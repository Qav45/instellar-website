// Stream mode's host half is a byte-stream parser and a process babysitter, and
// both are worth proving with bytes rather than reading. The parsers get
// synthetic Annex-B (H.264 and HEVC) and AV1 OBU streams fed to them in every
// chunking that can go wrong; the header readers get real SPSes and a real
// AV1 sequence header off the encoders, plus hand-built H.264 ones for the
// profiles and crops it has to handle; the source gets fake-ffmpeg.mjs
// standing in for ffmpeg so the codec preference, the fallback chain, GOP
// replay, backpressure and idle stop run for real without a GPU - and without
// a single picture, per CLAUDE.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAnnexB, parseObu, codecString, spsDimensions, hevcSpsInfo, av1SeqInfo, codecOf,
  validateVideoSettings, createVideoSource,
} from "../video.mjs";

const FAKE = fileURLToPath(new URL("./fake-ffmpeg.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};

/* == parseAnnexB ============================================================ */

// The same real x264 1080p High 4.2 SPS/PPS the stub writes.
const SPS = Buffer.from("Z2QAKqzZQHgCJ+XARAAAAwAEAAADAPA8YMZY", "base64");
const PPS = Buffer.from("aOvssiw=", "base64");
const SC3 = Buffer.from([0, 0, 1]);
const SC4 = Buffer.from([0, 0, 0, 1]);
const nal = (type, firstMb, len) => {
  const b = Buffer.alloc(len, 0x5a);
  b[0] = type === 5 ? 0x65 : type === 1 ? 0x41 : type === 6 ? 0x06 : 0x09;
  b[1] = firstMb === 0 ? 0xc0 : 0x40;                // ue(v): "1" is 0, "010" is 1
  return b;
};
const IDR = nal(5, 0, 40);
const IDR2 = nal(5, 5, 30);                          // second slice of the same picture
const P = nal(1, 0, 20);
const SEI = nal(6, 0, 6);

const stream = Buffer.concat([
  SC4, SPS, SC4, PPS, SC4, IDR, SC3, IDR2,           // AU 0: key, two slices
  SC3, P,                                            // AU 1
  SC4, P,                                            // AU 2
  SC4, SEI, SC4, IDR,                                // AU 3: key without SPS/PPS
  SC3, P,                                            // AU 4
]);
const expectKeys = [true, false, false, true, false];
const expectNals = [4, 1, 1, 4, 1];                   // AU 3 gets SPS + PPS prepended

const nalsOf = (bytes) => bytes.toString("hex").split("00000001").filter(Boolean);

function runSplit(chunkSize) {
  const p = parseAnnexB();
  let aus = [];
  for (let i = 0; i < stream.length; i += chunkSize) {
    aus = aus.concat(p.feed(stream.subarray(i, i + chunkSize)));
  }
  return aus.concat(p.flush());
}

for (const size of [stream.length, 1, 2, 3, 7, 64]) {
  const aus = runSplit(size);
  const keys = aus.map((a) => a.key);
  const counts = aus.map((a) => nalsOf(a.bytes).length);
  ok("split in " + size + "-byte chunks: 5 AUs, keys and NAL counts as expected",
    aus.length === 5 && keys.join() === expectKeys.join() && counts.join() === expectNals.join(),
    aus.length + " AUs, keys " + keys.join() + ", nals " + counts.join());
}

{
  const aus = runSplit(5);
  const first = nalsOf(aus[0].bytes);
  ok("3- and 4-byte start codes both split; NAL payloads come through byte-exact",
    first[0] === SPS.toString("hex") && first[1] === PPS.toString("hex") &&
    first[2] === IDR.toString("hex") && first[3] === IDR2.toString("hex"));
  ok("keyframe AU exposes sps and pps",
    aus[0].sps && aus[0].sps.equals(SPS) && aus[0].pps && aus[0].pps.equals(PPS));
  ok("delta AU has no sps/pps", !aus[1].sps && !aus[1].pps);
  const bare = nalsOf(aus[3].bytes);
  ok("keyframe missing SPS/PPS gets the last seen ones prepended, ahead of SEI and IDR",
    bare[0] === SPS.toString("hex") && bare[1] === PPS.toString("hex") &&
    bare[2] === SEI.toString("hex") && bare[3] === IDR.toString("hex") && aus[3].sps.equals(SPS));
  ok("second slice of the same picture (first_mb_in_slice != 0) stays in the AU",
    first.length === 4);
}

{
  // The trailing AU only appears when its successor starts or on flush - and a
  // chunk ending exactly on 00 00 | 00 01 must not lose the start code.
  const p = parseAnnexB();
  const a = p.feed(Buffer.concat([SC4, SPS, SC4, PPS, SC4, IDR, Buffer.from([0, 0])]));
  const b = p.feed(Buffer.concat([Buffer.from([0, 1]), P]));
  ok("AU is emitted when the next picture starts, not before",
    a.length === 0 && b.length === 1 && b[0].key);
  ok("start code split as 00 00 | 00 01 still splits", nalsOf(b[0].bytes).length === 3);
  const c = p.flush();
  ok("flush emits the last pending AU", c.length === 1 && !c[0].key && nalsOf(c[0].bytes)[0] === P.toString("hex"));
}

{
  const p = parseAnnexB();
  const aus = p.feed(Buffer.concat([SC4, IDR, SC4, P, SC4, P]));
  ok("keyframe before any SPS is dropped, deltas still pass",
    aus.length === 1 && !aus[0].key);
}

/* == parseAnnexB("hevc") =================================================== */

// The VPS/SPS/PPS hevc_nvenc writes for 1920x1080 Main 4.1, as in the stub.
const HVPS = Buffer.from("QAEMAf//AWAAAAMAkAAAAwAAAwB7lwJA", "base64");
const HSPS = Buffer.from("QgEBAWAAAAMAkAAAAwAAAwB7oAPAgBEHy5ZdKQhGRdUMBAQAAAMABAAAAwDxgBd5RAAD0JAABBLx", "base64");
const HPPS = Buffer.from("RAHA98DMkA==", "base64");
// Two-byte NAL header, then first_slice_segment_in_pic_flag as the top bit.
const hnal = (type, first, len) => {
  const b = Buffer.alloc(len, 0x5a);
  b[0] = type << 1;
  b[1] = 0x01;
  b[2] = first ? 0x80 : 0x40;
  return b;
};
const HIDR = hnal(19, 1, 40);
const HIDR2 = hnal(19, 0, 30);
const HP = hnal(1, 1, 20);
const HSEI = hnal(39, 1, 6);
const HCRA = hnal(21, 1, 36);

const hstream = Buffer.concat([
  SC4, HVPS, SC4, HSPS, SC4, HPPS, SC4, HIDR, SC3, HIDR2,  // AU 0: key, two slices
  SC3, HP,                                                 // AU 1
  SC4, HSEI, SC4, HP,                                      // AU 2: prefix SEI opens it
  SC4, HCRA,                                               // AU 3: CRA without parameter sets
  SC3, HP,                                                 // AU 4
]);
const hexpectKeys = [true, false, false, true, false];
const hexpectNals = [5, 1, 2, 4, 1];                       // AU 3 gets VPS + SPS + PPS prepended

function runHevc(chunkSize) {
  const p = parseAnnexB("hevc");
  let aus = [];
  for (let i = 0; i < hstream.length; i += chunkSize) {
    aus = aus.concat(p.feed(hstream.subarray(i, i + chunkSize)));
  }
  return aus.concat(p.flush());
}

for (const size of [hstream.length, 1, 3, 7, 64]) {
  const aus = runHevc(size);
  const keys = aus.map((a) => a.key);
  const counts = aus.map((a) => nalsOf(a.bytes).length);
  ok("hevc split in " + size + "-byte chunks: 5 AUs, keys and NAL counts as expected",
    aus.length === 5 && keys.join() === hexpectKeys.join() && counts.join() === hexpectNals.join(),
    aus.length + " AUs, keys " + keys.join() + ", nals " + counts.join());
}
{
  const aus = runHevc(5);
  ok("hevc keyframe AU exposes vps, sps and pps",
    aus[0].vps && aus[0].vps.equals(HVPS) && aus[0].sps.equals(HSPS) && aus[0].pps.equals(HPPS) && !aus[1].sps);
  const bare = nalsOf(aus[3].bytes);
  ok("a CRA is a keyframe and gets VPS, SPS, PPS prepended in that order",
    bare[0] === HVPS.toString("hex") && bare[1] === HSPS.toString("hex") &&
    bare[2] === HPPS.toString("hex") && bare[3] === HCRA.toString("hex") && aus[3].vps.equals(HVPS));
  const p = parseAnnexB("hevc");
  const dropped = p.feed(Buffer.concat([SC4, HIDR, SC4, HP, SC4, HP]));
  ok("hevc keyframe before any parameter set is dropped, deltas still pass",
    dropped.length === 1 && !dropped[0].key);
}

/* == parseObu ============================================================== */

// The sequence header av1_nvenc writes for 1920x1080 8-bit, level 4.1 Main tier.
const SEQ = Buffer.from("CgsAAABKq7/DcAhmAQ==", "base64");
const leb = (n) => { const out = []; do { out.push((n & 0x7f) | (n >= 128 ? 0x80 : 0)); n >>= 7; } while (n); return Buffer.from(out); };
const obu = (type, payload, ext) => Buffer.concat([
  Buffer.from(ext ? [(type << 3) | 0x06, 0x08] : [(type << 3) | 0x02]), leb(payload.length), payload]);
const framePayload = (key, len) => { const b = Buffer.alloc(len, 0x5a); b[0] = key ? 0x10 : 0x30; return b; };
const TD = obu(2, Buffer.alloc(0));
const KEY = obu(6, framePayload(true, 300));               // two-byte LEB128 size
const INTER = obu(6, framePayload(false, 40));
const HDR = obu(3, framePayload(false, 5), true);          // with an extension header byte
const TILES = obu(4, Buffer.alloc(30, 0x5a));

const ostream = Buffer.concat([
  TD, SEQ, KEY,                                            // TU 0: key
  TD, INTER,                                               // TU 1
  TD, HDR, TILES,                                          // TU 2: frame header + tile group
  TD, KEY,                                                 // TU 3: key without its sequence header
  TD, INTER,                                               // TU 4
]);
const oexpectKeys = [true, false, false, true, false];
const oexpectObus = [3, 2, 3, 3, 2];                       // TU 3 gets the sequence header put back

const obusOf = (bytes) => {
  const out = [];
  let at = 0;
  while (at < bytes.length) {
    let p = at + 1 + ((bytes[at] >> 2) & 1);
    let size = 0, shift = 0;
    for (;;) { const x = bytes[p++]; size += (x & 0x7f) << shift; shift += 7; if (!(x & 0x80)) break; }
    out.push(bytes.subarray(at, p + size));
    at = p + size;
  }
  return out;
};

function runObu(chunkSize) {
  const p = parseObu();
  let aus = [];
  for (let i = 0; i < ostream.length; i += chunkSize) {
    aus = aus.concat(p.feed(ostream.subarray(i, i + chunkSize)));
  }
  return aus.concat(p.flush());
}

for (const size of [ostream.length, 1, 2, 3, 7, 64]) {
  const aus = runObu(size);
  const keys = aus.map((a) => a.key);
  const counts = aus.map((a) => obusOf(a.bytes).length);
  ok("obu split in " + size + "-byte chunks: 5 temporal units, keys and OBU counts as expected",
    aus.length === 5 && keys.join() === oexpectKeys.join() && counts.join() === oexpectObus.join(),
    aus.length + " TUs, keys " + keys.join() + ", obus " + counts.join());
}
{
  const aus = runObu(5);
  const first = obusOf(aus[0].bytes);
  ok("temporal unit starts with its delimiter and comes through byte-exact",
    first[0].equals(TD) && first[1].equals(SEQ) && first[2].equals(KEY) && aus[0].seq.equals(SEQ) && !aus[1].seq);
  const bare = obusOf(aus[3].bytes);
  ok("a key frame without a sequence header gets the last one put back, behind the delimiter",
    bare[0].equals(TD) && bare[1].equals(SEQ) && bare[2].equals(KEY) && aus[3].seq.equals(SEQ));
  ok("a frame header OBU with an extension byte is still read", aus[2].bytes.length === TD.length + HDR.length + TILES.length);
  const p = parseObu();
  const a = p.feed(Buffer.concat([TD, KEY, TD, INTER, TD]));
  ok("a key frame before any sequence header is dropped, inter frames still pass",
    a.length === 1 && !a[0].key);
  ok("the unit after the last delimiter waits for flush", p.feed(INTER).length === 0 && p.flush().length === 1);
}

/* == codecString / spsDimensions / hevcSpsInfo / av1SeqInfo ================ */

{
  const h = hevcSpsInfo(HSPS);
  ok("hevc SPS from the encoder: Main, compat flags 6, level 4.1 main tier, progressive+frame-only, 1920x1080",
    h.codec === "hvc1.1.6.L123.90" && h.width === 1920 && h.height === 1080, JSON.stringify(h));
  ok("hevc SPS with a start code", hevcSpsInfo(Buffer.concat([SC4, HSPS])).codec === "hvc1.1.6.L123.90");
  const a = av1SeqInfo(SEQ);
  ok("av1 sequence header from the encoder: profile 0, level 4.1 (idx 9) main tier, 8-bit, 1920x1080",
    a.codec === "av01.0.09M.08" && a.width === 1920 && a.height === 1080, JSON.stringify(a));
  ok("av1 sequence header payload without its OBU header reads the same",
    av1SeqInfo(SEQ.subarray(2)).codec === "av01.0.09M.08");
  ok("codecOf maps encoder names to codecs",
    codecOf("av1_nvenc") === "av1" && codecOf("hevc_qsv") === "hevc" && codecOf("h264_amf") === "h264" && codecOf("libx264") === "h264");
}

ok("codec string for a real 1080p High profile SPS", codecString(SPS) === "avc1.64002a", codecString(SPS));
ok("codec string with a 4-byte start code", codecString(Buffer.concat([SC4, SPS])) === "avc1.64002a");
ok("codec string with a 3-byte start code", codecString(Buffer.concat([SC3, SPS])) === "avc1.64002a");
{
  const d = spsDimensions(SPS);
  ok("real SPS: 1920x1080 (coded 1920x1088, 8 lines cropped)", d.width === 1920 && d.height === 1080, JSON.stringify(d));
}

// A bit writer to build SPSes the real encoders would never hand us in a test:
// 4:4:4, interlaced, a scaling matrix, odd crops. Emulation prevention is
// applied so the reader's unescaping is exercised too.
function spsWriter() {
  const bits = [];
  const u = (n, v) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  const ue = (v) => { const c = v + 1; const len = 32 - Math.clz32(c); u(len - 1, 0); u(len, c); };
  const se = (v) => ue(v <= 0 ? -2 * v : 2 * v - 1);
  const done = () => {
    bits.push(1);
    while (bits.length % 8) bits.push(0);
    const raw = [];
    for (let i = 0; i < bits.length; i += 8) raw.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    const out = [0x67];
    let zeros = 0;
    for (const b of raw) {
      if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
      out.push(b);
      zeros = b === 0 ? zeros + 1 : 0;
    }
    return Buffer.from(out);
  };
  return { u, ue, se, done };
}

function buildSps(o) {
  const w = spsWriter();
  w.u(8, o.profile); w.u(8, 0); w.u(8, 40); w.ue(0);
  if ([100, 110, 122, 244].includes(o.profile)) {
    w.ue(o.chroma);
    if (o.chroma === 3) w.u(1, 0);
    w.ue(0); w.ue(0); w.u(1, 0);
    w.u(1, o.scaling ? 1 : 0);
    if (o.scaling) {
      for (let i = 0; i < (o.chroma !== 3 ? 8 : 12); i++) {
        w.u(1, 1);
        // A list that ends early with next == 0, then one that runs the full size.
        const size = i < 6 ? 16 : 64;
        if (i % 2) { w.se(-8); } else { for (let j = 0; j < size; j++) w.se(j % 3 - 1); }
      }
    }
  }
  w.ue(0);
  w.ue(o.poc === undefined ? 0 : o.poc);
  if (o.poc === 1) { w.u(1, 0); w.se(-3); w.se(2); w.ue(2); w.se(1); w.se(-1); }
  else if (!o.poc) w.ue(2);
  w.ue(4); w.u(1, 0);
  w.ue(o.wMbs - 1); w.ue(o.hUnits - 1);
  w.u(1, o.frameMbsOnly === undefined ? 1 : o.frameMbsOnly);
  if (o.frameMbsOnly === 0) w.u(1, 0);
  w.u(1, 1);
  w.u(1, o.crop ? 1 : 0);
  if (o.crop) o.crop.forEach((c) => w.ue(c));
  return w.done();
}

const cases = [
  ["high 4:2:0 1920x1088 crop 4 bottom -> 1920x1080", { profile: 100, chroma: 1, wMbs: 120, hUnits: 68, crop: [0, 0, 0, 4] }, 1920, 1080],
  ["baseline 1280x720 no crop", { profile: 66, wMbs: 80, hUnits: 45 }, 1280, 720],
  ["main 4:2:0 crop left+right 2 each -> 1272", { profile: 77, wMbs: 80, hUnits: 45, crop: [2, 2, 0, 0] }, 1272, 720],
  ["high444 (244) crop unit 1 -> 1919x1079", { profile: 244, chroma: 3, wMbs: 120, hUnits: 68, crop: [0, 1, 0, 9] }, 1919, 1079],
  ["high422 (122) crop unit 2x1", { profile: 122, chroma: 2, wMbs: 120, hUnits: 68, crop: [1, 0, 0, 8] }, 1918, 1080],
  ["high10 (110) 4:2:0 with scaling matrix present", { profile: 110, chroma: 1, scaling: true, wMbs: 120, hUnits: 68, crop: [0, 0, 0, 4] }, 1920, 1080],
  ["interlaced 4:2:0 (frame_mbs_only 0) 1920x1080", { profile: 100, chroma: 1, frameMbsOnly: 0, wMbs: 120, hUnits: 34, crop: [0, 0, 0, 2] }, 1920, 1080],
  ["poc type 1 cycle is skipped correctly", { profile: 100, chroma: 1, poc: 1, wMbs: 40, hUnits: 30 }, 640, 480],
  ["monochrome (chroma 0) crop unit 1", { profile: 100, chroma: 0, wMbs: 40, hUnits: 30, crop: [3, 0, 0, 5] }, 637, 475],
];
for (const [name, o, w, h] of cases) {
  const d = spsDimensions(buildSps(o));
  ok("spsDimensions: " + name, d.width === w && d.height === h, JSON.stringify(d));
}

/* == validateVideoSettings ================================================= */

const q = (o) => ({ get: (k) => (k in o ? o[k] : null) });
{
  const d = validateVideoSettings(q({}));
  ok("settings defaults: 60 fps, 8 mbps, primary, h264",
    d && d.fps === 60 && d.mbps === 8 && d.display === "primary" && d.codecs.join() === "h264");
  ok("settings keep the codec list in the page's order",
    validateVideoSettings(q({ codecs: "hevc,av1,h264" })).codecs.join() === "hevc,av1,h264");
  ok("settings drop unknown codec names and repeats, and fall back to h264 when nothing is left",
    validateVideoSettings(q({ codecs: "vp9,av1,av1, hevc" })).codecs.join() === "av1" &&
    validateVideoSettings(q({ codecs: "vp9" })).codecs.join() === "h264" &&
    validateVideoSettings(q({ codecs: "" })).codecs.join() === "h264");
  const c = validateVideoSettings(q({ fps: "500", mbps: "0.1", display: "3" }));
  ok("settings clamp fps to 120 and mbps to 1, keep display 3", c && c.fps === 120 && c.mbps === 1 && c.display === "3");
  ok("settings refuse a non-numeric fps", validateVideoSettings(q({ fps: "fast" })) === null);
  ok("settings refuse a display outside the vocabulary", validateVideoSettings(q({ display: "0; rm" })) === null);
  ok("settings accept full and 99", validateVideoSettings(q({ display: "full" })).display === "full" &&
    validateVideoSettings(q({ display: "99" })).display === "99");
  ok("settings refuse display 100", validateVideoSettings(q({ display: "100" })) === null);
}

/* == createVideoSource with the stub ffmpeg ================================ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-video-"));
process.env.CAST_FFMPEG_BIN = FAKE;
const pidFile = path.join(tmp, "pid");
const argsFile = path.join(tmp, "args");
process.env.CAST_FAKE_FFMPEG_PID = pidFile;
process.env.CAST_FAKE_FFMPEG_ARGS = argsFile;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const readPid = () => { try { return Number(fs.readFileSync(pidFile, "utf8")); } catch (_) { return 0; } };

// A sink that records everything and lets the test dial its backlog.
function recorder() {
  const s = {
    configs: [], aus: [], closed: null, backlog: 0,
    config(c) { s.configs.push(c); },
    au(flags, ts, bytes) { s.aus.push({ flags, ts, bytes }); },
    close(code, reason) { s.closed = { code, reason }; },
    buffered() { return s.backlog; },
  };
  return s;
}
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return fn();
};
const S60 = { fps: 60, mbps: 8, display: "primary", codecs: ["h264"] };

// -- normal life: first viewer, late viewer, backpressure, idle stop ---------
{
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  const offA = src.subscribe(S60, a);
  await until(() => a.aus.length >= 20, 3000);
  const cfg = a.configs[0];
  ok("first viewer gets a config before any AU",
    a.configs.length === 1 && cfg && cfg.type === "config" && a.aus.length >= 20);
  ok("config carries codec, size, encoder and the settings",
    cfg && cfg.codec === "avc1.64002a" && cfg.width === 1920 && cfg.height === 1080 &&
    cfg.encoder === "h264_nvenc" && cfg.fps === 60 && cfg.mbps === 8 && cfg.display === "primary",
    JSON.stringify(cfg));
  ok("first AU is a keyframe carrying SPS and PPS",
    (a.aus[0].flags & 1) === 1 && nalsOf(a.aus[0].bytes).length === 3 && (a.aus[1].flags & 1) === 0);
  ok("timestamps are non-decreasing ms", a.aus.every((x, i) => i === 0 || x.ts >= a.aus[i - 1].ts));
  ok("log says which encoder is in use", logs.some((l) => l === "video    h264 via h264_nvenc"), logs.join(" | "));
  ok("settings() reports what is running", JSON.stringify(src.settings()) === JSON.stringify(S60));
  const argv = JSON.parse(fs.readFileSync(argsFile, "utf8").trim().split("\n").pop());
  ok("ffmpeg command: ddagrab primary at 60 fps without the cursor, nvenc cbr 8M, one-second GOP, raw h264 to stdout",
    argv.includes("ddagrab=output_idx=0:framerate=60:draw_mouse=0") && argv.includes("h264_nvenc") &&
    argv.join(" ").includes("-b:v 8M -maxrate 8M -bufsize 2000k -g 60 -bf 0") &&
    argv.slice(-3).join(" ") === "-f h264 pipe:1", argv.join(" "));

  // Late subscriber: config, then the cached GOP, so it starts on a keyframe
  // the first viewer already saw, and the two see identical bytes from then on.
  await until(() => a.aus.length >= 40, 2000);
  const b = recorder();
  const offB = src.subscribe(S60, b);
  const lastKeyA = a.aus.map((x) => x.flags & 1).lastIndexOf(1);
  ok("late viewer gets config synchronously", b.configs.length === 1 && b.configs[0] === cfg);
  ok("late viewer starts on the cached keyframe, replayed at once",
    b.aus.length >= 1 && (b.aus[0].flags & 1) === 1 && b.aus[0].bytes.equals(a.aus[lastKeyA].bytes) &&
    b.aus.length === a.aus.length - lastKeyA, b.aus.length + " vs " + (a.aus.length - lastKeyA));
  await until(() => b.aus.length >= 40, 2000);
  const tailA = a.aus.slice(lastKeyA, lastKeyA + 40).map((x) => x.ts + ":" + x.bytes.length).join();
  const tailB = b.aus.slice(0, 40).map((x) => x.ts + ":" + x.bytes.length).join();
  ok("after the replay both viewers see the same AUs in order", tailA === tailB);

  // Backpressure: a viewer a megabyte behind gets nothing until the next
  // keyframe, and then resumes on that keyframe. The limit has to stay clear
  // of a single keyframe: one that trips on its own starves the viewer to a
  // picture per GOP.
  b.backlog = 2 * 1024 * 1024;
  let before = b.aus.length;
  await sleep(1100);
  ok("viewer over the backlog limit receives no AUs", b.aus.length === before);
  b.backlog = 0;
  await until(() => b.aus.length > before, 1500);
  ok("viewer resumes on a keyframe once its backlog drains",
    b.aus.length > before && (b.aus[before].flags & 1) === 1);
  b.backlog = 300 * 1024;
  before = b.aus.length;
  await until(() => b.aus.length > before, 1500);
  ok("a backlog bigger than a keyframe but inside the limit still delivers",
    b.aus.length > before, b.aus.length - before + " AUs");
  b.backlog = 0;
  ok("the other viewer never dropped", a.aus.every((x, i) => i === 0 || x.ts >= a.aus[i - 1].ts) && a.aus.length > 60);

  // Idle stop: the encoder outlives a quick reconnect but not 3 s of nobody.
  const pid = readPid();
  offA();
  offB();
  await sleep(1500);
  ok("encoder still running 1.5 s after the last viewer left", alive(pid));
  const c = recorder();
  const offC = src.subscribe(S60, c);
  ok("a viewer back within 3 s joins the running encoder from its cache",
    readPid() === pid && c.configs.length === 1 && c.aus.length >= 1 && (c.aus[0].flags & 1) === 1);
  offC();
  await sleep(2500);
  ok("encoder still running 2.5 s after the last viewer left", alive(pid));
  await until(() => !alive(pid), 1500);
  ok("encoder stopped by ~3.5 s after the last viewer left", !alive(pid) && src.settings() === null);
  src.stop();
}

// -- the GOP cache at the real keyframe interval, and the replay cap ---------
// Five seconds at sixty is 300 AUs between keyframes; the cache must hold all
// of them for a late joiner. The fake runs that GOP at 2 ms a picture.
{
  process.env.CAST_FAKE_FFMPEG_GOP = "300";
  process.env.CAST_FAKE_FFMPEG_TICK_MS = "2";
  const src = createVideoSource({ ffmpeg: null, log: () => {} });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.aus.length >= 250, 5000);
  const b = recorder();
  src.subscribe(S60, b);
  const lastKeyA = a.aus.map((x) => x.flags & 1).lastIndexOf(1);
  ok("a viewer joining 250 frames into a 300-frame GOP is replayed all of it, from the keyframe",
    a.aus.length >= 250 && lastKeyA === 0 && b.aus.length === a.aus.length &&
    (b.aus[0].flags & 1) === 1 && b.aus.every((x, i) => x.bytes.equals(a.aus[i].bytes)),
    a.aus.length + " cached, " + b.aus.length + " replayed, last key at " + lastKeyA);
  src.stop();
  delete process.env.CAST_FAKE_FFMPEG_GOP;
  delete process.env.CAST_FAKE_FFMPEG_TICK_MS;
}
// A GOP bigger than the backlog limit is not replayed: deliver would skip the
// joiner part way through anyway, so it waits for the next keyframe instead.
{
  process.env.CAST_FAKE_FFMPEG_DELTA = String(60 * 1024);       // 30 of these is 1.8 MB a GOP
  const src = createVideoSource({ ffmpeg: null, log: () => {} });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.aus.length >= 25, 3000);
  const b = recorder();
  src.subscribe(S60, b);
  ok("a joiner during an oversize GOP gets the config and no replay",
    b.configs.length === 1 && b.aus.length === 0, b.aus.length + " replayed");
  await until(() => b.aus.length >= 1, 2000);
  ok("and starts on the next keyframe", b.aus.length >= 1 && (b.aus[0].flags & 1) === 1);
  src.stop();
  delete process.env.CAST_FAKE_FFMPEG_DELTA;
}

// -- restart when a viewer asks for different settings ----------------------
{
  const src = createVideoSource({ ffmpeg: null, log: () => {} });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.aus.length >= 5, 3000);
  const pid1 = readPid();
  const b = recorder();
  src.subscribe({ fps: 30, mbps: 4, display: "2", codecs: ["h264"] }, b);
  await until(() => a.configs.length >= 2 && b.aus.length >= 5, 3000);
  ok("different settings restart the encoder for everyone with a new config",
    a.configs.length === 2 && a.configs[1].fps === 30 && b.configs.length === 1 && b.configs[0] === a.configs[1]);
  const argv = JSON.parse(fs.readFileSync(argsFile, "utf8").trim().split("\n").pop());
  ok("restarted with the new settings: display 2 -> output_idx 1, 30 fps, 4M",
    argv.includes("ddagrab=output_idx=1:framerate=30:draw_mouse=0") && argv.join(" ").includes("-b:v 4M -maxrate 4M -bufsize 1000k -g 30 -bf 0"));
  ok("old ffmpeg was killed", !alive(pid1) && readPid() !== pid1);
  const firstAfter = a.aus.slice().reverse().find((x) => x.flags & 1);
  ok("the old viewer resumed on a keyframe from the new encoder", !!firstAfter);
  src.stop();
  ok("stop() closes viewers with 1001", a.closed && a.closed.code === 1001 && b.closed && b.closed.code === 1001);
}

// -- fallback chain: nvenc exits at once, amf takes over ---------------------
{
  process.env.CAST_FAKE_FFMPEG_FAIL = "h264_nvenc,h264_amf";
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.aus.length >= 5, 4000);
  ok("nvenc and amf failing fall through to qsv",
    a.configs.length === 1 && a.configs[0].encoder === "h264_qsv" && a.aus.length >= 5 && (a.aus[0].flags & 1) === 1,
    JSON.stringify(a.configs[0]));
  ok("each failure is logged with the encoder name and ffmpeg's last stderr line",
    logs.some((l) => /^video    h264_nvenc failed \(exit 1\): Cannot load h264_nvenc$/.test(l)) &&
    logs.some((l) => /^video    h264_amf failed/.test(l)) && logs.some((l) => l === "video    h264 via h264_qsv"),
    logs.join(" | "));
  src.stop();
}

// -- every encoder fails: viewers closed 1011 "no encoder" ------------------
{
  process.env.CAST_FAKE_FFMPEG_FAIL = "h264_nvenc,h264_amf,h264_qsv,libx264";
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  const b = recorder();
  src.subscribe(S60, a);
  src.subscribe(S60, b);
  await until(() => a.closed && b.closed, 4000);
  ok("all encoders failing closes every viewer with 1011 no encoder",
    a.closed && a.closed.code === 1011 && a.closed.reason === "no encoder" && b.closed && b.closed.code === 1011);
  ok("and logs why", logs.some((l) => /no encoder could start \(tried h264_nvenc, h264_amf, h264_qsv, libx264\)/.test(l)));
  ok("nothing running afterwards", src.settings() === null && a.configs.length === 0);
  src.stop();
  delete process.env.CAST_FAKE_FFMPEG_FAIL;
}

// -- crash later: restart once, second death within 10 s is final -----------
{
  process.env.CAST_FAKE_FFMPEG_DIE_AFTER = "2300";
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.configs.length >= 2 && a.aus.length > 0, 6000);
  const n = a.configs.length;
  const lastKey = a.aus.map((x) => x.flags & 1).lastIndexOf(1);
  ok("a crash after a healthy run restarts the encoder and re-sends config",
    n === 2 && logs.some((l) => /h264_nvenc exited \(3\) - restarting$/.test(l)) && !a.closed, logs.join(" | "));
  ok("timestamps restart from the new encoder start and viewer resumes on a keyframe",
    lastKey >= 0 && a.aus[lastKey].ts < 1000);
  await until(() => a.closed, 6000);
  ok("a second death within 10 s closes viewers with 1011 encoder died",
    a.closed && a.closed.code === 1011 && a.closed.reason === "encoder died" && a.configs.length === 2,
    JSON.stringify(a.closed) + " " + logs.join(" | "));
  src.stop();
  delete process.env.CAST_FAKE_FFMPEG_DIE_AFTER;
}

// -- a bare IDR from an encoder that does not repeat SPS/PPS ----------------
{
  process.env.CAST_FAKE_FFMPEG_BARE_IDR = "1";
  const src = createVideoSource({ ffmpeg: null, log: () => {} });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.aus.filter((x) => x.flags & 1).length >= 2, 3000);
  const keys = a.aus.filter((x) => x.flags & 1);
  ok("every keyframe on the wire carries SPS and PPS even when the encoder sent none",
    keys.length >= 2 && keys.every((k) => { const n = nalsOf(k.bytes); return n[0] === SPS.toString("hex") && n[1] === PPS.toString("hex"); }));
  const b = recorder();
  src.subscribe(S60, b);
  ok("late viewer's replayed keyframe is decodable on its own",
    b.aus.length >= 1 && nalsOf(b.aus[0].bytes).length === 3);
  src.stop();
  delete process.env.CAST_FAKE_FFMPEG_BARE_IDR;
}

// -- codec preference: the page's first choice wins, each with its own muxer --
{
  const src = createVideoSource({ ffmpeg: null, log: () => {} });
  const a = recorder();
  src.subscribe({ ...S60, codecs: ["av1", "hevc", "h264"] }, a);
  await until(() => a.aus.length >= 5, 3000);
  const cfg = a.configs[0];
  ok("av1 first on the list: av1_nvenc, av01 codec string from the sequence header",
    cfg && cfg.encoder === "av1_nvenc" && cfg.codec === "av01.0.09M.08" && cfg.width === 1920 && cfg.height === 1080,
    JSON.stringify(cfg));
  let argv = JSON.parse(fs.readFileSync(argsFile, "utf8").trim().split("\n").pop());
  ok("av1_nvenc argv: nvenc low-latency flags, forced IDR, no h264 profile, obu muxer",
    argv.join(" ").includes("-c:v av1_nvenc -preset p1 -tune ull -zerolatency 1 -rc cbr -b:v 8M") &&
    argv.join(" ").includes("-bf 0 -forced-idr 1 -flush_packets 1 -f obu pipe:1") && !argv.includes("-profile:v"), argv.join(" "));
  ok("first av1 unit is a key with the delimiter, sequence header and frame",
    (a.aus[0].flags & 1) === 1 && obusOf(a.aus[0].bytes).length === 3 && obusOf(a.aus[1].bytes).length === 2);

  // A viewer whose list includes what is running joins it; one that cannot
  // decode it restarts the encoder for everyone.
  const b = recorder();
  src.subscribe({ ...S60, codecs: ["hevc", "av1"] }, b);
  ok("a viewer that can decode the running codec joins it from the cache",
    b.configs.length === 1 && b.configs[0] === cfg && b.aus.length >= 1 && (b.aus[0].flags & 1) === 1);
  const c = recorder();
  src.subscribe({ ...S60, codecs: ["hevc"] }, c);
  await until(() => a.configs.length >= 2 && c.aus.length >= 5, 3000);
  ok("a viewer that cannot decode it restarts the encoder on its codec, for everyone",
    a.configs.length === 2 && a.configs[1].encoder === "hevc_nvenc" && a.configs[1].codec === "hvc1.1.6.L123.90" &&
    b.configs.length === 2 && c.configs[0] === a.configs[1], JSON.stringify(a.configs[1]));
  argv = JSON.parse(fs.readFileSync(argsFile, "utf8").trim().split("\n").pop());
  ok("hevc_nvenc argv ends in the hevc muxer",
    argv.includes("hevc_nvenc") && argv.slice(-3).join(" ") === "-f hevc pipe:1");
  const key = c.aus.find((x) => x.flags & 1);
  ok("first hevc AU is a key carrying VPS, SPS, PPS", key && nalsOf(key.bytes).length === 4 && nalsOf(key.bytes)[0] === HVPS.toString("hex"));
  src.stop();
}

// -- fallback across codecs: no AV1 encoder here, HEVC takes over ----------
{
  process.env.CAST_FAKE_FFMPEG_FAIL = "av1_nvenc,av1_amf,av1_qsv,hevc_nvenc";
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  src.subscribe({ ...S60, codecs: ["av1", "hevc", "h264"] }, a);
  await until(() => a.aus.length >= 5, 6000);
  ok("every av1 encoder failing falls through to the next codec's chain",
    a.configs.length === 1 && a.configs[0].encoder === "hevc_amf" && a.configs[0].codec === "hvc1.1.6.L123.90",
    JSON.stringify(a.configs[0]) + " " + logs.join(" | "));
  ok("the log names the codec that ended up running", logs.some((l) => l === "video    hevc via hevc_amf"), logs.join(" | "));
  src.stop();

  process.env.CAST_FAKE_FFMPEG_FAIL = "av1_nvenc,av1_amf,av1_qsv";
  const src2 = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const b = recorder();
  src2.subscribe({ ...S60, codecs: ["av1"] }, b);
  await until(() => b.closed, 6000);
  ok("a list with only a codec nobody here can encode ends in 1011 no encoder",
    b.closed && b.closed.code === 1011 && b.closed.reason === "no encoder" &&
    logs.some((l) => /no encoder could start \(tried av1_nvenc, av1_amf, av1_qsv\)/.test(l)), JSON.stringify(b.closed));
  src2.stop();
  delete process.env.CAST_FAKE_FFMPEG_FAIL;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

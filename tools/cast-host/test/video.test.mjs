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
  ffmpegArgs, levelFor, ffmpegReason, captureIndex,
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
  ok("settings default the text offset to 0 and clamp it to +-12",
    validateVideoSettings(q({})).cq === 0 &&
    validateVideoSettings(q({ cq: "-30" })).cq === -12 && validateVideoSettings(q({ cq: "30" })).cq === 12);
  ok("settings refuse a non-numeric text offset", validateVideoSettings(q({ cq: "sharp" })) === null);
  // The picture cap negotiates like fps and mbps do, and defaults to the size
  // the weak client can decode rather than to whatever the host's desktop is.
  ok("the picture cap defaults to 720 and is negotiable",
    validateVideoSettings(q({})).maxh === 720 &&
    validateVideoSettings(q({ maxh: "1440" })).maxh === 1440);
  ok("the cap is clamped at both ends and always even",
    validateVideoSettings(q({ maxh: "4320" })).maxh === 2160 &&
    validateVideoSettings(q({ maxh: "1" })).maxh === 240 &&
    validateVideoSettings(q({ maxh: "1081" })).maxh === 1080 &&
    validateVideoSettings(q({ maxh: "" })).maxh === 720);
  ok("settings refuse a non-numeric cap", validateVideoSettings(q({ maxh: "big" })) === null);
}

/* == levelFor ============================================================== */

// The rungs that decide whether a built-in decoder takes the stream at all.
// 1080p60 H.264 is the 4.2 the viewer's own comment names; the same picture at
// thirty is 4.0, which is why walking the pace ladder down rescues a refusal.
{
  const cases = [
    ["h264", 1280, 720, 60, 8, "3.2"],
    ["h264", 1280, 720, 30, 8, "3.1"],
    ["h264", 1920, 1080, 60, 8, "4.2"],
    ["h264", 1920, 1080, 30, 8, "4.0"],
    ["h264", 3840, 2160, 60, 8, "5.2"],
    ["hevc", 1280, 720, 60, 8, "4.0"],
    ["hevc", 1920, 1080, 60, 8, "4.1"],
    ["av1", 1280, 720, 60, 8, "4.0"],
    ["av1", 1920, 1080, 60, 8, "4.1"],
  ];
  for (const [codec, w, h, fps, mbps, want] of cases) {
    ok("level for " + codec + " " + w + "x" + h + "@" + fps + ": " + want,
      levelFor(codec, w, h, fps, mbps) === want, levelFor(codec, w, h, fps, mbps));
  }
  // A level bounds the bitrate too, so a viewer asking for a ceiling the small
  // level cannot carry moves up a rung rather than being promised a lie.
  ok("a bitrate past the level's ceiling picks the next level up",
    levelFor("h264", 1280, 720, 30, 8) === "3.1" && levelFor("h264", 1280, 720, 30, 20) === "3.2");
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
const S60 = { fps: 60, mbps: 8, maxh: 720, display: "primary", codecs: ["h264"] };

/* ------------------------------------------------------------- encoding -- */

// What ends up on the ffmpeg command line. The bitrate the viewer asks for is
// a ceiling, not a quota: NVENC aims at a quality and climbs to the ceiling
// for motion, which on a mostly still screen is most of the bytes saved.
{
  const nv = ffmpegArgs("h264_nvenc", S60);
  const at = (flag) => nv[nv.indexOf(flag) + 1];
  ok("nvenc encodes at a variable rate", at("-rc") === "vbr");
  ok("the viewer's number is the ceiling", at("-maxrate") === "8M");
  ok("the aim is a quality, not an average bitrate",
    at("-b:v") === "0" && at("-cq") === "20");
  ok("the buffer is a quarter second of the ceiling", at("-bufsize") === "2000k");
  ok("no B-frames and a keyframe every second",
    at("-bf") === "0" && at("-g") === "60");
  ok("still a low latency tuning with zero latency on",
    at("-tune") === "ll" && at("-zerolatency") === "1");
  ok("nvenc hands each packet out as it is encoded, not frames later", at("-delay") === "0");
  ok("spatial AQ moves bits to the detailed regions", at("-spatial-aq") === "1");
  // -cq is not a shared scale: the same number costs the better codecs more
  // bytes, so each gets the number measured to cost what H.264's does.
  const hevc = ffmpegArgs("hevc_nvenc", { ...S60, codecs: ["hevc"] });
  const av1 = ffmpegArgs("av1_nvenc", { ...S60, codecs: ["av1"] });
  ok("each codec asks for quality on its own scale",
    hevc[hevc.indexOf("-cq") + 1] === "26" && av1[av1.indexOf("-cq") + 1] === "32");
  const sharp = ffmpegArgs("hevc_nvenc", { ...S60, codecs: ["hevc"], cq: -6 });
  ok("the viewer's text offset moves the quality aim", sharp[sharp.indexOf("-cq") + 1] === "20");
  const amf = ffmpegArgs("h264_amf", S60);
  const amfAt = (flag) => amf[amf.indexOf(flag) + 1];
  ok("the other vendors keep constant bitrate and the full ask",
    amfAt("-rc") === "cbr" && amfAt("-b:v") === "8M" && amfAt("-maxrate") === "8M");
  ok("and are not asked for a quality they do not take", amf.indexOf("-cq") === -1);
  const half = ffmpegArgs("h264_nvenc", { ...S60, fps: 30, mbps: 4 });
  const halfAt = (flag) => half[half.indexOf(flag) + 1];
  ok("a paced-down viewer scales the ceiling and the keyframe interval",
    halfAt("-maxrate") === "4M" && halfAt("-g") === "30");
  ok("but not the quality it is shown at", halfAt("-cq") === "20");
  const tiny = ffmpegArgs("h264_nvenc", { ...S60, mbps: 2 });
  ok("a small ceiling is still only a ceiling",
    tiny[tiny.indexOf("-maxrate") + 1] === "2M" && tiny[tiny.indexOf("-b:v") + 1] === "0");
}

/* ------------------------------------------------- the cap on the picture -- */

// What `ffmpeg -h filter=<name>` prints on the host this cast runs on, for
// every filter the capture graph uses. It is a recording, not a guess - each
// row was read off ffmpeg 9.0.1 on that machine - and it exists because the
// first cap that shipped was asserted here as a string and never ran once.
// It asked scale_d3d11 for w= and h=; that filter's options are width and
// height, ffmpeg answered "Error applying option 'w' to filter 'scale_d3d11':
// Option not found", the whole graph failed to configure, every encoder in the
// chain died with "received no packets", and the fail-safe quietly dropped the
// cap. The suite stayed green through all of it, because a test that asserts
// the shape of a string cannot tell a filter option from a typo.
const FILTER_OPTIONS = {
  ddagrab: ["output_idx", "draw_mouse", "framerate", "video_size", "offset_x", "offset_y",
            "output_fmt", "allow_fallback", "force_fmt", "dup_frames"],
  scale: ["w", "width", "h", "height", "flags", "interl", "size", "s", "in_color_matrix",
          "out_color_matrix", "in_range", "out_range", "in_chroma_loc", "out_chroma_loc",
          "in_primaries", "out_primaries", "in_transfer", "out_transfer", "in_v_chr_pos",
          "in_h_chr_pos", "out_v_chr_pos", "out_h_chr_pos", "force_original_aspect_ratio",
          "force_divisible_by", "reset_sar", "param0", "param1", "eval", "eof_action",
          "shortest", "repeatlast", "ts_sync_mode"],
  format: ["pix_fmts", "color_spaces", "color_ranges", "alpha_modes"],
  hwdownload: [],
  hwupload: ["derive_device"],
  hwmap: ["mode", "derive_device", "reverse"],
  scale_d3d11: ["width", "height", "format"],
};

// Split a filtergraph the way ffmpeg does: on commas and colons that are not
// backslash-escaped, so the escaped commas inside a scale expression stay
// inside it. Returns the first complaint ffmpeg would make, or "".
function graphComplaint(graph) {
  const split = (str, sep) => {
    const out = [];
    let cur = "";
    for (let i = 0; i < str.length; i++) {
      if (str[i] === "\\") { cur += str[i] + (str[++i] || ""); continue; }
      if (str[i] === sep) { out.push(cur); cur = ""; continue; }
      cur += str[i];
    }
    out.push(cur);
    return out;
  };
  for (const stage of split(graph, ",")) {
    const eq = stage.indexOf("=");
    const name = eq === -1 ? stage : stage.slice(0, eq);
    const opts = FILTER_OPTIONS[name];
    if (!opts) return "No such filter: '" + name + "'";
    if (eq === -1) continue;
    for (const arg of split(stage.slice(eq + 1), ":")) {
      const at = arg.indexOf("=");
      // A bare value is the filter's first option given positionally, which
      // is how format=nv12 is written; only a named one can be misspelled.
      if (at === -1) continue;
      const key = arg.slice(0, at);
      if (!opts.includes(key)) {
        return "Error applying option '" + key + "' to filter '" + name + "': Option not found";
      }
    }
  }
  return "";
}

// The validator against the shape the cap used to have, so a green run of the
// assertions below means something. If this ever passes, the check above has
// stopped checking.
ok("the recorded option lists reject the cap that shipped and never ran",
  graphComplaint("ddagrab=output_idx=0,scale_d3d11=width=1280:height=720:format=bgra") === "" &&
  /Option not found/.test(graphComplaint("ddagrab=output_idx=0,scale_d3d11=w=1280:h=720:format=bgra")) &&
  /No such filter/.test(graphComplaint("ddagrab=output_idx=0,scale_vulkan=w=1280")));

// The Chromebook half of the command line: a picture it can decode and a level
// it carries. The graph below was run against real ffmpeg on the RTX 4070 host
// and encoded 1280x720 out of a 1920x1080 desktop at the full sixty frames;
// what this suite can prove with no GPU is that every filter and option in it
// is one that ffmpeg has, and that the chain is joined up.
{
  const graph = (a) => a[a.indexOf("-filter_complex") + 1];
  const nv = ffmpegArgs("h264_nvenc", S60);
  const g = graph(nv);
  ok("every filter and option in the capped graph is one ffmpeg has",
    graphComplaint(g) === "", graphComplaint(g) || g);
  ok("the cap is a CPU scale, because no GPU scaler in this build can take ddagrab's frames",
    /^ddagrab=[^,]+,hwdownload,format=bgra,scale=/.test(g) && g.endsWith(",format=nv12"), g);
  ok("the frame is read back exactly once",
    (g.match(/hwdownload/g) || []).length === 1 && !g.includes("hwupload"), g);
  ok("the box is 16:9 at the asked-for height, the picture is fitted inside it and never enlarged",
    g.includes("min(1\\,min(1280/iw\\,720/ih))"), g);
  ok("both dimensions come out even",
    g.includes("scale=w=trunc(iw*") && g.includes(":h=trunc(ih*") &&
    (g.match(/\/2\)\*2/g) || []).length === 2, g);
  ok("the scale hands the encoder a format it takes, not the bgra it read back",
    g.endsWith(",format=nv12"), g);
  const wide = graph(ffmpegArgs("h264_nvenc", { ...S60, maxh: 1440 }));
  ok("a strong desktop negotiates a bigger box", wide.includes("min(1\\,min(2560/iw\\,1440/ih))"), wide);
  const cpu = graph(ffmpegArgs("libx264", S60));
  ok("the CPU encoder does not read the frame back a second time",
    cpu === g && (cpu.match(/hwdownload/g) || []).length === 1, cpu);
  ok("...and the capped graph is valid for it too", graphComplaint(cpu) === "", graphComplaint(cpu) || cpu);
  const off = ffmpegArgs("h264_nvenc", S60, false);
  ok("with the cap off the capture goes straight to the encoder, as it did before",
    graph(off) === "ddagrab=output_idx=0:framerate=60:draw_mouse=0", graph(off));
  const offCpu = graph(ffmpegArgs("libx264", S60, false));
  ok("with the cap off libx264 still gets its own read-back",
    offCpu === "ddagrab=output_idx=0:framerate=60:draw_mouse=0,hwdownload,format=nv12" &&
    graphComplaint(offCpu) === "", offCpu);

  // Which rectangle each of the share dropdown's three values gets captured
  // as. The dropdown value is doing two jobs - it is a tvnserver share mode as
  // well, and that is what sizes the framebuffer every mouse coordinate is
  // measured against - so what these pin is not just an index but which of the
  // three the host can and cannot honour.
  ok("Main screen captures the first output", captureIndex("primary") === 0);
  ok("Second screen captures the second: the dropdown counts from one, ddagrab from zero",
    captureIndex("2") === 1 && captureIndex("9") === 8);
  // Not an aspiration. ddagrab takes one output_idx and there is no d3d11
  // stack filter in this ffmpeg to compose several, so Both IS one screen at
  // this end. It is written down here so that a change making the host span
  // outputs has to come and delete this line, and so the page's shape check -
  // the thing that keeps the picture and the framebuffer honest with each
  // other - is not the only place that says so.
  ok("Both cannot be honoured: it is served the same single output as Main screen",
    captureIndex("full") === captureIndex("primary"));
  ok("and the command line says so too",
    graph(ffmpegArgs("h264_nvenc", { ...S60, display: "full" })) ===
    graph(ffmpegArgs("h264_nvenc", { ...S60, display: "primary" })));
  ok("Second screen reaches the command line as the second output",
    graph(ffmpegArgs("h264_nvenc", { ...S60, display: "2" }))
      .startsWith("ddagrab=output_idx=1:"));

  // Profile and level. The level follows the cap and the rate, so a viewer
  // that paces itself down lands on a lower rung of its own accord.
  ok("h264 is pinned to High and to the level the capped picture needs",
    nv[nv.indexOf("-profile:v") + 1] === "high" && nv[nv.indexOf("-level") + 1] === "3.2");
  const big = ffmpegArgs("h264_nvenc", { ...S60, maxh: 1080 });
  const slow = ffmpegArgs("h264_nvenc", { ...S60, maxh: 1080, fps: 30 });
  ok("1080p60 is the 4.2 the viewer's decoder may not carry; 1080p30 is 4.0",
    big[big.indexOf("-level") + 1] === "4.2" && slow[slow.indexOf("-level") + 1] === "4.0");
  const hv = ffmpegArgs("hevc_nvenc", { ...S60, codecs: ["hevc"] });
  ok("hevc asks for Main, not a ten-bit profile a built-in decoder would refuse",
    hv[hv.indexOf("-profile:v") + 1] === "main" && hv[hv.indexOf("-level") + 1] === "4.0");
  const a1 = ffmpegArgs("av1_nvenc", { ...S60, codecs: ["av1"] });
  ok("av1_nvenc takes a level but has no -profile option in this ffmpeg",
    a1[a1.indexOf("-level") + 1] === "4.0" && a1.indexOf("-profile:v") === -1);
  const qsv = ffmpegArgs("h264_qsv", S60);
  ok("qsv gets a profile and no level, because its help carries no -level",
    qsv[qsv.indexOf("-profile:v") + 1] === "high" && qsv.indexOf("-level") === -1);
  ok("with no cap there is no upper bound to name a level from",
    off.indexOf("-level") === -1 && off[off.indexOf("-profile:v") + 1] === "high");
}

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
  ok("log says which encoder is in use", logs.some((l) => l === "DECODER+ h264 via h264_nvenc"), logs.join(" | "));
  ok("settings() reports what is running", JSON.stringify(src.settings()) === JSON.stringify(S60));
  const argv = JSON.parse(fs.readFileSync(argsFile, "utf8").trim().split("\n").pop());
  ok("ffmpeg command: ddagrab primary at 60 fps without the cursor, nvenc vbr under an 8M ceiling, one-second GOP, raw h264 to stdout",
    argv[argv.indexOf("-filter_complex") + 1].startsWith("ddagrab=output_idx=0:framerate=60:draw_mouse=0,") && argv.includes("h264_nvenc") &&
    argv.join(" ").includes("-b:v 0 -cq 20 -maxrate 8M -bufsize 2000k -g 60 -bf 0") &&
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
  // Back under the limit is not caught up: a keyframe that picked it up here
  // would leave most of a megabyte of lag in front of every picture after it.
  b.backlog = 900 * 1024;
  await sleep(1100);
  ok("a skipped viewer is not resumed while still most of a megabyte behind",
    b.aus.length === before, b.aus.length - before + " AUs");
  b.backlog = 0;
  await until(() => b.aus.length > before, 1500);
  ok("viewer resumes on a keyframe once its backlog drains",
    b.aus.length > before && (b.aus[before].flags & 1) === 1);
  b.backlog = 300 * 1024;
  before = b.aus.length;
  await until(() => b.aus.length > before, 1500);
  ok("a backlog bigger than a keyframe but inside the limit still delivers",
    b.aus.length > before, b.aus.length - before + " AUs");
  // ...but not for ever: a queue that settles just under the limit is standing
  // latency, and it is skipped once it has sat there longer than a GOP.
  b.backlog = 900 * 1024;
  await sleep(1500);
  before = b.aus.length;
  await sleep(700);
  ok("a viewer that stays most of a megabyte behind is skipped, not fed for ever",
    b.aus.length === before, b.aus.length - before + " AUs");
  b.backlog = 0;
  await until(() => b.aus.length > before, 1500);
  ok("...and resumes on a keyframe once it drains",
    b.aus.length > before && (b.aus[before].flags & 1) === 1);
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
    argv[argv.indexOf("-filter_complex") + 1].startsWith("ddagrab=output_idx=1:framerate=30:draw_mouse=0,") && argv.join(" ").includes("-b:v 0 -cq 20 -maxrate 4M -bufsize 1000k -g 30 -bf 0"));
  ok("old ffmpeg was killed", !alive(pid1) && readPid() !== pid1);
  const firstAfter = a.aus.slice().reverse().find((x) => x.flags & 1);
  ok("the old viewer resumed on a keyframe from the new encoder", !!firstAfter);
  src.stop();
  ok("stop() closes viewers with 1001", a.closed && a.closed.code === 1001 && b.closed && b.closed.code === 1001);
}

// -- a viewer that switches settings and leaves before the old encoder exits --
// The new start waits on the old process's exit. Leaving inside that wait must
// still end in the idle stop, not in an encoder started for nobody.
{
  const src = createVideoSource({ ffmpeg: null, log: () => {} });
  const a = recorder();
  const offA = src.subscribe(S60, a);
  await until(() => a.aus.length >= 5, 3000);
  const pid1 = readPid();
  const offB = src.subscribe({ ...S60, fps: 30 }, recorder());
  offA();
  offB();
  await until(() => readPid() !== pid1, 3000);
  const pid2 = readPid();
  await until(() => !alive(pid2), 5000);
  ok("an encoder queued behind a switch is stopped when nobody is left to watch it",
    pid2 !== pid1 && !alive(pid2) && src.settings() === null);
  src.stop();
}

// -- the cap is part of what two viewers have to agree about ----------------
{
  const src = createVideoSource({ ffmpeg: null, log: () => {} });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.aus.length >= 5, 3000);
  const pid1 = readPid();
  const b = recorder();
  src.subscribe({ ...S60 }, b);
  await until(() => b.aus.length >= 3, 3000);
  ok("a viewer that wants the same picture joins the running encoder",
    a.configs.length === 1 && readPid() === pid1 && !b.closed);
  const c = recorder();
  src.subscribe({ ...S60, maxh: 1080 }, c);
  await until(() => a.configs.length >= 2 && c.aus.length >= 3, 3000);
  ok("a viewer that wants a different picture restarts the encoder rather than being served the wrong one",
    a.configs.length === 2 && readPid() !== pid1);
  const argv = JSON.parse(fs.readFileSync(argsFile, "utf8").trim().split("\n").pop());
  ok("and the encoder comes back with that viewer's box and its level",
    argv[argv.indexOf("-filter_complex") + 1].includes("min(1\\,min(1920/iw\\,1080/ih))") &&
    argv[argv.indexOf("-level") + 1] === "4.2", argv.join(" "));
  src.stop();
}

// -- the timestamps a presentation clock at the other end would read --------
//
// The stand-in writes a picture every 16 ms while the settings say sixty, so
// arrival time and capture cadence are measurably different things here. What
// goes on the wire has to be the cadence: an even 1000/60 per access unit, not
// when each one happened to fall out of the pipe.
{
  const src = createVideoSource({ ffmpeg: null, log: () => {} });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.aus.length >= 24, 4000);
  // Every step is one period. At most one may not be: a count that has drifted
  // from the wall clock is pulled back to it, which is a step of its own and is
  // meant to be rare - and even that one never goes backwards.
  const steps = (r, n) => r.aus.slice(1, n).map((x, i) => x.ts - r.aus[i].ts);
  const period = (list, p) => list.filter((d) => d !== Math.floor(p) && d !== Math.ceil(p)).length <= 1;
  const s60 = steps(a, 24);
  ok("timestamps are the capture cadence, not the arrival time",
    period(s60, 1000 / 60) && s60.every((d) => d >= 0), s60.join(","));
  const b = recorder();
  src.subscribe({ ...S60, fps: 30 }, b);
  await until(() => b.aus.length >= 12, 4000);
  const s30 = steps(b, 12);
  ok("a paced-down viewer gets that pace's period",
    period(s30, 1000 / 30) && s30.every((d) => d >= 0), s30.join(","));
  src.stop();
}

// -- a host whose GPU cannot scale still streams ----------------------------
//
// The cap is the one part of the command line that is identical for every
// encoder, so if the filter does not work on a host it fails all of them at
// once. The whole chain is then retried without it: worse pictures for a weak
// client, but a stream rather than no stream.
{
  process.env.CAST_FAKE_FFMPEG_FAIL = "h264_nvenc,h264_amf,h264_qsv,libx264";
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  const before = fs.readFileSync(argsFile, "utf8").trim().split("\n").length;
  src.subscribe(S60, a);
  await until(() => a.closed, 6000);
  const runs = fs.readFileSync(argsFile, "utf8").trim().split("\n").slice(before).map((l) => JSON.parse(l));
  const graphs = runs.map((r) => r[r.indexOf("-filter_complex") + 1]);
  ok("every encoder is tried with the cap, then every encoder again without it",
    graphs.length === 8 && graphs.slice(0, 4).every((g) => g.includes(",scale=w=trunc(")) &&
    graphs.slice(4).every((g) => !g.includes(",scale=w=trunc(") &&
      g.startsWith("ddagrab=output_idx=0:framerate=60:draw_mouse=0")),
    graphs.length + " runs");
  ok("the second pass names no level either, having no bound to name one from",
    runs.slice(4).every((r) => r.indexOf("-level") === -1));
  ok("the log says the cap was dropped before it says nothing started",
    logs.some((l) => /retrying without it$/.test(l)) &&
    logs.some((l) => /no encoder could start/.test(l)), logs.join(" | "));
  ok("only then are viewers closed", a.closed && a.closed.code === 1011 && a.closed.reason === "no encoder");
  src.stop();
  delete process.env.CAST_FAKE_FFMPEG_FAIL;
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
    logs.some((l) => /^DECODER\+ h264_nvenc failed \(exit 1\): Cannot load h264_nvenc$/.test(l)) &&
    logs.some((l) => /^DECODER\+ h264_amf failed/.test(l)) && logs.some((l) => l === "DECODER+ h264 via h264_qsv"),
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

// -- an encoder that stays alive but stops producing ------------------------
// ddagrab repeats frames to hold its rate, so silence from a live process is a
// wedge, not a still screen. Restarted like a crash, and bounded like one.
{
  process.env.CAST_FAKE_FFMPEG_STALL_AFTER = "2300";
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.configs.length >= 1, 3000);
  const pid1 = readPid();
  await until(() => a.configs.length >= 2, 8000);
  ok("an encoder that goes silent is killed and restarted, and the viewer gets a fresh config",
    a.configs.length === 2 && readPid() !== pid1 && !alive(pid1) && !a.closed &&
    logs.some((l) => /exited \(.*\): no picture from the encoder for 3s - restarting$/.test(l)),
    logs.join(" | "));
  await until(() => a.closed, 10000);
  ok("going silent again inside the crash window closes with 1011, not a restart storm",
    a.closed && a.closed.code === 1011 && a.closed.reason === "encoder died" && a.configs.length === 2,
    JSON.stringify(a.closed) + " " + logs.join(" | "));
  src.stop();
  delete process.env.CAST_FAKE_FFMPEG_STALL_AFTER;
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
    argv.join(" ").includes("-c:v av1_nvenc -preset p4 -tune ll -zerolatency 1 -delay 0 -rc vbr -spatial-aq 1 -b:v 0 -cq 32 -maxrate 8M") &&
    argv.join(" ").includes("-bf 0 -forced-idr 1 -level 4.0 -flush_packets 1 -f obu pipe:1") && !argv.includes("-profile:v"), argv.join(" "));
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
  ok("the log names the codec that ended up running", logs.some((l) => l === "DECODER+ hevc via hevc_amf"), logs.join(" | "));
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

/* == the three faults that only show themselves when something goes wrong == */

// The stand-in above is a well-behaved encoder. These three need a badly
// behaved one, so a second stand-in is written into the temp directory at run
// time - no new file in the repo - and wraps the first. It does three things
// the good one cannot:
//
//   CAST_GATE_LOCK    a file standing in for the screen. A run that starts
//                     normally takes it; a run that is killed cannot put it
//                     back, so the next run finds it held and fails the way
//                     ffmpeg does when the desktop duplication has not been
//                     let go of - once, clearing it on the way out.
//
//                     This models the CONSEQUENCE of F4, not its timing: how
//                     long Windows really takes to release the duplication
//                     after TerminateProcess is NOT VERIFIED here and cannot
//                     be, because reproducing it needs the GPU and a desktop.
//                     What is tested is the part that turned that race into
//                     the user's "no encoder" - that one failed start right
//                     after a restart is evidence about the screen and not
//                     about the encoder, whether the screen was held by the
//                     process just killed or by an ffmpeg an earlier run of
//                     this host orphaned.
//   CAST_GATE_ONLY    the one encoder name this machine has. Everything else
//                     exits 1, so a chain that walks past the first encoder
//                     walks all the way to the bottom, as it would on a host
//                     whose only encoder is its NVIDIA one.
//   CAST_GATE_STDERR  lines (separated by |) to write to stderr before exiting
//                     1, for the exit handler to pick a reason out of.
//   CAST_GATE_BAD_SPS a keyframe whose SPS is two bytes long - shorter than
//                     the three the codec string is made of.
const GATE = path.join(tmp, "gate-ffmpeg.mjs");
const gateArgs = path.join(tmp, "gate-args");
const gateLock = path.join(tmp, "gate-lock");
fs.writeFileSync(GATE, `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const argv = process.argv.slice(2);
const enc = argv[argv.indexOf("-c:v") + 1] || "";
const env = process.env;
if (env.CAST_GATE_ARGS) fs.appendFileSync(env.CAST_GATE_ARGS, JSON.stringify(argv) + "\\n");
if (env.CAST_GATE_LOCK && fs.existsSync(env.CAST_GATE_LOCK)) {
  fs.rmSync(env.CAST_GATE_LOCK, { force: true });
  process.stderr.write("[ddagrab @ 0000021a] IDXGIOutputDuplication::AcquireNextFrame failed: 0x887a0026\\n" +
    "av_interleaved_write_frame(): Broken pipe\\nConversion failed!\\n");
  process.exit(1);
}
if (env.CAST_GATE_STDERR) {
  process.stderr.write(env.CAST_GATE_STDERR.split("|").join("\\n") + "\\n");
  process.exit(1);
}
if (env.CAST_GATE_ONLY && enc !== env.CAST_GATE_ONLY) {
  process.stderr.write("Cannot load " + enc + "\\n");
  process.exit(1);
}
if (env.CAST_GATE_LOCK) fs.writeFileSync(env.CAST_GATE_LOCK, String(process.pid));
if (env.CAST_GATE_BAD_SPS) {
  // SPS, PPS, IDR, forever. The SPS is two bytes: enough for the parser to
  // file it as a parameter set, one byte short of a codec string.
  const SC = Buffer.from([0, 0, 0, 1]);
  const SPS2 = Buffer.from([0x67, 0x64]);
  const PPS2 = Buffer.from([0x68, 0xeb]);
  const idr = () => { const b = Buffer.alloc(400, 0x5a); b[0] = 0x65; b[1] = 0xc0; return b; };
  setInterval(() => process.stdout.write(Buffer.concat([SC, SPS2, SC, PPS2, SC, idr()])), 16);
} else {
  await import(pathToFileURL(env.CAST_GATE_FAKE).href);
}
`);
process.env.CAST_GATE_FAKE = FAKE;
process.env.CAST_GATE_ARGS = gateArgs;
process.env.CAST_GATE_LOCK = gateLock;
const gateReset = () => {
  fs.writeFileSync(gateArgs, "");
  fs.rmSync(gateLock, { force: true });
  delete process.env.CAST_GATE_ONLY;
  delete process.env.CAST_GATE_STDERR;
  delete process.env.CAST_GATE_BAD_SPS;
};
const gateRuns = () =>
  fs.readFileSync(gateArgs, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const encOf = (argv) => argv[argv.indexOf("-c:v") + 1];
const graphOf = (argv) => argv[argv.indexOf("-filter_complex") + 1];

/* --------------------------------- F1: a header this build cannot read --- */

// The picture size is read by running an exp-Golomb reader over a parameter
// set the encoder wrote, inside the encoder's stdout handler - where a throw
// has nothing above it and ends the host for every viewer at once. Before this
// was guarded, the block below did not fail this suite: it ended it, because
// the uncaught exception is in this process.
{
  process.env.CAST_FFMPEG_BIN = GATE;
  gateReset();
  process.env.CAST_GATE_BAD_SPS = "1";
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.aus.length >= 5, 4000);
  ok("a keyframe whose header cannot be read does not end the host",
    a.aus.length >= 5 && !a.closed, a.aus.length + " AUs");
  const cfg = a.configs[0] || {};
  ok("the viewer still gets a config, and one it can configure a decoder with",
    a.configs.length === 1 && cfg.codec === "avc1.64002a" && cfg.fps === 60 &&
    cfg.encoder === "h264_nvenc", JSON.stringify(cfg));
  ok("with no picture size in it, rather than a guessed one",
    cfg.width === undefined && cfg.height === undefined, JSON.stringify(cfg));
  ok("and the console says which header it could not read",
    logs.some((l) => /^DECODER\+ could not read the h264 header \(.+\) - sending the config without a picture size$/.test(l)),
    logs.join(" | "));
  ok("the frames themselves are unaffected", (a.aus[0].flags & 1) === 1);
  src.stop();
}

/* ------------------------- F3: the one line that reaches the console ----- */

// ffmpeg says how it ended after it says why it ended, so the last line of a
// failed run is the trailer and the cause is above it.
{
  const tail = [
    "[ddagrab @ 0000021a] IDXGIOutputDuplication::AcquireNextFrame failed: 0x887a0026",
    "[out#0/h264 @ 0000021b] Error muxing a packet",
    "av_interleaved_write_frame(): Broken pipe",
    "Conversion failed!",
  ].join("\n");
  ok("the reason is the cause, not the trailer three lines under it",
    ffmpegReason(tail) === "[ddagrab @ 0000021a] IDXGIOutputDuplication::AcquireNextFrame failed: 0x887a0026",
    ffmpegReason(tail));
  ok("the component prefix is kept, because it says what the cause is about",
    /^\[ddagrab/.test(ffmpegReason(tail)));
  ok("a run whose whole tail is trailers still gets an answer, not an empty one",
    ffmpegReason("Conversion failed!\n") === "Conversion failed!" &&
    ffmpegReason("av_interleaved_write_frame(): Broken pipe\nConversion failed!") === "Conversion failed!",
    ffmpegReason("av_interleaved_write_frame(): Broken pipe\nConversion failed!"));
  ok("an encoder that said nothing at all reports nothing at all",
    ffmpegReason("") === "" && ffmpegReason("  \r\n \n") === "" && ffmpegReason(undefined) === "");
  ok("a single-line tail is still that line",
    ffmpegReason("Cannot load h264_nvenc\n") === "Cannot load h264_nvenc");
  ok("trailing whitespace and CRLF do not change the answer",
    ffmpegReason("Unknown encoder 'h264_nvenc'\r\nConversion failed!\r\n") ===
    "Unknown encoder 'h264_nvenc'");

  // And through the real exit handler, which is the only place a person sees it.
  process.env.CAST_FFMPEG_BIN = GATE;
  gateReset();
  process.env.CAST_GATE_STDERR = tail.split("\n").join("|");
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.closed, 8000);
  ok("the line the console gets names the cause",
    logs.some((l) => /h264_nvenc failed \(exit 1\): \[ddagrab @ .+AcquireNextFrame failed/.test(l)),
    logs.join(" | "));
  ok("...and never the trailer that used to hide it",
    !logs.some((l) => /Conversion failed!/.test(l)), logs.join(" | "));
  src.stop();
}

/* --------- F4: a viewer changing settings must not walk the chain -------- */

// The restart path kills the encoder and starts its replacement. ffmpeg holds
// the desktop duplication until its process is gone, so a replacement that
// finds the screen still taken fails to start - and a failure to start is what
// the exit handler reads as "this encoder is not on this machine". It then
// walks nvenc, amf, qsv, libx264, and on a host whose only encoder is its
// NVIDIA one that ends at closeAll(1011, "no encoder") for every viewer,
// because one of them changed its frame rate.
//
// CAST_GATE_ONLY makes this that host, and the lock makes the first start
// after the kill fail exactly once. The assertion is not "it recovered": it
// does recover, and worse than not recovering. W2's retry-without-the-cap
// catches the exhausted chain and restarts it with no picture cap, so a viewer
// asking for 30 fps silently costs a Chromebook the scaling that is there for
// it, for the rest of the run, and the console says the GPU cannot scale when
// it can. So the assertion is that the chain is not walked at all.
{
  process.env.CAST_FFMPEG_BIN = GATE;
  gateReset();
  process.env.CAST_GATE_ONLY = "h264_nvenc";
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.aus.length >= 5, 4000);
  const pid1 = readPid();
  const b = recorder();
  src.subscribe({ ...S60, fps: 30 }, b);
  await until(() => a.configs.length >= 2 && b.aus.length >= 3, 8000);
  const runs = gateRuns();
  ok("a start that failed because the screen was still held costs one more start, not the chain",
    runs.length === 3 && runs.every((r) => encOf(r) === "h264_nvenc"),
    runs.map(encOf).join(" -> "));
  ok("...and the console says what actually went wrong",
    logs.filter((l) => /h264_nvenc failed \(exit 1\): \[ddagrab @ .+AcquireNextFrame/.test(l)).length === 1 &&
    !logs.some((l) => /h264_amf|h264_qsv|libx264/.test(l)), logs.join(" | "));
  ok("...never that the GPU cannot scale, which is how the cap used to be lost",
    !logs.some((l) => /retrying without it/.test(l)) &&
    graphOf(runs[runs.length - 1]).includes(",scale=w=trunc("), graphOf(runs[runs.length - 1]));
  ok("...and nobody is told there is no encoder",
    !a.closed && !b.closed && !logs.some((l) => /no encoder could start/.test(l)));
  ok("the stream comes back on a new process with the settings that were asked for",
    readPid() !== pid1 && !alive(pid1) && a.configs.length === 2 &&
    a.configs[1].fps === 30 && b.configs[0] === a.configs[1]);
  src.stop();
}

// The same holds for the restart after a crash. The encoder was producing
// pictures a moment ago; the first start after it dies failing is the screen,
// and walking the chain on it lands on libx264 or on no picture cap at all.
{
  process.env.CAST_FFMPEG_BIN = GATE;
  gateReset();
  process.env.CAST_GATE_ONLY = "h264_nvenc";
  process.env.CAST_FAKE_FFMPEG_DIE_AFTER = "2300";
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => gateRuns().length >= 3 && a.configs.length >= 2, 8000);
  const runs = gateRuns().slice(0, 3);
  ok("a restart after a crash that fails once is retried on the same encoder, not walked",
    runs.length === 3 && runs.every((r) => encOf(r) === "h264_nvenc" && graphOf(r).includes(",scale=w=trunc(")) &&
    !logs.some((l) => /retrying without it|no encoder could start/.test(l)),
    runs.map(encOf).join(" -> ") + " | " + logs.join(" | "));
  src.stop();
  delete process.env.CAST_FAKE_FFMPEG_DIE_AFTER;
}

// The extra start is spent once and not held in reserve: an encoder that is
// genuinely absent still falls through to the next one at the same speed.
{
  process.env.CAST_FFMPEG_BIN = GATE;
  gateReset();
  process.env.CAST_GATE_ONLY = "h264_qsv";
  const logs = [];
  const src = createVideoSource({ ffmpeg: null, log: (l) => logs.push(l) });
  const a = recorder();
  src.subscribe(S60, a);
  await until(() => a.aus.length >= 5, 5000);
  const b = recorder();
  src.subscribe({ ...S60, fps: 30 }, b);
  await until(() => a.configs.length >= 2 && b.aus.length >= 3, 8000);
  ok("a restart on a host with only one working encoder still finds it",
    a.configs.length === 2 && a.configs[1].encoder === "h264_qsv" && !a.closed && !b.closed,
    JSON.stringify(a.configs[1]));
  const after = gateRuns().map(encOf).slice(gateRuns().map(encOf).indexOf("h264_nvenc", 1));
  ok("...by trying the top of the chain twice and then walking it exactly once",
    after.join(" -> ") === "h264_nvenc -> h264_nvenc -> h264_amf -> h264_qsv", after.join(" -> "));
  src.stop();
}

// The same wait must not slow down a start that has nothing to wait for, and
// must not resurrect an encoder that was deliberately stopped.
{
  process.env.CAST_FFMPEG_BIN = GATE;
  gateReset();
  const src = createVideoSource({ ffmpeg: null, log: () => {} });
  const a = recorder();
  const began = Date.now();
  src.subscribe(S60, a);
  await until(() => a.aus.length >= 1, 4000);
  ok("a first viewer's encoder starts at once - there is nothing dying to wait for",
    Date.now() - began < 1500, Date.now() - began + " ms");
  src.stop();
  const after = readPid();
  await sleep(300);
  ok("stop() during the settle leaves nothing running", readPid() === after && !alive(after));
  ok("and the viewer was closed, not left waiting", a.closed && a.closed.code === 1001);
}

process.env.CAST_FFMPEG_BIN = FAKE;
gateReset();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

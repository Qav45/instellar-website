// Boots the real cast-host with fake-ffmpeg.mjs standing in for ffmpeg and reads
// the /video route with a hand-rolled WebSocket client: the wire protocol the
// page relies on (config text first, keyframe first, monotone timestamps), what a
// late second viewer sees, when the encoder is let go, and how --video off
// answers. No screen is captured anywhere in this file: the stream is filler.
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST_SCRIPT = fileURLToPath(new URL("../cast-host.mjs", import.meta.url));
const FAKE_FFMPEG = fileURLToPath(new URL("./fake-ffmpeg.mjs", import.meta.url));
const REPO = path.dirname(HOST_SCRIPT);
const VNC_PORT = 59031;
const PORT = 60831;
const PID_FILE = path.join(os.tmpdir(), "cast-video-route-" + process.pid + ".pid");

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stand-in for TightVNC so the host's startup probe passes; /video never touches it.
const vnc = net.createServer((sock) => { sock.write("RFB 003.008\n"); sock.on("error", () => {}); });
await new Promise((r) => vnc.listen(VNC_PORT, "127.0.0.1", r));

function boot(extra) {
  const proc = spawn(process.execPath, [
    HOST_SCRIPT, "--tunnel", "none", "--lan", "--port", String(PORT),
    "--vnc", "127.0.0.1:" + VNC_PORT, "--share", "nope",
  ].concat(extra), {
    cwd: REPO, windowsHide: true,
    env: Object.assign({}, process.env, { CAST_FFMPEG_BIN: FAKE_FFMPEG, CAST_FAKE_FFMPEG_PID: PID_FILE }),
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error("host did not start:\n" + out)), 15000);
    const scan = (c) => {
      out += String(c);
      if (/Leave this window open/.test(out)) { clearTimeout(t); resolve({ proc, log: () => out }); }
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    proc.on("exit", (code) => { clearTimeout(t); reject(new Error("exited " + code + ":\n" + out)); });
  });
}

const get = (p) => new Promise((resolve) => {
  http.get({ host: "127.0.0.1", port: PORT, path: p }, (res) => {
    let b = ""; res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, body: b }));
  }).on("error", (e) => resolve({ status: 0, body: String(e.message) }));
});

const sessionKey = async () => ((await get("/")).body.match(/CAST_DIRECT="([\w-]+)"/) || [])[1] || "";

// Minimal WS client: upgrades, then hands back decoded server frames as
// { op, payload } in order. Pings are answered so the host's keepalive is happy.
function connect(query) {
  const frames = [];
  const waiters = [];
  let status = "";
  const c = { frames, status: () => status, sock: null, closed: false };
  c.next = (pred) => new Promise((resolve, reject) => {
    const scan = () => {
      const i = frames.findIndex(pred || (() => true));
      if (i >= 0) { resolve(frames.splice(0, i + 1).pop()); return true; }
      if (c.closed) { reject(new Error("socket closed" + (status ? " after: " + status : ""))); return true; }
      return false;
    };
    if (!scan()) waiters.push(scan);
  });
  c.close = () => { if (c.sock) c.sock.destroy(); };

  const sock = net.connect(PORT, "127.0.0.1", () => {
    sock.write("GET /video?" + query + " HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\nSec-WebSocket-Key: " + crypto.randomBytes(16).toString("base64") +
      "\r\nSec-WebSocket-Version: 13\r\n\r\n");
  });
  c.sock = sock;
  let raw = Buffer.alloc(0), up = false;
  sock.on("data", (d) => {
    raw = Buffer.concat([raw, d]);
    if (!up) {
      const i = raw.indexOf("\r\n\r\n");
      if (i < 0) return;
      status = String(raw.subarray(0, i)).split("\r\n")[0];
      raw = raw.subarray(i + 4);
      up = true;
      if (!/ 101 /.test(status)) { c.closed = true; sock.destroy(); }
    }
    for (;;) {
      if (raw.length < 2) break;
      const op = raw[0] & 0x0f;
      let len = raw[1] & 0x7f, off = 2;
      if (len === 126) { if (raw.length < 4) break; len = raw.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (raw.length < 10) break; len = Number(raw.readBigUInt64BE(2)); off = 10; }
      if (raw.length < off + len) break;
      const payload = Buffer.from(raw.subarray(off, off + len));
      raw = raw.subarray(off + len);
      if (op === 0x9) { sock.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])); continue; }   // pong, masked
      frames.push({ op, payload });
    }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1);
  });
  const gone = () => { c.closed = true; for (const w of waiters.splice(0)) w(); };
  sock.on("close", gone);
  sock.on("error", gone);
  return c;
}

const pidAlive = () => {
  try { process.kill(Number(fs.readFileSync(PID_FILE, "utf8")), 0); return true; } catch (_) { return false; }
};

// AU header: flags byte, then u32 timestamp; NAL type of the first NAL after it.
const header = (p) => ({ flags: p[0], ts: p.readUInt32BE(1), firstNal: p[9] & 0x1f });

/* ---- the route with the encoder stand-in ------------------------------------ */
{
  const host = await boot(["--video", "on"]);
  const key = await sessionKey();
  ok("nothing is spawned before a viewer asks", !fs.existsSync(PID_FILE));

  const ctl = JSON.parse((await get("/ctl?k=" + key + "&stream=0")).body);
  ok("/ctl?stream= reply says video:true", ctl.video === true, JSON.stringify(ctl));

  const nokey = connect("v=t1");
  await new Promise((r) => nokey.sock.on("close", r));
  ok("no key -> 403", /^HTTP\/1\.1 403/.test(nokey.status()), nokey.status());

  const a = connect("k=" + key + "&v=t1&fps=30&mbps=6&display=primary");
  const cfgFrame = await a.next();
  ok("first message is a text frame", cfgFrame.op === 0x1, "op " + cfgFrame.op);
  const cfg = JSON.parse(String(cfgFrame.payload));
  ok("config carries codec/width/height from the SPS",
     cfg.type === "config" && cfg.codec === "avc1.64002a" && cfg.width === 1920 && cfg.height === 1080,
     JSON.stringify(cfg));
  ok("config echoes the viewer's settings", cfg.fps === 30 && cfg.mbps === 6 && cfg.display === "primary");
  ok("host logged the encoder", /video\s+h264 via \w+/.test(host.log()));

  const first = await a.next((f) => f.op === 0x2);
  const h0 = header(first.payload);
  ok("first binary is a keyframe: flags=1 and SPS leads the AU", h0.flags === 1 && h0.firstNal === 7,
     "flags " + h0.flags + " nal " + h0.firstNal);

  // Twenty more, across a GOP boundary would be nicer but 30 AUs is a second;
  // non-decreasing is the property, not the gap.
  let prev = h0.ts, mono = true, deltas = 0;
  for (let i = 0; i < 20; i++) {
    const f = await a.next((x) => x.op === 0x2);
    const h = header(f.payload);
    if (h.ts < prev) mono = false;
    prev = h.ts;
    if (h.flags === 0) deltas++;
  }
  ok("timestamps never go backwards", mono);
  ok("delta frames follow with flags=0", deltas > 0, deltas + " deltas");
  ok("encoder is running", pidAlive());

  // Mid-GOP second viewer: same settings, so no restart, and it must start on the
  // cached keyframe rather than on whatever AU is next off the encoder.
  const b = connect("k=" + key + "&v=t2&fps=30&mbps=6&display=primary");
  const bCfg = await b.next();
  ok("second viewer gets config first", bCfg.op === 0x1);
  const bFirst = await b.next((f) => f.op === 0x2);
  const hb = header(bFirst.payload);
  ok("second viewer starts on a keyframe too", hb.flags === 1 && hb.firstNal === 7,
     "flags " + hb.flags + " nal " + hb.firstNal);
  ok("first viewer is still receiving", (await a.next((f) => f.op === 0x2)).op === 0x2);

  a.close();
  await sleep(1500);
  ok("encoder stays up while a viewer remains", pidAlive());
  b.close();
  await sleep(1500);
  ok("encoder still up 1.5s after the last viewer left", pidAlive());
  await sleep(3000);
  ok("encoder gone ~3s after the last viewer left", !pidAlive());

  host.proc.kill();
  await new Promise((r) => host.proc.on("exit", r));
}

/* ---- --video off ------------------------------------------------------------ */
{
  const host = await boot(["--video", "off"]);
  const key = await sessionKey();
  ok("host logs why video is off", /video\s+off \(--video off\)/.test(host.log()));
  const ctl = JSON.parse((await get("/ctl?k=" + key + "&stream=0")).body);
  ok("/ctl?stream= reply says video:false", ctl.video === false, JSON.stringify(ctl));

  const c = connect("k=" + key + "&v=t3");
  await new Promise((r) => c.sock.on("close", r));
  ok("keyed /video -> 404 with the route off", /^HTTP\/1\.1 404/.test(c.status()), c.status());
  const nokey = connect("v=t3");
  await new Promise((r) => nokey.sock.on("close", r));
  ok("unkeyed /video is still 403, not 404", /^HTTP\/1\.1 403/.test(nokey.status()), nokey.status());
  ok("nothing was ever spawned", !pidAlive());

  host.proc.kill();
  await new Promise((r) => host.proc.on("exit", r));
}

try { fs.unlinkSync(PID_FILE); } catch (_) {}
vnc.close();
console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

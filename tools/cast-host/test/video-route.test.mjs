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
// Port 0: Windows hands out ephemeral client ports from 49152 up, so a fixed
// number in that range is one a passing browser or another suite can be holding
// when this one starts - which fails the whole file on a bind rather than on
// anything it is testing.
await new Promise((r) => vnc.listen(0, "127.0.0.1", r));
const VNC_PORT = vnc.address().port;

function boot(extra, opts = {}) {
  const proc = spawn(process.execPath, [
    HOST_SCRIPT, "--tunnel", opts.tunnel || "none", "--lan", "--port", String(PORT),
    "--vnc", "127.0.0.1:" + VNC_PORT, "--share", "nope",
  ].concat(opts.site ? ["--site", opts.site] : [], extra), {
    cwd: REPO, windowsHide: true,
    env: Object.assign({}, process.env,
      { CAST_FFMPEG_BIN: FAKE_FFMPEG, CAST_FAKE_FFMPEG_PID: PID_FILE,
        CAST_SESSION_KEY: KEY }, opts.env || {}),
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

// Pinned through the host's test hook rather than read back off loopback: the
// page carrying this key is served on the --lan listener alone now.
const KEY = "video-route-test-" + process.pid;
const sessionKey = async () => KEY;

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
// Which encoder, not just whether one is running. A viewer rejoining inside the
// idle window must land on the same process; a restart is a different number.
const pidOf = () => {
  try { return fs.readFileSync(PID_FILE, "utf8").trim(); } catch (_) { return ""; }
};
const forget = () => { try { fs.unlinkSync(PID_FILE); } catch (_) {} };

// The close-frame payload the host sends with 1011 and friends: u16 code, then
// the reason as UTF-8.
const closeCode = (p) => (p.length >= 2 ? p.readUInt16BE(0) : 0);
const closeWhy = (p) => String(p.subarray(2));
const count = (text, re) => (text.match(re) || []).length;

// Raw codes leaking into the console are the thing this whole pass is about: a
// laptop lid or a tunnel drop is not a fault, and ECONNRESET printed next to a
// running stream reads as one.
const RAW_CODES = /ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|write after end|stream was destroyed|ERR_STREAM/;

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
  ok("host logged the encoder", /DECODER\+ h264 via \w+/.test(host.log()));

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
  ok("host logs why video is off", /DECODER\+ off \(--video off\)/.test(host.log()));
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

/* ---- the races: a viewer leaving badly, and one coming back quickly -------- */
// The user's complaint is "random errors while the stream is running", and
// random-while-running is the shape of a lifecycle race rather than of a broken
// happy path. Everything below is one of those, provoked deliberately.
{
  forget();
  const host = await boot(["--video", "on"]);
  const key = await sessionKey();
  const settings = "&fps=30&mbps=6&display=primary";

  const a = connect("k=" + key + "&v=r1" + settings);
  await a.next((f) => f.op === 0x2);
  const firstPid = pidOf();
  ok("an encoder is running for the first viewer", firstPid !== "" && pidAlive());

  // Leave, then come back inside the three-second idle window. The encoder is
  // kept warm for exactly this - a viewer reloading the page, or a Chromebook
  // whose tunnel blinked - and the viewer must land on the running process
  // rather than on a restart racing the stop that was already scheduled.
  a.close();
  await sleep(1200);
  const b = connect("k=" + key + "&v=r2" + settings);
  const bCfg = await b.next((f) => f.op === 0x1);
  const bKey = await b.next((f) => f.op === 0x2);
  ok("a viewer returning inside the idle window gets config and a keyframe",
     JSON.parse(String(bCfg.payload)).type === "config" && header(bKey.payload).flags === 1);
  ok("...on the same encoder, not a restart", pidOf() === firstPid,
     firstPid + " -> " + pidOf());
  ok("...and the host did not log a restart", !/restarting for/.test(host.log()));

  // A second viewer that stops reading and is then destroyed mid-frame. This is
  // the lid closing on a Chromebook: the host has access units in flight for a
  // socket the kernel has already torn down. It must cost that viewer and
  // nobody else - not the fan-out loop, not the other viewer, not the host.
  const c = connect("k=" + key + "&v=r3" + settings);
  await c.next((f) => f.op === 0x2);
  c.sock.pause();                      // stop draining, so the host queues for it
  await sleep(300);
  // An explicit RST rather than destroy(): a lid closing or a tunnel dropping a
  // socket mid-frame is what this looks like on the wire, and it is what makes
  // the host's next write fail with a raw code rather than end cleanly.
  c.sock.resetAndDestroy();

  let stillFlowing = 0;
  for (let i = 0; i < 20; i++) { await b.next((f) => f.op === 0x2); stillFlowing++; }
  ok("the surviving viewer keeps receiving through the other one's death", stillFlowing === 20);
  ok("the host is still up", host.proc.exitCode === null);
  ok("the encoder is still up", pidOf() === firstPid && pidAlive());
  ok("the reset viewer was reported", /DECODER\+ viewer gone/.test(host.log()));
  ok("...in words, not as a raw socket error code", !RAW_CODES.test(host.log()),
     (host.log().match(RAW_CODES) || [])[0] || "");
  ok("no uncaught exception", !/Internal host error|internal promise error/.test(host.log()));

  b.close();
  host.proc.kill();
  await new Promise((r) => host.proc.on("exit", r));
}

/* ---- a viewer that hangs up inside the upgrade ------------------------------ */
// The close frame arrives in the same TCP segment as the upgrade request, so it
// is in `head` and the route tears down before it has subscribed. Subscribing
// anyway started an encoder for nobody and left a sink in video.mjs that nothing
// would ever remove: the set never empties, so the idle stop never fires and the
// host writes a frame into a destroyed socket sixty times a second for the rest
// of the run.
{
  forget();
  const host = await boot(["--video", "on"]);
  const key = await sessionKey();

  const sock = net.connect(PORT, "127.0.0.1", () => {
    sock.write(Buffer.concat([
      Buffer.from("GET /video?k=" + key + "&v=g1&fps=30&mbps=6 HTTP/1.1\r\nHost: x\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " +
        crypto.randomBytes(16).toString("base64") + "\r\nSec-WebSocket-Version: 13\r\n\r\n"),
      Buffer.from([0x88, 0x80, 0, 0, 0, 0]),          // masked, empty close
    ]));
  });
  sock.on("data", () => {});           // read, or the FIN the host sends is never seen
  sock.on("error", () => {});
  await new Promise((r) => sock.on("close", r));
  await sleep(1000);
  ok("a viewer gone before it subscribed never starts an encoder", !fs.existsSync(PID_FILE));
  ok("...and the host says so once", count(host.log(), /DECODER\+ viewer gone/g) === 1,
     host.log().split("\n").filter((l) => /DECODER\+ viewer/.test(l)).join(" | "));

  // Not a vacuous check: a viewer that stays does start one.
  const real = connect("k=" + key + "&v=g2&fps=30&mbps=6&display=primary");
  await real.next((f) => f.op === 0x2);
  ok("a viewer that stays still gets an encoder", pidAlive());
  real.close();
  await sleep(4000);
  ok("and it is let go at the idle deadline", !pidAlive());
  ok("no uncaught exception", !/Internal host error|internal promise error/.test(host.log()));

  host.proc.kill();
  await new Promise((r) => host.proc.on("exit", r));
}

/* ---- an encoder that dies, restarts, and dies again ------------------------- */
// Both branches of the crash rule in one boot. The stand-in exits 3 after 2.6s
// on every run: past STARTUP_MS with a picture already produced, so the first
// death is a restart; the second is inside CRASH_WINDOW_MS of it, so it is
// final and the viewer is closed with 1011 rather than left on a dead socket.
{
  forget();
  const host = await boot(["--video", "on"], { env: { CAST_FAKE_FFMPEG_DIE_AFTER: "2600" } });
  const key = await sessionKey();

  const v = connect("k=" + key + "&v=d1&fps=30&mbps=6&display=primary");
  const cfg1 = await v.next((f) => f.op === 0x1);
  await v.next((f) => f.op === 0x2);
  const pid1 = pidOf();
  ok("the dying encoder served a picture first", JSON.parse(String(cfg1.payload)).type === "config");

  // The restart must be invisible to the viewer beyond a fresh config: same
  // socket, no close, frames again.
  const cfg2 = await v.next((f) => f.op === 0x1);
  ok("a first death restarts the encoder under the same viewer",
     JSON.parse(String(cfg2.payload)).type === "config");
  ok("...on a new process", pidOf() !== pid1, pid1 + " -> " + pidOf());
  ok("...and says so in one line", /DECODER\+ \S+ exited \(3\).* - restarting/.test(host.log()));
  const after = await v.next((f) => f.op === 0x2);
  ok("frames resume after the restart", header(after.payload).flags === 1);

  // Second death inside the window: named, final, and told to the viewer.
  const bye = await v.next((f) => f.op === 0x8);
  ok("a second death closes the viewer with 1011", closeCode(bye.payload) === 1011,
     String(closeCode(bye.payload)));
  ok("...and names it", closeWhy(bye.payload) === "encoder died", closeWhy(bye.payload));
  ok("...and says so once, not twice", count(host.log(), /died again/g) === 1);
  ok("the host survived both deaths", host.proc.exitCode === null);
  ok("no uncaught exception", !/Internal host error|internal promise error/.test(host.log()));

  v.close();
  host.proc.kill();
  await new Promise((r) => host.proc.on("exit", r));
}

/* ---- the tunnel's routine chatter stays out of the console ------------------ */
// cloudflared rotates its four edge connections on a schedule of its own and
// prints an informational line for each rotation. Those lines matched the old
// filter, so a console whose only other content is errors filled up with them -
// which is most of what "random errors while the stream is running" is. A
// warning or an error still gets through, and four identical ones get through
// once.
{
  const TUNNEL_BIN = path.join(os.tmpdir(), "cast-noisy-tunnel-" + process.pid + ".mjs");
  fs.writeFileSync(TUNNEL_BIN, [
    'console.log("https://cast-noise-1.trycloudflare.com");',
    'const t = () => new Date().toISOString().replace(/\\.\\d+Z$/, "Z");',
    "setTimeout(() => {",
    '  for (let i = 0; i < 4; i++) console.error(t() + " INF Unregistered tunnel connection connIndex=" + i);',
    '  for (let i = 0; i < 4; i++) console.error(t() + " ERR Failed to serve quic connection error=\\"timeout\\" connIndex=" + i);',
    '  console.error(t() + " WRN Connection terminated error=\\"context canceled\\"");',
    "}, 500);",
    "setInterval(() => {}, 1000);",
  ].join("\n"));

  const registry = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  });
  await new Promise((r) => registry.listen(0, "127.0.0.1", r));

  forget();
  const host = await boot(["--video", "off"], {
    tunnel: "cloudflared",
    site: "http://127.0.0.1:" + registry.address().port,
    env: { CAST_TUNNEL_BIN: TUNNEL_BIN },
  });
  await sleep(1500);
  const out = host.log();
  ok("a routine connection rotation is not printed as an error", !/Unregistered/.test(out),
     (out.match(/.*Unregistered.*/) || [])[0] || "");
  ok("a real error is printed", /tunnel: .*Failed to serve quic/.test(out));
  ok("...once, not once per connection", count(out, /Failed to serve quic/g) === 1,
     count(out, /Failed to serve quic/g) + " lines");
  ok("a warning is printed too", /tunnel: .*Connection terminated/.test(out));

  host.proc.kill();
  await new Promise((r) => host.proc.on("exit", r));
  registry.close();
  try { fs.unlinkSync(TUNNEL_BIN); } catch (_) {}
}

try { fs.unlinkSync(PID_FILE); } catch (_) {}
vnc.close();
console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

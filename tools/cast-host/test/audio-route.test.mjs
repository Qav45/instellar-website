// Boots the real cast-host with fake-mic.mjs standing in for ffmpeg and reads
// /audio with a hand-rolled WebSocket client: the same key as /video, the mic
// opened by the first listener and let go after the last, a listener that stops
// reading costing it audio rather than the host memory, and a missing device
// or binary answered with a close rather than a crash. No microphone is opened
// anywhere in this file: the "audio" is filler.
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST_SCRIPT = fileURLToPath(new URL("../cast-host.mjs", import.meta.url));
const FAKE_MIC = fileURLToPath(new URL("./fake-mic.mjs", import.meta.url));
const REPO = path.dirname(HOST_SCRIPT);
const PORT = 60851;
const PID_FILE = path.join(os.tmpdir(), "cast-audio-route-" + process.pid + ".pid");
const ARGS_FILE = path.join(os.tmpdir(), "cast-audio-route-" + process.pid + ".args");
const KEY = "audio-route-test-" + process.pid;

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stand-in for TightVNC so the host's startup probe passes.
const vnc = net.createServer((sock) => { sock.write("RFB 003.008\n"); sock.on("error", () => {}); });
await new Promise((r) => vnc.listen(0, "127.0.0.1", r));
const VNC_PORT = vnc.address().port;

function boot(extra, env) {
  const proc = spawn(process.execPath, [
    HOST_SCRIPT, "--tunnel", "none", "--port", String(PORT),
    "--vnc", "127.0.0.1:" + VNC_PORT, "--share", "nope",
  ].concat(extra), {
    cwd: REPO, windowsHide: true,
    env: Object.assign({}, process.env,
      { CAST_FFMPEG_BIN: FAKE_MIC, CAST_FAKE_MIC_PID: PID_FILE, CAST_FAKE_MIC_ARGS: ARGS_FILE,
        CAST_SESSION_KEY: KEY }, env || {}),
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
const halt = async (host) => {
  host.proc.removeAllListeners("exit");
  host.proc.kill();
  await new Promise((r) => host.proc.on("exit", r));
};

// Minimal WS client, as in video-route.test.mjs: decoded server frames in order,
// pings answered.
function connect(route, query) {
  const frames = [];
  const waiters = [];
  let status = "";
  const c = { frames, status: () => status, closed: false };
  c.next = (pred) => new Promise((resolve, reject) => {
    const scan = () => {
      const i = frames.findIndex(pred || (() => true));
      if (i >= 0) { resolve(frames.splice(0, i + 1).pop()); return true; }
      if (c.closed) { reject(new Error("socket closed" + (status ? " after: " + status : ""))); return true; }
      return false;
    };
    if (!scan()) waiters.push(scan);
  });
  c.upgraded = new Promise((r) => (c.onStatus = r));
  const sock = net.connect(PORT, "127.0.0.1", () => {
    sock.write("GET " + route + "?" + query + " HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\nSec-WebSocket-Key: " + crypto.randomBytes(16).toString("base64") +
      "\r\nSec-WebSocket-Version: 13\r\n\r\n");
  });
  c.sock = sock;
  c.close = () => sock.destroy();
  let raw = Buffer.alloc(0), up = false;
  sock.on("data", (d) => {
    raw = Buffer.concat([raw, d]);
    if (!up) {
      const i = raw.indexOf("\r\n\r\n");
      if (i < 0) return;
      status = String(raw.subarray(0, i)).split("\r\n")[0];
      raw = raw.subarray(i + 4);
      up = true;
      c.onStatus(status);
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
      if (op === 0x9) { sock.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])); continue; }
      frames.push({ op, payload });
    }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1);
  });
  const gone = () => { c.closed = true; c.onStatus(status); for (const w of waiters.splice(0)) w(); };
  sock.on("close", gone);
  sock.on("error", gone);
  return c;
}

const pidOf = () => { try { return fs.readFileSync(PID_FILE, "utf8").trim(); } catch (_) { return ""; } };
const alive = (pid) => { try { process.kill(Number(pid), 0); return !!pid; } catch (_) { return false; } };
const forget = () => { for (const f of [PID_FILE, ARGS_FILE]) try { fs.unlinkSync(f); } catch (_) {} };
const closeCode = (p) => (p.length >= 2 ? p.readUInt16BE(0) : 0);
const closeWhy = (p) => String(p.subarray(2));
const isPcm = (f) => f.op === 0x2;

/* -------------------------------------------------- the key is /video's -- */
{
  forget();
  const host = await boot([]);
  for (const [name, q] of [["no key", ""], ["a wrong key", "k=nope"], ["the key's prefix", "k=" + KEY.slice(0, -1)]]) {
    const a = connect("/audio", q), v = connect("/video", q);
    const [sa, sv] = [await a.upgraded, await v.upgraded];
    ok("/audio with " + name + " is refused exactly as /video is", / 403 /.test(sa) && sa === sv, sa + " | " + sv);
  }
  await sleep(300);
  ok("...and a refused listener opens no mic", !pidOf());
  const a = connect("/audio", "k=" + KEY), v = connect("/video", "k=" + KEY);
  const [sa, sv] = [await a.upgraded, await v.upgraded];
  ok("the session key opens both", / 101 /.test(sa) && / 101 /.test(sv), sa + " | " + sv);
  a.close(); v.close();
  await halt(host);
  await sleep(300);
  forget();
}

/* ------------------------------------ first listener opens, last closes -- */
{
  forget();
  const host = await boot([], { CAST_MIC: "Test Mic (fake)" });
  await sleep(300);
  ok("nobody listening, no mic", !pidOf());
  const a = connect("/audio", "k=" + KEY);
  const cfg = await a.next();
  let parsed = null;
  try { parsed = JSON.parse(String(cfg.payload)); } catch (_) {}
  ok("config comes first, as text", cfg.op === 0x1 && parsed && parsed.rate === 16000 && parsed.channels === 1,
     String(cfg.payload));
  const first = await a.next(isPcm);
  ok("then 20ms chunks of PCM", first.payload.length === 640, first.payload.length + " bytes");
  const pid = pidOf();
  ok("the first listener opened the mic", alive(pid));
  const argv = JSON.parse(fs.readFileSync(ARGS_FILE, "utf8").trim().split("\n")[0]);
  ok("...the device CAST_MIC names", argv.includes("audio=Test Mic (fake)"), argv.join(" "));
  ok("...with a small dshow buffer", argv[argv.indexOf("-audio_buffer_size") + 1] === "20");
  ok("...mono s16le", argv.join(" ").includes("-ac 1 -ar 16000 -f s16le"));

  const b = connect("/audio", "k=" + KEY);
  await b.next(isPcm);
  ok("a second listener shares the same process", pidOf() === pid);
  a.close();
  await sleep(2600);
  ok("one leaving keeps it open for the other", alive(pid));
  await b.next(isPcm);
  b.close();
  await sleep(600);
  const c = connect("/audio", "k=" + KEY);
  await c.next(isPcm);
  ok("a listener back inside the idle window finds the same process", pidOf() === pid);
  c.close();
  await sleep(3000);
  ok("the last one leaving closes the mic", !alive(pid));
  ok("...and says so", /mic off \(nobody listening\)/.test(host.log()));
  await halt(host);
  forget();
}

/* -------------------------------------------- a slow listener is bounded -- */
{
  forget();
  // ~200 chunks every few ms: far more than a paused socket and the kernel's
  // buffers under it can hold, so anything unbounded shows.
  const host = await boot([], { CAST_FAKE_MIC_TICK_MS: "2", CAST_FAKE_MIC_BURST: "200" });
  const slow = connect("/audio", "k=" + KEY);
  await slow.next(isPcm);
  const fast = connect("/audio", "k=" + KEY);
  await fast.next(isPcm);
  slow.sock.pause();
  await sleep(3000);
  slow.sock.resume();
  await sleep(500);
  const seqs = slow.frames.filter(isPcm).map((f) => f.payload.readUInt32BE(0));
  const last = Math.max(...fast.frames.filter(isPcm).map((f) => f.payload.readUInt32BE(0)));
  let gaps = 0;
  for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1] + 1) gaps++;
  ok("a listener that stopped reading lost audio rather than queueing it",
     gaps > 0 && seqs.length < last / 2, seqs.length + " of " + last + " chunks, " + gaps + " gaps");
  ok("...and its chunks still arrive in order", seqs.every((s, i) => !i || s > seqs[i - 1]));
  ok("the host is still up", host.proc.exitCode === null);
  slow.close(); fast.close();
  await halt(host);
  await sleep(300);
  forget();
}

/* -------------------------------------------------- no mic, no crash -- */
{
  forget();
  const host = await boot([], { CAST_FAKE_MIC_MISSING: "1" });
  const a = connect("/audio", "k=" + KEY);
  const end = await a.next((f) => f.op === 0x8).catch(() => null);
  ok("a missing device closes the listener with 1011 \"no mic\"",
     end && closeCode(end.payload) === 1011 && closeWhy(end.payload) === "no mic",
     end ? closeCode(end.payload) + " " + closeWhy(end.payload) : "no close frame");
  ok("...logs why", /mic unavailable: .*Could not find audio only device|mic unavailable: .*I\/O error/.test(host.log()));
  const again = connect("/audio", "k=" + KEY);
  const end2 = await again.next((f) => f.op === 0x8).catch(() => null);
  ok("...and the next listener gets the same answer", end2 && closeWhy(end2.payload) === "no mic");
  ok("the host is still up", host.proc.exitCode === null);
  await halt(host);
  forget();
}
{
  // No ffmpeg binary where it was said to be: spawn fails, it never exits.
  const host = await boot(["--ffmpeg", path.join(os.tmpdir(), "no-such-ffmpeg-" + process.pid + ".exe")],
                          { CAST_FFMPEG_BIN: "" });
  const a = connect("/audio", "k=" + KEY);
  const end = await Promise.race([a.next((f) => f.op === 0x8).catch(() => null), sleep(3000)]);
  ok("a missing ffmpeg binary closes the listener with 1011", end && closeCode(end.payload) === 1011,
     end ? closeWhy(end.payload) : "no close frame in 3s");
  ok("the host is still up", host.proc.exitCode === null);
  await halt(host);
}
{
  const host = await boot([], { CAST_MIC: "off" });
  const a = connect("/audio", "k=" + KEY);
  const s = await a.upgraded;
  ok("CAST_MIC=off: /audio is a 404 to a keyed request", / 404 /.test(s), s);
  const b = connect("/audio", "k=nope");
  ok("...and still a 403 to anyone else", / 403 /.test(await b.upgraded));
  await halt(host);
}

forget();
vnc.close();
console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

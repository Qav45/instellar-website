// LAN host for /room: LL-HLS tunnel, camera-only speech, local transcription.
// Run: node room-host.mjs [--no-stt] [--no-say]
// Camera video/audio come from the Wyze bridge. go2rtc supplies native talkback.
// The browser receives media over HTTPS; WebRTC would need a separate ICE path
// (direct connectivity or TURN), which the HTTP tunnel alone does not provide.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { speakOnCamera } from "./camera-speech.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// .env if there is one, the process environment otherwise, with the file winning.
// The file is the normal way in; the environment is what makes this runnable as a
// service, or on a machine whose tooling is not allowed to write a .env at all.
const env = { ...process.env, ...loadEnv(path.join(HERE, ".env")) };

const ARGS = process.argv.slice(2);
const flag = (name) => ARGS.includes("--" + name);
const opt = (name, fallback) => {
  const i = ARGS.indexOf("--" + name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
};

// go.instellar.net, not instellar.net: the same files are served from GitHub
// Pages and from Vercel, and only the Vercel copy has /api/*. The page bounces
// itself there; the host has no reason to take the long way round.
const API = env.ROOM_API || "https://go.instellar.net/api/room";
const VIEW = env.ROOM_VIEW || "";
const PUBLISH = env.ROOM_PUBLISH || "";
const ADMIN = env.ROOM_ADMIN_TOKEN || "";
const CAM = env.CAM_NAME || "front-room";
const NAME = env.ROOM_LABEL || CAM;
const DEEPGRAM = flag("no-stt") ? "" : (env.DEEPGRAM_KEY || "");
const HLS_PORT = 8888;
const RTSP = "rtsp://127.0.0.1:8554/" + CAM;
const BEAT_MS = 2000; // Collect speech promptly, with no overlapping requests.
const CAMERA_API = env.CAMERA_AUDIO_API || "http://127.0.0.1:1984";
const CAMERA_STREAM = env.CAMERA_AUDIO_STREAM || "camera";
let speechStatus = flag("no-say") ? "off" : "starting";
let sttStatus = flag("no-stt") ? "off" : "starting";
const children = new Set();
function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
process.on("exit", () => { for (const child of children) child.kill(); });

let tunnelUrl = "";
let published = "";
let stopping = false;

/* ------------------------------------------------------------- preflight -- */

if (VIEW.length < 4) die("ROOM_VIEW must be at least 4 characters. See .env.example.");
if (PUBLISH.length < 16) die("ROOM_PUBLISH must be at least 16 characters. See .env.example.");
// The split is the entire access model, and two equal keys quietly collapse it:
// every viewer would hold the key that can repoint the camera.
if (VIEW === PUBLISH) die("ROOM_VIEW and ROOM_PUBLISH must be different keys.");

/* ----------------------------------------------------------------- main -- */

// Everything runs from here rather than straight down the module body, and that
// is not a matter of taste. A top-level `await` runs while the rest of the file
// is still being evaluated, so anything it reaches for that is declared further
// down - `sleep`, `WELL_KNOWN` - is in the temporal dead zone and throws
// "Cannot access before initialization". Function declarations hoist; consts do
// not, and the ones this reaches through are consts.
async function main() {
  log("camera   " + CAM);
  log("bridge   http://127.0.0.1:" + HLS_PORT + "/" + CAM + "/index.m3u8");

  await startCameraAudio();
  await waitForBridge();
  tunnelUrl = await startTunnel();
  log("tunnel   " + tunnelUrl);

  const playlist = tunnelUrl.replace(/\/+$/, "") + "/" + CAM + "/index.m3u8";
  await beat(playlist);
  const heartbeat = async () => {
    if (stopping) return;
    try { await beat(playlist); } catch (e) { log("heartbeat: " + e.message); }
    if (!stopping) setTimeout(heartbeat, BEAT_MS);
  };
  setTimeout(heartbeat, BEAT_MS);

  if (flag("no-stt")) log("stt      off (--no-stt)");
  else if (DEEPGRAM) startTranscriber();
  else startLocalTranscriber();

  log("");
  log("watch it at " + API.replace(/\/api\/room$/, "/room") + "#" + VIEW);
}

/* --------------------------------------------------------------- bridge -- */

// The bridge takes a while to log into Wyze and open the camera, and publishing
// a tunnel to a port that is not serving yet just means viewers get a 404 from
// the playlist and no way to tell why.
async function waitForBridge() {
  const until = Date.now() + 120000;
  let warned = false;
  for (;;) {
    try {
      const r = await fetch("http://127.0.0.1:" + HLS_PORT + "/" + CAM + "/index.m3u8",
        { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
    } catch (_) { /* not up yet */ }
    if (!warned) {
      log("waiting for the bridge to open " + CAM + "...");
      log("  (docker compose up -d, and check http://127.0.0.1:5000 if this hangs)");
      warned = true;
    }
    if (Date.now() > until) {
      die("the bridge never served " + CAM + ". Is CAM_NAME right? The bridge's web UI " +
          "at http://127.0.0.1:5000 lists the names it actually has.");
    }
    await sleep(2000);
  }
}

/* --------------------------------------------------------------- tunnel -- */

function startTunnel() {
  if (opt("tunnel", "") === "none") return Promise.resolve("http://127.0.0.1:" + HLS_PORT);
  const bin = findBin("cloudflared");
  if (!bin) {
    return Promise.reject(new Error(
      "could not find cloudflared on PATH. Install it, or open a fresh terminal if " +
      "you just did - a terminal started before the install still has the old PATH."));
  }
  // No shell, for the reason cast-host.mjs spells out: with shell:true the child
  // is cmd.exe, so killing it leaves cloudflared running and the tunnel orphaned.
  const child = spawn(bin, ["tunnel", "--url", "http://127.0.0.1:" + HLS_PORT], { windowsHide: true });
  process.on("exit", () => child.kill());

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cloudflared printed no URL in 40s")), 40000);
    const onText = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stdout.on("data", onText);
    child.stderr.on("data", onText);          // cloudflared prints its URL on stderr
    child.on("exit", (code) => reject(new Error("cloudflared exited (" + code + ")")));
  });
}

/* ------------------------------------------------------------ heartbeat -- */

async function beat(url) {
  const r = await post({ url, name: NAME, token: VIEW, publish: PUBLISH, speech: speechStatus, stt: sttStatus });
  if (!r.ok) throw new Error("publish " + r.status + " " + JSON.stringify(r.body));
  if (r.body.claimed) log("published " + url);
  published = url;
  for (const line of r.body.say || []) say(line.text);
}

async function post(body) {
  const r = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ADMIN ? { "x-admin-token": ADMIN } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

/* -------------------------------------------------------------- talking -- */

// One camera message at a time; no fallback to the PC's audio device.
const queue = [];
let speaking = false;
function say(text) {
  if (flag("no-say")) return;
  if (queue.length < 20) queue.push(text);
  drain();
}
async function drain() {
  if (speaking || !queue.length || stopping) return;
  speaking = true;
  const text = queue.shift();
  try {
    await speakOnCamera(text, {
      directory: path.join(HERE, ".runtime"), api: CAMERA_API, stream: CAMERA_STREAM,
      codec: env.CAMERA_AUDIO_CODEC || "pcml/8000", rate: Number(env.CAMERA_SPEECH_RATE || -2),
    });
    speechStatus = "ready";
    log("camera   message played");
  } catch (e) {
    speechStatus = "error";
    log("camera speech: " + e.message);
  } finally { speaking = false; drain(); }
}

async function startCameraAudio() {
  if (flag("no-say")) return;
  const bin = path.join(HERE, ".runtime", "go2rtc.exe");
  const config = path.join(HERE, ".runtime", "go2rtc.yaml");
  // An existing local service is also supported. Its API is never tunneled.
  try { await fetch(CAMERA_API + "/api", { signal: AbortSignal.timeout(1000) }); }
  catch (_) {
    if (!fs.existsSync(bin) || !fs.existsSync(config)) {
      speechStatus = "unavailable";
      return log("camera   speaker unavailable: configure go2rtc (see README)");
    }
    const child = track(spawn(bin, ["-config", config], { windowsHide: true, stdio: "ignore" }));
    child.on("error", () => { speechStatus = "error"; });
    child.on("exit", () => { speechStatus = "error"; });
    await sleep(1000);
  }
  // Keep the native producer connected so its audio codec is detected before
  // sending the first message. Video/STT continue using the established bridge.
  const ff = findBin("ffmpeg");
  if (!ff) { speechStatus = "unavailable"; return; }
  const connect = () => {
    if (stopping) return;
    const child = track(spawn(ff, ["-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp",
      "-timeout", "15000000", "-i", env.CAMERA_AUDIO_RTSP || "rtsp://127.0.0.1:8556/camera?audio",
      "-vn", "-acodec", "copy", "-f", "null", "-"], { windowsHide: true, stdio: "ignore" }));
    child.on("error", () => { speechStatus = "error"; });
    child.on("exit", () => { speechStatus = "error"; if (!stopping) setTimeout(connect, 5000); });
  };
  connect();
  const check = async () => {
    if (stopping) return;
    try {
      const response = await fetch(CAMERA_API + "/api/streams?src=" + encodeURIComponent(CAMERA_STREAM),
        { signal: AbortSignal.timeout(2000) });
      const info = await response.json();
      speechStatus = info.producers?.some(p => p.medias?.some(m => m.includes("audio, sendonly"))) ? "ready" : "connecting";
    } catch (_) { speechStatus = "error"; }
    if (!stopping) setTimeout(check, 5000);
  };
  await check();
}

function startLocalTranscriber() {
  const ff = findBin("ffmpeg");
  if (!ff) { sttStatus = "error"; return log("stt: ffmpeg missing"); }
  const run = () => {
    if (stopping) return;
    sttStatus = "starting";
    const child = track(spawn(env.ROOM_PYTHON || "python", ["-u", path.join(HERE, "transcribe.py"),
      "--ffmpeg", ff, "--rtsp", RTSP, "--model", env.WHISPER_MODEL || "base.en"], { windowsHide: true }));
    child.stdin.end();
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.status && event.status !== sttStatus) { sttStatus = event.status; log("stt      " + sttStatus); }
        if (event.text) sendLine(event.text);
      } catch (_) { /* stdout is a JSON-lines protocol */ }
    });
    child.stderr.on("data", b => log("stt: " + String(b).trim()));
    let retry = false;
    const restart = () => {
      sttStatus = "error";
      if (!retry && !stopping) { retry = true; setTimeout(run, 10000); }
    };
    child.on("error", restart);
    child.on("exit", restart);
  };
  run();
}

/* ---------------------------------------------------------------- to text -- */

// ffmpeg pulls the room's audio off the bridge's RTSP port and Deepgram turns it
// into lines. Both are restarted on their own timer, because a camera that drops
// off wifi for a minute should not end the transcript for the rest of the day.
function startTranscriber() {
  const ff = findBin("ffmpeg");
  if (!ff) return log("stt      off - ffmpeg is not on PATH (winget install Gyan.FFmpeg)");

  let ws = null;
  let ffmpeg = null;
  let restarting = false;

  const restart = (why) => {
    if (stopping || restarting) return;
    restarting = true;
    log("stt: " + why + ", retrying in 5s");
    try { ffmpeg?.kill(); } catch (_) {}
    try { ws?.close(); } catch (_) {}
    setTimeout(() => { restarting = false; run(); }, 5000);
  };

  const run = () => {
    if (stopping) return;
    // linear16 at 16k mono is what the query string below promises Deepgram, so
    // these two have to be changed together or it transcribes noise.
    ffmpeg = spawn(ff, [
      "-nostdin", "-loglevel", "error",
      "-rtsp_transport", "tcp", "-i", RTSP,
      "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-",
    ], { windowsHide: true });

    ws = new WebSocket("wss://api.deepgram.com/v1/listen?" + new URLSearchParams({
      encoding: "linear16", sample_rate: "16000", channels: "1",
      model: "nova-3", punctuate: "true", smart_format: "true",
      // Interim results would post a line per syllable and the transcript would
      // rewrite itself under the reader. Only settled text is worth sending.
      interim_results: "false",
      // Node's global WebSocket is the browser one: it takes protocols, not
      // headers, and an options object is accepted and silently dropped. So the
      // key travels as a subprotocol, which is what Deepgram offers browsers for
      // exactly this reason. An Authorization header here looks right, compiles,
      // and fails as an unexplained 401.
    }), ["token", DEEPGRAM]);

    ws.addEventListener("open", () => { sttStatus = "listening"; log("stt      listening"); });
    ws.addEventListener("message", (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const text = msg?.channel?.alternatives?.[0]?.transcript?.trim();
      if (text) sendLine(text);
    });
    ws.addEventListener("close", () => restart("deepgram closed"));
    ws.addEventListener("error", () => restart("deepgram error"));

    ffmpeg.stdout.on("data", (chunk) => {
      if (ws && ws.readyState === 1) ws.send(chunk);
    });
    ffmpeg.stderr.on("data", (b) => log("ffmpeg: " + String(b).trim()));
    ffmpeg.on("exit", (code) => restart("ffmpeg exited (" + code + ")"));
  };

  run();
}

// Batched on a short timer. Deepgram settles a line at a time and each one would
// otherwise be its own round trip to Vercel, three or four a sentence.
let pending = [];
let flushTimer = null;

function sendLine(text) {
  log("heard: " + text);
  pending.push({ text });
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    const tx = pending.splice(0, 20);
    flushTimer = null;
    try {
      const r = await post({ publish: PUBLISH, tx });
      if (!r.ok) log("transcript " + r.status + " " + JSON.stringify(r.body));
    } catch (e) { log("transcript: " + e.message); }
  }, 250);
}

/* ----------------------------------------------------------- going away -- */

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(sig, async () => {
    if (stopping) process.exit(0);
    stopping = true;
    log("\nunpublishing...");
    try {
      // The URL as well as the key, so a copy shutting down late cannot delete
      // the record a replacement has already published.
      await fetch(API + "?p=" + encodeURIComponent(PUBLISH) +
        (published ? "&u=" + encodeURIComponent(published) : ""),
        { method: "DELETE", headers: ADMIN ? { "x-admin-token": ADMIN } : {},
          signal: AbortSignal.timeout(5000) });
    } catch (_) { /* going away regardless */ }
    process.exit(0);
  });
}

/* ----------------------------------------------------------------- util -- */

// Deliberately not a dotenv dependency: this reads four lines of KEY=value and
// the file is written by hand.
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

// A full path, never a bare name, so the caller can spawn it without a shell.
// The well-known fallback matters because winget's installers edit the machine
// PATH, which a terminal already open at install time will not see.
const WELL_KNOWN = {
  cloudflared: [
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    "C:\\Program Files\\cloudflared\\cloudflared.exe",
  ],
  ffmpeg: [],
};

// winget's ffmpeg is reached through an App Execution Alias, which is not a file
// on disk and is not on the PATH of a terminal that was already open when it was
// installed. The real binary is under Packages in a version-stamped directory, so
// this looks for it rather than naming a version that the next update invalidates.
// Without this the message is "stt off, ffmpeg is not on PATH" on a machine that
// plainly has ffmpeg, which is a confusing thing to be handed.
function findWingetFfmpeg() {
  const root = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  if (!fs.existsSync(root)) return null;
  for (const pkg of fs.readdirSync(root)) {
    if (!/ffmpeg/i.test(pkg)) continue;
    const dir = path.join(root, pkg);
    for (const build of fs.readdirSync(dir)) {
      const hit = path.join(dir, build, "bin", "ffmpeg.exe");
      if (fs.existsSync(hit)) return hit;
    }
  }
  return null;
}

function findBin(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { shell: true, encoding: "utf8" });
  if (r.status === 0) {
    const hit = String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (hit) return hit;
  }
  for (const p of WELL_KNOWN[cmd] || []) if (fs.existsSync(p)) return p;
  if (cmd === "ffmpeg" && process.platform === "win32") return findWingetFfmpeg();
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(s) { console.log(s); }
function die(s) { console.error("room-host: " + s); process.exit(1); }

main().catch((e) => die(e.message));

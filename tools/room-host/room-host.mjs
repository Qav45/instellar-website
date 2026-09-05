// The host half of /room. Run it on the machine that shares a LAN with the
// camera; everything else lives on the site.
//
//   node room-host.mjs [--no-stt] [--no-say] [--tunnel none]
//
// Four jobs, none of which are the video path:
//
//   1. put a Cloudflare tunnel in front of the bridge's HLS port
//   2. heartbeat that tunnel's URL to /api/room every 30 seconds
//   3. collect whatever viewers queued in that reply and say it out loud
//   4. transcribe the room off the bridge's RTSP port and post the lines up
//
// The pixels never pass through instellar.net, for the reason written up in
// tools/cast-host/README.md: a Vercel function cannot hold a socket open, so the
// page fetches the playlist straight from the tunnel and /api/room only ever
// remembers where that tunnel currently is.
//
// HLS and not WebRTC, which is the one real compromise here. WHEP would be a
// second or two quicker, but its media is UDP to an ICE candidate and a
// Cloudflare tunnel carries HTTP - the signalling would succeed and the video
// would never arrive. The delay lands only on the picture: the transcript is cut
// from the RTSP feed on this machine and never goes near the tunnel, so what is
// said in the room still reaches the page promptly.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const BEAT_MS = 30000;          // the record's TTL is 90s, so this is 3 tries

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

  await waitForBridge();
  tunnelUrl = await startTunnel();
  log("tunnel   " + tunnelUrl);

  const playlist = tunnelUrl.replace(/\/+$/, "") + "/" + CAM + "/index.m3u8";
  await beat(playlist);
  setInterval(() => beat(playlist).catch((e) => log("heartbeat: " + e.message)), BEAT_MS);

  if (DEEPGRAM) startTranscriber();
  else log("stt      off (no DEEPGRAM_KEY) - the room's audio stays in the house");

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
  const r = await post({ url, name: NAME, token: VIEW, publish: PUBLISH });
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

// One at a time. Two SAPI voices talking over each other in a real room is not a
// transcript anyone can follow, and viewers can queue faster than speech runs.
const queue = [];
let speaking = false;

function say(text) {
  if (flag("no-say")) return log("say (muted): " + text);
  queue.push(text);
  drain();
}

function drain() {
  if (speaking || !queue.length) return;
  speaking = true;
  const text = queue.shift();
  log("saying: " + text);
  // Through a temp file and -EncodedCommand rather than interpolated into the
  // command line: this string came off the internet from anyone holding the view
  // key, and pasting it into a PowerShell command is how it would get to run as
  // one. Base64 of UTF-16LE is what -EncodedCommand takes.
  const script = "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Speech;" +
    "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
    "$s.Speak([Console]::In.ReadToEnd())";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { windowsHide: true });
  child.stdin.end(text, "utf8");

  // A watchdog, because one wedged child used to stop the room talking for good.
  // `speaking` is only cleared on exit, so a SAPI call that never returns - and
  // one did, sitting at no CPU with the queue backing up behind it - meant every
  // later message was accepted by the site, logged here as "saying", and never
  // heard. Whatever makes SAPI hang, it must not be able to take the feature with
  // it. Generous enough not to cut real speech off: SAPI runs at roughly 15
  // characters a second and the queue caps a message at 300.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    speaking = false;
    drain();
  };
  const watchdog = setTimeout(() => {
    log("say: gave up after 45s, killing it");
    try { child.kill(); } catch (_) {}
    finish();
  }, 45000);

  child.on("exit", finish);
  child.on("error", (e) => { log("say failed: " + e.message); finish(); });
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

    ws.addEventListener("open", () => log("stt      listening"));
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
  }, 1500);
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

// Always-on companion for /cast. It registers this machine with the site and
// turns the ordinary cast-host process on and off when the watch page asks.
// There are deliberately no packages to install: this runs under the same Node
// that runs cast-host.mjs and is meant to sit quietly in Task Scheduler.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = String(arg("site", process.env.SITE || "https://go.instellar.net")).replace(/\/+$/, "");
const NAME = arg("name", os.hostname());
const ADMIN_TOKEN = process.env.CAST_TOKEN || "";
const POLL_MS = Math.max(25, Number(process.env.CAST_AGENT_POLL_MS || 10000));
const FIRST_BACKOFF = Math.max(25, Number(process.env.CAST_AGENT_BACKOFF_MS || 5000));
const HEALTHY_MS = Math.max(100, Number(process.env.CAST_AGENT_HEALTHY_MS || 120000));
const DIR = process.env.CAST_AGENT_DIR || path.join(os.homedir(), ".instellar-cast");
const STATE_FILE = path.join(DIR, "agent-state");
const STOP_FILE = path.join(DIR, "cast-host.stop");
const AGENT_STOP_FILE = path.join(DIR, "agent.stop");
const CAST_LOG = path.join(DIR, "cast.log");
const AGENT_LOG = path.join(DIR, "agent.log");
const HOST_SCRIPT = process.env.CAST_HOST_SCRIPT || path.join(HERE, "cast-host.mjs");
let TOKEN = "";
let PUBLISH_KEY = "";

let desired = "stop";
let child = null;
let childStarted = 0;
let backoff = FIRST_BACKOFF;
let restartTimer = null;
let stoppingChild = false;
let closing = false;
let networkDown = false;
let polling = false;
let pollTimer = null;
let stopTimer = null;

function append(file, text) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(file, text);
  } catch (_) {}
}

function log(message) {
  const line = "[" + new Date().toISOString() + "] " + message + "\n";
  process.stdout.write(line);
  append(AGENT_LOG, line);
}

function loadSecret(name, bytes) {
  const file = path.join(DIR, name);
  try {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (saved) return saved;
  } catch (_) {}
  const fresh = crypto.randomBytes(bytes).toString("base64url");
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}

function readState() {
  try {
    return fs.readFileSync(STATE_FILE, "utf8").trim() === "start" ? "start" : "stop";
  } catch (_) {
    return "stop";
  }
}

function setState(next) {
  desired = next;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, next, { mode: 0o600 });
}

function rotateCastLog() {
  try {
    if (fs.statSync(CAST_LOG).size < 2 * 1024 * 1024) return;
    const old = CAST_LOG + ".1";
    try { fs.unlinkSync(old); } catch (_) {}
    fs.renameSync(CAST_LOG, old);
  } catch (_) {}
}

function scheduleRestart(wait = backoff) {
  if (restartTimer || closing || desired !== "start" || child) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (desired === "start" && !child) startHost();
  }, wait);
}

function startHost() {
  if (closing || desired !== "start" || child) return;
  try { fs.unlinkSync(STOP_FILE); } catch (_) {}
  rotateCastLog();
  let logStream;
  try {
    logStream = fs.createWriteStream(CAST_LOG, { flags: "a" });
    logStream.on("error", () => { logStream = null; });
  } catch (_) {}

  let proc;
  try {
    proc = spawn(process.execPath, [HOST_SCRIPT, ...argv], {
      cwd: path.dirname(HOST_SCRIPT),
      windowsHide: true,
      env: { ...process.env, CAST_STOP_FILE: STOP_FILE },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (logStream) logStream.end();
    log("could not start cast-host: " + (e.message || e));
    const wait = backoff;
    backoff = Math.min(backoff * 2, 60000);
    return scheduleRestart(wait);
  }
  child = proc;
  childStarted = Date.now();
  stoppingChild = false;
  log("starting cast-host (pid " + proc.pid + ")");

  const copy = (target, chunk) => {
    target.write(chunk);
    if (logStream) logStream.write(chunk);
  };
  proc.stdout.on("data", (c) => copy(process.stdout, c));
  proc.stderr.on("data", (c) => copy(process.stderr, c));
  proc.on("error", (e) => log("cast-host error: " + (e.message || e)));
  proc.on("exit", (code) => {
    const lived = Date.now() - childStarted;
    if (child === proc) child = null;
    if (logStream) logStream.end();
    log("cast-host exited (" + code + ")" + (stoppingChild ? " after stop" : ""));
    if (lived >= HEALTHY_MS) backoff = FIRST_BACKOFF;
    if (!stoppingChild && desired === "start" && !closing) {
      const wait = backoff;
      backoff = Math.min(backoff * 2, 60000);
      log("restarting cast-host in " + Math.round(wait / 1000) + "s");
      scheduleRestart(wait);
    }
  });
}

async function stopHost() {
  clearTimeout(restartTimer);
  restartTimer = null;
  const proc = child;
  if (!proc) return;
  stoppingChild = true;
  try { fs.writeFileSync(STOP_FILE, "stop\n"); } catch (e) {
    log("could not request a clean stop: " + (e.message || e));
  }
  const exited = await Promise.race([
    new Promise((resolve) => proc.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
  ]);
  if (!exited && child === proc) {
    log("cast-host did not stop in 10s; terminating it");
    proc.kill();
  }
}

async function clearWant() {
  const headers = ADMIN_TOKEN ? { "x-admin-token": ADMIN_TOKEN } : {};
  const res = await fetch(SITE + "/api/cast?p=" + encodeURIComponent(PUBLISH_KEY) + "&want=1", {
    method: "DELETE", headers, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("clear want failed " + res.status);
}

async function poll() {
  if (polling || closing) return;
  polling = true;
  try {
    const headers = { "content-type": "application/json" };
    if (ADMIN_TOKEN) headers["x-admin-token"] = ADMIN_TOKEN;
    const res = await fetch(SITE + "/api/cast", {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: true, token: TOKEN, publish: PUBLISH_KEY, name: NAME }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 409) {
      log("another agent holds the slot; will keep trying");
      networkDown = false;
      return;
    }
    if (!res.ok) throw new Error("site answered " + res.status);
    const body = await res.json();
    if (body.want === "start" || body.want === "stop") {
      setState(body.want);
      log("site requested " + body.want);
      if (body.want === "start") startHost();
      else await stopHost();
      await clearWant();
    }
    networkDown = false;
  } catch (e) {
    if (!networkDown) log("site unavailable: " + (e.message || e));
    networkDown = true;
  } finally {
    polling = false;
  }
}

async function closeAgent() {
  if (closing) return;
  closing = true;
  clearInterval(pollTimer);
  clearInterval(stopTimer);
  clearTimeout(restartTimer);
  await stopHost();
  process.exit(0);
}

process.on("unhandledRejection", (e) => log("internal promise error: " + String(e?.stack || e)));
process.on("uncaughtException", (e) => log("internal agent error: " + String(e?.stack || e)));
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => { closeAgent(); });
}

function boot() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    try { fs.unlinkSync(AGENT_STOP_FILE); } catch (_) {}
    const savedToken = loadSecret("token", 16);
    const savedPublish = loadSecret("publish-key", 24);
    TOKEN = process.env.CAST_VIEW_TOKEN || savedToken;
    PUBLISH_KEY = process.env.CAST_PUBLISH_KEY || savedPublish;
    desired = readState();
    log("agent listening for " + NAME + " at " + SITE);
    if (desired === "start") startHost();
    poll();
    pollTimer = setInterval(poll, POLL_MS);
    stopTimer = setInterval(() => {
      if (!fs.existsSync(AGENT_STOP_FILE)) return;
      clearInterval(stopTimer);
      closeAgent();
    }, 250);
  } catch (e) {
    log("agent setup failed: " + String(e?.message || e) + "; retrying");
    setTimeout(boot, POLL_MS);
  }
}

boot();

// Exercises the always-on agent against a fake site and a tiny cast-host stand-in.
// Nothing here reaches the live registry or needs TightVNC, a tunnel, or packages.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "instellar-cast-agent-"));
const EVENTS = path.join(DIR, "events.txt");
const STAND_IN = path.join(DIR, "stand-in.mjs");
fs.writeFileSync(STAND_IN, `
import fs from "node:fs";
const events = process.env.CAST_TEST_EVENTS;
const stop = process.env.CAST_STOP_FILE;
fs.appendFileSync(events, "start " + process.pid + "\\n");
const timer = setInterval(() => {
  if (!fs.existsSync(stop)) return;
  clearInterval(timer);
  fs.appendFileSync(events, "stop " + process.pid + "\\n");
  process.exit(0);
}, 20);
`, "utf8");

let failed = 0;
function ok(name, condition, detail = "") {
  if (!condition) failed++;
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  return null;
}
function events() {
  try { return fs.readFileSync(EVENTS, "utf8").trim().split(/\r?\n/).filter(Boolean); }
  catch (_) { return []; }
}

let want = null;
let posts = 0;
let clears = 0;
let conflict = false;
let lastBody = null;
const site = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "POST") {
      posts++;
      try { lastBody = JSON.parse(raw); } catch (_) {}
      if (conflict) {
        conflict = false;
        res.writeHead(409, { "content-type": "application/json" });
        return res.end('{"error":"Another agent holds the slot"}');
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, want, casting: false }));
    }
    if (req.method === "DELETE" && new URL(req.url, "http://x").searchParams.get("want") === "1") {
      clears++;
      want = null;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }
    res.writeHead(404).end();
  });
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const port = site.address().port;

const agent = spawn(process.execPath, [
  path.join(HERE, "..", "cast-agent.mjs"),
  "--site", "http://127.0.0.1:" + port, "--lan",
], {
  windowsHide: true,
  env: {
    ...process.env,
    CAST_AGENT_DIR: DIR,
    CAST_AGENT_POLL_MS: "60",
    CAST_AGENT_BACKOFF_MS: "80",
    CAST_AGENT_HEALTHY_MS: "500",
    CAST_HOST_SCRIPT: STAND_IN,
    CAST_TEST_EVENTS: EVENTS,
  },
});
let agentOut = "";
agent.stdout.on("data", (c) => (agentOut += c));
agent.stderr.on("data", (c) => (agentOut += c));

await until(() => posts > 0);
ok("agent registers with the fake site", posts > 0 && lastBody?.agent === true);
ok("registration carries both persistent keys", lastBody?.token?.length >= 16 && lastBody?.publish?.length >= 24);

want = "start";
const first = await until(() => events().find((e) => e.startsWith("start ")));
ok("want=start spawns cast-host", Boolean(first), agentOut.slice(-160));
await until(() => clears >= 1);
ok("agent clears start after acting on it", clears >= 1 && want === null);
ok("agent persists the wanted state", fs.readFileSync(path.join(DIR, "agent-state"), "utf8") === "start");

const firstPid = Number(first?.split(" ")[1]);
try { process.kill(firstPid); } catch (_) {}
const second = await until(() => events().filter((e) => e.startsWith("start ")).length >= 2 &&
  events().filter((e) => e.startsWith("start "))[1], 5000);
ok("a dead cast-host is restarted", Boolean(second) && second !== first, events().join(", "));

want = "stop";
const stopped = await until(() => events().some((e) => e.startsWith("stop ")), 4000);
ok("want=stop uses the cooperative stop file", Boolean(stopped), events().join(", "));
await until(() => clears >= 2);
ok("agent clears stop and persists it", clears >= 2 &&
  fs.readFileSync(path.join(DIR, "agent-state"), "utf8") === "stop");

const beforeConflict = posts;
conflict = true;
await until(() => posts >= beforeConflict + 2);
ok("agent survives a 409 and registers again", agent.exitCode === null && posts >= beforeConflict + 2);

await new Promise((resolve) => site.close(resolve));
await delay(180);
const beforeRecovery = posts;
await new Promise((resolve) => site.listen(port, "127.0.0.1", resolve));
await until(() => posts > beforeRecovery);
ok("agent survives a site outage", agent.exitCode === null && posts > beforeRecovery && /site unavailable/.test(agentOut));

agent.kill();
await Promise.race([new Promise((resolve) => agent.once("exit", resolve)), delay(2000)]);
site.close();

// The real bridge gets the same cleanup path from CAST_STOP_FILE as Ctrl+C.
const vnc = net.createServer((sock) => { sock.write("RFB 003.008\n"); sock.on("error", () => {}); });
await new Promise((resolve) => vnc.listen(0, "127.0.0.1", resolve));
const bridgePort = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const picked = probe.address().port;
    probe.close(() => resolve(picked));
  });
});
const bridgeStop = path.join(DIR, "bridge.stop");
const host = spawn(process.execPath, [
  path.join(HERE, "..", "cast-host.mjs"), "--tunnel", "none",
  "--port", String(bridgePort), "--vnc", "127.0.0.1:" + vnc.address().port,
  "--share", "nope",
], { windowsHide: true, env: { ...process.env, CAST_STOP_FILE: bridgeStop } });
let hostOut = "";
host.stdout.on("data", (c) => (hostOut += c));
host.stderr.on("data", (c) => (hostOut += c));
await until(() => /Leave this window open/.test(hostOut), 5000);
fs.writeFileSync(bridgeStop, "stop\n");
const hostCode = await Promise.race([
  new Promise((resolve) => host.once("exit", resolve)),
  delay(5000).then(() => null),
]);
ok("CAST_STOP_FILE takes cast-host through normal shutdown",
  hostCode === 0 && /shutting down/.test(hostOut), "exit=" + hostCode);
if (host.exitCode === null) host.kill();
vnc.close();

try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

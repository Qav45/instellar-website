// Host side of /cast. Run this on the machine you want to control.
//
//   node cast-host.mjs [--tunnel ngrok|cloudflared|none] [--port 6080]
//                      [--vnc 127.0.0.1:5900] [--site https://go.instellar.net]
//                      [--ngrok-domain your.ngrok-free.app] [--url wss://...]
//                      [--share primary|full|<n>] [--lan]
//
// Three jobs:
//   1. bridge  - browsers speak WebSocket, VNC speaks raw TCP. Nothing in between
//                translates, so this does: one framed WS stream <-> one socket to
//                TightVNC. Written against the RFC rather than pulling in the "ws"
//                package, because this file has to run with nothing installed.
//   2. tunnel  - spawn ngrok/cloudflared and scrape the public URL it prints.
//   3. publish - POST that URL to /api/cast every 30s so the page can find us.
//
// The bridge binds loopback only, so the tunnel is the sole way in. On top of that
// the WS URL carries a per-run ?k= secret, so knowing the tunnel hostname alone is
// not enough - and the TightVNC password is still the last gate.
//
// That second gate only holds because the viewer page, which carries the session
// key inlined, is served only under --lan. The tunnel reverse-proxies every path,
// so serving it unconditionally handed the key to anyone who learned the hostname.
//
// Publishing uses a different key from watching. The view key travels in the watch
// link; the publish key never leaves this machine. See README, "The two keys".

import net from "node:net";
import dgram from "node:dgram";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

/* ---------------------------------------------------------------- config -- */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg("port", 6080));
const SITE = String(arg("site", "https://go.instellar.net")).replace(/\/+$/, "");
const NAME = arg("name", os.hostname());
const TUNNEL = arg("tunnel", "auto");
const NGROK_DOMAIN = arg("ngrok-domain", process.env.NGROK_DOMAIN || "");
const FIXED_URL = arg("url", "");                  // skip the tunnel, publish this
const SHARE = arg("share", "primary");             // primary | full | <display number>
const LAN = argv.includes("--lan");                // also listen on the local network
const ADMIN_TOKEN = process.env.CAST_TOKEN || "";  // only if the site sets CAST_TOKEN

const [VNC_HOST, VNC_PORT] = String(arg("vnc", "127.0.0.1:5900")).split(":");
const SESSION_KEY = crypto.randomBytes(9).toString("base64url");
// Two independent secrets. TOKEN goes in the watch link and is meant to be
// shared; PUBLISH_KEY never leaves this machine. They used to be one key, which
// meant anyone invited to watch could also repoint the registry at a machine of
// their own and collect the VNC password from every other viewer.
const TOKEN = arg("token", process.env.CAST_VIEW_TOKEN || loadSecret("token", 16));
const PUBLISH_KEY = process.env.CAST_PUBLISH_KEY || loadSecret("publish-key", 24);
// No tunnel means no reachable address, so there is nothing worth publishing -
// and publishing a loopback URL shipped this run's session key to the registry
// for an endpoint no viewer could ever open.
const TUNNELLESS = TUNNEL === "none" && !FIXED_URL;

/* -------------------------------------------------------------- ws bridge -- */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_PENDING = 4 * 1024 * 1024;   // client bytes held while VNC is connecting
let live = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Lets the viewer switch which monitor is shared without touching this machine.
  // The page lives on another origin, so it needs CORS; the session key is what
  // actually guards it.
  if (url.pathname === "/ctl") {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("cache-control", "no-store");
    if (url.searchParams.get("k") !== SESSION_KEY) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad key" }));
    }
    const mode = url.searchParams.get("share") || "";
    return applyShareAsync(mode).then((applied) => {
      res.writeHead(applied ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(applied ? { ok: true, share: mode }
                                     : { error: "bad share mode" }));
    });
  }

  // On the LAN the page is served from here rather than from instellar.net. That
  // is not a convenience: a browser refuses ws:// from an https:// page, so going
  // through the site would force the traffic out to Cloudflare and back - 50ms of
  // round trip to reach a machine in the same room. Same origin, same page, ~1ms.
  //
  // Only under --lan, though. This page carries the session key inlined, and the
  // tunnel reverse-proxies every path - so serving it unconditionally handed that
  // key to anyone who learned the tunnel hostname, and the key is the only thing
  // between them and a socket onto TightVNC. Without --lan there is nobody this
  // route is for: viewers through the tunnel load the page from the site.
  if (LAN && (url.pathname === "/" || url.pathname === "/index.html")) {
    const page = viewerPage();
    if (page) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(page);
    }
  }

  // The page imports the bundle by relative path, so LAN mode has to serve it too
  // or the viewer loads and then cannot start. Only these two names are ever read
  // from disk - the path never comes from the request.
  if (LAN && url.pathname === "/novnc.js") {
    const js = viewerAsset("novnc.js");
    if (js) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=604800",
      });
      return res.end(js);
    }
  }

  // Anything else still gets a body, so tunnel health checks and a stray browser
  // visit see something other than a hang.
  res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
  res.end("cast bridge up\n");
});

// The viewer normally learns the endpoint from /api/cast, which needs the access
// key. Served from here there is nothing to look up, so the session key is handed
// straight to the page and it connects to whatever host it was loaded from.
function viewerPage() {
  const html = viewerAsset("index.html");
  if (!html) return null;
  return html.replace("<head>",
    '<head>\n<script>window.CAST_DIRECT=' + JSON.stringify(SESSION_KEY) + ";</scr" + "ipt>");
}

function viewerAsset(name) {
  try {
    return fs.readFileSync(new URL("../../cast/" + name, import.meta.url), "utf8");
  } catch (_) {
    return null;                     // script copied out of the repo on its own
  }
}

server.on("error", (e) => {
  // Without this a busy port is an uncaught exception with a stack trace, which
  // is not how anything else in this script fails.
  console.error("\n  Bridge could not listen on port " + PORT + ": " + e.message);
  if (e.code === "EADDRINUSE") {
    console.error("  Something is already using it - most likely another cast still running.");
    console.error("  Close it, or pass --port with a free one.");
  }
  console.error("");
  restoreShare();
  process.exit(1);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  // Not a WebSocket at all: answer like the plain-HTTP handler does, so a health
  // check sees a body rather than a bodiless 403.
  if (String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n" +
               "Content-Type: text/plain\r\n\r\ncast bridge up\n");
    return;
  }
  if (url.searchParams.get("k") !== SESSION_KEY || !handshake(req, socket)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n" +
               "Content-Type: text/plain\r\n\r\nbad or missing key\n");
    return;
  }
  if (url.pathname === "/ping") pingProbe(socket, head);
  else bridge(socket, head);
});

// Completes the RFC 6455 handshake. Returns false if this was not a WebSocket
// request at all, in which case the caller answers with plain HTTP.
function handshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) return false;

  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  const offered = String(req.headers["sec-websocket-protocol"] || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + accept,
  ];
  // noVNC asks for the "binary" subprotocol; it expects to see it echoed back.
  if (offered.includes("binary")) lines.push("Sec-WebSocket-Protocol: binary");
  socket.write(lines.join("\r\n") + "\r\n\r\n");
  socket.setNoDelay(true);
  return true;
}

// Reads masked client frames off `sock` and hands each data payload to onData.
// Returns the feed function to push raw socket bytes through. Control frames are
// answered here so neither caller has to care about them.
function wsReader(sock, onData, onClose) {
  let buf = Buffer.alloc(0);
  let dead = false;

  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (dead) return;
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) { dead = true; return onClose("frame too large"); }
        len = Number(big);
        off = 10;
      }

      const maskAt = off;
      if (masked) {
        if (buf.length < off + 4) return;
        off += 4;
      }
      if (buf.length < off + len) return;

      let payload = buf.subarray(off, off + len);
      if (masked) {
        const m = buf.subarray(maskAt, maskAt + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      buf = buf.subarray(off + len);

      if (op === 0x8) {                                          // close
        frame(sock, 0x8, Buffer.alloc(0));
        dead = true;
        return onClose("closed by viewer");
      }
      if (op === 0x9) { frame(sock, 0x0a, payload); continue; }   // ping -> pong
      if (op === 0x0a) continue;                                  // pong
      // Continuation / text / binary are all just payload as far as we care.
      onData(payload);
    }
  };
}

// Echoes whatever it is sent, so the page can time a real round trip over the
// same tunnel the pixels use. Measuring with an HTTP request instead would fold
// in request setup that the long-lived VNC socket never pays.
function pingProbe(ws, head) {
  const feed = wsReader(ws, (p) => frame(ws, 0x02, p), () => ws.destroy());
  ws.on("error", () => ws.destroy());
  ws.on("data", feed);
  if (head && head.length) feed(head);
}

function bridge(ws, head) {
  const vnc = net.connect(Number(VNC_PORT), VNC_HOST);
  vnc.setNoDelay(true);                       // every keystroke is its own packet
  let open = false;
  let done = false;
  let pending = [];
  let pendingBytes = 0;

  live++;
  log("viewer connected (" + live + " live)");

  const shut = (why) => {
    if (done) return;
    done = true;
    live--;
    log("viewer gone" + (why ? " - " + why : "") + " (" + live + " live)");
    // end(), not destroy(): the close frame the reader just queued is still in
    // the write buffer, and destroy() threw it away - so a viewer closing its tab
    // got a TCP reset and logged an abnormal 1006 close instead of a clean one.
    if (!ws.destroyed) ws.end();
    vnc.destroy();
  };

  // Browser -> VNC. Anything the client sends before the VNC socket is up waits
  // in `pending` rather than being dropped.
  const feed = wsReader(ws, (payload) => {
    if (!open) {
      // Capped. If TightVNC is restarting the SYN goes unanswered rather than
      // refused, and an unbounded queue let anyone holding the session key grow
      // this process's memory 8MB at a time while waiting.
      pendingBytes += payload.length;
      if (pendingBytes > MAX_PENDING) return shut("vnc did not answer in time");
      pending.push(payload);
      return;
    }
    if (!vnc.write(payload)) ws.pause();
  }, shut);

  vnc.on("connect", () => {
    open = true;
    // Honour backpressure on the replay too; ignoring it left vnc write-buffered
    // with the browser still streaming into it.
    for (const p of pending) { if (!vnc.write(p)) ws.pause(); }
    pending = [];
    pendingBytes = 0;
  });
  vnc.on("error", (e) => shut("vnc: " + e.message));
  vnc.on("close", () => shut());
  ws.on("error", () => shut("socket error"));
  ws.on("close", () => shut());

  ws.on("data", feed);
  if (head && head.length) feed(head);

  vnc.on("drain", () => ws.resume());

  // VNC -> browser, one frame per read so updates leave as soon as they exist.
  vnc.on("data", (d) => { if (!frame(ws, 0x02, d)) vnc.pause(); });
  ws.on("drain", () => vnc.resume());
}

// Server-to-client frames are never masked. Header and payload go out in a single
// write: two writes would be two packets, and this runs with Nagle disabled.
function frame(sock, op, payload) {
  const n = payload.length;
  let head;
  if (n < 126) {
    head = Buffer.allocUnsafe(2);
    head[1] = n;
  } else if (n < 65536) {
    head = Buffer.allocUnsafe(4);
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.allocUnsafe(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  head[0] = 0x80 | op;
  return sock.write(Buffer.concat([head, payload], head.length + n));
}

/* ----------------------------------------------------------------- share -- */

// Every pixel of shared desktop is bandwidth to move, memory to hold, and work
// for the viewer to decode. Two 1080p monitors is a 3840x1080 framebuffer, twice
// what anyone needs to read code on. TightVNC can share a single display instead,
// which cuts all three costs in half, so that is the default.
const TVN = [
  "C:\\Program Files\\TightVNC\\tvnserver.exe",
  "C:\\Program Files (x86)\\TightVNC\\tvnserver.exe",
];

let shareChanged = false;

// Resolves a share mode to the tvnserver argv, or null if it is not one we allow.
// Keeping the whitelist here is what makes the /ctl query parameter safe to pass
// through: nothing from the request ever reaches the command line unmatched.
function shareCommand(mode) {
  const bin = TVN.find((p) => fs.existsSync(p));
  if (!bin) return null;
  if (mode === "primary") return [bin, ["-controlservice", "-shareprimary"]];
  if (mode === "full") return [bin, ["-controlservice", "-sharefull"]];
  if (/^[1-9][0-9]?$/.test(mode)) return [bin, ["-controlservice", "-sharedisplay", mode]];
  return null;
}

// Async twin of applyShare, for /ctl. spawnSync there stalled the event loop for
// as long as Windows took to start a process and reach the service - typically a
// few hundred ms - during which no pixels moved and no input went the other way.
// In a bridge that argues about 50ms of round trip, freezing the picture on a
// button press is not a detail.
function applyShareAsync(mode) {
  const cmd = shareCommand(mode);
  if (!cmd) return Promise.resolve(false);
  return new Promise((done) => {
    const proc = spawn(cmd[0], cmd[1], { stdio: "ignore", windowsHide: true });
    proc.on("error", () => done(false));
    proc.on("exit", (code) => {
      if (code !== 0) return done(false);
      noteShare(mode);
      done(true);
    });
  });
}

function noteShare(mode) {
  shareChanged = mode !== "full";
  log("sharing " + (mode === "full" ? "the whole desktop"
                  : mode === "primary" ? "the primary display only"
                  : "display " + mode));
}

function applyShare(mode) {
  const cmd = shareCommand(mode);
  if (!cmd) return false;
  if (spawnSync(cmd[0], cmd[1], { stdio: "ignore" }).status !== 0) return false;
  noteShare(mode);
  return true;
}

// Every exit path has to run this, not just Ctrl+C. Leaving the server cropped to
// one display is a surprise for whoever connects next, and startup can fail after
// the crop in half a dozen ways - no cloudflared, a busy port, a scrape timeout,
// a refused publish.
function restoreShare() {
  if (!shareChanged) return;
  shareChanged = false;
  applyShare("full");
}

/* ---------------------------------------------------------------- tunnel -- */

let tunnelProc = null;

function startTunnel() {
  if (FIXED_URL) return Promise.resolve(FIXED_URL.replace(/^https?:/, "wss:"));
  if (TUNNEL === "none") return Promise.resolve("ws://127.0.0.1:" + PORT);

  // cloudflared first: its quick tunnels need no account, have no bandwidth cap
  // and put no browser-warning interstitial in front of the WebSocket upgrade.
  const kind = TUNNEL === "auto" ? (findBin("cloudflared") ? "cloudflared" : "ngrok") : TUNNEL;
  const bin = findBin(kind);
  if (!bin) {
    return Promise.reject(new Error(
      "could not find " + kind + " on PATH. Install it, or open a fresh terminal " +
      "if you just did - a terminal started before the install still has the old PATH."));
  }

  const args = kind === "ngrok"
    ? ["http", String(PORT), "--log", "stdout", "--log-format", "json"]
      .concat(NGROK_DOMAIN ? ["--domain", NGROK_DOMAIN] : [])
    : ["tunnel", "--url", "http://127.0.0.1:" + PORT];

  log("starting " + kind + "...");
  // findBin always hands back a full path now, so this never needs a shell - and
  // must not have one. With shell:true on Windows the child was cmd.exe, so kill()
  // killed the wrapper and left cloudflared running: an orphaned tunnel still
  // holding its hostname open, its exit handler never firing, and - once a later
  // run reused the port - that stale public URL proxying into the new bridge.
  tunnelProc = spawn(bin, args, { windowsHide: true });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(kind + " printed no URL in 45s")), 45000);
    let settled = false;

    // A pipe delivers whatever bytes are ready, not whole lines, so the URL can
    // arrive split across two chunks. Matching each chunk on its own then found
    // nothing and the 45s timer fired while the tunnel was up and working.
    let seen = "";

    const scan = (chunk) => {
      seen += String(chunk);
      if (seen.length > 65536) seen = seen.slice(-4096);   // a tail, not a transcript
      const text = seen;
      // ngrok --log-format json prints "url":"https://..."; cloudflared prints it bare.
      let m = text.match(/https:\/\/[a-z0-9-]+\.(?:trycloudflare\.com|ngrok[-a-z.]*\.app|ngrok\.io)/i);
      if (!m && NGROK_DOMAIN) {
        m = text.match(new RegExp("https://" + NGROK_DOMAIN.replace(/\./g, "\\."), "i"));
      }
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(m[0].replace(/^https:/, "wss:"));
      } else if (!settled && /err_|error/i.test(String(chunk))) {
        process.stderr.write(String(chunk));
      }
    };

    tunnelProc.stdout && tunnelProc.stdout.on("data", scan);
    tunnelProc.stderr && tunnelProc.stderr.on("data", scan);
    tunnelProc.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error("could not run " + kind + ": " + e.message));
    });
    tunnelProc.on("exit", (code) => {
      if (!settled) {
        clearTimeout(timer);
        reject(new Error(kind + " exited (" + code + ")"));
      } else {
        // The published URL now points nowhere. Stop advertising it and get out,
        // so the viewer says "nobody is casting" instead of retrying a dead host.
        log(kind + " exited (" + code + ") - the link is dead, shutting down");
        clearInterval(publishTimer);
        unpublish().then(() => {
          restoreShare();
          process.exit(1);
        });
      }
    });
  });
}

// Returns a full path to the executable, or null. Always a path, never a bare
// name, so the caller can spawn it directly instead of asking a shell to find it.
// The WELL_KNOWN fallback matters because winget's cloudflared MSI edits the
// machine PATH, which any terminal already open at install time will not see.
const WELL_KNOWN = {
  cloudflared: [
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    "C:\\Program Files\\cloudflared\\cloudflared.exe",
  ],
};

function findBin(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { shell: true, encoding: "utf8" });
  if (r.status === 0) {
    // `where` can list several matches; the first is the one PATH would pick.
    const hit = String(r.stdout || "").split(/\r?\n/)
      .map((l) => l.trim()).filter(Boolean)[0];
    if (hit) return hit;
  }
  for (const p of WELL_KNOWN[cmd] || []) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* --------------------------------------------------------------- publish -- */

let publishTimer = null;

async function publish(wsUrl) {
  const headers = { "content-type": "application/json" };
  if (ADMIN_TOKEN) headers["x-admin-token"] = ADMIN_TOKEN;

  const r = await fetch(SITE + "/api/cast", {
    method: "POST",
    headers,
    // token is what viewers present to read; publish is what proves this process
    // owns the slot. Only the first is ever printed.
    body: JSON.stringify({ url: wsUrl, name: NAME, token: TOKEN, publish: PUBLISH_KEY }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    throw new Error("publish failed " + r.status + ": " + (await r.text()).slice(0, 200));
  }
}

async function unpublish() {
  try {
    const headers = ADMIN_TOKEN ? { "x-admin-token": ADMIN_TOKEN } : {};
    await fetch(SITE + "/api/cast?p=" + encodeURIComponent(PUBLISH_KEY), {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(5000),
    });
  } catch (_) {}
}

/* ------------------------------------------------------------------ boot -- */

// One set of secrets per machine, kept on disk so the watch link stays the same
// between runs even though the tunnel URL behind it does not.
function loadSecret(name, bytes) {
  const dir = path.join(os.homedir(), ".instellar-cast");
  const file = path.join(dir, name);
  try {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (saved) return saved;
  } catch (_) {}
  const fresh = crypto.randomBytes(bytes).toString("base64url");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}

// Picking the first non-internal address gets it wrong on any real machine: VPN,
// WSL and VirtualBox adapters all look like candidates. Connecting a UDP socket
// asks the routing table which address actually reaches the outside world, which
// is the one a laptop on the same network can also reach. No packet is sent.
function lanAddress() {
  return new Promise((done) => {
    const s = dgram.createSocket("udp4");
    const bail = () => { try { s.close(); } catch (_) {} done(null); };
    s.on("error", bail);
    try {
      s.connect(53, "1.1.1.1", () => {
        let addr = null;
        try { addr = s.address().address; } catch (_) {}
        try { s.close(); } catch (_) {}
        done(addr && addr !== "0.0.0.0" ? addr : null);
      });
    } catch (_) { bail(); }
    setTimeout(bail, 1000);
  });
}

function log(msg) {
  console.log("[" + new Date().toTimeString().slice(0, 8) + "] " + msg);
}

function checkVnc() {
  return new Promise((resolve) => {
    const s = net.connect(Number(VNC_PORT), VNC_HOST);
    s.setTimeout(3000);
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

async function main() {
  if (!(await checkVnc())) {
    console.error("\n  No VNC server answering on " + VNC_HOST + ":" + VNC_PORT + ".");
    console.error("  Start TightVNC Server (it installs as the tvnserver service) and");
    console.error("  make sure it has a password set, then run this again.\n");
    process.exit(1);
  }

  if (!applyShare(SHARE)) {
    log("could not set share mode \"" + SHARE + "\" - carrying on with whatever\n           TightVNC is already sharing");
  }

  await new Promise((r) => server.listen(PORT, LAN ? "0.0.0.0" : "127.0.0.1", r));
  log("bridge on " + (LAN ? "0.0.0.0" : "127.0.0.1") + ":" + PORT +
      " -> " + VNC_HOST + ":" + VNC_PORT);

  const base = await startTunnel();
  const wsUrl = base + "/ws?k=" + SESSION_KEY;

  // With no tunnel there is no address a viewer could reach, so the registry has
  // nothing to remember. Publishing anyway meant --tunnel none died on the site's
  // wss:// check - taking the LAN cast, which needs the site for nothing at all,
  // down with it - and on an offline network it died on the fetch instead.
  if (!TUNNELLESS) {
    await publish(wsUrl);
    let missed = 0;
    publishTimer = setInterval(() => {
      publish(wsUrl).then(() => { missed = 0; }).catch((e) => {
        missed++;
        log("heartbeat: " + e.message);
        // Three in a row is longer than the record's own TTL: viewers are seeing
        // "nobody is casting" by now, and one quiet line among the connection
        // noise was not enough to say so.
        if (missed === 3) {
          log("  ^ three failed in a row - the site has dropped this cast and");
          log("    viewers cannot find it. The cast itself is still running.");
        }
      });
    }, 30000);
  }

  console.log("\n  Casting \"" + NAME + "\".\n");
  if (!TUNNELLESS) {
    console.log("    Watch it at   " + SITE + "/cast#" + TOKEN);
    console.log("    Tunnel        " + base);
  } else {
    console.log("    No tunnel (--tunnel none), so this cast is local only.");
  }
  console.log("");
  if (LAN) {
    const ip = await lanAddress();
    if (ip) console.log("    On this network  http://" + ip + ":" + PORT + "/   (much faster)");
  } else {
    console.log("    Watching from this same network? --lan skips the tunnel entirely,");
    console.log("    which is worth about 50ms of round trip.");
  }
  console.log("");
  if (!TUNNELLESS) {
    console.log("  That link carries the view key, so treat it like a password -");
    console.log("  anyone holding it reaches this machine's TightVNC password prompt.");
    console.log("  It does not let them move the cast: that needs the publish key,");
    console.log("  which stays in ~/.instellar-cast and is never printed.\n");
  }
  console.log("  Leave this window open. Ctrl+C stops the cast.\n");
}

let quitting = false;
// SIGTERM is never raised on Windows and closing the console window does not
// arrive as SIGINT either; SIGBREAK and SIGHUP are what Node does deliver there.
// Without them the only clean exit was Ctrl+C, and every other way of stopping
// left the display cropped and the record advertised for its full TTL.
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, async () => {
    if (quitting) {
      // Second Ctrl+C, usually because unpublish() is sitting on its timeout and
      // the window looks hung. Give up on the network, but still put the display
      // back - that is local, instant, and the thing worth saving.
      restoreShare();
      if (tunnelProc) tunnelProc.kill();
      process.exit(0);
    }
    quitting = true;
    log("shutting down...");
    clearInterval(publishTimer);
    // Restore first: it is a local call that always succeeds, where unpublish is
    // a network round trip that can hang for its full 5s.
    restoreShare();
    if (!TUNNELLESS) await unpublish();
    if (tunnelProc) tunnelProc.kill();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("\n  " + (e.message || e) + "\n");
  // Startup can fail in half a dozen ways after the display was already cropped -
  // no cloudflared, a scrape timeout, a refused publish. None of them should
  // leave TightVNC showing one monitor to whoever connects next.
  restoreShare();
  if (tunnelProc) tunnelProc.kill();
  process.exit(1);
});

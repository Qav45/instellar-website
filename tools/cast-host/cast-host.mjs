// Host side of /cast. Run this on the machine you want to control.
//
//   node cast-host.mjs [--tunnel ngrok|cloudflared|none] [--port 6080]
//                      [--vnc 127.0.0.1:5900] [--site https://go.instellar.net]
//                      [--ngrok-domain your.ngrok-free.app] [--url wss://...]
//                      [--share primary|full|<n>] [--lan]
//                      [--video on|off] [--ffmpeg <path>] [--codec av1|hevc|h264]
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
// key inlined, is never served to the tunnel. --lan used to be the whole of that
// promise, and a flag cannot keep it: a flag records what was intended, not where
// a request came from, and the tunnel reverse-proxies every path into this same
// process. So --lan alongside the default --tunnel auto served the key to anyone
// who learned the tunnel hostname. What keeps it now is which socket accepted the
// request - under --lan the page lives on a second listener bound to the LAN
// address alone, and the tunnel is only ever pointed at loopback.
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
import { createVideoSource, validateVideoSettings, CODECS } from "./video.mjs";
import { selectServer, shareArgv, pushesUpdates, defaultPort } from "./vnc-server.mjs";

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
// The one address --lan listens on, resolved in main() before anything binds.
// Empty means no route out was found, and then --lan serves no page at all.
let LAN_IP = "";
const ADMIN_TOKEN = process.env.CAST_TOKEN || "";  // only if the site sets CAST_TOKEN
const STOP_FILE = process.env.CAST_STOP_FILE || ""; // cooperative stop for cast-agent
// Stream mode: ffmpeg encodes the screen on the GPU and /video fans the H.264
// out. Opt-in on the page, but the route is on by default so a host needs no
// flag to offer it. --ffmpeg names the binary; the env form is the test hook.
const VIDEO = arg("video", "on") !== "off";
const FFMPEG = arg("ffmpeg", "") || process.env.CAST_FFMPEG_BIN || "";
// --codec pins the host's choice whatever the page asks for - for a browser
// that claims a decoder in hardware and then stutters on it. Only that codec's
// encoders are tried.
const CODEC = arg("codec", "");
if (CODEC && !CODECS.includes(CODEC)) {
  console.error("\n  --codec must be one of " + CODECS.join(", ") + "\n");
  process.exit(2);
}

// Which VNC+ server this bridge is driving, and what it can do. The table, the
// binary paths and the share argv all live in vnc-server.mjs; nothing here knows
// a path or a command line any more. With no --vnc-server the order of that
// table decides, and TightVNC is first in it - so on this machine, which has
// TightVNC installed and is streaming through it right now, this resolves to
// exactly what was hardcoded here before.
//
// Naming a server that is not installed is an error rather than a silent fall
// back to a different one: a host that quietly kept using the incumbent after
// being told to use something else would make an A/B measurement meaningless.
const VNC_PREFER = arg("vnc-server", process.env.CAST_VNC_SERVER || "");
const VNC_SERVER = selectServer({ prefer: VNC_PREFER });
if (VNC_PREFER && !VNC_SERVER) {
  console.error("\n  No " + VNC_PREFER + " on this machine, and --vnc-server is not a" +
    "\n  suggestion: carrying on with a different server would make any" +
    "\n  measurement taken against it meaningless.\n");
  process.exit(2);
}
// True when the server pushes framebuffer updates on its own (ContinuousUpdates,
// pseudo-encoding -313). Only TigerVNC has it on Windows; see vnc-plus.md. An
// unknown server reads as false, which keeps the injector - see arm() in
// bridge() for why that is the safe direction.
const VNC_PUSHES = pushesUpdates(VNC_SERVER);
// The port still comes from --vnc when it is given. Without it the selected
// server names its own: 5900 for the incumbent, and 5901 for the two that are
// only ever worth running beside it. defaultPort(null) is 5900, so a machine
// with no known server installed probes exactly where it always did.
const [VNC_HOST, VNC_PORT] = String(arg("vnc", "127.0.0.1:" + defaultPort(VNC_SERVER))).split(":");
// The env form is the test hook, like CAST_TUNNEL_BIN and CAST_FFMPEG_BIN. The
// only place this key is ever published is the viewer page, and that is served
// on the --lan listener alone now, so a suite cannot read it back off loopback.
// Pinning it grants nothing: whoever sets this process's environment spawned the
// process and could read the key straight out of it.
const SESSION_KEY = process.env.CAST_SESSION_KEY || crypto.randomBytes(9).toString("base64url");
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
// TightVNC's polling interval is the ceiling on frames per second on the capture
// path it falls back to, and nothing at all while desktop duplication is running
// - see the VNC+ section of the README, and the tightvnc record in
// vnc-server.mjs, which carries the file and line the claim comes from. It lives
// under an HKLM key this process may not even read. tune-host.cmd is
// elevated when it writes that key, so it leaves the number here on its way out.
// A readout, never a lever: 0 means nobody has run the tuner on this machine.
const POLL_MS = readPollMs();

/* -------------------------------------------------------------- ws bridge -- */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_PENDING = 4 * 1024 * 1024;   // client bytes held while VNC is connecting
// A still screen sends nothing, and a tunnel closes a connection it has seen no
// bytes on - Cloudflare's edge does it after about 100 seconds. So a cast left
// alone died of being watched quietly. Overridable only so the tests do not have
// to sit through the real interval.
const KEEPALIVE_MS = Number(process.env.CAST_KEEPALIVE_MS || 20000);
const PUBLISH_MS = Number(process.env.CAST_PUBLISH_MS || 30000);
const PUBLISH_RETRY_MS = Number(process.env.CAST_PUBLISH_RETRY_MS || 3000);
let live = 0;

// pageListener says this request arrived on the --lan listener - the one bound to
// LAN_IP alone. The loopback listener, which is the only thing the tunnel can
// reach, passes false and so never serves the page.
function httpRequest(req, res, pageListener) {
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
    // Same endpoint, second lever: how fast this bridge should ask TightVNC for
    // updates on the viewer's behalf. See setStream - the parameter is a clamped
    // integer that never reaches a command line, unlike share, which is why this
    // one needs no whitelist. Checked before share so a stream call cannot be
    // mistaken for a share call with a missing mode.
    if (url.searchParams.has("stream")) {
      const s = setStream(url.searchParams.get("stream"),
                          url.searchParams.get("w"), url.searchParams.get("h"),
                          url.searchParams.get("v") || "");
      res.writeHead(200, { "content-type": "application/json" });
      // video says whether /video exists here, so a page can grey out Stream on
      // a host that predates it without opening a socket to find out.
      return res.end(JSON.stringify({ ok: true, ...s, pollMs: POLL_MS, video: !!video }));
    }
    const mode = url.searchParams.get("share") || "";
    return applyShareAsync(mode).then((applied) => {
      res.writeHead(applied ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(applied ? { ok: true, share: mode, pollMs: POLL_MS }
                                     : { error: "bad share mode" }));
    }).catch(() => {
      // Starting tvnserver and reaching the service takes a few hundred ms, and
      // the viewer can close the tab inside them - then there is no response
      // left to write and writeHead/end throw. Without this that is a rejected
      // promise nobody owns, which this process reports as "internal promise
      // error" while the stream carries on perfectly: a random error in the
      // console for a viewer changing their mind about a menu.
      try { res.destroy(); } catch (_) {}
    });
  }

  // On the LAN the page is served from here rather than from instellar.net. That
  // is not a convenience: a browser refuses ws:// from an https:// page, so going
  // through the site would force the traffic out to Cloudflare and back - 50ms of
  // round trip to reach a machine in the same room. Same origin, same page, ~1ms.
  //
  // This page carries the session key inlined, and that key is the only thing
  // between a stranger and a socket onto TightVNC. So the question asked here is
  // never "was --lan passed": that is an intention, and the tunnel proxies every
  // path into this process regardless of it. Both gates below are about the
  // request itself, and a request has to clear both:
  //
  //   pageListener - which socket accepted it. Under --lan the page lives on a
  //     second listener bound to LAN_IP alone. The tunnel is spawned as
  //     `cloudflared tunnel --url http://127.0.0.1:<port>`, so everything it
  //     proxies lands on the loopback listener, and that listener serves no page
  //     on any run. This is the gate that is a guarantee rather than a guess: it
  //     is a property of which socket the kernel accepted on, not of anything a
  //     peer is free to write.
  //   fromLan - what the request says. Belt to that brace, for the one case a
  //     bind cannot cover: --url lets someone front this host with a reverse
  //     proxy of their own and point it at LAN_IP.
  //
  // Without --lan no page listener is ever created, so nothing reaches this.
  if (pageListener && fromLan(req) &&
      (url.pathname === "/" || url.pathname === "/index.html")) {
    const page = viewerPage();
    if (page) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(page);
    }
  }

  // The page imports the bundle by relative path, so LAN mode has to serve it too
  // or the viewer loads and then cannot start. Only these two names are ever read
  // from disk - the path never comes from the request.
  if (pageListener && fromLan(req) && url.pathname === "/novnc.js") {
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
}

// The loopback listener. The tunnel's origin is 127.0.0.1:PORT, so this is the
// one it knocks on, and it is created with pageListener false for that reason.
const server = http.createServer((req, res) => httpRequest(req, res, false));
// The --lan listener, bound to LAN_IP alone rather than 0.0.0.0, because 0.0.0.0
// includes loopback and loopback is exactly where the tunnel arrives. Null until
// main() binds it, and null forever without --lan.
//
// Do not collapse this back into one listener on the strength of fromLan() below.
// This split IS the guarantee: cloudflared is spawned as
// `tunnel --url http://127.0.0.1:<port>`, so loopback is the only socket it can
// ever reach, and the loopback listener serves no page on any run. fromLan() is
// defence in depth stacked on top of that - it reads a peer address and a header,
// and a header is written by whoever is calling. If this split goes, the header
// check does not cover for it, and the key is back on the tunnel.
let lanServer = null;

// Did this request come from a browser on the local network, rather than through
// something proxying on its behalf? Two things are true of the first and not the
// second:
//
//   - The peer is not loopback. Everything a tunnel proxies in comes from
//     127.0.0.1, because 127.0.0.1 is the origin address it was handed.
//   - The request is addressed to the LAN address this process bound and printed
//     in its banner. A proxy passes on the hostname it was reached by, which is
//     the public one; a browser following the printed link sends that bare IP.
//
// What this does not guarantee, stated plainly: the Host header is written by
// the peer. A reverse proxy that sits on the LAN and rewrites Host to LAN_IP
// would satisfy both tests, and nothing readable from one request separates that
// from a real browser. That is why the listener split above is the gate that
// carries the weight and this is the second lock on the same door. Anything this
// cannot answer is answered no: with no LAN_IP there is no page.
function fromLan(req) {
  if (!LAN_IP) return false;
  const ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (!ip || ip === "::1" || ip.startsWith("127.")) return false;
  return String(req.headers.host || "").split(":")[0] === LAN_IP;
}

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

server.on("upgrade", onUpgrade);

// Shared by both listeners: the bridge itself is not page-gated, and a viewer
// that loaded the page over the LAN opens its socket to that same listener.
function onUpgrade(req, socket, head) {
  // Once HTTP hands an upgraded socket to us it no longer owns the error path.
  // Install this before even writing a rejection: a peer that resets during the
  // handshake must not become an unhandled `error` event for the whole process.
  socket.on("error", () => socket.destroy());
  const url = new URL(req.url, "http://localhost");
  // Not a WebSocket at all: answer like the plain-HTTP handler does, so a health
  // check sees a body rather than a bodiless 403.
  if (String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n" +
               "Content-Type: text/plain\r\n\r\ncast bridge up\n");
    return;
  }
  // Keyed, but there is no such route on this host - --video off, or no ffmpeg.
  // A plain 404 ahead of the handshake: the page reads it as "unavailable" rather
  // than as a socket that opened and then died. Only after the key matches, so
  // an unkeyed probe learns nothing it would not from /ws.
  if (url.pathname === "/video" && !video && url.searchParams.get("k") === SESSION_KEY) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n" +
               "Content-Type: text/plain\r\n\r\nvideo off\n");
    return;
  }
  if (url.searchParams.get("k") !== SESSION_KEY || !handshake(req, socket)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n" +
               "Content-Type: text/plain\r\n\r\nbad or missing key\n");
    return;
  }
  if (url.pathname === "/ping") pingProbe(socket, head);
  else if (url.pathname === "/video") videoRoute(socket, head, url);
  // Which tab this socket belongs to, so /ctl can name it later. Not a
  // credential - the key above is - just an identifier, and an absent one means
  // an older page and the old whole-host behaviour.
  else bridge(socket, head, url.searchParams.get("v") || "");
}

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
  socket.setKeepAlive(true, 20000);
  return true;
}

// Reads masked client frames off `sock` and hands each data payload to onData.
// Returns the feed function to push raw socket bytes through. Control frames are
// answered here so neither caller has to care about them.
function wsReader(sock, onData, onClose, onPong) {
  let buf = Buffer.alloc(0);
  let dead = false;

  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (dead) return;
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      // FIN says whether this frame finishes the message. Everything below still
      // treats continuation, text and binary alike, but a caller that writes the
      // payload straight on to something with its own framing needs to know when it
      // is holding half of one - see the injector in bridge().
      const fin = (buf[0] & 0x80) !== 0;
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
      if (op === 0x0a) { if (onPong) onPong(payload); continue; } // pong
      // Continuation / text / binary are all just payload as far as we care.
      onData(payload, fin);
    }
  };
}

// Echoes whatever it is sent, so the page can time a real round trip over the
// same tunnel the pixels use. Measuring with an HTTP request instead would fold
// in request setup that the long-lived VNC socket never pays.
function pingProbe(ws, head) {
  const feed = wsReader(ws, (p) => frame(ws, 0x02, p), () => ws.destroy());
  ws.on("error", () => ws.destroy());
  ws.on("end", () => ws.destroy());
  ws.on("data", feed);
  if (head && head.length) feed(head);
}

/* ----------------------------------------------------------------- video -- */

// The one encoder every Stream viewer shares. null until main() has found
// ffmpeg, and stays null when it cannot or when --video off, which is what the
// upgrade handler and /ctl read to say the route is not here.
let video = null;

// How a socket ordinarily ends, in words. A viewer shutting a laptop lid,
// walking out of wifi range or losing the tunnel mid-frame hands us a Node
// error code, and ECONNRESET printed into a console whose only other content is
// errors reads as a fault in this program rather than as somebody closing a
// tab. None of these are faults and none of them are actionable, so say what
// happened instead of what the kernel called it - and keep the raw text for
// anything not on this list, because that is where a real bug would show up.
const SOCKET_ENDINGS = {
  ECONNRESET: "the connection was reset",
  ECONNABORTED: "the connection was dropped",
  EPIPE: "the viewer went away mid-frame",
  ETIMEDOUT: "the connection timed out",
  ERR_STREAM_WRITE_AFTER_END: "the viewer went away mid-frame",
  ERR_STREAM_DESTROYED: "the viewer went away mid-frame",
};
const plainly = (e) => (e && SOCKET_ENDINGS[e.code]) || (e && e.message) || String(e);

// A /video viewer. Server-to-client only: the client never sends anything but
// pongs and a close, so wsReader is here for those and its data callback drops
// whatever else arrives. Everything about the encoder - starting it, the GOP
// cache, dropping deltas for a viewer that is behind - is video.mjs's; this is
// the sink it writes into, and the sink is a WebSocket.
function videoRoute(ws, head, url) {
  const settings = validateVideoSettings(url.searchParams);
  let done = false;
  let missedPongs = 0;
  let unsubscribe = () => {};
  const since = Date.now();

  const shut = (why, code) => {
    if (done) return;
    done = true;
    clearInterval(keepalive);
    unsubscribe();
    log("DECODER+ viewer gone" + (why ? ": " + why : "") +
        " after " + Math.round((Date.now() - since) / 1000) + "s");
    // A close from the source carries a code the page acts on - 1011 "no
    // encoder" is what turns the Stream toggle back off with a reason. The
    // reader's own close path has already queued its frame, so only send one
    // when nobody has. end(), not destroy(), for the same reason as bridge().
    if (code && !ws.destroyed) frame(ws, 0x8, closeFrame(code, why));
    if (!ws.destroyed) ws.end();
  };

  // Same reasoning as bridge(): a paused game sends no frames, and a tunnel hangs
  // up on a quiet socket.
  const keepalive = setInterval(() => {
    if (ws.destroyed) return;
    if (++missedPongs >= 3) return shut("viewer stopped answering pings");
    frame(ws, 0x9, Buffer.alloc(0));
  }, KEEPALIVE_MS);

  const feed = wsReader(ws, () => {}, shut, () => { missedPongs = 0; });
  ws.on("error", (e) => shut(plainly(e)));
  ws.on("close", () => shut());
  ws.on("end", () => shut("viewer hung up"));
  ws.on("data", feed);
  if (head && head.length) feed(head);

  if (!settings) return shut("bad settings", 1008);
  // This viewer can already be gone. `head` is whatever arrived behind the
  // upgrade request, and through a tunnel that can include the viewer's own
  // close frame, so shut() may have run several lines above. Subscribing now
  // would start the encoder for nobody and leave a sink in video.mjs that
  // nothing ever removes: shut() has already set `done`, so every later socket
  // event returns early and the unsubscribe assigned below is never called. The
  // encoder would then never reach its three-second idle stop - the sink set
  // never empties - and would go on handing an access unit to a destroyed
  // socket sixty times a second for as long as the host ran.
  if (done) return;
  if (CODEC) settings.codecs = [CODEC];
  log("DECODER+ viewer connected (" + settings.fps + " fps, " + settings.mbps +
      " mbps, " + settings.display + ", " + settings.codecs.join(",") + ")");

  // video.mjs fans one access unit out to every sink in a single loop, and that
  // loop runs inside the encoder's stdout handler. A throw from this viewer -
  // a write onto a socket the kernel has already torn down, a Buffer that will
  // not allocate - would end that loop, so every viewer after this one in the
  // set silently loses the frame; and it would come out of a stream handler
  // with no 'error' listener above it, which is an uncaught exception and the
  // end of the host for everybody. One viewer misbehaving has to cost that
  // viewer and nobody else, so nothing handed to subscribe() may throw. The
  // `done` check is the other half: between a peer's reset and the 'error'
  // event that reports it there is a window in which this socket is destroyed
  // and still subscribed, and a write in that window is pure waste.
  const sink = (what, fn) => (...a) => {
    if (done) return;
    try { return fn(...a); } catch (e) { shut(what + ": " + plainly(e)); }
  };

  unsubscribe = video.subscribe(settings, {
    // Text, so the page can JSON.parse it without first asking what it is.
    config: sink("config", (cfg) => {
      frame(ws, 0x1, Buffer.from(JSON.stringify(cfg)));
    }),
    // Five bytes ahead of the access unit: flags, then a u32 timestamp. One copy
    // of the AU per viewer, which at 8 mbps is ~15KB sixty times a second - the
    // concat that frame() avoids for the pixel stream is cheap here, and the same
    // Buffer is handed to every viewer so it cannot be prepended to in place.
    au: sink("frame", (flags, tsMs, bytes) => {
      const h = Buffer.allocUnsafe(5);
      h[0] = flags;
      h.writeUInt32BE(tsMs >>> 0, 1);
      frame(ws, 0x2, Buffer.concat([h, bytes]));
    }),
    // What the source's backpressure reads: bytes we have accepted for this
    // socket that the kernel has not taken yet. A destroyed socket reports 0,
    // which would read as a viewer perfectly keeping up - au() above is what
    // stops us writing to it, not this.
    buffered: () => (done ? 0 : ws.writableLength),
    close: (code, reason) => shut(reason, code),
  });
  // subscribe() can close this viewer from inside the call: a host with no
  // encoder that will start answers 1011 synchronously. shut() then ran while
  // `unsubscribe` was still the no-op above, so nothing would ever release the
  // subscription. Harmless today because that path clears the whole sink set,
  // but it is the kind of thing that stops being harmless quietly.
  if (done) unsubscribe();
}

// Close frame payload: the status code, then the reason as UTF-8.
function closeFrame(code, reason) {
  const r = Buffer.from(reason || "");
  const b = Buffer.allocUnsafe(2 + r.length);
  b.writeUInt16BE(code, 0);
  r.copy(b, 2);
  return b;
}

/* ------------------------------------------------------------- streaming -- */

// The viewer's frame loop is depth-1: it asks for one incremental update, waits a
// full round trip for the answer, and only then asks again. Through the tunnel that
// round trip is 50ms, so the picture sits near 15fps whatever the screen is doing,
// and no quality setting can move it - quality changes bytes per frame, not frames
// per second. This bridge is 0ms from TightVNC, so it can hold that request open on
// the viewer's behalf and take the viewer's round trip out of the loop entirely.
//
// It does that without parsing a byte of RFB. A FramebufferUpdateRequest is ten
// fixed bytes and the viewer already knows its own framebuffer size, so it sends it
// on /ctl?stream=. Teaching the bridge to speak RFB instead would put a stateful
// parser in the one part of this tool that is currently simple enough to be
// obviously correct, and a timer needs none of it.
//
// TightVNC Server for Windows does not implement the ContinuousUpdates extension,
// which is the thing that would make all of this unnecessary. If a server ever does
// negotiate it, the viewer stops asking for updates and simply never calls this -
// the extra requests would be harmless anyway, since incremental requests to a
// server with nothing to report are answered with nothing.
// The rate belongs to the viewer connection, not to the host. Kept here it
// outlived the session that asked for it: closing a tab does not run the page's
// disconnect handler, so the rate stayed set, and the next viewer's bridge began
// injecting at TCP connect - several round trips before its RFB handshake has
// finished. Ten bytes landing inside the version exchange or the auth reply is a
// session that dies or mis-authenticates. Per connection, every bridge starts at
// 0, and two viewers watching at once stop overwriting each other's rate and
// each other's framebuffer size.
const streamers = new Set();       // { id, take } per live viewer

// noVNC's send buffer is 10KiB and it flushes when full, so a client message at
// least this big may be one piece of a larger one however the browser framed it.
// The injector then stands off until a message small enough to be a whole one
// goes past, and STREAM_QUIET_MS is the backstop on that wait. See bridge().
const FRAGMENT_BYTES = 8192;
const STREAM_QUIET_MS = 500;

// hz is clamped to 0..60, and 0 restores today's behaviour exactly - so a viewer
// that never calls this, or one that hangs up, leaves the bridge exactly as it was.
// w/h are remembered per connection from the last call that carried them: the
// bridge cannot know the framebuffer size on its own, so given none it accepts the
// rate and injects nothing rather than guessing a size and desynchronising
// TightVNC.
//
// `v` is which viewer is asking. The page puts a per-tab id in the URL it opens
// the socket with, so the bridge learns it during the upgrade and /ctl can name
// it - which is what makes the rate the session's rather than the host's. Two
// tabs watching at once each run their own ladder, and without this each call
// moved both: they overwrote each other's rate all session, and since the shared
// screen is host-wide their framebuffers always match, so nothing downstream
// could tell the two apart. A page that names no viewer - an older one - is
// answered the old way, every live bridge, because there is nothing to match on.
function setStream(hz, w, h, v) {
  const rate = clampInt(hz, 0, 60);
  const w16 = clampInt(w, 0, 65535);
  const h16 = clampInt(h, 0, 65535);
  const targets = v ? [...streamers].filter((s) => s.id === v) : [...streamers];
  // Nothing to settle it, so the answer is what was asked for: a named viewer
  // whose bridge has already gone is the disconnect handler's stream=0 arriving
  // after the socket it was about to quieten. Deliberately not fanned out to
  // whoever else is watching.
  let settled = { stream: rate, w: w16, h: h16 };
  for (const s of targets) settled = s.take(rate, w16, h16);
  return settled;
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;      // absent or not a number at all
  return n < lo ? lo : n > hi ? hi : n;
}

// FramebufferUpdateRequest: type 3, incremental 1, then x/y/w/h as big-endian u16.
// Incremental is what makes this cheap - TightVNC answers with whatever changed, and
// with nothing to report it does not answer at all, so a still screen costs these
// ten bytes and nothing else.
function fbUpdateRequest(w, h) {
  const b = Buffer.alloc(10);
  b[0] = 3;
  b[1] = 1;
  b.writeUInt16BE(w, 6);
  b.writeUInt16BE(h, 8);
  return b;
}

function bridge(ws, head, viewerId) {
  const vnc = net.connect(Number(VNC_PORT), VNC_HOST);
  vnc.setNoDelay(true);                       // every keystroke is its own packet
  vnc.setKeepAlive(true, 20000);
  // TCP's own connect timeout is measured in minutes on some Windows builds.
  // A viewer should not sit on a dead TightVNC port for that long looking live.
  vnc.setTimeout(15000);
  let open = false;
  let done = false;
  let pending = [];
  let pendingBytes = 0;
  let missedPongs = 0;
  // Guards of the update injector below, each tracked where it happens: the
  // viewer is behind so we stopped reading TightVNC, a client message is only
  // half delivered across WebSocket fragments, and a client message big enough to
  // have been flushed mid-message has just gone past.
  let paused = false;
  let midMessage = false;
  let clientMsgBytes = 0;            // of the client message currently arriving
  let midFlush = false;              // a message big enough to be a piece went past
  let quietUntil = 0;                // ...and the backstop on waiting for its end
  // This viewer's own rate and rectangle. Nobody else's, and nothing until it
  // asks: see setStream.
  let streamHz = 0;
  let streamW = 0;
  let streamH = 0;
  let streamReq = null;              // the ten bytes, rebuilt only when w/h change
  let streamSeen = false;            // this viewer has itself sent exactly those

  live++;
  const since = Date.now();
  log("viewer connected (" + live + " live)");

  // Nothing crosses this socket while the screen is still, and a tunnel hangs up
  // on a connection it has seen no bytes on. A ping is the cheapest traffic there
  // is, and the browser answers it in the network stack rather than in JS - so
  // this also holds up a backgrounded tab, whose own timers are throttled to
  // roughly once a minute and cannot be relied on to make noise.
  const keepalive = setInterval(() => {
    if (ws.destroyed) return;
    // A ping that gets no pong is more useful than traffic for traffic's sake:
    // after a tunnel rebuild a half-open socket can otherwise occupy TightVNC
    // indefinitely. Browsers answer below JavaScript, even in a background tab.
    if (++missedPongs >= 3) return shut("viewer stopped answering pings");
    frame(ws, 0x9, Buffer.alloc(0));
  }, KEEPALIVE_MS);

  // Ask TightVNC for the next update on this viewer's behalf, so that the viewer's
  // round trip stops being the frame period. Seven guards, and every one of them is
  // a way this could make the picture worse rather than faster:
  //
  //   open           there is a VNC socket to ask at all
  //   streamSeen     this viewer has itself sent these exact ten bytes at least
  //                  once, so its own handshake is provably behind it and the
  //                  rectangle is provably its own. A rate arriving on /ctl only
  //                  proves that of whoever called; with a second viewer watching
  //                  it proves nothing about this one, and the handshake is the
  //                  window where ten stray bytes are fatal. Watching the viewer's
  //                  own request go past costs a ten-byte compare and settles it
  //                  per connection. A rectangle we have never seen asked for is
  //                  simply not injected - the depth-1 loop, which is where this
  //                  started.
  //   writableLength nothing of ours is still queued for it - never pile requests
  //                  onto a socket that is already behind
  //   paused         the viewer is behind and we have stopped reading TightVNC, so
  //                  asking for more would grow a queue nobody is draining
  //   midMessage     a client message is half written. wsReader hands fragments
  //                  straight through, so injecting between two of them would
  //                  splice these ten bytes into the middle of another RFB message
  //                  and desynchronise TightVNC's parser for the rest of the
  //                  session.
  //   midFlush       the same splice one level up, and the one FIN cannot see:
  //                  noVNC flushes its 10KiB send buffer when it fills, so a
  //                  client message larger than that - a paste - leaves the
  //                  browser as several whole, FIN-set messages. Only a message
  //                  that big can be a piece of a larger one, so one of those
  //                  stands the injector down. Standing off after every client
  //                  write would have been simpler and would also have switched
  //                  the feature off: the viewer answers each update with a
  //                  request of its own, so at any rate worth asking for its
  //                  writes are never 50ms apart.
  //
  //                  What lifts it is a whole client message smaller than the
  //                  buffer, because that cannot be a piece of a larger one. It
  //                  is proof rather than a guess: noVNC pushes every piece of
  //                  one message in a single synchronous call, and a WebSocket
  //                  delivers in order, so nothing else can appear between them.
  //                  Waiting on a deadline instead was the whole flaw in the
  //                  first version of this - the pieces leave together but they
  //                  still have to cross the viewer's uplink, and 10KiB takes
  //                  longer than 50ms on anything under about 1.6Mbit up.
  //   quietUntil     the backstop on that wait, because "a smaller message" can
  //                  fail to arrive: a paste whose last piece is itself over the
  //                  threshold, onto a still screen, leaves no update to answer
  //                  and so nothing more to send. Without a deadline the feature
  //                  would switch itself off for the session there.
  //
  //   VNC_PUSHES     the server negotiated ContinuousUpdates with the viewer, so
  //                  it is already sending updates without being asked and this
  //                  whole mechanism is not just redundant but harmful. noVNC
  //                  stops sending FramebufferUpdateRequests the moment
  //                  continuous updates are enabled (cast/novnc.js:17893 and
  //                  :17981), which takes away the one thing that made injecting
  //                  safe: until now every request this bridge wrote was a
  //                  duplicate of ten bytes the viewer itself was sending on the
  //                  same rhythm, so a server that got two saw nothing it was not
  //                  already being asked for. On a pushing server the viewer has
  //                  gone quiet and these ten bytes are a foreign message in a
  //                  stream nobody else is writing to - and streamSeen, which
  //                  proves the rectangle by watching the viewer ask for it, can
  //                  never become true there either. Only TigerVNC has the
  //                  extension on Windows (vnc-plus.md); with TightVNC, which is
  //                  what this host runs, this is false and every line below
  //                  behaves exactly as it did before the branch existed.
  let streamTimer = null;
  let armedHz = 0;
  const arm = () => {
    // No w/h means no request to send, so that is the same as no rate at all -
    // and neither does a server that is already pushing them.
    const want = streamReq && !done && !VNC_PUSHES ? streamHz : 0;
    if (want === armedHz) return;      // same rate: keep the phase we are already on
    armedHz = want;
    clearTimeout(streamTimer);
    streamTimer = null;
    if (!want) return;

    // Deadline-chasing rather than setInterval, because Windows timers land on a
    // ~15.6ms tick: a flat setInterval(50) fires every 62ms and the 20fps somebody
    // asked for quietly becomes 16. Aiming at the next deadline lets each fire
    // absorb the rounding of the one before it. Never catch up on a missed
    // deadline, though - falling behind means a guard was holding us back, and a
    // burst of requests is the exact thing guard 2 is there to prevent.
    const period = 1000 / want;
    let next = Date.now() + period;
    const tick = () => {
      const now = Date.now();
      next += period;
      if (next < now - period) next = now + period;
      streamTimer = setTimeout(tick, Math.max(0, next - now));
      if (done || !open || paused || midMessage) return;
      if (!streamSeen || (midFlush && now < quietUntil)) return;
      if (vnc.writableLength !== 0) return;
      vnc.write(streamReq);
    };
    streamTimer = setTimeout(tick, period);
  };

  // What /ctl?stream= reaches. A rectangle this viewer has not asked for yet has
  // to be proven again before anything goes out at it.
  const take = (hz, w, h) => {
    streamHz = hz;
    streamW = w || streamW;
    streamH = h || streamH;
    const req = streamW && streamH ? fbUpdateRequest(streamW, streamH) : null;
    if (!req || !streamReq || !req.equals(streamReq)) streamSeen = false;
    streamReq = req;
    arm();
    return { stream: streamHz, w: streamW, h: streamH };
  };
  const streamer = { id: viewerId, take };
  streamers.add(streamer);

  const shut = (why) => {
    if (done) return;
    done = true;
    live--;
    clearInterval(keepalive);
    // Either socket going means there is nobody to ask for, so stop asking. Left
    // behind, this timer would hold the process open and keep writing into a
    // destroyed socket for as long as the host ran.
    streamers.delete(streamer);
    clearTimeout(streamTimer);
    // How long it lasted is the difference between a timeout and bad luck: drops
    // that cluster around one duration are something expiring on a timer, drops
    // scattered across seconds and hours are the link itself.
    log("viewer gone" + (why ? " - " + why : "") +
        " after " + Math.round((Date.now() - since) / 1000) + "s (" + live + " live)");
    // end(), not destroy(): the close frame the reader just queued is still in
    // the write buffer, and destroy() threw it away - so a viewer closing its tab
    // got a TCP reset and logged an abnormal 1006 close instead of a clean one.
    if (!ws.destroyed) ws.end();
    vnc.destroy();
  };

  // Browser -> VNC. Anything the client sends before the VNC socket is up waits
  // in `pending` rather than being dropped.
  const feed = wsReader(ws, (payload, fin) => {
    // Half a client message is on its way to vnc until the frame carrying FIN
    // arrives; the injector must not write anything between the pieces.
    midMessage = !fin;
    clientMsgBytes += payload.length;
    if (fin) {
      // A whole message this big is noVNC's send buffer emptying mid-message, so
      // the rest of that message is right behind it whatever FIN said - and one
      // smaller than the buffer is a message that ended, which is what says the
      // sequence is over. See the injector's guards.
      if (clientMsgBytes >= FRAGMENT_BYTES) {
        midFlush = true;
        quietUntil = Date.now() + STREAM_QUIET_MS;
      } else {
        midFlush = false;
      }
      clientMsgBytes = 0;
    }
    // The viewer asking for the rectangle we would inject: proof that its own
    // handshake is done and that the rectangle is the one it wants. Nothing is
    // injected before this, and the compare stops the moment it is true.
    if (streamReq && !streamSeen && payload.includes(streamReq)) streamSeen = true;
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
  }, shut, () => { missedPongs = 0; });

  vnc.on("connect", () => {
    open = true;
    vnc.setTimeout(0);                         // silence is normal once connected
    // Honour backpressure on the replay too; ignoring it left vnc write-buffered
    // with the browser still streaming into it.
    for (const p of pending) { if (!vnc.write(p)) ws.pause(); }
    pending = [];
    pendingBytes = 0;
  });
  vnc.on("timeout", () => shut("vnc connect timed out"));
  vnc.on("error", (e) => shut("vnc: " + e.message));
  vnc.on("end", () => shut("vnc hung up"));
  vnc.on("close", () => shut());
  ws.on("error", (e) => shut(plainly(e)));
  ws.on("close", () => shut());
  // http.Server hands out sockets with allowHalfOpen, so a viewer that vanishes
  // with a bare FIN and no close frame - a tunnel dropping it, a laptop lid -
  // never reaches "close" on its own. Left alone, TightVNC kept encoding frames
  // for a socket nobody was reading.
  ws.on("end", () => shut("viewer hung up"));

  ws.on("data", feed);
  if (head && head.length) feed(head);

  vnc.on("drain", () => ws.resume());

  // VNC -> browser, one frame per read so updates leave as soon as they exist.
  // The pause is also guard 3 above: while the viewer is behind, this session has
  // no business asking TightVNC for more frames.
  vnc.on("data", (d) => { if (!frame(ws, 0x02, d)) { paused = true; vnc.pause(); } });
  ws.on("drain", () => { paused = false; vnc.resume(); });
}

// Server-to-client frames are never masked. Header and payload leave in a single
// packet, which matters because this runs with Nagle disabled - but corking is what
// buys that, not concatenation. Node coalesces writes issued while corked into one
// writev, so the header goes out ahead of the payload without the payload being
// copied. It used to be a Buffer.concat, which meant memcpying every byte of the
// pixel stream to prepend at most ten bytes to it.
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
  if (n === 0) return sock.write(head);         // close and keepalive pings
  sock.cork();
  sock.write(head);
  const ok = sock.write(payload);
  sock.uncork();
  return ok;
}

/* ----------------------------------------------------------------- share -- */

// Every pixel of shared desktop is bandwidth to move, memory to hold, and work
// for the viewer to decode. Two 1080p monitors is a 3840x1080 framebuffer, twice
// what anyone needs to read code on. TightVNC can share a single display instead,
// which cuts all three costs in half, so that is the default.
let shareChanged = false;

// Resolves a share mode to the server's argv, or null if it is not one we allow.
// The whitelist moved into vnc-server.mjs along with the binary paths, and it is
// still what makes the /ctl query parameter safe to pass through: nothing from
// the request ever reaches a command line unmatched, and the display number is
// still matched against /^[1-9][0-9]?$/ and nothing else. A server with no share
// CLI - which is both of the alternatives - answers null for every mode
// including "full", so applyShare reports that it could not crop rather than
// pretending it did.
function shareCommand(mode) {
  return shareArgv(VNC_SERVER, mode);
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
let replaceTunnelUrl = null;
let recoveringTunnel = false;
let restartFailures = 0;
let restartDelay = 2000;
const MAX_TUNNEL_RESTARTS = 10;
const MAX_TUNNEL_BACKOFF = 30000;
const HEALTHY_TUNNEL_MS = 2 * 60 * 1000;

function startTunnel() {
  if (FIXED_URL) return Promise.resolve(FIXED_URL.replace(/^https?:/, "wss:"));
  if (TUNNEL === "none") return Promise.resolve("ws://127.0.0.1:" + PORT);

  // cloudflared first: its quick tunnels need no account, have no bandwidth cap
  // and put no browser-warning interstitial in front of the WebSocket upgrade.
  // Keep what the probe found. findBin spawns a process to answer, so asking it
  // twice for the same binary - once for "is cloudflared here", once for "where" -
  // was two process launches for a path we were already holding.
  const probed = TUNNEL === "auto" ? findBin("cloudflared") : null;
  const kind = TUNNEL === "auto" ? (probed ? "cloudflared" : "ngrok") : TUNNEL;
  // Test-only: lets the bridge suite stand in for cloudflared without installing
  // it or opening a real public tunnel. A JS file is run through this Node.
  const override = process.env.CAST_TUNNEL_BIN || "";
  const found = override || (kind === "cloudflared" && probed) || findBin(kind);
  const bin = override && /\.[cm]?js$/i.test(override) ? process.execPath : found;
  if (!bin) {
    return Promise.reject(new Error(
      "could not find " + kind + " on PATH. Install it, or open a fresh terminal " +
      "if you just did - a terminal started before the install still has the old PATH."));
  }

  const args = override && bin === process.execPath ? [override]
    : override ? []
    : kind === "ngrok"
    ? ["http", String(PORT), "--log", "stdout", "--log-format", "json"]
      .concat(NGROK_DOMAIN ? ["--domain", NGROK_DOMAIN] : [])
    : ["tunnel", "--url", "http://127.0.0.1:" + PORT];

  const spec = { kind, bin, args };
  return spawnTunnel(spec, false);
}

// One child, one scrape promise. Its listeners close over `child`, never the
// mutable global, so an old exit cannot reject or tear down its replacement.
function spawnTunnel(spec, restarted) {
  const { kind, bin, args } = spec;
  log("starting " + kind + "...");
  // findBin always hands back a full path now, so this never needs a shell - and
  // must not have one. With shell:true on Windows the child was cmd.exe, so kill()
  // killed the wrapper and left cloudflared running: an orphaned tunnel still
  // holding its hostname open, its exit handler never firing, and - once a later
  // run reused the port - that stale public URL proxying into the new bridge.
  const child = spawn(bin, args, { windowsHide: true });
  tunnelProc = child;
  troubleBuf = "";
  lastTrouble = "";

  return new Promise((resolve, reject) => {
    let done = false;
    let settled = false;
    let readyAt = 0;
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (tunnelProc === child) tunnelProc = null;
      child.kill();
      reject(e);
    };
    const timer = setTimeout(
      () => fail(new Error(kind + " printed no URL in 45s")), 45000);

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
        done = true;
        readyAt = Date.now();
        clearTimeout(timer);
        resolve(m[0].replace(/^https:/, "wss:"));
      } else if (!settled && /err_|error/i.test(String(chunk))) {
        process.stderr.write(String(chunk));
      } else if (settled) {
        tunnelTrouble(String(chunk));
      }
    };

    child.stdout && child.stdout.on("data", scan);
    child.stderr && child.stderr.on("data", scan);
    // A pipe being read with no 'error' listener on it is a process-level throw
    // waiting for the right moment, and on Windows that moment is ordinary:
    // kill() here is TerminateProcess rather than a signal, so the read side can
    // see the handle go and report EPIPE/ECONNRESET on the stream instead of a
    // clean end. That would be an uncaught exception, which takes the bridge,
    // every viewer and the encoder with it - to say that cloudflared, which we
    // had just deliberately killed, had stopped writing. There is nothing to
    // say: the 'exit' handler below decides what happens next either way. This
    // is only somewhere for it to land.
    for (const pipe of [child.stdout, child.stderr]) if (pipe) pipe.on("error", () => {});
    child.on("error", (e) => fail(new Error("could not run " + kind + ": " + e.message)));
    child.on("exit", (code) => {
      if (tunnelProc !== child) return;
      tunnelProc = null;
      if (!settled) {
        return fail(new Error(kind + " exited (" + code + ")"));
      }
      if (quitting || fataling) return;
      recoverTunnel(spec, restarted, Date.now() - readyAt, code);
    });
  });
}

async function recoverTunnel(spec, restarted, livedFor, code) {
  if (recoveringTunnel || quitting || fataling) return;
  recoveringTunnel = true;
  stopPublishLoop();

  if (livedFor >= HEALTHY_TUNNEL_MS) {
    restartFailures = 0;
    restartDelay = 2000;
  } else if (restarted) {
    restartFailures++;
  }
  log(spec.kind + " exited (" + code + ") - restarting the tunnel; " +
      "the watch link will not change");

  while (!quitting && !fataling) {
    if (restartFailures >= MAX_TUNNEL_RESTARTS) return giveUpTunnel(spec.kind);
    const wait = restartDelay;
    restartDelay = Math.min(restartDelay * 2, MAX_TUNNEL_BACKOFF);
    log("tunnel restart " + (restartFailures + 1) + "/" + MAX_TUNNEL_RESTARTS +
        " in " + Math.round(wait / 1000) + "s");
    await new Promise((r) => setTimeout(r, wait));
    if (quitting || fataling) break;

    try {
      const base = await spawnTunnel(spec, true);
      const replacement = tunnelProc;
      if (!replacement) throw new Error(spec.kind + " exited before its URL could be published");
      // The first child can technically exit in the few milliseconds between URL
      // discovery and initial publish. Wait until main has installed the mover.
      while (!replaceTunnelUrl && !quitting && !fataling) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (quitting || fataling) break;
      await replaceTunnelUrl(base);
      if (tunnelProc !== replacement) {
        throw new Error(spec.kind + " exited while its URL was being published");
      }
      console.log("    Tunnel        " + base + "   (watch link unchanged; nothing to do)");
      recoveringTunnel = false;
      return;
    } catch (e) {
      stopPublishLoop();
      if (tunnelProc) {
        const failed = tunnelProc;
        tunnelProc = null;
        failed.kill();
      }
      restartFailures++;
      log("tunnel restart failed (" + restartFailures + "/" + MAX_TUNNEL_RESTARTS +
          "): " + (e.message || e));
    }
  }
  recoveringTunnel = false;
}

function giveUpTunnel(kind) {
  fataling = true;
  log(kind + " could not be restarted after " + MAX_TUNNEL_RESTARTS +
      " attempts - the link is dead, shutting down");
  stopPublishLoop();
  if (video) video.stop();
  unpublish().then(() => {
    restoreShare();
    process.exit(1);
  });
}

// Everything the tunnel printed after the URL was being dropped on the floor,
// and that is where it says it lost its connection to the edge and rebuilt it -
// which takes every WebSocket through it down with it. Without these lines a
// cast that drops looks causeless from in here. Warnings and errors only: the
// routine chatter is a line every few seconds and would bury the log the viewer
// events are in.
let troubleBuf = "";
let lastTrouble = "";
let lastTroubleAt = 0;
// How long the same line stays suppressed. Long enough that an outage is one
// line rather than one a second; short enough that a fault still happening an
// hour later says so again instead of looking like it stopped.
const TROUBLE_REPEAT_MS = 60000;

function tunnelTrouble(chunk) {
  troubleBuf += chunk;
  const lines = troubleBuf.split(/\r?\n/);
  troubleBuf = lines.pop();
  if (troubleBuf.length > 8192) troubleBuf = "";     // a line that never ends
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    // cloudflared tags levels WRN/ERR/FTL; ngrok's JSON carries "lvl":"warn"|"eror".
    const loud = /\b(WRN|ERR|FTL)\b|"lvl":"(warn|eror|crit)"/.test(text);
    // The two words that say the edge connection went away and came back. They
    // are the reason a viewer just dropped, so they are worth printing - but
    // only when the tunnel is not saying them as routine bookkeeping. "Warnings
    // and errors only" was the intent from the first version and this is where
    // it leaked: cloudflared rotates its four edge connections on a schedule of
    // its own, and every rotation prints `INF Unregistered tunnel connection
    // connIndex=N` at information level. Four cheerful lines about a tunnel
    // doing exactly what it should, in a console whose only other content is
    // errors, are read as errors - which is most of what "random errors while
    // the stream is running" turns out to be.
    const churn = /unregister|reconnect/i.test(text);
    const chatter = /\b(INF|DBG|TRC)\b|"lvl":"(info|debug|trace)"/.test(text);
    if (!loud && !(churn && !chatter)) continue;
    // The same failure repeats every retry, and a tunnel that is down repeats it
    // for as long as it is down. Say it once - which comparing the raw line
    // never actually did, because every repeat carries its own timestamp and its
    // own connIndex and so differed from the one before it. Compare what is left
    // with those taken out: the four connections failing the same way become one
    // line, and a genuinely different message still gets through.
    const key = text.replace(/^\S*\d{2}:\d{2}:\d{2}\S*\s*/, "").replace(/\d+/g, "#");
    const now = Date.now();
    if (key === lastTrouble && now - lastTroubleAt < TROUBLE_REPEAT_MS) continue;
    lastTrouble = key;
    lastTroubleAt = now;
    log("tunnel: " + text.slice(0, 200));
  }
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
  // No shell: `where` and `which` are real executables, so a shell here only added
  // a cmd.exe between us and the answer. A probe that cannot run at all leaves
  // status unset, which falls through to WELL_KNOWN exactly as a miss does.
  const r = spawnSync(probe, [cmd], { encoding: "utf8" });
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
let publishStopped = false;
let publishGeneration = 0;
let publishedUrl = "";

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
    const e = new Error("publish failed " + r.status + ": " + (await r.text()).slice(0, 200));
    e.status = r.status;   // 409 is "somebody else holds the slot", which is worth waiting out
    throw e;
  }
}

// The first publish is the only one that can lose to a record on its way out. A
// record written before the view/publish split carries no owner, so nothing can
// overwrite it and it has to lapse on its own - which means the first run against
// a freshly deployed API would otherwise die on a 409 that clears itself within
// the record's 90s TTL. Wait it out rather than making that the user's problem.
async function claimSlot(wsUrl) {
  const deadline = Date.now() + 100000;
  let waited = false;
  let transient = 0;
  for (;;) {
    try {
      return await publish(wsUrl);
    } catch (e) {
      if (e.status !== 409) {
        // A cold function, DNS wobble or brief 5xx should not abort the whole
        // cast before it has even printed the link. Client errors are permanent;
        // retrying a bad token or URL only hides the useful failure.
        if ((e.status && e.status < 500) || ++transient >= 5) throw e;
        log("publish: " + e.message + " - retrying");
        await new Promise((r) => setTimeout(r, PUBLISH_RETRY_MS * transient));
        continue;
      }
      if (Date.now() > deadline) {
        console.error("");
        console.error("  The cast slot has been held by someone else for the last 100s.");
        console.error("  If that is another copy of this script, or another machine, stop");
        console.error("  it first. If it is nobody you know of, set CAST_TOKEN on the site");
        console.error("  and here: without it anyone can claim an empty slot and keep you out.");
        throw new Error("could not claim the cast slot");
      }
      if (!waited) {
        log("slot is held by an older record - waiting for it to lapse (up to 90s)");
        waited = true;
      }
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

// setInterval made a slow request overlap its successor as soon as retries were
// added. One self-scheduling loop owns the POST instead: transient failures get
// two quick retries, successful refreshes return to the quiet 30-second cadence,
// and a longer outage keeps trying every 10 seconds without piling up fetches.
function startPublishLoop(getUrl) {
  clearTimeout(publishTimer);
  publishStopped = false;
  const generation = ++publishGeneration;
  const current = () => !publishStopped && generation === publishGeneration;
  const later = (ms) => {
    if (current()) publishTimer = setTimeout(beat, ms);
  };
  // The failure this loop has already reported, and how many beats it has
  // swallowed since. A site that is down for a minute is one fact, and the old
  // code stated it eighteen times: three attempts a beat, a beat every ten
  // seconds, a line for each. All of them true, none of them new, and the whole
  // window of them lands in the console of somebody who is watching a stream
  // that never faltered - the registry record is how a viewer *finds* this host,
  // not how a connected one stays connected.
  let saying = "";
  let quiet = 0;
  const beat = async () => {
    for (let attempt = 1; attempt <= 3 && current(); attempt++) {
      try {
        await publish(getUrl());
        // Recovery is the news. The thirty ordinary beats after it are not.
        if (saying) {
          log("heartbeat recovered after " + quiet + " failed " +
              (quiet === 1 ? "beat" : "beats"));
          saying = "";
          quiet = 0;
        }
        return later(PUBLISH_MS);
      } catch (e) {
        if (e.message !== saying) {
          log("heartbeat: " + e.message +
              " - the site may have dropped this cast; retrying until it comes back");
          saying = e.message;
          quiet = 0;
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, PUBLISH_RETRY_MS * attempt));
      }
    }
    if (current()) {
      quiet++;
      later(Math.min(10000, PUBLISH_MS));
    }
  };
  later(PUBLISH_MS);
}

function stopPublishLoop() {
  publishStopped = true;
  publishGeneration++;
  clearTimeout(publishTimer);
}

async function unpublish() {
  // If startup never published, there is nothing belonging to this process to
  // remove. More importantly, name the exact URL: a replacement process uses the
  // same persistent publish key, and an older process must not delete its record
  // when the older tunnel finally exits.
  if (!publishedUrl) return;
  try {
    const headers = ADMIN_TOKEN ? { "x-admin-token": ADMIN_TOKEN } : {};
    await fetch(SITE + "/api/cast?p=" + encodeURIComponent(PUBLISH_KEY) +
                "&u=" + encodeURIComponent(publishedUrl), {
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

// tune-host.cmd leaves the polling interval it wrote here, because it is elevated
// at the time and this process is not: HKLM\SOFTWARE\TightVNC\Server is
// administrator-only even to read, so the bridge cannot ask the registry what the
// interval is. A readout and nothing more - the poll rate is machine-wide, and a
// remote page moving it is a different question from "which monitor am I looking
// at". 0 means the tuner has not been run here, not that the interval is zero.
function readPollMs() {
  const base = process.env.PROGRAMDATA || "";
  if (!base) return 0;
  try {
    const n = Number(fs.readFileSync(path.join(base, "instellar-cast", "poll-ms"), "utf8").trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  } catch (_) {
    return 0;                        // never tuned, or not a Windows host
  }
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
  // The tunnel is the long pole - a quick tunnel takes seconds to print its URL -
  // and it depends on neither of the checks below, so start it first and join it at
  // the end. The catch is not cosmetic: without a handler attached now, a tunnel
  // that fails while we are still probing VNC is an unhandled rejection, and the
  // real await further down would arrive too late to claim it.
  const tunnelUp = startTunnel();
  tunnelUp.catch(() => {});

  if (!(await checkVnc())) {
    if (tunnelProc) tunnelProc.kill();     // started above; do not orphan it
    console.error("\n  No VNC+ server answering on " + VNC_HOST + ":" + VNC_PORT + ".");
    console.error(VNC_SERVER
      ? "  Start " + VNC_SERVER.name + " (it installs as the " + VNC_SERVER.serviceName + " service) and"
      : "  Start TightVNC Server (it installs as the tvnserver service) and");
    console.error("  make sure it has a password set, then run this again.\n");
    process.exit(1);
  }

  // The async twin, so the few hundred ms Windows takes to start tvnserver and
  // reach the service is spent reading the tunnel's output rather than blocking on
  // it. restoreShare still uses the sync one: exit paths have nothing to overlap.
  if (!(await applyShareAsync(SHARE))) {
    log("could not set share mode \"" + SHARE + "\" - carrying on with whatever\n           the VNC+ server is already sharing");
  }

  // Find ffmpeg now, so a missing one is a startup line and not the first
  // viewer's mystery. Only found: it is not spawned until a viewer asks, since
  // an idle encoder is a GPU and a monitor capture nobody is watching.
  if (!VIDEO) {
    log("DECODER+ off (--video off)");
  } else {
    const ffmpeg = FFMPEG || findBin("ffmpeg");
    if (ffmpeg) video = createVideoSource({ ffmpeg, log });
    else log("DECODER+ off (ffmpeg not found on PATH - install it to offer DECODER+)");
  }

  // Resolved before anything binds, because under --lan it decides what the
  // second listener binds to. A machine with no route out has no LAN address to
  // bind, and then --lan serves no page rather than falling back to something
  // broader: if the code cannot say where a request came from, it must not hand
  // out the key.
  if (LAN) LAN_IP = (await lanAddress()) || "";

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  log("VNC+ bridge on 127.0.0.1:" + PORT + " -> " + VNC_HOST + ":" + VNC_PORT +
      (VNC_SERVER ? " (" + VNC_SERVER.brand + ")" : ""));
  // Which half of the capability branch this run is on, printed once, because
  // "is the request injector running" is otherwise invisible from the console,
  // and it is the first thing to look at if the pacing ever seems wrong.
  if (VNC_PUSHES) log("VNC+ server pushes updates - request injector off");

  if (LAN && LAN_IP) {
    lanServer = http.createServer((req, res) => httpRequest(req, res, true));
    lanServer.on("upgrade", onUpgrade);
    // A second bind that fails must not take a working cast down with it - the
    // loopback listener is up by here and the tunnel is already scraping a URL.
    // So this one logs where the other one exits.
    lanServer.on("error", (e) =>
      log("--lan: could not listen on " + LAN_IP + ":" + PORT + " - " + e.message +
          "; carrying on without the local page"));
    await new Promise((r) => {
      lanServer.once("error", () => r());
      lanServer.listen(PORT, LAN_IP, r);
    });
    if (lanServer.listening) {
      log("VNC+ bridge on " + LAN_IP + ":" + PORT + " (--lan; the only listener that serves the page)");
    } else {
      lanServer = null;
    }
  } else if (LAN) {
    log("--lan: no local network address found, so the viewer page is not served");
  }
  // Saying nothing when it is unknown is what let a host sit at 1 FPS with a
  // healthy-looking ping and everyone blaming the network. But this line used to
  // call the number the ceiling on frames per second full stop, and it is not:
  // PollingInterval is a member of TightVNC's Win32ScreenDriver, the driver the
  // factory falls back to. While UseD3D is on and desktop duplication is running
  // - which is the default and is what this host is believed to be doing - the
  // interval governs nothing at all. It is still worth printing, because it is
  // the ceiling the moment duplication cannot start, and nothing here can see
  // which of the two happened: TightVNC logs that, at a log level it ships off.
  log(POLL_MS ? "polling interval " + POLL_MS + " ms (~" + Math.round(1000 / POLL_MS) +
                " fps) - the ceiling only if desktop duplication is not running"
              : "polling interval unknown - run tools\\cast-host\\tune-host.cmd once on this machine");

  const base = await tunnelUp;
  let wsUrl = base + "/ws?k=" + SESSION_KEY;

  // With no tunnel there is no address a viewer could reach, so the registry has
  // nothing to remember. Publishing anyway meant --tunnel none died on the site's
  // wss:// check - taking the LAN cast, which needs the site for nothing at all,
  // down with it - and on an offline network it died on the fetch instead.
  if (!TUNNELLESS) {
    await claimSlot(wsUrl);
    publishedUrl = wsUrl;
    if (!recoveringTunnel) startPublishLoop(() => wsUrl);
    replaceTunnelUrl = async (nextBase) => {
      const nextUrl = nextBase + "/ws?k=" + SESSION_KEY;
      await claimSlot(nextUrl);
      wsUrl = nextUrl;
      publishedUrl = nextUrl;
      startPublishLoop(() => wsUrl);
    };
  }

  console.log("\n  Casting \"" + NAME + "\".\n");
  if (!TUNNELLESS) {
    console.log("    Watch it at   " + SITE + "/cast#" + TOKEN);
    console.log("    Tunnel        " + base);
  } else {
    console.log("    No tunnel (--tunnel none), so this cast is local only.");
  }
  console.log("");
  if (LAN && lanServer) {
    console.log("    On this network  http://" + LAN_IP + ":" + PORT + "/   (much faster)");
    console.log("");
    console.log("    That page has this run's session key written into it, so --lan puts");
    console.log("    the key on your local network. It is served on " + LAN_IP + " and");
    console.log("    nowhere else - the tunnel reaches this host on loopback, where there");
    console.log("    is no page to read it out of.");
  } else if (LAN) {
    console.log("    --lan found no local network address, so no page is being served here.");
  } else {
    // Do not sell --lan as "skips the tunnel". It does not turn the tunnel off,
    // and a user who read it that way and passed --lan on its own was the whole
    // of the hole this listener split closed.
    console.log("    Watching from this same network? --lan serves the page from here,");
    console.log("    which is worth about 50ms of round trip. It does not turn the tunnel");
    console.log("    off; it writes this run's session key into a page on your local");
    console.log("    network - fine at home, think twice on a network you do not control.");
  }
  console.log("");
  if (!TUNNELLESS) {
    console.log("  That link carries the view key, so treat it like a password -");
    console.log("  anyone holding it reaches this machine's VNC+ password prompt.");
    console.log("  It does not let them move the cast: that needs the publish key,");
    console.log("  which stays in ~/.instellar-cast and is never printed.\n");
  }
  console.log("  Leave this window open. Ctrl+C stops the cast.\n");
}

let quitting = false;
let fataling = false;

// Every socket and child has its own error listener, so reaching either of these
// means a programming fault rather than an ordinary disconnect. A rejected
// background promise can be reported without sacrificing healthy viewers; an
// uncaught exception gets a loud, bounded cleanup instead of silently orphaning
// the tunnel, registry record and TightVNC share mode.
process.on("unhandledRejection", (e) => {
  log("internal promise error: " + String(e?.message || e));
});
process.on("uncaughtException", (e) => {
  if (fataling) return process.exit(1);
  fataling = true;
  console.error("\n  Internal host error: " + String(e?.stack || e) + "\n");
  stopPublishLoop();
  restoreShare();
  if (video) video.stop();
  if (tunnelProc) tunnelProc.kill();
  const out = () => process.exit(1);
  if (TUNNELLESS || !publishedUrl) return out();
  unpublish().then(out, out);
  setTimeout(out, 5500).unref();
});

// SIGTERM is never raised on Windows and closing the console window does not
// arrive as SIGINT either; SIGBREAK and SIGHUP are what Node does deliver there.
// Without them the only clean exit was Ctrl+C, and every other way of stopping
// left the display cropped and the record advertised for its full TTL.
async function shutDown() {
  if (quitting) {
    // Second Ctrl+C, usually because unpublish() is sitting on its timeout and
    // the window looks hung. Give up on the network, but still put the display
    // back - that is local, instant, and the thing worth saving.
    restoreShare();
    if (video) video.stop();
    if (tunnelProc) tunnelProc.kill();
    process.exit(0);
  }
  quitting = true;
  log("shutting down...");
  stopPublishLoop();
  // Restore first: it is a local call that always succeeds, where unpublish is
  // a network round trip that can hang for its full 5s.
  restoreShare();
  if (video) video.stop();
  if (!TUNNELLESS) await unpublish();
  if (tunnelProc) tunnelProc.kill();
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => { shutDown(); });
}

// Task Scheduler cannot deliver Ctrl+C to a hidden child, and child.kill() on
// Windows is TerminateProcess rather than a signal. The always-on agent drops
// this file instead, giving us the exact same cleanup path as the console.
if (STOP_FILE) {
  const stopWatch = setInterval(() => {
    if (fs.existsSync(STOP_FILE)) {
      clearInterval(stopWatch);
      shutDown();
    }
  }, 250);
  stopWatch.unref();
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

// The last line of defence against an orphaned encoder. Windows does not kill a
// child when its parent goes, and the bridge is listening before main() has
// finished - server.listen comes before the await on the tunnel and before the
// slot is claimed - so a viewer can have ffmpeg running by the time one of those
// fails and exits. ffmpeg holds the D3D11 desktop duplication for as long as it
// lives, so one left behind is not merely a stray process: it is the reason the
// next run's encoder cannot acquire the screen, on a machine where nothing looks
// wrong. Every deliberate exit path calls video.stop() itself; this catches the
// ones that are not deliberate. stop() is synchronous, which is the only kind of
// work an 'exit' handler can do.
process.on("exit", () => { if (video) video.stop(); });

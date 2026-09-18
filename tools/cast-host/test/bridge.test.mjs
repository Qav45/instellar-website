// Boots the real cast-host bridge against a stand-in VNC server and checks what
// it will and will not hand out. --tunnel none so nothing is published anywhere.
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Repo root, as a real filesystem path - a file: URL pathname is "/C:/..." on
// Windows, which is not a directory anything can be spawned in.
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const VNC_PORT = 59011;
const PORT = 60811;

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};

// Stand-in for TightVNC: greets like RFB and echoes whatever it is sent.
const vncClosed = [];   // one promise per connection, settled when the bridge lets go
const vnc = net.createServer((sock) => {
  vncClosed.push(new Promise((r) => sock.on("close", r)));
  sock.write("RFB 003.008\n");
  sock.on("data", (d) => {
    if (String(d) === "DROP") sock.destroy(new Error("test reset"));
    else sock.write(d);
  });
  sock.on("error", () => {});
});
await new Promise((r) => vnc.listen(VNC_PORT, "127.0.0.1", r));

function boot(extraArgs) {
  const proc = spawn(process.execPath, [
    fileURLToPath(new URL("../cast-host.mjs", import.meta.url)),
    "--tunnel", "none", "--port", String(PORT),
    "--vnc", "127.0.0.1:" + VNC_PORT, "--share", "nope",   // no TightVNC here
  ].concat(extraArgs), { cwd: REPO, windowsHide: true });

  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error("bridge did not start:\n" + out)), 15000);
    const scan = (c) => {
      out += String(c);
      if (/Leave this window open/.test(out)) { clearTimeout(t); resolve({ proc, out }); }
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    proc.on("exit", (code) => { clearTimeout(t); reject(new Error("exited " + code + ":\n" + out)); });
  });
}

// host is the address dialled - which listener answers; headers.Host is what the
// request claims to be addressed to. The bridge now cares about both, so tests
// have to be able to set them apart.
const req = (path, opts = {}) => new Promise((resolve) => {
  http.get({ host: opts.host || "127.0.0.1", port: PORT, path,
             headers: opts.headers || {} }, (res) => {
    let b = ""; res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, body: b }));
  }).on("error", (e) => resolve({ status: 0, body: String(e.message) }));
});

// Raw upgrade so we can see the exact status line the bridge writes.
const upgrade = (path, headers) => new Promise((resolve) => {
  const sock = net.connect(PORT, "127.0.0.1", () => {
    sock.write("GET " + path + " HTTP/1.1\r\nHost: x\r\n" +
      Object.entries(headers).map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n\r\n");
  });
  let b = "";
  sock.on("data", (c) => { b += c; if (b.includes("\r\n\r\n")) { sock.destroy(); resolve(b); } });
  sock.on("error", () => resolve(b));
  setTimeout(() => { sock.destroy(); resolve(b); }, 3000);
});

const WSKEY = crypto.randomBytes(16).toString("base64");
const WSH = { Upgrade: "websocket", Connection: "Upgrade",
              "Sec-WebSocket-Key": WSKEY, "Sec-WebSocket-Version": "13" };

/* ---- 1. Without --lan the page (and the session key in it) must not be served -- */
{
  const { proc, out } = await boot([]);

  const root = await req("/");
  ok("tunnel mode: / does not serve the viewer page",
     !/CAST_DIRECT/.test(root.body), "body=" + JSON.stringify(root.body.slice(0, 40)));
  ok("tunnel mode: / still answers health checks with a body",
     root.status === 200 && root.body.includes("cast bridge up"));

  const js = await req("/novnc.js");
  ok("tunnel mode: /novnc.js is not served either", !/noVNC/.test(js.body));

  const bad = await upgrade("/ws?k=wrong", WSH);
  ok("wrong session key is refused", /^HTTP\/1\.1 403/.test(bad), bad.split("\r\n")[0]);
  ok("...and the refusal has a body", /bad or missing key/.test(bad));

  // A reset while the rejection is being written used to have no socket error
  // listener after HTTP handed off the upgrade.
  await new Promise((resolve) => {
    const sock = net.connect(PORT, "127.0.0.1", () => {
      sock.write("GET /ws?k=wrong HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n" +
                 "Connection: Upgrade\r\nSec-WebSocket-Key: " + WSKEY + "\r\n\r\n");
      if (sock.resetAndDestroy) sock.resetAndDestroy(); else sock.destroy();
      setTimeout(resolve, 100);
    });
    sock.on("error", () => resolve());
  });
  const afterBadReset = await req("/");
  ok("a reset during a rejected upgrade does not kill the bridge", afterBadReset.status === 200);

  const notWs = await upgrade("/ws", { Upgrade: "h2c", Connection: "Upgrade" });
  ok("a non-WebSocket upgrade gets a plain answer, not a bare 403",
     /^HTTP\/1\.1 400/.test(notWs) && /cast bridge up/.test(notWs), notWs.split("\r\n")[0]);

  // The banner used to offer --lan as something that "skips the tunnel entirely".
  // It does not turn the tunnel off, and a user who read it that way and passed
  // --lan on its own published this run's session key through the tunnel.
  ok("the --lan advice no longer claims it skips the tunnel",
     /Watching from this same network\? --lan/.test(out) &&
     !/skips the tunnel entirely/.test(out) &&
     /does not turn the tunnel/.test(out));

  proc.kill();
  await new Promise((r) => proc.on("exit", r));
}

/* ---- 2. --lan serves the page to a LAN request and to nothing else -------- */
{
  const { proc, out } = await boot(["--lan"]);

  ok("--lan: the loopback listener binds 127.0.0.1, not 0.0.0.0",
     /bridge on 127\.0\.0\.1:/.test(out) && !/bridge on 0\.0\.0\.0/.test(out));

  // The shape a tunnelled request has. cloudflared is spawned as
  // `tunnel --url http://127.0.0.1:<port>`, so it dials loopback and passes the
  // public hostname through in Host. This is the request that used to be handed
  // the session key, and it is the whole reason this section exists.
  const TUNNEL_HOST = "some-quick-tunnel.trycloudflare.com";
  const tunnelled = await req("/", { headers: { Host: TUNNEL_HOST } });
  ok("--lan: a tunnel-shaped request to / gets no viewer page",
     !/CAST_DIRECT/.test(tunnelled.body) && /cast bridge up/.test(tunnelled.body),
     "body=" + JSON.stringify(tunnelled.body.slice(0, 40)));
  const tunnelledJs = await req("/novnc.js", { headers: { Host: TUNNEL_HOST } });
  ok("--lan: a tunnel-shaped request to /novnc.js gets no bundle either",
     !/noVNC/.test(tunnelledJs.body));

  // The address the host bound the page to and printed. Absent on a machine with
  // no route out, and then --lan deliberately serves nothing.
  const lanIp = (out.match(/On this network\s+http:\/\/(\d+\.\d+\.\d+\.\d+):/) || [])[1] || "";

  let key = "";
  if (!lanIp) {
    ok("--lan: with no LAN address the host says so and serves no page",
       /no local network address found/.test(out) && !/CAST_DIRECT/.test(tunnelled.body));
    console.log("SKIP  no LAN address on this machine, so the page listener, the key it " +
                "serves, and the socket tests that need that key are NOT VERIFIED here");
  } else {
    // A loopback peer claiming the LAN address in Host: the shape a proxy would
    // send if it rewrote the header. The listener split refuses this one, not the
    // header check - which is the point of having the split.
    const spoofed = await req("/", { headers: { Host: lanIp + ":" + PORT } });
    ok("--lan: a loopback peer claiming the LAN Host still gets no page",
       !/CAST_DIRECT/.test(spoofed.body));

    const lanRoot = await req("/", { host: lanIp, headers: { Host: lanIp + ":" + PORT } });
    ok("--lan: a genuine LAN request gets the page with the session key inlined",
       lanRoot.status === 200 && /CAST_DIRECT/.test(lanRoot.body));
    const lanJs = await req("/novnc.js", { host: lanIp, headers: { Host: lanIp + ":" + PORT } });
    ok("--lan: /novnc.js is served on the LAN listener so the page can start",
       lanJs.status === 200 && lanJs.body.length > 10000);

    // Same socket, a proxied Host. This is the second lock: --url lets someone
    // front this host with a reverse proxy of their own aimed at the LAN address.
    const proxied = await req("/", { host: lanIp, headers: { Host: TUNNEL_HOST } });
    ok("--lan: a proxied Host on the LAN listener gets no page",
       !/CAST_DIRECT/.test(proxied.body));

    key = (lanRoot.body.match(/CAST_DIRECT="([\w-]+)"/) || [])[1] || "";
    ok("--lan: the page carries a usable session key", key.length > 0);
  }

  if (key) {
    // The correct key must still work, all the way through to the VNC server.
    const good = await new Promise((resolve) => {
      const sock = net.connect(PORT, "127.0.0.1", () => {
        sock.write("GET /ws?k=" + key + " HTTP/1.1\r\nHost: x\r\n" +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: " + WSKEY + "\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Protocol: binary\r\n\r\n");
      });
      let b = Buffer.alloc(0);
      sock.on("data", (c) => {
        b = Buffer.concat([b, c]);
        // 101 headers, then an unmasked server frame carrying the RFB greeting.
        if (b.includes("RFB 003.008")) { sock.destroy(); resolve(b.toString("latin1")); }
      });
      sock.on("error", () => resolve(b.toString("latin1")));
      setTimeout(() => { sock.destroy(); resolve(b.toString("latin1")); }, 3000);
    });
    ok("correct key upgrades and reaches VNC",
       /^HTTP\/1\.1 101/.test(good) && good.includes("RFB 003.008"), good.split("\r\n")[0]);
    ok("binary subprotocol is echoed back", /Sec-WebSocket-Protocol: binary/i.test(good));

    // A viewer that sends a bare FIN - no close frame - must still take its VNC
    // connection down with it, or TightVNC keeps encoding for a dead socket.
    const before = vncClosed.length;
    await new Promise((resolve) => {
      const sock = net.connect(PORT, "127.0.0.1", () => {
        sock.write("GET /ws?k=" + key + " HTTP/1.1\r\nHost: x\r\n" +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: " + WSKEY + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
      });
      sock.on("data", (c) => { if (String(c).includes("RFB")) sock.end(); });   // half-close only
      sock.on("close", resolve);
      sock.on("error", resolve);
      setTimeout(resolve, 3000);
    });
    const released = await Promise.race([
      (vncClosed[before] || Promise.resolve(false)).then(() => true),
      new Promise((r) => setTimeout(() => r(false), 3000)),
    ]);
    ok("a half-closed viewer socket releases its VNC connection", released);

    // A VNC reset races its final data/error/close events against any viewer
    // writes. Every path must converge on one shutdown without killing the host.
    const resetClosed = await new Promise((resolve) => {
      const sock = net.connect(PORT, "127.0.0.1", () => {
        sock.write("GET /ws?k=" + key + " HTTP/1.1\r\nHost: x\r\n" +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: " + WSKEY + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
      });
      let sent = false;
      sock.on("data", (c) => {
        if (sent || !String(c).includes("RFB")) return;
        sent = true;
        const mask = Buffer.from([1, 2, 3, 4]);
        const payload = Buffer.from("DROP");
        const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
        sock.write(Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, body]));
      });
      sock.on("close", () => resolve(true));
      sock.on("error", () => resolve(true));
      setTimeout(() => { sock.destroy(); resolve(false); }, 3000);
    });
    ok("a VNC-side reset closes only that viewer", resetClosed);
    const afterReset = await req("/");
    ok("the bridge survives a VNC-side reset", afterReset.status === 200);
  }

  proc.kill();
  await new Promise((r) => proc.on("exit", r));
}

/* ---- 3. A crashed tunnel is replaced and its new URL is published -------- */
{
  const TUNNEL_PORT = 60812;
  const state = path.join(os.tmpdir(), "instellar-fake-tunnel-" + process.pid + ".txt");
  try { fs.rmSync(state); } catch (_) {}
  const published = [];
  const registry = http.createServer((req, res) => {
    if (req.method === "DELETE") { res.end("{}"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { published.push(JSON.parse(body).url); } catch (_) {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => registry.listen(0, "127.0.0.1", r));

  const proc = spawn(process.execPath, [
    fileURLToPath(new URL("../cast-host.mjs", import.meta.url)),
    "--tunnel", "cloudflared", "--port", String(TUNNEL_PORT),
    "--site", "http://127.0.0.1:" + registry.address().port,
    "--vnc", "127.0.0.1:" + VNC_PORT, "--share", "nope",
  ], {
    cwd: REPO,
    windowsHide: true,
    env: {
      ...process.env,
      CAST_TUNNEL_BIN: fileURLToPath(new URL("./fake-tunnel.mjs", import.meta.url)),
      CAST_FAKE_TUNNEL_STATE: state,
    },
  });
  let out = "";
  proc.stdout.on("data", (c) => (out += c));
  proc.stderr.on("data", (c) => (out += c));

  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (published.some((u) => u.includes("cast-restart-2")) || proc.exitCode !== null) {
        clearInterval(poll);
        resolve();
      }
    }, 25);
    setTimeout(() => { clearInterval(poll); resolve(); }, 10000);
  });

  ok("a crashed tunnel is spawned again and publishes its replacement URL",
     published.length >= 2 && published[0].includes("cast-restart-1") &&
     published.some((u) => u.includes("cast-restart-2")), published.join(", "));
  ok("the host stays alive after publishing the replacement tunnel", proc.exitCode === null);
  ok("the recovery log says the watch link is unchanged",
     /watch link will not change/.test(out) && /watch link unchanged; nothing to do/.test(out));

  proc.kill();
  await Promise.race([
    new Promise((r) => proc.on("exit", r)),
    new Promise((r) => setTimeout(r, 1000)),
  ]);
  registry.close();
  try { fs.rmSync(state); } catch (_) {}
}

vnc.close();
console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

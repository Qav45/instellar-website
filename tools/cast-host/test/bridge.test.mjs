// Boots the real cast-host bridge against a stand-in VNC server and checks what
// it will and will not hand out. --tunnel none so nothing is published anywhere.
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
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
  sock.on("data", (d) => sock.write(d));
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

const req = (path) => new Promise((resolve) => {
  http.get({ host: "127.0.0.1", port: PORT, path }, (res) => {
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
  const { proc } = await boot([]);

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

  const notWs = await upgrade("/ws", { Upgrade: "h2c", Connection: "Upgrade" });
  ok("a non-WebSocket upgrade gets a plain answer, not a bare 403",
     /^HTTP\/1\.1 400/.test(notWs) && /cast bridge up/.test(notWs), notWs.split("\r\n")[0]);

  proc.kill();
  await new Promise((r) => proc.on("exit", r));
}

/* ---- 2. With --lan the page is served, because that is what --lan is for ---- */
{
  const { proc } = await boot(["--lan"]);
  const root = await req("/");
  ok("--lan: / serves the viewer page with the session key inlined",
     root.status === 200 && /CAST_DIRECT/.test(root.body));
  const js = await req("/novnc.js");
  ok("--lan: /novnc.js is served so the page can start", js.status === 200 && js.body.length > 10000);

  const key = (root.body.match(/CAST_DIRECT="([\w-]+)"/) || [])[1] || "";
  ok("--lan: the page carries a usable session key", key.length > 0);
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


  proc.kill();
  await new Promise((r) => proc.on("exit", r));
}

vnc.close();
console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

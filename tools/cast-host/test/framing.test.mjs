// The bridge speaks RFC 6455 by hand, so the framing is worth proving rather
// than reading. Pushes payloads past both length boundaries in both directions,
// split across TCP chunks that do not line up with frame edges, and checks the
// bytes that come out the far end - not just that nothing crashed.
//
// Also covers the two lifecycle properties a long cast depends on: a stalled
// viewer must stall the host rather than pile up in the bridge's memory, and an
// upgraded socket must outlive Node's own request timeouts.
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOST_SCRIPT = fileURLToPath(new URL("../cast-host.mjs", import.meta.url));
const REPO = path.dirname(HOST_SCRIPT);

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};

function boot(vncPort, port) {
  const proc = spawn(process.execPath, [
    HOST_SCRIPT, "--tunnel", "none", "--lan", "--port", String(port),
    "--vnc", "127.0.0.1:" + vncPort, "--share", "nope",
  ], { cwd: REPO, windowsHide: true });
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error("bridge did not start:\n" + out)), 15000);
    const scan = (c) => {
      out += String(c);
      if (/Leave this window open/.test(out)) { clearTimeout(t); resolve(proc); }
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    proc.on("exit", (code) => { clearTimeout(t); reject(new Error("exited " + code + ":\n" + out)); });
  });
}

// The session key is only in the page, and the page is only served under --lan.
const sessionKey = (port) => new Promise((resolve) => {
  http.get({ host: "127.0.0.1", port, path: "/" }, (r) => {
    let b = "";
    r.on("data", (c) => (b += c));
    r.on("end", () => resolve((b.match(/CAST_DIRECT="([\w-]+)"/) || [])[1] || ""));
  });
});

function upgrade(port, key) {
  const sock = net.connect(port, "127.0.0.1", () => {
    sock.write("GET /ws?k=" + key + " HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\nSec-WebSocket-Key: " +
      crypto.randomBytes(16).toString("base64") +
      "\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n\r\n");
  });
  return sock;
}

// A client frame: FIN set, masked, whichever length form the size calls for.
function clientFrame(op, payload) {
  const n = payload.length;
  const mask = crypto.randomBytes(4);
  let head;
  if (n < 126) {
    head = Buffer.allocUnsafe(2);
    head[1] = 0x80 | n;
  } else if (n < 65536) {
    head = Buffer.allocUnsafe(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.allocUnsafe(10);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  head[0] = 0x80 | op;
  const body = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/* ---- 1. Byte-exact in both directions, past both length boundaries -------- */
{
  const VNC_PORT = 59021, PORT = 60821;
  const UP = crypto.randomBytes(100000);     // needs the 64-bit length form
  const DOWN = crypto.randomBytes(300000);   // arrives as several frames
  const GREET = Buffer.from("RFB 003.008\n");

  let gotUp = Buffer.alloc(0);
  let upResolve;
  const upDone = new Promise((r) => (upResolve = r));

  const vnc = net.createServer((sock) => {
    sock.write(GREET);
    sock.on("data", (d) => {
      gotUp = Buffer.concat([gotUp, d]);
      if (gotUp.length >= UP.length + GREET.length) { upResolve(); sock.write(DOWN); }
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => vnc.listen(VNC_PORT, "127.0.0.1", r));

  const proc = await boot(VNC_PORT, PORT);
  const key = await sessionKey(PORT);
  const sock = upgrade(PORT, key);

  // Server frames must be unmasked with FIN set; anything else is a protocol
  // violation a browser would drop the connection over.
  let sawLen126 = false, sawLen127 = false, violation = "";
  const decode = (buf) => {
    const out = [];
    for (;;) {
      if (buf.length < 2) break;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2); off = 4; sawLen126 = true;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2)); off = 10; sawLen127 = true;
      }
      if (buf[1] & 0x80) violation = "server frame was masked";
      if (!(buf[0] & 0x80)) violation = "server frame had FIN clear";
      if (buf.length < off + len) break;
      out.push(buf.subarray(off, off + len));
      buf = buf.subarray(off + len);
    }
    return [out, buf];
  };

  let raw = Buffer.alloc(0), handshook = false, gotDown = Buffer.alloc(0);
  const downDone = new Promise((resolve) => {
    sock.on("data", (c) => {
      raw = Buffer.concat([raw, c]);
      if (!handshook) {
        const i = raw.indexOf("\r\n\r\n");
        if (i < 0) return;
        handshook = true;
        raw = raw.subarray(i + 4);
      }
      const [frames, rest] = decode(raw);
      raw = rest;
      for (const f of frames) gotDown = Buffer.concat([gotDown, f]);
      if (gotDown.length >= GREET.length + DOWN.length) resolve();
    });
  });

  await new Promise((r) => setTimeout(r, 800));
  // Ragged writes: the reader has to reassemble across chunk boundaries that
  // fall inside the header, inside the mask, and inside the payload.
  const framed = clientFrame(0x02, UP);
  for (let i = 0; i < framed.length; ) {
    const n = Math.min(1 + Math.floor(Math.random() * 1500), framed.length - i);
    sock.write(framed.subarray(i, i + n));
    i += n;
    await new Promise((r) => setImmediate(r));
  }
  sock.write(clientFrame(0x02, GREET));

  const die = (msg) => new Promise((_, x) => setTimeout(() => x(new Error(msg())), 20000));
  try {
    await Promise.race([upDone, die(() => "upload stalled at " + gotUp.length + "/" + UP.length)]);
    await Promise.race([downDone, die(() => "download stalled at " + gotDown.length)]);
  } catch (e) {
    ok("large payloads cross the bridge", false, e.message);
  }

  ok("100KB from the viewer reaches VNC byte-for-byte",
     gotUp.subarray(0, UP.length).equals(UP));
  ok("300KB from VNC reaches the viewer byte-for-byte",
     gotDown.subarray(GREET.length, GREET.length + DOWN.length).equals(DOWN));
  ok("the 16-bit length form was exercised", sawLen126);
  ok("the 64-bit length form was exercised", sawLen127);
  ok("no framing violations in anything the bridge sent", !violation, violation);

  sock.destroy();
  proc.kill();
  await new Promise((r) => proc.on("exit", r));
  vnc.close();
}

/* ---- 2. A viewer that stops reading must stall the host, not the heap ----- */
{
  const VNC_PORT = 59022, PORT = 60822;
  const CHUNK = Buffer.alloc(65536, 7);
  let written = 0, stop = false;

  const vnc = net.createServer((sock) => {
    sock.write("RFB 003.008\n");
    const pump = () => {
      while (!stop && written < 200 * 1024 * 1024) {
        written += CHUNK.length;
        if (!sock.write(CHUNK)) return;
      }
    };
    sock.on("drain", pump);
    sock.on("error", () => {});
    setTimeout(pump, 300);
  });
  await new Promise((r) => vnc.listen(VNC_PORT, "127.0.0.1", r));

  const proc = await boot(VNC_PORT, PORT);
  const key = await sessionKey(PORT);
  const sock = upgrade(PORT, key);
  sock.once("data", () => sock.pause());        // read the 101, then go quiet

  await new Promise((r) => setTimeout(r, 6000));
  stop = true;
  const mb = written / 1024 / 1024;
  // Socket buffers on both hops plus one chunk in flight is a few MB. Tens would
  // mean the bridge is absorbing an unread stream into its own memory.
  ok("a viewer that stops reading stalls the VNC side",
     mb < 16, mb.toFixed(1) + " MB accepted in 6s");

  sock.destroy();
  proc.kill();
  await new Promise((r) => proc.on("exit", r));
  vnc.close();
}

/* ---- 3. Node's request timeouts must not reach an upgraded socket -------- */
{
  // The bridge leaves headersTimeout and requestTimeout at their defaults, which
  // are 60s and 300s. If those applied after the upgrade, every cast would drop
  // on a timer. Same code path, shrunk so the test does not take five minutes.
  const srv = http.createServer((req, res) => res.end("x"));
  srv.requestTimeout = 1500;
  srv.headersTimeout = 1000;
  srv.on("upgrade", (req, sock) => {
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
               "Connection: Upgrade\r\n\r\n");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));

  const survived = await new Promise((resolve) => {
    const s = net.connect(srv.address().port, "127.0.0.1", () => {
      s.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
              "Sec-WebSocket-Key: abcdefghijklmnop\r\nSec-WebSocket-Version: 13\r\n\r\n");
    });
    let up = false;
    s.on("data", (c) => { if (String(c).includes("101")) up = true; });
    s.on("close", () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(up); }, 4000);
  });
  ok("an upgraded socket outlives the server's request timeout", survived);
  srv.close();
}

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

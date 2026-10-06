// Relative mouse for games. RFB carries absolute positions and nothing else, so
// a game that re-centres the cursor every frame (Unity, and most others) cannot
// be turned with it. This takes movement as movement - the page sends deltas on
// /mouse - and replays them through SendInput, the same call a real mouse's
// driver ends up in, so the game reads them as a real mouse.
//
// SendInput lives in user32 and Node has no way to call it, so a PowerShell
// process holds it: it compiles a few lines of C# once, then reads one command
// per line from stdin. No dependency is added; PowerShell ships with Windows.
//
// Wire format, one or more 5-byte records per WebSocket message:
//   u8 type, i16 a, i16 b  (big endian)
//   0 move    a = dx, b = dy
//   1 button  a = 0 left, 1 middle, 2 right, 3 back, 4 forward; b = 1 down, 0 up
//   2 wheel   a = vertical notches (positive away from the user), b = horizontal
//
// Nothing here reaches a command line: records are decoded to integers and only
// the integers are written to the helper's stdin.

import { spawn as nodeSpawn } from "node:child_process";

export const RECORD = 5;
const MOVE_MAX = 4000;       // a flick bigger than this in one event is not a mouse
const WHEEL_MAX = 20;
const STDIN_LIMIT = 64 * 1024;   // moves are dropped past this; a stale turn is worse than a lost one
const IDLE_MS = 10000;       // the helper outlives its last viewer this long

const CSHARP = `
using System;
using System.Runtime.InteropServices;
public static class M {
  [StructLayout(LayoutKind.Sequential)] struct MI { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct IN { public uint type; public MI mi; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, IN[] i, int size);
  static void Fire(int dx, int dy, uint data, uint flags) {
    var i = new IN[1];
    i[0].type = 0; i[0].mi.dx = dx; i[0].mi.dy = dy; i[0].mi.data = data; i[0].mi.flags = flags;
    SendInput(1, i, Marshal.SizeOf(typeof(IN)));
  }
  public static void Line(string s) {
    try {
      var p = s.Split(' ');
      switch (p[0]) {
        case "m": Fire(int.Parse(p[1]), int.Parse(p[2]), 0, 0x1); break;
        case "d": case "u": {
          int b = int.Parse(p[1]); bool down = p[0] == "d";
          uint f, data = 0;
          if (b == 0) f = down ? 0x2u : 0x4u;
          else if (b == 1) f = down ? 0x20u : 0x40u;
          else if (b == 2) f = down ? 0x8u : 0x10u;
          else { f = down ? 0x80u : 0x100u; data = b == 3 ? 1u : 2u; }
          Fire(0, 0, data, f); break;
        }
        case "w": Fire(0, 0, unchecked((uint)int.Parse(p[1])), 0x800); break;
        case "h": Fire(0, 0, unchecked((uint)int.Parse(p[1])), 0x1000); break;
      }
    } catch (Exception) { }
  }
}`;

const SCRIPT = "$ErrorActionPreference = 'Stop'\n" +
  "Add-Type -TypeDefinition @'\n" + CSHARP + "\n'@\n" +
  "[Console]::Out.WriteLine('ready')\n" +
  "while ($null -ne ($l = [Console]::In.ReadLine())) { [M]::Line($l) }\n";

// -EncodedCommand takes UTF-16LE base64, which is what keeps the script's own
// quotes away from every shell between here and PowerShell.
export const helperArgs = () => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")];

const clamp = (n, m) => Math.max(-m, Math.min(m, n));

// Records in, helper lines out. Anything malformed is skipped, not guessed at.
export function decode(buf) {
  const out = [];
  for (let o = 0; o + RECORD <= buf.length; o += RECORD) {
    const type = buf[o], a = buf.readInt16BE(o + 1), b = buf.readInt16BE(o + 3);
    if (type === 0) {
      const dx = clamp(a, MOVE_MAX), dy = clamp(b, MOVE_MAX);
      if (dx || dy) out.push({ kind: "move", line: "m " + dx + " " + dy });
    } else if (type === 1 && a >= 0 && a <= 4) {
      out.push({ kind: "button", button: a, down: b === 1, line: (b === 1 ? "d " : "u ") + a });
    } else if (type === 2) {
      const v = clamp(a, WHEEL_MAX), h = clamp(b, WHEEL_MAX);
      if (v) out.push({ kind: "wheel", line: "w " + v * 120 });
      if (h) out.push({ kind: "wheel", line: "h " + h * 120 });
    }
  }
  return out;
}

export function createMouse({ spawn = nodeSpawn, platform = process.platform, log = () => {} } = {}) {
  const available = platform === "win32";
  let child = null, ready = false, idle = null;
  const sessions = new Set();
  const held = new Set();      // buttons the helper has been told are down

  function write(line) {
    if (child && child.stdin.writable) child.stdin.write(line + "\n");
  }

  function start() {
    ready = false;
    const c = spawn("powershell.exe", helperArgs(), { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    child = c;
    c.stdin.on("error", () => {});
    c.stdout.on("data", (d) => {
      if (c !== child || ready || !String(d).includes("ready")) return;
      ready = true;
      for (const s of sessions) s.onReady();
    });
    const gone = () => {
      if (c !== child) return;
      child = null; ready = false; held.clear();
      log("mouse helper stopped");
      for (const s of [...sessions]) s.onFail();
    };
    c.on("error", gone);
    c.on("exit", gone);
  }

  function stop() {
    const c = child;
    child = null; ready = false;
    if (c) { try { c.stdin.end(); } catch (_) {} try { c.kill(); } catch (_) {} }
  }

  function releaseAll() {
    for (const b of held) write("u " + b);
    held.clear();
  }

  // One per /mouse socket. onReady fires when the helper can take input (at
  // once if it already could); onFail when it dies and there is nothing to
  // send to any more.
  function attach(onReady, onFail) {
    if (!available) return null;
    clearTimeout(idle);
    const s = { onReady, onFail };
    sessions.add(s);
    if (!child) start();
    else if (ready) queueMicrotask(() => sessions.has(s) && onReady());
    return {
      send(buf) {
        if (!ready || !child) return;
        for (const r of decode(buf)) {
          if (r.kind === "move" && child.stdin.writableLength > STDIN_LIMIT) continue;
          if (r.kind === "button") { if (r.down) held.add(r.button); else held.delete(r.button); }
          write(r.line);
        }
      },
      close() {
        if (!sessions.delete(s)) return;
        // A viewer that vanishes with a button down must not leave it down on a
        // machine nobody is looking at.
        if (!sessions.size) {
          releaseAll();
          idle = setTimeout(() => { if (!sessions.size) stop(); }, IDLE_MS);
          if (idle.unref) idle.unref();
        }
      },
    };
  }

  return { available, attach, stop };
}

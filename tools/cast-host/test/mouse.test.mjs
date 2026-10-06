// The relative-mouse helper: the wire format, what reaches the PowerShell
// helper's stdin, and that a viewer who vanishes with a button down lets it go.
// The helper itself is a fake - SendInput is not something a test can watch.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { decode, createMouse, helperArgs, RECORD } from "../mouse.mjs";

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};

const rec = (type, a, b) => { const r = Buffer.alloc(RECORD); r[0] = type; r.writeInt16BE(a, 1); r.writeInt16BE(b, 3); return r; };
const lines = (buf) => decode(buf).map((r) => r.line);

ok("a move becomes one helper line", lines(rec(0, 12, -7)).join() === "m 12 -7");
ok("a zero move is nothing", lines(rec(0, 0, 0)).length === 0);
ok("a huge move is clamped", lines(rec(0, 32000, -32000)).join() === "m 4000 -4000");
ok("button down and up", lines(Buffer.concat([rec(1, 2, 1), rec(1, 2, 0)])).join() === "d 2,u 2");
ok("a button that does not exist is dropped", lines(rec(1, 9, 1)).length === 0 && lines(rec(1, -1, 1)).length === 0);
ok("wheel is scaled to notches of 120 and clamped",
   lines(rec(2, 3, -2)).join() === "w 360,h -240" && lines(rec(2, 500, 0)).join() === "w 2400");
ok("an unknown type is dropped", lines(rec(7, 1, 1)).length === 0);
ok("a half record is ignored", lines(rec(0, 5, 5).subarray(0, 4)).length === 0);
ok("several records in one message are all read", lines(Buffer.concat([rec(0, 1, 1), rec(0, 2, 2)])).length === 2);
ok("the helper script travels encoded, never as a shell string",
   helperArgs().includes("-EncodedCommand") && !helperArgs().join(" ").includes("SendInput"));

function fake() {
  const spawned = [];
  const spawn = () => {
    const c = new EventEmitter();
    c.stdin = new PassThrough(); c.stdout = new PassThrough();
    c.written = [];
    c.stdin.on("data", (d) => c.written.push(...String(d).split("\n").filter(Boolean)));
    c.kill = () => { c.killed = true; c.emit("exit", 0); };
    spawned.push(c);
    return c;
  };
  return { spawn, spawned };
}
const tick = () => new Promise((r) => setTimeout(r, 15));

{
  const f = fake();
  const m = createMouse({ spawn: f.spawn, platform: "linux" });
  ok("off Windows there is no route", !m.available && m.attach(() => {}, () => {}) === null && f.spawned.length === 0);
}
{
  const f = fake();
  const m = createMouse({ spawn: f.spawn, platform: "win32" });
  let ready = 0, failedCount = 0;
  const s = m.attach(() => ready++, () => failedCount++);
  await tick();
  const c = f.spawned[0];
  s.send(rec(0, 5, 5));
  await tick();
  ok("nothing is sent before the helper says ready", c.written.length === 0 && ready === 0);
  c.stdout.write("ready\n");
  await tick();
  ok("the viewer is told when it is ready", ready === 1);
  s.send(Buffer.concat([rec(0, 3, 4), rec(1, 0, 1)]));
  await tick();
  ok("after ready, lines reach the helper", c.written.join() === "m 3 4,d 0", c.written.join());
  s.close();
  await tick();
  ok("a button left down is released when the viewer goes", c.written.at(-1) === "u 0", c.written.join());
  ok("the helper is kept warm a moment, not killed at once", !c.killed);
  const s2 = m.attach(() => ready++, () => {});
  await tick();
  ok("a returning viewer reuses the helper and is told it is ready", f.spawned.length === 1 && ready === 2);
  s2.close();
  m.stop();
}
{
  const f = fake();
  const m = createMouse({ spawn: f.spawn, platform: "win32" });
  let failedCount = 0;
  m.attach(() => {}, () => failedCount++);
  f.spawned[0].emit("exit", 1);
  await tick();
  ok("a helper that dies tells its viewers", failedCount === 1);
  m.stop();
}
process.exit(failed ? 1 : 0);

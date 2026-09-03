// cast/novnc.js is vendored, with one local change: JPEG and PNG rects decode
// through createImageBitmap instead of a base64 data: URL. That change sits in
// the render queue, where a mistake does not throw - it freezes the picture and
// leaves everything else working, which is the hardest kind of bug to attribute.
//
// So: pull the real display.js out of the bundle, stub a canvas around it, and
// push rects through. No browser needed, and it fails loudly if a re-bundle drops
// the local change.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const BUNDLE = fileURLToPath(new URL("../../../cast/novnc.js", import.meta.url));

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};

const src = fs.readFileSync(BUNDLE, "utf8");
const start = src.indexOf('__m["display.js"] = function');
if (start < 0) {
  console.log("FAIL could not find display.js in the bundle");
  process.exit(1);
}
const next = src.indexOf('\n__m[', start + 1);
const slice = src.slice(start, next < 0 ? undefined : next);

ok("the bundle still carries the local bitmap change",
   /createImageBitmap/.test(slice) && /'type': 'bitmap'/.test(slice));

/* ------------------------------------------------------------- harness -- */

const drawn = [];
const closed = [];
const ctx = new Proxy({}, {
  get: (_, k) => {
    if (k === "canvas") return { width: 100, height: 100 };
    return (...a) => {
      if (k === "drawImage") drawn.push(a[0].tag);
      return { data: new Uint8ClampedArray(4) };
    };
  },
});
const canvas = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx });

const sandbox = {
  console, Promise, setTimeout, queueMicrotask,
  Uint8Array, Uint8ClampedArray,
  ImageData: class {},
  Image: class {},
  Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
  document: { createElement: () => canvas() },
  window: {},
  navigator: { userAgent: "node-test" },
  __m: {},
};
sandbox.globalThis = sandbox;

// The first byte of the rect picks the outcome: 99 fails to decode, 98 decodes
// at the wrong size, anything else decodes cleanly.
sandbox.createImageBitmap = (blob) => {
  const tag = blob.parts[0][0];
  if (tag === 99) return Promise.reject(new Error("corrupt jpeg"));
  const wrong = tag === 98;
  return Promise.resolve({
    tag,
    width: wrong ? 7 : 10,
    height: wrong ? 7 : 10,
    close() { closed.push(tag); },
  });
};

vm.createContext(sandbox);
vm.runInContext(slice, sandbox);

const stubs = {
  "util/logging.js": { __esModule: true, Error: () => {}, Warn: () => {}, Debug: () => {}, Info: () => {} },
  "base64.js": { __esModule: true, default: { encode: () => "" } },
  "util/int.js": { toUnsigned32bit: (x) => x >>> 0, toSigned32bit: (x) => x | 0 },
};
const mod = { exports: {} };
sandbox.__m["display.js"](mod, mod.exports, (id) => stubs[id]);

const display = new mod.exports.default(canvas());
display.resize(100, 100);
drawn.length = 0;                       // resize blits the old canvas; not a rect

const rect = (tag) => display.imageRect(0, 0, 10, 10, "image/jpeg", Uint8Array.from([tag]));
rect(1);
rect(99);        // never decodes
rect(2);
rect(98);        // decodes at the wrong size
rect(3);

await new Promise((r) => setTimeout(r, 200));

ok("good rects paint in the order they arrived",
   JSON.stringify(drawn) === "[1,2,3]", JSON.stringify(drawn));
// Both of these wedge the queue upstream, which stops the picture updating for
// the rest of the session while the connection stays up and input keeps working.
ok("a rect that fails to decode does not wedge the queue", drawn.includes(3));
ok("a wrong-sized rect is dropped rather than freezing the queue", !drawn.includes(98));
ok("the queue drains completely", display._renderQ.length === 0,
   "left " + display._renderQ.length);
// A bitmap holds GPU memory until it is closed, and a cast runs for hours.
ok("every decoded bitmap is closed", closed.slice().sort().join() === "1,2,3,98", closed.join());

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

// Pasting into the cast is an ordering problem wearing a feature's clothes: the
// text has to be on the host's clipboard before the host sees Ctrl+V, and if the
// two ever swap places the paste still happens - it just pastes whatever was
// there before. That is a bug you cannot see in a diff and can barely see in
// use, so the order is pinned here.
//
// The handlers live inline in cast/index.html. Rather than restructure the page
// for a test, slice that section out and run it in a vm with a stub document,
// the same trick render.test.mjs uses on the noVNC bundle.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(new URL("../../../cast/index.html", import.meta.url));

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};

const src = fs.readFileSync(PAGE, "utf8");
const start = src.indexOf("/* ------------------------------------------------------------ clipboard -- */");
const end = src.indexOf('window.addEventListener("focus", refocus);');
ok("the clipboard section is still in the page", start > 0 && end > start);
if (failed) process.exit(1);
const slice = src.slice(start, end);

/* ------------------------------------------------------------- harness -- */

// Every listener the slice registers, by type. Capture and bubble both land
// here; the slice only ever uses one phase per type.
const listeners = {};
const timers = [];
const sent = [];          // what reached the remote machine, in order

let veil = null;          // a card on screen, i.e. somewhere else to type
let rfb = null;

const rfbStub = {
  clipboardPasteFrom: (t) => sent.push("text:" + t),
  sendKey: (keysym, code, down) => {
    if (down === undefined) { rfbStub.sendKey(keysym, code, true); rfbStub.sendKey(keysym, code, false); return; }
    sent.push("key:" + keysym + (down ? "+" : "-"));
  },
};

const sandbox = {
  console,
  performance: { now: () => 0 },
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  document: {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  },
  $: (id) => (id === "veil" ? veil : null),
  get rfb() { return rfb; },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(slice, sandbox, { filename: "cast/index.html" });

const fire = (type, event) => {
  for (const fn of listeners[type] || []) fn(event);
};
const runTimers = () => {
  const due = timers.splice(0);
  for (const t of due) t.fn();
  return due;
};

const keyEvent = (over) => {
  const e = { key: "v", ctrlKey: true, stopped: false, prevented: false,
              stopImmediatePropagation() { e.stopped = true; },
              preventDefault() { e.prevented = true; }, ...over };
  return e;
};
const pasteEvent = (text) => {
  const e = { clipboardData: { getData: () => text }, prevented: false,
              preventDefault() { e.prevented = true; } };
  return e;
};

/* --------------------------------------------------------------- tests -- */

ok("it listens for keydown, keyup and paste",
   !!listeners.keydown && !!listeners.keyup && !!listeners.paste);

// noVNC's own handler sits on the canvas, below document. If Ctrl+V is allowed
// through, the host is asked to paste before the text has left this machine.
rfb = rfbStub;
let e = keyEvent();
fire("keydown", e);
ok("Ctrl+V is kept away from the remote session", e.stopped);
// ...but the browser still has to do its normal job, or it never fires `paste`
// and the text has to be asked for with a permission prompt instead.
ok("Ctrl+V keeps its default, so the paste event still fires", !e.prevented);

e = keyEvent({ ctrlKey: false, shiftKey: true, key: "Insert" });
fire("keydown", e);
ok("Shift+Insert is treated as a paste too", e.stopped);

e = keyEvent({ ctrlKey: false });
fire("keydown", e);
ok("an ordinary v is left alone", !e.stopped);

e = keyEvent({ ctrlKey: true, altKey: true });
fire("keydown", e);
ok("Ctrl+Alt+V is left alone", !e.stopped);

sent.length = 0;
const p = pasteEvent("hello there");
fire("paste", p);
ok("the text is sent as soon as it is pasted", sent.join(",") === "text:hello there",
   sent.join(","));
ok("the keystroke is held back, not sent with it", timers.length === 1);
ok("the browser is stopped from pasting into the page as well", p.prevented);

runTimers();
ok("the keystroke follows the text, never the other way round",
   sent.join(",") === "text:hello there,key:65507+,key:118+,key:118-,key:65507-",
   sent.join(","));

// Both directions of the Ctrl are synthesised on purpose: by the time this
// fires the viewer may have let go, and a lone v would be typed into whatever
// they had open.
ok("the paste is a whole Ctrl+V, not a bare v",
   sent[1] === "key:65507+" && sent[sent.length - 1] === "key:65507-");

// A password card is up: that paste belongs in the field, and a keystroke sent
// to the host would be typed into someone's desktop instead.
sent.length = 0;
veil = {};
e = keyEvent();
fire("keydown", e);
fire("paste", pasteEvent("secret"));
runTimers();
ok("nothing is sent while a card is on screen", sent.length === 0 && !e.stopped,
   sent.join(","));
veil = null;

// The session can end between the paste and the delayed keystroke.
sent.length = 0;
fire("paste", pasteEvent("x"));
rfb = null;
runTimers();
ok("a session that ends in between is not typed into",
   sent.join(",") === "text:x", sent.join(","));

rfb = rfbStub;
sent.length = 0;
fire("paste", pasteEvent(""));
ok("an empty clipboard sends nothing", sent.length === 0 && timers.length === 0);

console.log(failed ? "\n" + failed + " failed" : "\nall passed");
process.exit(failed ? 1 : 0);

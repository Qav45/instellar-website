// The calculator standing in front of /cast is only a door as far as one string
// is concerned; the rest of it has to be a calculator, because a prop whose keys
// do not add up is one anybody spots. Its evaluator is pure, so - as with the
// other page logic tested here - the source is cut out of cast/index.html and
// run under node rather than restructuring the page to export it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(new URL("../../../cast/index.html", import.meta.url));
const src = fs.readFileSync(PAGE, "utf8");

function slice(from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error("cast/index.html no longer contains: " + from);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error("cast/index.html no longer contains: " + to);
  return src.slice(a, b);
}

const sandbox = { calcToks: [] };
vm.createContext(sandbox);
vm.runInContext(
  slice("const CALC_FN = {", "function calcShow()") +
  "\nthis.calcEval = calcEval; this.calcFmt = calcFmt; this.calcSolve = calcSolve;" +
  "\nthis.setDeg = (v) => { calcDeg = v; }; this.setToks = (t) => { calcToks = t; };" +
  "\nthis.ENTRY_KEYS = CALC_KEYS;",
  sandbox, { filename: "cast/index.html" });

const { calcEval, calcFmt, calcSolve, setDeg, setToks } = sandbox;
const ev = (s) => calcFmt(calcEval(s));

test("arithmetic and precedence", () => {
  assert.equal(ev("2+3"), "5");
  assert.equal(ev("2+3×4"), "14", "times binds tighter than plus");
  assert.equal(ev("(2+3)×4"), "20");
  assert.equal(ev("10÷4"), "2.5");
  assert.equal(ev("7−3−2"), "2", "minus is left associative");
});

test("unary minus and powers", () => {
  assert.equal(ev("−5+8"), "3");
  assert.equal(ev("2^3"), "8");
  assert.equal(ev("2^3^2"), "512", "powers are right associative");
  assert.equal(ev("3²"), "9", "the x-squared key");
});

test("postfix keys", () => {
  assert.equal(ev("5!"), "120");
  assert.equal(ev("50%"), "0.5");
});

test("functions, in degrees and in radians", () => {
  setDeg(true);
  assert.equal(ev("sin(30)"), "0.5");
  assert.equal(ev("cos(60)"), "0.5");
  setDeg(false);
  assert.equal(ev("sin(0)"), "0");
  setDeg(true);
  assert.equal(ev("√(16)"), "4");
  assert.equal(ev("ln(e)"), "1");
  assert.equal(ev("log(1000)"), "3");
  assert.equal(ev("abs(−7)"), "7");
  assert.equal(ev("π").slice(0, 7), "3.14159");
});

test("what it refuses rather than answers", () => {
  assert.equal(ev("1÷0"), "Error", "divide by zero");
  assert.throws(() => calcEval("2+"), "a dangling operator is not an answer");
  assert.throws(() => calcEval("(2+3"), "an unclosed bracket is not an answer");
});

test("= closes the brackets a function key opened", () => {
  setToks(["√(", "9"]);
  assert.equal(calcSolve(), "3");
  setToks(["2", "+"]);
  assert.equal(calcSolve(), "Error", "but it does not invent a missing operand");
});

test("it prints no digit a double cannot back up", () => {
  assert.equal(ev("0.1+0.2"), "0.3", "float noise is rounded away");
  assert.equal(ev("1÷3").slice(0, 8), "0.333333");
});

// The door itself: the page compares the typed expression against ENTRY, so what
// matters here is that the digit keys write exactly the characters that string is
// made of. A digit key that wrote a prettified glyph would make the code untypeable.
test("the digit keys write plain digits", () => {
  for (const d of "0123456789") assert.ok(!(d in sandbox.ENTRY_KEYS), d + " is passed through as itself");
});

/* ---- the cover, and the two ways past it ---- */

// The graph door and the hash are page logic, not arithmetic, so they need a
// document to run against. These build the smallest one that answers the calls
// the page actually makes - getElementById, add/removeEventListener, hidden,
// remove - and cut the two blocks out of the page the same way the evaluator
// above is cut out, rather than restructuring the page to export them.
function fakeDom(ids) {
  const els = {};
  for (const id of ids) {
    els[id] = {
      id, hidden: false, on: {}, removed: false,
      addEventListener(t, f) { (this.on[t] = this.on[t] || []).push(f); },
      removeEventListener(t, f) {
        const a = this.on[t] || [], i = a.indexOf(f);
        if (i >= 0) a.splice(i, 1);
      },
      remove() { this.removed = true; },
    };
  }
  return els;
}

// The block that decides what the hash means, plus the boot block that decides
// what gets saved out of it, run with a location and a sessionStorage of our
// choosing. The two belong in one rig: which key this load uses and which key
// the next load will find are separate decisions, and the cases worth testing
// are the ones where they disagree.
function bootHash(hash, stored) {
  const replaced = [];
  const box = {
    location: { hash, pathname: "/cast", search: "" },
    history: { replaceState: (_s, _t, url) => { replaced.push(url); } },
    sessionStorage: {
      getItem: (k) => (k in stored ? stored[k] : null),
      setItem: (k, v) => { stored[k] = v; },
      removeItem: (k) => { delete stored[k]; },
    },
  };
  vm.createContext(box);
  vm.runInContext(
    slice("function hashToken() {", "// Served by the bridge itself") +
    slice("// Keep the key out of the address bar", '$("gateGo")') +
    "\nthis.out = { hash, SKIP_COVER, token, ENTRY };",
    box, { filename: "cast/index.html" });
  return { ...box.out, stored, replaced };
}

// The first two of these used to assert the opposite: that the entry code was a
// door only, and must never be read as an access key. That reading broke the one
// watch link it was meant to protect - the key on this host is 1234, so #1234 is
// the key - and it has been deliberately reversed. The hash is the access key
// again and SKIP_COVER governs the cover alone, so the assertions say that now.
test("#1234 is the access key and the cover skip at once", () => {
  const r = bootHash("#1234", {});
  assert.equal(r.ENTRY, "1234");
  assert.equal(r.SKIP_COVER, true, "the cover comes down");
  assert.equal(r.token, "1234", "and the same four digits go to the host as the key");
  assert.equal(r.stored.castToken, "1234", "saved, so a reload is not sent back to the card");
  assert.deepEqual(r.replaced, ["/cast"], "and the hash leaves the address bar");
});

test("#1234 does not write itself over a saved key that is not 1234", () => {
  const r = bootHash("#1234", { castToken: "a-real-key" });
  assert.equal(r.SKIP_COVER, true);
  assert.equal(r.token, "1234", "the hash wins this load, and the host will refuse it");
  assert.equal(r.stored.castToken, "a-real-key", "but the good saved key survives the visit");
});

test("a real access key in the hash still works as before", () => {
  const r = bootHash("#s3cret", {});
  assert.equal(r.SKIP_COVER, false, "a key that is not the code leaves the cover standing");
  assert.equal(r.token, "s3cret");
  assert.equal(bootHash("#a%20b", {}).token, "a b", "still percent-decoded");
  assert.equal(bootHash("#50%", {}).token, "50%", "and a bad escape is still passed through");
  assert.equal(bootHash("", { castToken: "saved" }).token, "saved", "no hash, saved key");
  assert.equal(bootHash("#12345", {}).token, "12345", "only the exact code is the cover code");
  assert.equal(bootHash("#12345", {}).SKIP_COVER, false, "and it leaves the cover up");
  assert.equal(bootHash("#1234 ", {}).SKIP_COVER, false, "and it is exact, not trimmed");
  assert.equal(bootHash("#1234 ", {}).token, "1234 ", "though it is still read as a key");
});

test("a strong key in the hash saves over the one it replaces", () => {
  const r = bootHash("#Kq7m-2Xb9-ZZ", { castToken: "1234" });
  assert.equal(r.SKIP_COVER, false, "the cover is up: only 1234 itself takes it down");
  assert.equal(r.token, "Kq7m-2Xb9-ZZ");
  assert.equal(r.stored.castToken, "Kq7m-2Xb9-ZZ", "a rotated key does replace the old one");
});

test("no hash saves nothing and leaves the address bar alone", () => {
  const r = bootHash("", { castToken: "a-real-key" });
  assert.equal(r.token, "a-real-key");
  assert.deepEqual(r.replaced, [], "there is nothing to strip");
  assert.equal(r.SKIP_COVER, false, "and the cover is up, as on any ordinary load");
});

// Everything the graph half of the cover touches. Returns the handles a test
// needs to drive it: the script tag it appended, the timer it armed, and
// whether the door was opened.
function coverRig(opts = {}) {
  const els = fakeDom(["lock", "graph", "graphBox", "calc", "graphWait"]);
  els.calc.hidden = true;
  const rig = { els, entered: 0, scripts: [], timers: [], docOn: [] };
  const calcKey = () => {};
  const box = {
    ENTRY: "1234",
    calcKey,
    $: (id) => els[id] || null,
    enter: () => { rig.entered++; },
    window: { Desmos: opts.desmos },
    document: {
      head: { appendChild: (s) => rig.scripts.push(s) },
      createElement: () => ({}),
      addEventListener: (t, f) => rig.docOn.push(f),
      removeEventListener: (t, f) => {
        const i = rig.docOn.indexOf(f);
        if (i >= 0) rig.docOn.splice(i, 1);
      },
    },
    setTimeout: (f, ms) => { rig.timers.push({ f, ms, live: true }); return rig.timers.length; },
    clearTimeout: (h) => { if (rig.timers[h - 1]) rig.timers[h - 1].live = false; },
  };
  vm.createContext(box);
  vm.runInContext(
    slice("const DESMOS_SRC =", "// Past the calculator is where") +
    "\nthis.loadDesmos = loadDesmos; this.showKeypad = showKeypad;" +
    "\nthis.src = DESMOS_SRC; this.waitMs = DESMOS_WAIT_MS;",
    box, { filename: "cast/index.html" });
  rig.api = box;
  rig.docOn.push(calcKey);        // as the page arms it, before the script lands
  return rig;
}

// Mount the calculator the way a successful load would, with an expression list
// the test chooses, and hand back the keydown handler the page put on the box.
function mounted(rows) {
  const rig = coverRig({
    desmos: { GraphingCalculator: () => ({ getExpressions: () => rows, destroy() {} }) },
  });
  rig.api.loadDesmos();
  rig.scripts[0].onload();
  rig.key = rig.els.graphBox.on.keydown[0];
  return rig;
}

const ENTER = () => ({ key: "Enter", preventDefault() {}, stopPropagation() {} });

test("the door opens on the code typed on its own and nothing else", () => {
  const rig = mounted([{ latex: "1234" }]);
  rig.key(ENTER());
  assert.equal(rig.entered, 1);
});

test("a trailing empty row is still the code typed on its own", () => {
  // Desmos keeps a blank expression under the last one; that is not a second
  // thing on the screen and must not shut the door.
  const rig = mounted([{ latex: "1234" }, { latex: "" }]);
  rig.key(ENTER());
  assert.equal(rig.entered, 1);
});

test("a sum that merely lands on 1234 is an answer, not the code", () => {
  for (const rows of [
    [{ latex: "617\\cdot 2" }],
    [{ latex: "1233+1" }],
    [{ latex: "y=1234x" }],
    [{ latex: "1234" }, { latex: "y=x" }],
    [{ latex: "12345" }],
    [{ latex: " " }],
    [],
  ]) {
    const rig = mounted(rows);
    rig.key(ENTER());
    assert.equal(rig.entered, 0, JSON.stringify(rows) + " is not the way through");
  }
});

test("only Enter is the = key, and a calculator that cannot answer keeps the door shut", () => {
  const rig = mounted([{ latex: "1234" }]);
  rig.key({ key: "a", preventDefault() {}, stopPropagation() {} });
  assert.equal(rig.entered, 0, "any other key is the graph's business");
  const broken = coverRig({
    desmos: { GraphingCalculator: () => ({ getExpressions() { throw new Error("gone"); }, destroy() {} }) },
  });
  broken.api.loadDesmos();
  broken.scripts[0].onload();
  broken.els.graphBox.on.keydown[0](ENTER());
  assert.equal(broken.entered, 0);
});

test("a mounted graph takes the typed-key door off the document", () => {
  const rig = mounted([{ latex: "1234" }]);
  assert.equal(rig.docOn.length, 0, "or it would eat every digit meant for the graph");
  assert.equal(rig.els.graphWait.removed, true, "and the Loading line goes");
  assert.equal(rig.timers[0].live, false, "and the watchdog is disarmed");
});

test("the script is pinned, not floating", () => {
  const rig = coverRig();
  assert.match(rig.api.src, /^https:\/\/www\.desmos\.com\/api\/v\d+\.\d+\.\d+\/calculator\.js\?apiKey=/,
    "a two-part version redirects to whatever the latest build is");
});

test("a Desmos that never arrives falls back to a keypad that still opens", () => {
  for (const fail of [
    (rig) => rig.scripts[0].onerror(),                     // blocked, offline, 404
    (rig) => rig.timers[0].f(),                            // too slow
    (rig) => rig.scripts[0].onload(),                      // loaded, left no Desmos
  ]) {
    const rig = coverRig();
    rig.api.loadDesmos();
    assert.equal(rig.els.calc.hidden, true, "the keypad starts behind the graph");
    fail(rig);
    assert.equal(rig.els.graph.hidden, true, "the graph card goes");
    assert.equal(rig.els.calc.hidden, false, "and the keypad that already works is the cover");
    assert.equal(rig.docOn.length, 1, "with its typed-key door still armed");
    assert.equal(rig.timers[0].live, false, "and nothing left ticking");
  }
});

test("a Desmos that loads but refuses the key falls back too", () => {
  const rig = coverRig({ desmos: { GraphingCalculator: () => { throw new Error("bad key"); } } });
  rig.api.loadDesmos();
  rig.scripts[0].onload();
  assert.equal(rig.els.calc.hidden, false);
  assert.equal(rig.docOn.length, 1, "the typed-key door was never taken away");
});

test("Basic swaps a working graph for the keypad by hand", () => {
  const rig = mounted([{ latex: "1234" }]);
  assert.equal(rig.docOn.length, 0);
  rig.api.showKeypad();
  assert.equal(rig.els.calc.hidden, false);
  assert.equal(rig.els.graph.hidden, true);
  assert.equal(rig.docOn.length, 1, "the typed-key door comes back with the keypad");
  assert.equal(rig.els.graphBox.on.keydown.length, 0, "and the graph door goes with the graph");
});

test("a graph that arrives after the watchdog gave up leaves the keypad alone", () => {
  const rig = coverRig({
    desmos: { GraphingCalculator: () => ({ getExpressions: () => [], destroy() {} }) },
  });
  rig.api.loadDesmos();
  rig.timers[0].f();
  rig.scripts[0].onload();
  assert.equal(rig.els.calc.hidden, false, "whoever is mid-sum keeps their calculator");
  assert.equal(rig.docOn.length, 1);
});

/* ---- the bundle is pinned, and what happens when the pin refuses it ---- */

// Four megabytes of somebody else's JavaScript run in the document that holds
// the access key and the screen password. integrity= is what says the four
// megabytes are the ones that were read; these say the tag actually carries it,
// that the URL it is a hash of cannot drift under it, and - the part that
// matters most - that a bundle the browser throws away still leaves a way in.
test("the Desmos tag is fetched against a hash, not on trust", () => {
  const rig = coverRig();
  rig.api.loadDesmos();
  const s = rig.scripts[0];
  assert.match(s.integrity, /^sha384-[A-Za-z0-9+/]{64}$/, "sha384, base64, the whole digest");
  assert.equal(s.crossOrigin, "anonymous",
    "without this the body is opaque and the browser blocks rather than checks");
  assert.equal(s.src, rig.api.src);
});

test("the URL the hash is a hash of cannot drift under it", () => {
  const rig = coverRig();
  assert.match(rig.api.src, /^https:\/\/www\.desmos\.com\/api\/v\d+\.\d+\.\d+\/calculator\.js\?/,
    "a two-part version redirects, and a redirect is a different four megabytes");
  // Measured 2026-09-16: without lang=, desmos.com answers an Accept-Language of
  // fr-FR with a 302 to &lang=fr, and that build is 4348961 bytes against this
  // one's 4029588. One hash cannot match both, so a page that left the language
  // to the browser would load for an English viewer and be blocked for the rest.
  // Naming the build is what makes the bytes the same for everybody.
  assert.match(rig.api.src, /[?&]lang=en(&|$)/,
    "the language is ours to pick, or the bytes are the viewer's browser's to pick");
  assert.match(rig.api.src, /[?&]apiKey=/, "and the key is still on it");
});

// The end of the whole chain: a hash that does not match is a script that never
// runs, and this is a page somebody is locked out of unless the keypad behind it
// still opens. Nothing here stubs the door - the keystrokes go through the
// page's own calcKey and its own calcPress, and enter() is the real call.
function blockedRig() {
  const els = fakeDom(["lock", "graph", "graphBox", "calc", "graphWait",
                       "calcPrev", "calcNow", "calcDeg"]);
  els.calc.hidden = true;
  const rig = { els, entered: 0, scripts: [], timers: [], docOn: [] };
  const box = {
    ENTRY: "1234",
    $: (id) => els[id] || null,
    enter: () => { rig.entered++; },
    window: {},
    document: {
      head: { appendChild: (s) => rig.scripts.push(s) },
      createElement: () => ({}),
      addEventListener: (t, f) => rig.docOn.push(f),
      removeEventListener: (t, f) => {
        const i = rig.docOn.indexOf(f);
        if (i >= 0) rig.docOn.splice(i, 1);
      },
    },
    setTimeout: (f, ms) => { rig.timers.push({ f, ms, live: true }); return rig.timers.length; },
    clearTimeout: (h) => { if (rig.timers[h - 1]) rig.timers[h - 1].live = false; },
  };
  vm.createContext(box);
  vm.runInContext(
    slice("const CALC_FN = {", "/* ---- the graphing calculator") +
    slice("const DESMOS_SRC =", "// Past the calculator is where") +
    "\nthis.loadDesmos = loadDesmos; this.calcKey = calcKey; this.calcShow = calcShow;",
    box, { filename: "cast/index.html" });
  rig.api = box;
  // The page arms the typed-key door before it asks for the script, so the
  // seconds the bundle is in flight are not seconds with no way in.
  box.document.addEventListener("keydown", box.calcKey, true);
  box.calcShow();
  box.loadDesmos();
  return rig;
}

const KEY = (k) => ({ key: k, preventDefault() {}, stopPropagation() {} });

test("a bundle the browser refuses still leaves 1234 as the way through", () => {
  for (const [why, fail] of [
    ["the hash did not match", (rig) => rig.scripts[0].onerror()],
    ["the policy refused the origin", (rig) => rig.scripts[0].onerror()],
    ["it never answered", (rig) => rig.timers[0].f()],
    ["it answered with no Desmos on it", (rig) => rig.scripts[0].onload()],
  ]) {
    const rig = blockedRig();
    fail(rig);
    assert.equal(rig.els.calc.hidden, false, why + ": the keypad is the cover");
    assert.equal(rig.els.graph.hidden, true, why + ": and the graph card is gone");
    const key = rig.docOn[0];
    assert.ok(key, why + ": with a live keydown handler on the document");
    for (const k of "1234") key(KEY(k));
    assert.equal(rig.entered, 0, why + ": four digits are four digits, not the door");
    key(KEY("Enter"));
    assert.equal(rig.entered, 1, why + ": and Enter on the code opens it");
  }
});

test("and the keypad behind a refused bundle is still a calculator", () => {
  const rig = blockedRig();
  rig.scripts[0].onerror();
  const key = rig.docOn[0];
  for (const k of "12") key(KEY(k));
  key(KEY("Enter"));
  assert.equal(rig.entered, 0, "a sum is not the code");
  assert.equal(rig.els.calcNow.textContent, "12", "it works the sum out instead");
});

/* ---- the policy that says the key cannot leave even if the bundle is bad ---- */

// A hash says the bundle is the one that was read. This says a bundle that
// somehow is not still has nowhere to send what it read, which is the half that
// survives the hash being wrong. The policy is parsed out of the page rather
// than restated here, so a directive quietly dropped from the page fails here
// instead of leaving a test passing against its own copy.
const csp = (() => {
  const m = src.match(/<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)">/);
  if (!m) throw new Error("cast/index.html no longer carries a Content-Security-Policy");
  const out = {};
  for (const part of m[1].split(";")) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length) out[bits[0]] = bits.slice(1);
  }
  return out;
})();

// Enough of the source-list rules to answer "would the browser let this one
// through": the origin the page is served from, an exact host, a *. wildcard
// that needs a subdomain under it, and 'self' matching a wss:// back to its own
// host, which is what CSP3 says and what the LAN bridge relies on.
const SELF = new URL("https://go.instellar.net/cast/");
function allows(directive, url) {
  const u = new URL(url);
  return (csp[directive] || []).some((s) => {
    if (s === "'self'") {
      return u.hostname === SELF.hostname && u.port === SELF.port &&
        (u.protocol === SELF.protocol || u.protocol === "wss:");
    }
    if (!s.includes("://")) return false;
    const [scheme, host] = s.split("://");
    if (u.protocol !== scheme + ":") return false;
    return host.startsWith("*.") ? u.hostname.endsWith(host.slice(1)) : u.hostname === host;
  });
}

test("the page's own traffic is traffic the policy permits", () => {
  // Every address this page actually opens. The tunnel hostname rotates on every
  // host restart, which is why these are wildcards and not one name.
  for (const url of [
    "https://go.instellar.net/api/cast?t=k&want=view",   // where is the host
    "wss://go.instellar.net/ws?k=abc&v=tab",             // the bridge on the LAN
    "wss://quiet-lion-rides-fast.trycloudflare.com/ws?k=abc&v=tab",
    "wss://quiet-lion-rides-fast.trycloudflare.com/video?fps=30&mbps=8",
    "wss://a1b2c3.ngrok-free.app/ws?k=abc&v=tab",
    "wss://a1b2c3.ngrok.io/ws?k=abc&v=tab",
  ]) assert.ok(allows("connect-src", url), url + " is a socket the page has to open");

  // ctlUrl() rewrites that same tunnel to https and asks it for a rate change. A
  // policy that allowed the socket and forgot this would leave the picture up
  // and every dial on the toolbar dead.
  for (const url of [
    "https://quiet-lion-rides-fast.trycloudflare.com/ctl?k=abc&v=tab&stream=30",
    "https://a1b2c3.ngrok-free.app/ctl?k=abc&v=tab&stream=0",
  ]) assert.ok(allows("connect-src", url), url + " is how the toolbar moves the host");
});

test("and nowhere else is somewhere the key can be posted to", () => {
  for (const url of [
    "https://evil.example/collect?k=",
    "wss://evil.example/collect",
    "https://trycloudflare.com/collect",        // the wildcard needs a subdomain
    "https://www.desmos.com/api/log",           // the bundle may run, not report
    "https://desmos.s3.amazonaws.com/x",
  ]) assert.equal(allows("connect-src", url), false, url + " must not be reachable");
});

test("the other easy way out is an image, and the page loads none", () => {
  // No img tag, no background-image, no font file: everything the page draws it
  // draws itself. Desmos inlines its own sprites and faces as data: URIs, which
  // is why those two schemes are there and why no host is.
  for (const d of ["img-src", "font-src"]) {
    for (const s of csp[d]) {
      assert.ok(!s.includes("://"), d + " names " + s + ", which is a place to send bytes to");
    }
  }
  assert.equal(allows("img-src", "https://evil.example/beacon.gif"), false);
});

test("the beacons nobody thinks of are closed too", () => {
  assert.deepEqual(csp["default-src"], ["'none'"], "a directive nobody listed refuses");
  assert.deepEqual(csp["form-action"], ["'none'"], "a form posts as well as any fetch does");
  assert.deepEqual(csp["frame-src"], ["'none'"], "and so does an iframe with a query string");
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["base-uri"], ["'none'"], "or ./novnc.js stops meaning ours");
});

test("a script may come from here or from Desmos and from nowhere else", () => {
  assert.ok(allows("script-src", "https://www.desmos.com/api/v1.11.4/calculator.js"),
    "the pinned bundle has to be allowed to run at all");
  assert.ok(allows("script-src", "https://go.instellar.net/cast/novnc.js"));
  assert.equal(allows("script-src", "https://evil.example/stage2.js"), false,
    "so a bad bundle cannot pull the next one down after it");
  // Both of these are load-bearing rather than sloppy: this page's own script is
  // inline and a static host cannot mint a nonce, and the Desmos bundle eval()s
  // its chunk table as it loads and compiles every expression with new Function.
  assert.ok(csp["script-src"].includes("'unsafe-inline'"));
  assert.ok(csp["script-src"].includes("'unsafe-eval'"));
  assert.ok(!csp["script-src"].includes("'strict-dynamic'"),
    "which would throw the origin list away and let the bundle load anything it liked");
});

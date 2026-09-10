// The Stream client in cast/index.html has four decisions that need no DOM,
// no socket and no decoder: what the 5-byte frame header says, whether a chunk
// goes to the decoder, what the state line says when it all falls over, which
// codecs to ask the host for once the browser has said what it decodes, and
// when a codec that decodes but cannot keep up is given up on.
// They are kept as plain functions on purpose, so this cuts them out of the
// page by their source text - the same trick as viewer.test.mjs - and runs
// them as they are. A rename fails loudly; the test follows the code.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(new URL("../../../cast/index.html", import.meta.url));

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};

const src = fs.readFileSync(PAGE, "utf8").replace(/\r\n/g, "\n");
const grab = (from, to) => {
  const a = src.indexOf(from);
  if (a < 0) throw new Error("page no longer contains: " + from);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error("no end marker after: " + from);
  return src.slice(a, b + to.length) + "\n";
};

const sandbox = {};
vm.createContext(sandbox);
const { LAG_QUEUE, STREAM_CODECS, STREAM_STEPS, STEP_UP_MS, PROBATION_MS, STRIKE_MS, STRAIN_DROPS, STRAIN_DROP_MS, STRAIN_RATIO, STRAIN_SLOW_MS,
        parseVideoFrame, streamGate, streamReason, streamCodecs, streamNext, streamFamily, streamSlow, streamStrain } = vm.runInContext(
  grab("const LAG_QUEUE = ", ";\n") +
  // These four carry a trailing comment, so the line end is the marker.
  grab("const STRAIN_DROPS = ", "\n") +
  grab("const STRAIN_DROP_MS = ", "\n") +
  grab("const STRAIN_RATIO = ", "\n") +
  grab("const STRAIN_SLOW_MS = ", "\n") +
  grab("const STREAM_CODECS = ", ";\n") +
  grab("const STREAM_STEPS = ", ";\n") +
  grab("const STEP_UP_MS = ", "\n") +
  grab("const PROBATION_MS = ", "\n") +
  grab("const STRIKE_MS = ", "\n") +
  grab("function parseVideoFrame(buf) {", "\n}\n") +
  grab("function streamGate(waitKey, key, queued) {", "\n}\n") +
  grab("function streamReason(why, code, reason) {", "\n}\n") +
  grab("function streamCodecs(supported, bad = [], first = \"\") {", "\n}\n") +
  grab("function streamNext(supported, bad, from) {", "\n}\n") +
  grab("function streamFamily(codec) {", "\n}\n") +
  grab("function streamSlow(deliveredFps, decodedFps) {", "\n}\n") +
  grab("function streamStrain(drops, now, slowMs) {", "\n}\n") +
  "({ LAG_QUEUE, STREAM_CODECS, STREAM_STEPS, STEP_UP_MS, PROBATION_MS, STRIKE_MS, STRAIN_DROPS, STRAIN_DROP_MS, STRAIN_RATIO, STRAIN_SLOW_MS," +
  " parseVideoFrame, streamGate, streamReason, streamCodecs, streamNext, streamFamily, streamSlow, streamStrain });",
  sandbox);

// The bridge's header, built the way the wire carries it: flags, u32 BE ms.
// Built inside the sandbox so the ArrayBuffer is the realm the page's DataView
// checks against - a buffer from this realm is not one there.
const frame = (flags, ms, payload) => vm.runInContext(
  "(() => { const b = new ArrayBuffer(5 + " + payload.length + ");" +
  " const v = new DataView(b); v.setUint8(0, " + flags + "); v.setUint32(1, " + ms + ");" +
  " new Uint8Array(b, 5).set([" + payload.join(",") + "]); return b; })()", sandbox);

/* --------------------------------------------------------------- header -- */

{
  const f = parseVideoFrame(frame(1, 1234, [0, 0, 0, 1, 0x65, 0x88]));
  ok("bit 0 of the flags byte is the keyframe", f.key === true);
  ok("milliseconds on the wire become the microseconds WebCodecs wants",
     f.timestamp === 1234000, f.timestamp);
  ok("the payload starts right after the header, start code intact",
     Array.from(f.data).join() === "0,0,0,1,101,136", Array.from(f.data).join());
  ok("the payload is a view, not a copy", f.data.byteOffset === 5 && f.data.byteLength === 6);
}
{
  const f = parseVideoFrame(frame(0, 0xFFFFFFFF, [1]));
  ok("a clear bit 0 is a delta", f.key === false);
  ok("the timestamp is read unsigned and big-endian", f.timestamp === 0xFFFFFFFF * 1000, f.timestamp);
  ok("other flag bits do not make a keyframe", parseVideoFrame(frame(2, 0, [1])).key === false);
  ok("the low bit set among others still does", parseVideoFrame(frame(3, 0, [1])).key === true);
}
ok("a header with nothing after it is not a frame", parseVideoFrame(frame(1, 0, [])) === null);
ok("a short buffer is not a frame", parseVideoFrame(vm.runInContext("new ArrayBuffer(3)", sandbox)) === null);
ok("no buffer at all is not a frame", parseVideoFrame(null) === null && parseVideoFrame(undefined) === null);

/* ----------------------------------------------------------- lag control -- */

// The stream as the page walks it: waitKey starts true after a configure, so
// deltas that arrive before any key are thrown away, not decoded into garbage.
{
  let g = streamGate(true, false, 0);
  ok("a delta before the first key is skipped", g.decode === false && g.waitKey === true);
  g = streamGate(true, true, 0);
  ok("the first key is decoded and opens the gate", g.decode === true && g.waitKey === false);
  g = streamGate(false, false, 0);
  ok("a delta on an open gate with an idle decoder is decoded", g.decode === true && g.waitKey === false);
  g = streamGate(false, false, LAG_QUEUE);
  ok("a queue right at the limit is still decoded", g.decode === true && g.waitKey === false);
  g = streamGate(false, false, LAG_QUEUE + 1);
  ok("a queue over the limit drops the delta and closes the gate", g.decode === false && g.waitKey === true);
  g = streamGate(true, false, 0);
  ok("once closed, an emptied queue does not reopen it - only a key can",
     g.decode === false && g.waitKey === true);
  g = streamGate(true, true, LAG_QUEUE * 3);
  ok("a key is decoded whatever the queue: it is the recovery point",
     g.decode === true && g.waitKey === false);
}
ok("the limit is eight frames, a bit over a tenth of a second at sixty",
   LAG_QUEUE === 8, LAG_QUEUE);

/* -------------------------------------------------------------- reasons -- */

// Every close the bridge sends, and every way the page itself gives up.
ok("1011 carries the bridge's own words", streamReason("close", 1011, "no encoder") === "no encoder");
ok("1011 with the reason stripped still blames the encoder",
   streamReason("close", 1011, "") === "the encoder failed", streamReason("close", 1011, ""));
ok("1006 is the link, with no words to quote",
   streamReason("close", 1006, "") === "the video link dropped");
ok("any other code is shown so it can be searched for",
   streamReason("close", 1008, "policy") === "closed (1008: policy)", streamReason("close", 1008, "policy"));
ok("a code with no reason shows just the code",
   streamReason("close", 1000, "") === "closed (1000)", streamReason("close", 1000, ""));
ok("no code at all does not print a zero",
   streamReason("close", 0, "") === "closed", streamReason("close", 0, ""));
ok("no config in time names the host", /host/.test(streamReason("timeout")));
ok("a missing VideoDecoder names the browser", /browser/.test(streamReason("nodecoder")));
ok("a host without the route names the host", /host/.test(streamReason("host")));
ok("a decoder error quotes the decoder",
   streamReason("decode", 0, "Unsupported codec") === "decoder error (Unsupported codec)");
ok("a decoder error with no message is still a sentence",
   streamReason("decode", 0, "") === "decoder error");
ok("an unknown cause does not throw", streamReason("???") === "unknown");
ok("every reason is short enough for the state line",
   ["close", "timeout", "nodecoder", "host", "decode"].every(
     (w) => streamReason(w, 1011, "encoder died").length < 60));

/* --------------------------------------------------------------- codecs -- */

// The probe results, one boolean per STREAM_CODECS entry, become the list the
// host sees on the /video URL.
ok("the probes are av1, hevc, h264 in that order, each a string of its own family",
   STREAM_CODECS.map((c) => c[0]).join() === "av1,hevc,h264" &&
   /^av01\./.test(STREAM_CODECS[0][1]) && /^hvc1\./.test(STREAM_CODECS[1][1]) && /^avc1\./.test(STREAM_CODECS[2][1]));
ok("everything supported asks for av1 first, then hevc, then h264",
   streamCodecs([true, true, true]) === "av1,hevc,h264", streamCodecs([true, true, true]));
ok("a browser with only h264 asks for h264", streamCodecs([false, false, true]) === "h264");
ok("av1 without hevc keeps the order and skips the gap", streamCodecs([true, false, true]) === "av1,h264");
ok("hevc alone is asked for alone", streamCodecs([false, true, false]) === "hevc");
ok("nothing supported still asks for h264", streamCodecs([false, false, false]) === "h264");
ok("no answers at all is h264 too", streamCodecs([]) === "h264");
ok("the list is fit for a query string as it is", /^[a-z0-9,]+$/.test(streamCodecs([true, true, true])));

// The session's bad list and last visit's codec narrow the list further.
const ALL = [true, true, true];
ok("a codec downgraded this session is left out", streamCodecs(ALL, ["av1"]) === "hevc,h264");
ok("two downgrades leave the last one", streamCodecs(ALL, ["av1", "hevc"]) === "h264");
ok("everything downgraded still asks for h264, the host's own floor",
   streamCodecs(ALL, ["av1", "hevc", "h264"]) === "h264");
ok("last visit's codec is where the list starts", streamCodecs(ALL, [], "hevc") === "hevc,h264");
ok("last visit's h264 asks for h264 alone", streamCodecs(ALL, [], "h264") === "h264");
ok("last visit's av1 changes nothing: it is the top already", streamCodecs(ALL, [], "av1") === "av1,hevc,h264");
ok("a remembered codec this browser no longer decodes is ignored",
   streamCodecs([true, false, true], [], "hevc") === "av1,h264");
ok("a remembered codec that is also bad is ignored", streamCodecs(ALL, ["hevc"], "hevc") === "av1,h264");
ok("garbage in localStorage is ignored", streamCodecs(ALL, [], "vp9; drop") === "av1,hevc,h264");

/* ------------------------------------------------------------- families -- */

// The config message carries a codec string; the bad list and localStorage
// hold families, the same words the URL list uses.
ok("av01 is av1", streamFamily("av01.0.08M.08") === "av1");
ok("hvc1 and hev1 are hevc", streamFamily("hvc1.1.6.L120.90") === "hevc" && streamFamily("hev1.1.6.L120.90") === "hevc");
ok("avc1 and avc3 are h264", streamFamily("avc1.64002a") === "h264" && streamFamily("avc3.64002a") === "h264");
ok("anything else is no family, so nothing is struck", streamFamily("vp09.00.10.08") === "" && streamFamily("") === "");
ok("every probe string maps to its own name", STREAM_CODECS.every(([name, codec]) => streamFamily(codec) === name));

/* --------------------------------------------------------------- strain -- */

// Decoded output against arrivals, one tick at a time.
ok("the slow line is 85% of what arrives", STRAIN_RATIO === 0.85, STRAIN_RATIO);
ok("sixty in and sixty out is fine", streamSlow(60, 60) === false);
ok("sixty in and fifty-two out is fine, just over the line", streamSlow(60, 52) === false);
ok("sixty in and fifty out is slow", streamSlow(60, 50) === true);
ok("sixty in and nothing out is slow", streamSlow(60, 0) === true);
ok("nothing arriving is nothing to fall short of", streamSlow(0, 0) === false);

// The verdict, from the lag control's drop times and how long output has
// been short.
ok("two drops within ten seconds, two seconds slow: those are the numbers",
   STRAIN_DROPS === 2 && STRAIN_DROP_MS === 10000 && STRAIN_SLOW_MS === 2000);
ok("no drops and no slowness is no verdict", streamStrain([], 50000, 0) === "");
ok("one drop is a blip", streamStrain([49000], 50000, 0) === "");
ok("a second drop within ten seconds is the decoder falling behind",
   streamStrain([41000, 50000], 50000, 0) === "dropping frames");
ok("a second drop more than ten seconds after the first does not count",
   streamStrain([39000, 50000], 50000, 0) === "");
ok("old drops are not counted against new ones",
   streamStrain([10000, 20000, 50000], 50000, 0) === "");
ok("two seconds short of the arrivals is a decoder that will not catch up",
   streamStrain([], 50000, 2000) === "decoding too slowly");
ok("one second short is not yet", streamStrain([], 50000, 1999) === "");
ok("drops are judged before slowness when both apply",
   streamStrain([45000, 50000], 50000, 5000) === "dropping frames");
ok("either verdict fits the state line", ["dropping frames", "decoding too slowly"].every((w) => w.length < 30));

/* ------------------------------------------------------------ downgrade -- */

// What is left to fall to, which is not the question streamCodecs answers:
// that one always names something for the URL.
ok("av1 falls to hevc", streamNext(ALL, [], "av1") === "hevc");
ok("hevc falls to h264 even with av1 unstruck above it",
   streamNext(ALL, ["av1"], "hevc") === "h264");
ok("h264 with av1 still untried goes back up to it", streamNext(ALL, [], "h264") === "av1");
ok("the last codec standing has nowhere to fall",
   streamNext(ALL, ["av1", "hevc"], "h264") === "");
ok("a browser with only h264 has nowhere to fall from the start",
   streamNext([false, false, true], [], "h264") === "");
ok("no probe answers at all is nowhere to fall", streamNext([], [], "h264") === "");

// The demand ladder the downgrade walks down once the codecs run out.
ok("three steps, each asking for fewer frames and fewer bytes than the last",
   STREAM_STEPS.length === 3 &&
   STREAM_STEPS.every((s, i) => i === 0 ||
     (s.fps < STREAM_STEPS[i - 1].fps && s.mbps < STREAM_STEPS[i - 1].mbps)));
ok("the top step is the full ask, unchanged",
   STREAM_STEPS[0].fps === 60 && STREAM_STEPS[0].mbps === 1);
ok("the bottom step still clears the host's floor of one frame and one megabit",
   STREAM_STEPS[2].fps >= 1 && STREAM_STEPS[2].mbps * 8 >= 1);

// The decision itself: strike a codec while there is one left, pace the ask
// when there is not, and give up only at the bottom step or on a decoder that
// errored outright.
{
  // `age` is how long the codec has been decoding, `up` how long ago the pace
  // was last asked back for; both are what the two time rules read.
  const run = (codec, bad, supported, step, why, detail, { age = 0, up = 0, ceil = 0 } = {}) => {
    const out = { off: null, opened: 0 };
    const NOW = 1000000;
    const ctx = vm.createContext({
      STREAM_CODECS, STREAM_STEPS, STRIKE_MS, PROBATION_MS, streamFamily, streamNext, out,
      performance: { now: () => NOW },
      vidCodec: codec, vidBad: new Set(bad), vidSupported: supported, vidStep: step,
      vidCeil: ceil, vidCodecSince: age ? NOW - age : 0, vidUp: up ? NOW - up : 0,
      vidCodecs: "", vidNote: "",
      chooseCodecs() {}, state() {},
      openVideo() { out.opened++; },
      streamOff(w, code, reason) { out.off = reason; },
    });
    vm.runInContext(grab("function streamDowngrade(why, detail) {", "\n}\n") +
      "streamDowngrade(" + JSON.stringify(why) + ", " + JSON.stringify(detail || "") + ");", ctx);
    return { off: out.off, opened: out.opened, step: ctx.vidStep, ceil: ctx.vidCeil,
             bad: Array.from(ctx.vidBad).join(), note: ctx.vidNote };
  };

  let r = run("av01.0.08M.08", [], ALL, 0, "dropping frames");
  ok("a strained av1 is struck and hevc asked for at the same pace",
     r.bad === "av1" && r.step === 0 && r.opened === 1 && r.off === null, JSON.stringify(r));

  r = run("avc1.64002a", [], [false, false, true], 0, "dropping frames");
  ok("h264 alone is paced down rather than losing Stream for the session",
     r.off === null && r.step === 1 && r.opened === 1 && r.bad === "", JSON.stringify(r));
  ok("the note says what it came back at", /30 fps/.test(r.note), r.note);

  r = run("avc1.64002a", ["av1", "hevc"], ALL, 1, "decoding too slowly");
  ok("the last codec keeps stepping down while there are steps left",
     r.off === null && r.step === 2 && r.opened === 1, JSON.stringify(r));

  r = run("avc1.64002a", ["av1", "hevc"], ALL, 2, "dropping frames");
  ok("the bottom step is where it finally gives up",
     r.off === "dropping frames" && r.opened === 0 && r.step === 2, JSON.stringify(r));

  r = run("avc1.64002a", [], [false, false, true], 0, "decoder error", "Unsupported codec");
  ok("a decoder that errored outright is reported, not paced",
     r.off === "Unsupported codec" && r.opened === 0 && r.step === 0, JSON.stringify(r));

  r = run("", [], ALL, 0, "dropping frames");
  ok("strain with no codec named at all gives up",
     r.off === "dropping frames" && r.opened === 0, JSON.stringify(r));

  // The strike rule: a hard scene arriving half a minute in is the picture
  // getting harder, not the wrong codec.
  r = run("av01.0.08M.08", [], ALL, 0, "dropping frames", "", { age: STRIKE_MS + 10000 });
  ok("a codec that has been decoding for a while is paced, not struck",
     r.bad === "" && r.step === 1 && r.opened === 1, JSON.stringify(r));
  r = run("av01.0.08M.08", [], ALL, 0, "dropping frames", "", { age: 5000 });
  ok("a codec that strains in its first seconds is still struck",
     r.bad === "av1" && r.step === 0, JSON.stringify(r));
  r = run("av01.0.08M.08", [], ALL, 0, "decoder error", "Unsupported", { age: STRIKE_MS + 10000 });
  ok("a decoder error is a codec verdict however long it ran",
     r.bad === "av1" && r.opened === 1 && r.off === null, JSON.stringify(r));
  ok("half a minute is the line, and the same one on both sides",
     STRIKE_MS === 30000 && STEP_UP_MS === 30000);

  // Probation: a step that strains again right after being asked back for is
  // one this session cannot hold.
  r = run("avc1.64002a", ["av1", "hevc"], ALL, 0, "dropping frames", "", { up: 5000 });
  ok("straining on probation puts the step just left out of reach",
     r.step === 1 && r.ceil === 1, JSON.stringify(r));
  r = run("avc1.64002a", ["av1", "hevc"], ALL, 0, "dropping frames", "", { up: PROBATION_MS + 1000 });
  ok("a step that held for a full probation is not held against it",
     r.step === 1 && r.ceil === 0, JSON.stringify(r));
  r = run("avc1.64002a", ["av1", "hevc"], ALL, 0, "dropping frames");
  ok("a step down that follows no climb at all leaves the ceiling alone",
     r.step === 1 && r.ceil === 0, JSON.stringify(r));
}

// Climbing back up, one step and one encoder restart at a time.
{
  const out = { opened: 0, line: "" };
  const NOW = 1000000;
  const ctx = vm.createContext({
    STREAM_STEPS, out, performance: { now: () => NOW },
    vidStep: 2, vidUp: 0, vidNote: "",
    state(_, line) { out.line = line; },
    openVideo() { out.opened++; },
  });
  vm.runInContext(grab("function streamRecover() {", "\n}\n") + "streamRecover();", ctx);
  ok("a calm stretch buys one step back, not the whole ladder",
     ctx.vidStep === 1 && out.opened === 1);
  ok("the climb starts a probation", ctx.vidUp === NOW);
  ok("the state line names the pace it went back to", /30 fps/.test(out.line), out.line);
}

// Exercise the real decoder lifecycle with synthetic frames and a fake clock.
// A config is not a picture, and callbacks from a replaced decoder are stale.
{
  const timers = new Map();
  const instances = [];
  let nextTimer = 0, saved = 0, painted = 0, downgraded = "", refuseHw = false;
  const ctx = vm.createContext({
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    performance: { now: () => 100 },
    localStorage: { setItem() { saved++; } },
    VideoDecoder: class {
      constructor(callbacks) { this.callbacks = callbacks; instances.push(this); this.configs = []; }
      configure(c) {
        this.configs.push(c);
        // Stands in for a browser that treats prefer-hardware as a requirement
        // and refuses the configure rather than falling back on its own.
        if (refuseHw && c.hardwareAcceleration === "prefer-hardware") throw new Error("no hw");
        this.state = "configured";
      }
      close() { this.state = "closed"; }
    },
    vidCanvas: () => ({ width: 100, height: 100, getContext: () => ({ drawImage() { painted++; } }) }),
    $: () => ({}), pushStream() {}, state() {}, setRate() {}, ceilHz: () => 30,
    streamDowngrade(why) { downgraded = why; },
    streamFamily, CODEC_KEY: "cast.codec",
  });
  vm.runInContext(`let decoder = null, vidTimer = 0, vidReady = false;
    let vidFrames = 0, vidDelivered = 0, vidDrops = [], vidSlowSince = 0;
    let vidSince = 0, vidCalm = 0, vidCodecSince = 0, vidWaitKey = true, vidHz = 0, vidEncoder = '', vidCodec = '', vidNote = '';
    let streamWant = 30, vidSock = null, vidSoft = false;
    const rfb = { pixels: true };`, ctx);
  vm.runInContext(grab("function videoConfig(codec) {", "\n}\n") +
    grab("function configureVideo(cfg) {", "\n}\n") +
    grab("function closeVideo() {", "\n}\n"), ctx);
  const configure = () => vm.runInContext('configureVideo({ codec: "avc1.64002a", fps: 60 })', ctx);
  configure();
  ok("config alone keeps VNC pixels active", vm.runInContext("rfb.pixels && !vidReady", ctx));
  ok("config arms a first-picture timeout", timers.size === 1);
  let closed = 0;
  const frame = () => ({ close() { closed++; } });
  instances[0].callbacks.output(frame());
  ok("first picture takes over and cancels the timeout",
    vm.runInContext("!rfb.pixels && vidReady && streamWant === 0", ctx) && timers.size === 0 && painted === 1 && closed === 1);
  vm.runInContext("vidFrames = 0", ctx);
  instances[0].callbacks.output(frame());
  ok("stats resets do not repeat localStorage writes", saved === 1);
  configure();
  ok("encoder restart restores VNC while waiting", vm.runInContext("rfb.pixels && !vidReady", ctx));
  instances[0].callbacks.output(frame());
  ok("stale decoder frames are closed without painting", painted === 2 && closed === 3);
  [...timers.values()][0]();
  ok("a decoder producing no pictures triggers fallback", downgraded === "not producing frames");

  // A browser that refuses the hardware preference gets asked again without
  // it, in the same decoder, rather than being called a decoder error.
  refuseHw = true;
  const was = instances.length;
  configure();
  const d = instances[instances.length - 1];
  ok("a refused hardware preference is asked again without one",
    instances.length === was + 1 && d.configs.length === 2 &&
    d.configs[0].hardwareAcceleration === "prefer-hardware" &&
    d.configs[1].hardwareAcceleration === "no-preference" && d.state === "configured",
    JSON.stringify(d.configs.map((c) => c.hardwareAcceleration)));
  ok("and the page stops asking for hardware for the rest of the session",
    vm.runInContext("vidSoft", ctx) === true);
  ok("nothing was downgraded over it", downgraded === "not producing frames");
  refuseHw = false;
  vm.runInContext("closeVideo()", ctx);
  ok("closing cancels the first-picture timeout", timers.size === 0);
}

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

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
const { LAG_QUEUE, STREAM_CODECS, STREAM_SAFE, STREAM_STEPS, STEP_UP_MS, PROBATION_MS, STRIKE_MS, STREAM_PROVE_MS,
        STRAIN_DROPS, STRAIN_DROP_MS, STRAIN_RATIO, STRAIN_SLOW_MS,
        PACE_CAP_MS, PACE_FLOOR_MS, PACE_BAND_MS, PACE_SHRINK_MS, PACE_CALM, PACE_LATE,
        PACE_WINDOW_MS, PACE_STEP_MS, PACE_RESET_MS, PACE_QUEUE_MAX,
        RECT_SKEW, STREAM_HEIGHTS, STREAM_BASE_HEIGHT, HEIGHT_SLACK,
        streamRows, streamHeight, streamTaller, streamProven,
        parseVideoFrame, streamGate, streamRectOk, streamReason, streamOrder, streamCodecs, streamNext, streamBetter,
        streamFamily, streamSlow, streamStrain, streamClock, streamLate, streamDelay } = vm.runInContext(
  grab("const LAG_QUEUE = ", ";\n") +
  // These four carry a trailing comment, so the line end is the marker.
  grab("const STRAIN_DROPS = ", "\n") +
  grab("const STRAIN_DROP_MS = ", "\n") +
  grab("const STRAIN_RATIO = ", "\n") +
  grab("const STRAIN_SLOW_MS = ", "\n") +
  grab("const RECT_SKEW = ", "\n") +
  grab("const STREAM_CODECS = ", ";\n") +
  grab("const STREAM_STEPS = ", ";\n") +
  grab("const STEP_UP_MS = ", "\n") +
  grab("const PROBATION_MS = ", "\n") +
  grab("const STRIKE_MS = ", "\n") +
  grab("const STREAM_PROVE_MS = ", ";\n") +
  grab("const PACE_CAP_MS = ", "\n") +
  grab("const PACE_FLOOR_MS = ", "\n") +
  grab("const PACE_BAND_MS = ", "\n") +
  grab("const PACE_SHRINK_MS = ", "\n") +
  grab("const PACE_CALM = ", "\n") +
  grab("const PACE_LATE = ", "\n") +
  grab("const PACE_WINDOW_MS = ", "\n") +
  grab("const PACE_STEP_MS = ", "\n") +
  grab("const PACE_RESET_MS = ", "\n") +
  grab("const PACE_QUEUE_MAX = ", "\n") +
  grab("const STREAM_SAFE = ", ";\n") +
  grab("const STREAM_HEIGHTS = ", ";\n") +
  grab("const STREAM_BASE_HEIGHT = ", ";\n") +
  grab("const HEIGHT_SLACK = ", "\n") +
  grab("function streamRows(cssH, screenH, dpr, fbH) {", "\n}\n") +
  grab("function streamHeight(rows, allowed, current) {", "\n}\n") +
  grab("function streamTaller(rows, current, bad) {", "\n}\n") +
  grab("function streamProven(saved) {", "\n}\n") +
  grab("function parseVideoFrame(buf) {", "\n}\n") +
  grab("function streamClock(clock) {", "\n}\n") +
  grab("function streamLate(at, now, frameMs) {", "\n}\n") +
  grab("function streamDelay(delay, jitter, frameMs, late, calm) {", "\n}\n") +
  grab("function streamGate(waitKey, key, queued) {", "\n}\n") +
  grab("function streamRectOk(w, h, fbW, fbH) {", "\n}\n") +
  grab("function streamReason(why, code, reason) {", "\n}\n") +
  grab("function streamOrder(supported, bad = [], first = \"\") {", "\n}\n") +
  grab("function streamCodecs(supported, bad = [], first = \"\") {", "\n}\n") +
  grab("function streamNext(supported, bad, from) {", "\n}\n") +
  grab("function streamBetter(supported, bad, current) {", "\n}\n") +
  grab("function streamFamily(codec) {", "\n}\n") +
  grab("function streamSlow(deliveredFps, decodedFps) {", "\n}\n") +
  grab("function streamStrain(drops, now, slowMs) {", "\n}\n") +
  "({ LAG_QUEUE, STREAM_CODECS, STREAM_SAFE, STREAM_STEPS, STEP_UP_MS, PROBATION_MS, STRIKE_MS, STREAM_PROVE_MS," +
  " STRAIN_DROPS, STRAIN_DROP_MS, STRAIN_RATIO, STRAIN_SLOW_MS," +
  " PACE_CAP_MS, PACE_FLOOR_MS, PACE_BAND_MS, PACE_SHRINK_MS, PACE_CALM, PACE_LATE," +
  " PACE_WINDOW_MS, PACE_STEP_MS, PACE_RESET_MS, PACE_QUEUE_MAX," +
  " RECT_SKEW, STREAM_HEIGHTS, STREAM_BASE_HEIGHT, HEIGHT_SLACK," +
  " streamRows, streamHeight, streamTaller, streamProven," +
  " parseVideoFrame, streamGate, streamRectOk, streamReason, streamOrder, streamCodecs, streamNext, streamBetter," +
  " streamFamily, streamSlow, streamStrain, streamClock, streamLate, streamDelay });",
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
// The number is a latency budget, not a taste: a queue this deep is that many
// frames of already-decoded past sitting between the hand and the screen, on top
// of whatever the link costs. Asserted as the budget, since that is the thing
// that would be wrong if someone raised it.
ok("the limit is three frames, and so under 70ms of queue at sixty",
   LAG_QUEUE === 3 && (LAG_QUEUE + 1) * (1000 / 60) < 70, LAG_QUEUE);

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
ok("a picture that is not the screen's shape says which screens to pick instead",
   /one screen/.test(streamReason("shape")) && /Main/.test(streamReason("shape")),
   streamReason("shape"));
ok("a decoder error quotes the decoder",
   streamReason("decode", 0, "Unsupported codec") === "decoder error (Unsupported codec)");
ok("a decoder error with no message is still a sentence",
   streamReason("decode", 0, "") === "decoder error");
ok("an unknown cause does not throw", streamReason("???") === "unknown");
ok("every reason is short enough for the state line",
   ["close", "timeout", "nodecoder", "host", "decode", "shape"].every(
     (w) => streamReason(w, 1011, "encoder died").length < 60));

/* ----------------------------------------------------------- rectangles -- */

// The picture drawn on the canvas has to describe the same rectangle the
// canvas does, because the canvas is the VNC framebuffer and the framebuffer
// is what every mouse coordinate is measured against. These pin the three
// values the Show dropdown can hold, on a host whose picture is scaled - which
// is the ordinary case now that the host caps the encode at 720 rows.
//
// The framebuffer sizes below are what tvnserver shares for each mode; the
// picture sizes are what the host's own cap produces, computed the way
// ffmpegArgs computes it: fitted inside a 16:9 box of the cap height with the
// aspect ratio kept, never enlarged, each side truncated to even.
{
  // Main screen: one 1440p monitor shared, capped to 720p. A quarter of the
  // area and exactly the same rectangle, which is the case that must not be
  // refused - refusing it would take Stream away from every ordinary session.
  ok("Main screen, picture scaled to half: same rectangle",
     streamRectOk(1280, 720, 2560, 1440) === true);
  ok("Main screen, a desktop already inside the cap and encoded untouched",
     streamRectOk(1280, 720, 1280, 720) === true);
  ok("Second screen, its own framebuffer, scaled the same way",
     streamRectOk(1280, 720, 1920, 1080) === true);

  // Both, which is the bug this came from. tvnserver shares the whole virtual
  // desktop, so the framebuffer spans two monitors; ddagrab sends one of them;
  // one 16:9 picture drawn across a 32:9 framebuffer is that picture at twice
  // its width. That is the zoom, and it is also every click landing at half
  // the x the user aimed at, which is the half nobody can see.
  ok("Both, two 1080p monitors side by side against one monitor's picture",
     streamRectOk(1280, 720, 3840, 1080) === false);
  ok("Both, two monitors stacked, the same mistake the other way up",
     streamRectOk(1280, 720, 1920, 2160) === false);
  ok("Both, a 1440p and a 1080p monitor side by side",
     streamRectOk(1280, 720, 4480, 1440) === false);

  // A host with one monitor shares the same rectangle whichever mode it is
  // in, and Both is then perfectly honest. This is why the rule is the shape
  // and not the word "full".
  ok("Both on a single-monitor host is the whole desktop and is allowed",
     streamRectOk(1280, 720, 1920, 1080) === true);

  // An ultrawide, where the cap is the only thing that makes the shapes differ
  // at all: the filter truncates both sides to even and 3440x1440 lands on
  // 1278x534. The tolerance exists for exactly this and nothing larger.
  const fit = Math.min(1, Math.min(1280 / 3440, 720 / 1440));
  const uw = Math.trunc(3440 * fit / 2) * 2, uh = Math.trunc(1440 * fit / 2) * 2;
  ok("the ultrawide cap lands on 1280x534", uw === 1280 && uh === 534, uw + "x" + uh);
  ok("and truncating to even is not mistaken for a different rectangle",
     streamRectOk(uw, uh, 3440, 1440) === true,
     ((uw / uh) / (3440 / 1440) - 1).toFixed(5));
  // ffmpeg evaluates that fit in floating point, so the width can as easily
  // come out one even step lower than the arithmetic here does. Both are the
  // same rectangle as far as this is concerned, which is the point.
  ok("and so is the step below it, which is where a float evaluation may land",
     streamRectOk(uw - 2, uh, 3440, 1440) === true,
     ((uw - 2) / uh / (3440 / 1440) - 1).toFixed(5));
  ok("the truncation it has to tolerate is well inside the tolerance",
     Math.abs((uw / uh) / (3440 / 1440) - 1) < RECT_SKEW / 4 &&
     Math.abs((uw - 2) / uh / (3440 / 1440) - 1) < RECT_SKEW / 4);

  ok("a shape off by one per cent is the same rectangle",
     streamRectOk(1616, 900, 1600, 900) === true);
  ok("a shape off by five per cent is not",
     streamRectOk(1680, 900, 1600, 900) === false);

  // Width and height are optional on the wire on purpose: an older host never
  // sends them, and this host drops them rather than die when it cannot read
  // its own encoder's sequence header. With nothing to compare, the picture is
  // trusted exactly as it was before this check existed - it can only ever
  // refuse on evidence.
  ok("a config without a picture size is trusted",
     streamRectOk(undefined, undefined, 3840, 1080) === true);
  ok("a half-parsed size is trusted rather than half-believed",
     streamRectOk(1280, undefined, 3840, 1080) === true &&
     streamRectOk(undefined, 720, 3840, 1080) === true);
  ok("a zero or a NaN is not evidence either",
     streamRectOk(0, 0, 1920, 1080) === true &&
     streamRectOk(NaN, NaN, 1920, 1080) === true);
  ok("a canvas with no framebuffer yet is not evidence",
     streamRectOk(1280, 720, 0, 0) === true);
}

/* --------------------------------------------------------------- codecs -- */

// The probe results, one boolean per STREAM_CODECS entry, become the list the
// host sees on the /video URL.
ok("the probes are av1, hevc, h264 in that order, each a string of its own family",
   STREAM_CODECS.map((c) => c[0]).join() === "av1,hevc,h264" &&
   /^av01\./.test(STREAM_CODECS[0][1]) && /^hvc1\./.test(STREAM_CODECS[1][1]) && /^avc1\./.test(STREAM_CODECS[2][1]));
// D3: the ask leads with the codec most likely to be in a hardware decoder,
// not the one that buys the most picture per byte. The probe order stays
// richest-first because that is the order of value; what to ask for first is a
// different question and gets a different answer.
ok("the safe codec is h264", STREAM_SAFE === "h264");
ok("a viewer with nothing remembered is asked for h264 first",
   streamCodecs([true, true, true]) === "h264,av1,hevc", streamCodecs([true, true, true]));
ok("the richer codecs stay on the list behind it, so a host that cannot encode h264 still streams",
   streamCodecs([true, true, true]).split(",").slice(1).join() === "av1,hevc");
ok("a browser with only h264 asks for h264", streamCodecs([false, false, true]) === "h264");
ok("av1 without hevc still leads with h264", streamCodecs([true, false, true]) === "h264,av1");
ok("hevc alone is asked for alone: there is no safe codec to lead with",
   streamCodecs([false, true, false]) === "hevc");
ok("av1 alone is asked for alone", streamCodecs([true, false, false]) === "av1");
ok("nothing supported still asks for h264", streamCodecs([false, false, false]) === "h264");
ok("no answers at all is h264 too", streamCodecs([]) === "h264");
ok("the list is fit for a query string as it is", /^[a-z0-9,]+$/.test(streamCodecs([true, true, true])));

// The session's bad list and last visit's codec reorder the list further.
const ALL = [true, true, true];
ok("a codec downgraded this session is left out", streamCodecs(ALL, ["av1"]) === "h264,hevc");
ok("two downgrades leave the last one", streamCodecs(ALL, ["av1", "hevc"]) === "h264");
ok("everything downgraded still asks for h264, the host's own floor",
   streamCodecs(ALL, ["av1", "hevc", "h264"]) === "h264");
ok("a struck safe codec hands the lead back to the richest thing left",
   streamCodecs(ALL, ["h264"]) === "av1,hevc");
// A remembered codec is one that carried the picture for STREAM_PROVE_MS on a
// previous visit, which is evidence isConfigSupported never had. It leads.
ok("last visit's codec leads the ask", streamCodecs(ALL, [], "hevc") === "hevc,av1,h264");
ok("last visit's av1 leads it too, which is how a desktop keeps av1",
   streamCodecs(ALL, [], "av1") === "av1,hevc,h264");
ok("last visit's h264 is the default order anyway", streamCodecs(ALL, [], "h264") === "h264,av1,hevc");
ok("a remembered codec this browser no longer decodes is ignored, and h264 leads",
   streamCodecs([true, false, true], [], "hevc") === "h264,av1");
ok("a remembered codec that is also bad is ignored", streamCodecs(ALL, ["hevc"], "hevc") === "h264,av1");
ok("garbage in localStorage is ignored", streamCodecs(ALL, [], "vp9; drop") === "h264,av1,hevc");
ok("streamOrder is the same answer without the url fallback",
   streamOrder([false, false, false]).length === 0 && streamOrder([true, true, true]).join() === "h264,av1,hevc");

// The upgrade: what is worth one encoder restart once the safe codec has held.
ok("h264 on a browser that decodes everything is worth trying av1 on",
   streamBetter(ALL, [], "h264") === "av1");
ok("with av1 struck the upgrade on offer is hevc", streamBetter(ALL, ["av1"], "h264") === "hevc");
ok("a session already on the best codec has no upgrade to make",
   streamBetter(ALL, [], "av1") === "");
ok("a session that has struck both richer codecs is not asked again",
   streamBetter(ALL, ["av1", "hevc"], "h264") === "");
ok("a browser that only decodes h264 has no upgrade to make",
   streamBetter([false, false, true], [], "h264") === "");

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
// A Chromebook that has just failed on AV1 is not helped by being handed HEVC,
// the other format its built-in decoder is most likely to be missing: it falls
// to the safe codec, which is also what the next ask leads with, so the state
// line and the URL say the same thing.
ok("av1 falls to h264, not to the next-richest thing", streamNext(ALL, [], "av1") === "h264");
ok("hevc falls to h264 even with av1 unstruck above it",
   streamNext(ALL, ["av1"], "hevc") === "h264");
ok("h264 with av1 still untried goes back up to it", streamNext(ALL, [], "h264") === "av1");
ok("h264 struck with only hevc left falls to hevc", streamNext(ALL, ["av1"], "h264") === "hevc");
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
    const out = { off: null, opened: 0, remembered: streamFamily(codec) };
    const NOW = 1000000;
    const ctx = vm.createContext({
      STREAM_CODECS, STREAM_SAFE, STREAM_STEPS, STRIKE_MS, PROBATION_MS, streamFamily,
      streamOrder, streamNext, out, CODEC_KEY: "cast.codec",
      performance: { now: () => NOW },
      // The remembered codec, so a strike can be seen to clear it.
      localStorage: {
        getItem: () => out.remembered,
        removeItem() { out.remembered = null; },
      },
      vidCodec: codec, vidBad: new Set(bad), vidSupported: supported, vidStep: step,
      vidCeil: ceil, vidCodecSince: age ? NOW - age : 0, vidUp: up ? NOW - up : 0,
      vidCodecs: "", vidNote: "", vidSoft: false, vidWant: "",
      chooseCodecs() {}, state() {},
      openVideo() { out.opened++; },
      streamOff(w, code, reason) { out.off = reason; },
    });
    vm.runInContext(grab("function streamPace(why) {", "\n}\n") +
      grab("function streamDowngrade(why, detail) {", "\n}\n") +
      "streamDowngrade(" + JSON.stringify(why) + ", " + JSON.stringify(detail || "") + ");", ctx);
    return { off: out.off, opened: out.opened, step: ctx.vidStep, ceil: ctx.vidCeil,
             bad: Array.from(ctx.vidBad).join(), note: ctx.vidNote,
             remembered: out.remembered };
  };

  let r = run("av01.0.08M.08", [], ALL, 0, "dropping frames");
  ok("a strained av1 is struck and h264 asked for at the same pace",
     r.bad === "av1" && r.step === 0 && r.opened === 1 && r.off === null, JSON.stringify(r));
  ok("and the struck codec stops being the one the next visit starts on",
     r.remembered === null, String(r.remembered));
  r = run("avc1.64002a", ["av1", "hevc"], ALL, 0, "dropping frames");
  ok("a codec that is paced rather than struck is still the one to start on",
     r.remembered === "h264", String(r.remembered));

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

/* ---------------------------------------------------- presentation clock -- */

// D1. The three pieces of the clock that need no decoder at all.

// What the recent arrivals say.
ok("no arrivals is no clock", streamClock([]).base === 0 && streamClock([]).jitter === 0);
ok("one arrival sets the base and claims no jitter",
   streamClock([{ t: 0, off: 50 }]).base === 50 && streamClock([{ t: 0, off: 50 }]).jitter === 0);
{
  const k = streamClock([{ t: 0, off: 60 }, { t: 1, off: 48 }, { t: 2, off: 55 }]);
  ok("the base is the least-delayed arrival in the window", k.base === 48, k.base);
  ok("the jitter is the spread around it", k.jitter === 12, k.jitter);
}

// What counts as evidence the buffer is too short.
ok("a picture inside a frame period of its slot is on time", streamLate(1000, 1015, 20) === false);
ok("a picture more than a frame period past its slot is late", streamLate(1000, 1021, 20) === true);
ok("a picture drawn before its slot is not late at all", streamLate(1000, 990, 20) === false);

// The buffer controller: small, adaptive, and asymmetric in the same direction
// the codec ladder is - quick to give ground, slow to take it back.
ok("a calm link sits at exactly one frame of delay", streamDelay(20, 0, 20, 0, 0) === 20);
ok("measured jitter is added to the frame period", streamDelay(20, 25, 20, 0, 0) === 45);
ok("the cap keeps the added latency in the tens of milliseconds, not the hundreds",
   streamDelay(20, 500, 20, 0, 0) === PACE_CAP_MS && PACE_CAP_MS <= 100, PACE_CAP_MS);
ok("two late pictures grow the buffer even before the jitter estimate catches up",
   streamDelay(30, 0, 20, PACE_LATE, 0) === 40);
ok("one late picture is a blip, not a resize", streamDelay(30, 0, 20, 1, 0) === 30);
ok("a smaller jitter estimate does not shrink the buffer on its own",
   streamDelay(50, 0, 20, 0, 0) === 50);
ok("shrinking waits for PACE_CALM clean decisions and then gives up one step",
   streamDelay(50, 0, 20, 0, PACE_CALM - 1) === 50 &&
   streamDelay(50, 0, 20, 0, PACE_CALM) === 50 - PACE_SHRINK_MS);
ok("inside the dead band nothing moves in either direction",
   streamDelay(30, 14, 20, 0, PACE_CALM) === 30 && streamDelay(30, 6, 20, 0, PACE_CALM) === 30);
ok("growing is one decision and shrinking is many: the asymmetry is the point",
   streamDelay(20, 60, 20, 0, 0) === PACE_CAP_MS && PACE_SHRINK_MS < PACE_CAP_MS / 4);
{
  let d = PACE_CAP_MS;
  let steps = 0;
  while (steps < 100 && streamDelay(d, 0, 20, 0, PACE_CALM) !== d) { d = streamDelay(d, 0, 20, 0, PACE_CALM); steps++; }
  ok("a link that calms walks the buffer back down to within a dead band of one frame",
     d >= 20 && d <= 20 + PACE_BAND_MS, d + " after " + steps + " decisions");
  ok("and it takes its time getting there", steps >= 10, steps);
}
ok("the floor holds however fast the stream claims to be",
   streamDelay(0, 0, 1, 0, 0) === PACE_FLOOR_MS && PACE_FLOOR_MS > 0);
ok("a frame period longer than the cap does not raise the cap: latency is the harder limit",
   streamDelay(PACE_CAP_MS, 0, 200, 0, 0) === PACE_CAP_MS &&
   streamDelay(0, 0, 200, 0, 0) === PACE_CAP_MS);
ok("the queue ceiling is low enough to be a few frames, not a second of them",
   PACE_QUEUE_MAX <= 8 && PACE_QUEUE_MAX * (1000 / 60) < 200);

/* -------------------------------------------------------------- lifecycle -- */

// Exercise the real decoder lifecycle with synthetic frames and a fake clock.
// A config is not a picture, callbacks from a replaced decoder are stale, and
// - since D1 - a decoded frame is not a painted one: the output callback now
// queues, and the rAF loop is what puts pictures up. Every VideoFrame that
// goes in is counted out again, on every path, because a frame held is a
// buffer the decoder's pool never gets back.
{
  const timers = new Map();
  const instances = [];
  const rafs = [];
  let nextTimer = 0, nextRaf = 0, saved = null, painted = 0, ctxCalls = 0;
  let downgraded = "", refuseHw = false, opened = 0, closed = 0, chose = 0, offWhy = "";
  let clock = 100;
  const canvas = {
    width: 100, height: 100,
    getContext() { ctxCalls++; return { drawImage() { painted++; } }; },
  };
  const ctx = vm.createContext({
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { rafs.push([++nextRaf, fn]); return nextRaf; },
    cancelAnimationFrame(id) {
      const i = rafs.findIndex((r) => r[0] === id);
      if (i >= 0) rafs.splice(i, 1);
    },
    performance: { now: () => clock },
    document: { hidden: false },
    localStorage: { setItem(k, v) { saved = v; }, getItem: () => saved, removeItem() { saved = null; } },
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
    vidCanvas: () => canvas,
    RECT_SKEW, streamRectOk,
    streamOff(why) { offWhy = why; },
    $: () => ({}), pushStream() {}, state() {}, setRate() {}, ceilHz: () => 30,
    streamDowngrade(why) { downgraded = why; },
    openVideo() { opened++; },
    chooseCodecs() { chose++; },
    vidBad: new Set(), vidSupported: [true, true, true],
    STREAM_CODECS, STREAM_SAFE, streamOrder, streamNext,
    STREAM_STEPS, PROBATION_MS,
    PACE_CAP_MS, PACE_FLOOR_MS, PACE_BAND_MS, PACE_SHRINK_MS, PACE_CALM, PACE_LATE,
    PACE_WINDOW_MS, PACE_STEP_MS, PACE_RESET_MS, PACE_QUEUE_MAX,
    streamFamily, CODEC_KEY: "cast.codec",
    STREAM_HEIGHTS, STREAM_BASE_HEIGHT, HEIGHT_KEY: "cast.maxh",
  });
  vm.runInContext(`let decoder = null, vidTimer = 0, vidReady = false;
    let vidFrames = 0, vidDelivered = 0, vidPainted = 0, vidDrops = [], vidSlowSince = 0;
    let vidSince = 0, vidCalm = 0, vidCodecSince = 0, vidWaitKey = true, vidHz = 0, vidEncoder = '', vidCodec = '', vidNote = '';
    let streamWant = 30, vidSock = null, vidSoft = false;
    let vidStep = 0, vidCeil = 0, vidUp = 0;
    let vidPaint = [], vidClock = [], vidBase = 0, vidDelay = 0, vidRaf = 0;
    let vidLate = 0, vidDecided = 0, vidSteady = 0, vidCtxEl = null, vidCtx = null;
    let vidSaved = false, vidUpgraded = false, vidWant = '';
    let vidMaxh = 0, vidMaxhOk = 0, vidMaxhWant = 0, vidMaxhBad = 0;
    const rfb = { pixels: true };`, ctx);
  vm.runInContext(
    grab("function streamClock(clock) {", "\n}\n") +
    grab("function streamLate(at, now, frameMs) {", "\n}\n") +
    grab("function streamDelay(delay, jitter, frameMs, late, calm) {", "\n}\n") +
    grab("function vidPaintCtx() {", "\n}\n") +
    grab("function streamDrop(frame) {", "\n}\n") +
    grab("function streamFlush() {", "\n}\n") +
    grab("function streamHold(frame, now) {", "\n}\n") +
    grab("function streamPaint() {", "\n}\n") +
    grab("function videoConfig(codec) {", "\n}\n") +
    grab("function streamPace(why) {", "\n}\n") +
    grab("function streamRefused(detail) {", "\n}\n") +
    grab("function configureVideo(cfg) {", "\n}\n") +
    grab("function closeVideo() {", "\n}\n"), ctx);

  const get = (expr) => vm.runInContext(expr, ctx);
  const configure = (fps = 60) =>
    vm.runInContext('configureVideo({ codec: "avc1.64002a", fps: ' + fps + " })", ctx);
  // A decoded frame, carrying the host timestamp WebCodecs hands back in
  // microseconds - the same number parseVideoFrame put on the chunk.
  const frame = (ms = 0) => ({ timestamp: ms * 1000, close() { closed++; } });
  const out = (f) => instances[instances.length - 1].callbacks.output(f);
  // One display refresh: advance the clock, then run whatever rAF is pending.
  const vsync = (dt = 0) => { clock += dt; rafs.splice(0).forEach(([, fn]) => fn()); };

  configure();
  ok("config alone keeps VNC pixels active", get("rfb.pixels && !vidReady"));
  ok("config arms a first-picture timeout", timers.size === 1);
  ok("a fresh encoder starts the clock at one frame of delay",
     Math.abs(get("vidDelay") - 1000 / 60) < 0.01, get("vidDelay"));

  out(frame(0));
  ok("the first decoded picture takes over the screen and cancels the timeout",
     get("!rfb.pixels && vidReady && streamWant === 0") && timers.size === 0);
  ok("but it is queued, not painted: the clock says when", painted === 0 && get("vidPaint.length") === 1);
  ok("the takeover no longer writes the codec to localStorage - one picture is not proof",
     saved === null);
  ok("a queued frame starts the paint loop", rafs.length === 1 && get("vidRaf") !== 0);
  vsync(0);
  ok("a refresh before the slot paints nothing and holds the frame",
     painted === 0 && closed === 0 && get("vidPaint.length") === 1);
  vsync(1000 / 60);
  ok("the refresh at the slot paints it and lets it go", painted === 1 && closed === 1);
  ok("the loop keeps itself going", rafs.length === 1);

  /* -- the whole point: arrival bursts do not become screen bursts -- */
  configure(50);   // 20 ms a frame, which makes the arithmetic readable
  closed = painted = 0;
  clock = 10000;
  // Two frames 20 ms apart on the host, landing in the same millisecond here.
  out(frame(0));
  out(frame(20));
  ok("both are held, neither is painted on arrival", painted === 0 && get("vidPaint.length") === 2);
  vsync(0);
  ok("nothing is due yet: the first slot is one frame period away", painted === 0);
  vsync(20);
  ok("the first slot paints exactly one of them", painted === 1 && closed === 1 && get("vidPaint.length") === 1);
  vsync(20);
  ok("the second goes up a frame period later, not in the same burst it arrived in",
     painted === 2 && closed === 2 && get("vidPaint.length") === 0);
  vsync(20);
  ok("and an empty slot paints nothing rather than repeating", painted === 2);
  ok("every frame handed in has been let go of exactly once", closed === 2);

  /* -- frames the display has no refresh for are dropped, not drawn twice -- */
  configure(50);
  closed = painted = 0;
  clock = 20000;
  out(frame(0));
  out(frame(20));
  out(frame(40));
  vsync(60);   // three slots' worth of time in one refresh
  ok("a refresh that spans several slots paints the newest and closes the rest",
     painted === 1 && closed === 3 && get("vidPaint.length") === 0);

  /* -- the context is found once per canvas, not once per frame -- */
  configure(50);
  vm.runInContext("vidCtxEl = null", ctx);
  ctxCalls = 0;
  clock = 30000;
  for (let i = 0; i < 5; i++) { out(frame(i * 20)); vsync(20); }
  ok("getContext is called once for the canvas, not once for every frame", ctxCalls === 1, ctxCalls);

  /* -- the queue has a hard ceiling whatever the clock believes -- */
  configure(50);
  closed = 0;
  clock = 40000;
  for (let i = 0; i < PACE_QUEUE_MAX + 4; i++) out(frame(i * 20));
  ok("the queue never holds more than the cap",
     get("vidPaint.length") === PACE_QUEUE_MAX, get("vidPaint.length"));
  ok("and the frames it would not hold were closed, not leaked", closed === 4, closed);

  /* -- an encoder restart is a new clock, and the old frames go with it -- */
  closed = 0;
  const held = get("vidPaint.length");
  configure(50);
  ok("configuring a new decoder releases everything the old one queued",
     closed === held && get("vidPaint.length") === 0, closed + " of " + held);

  /* -- a hidden tab holds nothing: rAF will not run to paint it -- */
  clock = 50000;
  out(frame(0));
  closed = 0;
  vm.runInContext("document.hidden = true", ctx);
  out(frame(20));
  ok("a frame arriving while hidden is closed at once and the queue emptied",
     closed === 2 && get("vidPaint.length") === 0, closed);
  ok("it still counts as decoded, because the strain rule weighs decoding, not painting",
     get("vidFrames") >= 2, get("vidFrames"));

  // A tab hidden in the seconds between the socket opening and the first
  // frame. The picture cannot be shown, but the decoder is plainly working and
  // must not be reported as producing nothing.
  configure(50);
  vm.runInContext("document.hidden = true", ctx);
  closed = 0;
  out(frame(0));
  ok("a first picture arriving while hidden still takes over, so the timeout clears",
     get("vidReady") === true && timers.size === 0 && closed === 1 && get("vidPaint.length") === 0);
  vm.runInContext("document.hidden = false", ctx);

  /* -- closing gives every held frame back -- */
  clock = 60000;
  out(frame(0));
  out(frame(20));
  out(frame(40));
  closed = 0;
  const before = get("vidPaint.length");
  vm.runInContext("closeVideo()", ctx);
  ok("closeVideo releases every frame it was holding",
     closed === before && before > 0 && get("vidPaint.length") === 0, closed + " of " + before);
  ok("and stops the paint loop", get("vidRaf") === 0 && rafs.length === 0);
  ok("closing cancels the first-picture timeout", timers.size === 0);

  /* -- a paint loop that wakes up with no decoder lets go and stops -- */
  configure(50);
  clock = 70000;
  out(frame(0));
  closed = 0;
  vm.runInContext("decoder = null", ctx);
  vsync(20);
  ok("a loop that wakes to a dead decoder drops what it held and does not reschedule",
     closed === 1 && get("vidPaint.length") === 0 && rafs.length === 0);

  /* -- the buffer resizes on the loop's own clock -- */
  //
  // A 50 fps stream driven frame by frame: each one is stamped 20 ms after the
  // last on the host and lands `off` milliseconds after that here, which is
  // the only dial a link really has. One display refresh follows each arrival.
  clock = 100000;
  configure(50);
  let epoch = 100000;
  let host = 0;
  const feed = (off) => {
    // Math.max because a link that stalls does not hand the time back: the
    // frames behind the stall arrive in a burst, later than they were stamped.
    clock = Math.max(clock, epoch + host + off);
    out(frame(host));
    host += 20;
    vsync(0);
  };
  // After a stall the driver is behind its own schedule; this puts arrivals
  // back in step with the clock so the next phase means what it says.
  const sync = () => { epoch = clock - host - 50; };

  for (let i = 0; i < 60; i++) feed(50);
  ok("a clean link leaves the buffer at exactly one frame period",
     get("vidDelay") === 20, get("vidDelay"));
  ok("and every frame goes up on time: nothing is late", get("vidLate") === 0);

  // The same rate with 18 ms of arrival noise on it. The buffer grows without
  // waiting for a picture to actually miss its slot - the jitter estimate is
  // the predictive half of the controller.
  for (let i = 0; i < 120; i++) feed(i % 2 ? 68 : 50);
  ok("measured arrival jitter alone grows the buffer",
     get("vidDelay") > 20 && get("vidDelay") <= PACE_CAP_MS, get("vidDelay"));
  ok("and it grows by about the jitter, not to the cap", get("vidDelay") < 50, get("vidDelay"));

  // A link that stalls for 200 ms every dozen frames and then bursts: those
  // frames do miss their slots, which is the reactive half.
  const before2 = get("vidDelay");
  for (let i = 0; i < 120; i++) feed(i % 12 === 0 ? 250 : 50);
  ok("pictures that miss their slots grow it further, up to the cap",
     get("vidDelay") > before2 && get("vidDelay") <= PACE_CAP_MS, get("vidDelay"));

  // And the link calms down again. Twelve seconds of it moves the buffer but
  // does not undo the whole excursion: growing was one decision and shrinking
  // is fifteen, which is the asymmetry the ladder uses and for the ladder's
  // reason - a premature shrink just stalls the picture again.
  const peak = get("vidDelay");
  sync();
  for (let i = 0; i < 600; i++) feed(50);
  const halfway = get("vidDelay");
  ok("twelve calm seconds move it down but nowhere near all the way back",
     halfway < peak && halfway > 20 + PACE_BAND_MS, peak + " to " + halfway);
  ok("nothing was late while it came down", get("vidLate") === 0);
  for (let i = 0; i < 1400; i++) feed(50);
  ok("a link that stays calm gets all of it back, to within a dead band of one frame",
     get("vidDelay") <= 20 + PACE_BAND_MS, get("vidDelay"));
  ok("never below one frame period", get("vidDelay") >= 20, get("vidDelay"));
  ok("and the whole excursion stayed inside the tens of milliseconds",
     peak <= PACE_CAP_MS && PACE_CAP_MS <= 100, peak);
  vm.runInContext("closeVideo()", ctx);

  /* -- the stale-decoder and refusal paths, unchanged in meaning -- */
  configure();
  clock = 90000;
  closed = painted = 0;
  const live = instances[instances.length - 1];
  live.callbacks.output(frame(0));
  vsync(1000);
  ok("a live decoder's frame is painted and closed", painted === 1 && closed === 1);
  const stale = live;
  configure();
  ok("encoder restart restores VNC while waiting", get("rfb.pixels && !vidReady"));
  closed = painted = 0;
  stale.callbacks.output(frame(0));
  vsync(1000);
  ok("stale decoder frames are closed without painting and without being counted",
     painted === 0 && closed === 1);
  [...timers.values()][0]();
  ok("a decoder producing no pictures triggers fallback", downgraded === "not producing frames");

  // A browser that refuses the hardware preference is offered an easier
  // stream before it is offered a slower decoder. Software 1080p60 on a
  // machine that just refused 1080p60 is the worst of the options.
  refuseHw = true;
  opened = 0;
  configure();
  ok("a refused configure asks for a slower pace, still in hardware",
    get("vidStep") === 1 && get("vidSoft") === false && opened === 1, "step " + get("vidStep"));
  configure();
  ok("and again at the next step down", get("vidStep") === 2 && opened === 2);
  configure();
  ok("only at the bottom of the ladder does it drop the hardware preference",
    get("vidSoft") === true && get("vidStep") === 2 && opened === 3);
  const d = instances[instances.length - 1];
  ok("every attempt on the way down asked for hardware",
    d.configs.length === 1 && d.configs[0].hardwareAcceleration === "prefer-hardware");
  ok("nothing was called a decoder error while options remained",
    downgraded === "not producing frames");
  configure();
  const soft = instances[instances.length - 1];
  ok("the retry without the preference is the one that configures",
    soft.configs[0].hardwareAcceleration === "no-preference" && soft.state === "configured");
  // An upgrade the decoder will not take is not a pace problem: the safe codec
  // was carrying this very stream at this very pace seconds ago.
  opened = chose = 0;
  vm.runInContext("vidWant = 'av1'; vidStep = 0; vidSoft = false; vidCodec = '';", ctx);
  vm.runInContext('configureVideo({ codec: "av01.0.08M.08", fps: 60 })', ctx);
  ok("a refused upgrade is struck and handed back, not walked down the ladder",
     ctx.vidBad.has("av1") && get("vidStep") === 0 && get("vidSoft") === false &&
     get("vidWant") === "" && chose === 1 && opened === 1,
     "step " + get("vidStep") + " bad " + Array.from(ctx.vidBad).join());

  refuseHw = false;
  vm.runInContext("vidStep = 0; vidSoft = false;", ctx);
  vm.runInContext("closeVideo()", ctx);
  ok("nothing anywhere in the lifecycle wrote a codec to localStorage", saved === null);

  /* -- the picture that is not the screen it will be drawn on -- */
  // Both, on a host with two 1080p monitors: the framebuffer the canvas is
  // sized to spans both, and the host can only send one. Nothing is built for
  // it - no decoder, no first-picture timeout - and VNC keeps the screen.
  canvas.width = 3840; canvas.height = 1080;
  const built = instances.length;
  offWhy = "";
  vm.runInContext("rfb.pixels = true;", ctx);
  vm.runInContext('configureVideo({ codec: "avc1.64002a", fps: 60, width: 1280, height: 720 })', ctx);
  ok("a picture of one screen for a framebuffer spanning two is refused",
     offWhy === "shape", offWhy);
  ok("and no decoder is built for it", instances.length === built);
  ok("and no first-picture timeout is armed", timers.size === 0);
  ok("VNC keeps the screen it already has", get("rfb.pixels") === true);

  // The same host and the same picture, once the user picks one screen: the
  // framebuffer is that monitor and the rectangles agree, scale and all.
  canvas.width = 1920; canvas.height = 1080;
  offWhy = "";
  vm.runInContext('configureVideo({ codec: "avc1.64002a", fps: 60, width: 1280, height: 720 })', ctx);
  ok("one screen's framebuffer takes one screen's picture, scaled",
     offWhy === "" && instances.length === built + 1);
  vm.runInContext("closeVideo()", ctx);

  // And a host that sent no size at all is still served, because a check with
  // no evidence must not be a check that refuses.
  canvas.width = 3840; canvas.height = 1080;
  offWhy = "";
  vm.runInContext('configureVideo({ codec: "avc1.64002a", fps: 60 })', ctx);
  ok("a config with no picture size is configured as it always was",
     offWhy === "" && instances.length === built + 2);
  vm.runInContext("closeVideo()", ctx);
  canvas.width = 100; canvas.height = 100;
}

/* ---------------------------------------------------------------- upgrade -- */

// D3's other half: the richer codec is reached by earning it, not by being the
// default that has to fail first.
{
  const out = { opened: 0, chose: 0, line: "" };
  const ctx = vm.createContext({
    out, state(_, line) { out.line = line; }, openVideo() { out.opened++; },
    chooseCodecs() { out.chose++; },
    vidUpgraded: false, vidWant: "", vidNote: " at 30 fps after something",
  });
  vm.runInContext(grab("function streamUpgrade(to) {", "\n}\n") + "streamUpgrade('av1');", ctx);
  ok("the upgrade asks the host again, leading with the richer codec",
     ctx.vidWant === "av1" && out.chose === 1 && out.opened === 1);
  ok("and it is spent: one attempt per session", ctx.vidUpgraded === true);
  ok("the state line says what is being tried", /av1/.test(out.line), out.line);
  ok("the old downgrade note is cleared, since this is not a downgrade", ctx.vidNote === "");
}

/* ------------------------------------------------ the picture cap asked for -- */

// video.mjs has taken a ?maxh= cap all along and defaults it to 720 when the
// page sends nothing, which the page never did - so every viewer got 720,
// right for the Chromebook and an unasked-for downgrade for the same person at
// a 1440p desktop. These are the numbers it sends now.
{
  ok("the rows are the presented height in device pixels, not CSS ones",
     streamRows(800, 1080, 2) === 1600, streamRows(800, 1080, 2));
  ok("a ratio of 1 is the plain CSS height", streamRows(720, 1080, 1) === 720);
  ok("a canvas that is not up yet falls back to the screen",
     streamRows(0, 1080, 1) === 1080);
  ok("a missing ratio is 1 and not 0", streamRows(768, 0, 0) === 768);
  ok("nothing known at all answers 0, which asks for the base",
     streamRows(0, 0, 1) === 0);

  // Rows past the framebuffer are rows the host does not have: ddagrab never
  // enlarges, so they come back as the same picture. Measured on this host,
  // asking a 1920x1080 desktop for 1440 returns that same 1920x1080 picture
  // declared avc1.640033 - level 5.1 - where asking for 1080 returns it as
  // avc1.64002a, level 4.2, because video.mjs sizes -level on the cap and not
  // on the picture. So the ask stops at the framebuffer.
  ok("a 1440p screen on a 1080p host asks for what the host has, not what it has",
     streamRows(1440, 1440, 1, 1080) === 1080);
  ok("a retina window cannot ask past the framebuffer either",
     streamRows(900, 900, 2, 1080) === 1080);
  ok("a framebuffer larger than the window does not raise the ask",
     streamRows(720, 1440, 1, 1440) === 720);
  ok("an unknown framebuffer bounds nothing", streamRows(1440, 1440, 1, 0) === 1440);
}

{
  const top = STREAM_HEIGHTS[STREAM_HEIGHTS.length - 1];
  // A proved decoder, so these are the screen's own answers.
  ok("nothing known asks for the host's own default and changes nothing",
     streamHeight(0, top, 0) === 720 && streamHeight(0, top, 0) === STREAM_BASE_HEIGHT);
  ok("a small window asks for the base: below it the bytes saved are few and the text goes",
     streamHeight(480, top, 0) === 720);
  ok("a 1366x768 laptop asks for 720, not the rung above its rows",
     streamHeight(768, top, 0) === 720, streamHeight(768, top, 0));
  ok("a 1080p desktop asks for 1080 - the whole point of this change",
     streamHeight(1080, top, 0) === 1080);
  ok("a 1440p monitor asks for 1440", streamHeight(1440, top, 0) === 1440);
  ok("a 4K panel is clamped to the ladder's top rather than asking for 2160",
     streamHeight(2160, top, 0) === 1440);
  ok("a retina laptop, 900 CSS rows at a ratio of 2, asks for 1440",
     streamHeight(streamRows(900, 900, 2), top, 0) === 1440);

  // The rule that matters more than any of the above. A panel says what can be
  // shown; it does not say what can be decoded.
  ok("a Chromebook with a 1080p panel and nothing proved still asks for 720",
     streamHeight(1080, STREAM_BASE_HEIGHT, 0) === 720);
  ok("and so does the same machine in fullscreen on a 1440p external screen",
     streamHeight(1440, STREAM_BASE_HEIGHT, 0) === 720);
  ok("a machine that proved 1080 gets 1080 of its 1440p screen, not 1440",
     streamHeight(1440, 1080, 0) === 1080);
  ok("an allowed value from nowhere cannot drop the ask below the base",
     streamHeight(1440, 0, 0) === 720 && streamHeight(1440, 240, 0) === 720);
  ok("nor raise it above the ladder", streamHeight(2160, 4320, 0) === 1440);

  // The cap is part of what the host joins two viewers on, so every change to
  // it restarts the encoder. A cap that flaps is worse than one that is
  // slightly wrong.
  ok("a window nudged just under a boundary keeps the rung it is running",
     streamHeight(1040, top, 1080) === 1080, streamHeight(1040, top, 1080));
  ok("a window that really shrank drops a rung",
     streamHeight(1000, top, 1080) === 720, streamHeight(1000, top, 1080));
  ok("and the rung it comes back to is the one it left, so it cannot oscillate",
     streamHeight(1081, top, 720) === 1080 && streamHeight(1079, top, 1080) === 1080);
  ok("stickiness never holds a rung the decoder is not allowed",
     streamHeight(1040, STREAM_BASE_HEIGHT, 1080) === 720);
  ok("and it never blocks a climb: a screen with the rows gets the rung",
     streamHeight(1500, top, 720) === 1440);
}

{
  // What is worth one encoder restart, and what is not.
  ok("one rung at a time, even when the screen could take the top one",
     streamTaller(2160, 720, 0) === 1080);
  ok("then the next, once that one has been carried", streamTaller(2160, 1080, 0) === 1440);
  ok("and then nothing: the ladder has a top", streamTaller(2160, 1440, 0) === 0);
  ok("never past what the screen itself asks for",
     streamTaller(1080, 1080, 0) === 0 && streamTaller(900, 720, 0) === 0);
  ok("a 1440p screen climbs to 1080 first and not straight to 1440",
     streamTaller(1440, 720, 0) === 1080);
  ok("a size this session had refused is not asked for again",
     streamTaller(2160, 720, 1080) === 0);
  ok("but the rungs below the refused one are still reachable",
     streamTaller(2160, 720, 1440) === 1080);
  ok("no cap running yet is the base, not zero", streamTaller(1440, 0, 0) === 1080);
}

{
  // The remembered cap is a claim about the decoder, so it is believed only
  // when it names a rung.
  ok("a remembered rung is believed", streamProven("1080") === 1080 && streamProven(1440) === 1440);
  ok("nothing remembered is the base", streamProven("") === 720 && streamProven(null) === 720);
  ok("a value that is not a rung is not believed",
     streamProven("2160") === 720 && streamProven("900") === 720 && streamProven("yes") === 720);
}

// W7's rectangle guard sizes its tolerance on the even-truncation the host's
// scale does, and a new cap changes the picture's dimensions - so every rung
// this page can now ask for has to still pass it. The picture below is
// computed the way ffmpegArgs computes it: a 16:9 box of the cap's height, the
// desktop fitted inside with its aspect ratio kept and never enlarged, both
// sides truncated to even for the chroma planes.
{
  const hostPicture = (fbW, fbH, capH) => {
    const capW = Math.round(capH * 16 / 9) - (Math.round(capH * 16 / 9) % 2);
    const fit = Math.min(1, Math.min(capW / fbW, capH / fbH));
    return [Math.trunc(fbW * fit / 2) * 2, Math.trunc(fbH * fit / 2) * 2];
  };
  const skew = (w, h, fbW, fbH) => Math.abs((w / h) / (fbW / fbH) - 1);
  const screens = [[2560, 1440], [1920, 1080], [3440, 1440], [1600, 900], [1366, 768]];
  let worst = 0, allOk = true, shrinks = true;
  for (const [fbW, fbH] of screens) {
    let last = Infinity;
    for (const cap of STREAM_HEIGHTS) {
      const [w, h] = hostPicture(fbW, fbH, cap);
      if (!streamRectOk(w, h, fbW, fbH)) allOk = false;
      const e = skew(w, h, fbW, fbH);
      worst = Math.max(worst, e);
      // Truncating to even costs less of a larger picture, so a taller cap can
      // only move the shape closer to the framebuffer's, never further.
      if (e > last + 1e-12) shrinks = false;
      last = e;
    }
  }
  ok("every rung of the new cap passes the rectangle guard on every shape", allOk);
  ok("and the worst shape error is well inside the tolerance",
     worst < RECT_SKEW / 5, worst.toFixed(5) + " vs " + RECT_SKEW);
  ok("a taller cap can only shrink that error, so growing cannot trip the guard", shrinks);
  ok("the guard still refuses a picture of one monitor drawn over two, at any rung",
     STREAM_HEIGHTS.every((cap) => {
       const [w, h] = hostPicture(1920, 1080, cap);
       return streamRectOk(w, h, 3840, 1080) === false;
     }));
}

// The one failure this whole change must not cause: a decoder handed a picture
// it will not configure. It is caught where the codec refusals are caught, and
// answered the same way.
{
  const mk = (over) => {
    const out = { opened: 0, paced: 0, line: "", saved: "" };
    const ctx = vm.createContext(Object.assign({
      out, state(_, line) { out.line = line; }, openVideo() { out.opened++; },
      chooseCodecs() {}, streamPace() { out.paced++; }, streamDowngrade() {},
      streamFamily, streamNext, STREAM_HEIGHTS, STREAM_BASE_HEIGHT, STREAM_STEPS,
      HEIGHT_KEY: "cast.maxh",
      localStorage: { setItem(k, v) { out.saved = k + "=" + v; }, getItem: () => null },
      vidBad: new Set(), vidSupported: [true, true, true],
      vidCodec: "avc1.64002a", vidWant: "", vidNote: "", vidSoft: true, vidStep: 0,
      vidMaxh: 720, vidMaxhWant: 0, vidMaxhBad: 0, vidMaxhOk: 720,
    }, over));
    vm.runInContext(grab("function streamRefused(detail) {", "\n}\n") +
                    "streamRefused('unsupported configuration');", ctx);
    return { ctx, out };
  };

  const tall = mk({ vidMaxh: 1080, vidMaxhWant: 1080 });
  ok("a taller picture refused is struck, and nothing that tall is asked for again",
     tall.ctx.vidMaxhBad === 1080 && tall.ctx.vidMaxhWant === 0);
  ok("the ask goes back to the rung that was carrying the stream seconds ago",
     tall.ctx.vidMaxhOk === 720);
  ok("the refusal is remembered, so the next visit does not pay for it again",
     tall.out.saved === "cast.maxh=720", tall.out.saved);
  ok("and the host is asked again at once", tall.out.opened === 1);
  ok("the pace ladder is not walked for it: the frames were never the problem",
     tall.out.paced === 0);
  ok("nor is the codec blamed for it", tall.ctx.vidBad.size === 0);
  ok("the state line names the size", /1080p refused/.test(tall.out.line), tall.out.line);

  // The same refusal with no size upgrade in flight must still do what it did.
  const paced = mk({ vidMaxhWant: 1440 });
  ok("a taller ask that is not the one running does not answer for this refusal",
     paced.ctx.vidMaxhBad === 0 && paced.out.paced === 1 && paced.out.opened === 0);
}

// The other half: a taller picture is reached by earning it, exactly as the
// richer codec above is, and never by being handed it on the strength of a
// panel.
{
  const grow = (over) => {
    const out = { opened: 0, line: "" };
    const ctx = vm.createContext(Object.assign({
      out, state(_, line) { out.line = line; }, openVideo() { out.opened++; },
      streamTaller, STREAM_HEIGHTS, STREAM_BASE_HEIGHT,
      vidRows: () => 2160, vidMaxh: 720, vidMaxhBad: 0, vidMaxhWant: 0,
      vidSoft: false, vidNote: " at 30 fps after something",
    }, over));
    vm.runInContext(grab("function streamGrow() {", "\n}\n") + "streamGrow();", ctx);
    return { ctx, out };
  };

  const up = grow({});
  ok("a cap that has been carried earns the next rung, one at a time",
     up.ctx.vidMaxhWant === 1080 && up.out.opened === 1);
  ok("the state line says what is being tried", /1080p/.test(up.out.line), up.out.line);
  ok("and the old downgrade note is cleared, since this is not a downgrade",
     up.ctx.vidNote === "");

  const soft = grow({ vidSoft: true });
  ok("a decoder already running in software is not handed twice the pixels",
     soft.ctx.vidMaxhWant === 0 && soft.out.opened === 0);

  const small = grow({ vidRows: () => 900 });
  ok("a screen that cannot paint the next rung is not restarted for it",
     small.ctx.vidMaxhWant === 0 && small.out.opened === 0);

  const struck = grow({ vidMaxhBad: 1080 });
  ok("and a rung this session had refused is not asked for a second time",
     struck.ctx.vidMaxhWant === 0 && struck.out.opened === 0);
}

// Changing the cap restarts the encoder, so a window being dragged must not
// change it fifty times on the way.
{
  const out = { opened: 0, line: "" };
  const timers = new Map();
  let nextTimer = 0, handler = null, ctx = null;
  ctx = vm.createContext({
    out,
    window: { addEventListener(type, fn) { if (type === "resize") handler = fn; } },
    setTimeout(fn, ms) { timers.set(++nextTimer, [fn, ms]); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    state(_, line) { out.line = line; }, openVideo() { out.opened++; },
    // Stands in for the canvas measuring itself: the test says what the next
    // measurement would land on.
    chooseHeight() { vm.runInContext("vidMaxh = next", ctx); },
  });
  vm.runInContext("let vidSock = {}, vidReady = true, vidMaxh = 720, vidMaxhTimer = 0, next = 720;", ctx);
  vm.runInContext(grab("const HEIGHT_SETTLE_MS = ", "\n"), ctx);
  vm.runInContext(grab('window.addEventListener("resize", () => {', "\n});\n"), ctx);
  const drag = (n) => { for (let i = 0; i < n; i++) handler(); };
  const settle = () => {
    const due = Array.from(timers.values());
    timers.clear();
    due.forEach(([fn]) => fn());
  };

  ok("the page listens for the window changing size at all", typeof handler === "function");
  drag(40);
  ok("forty resize events in a drag arm one ask, not forty",
     timers.size === 1 && out.opened === 0);
  ok("and it waits for the drag to stop before asking",
     Array.from(timers.values())[0][1] === vm.runInContext("HEIGHT_SETTLE_MS", ctx));
  settle();
  ok("a window that settled back on the rung it had renegotiates nothing",
     out.opened === 0 && vm.runInContext("vidMaxh", ctx) === 720);

  vm.runInContext("next = 1080", ctx);
  drag(3);
  settle();
  ok("a window that really changed rung asks the host again, once",
     out.opened === 1 && vm.runInContext("vidMaxh", ctx) === 1080);
  ok("and says why the picture restarted", /1080p/.test(out.line), out.line);

  vm.runInContext("vidSock = null; next = 720", ctx);
  drag(5);
  ok("with no stream running there is nothing to renegotiate and no timer left",
     timers.size === 0 && out.opened === 1);
}

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

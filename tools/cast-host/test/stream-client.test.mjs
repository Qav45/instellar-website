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
const { LAG_QUEUE, STREAM_CODECS, STRAIN_DROPS, STRAIN_DROP_MS, STRAIN_RATIO, STRAIN_SLOW_MS,
        parseVideoFrame, streamGate, streamReason, streamCodecs, streamFamily, streamSlow, streamStrain } = vm.runInContext(
  grab("const LAG_QUEUE = ", ";\n") +
  // These four carry a trailing comment, so the line end is the marker.
  grab("const STRAIN_DROPS = ", "\n") +
  grab("const STRAIN_DROP_MS = ", "\n") +
  grab("const STRAIN_RATIO = ", "\n") +
  grab("const STRAIN_SLOW_MS = ", "\n") +
  grab("const STREAM_CODECS = ", ";\n") +
  grab("function parseVideoFrame(buf) {", "\n}\n") +
  grab("function streamGate(waitKey, key, queued) {", "\n}\n") +
  grab("function streamReason(why, code, reason) {", "\n}\n") +
  grab("function streamCodecs(supported, bad = [], first = \"\") {", "\n}\n") +
  grab("function streamFamily(codec) {", "\n}\n") +
  grab("function streamSlow(deliveredFps, decodedFps) {", "\n}\n") +
  grab("function streamStrain(drops, now, slowMs) {", "\n}\n") +
  "({ LAG_QUEUE, STREAM_CODECS, STRAIN_DROPS, STRAIN_DROP_MS, STRAIN_RATIO, STRAIN_SLOW_MS," +
  " parseVideoFrame, streamGate, streamReason, streamCodecs, streamFamily, streamSlow, streamStrain });",
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

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

// The adaptive-fps feature, both ends of it.
//
// Half A is the viewer's rung controller, cut out of cast/index.html and run under
// node:vm the way viewer.test.mjs does it. Half B is the host's side: the bridge
// keeping a FramebufferUpdateRequest outstanding on the viewer's behalf, so that the
// viewer's round trip stops being the frame period.
//
// Half B is worth booting a real host for rather than unit-testing the injector,
// because every interesting thing about it is an interaction: it must not fire while
// the VNC socket is still connecting, must not fire into a socket that is already
// behind, and above all must not fire between two halves of a fragmented client
// message - which would splice ten bytes into the middle of another RFB message and
// desynchronise the server for the rest of the session. None of those are visible
// from inside the function. All of them are visible from the far end of the wire,
// which is what this does: a stand-in VNC that records every byte it is handed.
//
// Nothing here contacts the live site (--tunnel none) and nothing captures a screen:
// the stand-in speaks RFB's greeting and then only ever counts bytes.
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOST_SCRIPT = fileURLToPath(new URL("../cast-host.mjs", import.meta.url));
const REPO = path.dirname(HOST_SCRIPT);
const VNC_PORT = 59041, PORT = 60841;

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/* == Half A - the viewer's rung controller, assertions 1-8 ================= */
/* ========================================================================== */
//
// The controller decides what the cast looks like and it decides it slowly - six
// seconds to climb, ninety to forgive a ceiling - so its failures are the kind
// nobody can reproduce on demand and nobody can attribute. A rung that oscillates
// looks like "the wifi"; a controller that walks an idle desktop to the floor
// looks like "it's slow when I come back to it". Simulated time is the only way
// to see any of it, so time here is a number this file increments.
//
// The real source, cut out of cast/index.html by the same source-text grab
// viewer.test.mjs uses, so a rename fails loudly rather than quietly testing a
// copy that has drifted from the page.

const PAGE = fileURLToPath(new URL("../../../cast/index.html", import.meta.url));
const pageSrc = fs.readFileSync(PAGE, "utf8").replace(/\r\n/g, "\n");
const grabPage = (from, to) => {
  const a = pageSrc.indexOf(from);
  if (a < 0) throw new Error("cast/index.html no longer contains: " + from);
  const b = pageSrc.indexOf(to, a + from.length);
  if (b < 0) throw new Error("no end marker after: " + from);
  return pageSrc.slice(a, b + to.length) + "\n";
};

// Builds one controller with everything it reaches for outside itself stubbed,
// and hands back a way to run a second through it. `weak` picks which branch of
// the WEAK guess the page takes, since that is what sets the opening rung.
function controller({ weak = false } = {}) {
  let clock = 0;
  const rungs = [];        // every rung applyQuality was called at
  const streamed = [];     // every rate handed to pushStream
  const box = {
    performance: { now: () => clock },
    navigator: { hardwareConcurrency: weak ? 2 : 16, deviceMemory: weak ? 4 : 32 },
    rfb: {},                                   // a live session; only truthiness is read
    endpoint: "wss://host/ws?k=x",
    stats: { rtt: 20, floor: 20, window: 0, mbps: 0 },
    metrics: { fps: 0, duty: 0, streamHz: 0, backlogBytes: 0, pollMs: 30, rung: 0, ceiling: 0 },
    screenEl: { querySelector: () => ({ width: 1920, height: 1080 }) },
    document: { hidden: false },               // a hidden tab hands the rate over
    picked: "auto",                            // what the Quality dropdown says
    $: (id) => (id === "quality" ? { get value() { return box.picked; } } : null),
    applyQuality() { rungs.push(sim.rung()); },
    pushStream() { streamed.push(sim.want()); },
  };
  vm.createContext(box);

  // Lexical declarations stay inside the script, so hand them back as a value -
  // viewer.test.mjs:31-37 does the same. streamWant lives further down the page,
  // past the slice we want, so supply it rather than dragging the network half in.
  const sim = vm.runInContext(
    grabPage("const RUNGS = [", "const RATES = [0, 5, 10, 15, 20, 30];") +
    grabPage("const WEAK = (navigator.hardwareConcurrency", ";\n") +
    grabPage("const UP_DWELL = ", "  stepUp(manual);\n}\n") +
    grabPage("function rungForPreset(value) {", "\n}\n") +
    "let streamWant = 0, hiddenWant = -1;\n" +
    // The visibility handler is a few hundred lines further down and reaches for
    // half the page around it, so take the four lines that decide the rate and
    // leave the focus and retry half where it is.
    "function visibility() {\n" +
    grabPage("  if (rfb) {\n    if (document.hidden) {", "    pushStream();\n  }\n") +
    "}\n" +
    "({ govern, setRung, setRate, onFrame, rungForPreset, visibility,\n" +
    "   RUNGS, RATES, TOP, WEAK,\n" +
    "   rung: () => rung, ceiling: () => ceilingRung,\n" +
    "   up: () => upHold, down: () => downHold, want: () => streamWant,\n" +
    "   held: () => hiddenWant });",
    box);

  // One simulated second: hand the governor `fps` frames that between them cost
  // `duty` of the second and carried `bytes`, then tick the clock and let it
  // decide. Nothing sleeps; the whole suite is arithmetic.
  const second = (o = {}) => {
    const fps = o.fps || 0, duty = o.duty || 0, backlog = o.backlog || 0;
    const bytes = o.bytes === undefined ? 400000 : o.bytes;
    box.stats.rtt = o.rtt === undefined ? 20 : o.rtt;
    box.stats.floor = o.floor === undefined ? 20 : o.floor;
    // The host acknowledges whatever was last asked of it - which is streamWant,
    // not the rung's rate: in manual mode the controller cuts the rate without
    // moving the rung, and reading the rung there would have the page judging
    // itself against a rate it deliberately stopped asking for.
    box.metrics.streamHz = o.streamHz === undefined ? sim.want() : o.streamHz;
    if (o.pollMs !== undefined) box.metrics.pollMs = o.pollMs;
    const n = Math.round(fps);
    for (let i = 0; i < n; i++) {
      sim.onFrame({ duration: (duty * 1000) / n, bytes: bytes / n,
                    backlog, continuous: !!o.continuous });
    }
    // Bytes with no completed frame is one big slow update, which is motion even
    // though nothing finished. Only a second with neither is a still screen.
    if (!n && bytes) {
      sim.onFrame({ duration: duty * 1000, bytes, backlog, continuous: !!o.continuous });
    }
    clock += 1000;
    sim.govern(1);
  };
  // What the connect handler does once the canvas exists: ask for the opening
  // rung's rate. Without it the controller would spend its first seconds judging
  // itself against a rate nobody had requested.
  sim.setRate(sim.RUNGS[sim.rung()].hz);
  return { sim, second, rungs, streamed, box };
}

/* ------------------------------------------------- 1. the climb, 4 -> 5 -> 6 -- */
{
  const { sim, second } = controller({ weak: true });
  ok("a weak device opens at rung 4", sim.rung() === 4, "rung " + sim.rung());

  const roomy = { duty: 0.30, backlog: 0, rtt: 22, floor: 20 };
  for (let i = 0; i < 5; i++) second({ ...roomy, fps: 15 });   // rung 4 is 15 Hz
  ok("five clean seconds are not enough to climb", sim.rung() === 4, "rung " + sim.rung());
  second({ ...roomy, fps: 15 });
  ok("the sixth clean second climbs 4 -> 5", sim.rung() === 5, "rung " + sim.rung());
  ok("one rung at a time, never two", sim.rung() === 5);

  for (let i = 0; i < 6; i++) second({ ...roomy, fps: 20 });   // rung 5 is 20 Hz
  ok("and 5 -> 6 after another six", sim.rung() === 6, "rung " + sim.rung());
}

/* ------------------------------------------------------------- 2. the drop -- */
{
  const { sim, second } = controller();
  ok("a capable device opens at rung 6", sim.rung() === 6, "rung " + sim.rung());
  second({ fps: 30, duty: 0.95 });
  ok("one stalled second does not drop yet", sim.rung() === 6, "rung " + sim.rung());
  second({ fps: 30, duty: 0.95 });
  ok("two stalled seconds drop a rung on duty > 0.85", sim.rung() === 5, "rung " + sim.rung());
}

/* ------------------------------------------ 3. hard drop, and the kill switch -- */
{
  const { sim, second } = controller();
  second({ fps: 30, duty: 0.4, backlog: 3 * 1024 * 1024 });
  ok("a 3 MB backlog drops two rungs with no dwell", sim.rung() === 4, "rung " + sim.rung());
}
{
  // 8 MB is five times below the 40 MB receive-queue cap where Websock throws and
  // takes the session with it. Getting there means asking for frames has become
  // the problem, so the only useful move is to stop asking.
  const { sim, second, streamed } = controller();
  second({ fps: 30, duty: 0.4, backlog: 9 * 1024 * 1024 });
  ok("a 9 MB backlog hits the kill switch: rung 0", sim.rung() === 0, "rung " + sim.rung());
  ok("and asks the host to stop streaming", streamed[streamed.length - 1] === 0,
     "last stream=" + streamed[streamed.length - 1]);
  for (let i = 0; i < 40; i++) second({ fps: 5, duty: 0.1, backlog: 0 });
  ok("and will not climb again inside the cooldown", sim.rung() === 0, "rung " + sim.rung());
}

/* ------------------------------------------- 4. the ceiling after a failed climb -- */
{
  const { sim, second } = controller();
  for (let i = 0; i < 6; i++) second({ fps: 30, duty: 0.3, backlog: 0 });
  ok("climbed to the top rung", sim.rung() === 7, "rung " + sim.rung());
  second({ fps: 30, duty: 0.95 });
  second({ fps: 30, duty: 0.95 });
  ok("a stall drops it back off the top", sim.rung() === 6, "rung " + sim.rung());
  ok("and latches the ceiling below the rung that failed", sim.ceiling() === 6,
     "ceiling " + sim.ceiling());
  for (let i = 0; i < 30; i++) second({ fps: 30, duty: 0.3, backlog: 0 });
  ok("the ceiling holds while its timer runs", sim.rung() === 6, "rung " + sim.rung());
  // ...and then lets go, on a plain timer rather than on a count of clean
  // seconds that every rung change used to reset. A link that recovered gets its
  // rung back; one that did not simply fails the same climb again.
  for (let i = 0; i < 45; i++) second({ fps: 30, duty: 0.3, backlog: 0 });
  ok("and decays so a recovered link can try again", sim.ceiling() === 7,
     "ceiling " + sim.ceiling());
}

/* --------------------------------- 5. the one that matters: no oscillation -- */
{
  // Clean at rung 5 and below, stalled at 6 and above - the exact shape that made
  // the old RTT tuner saw between two pictures every eight seconds for a whole
  // session. The first stall at the opening rung must NOT latch a ceiling (it was
  // never climbed into), so the controller has to discover the limit by trying it
  // once and then remember it.
  const { sim, second } = controller();
  const changes = [];
  let last = sim.rung();
  for (let s = 0; s < 200; s++) {
    const bad = sim.rung() >= 6;
    second(bad ? { fps: 30, duty: 0.95 }
               : { fps: sim.RUNGS[sim.rung()].hz, duty: 0.3, backlog: 0 });
    if (sim.rung() !== last) { changes.push(s + ":" + last + "->" + sim.rung()); last = sim.rung(); }
  }
  // Dropping the exponential cooldown buys a fixed re-probe cadence instead of a
  // lengthening one, so the bound is a handful of changes over three minutes
  // rather than the two the doubling gave. That is still a rung a minute at
  // worst, against the eight-second saw this exists to prevent.
  const late = changes.filter((c) => +c.split(":")[0] >= 50);
  ok("a marginal link settles instead of oscillating",
     late.length <= 6, late.length + " changes after tick 50: " + (late.join(" ") || "none"));
  ok("and settles below the rung that could not hold", sim.rung() <= 5, "rung " + sim.rung());
  ok("having tried the failing rung rather than assuming it", changes.length >= 2,
     changes.join(" "));
}

/* ----------------------------------------------------------- 6. the idle trap -- */
{
  // A still desktop delivers nothing forever. Read as "the link cannot sustain
  // this" it walks to the floor, and then hands over the worst picture it has the
  // moment somebody moves a window - which is precisely when they are looking.
  const { sim, second } = controller();
  const start = sim.rung();
  for (let i = 0; i < 60; i++) second({ fps: 0, bytes: 0, duty: 0, backlog: 0 });
  ok("an idle desktop moves nothing for a minute", sim.rung() === start, "rung " + sim.rung());
  ok("and leaves both dwell counters where they were",
     sim.up() === 0 && sim.down() === 0, "up " + sim.up() + " down " + sim.down());
}

/* -------------------------------------------------------- 7. hosts that cannot -- */
{
  // A host with no stream lever never acknowledges a rate, so the rate tests must
  // abstain and this must stay a quality controller - today's behaviour - rather
  // than reading a shortfall against a promise nobody made.
  const { sim, second } = controller();
  for (let i = 0; i < 30; i++) {
    second({ fps: 15, duty: 0.3, backlog: 0, streamHz: 0 });
  }
  ok("a host with no stream lever is not walked down", sim.rung() >= 6, "rung " + sim.rung());
}
{
  // An untuned host polls the screen once a second and so sends one frame a
  // second whatever is asked of it. Measuring that against 30 Hz reads as a
  // permanent stall and gives away quality for a reason that has nothing to do
  // with quality.
  const { sim, second } = controller();
  for (let i = 0; i < 20; i++) second({ fps: 1, duty: 0.03, backlog: 0, pollMs: 1000 });
  ok("a 1000 ms host poll is not mistaken for a stall", sim.rung() >= 6, "rung " + sim.rung());
}

/* ------------------------------------------------- 8. RTT is a veto, not a driver -- */
{
  const { sim, second } = controller();
  for (let i = 0; i < 20; i++) second({ fps: 30, duty: 0.2, backlog: 0, rtt: 60, floor: 20 });
  ok("queueing above 30 ms blocks a climb", sim.rung() === 6, "rung " + sim.rung());
  for (let i = 0; i < 3; i++) second({ fps: 30, duty: 0.2, backlog: 0, rtt: 120, floor: 20 });
  ok("and above 80 ms is a reason to drop", sim.rung() === 5, "rung " + sim.rung());
}

/* ------------------------------------------------- 9. a person holds the wheel -- */
{
  const { sim, second, box } = controller();
  ok("Sharp names the top rung", sim.rungForPreset("9,3") === 7, String(sim.rungForPreset("9,3")));
  ok("Balanced names the fastest rung sharing its pair", sim.rungForPreset("6,5") === 6,
     String(sim.rungForPreset("6,5")));
  ok("Fast names the fastest rung sharing its pair", sim.rungForPreset("3,7") === 3,
     String(sim.rungForPreset("3,7")));

  // Pinning fixes the quality. It does not hand the controller a device it must
  // watch drown: injecting 30 Hz into something that cannot decode it is the
  // page's doing, so a stall still moves the rate - the one dial the person did
  // not pin. Without that, nothing at all intervened until the receive queue hit
  // 8 MB, which is seconds of frozen picture, and the kill switch then dropped
  // the quality to 3 while the dropdown went on reading "Sharp".
  box.picked = "9,3";
  sim.setRung(sim.rungForPreset("9,3"));
  sim.setRate(30);
  for (let i = 0; i < 4; i++) second({ fps: 30, duty: 0.95, backlog: 300 * 1024 });
  ok("a pinned quality is never changed by the controller", sim.rung() === 7,
     "rung " + sim.rung());
  ok("but a stall still cuts the rate it is being sent at",
     sim.want() < 30 && sim.want() > 0, "stream " + sim.want() + " Hz");
  const cut = sim.want();
  for (let i = 0; i < 20; i++) second({ fps: cut, duty: 0.2, backlog: 0 });
  ok("and calm gives the rate back without touching quality",
     sim.want() > cut && sim.rung() === 7, "stream " + sim.want() + " Hz, rung " + sim.rung());
  // The kill switch runs in both modes - a queue heading for the cap is not a
  // matter of taste - but in manual it takes the rate to zero and leaves the
  // picture the person chose alone.
  second({ fps: 30, duty: 0.2, backlog: 9 * 1024 * 1024 });
  ok("the kill switch fires while pinned, on the rate",
     sim.want() === 0 && sim.rung() === 7, "stream " + sim.want() + ", rung " + sim.rung());
}

/* ------------------------------------- 10. hosts whose ceiling is not ours -- */
{
  // F4. pollMs is 0 on every host nobody has run tune-host.cmd on - the one
  // frame a second case this whole change is aimed at. Reading that as "no
  // ceiling" measured 1 FPS against 30, called it 97% short, and walked the
  // ladder to rung 0 and pinned it there: 1 FPS *and* the cheapest picture,
  // where the old RTT tuner had at least given it a sharp one.
  // Eight frames a second, not one: enough to clear the "did the host have
  // frames to send" guard below, so this is measuring the ceiling rule and not
  // that one. The host simply cannot go faster than eight, and has no recorded
  // poll interval to say so.
  const { sim, second } = controller();
  const opened = sim.rung();
  let lowest = opened;
  for (let i = 0; i < 40; i++) {
    second({ fps: 8, duty: 0.05, backlog: 0, bytes: 400000, pollMs: 0 });
    if (sim.rung() < lowest) lowest = sim.rung();
  }
  ok("an untuned host is never walked below its opening rung",
     lowest === opened, "fell to " + lowest + " from " + opened);
  ok("and can still climb, because quality is not what is short",
     sim.rung() === 7, "rung " + sim.rung());
}
{
  // F5. One big update a second clears the motion gate with n = 1, and at 30 Hz
  // that reads as 97% short - so a photo viewer, a video stepped frame by frame
  // or a slow scroll through images cost a rung every two seconds and dragged
  // the ceiling down with them. A shortfall is only evidence about the rate when
  // the host actually had frames to send.
  const { sim, second } = controller();
  for (let i = 0; i < 6; i++) second({ fps: 30, duty: 0.3, backlog: 0 });
  const before = sim.rung();
  for (let i = 0; i < 30; i++) second({ fps: 1, duty: 0.1, backlog: 0, bytes: 200000 });
  ok("one 200 KB update a second does not walk the ladder down",
     sim.rung() >= before, "rung " + sim.rung() + ", was " + before);
  ok("and does not drag the ceiling down with it", sim.ceiling() === 7,
     "ceiling " + sim.ceiling());
}

/* ---------------------------------------- 11. the two branches that must not stick -- */
{
  // F8. A background tab's timers fire about once a minute, so every rule here
  // would evaluate once a minute while the bridge kept injecting. The rate is
  // handed to the visibilitychange handler while hidden, and govern must not
  // fight it for the tick or two before the tab is throttled.
  const { sim, second, box } = controller();
  box.document.hidden = true;
  const held = sim.rung();
  for (let i = 0; i < 20; i++) second({ fps: 30, duty: 0.95, backlog: 300 * 1024 });
  ok("a hidden tab makes no rung decisions", sim.rung() === held, "rung " + sim.rung());
  box.document.hidden = false;
  for (let i = 0; i < 2; i++) second({ fps: 30, duty: 0.95, backlog: 300 * 1024 });
  ok("and the rules resume the moment it is looked at again",
     sim.rung() === held - 1, "rung " + sim.rung());
}
{
  // N5. What comes back on the way in is the rate that was in force, not the
  // rung's rate. Those differ exactly where it matters: in manual mode the rung
  // is whatever the person pinned and the rate is the only dial the controller
  // owns, so restoring the rung's rate handed a session that had been cut back
  // to 20 Hz its full 30 again because somebody changed tabs.
  const { sim, second, box } = controller();
  box.picked = "9,3";
  sim.setRung(sim.rungForPreset("9,3"));
  sim.setRate(30);
  for (let i = 0; i < 4; i++) second({ fps: 30, duty: 0.95, backlog: 300 * 1024 });
  const cut = sim.want();
  ok("a stall cut the rate under a pinned quality", cut > 0 && cut < 30,
     "stream " + cut);

  box.document.hidden = true;
  sim.visibility();
  ok("a hidden tab hands the rate back", sim.want() === 0 && sim.held() === cut,
     "stream " + sim.want() + ", holding " + sim.held());
  box.document.hidden = false;
  sim.visibility();
  ok("...and coming back restores that rate, not the pinned rung's",
     sim.want() === cut, "stream " + sim.want());

  // And the one rule that runs while hidden has to be able to overrule it, or a
  // tab switch would undo the kill switch.
  box.document.hidden = true;
  sim.visibility();
  second({ fps: 30, duty: 0.2, backlog: 9 * 1024 * 1024 });
  box.document.hidden = false;
  sim.visibility();
  ok("the kill switch is not undone by coming back", sim.want() === 0,
     "stream " + sim.want());
}
{
  // F9. continuous was not cleared in the drain, so one frame from a server that
  // pushes its own updates latched the branch true for the life of the session
  // and held the rate at zero for ever after.
  const { sim, second } = controller();
  second({ fps: 5, duty: 0.1, backlog: 0, continuous: true });
  ok("a continuous-update server stops us asking", sim.want() === 0,
     "stream " + sim.want());
  // The stickiness only shows on a tick with no frames at all, because every
  // frame re-asserts the flag either way. Ask again, then let a quiet second go
  // by: undrained, the flag takes the rate straight back to zero.
  sim.setRate(30);
  second({ fps: 0, bytes: 0 });
  ok("and the flag does not survive a second with no frames", sim.want() === 30,
     "stream " + sim.want());
}

/* ---------------------------------------- 8b. the rate lever and its backoff -- */
// pushStream is the only thing that ever tells the host a rate, and every call
// site is an event - a rung change, connect, disconnect. That is what makes the
// two rules here matter more than they look. A failed call must not retry itself:
// it used to, out of its own tail, at full speed with no delay, so a host going
// away left a fetch loop running for the life of the tab behind a card reading
// "Host offline". And a failed call must not be forgotten either, or the page
// believes nothing is streaming - which quietly takes the deficit rule out of
// service - while the bridge goes on injecting at the rate it was last given.
// The once-a-second reconcile in the tick is what closes that.

function rateLever() {
  let clock = 0;
  const calls = [];
  let reply = () => Promise.reject(new Error("ERR_NAME_NOT_RESOLVED"));
  const box = {
    performance: { now: () => clock },
    // The page names its own tab in the URL it opens the socket with, and ctlUrl
    // is built from that same string, so every control call carries it.
    endpoint: "wss://host/ws?k=x&v=tab1",
    metrics: { streamHz: 0, pollMs: 0 },
    screenEl: { querySelector: () => ({ width: 1920, height: 1080 }) },
    fetch: (url) => { calls.push(url); return reply(url); },
  };
  vm.createContext(box);
  const api = vm.runInContext(
    grabPage("let streamWant = 0;",
             "  if (!failed && streamWant !== streamSent) pushStream();\n}\n") +
    // The governor's, not the lever's, but the reset below touches them.
    "let bestFps = 0, prevBacklog = 0;\n" +
    // Both of these are lines out of the page rather than a paraphrase of them:
    // what is being tested is that connect() forgets the last host, and that the
    // tick reconciles - so if either moves, this has to notice.
    "function reconnect() {\n" +
    grabPage("  streamSent = -1;\n  streamOk = true;", "  metrics.pollMs = 0;\n") +
    "}\n" +
    "function tickOnce() {\n" +
    grabPage("  if (streamWant !== streamSent) pushStream();", "\n") +
    "}\n" +
    "({ pushStream, reconnect, tickOnce,\n" +
    "   want: (v) => (v === undefined ? streamWant : (streamWant = v)),\n" +
    "   sent: () => streamSent, ok: () => streamOk, fails: () => streamFails,\n" +
    "   retryAt: () => streamRetryAt });",
    box);
  return { api, calls, at: (ms) => { clock = ms; }, answer: (fn) => { reply = fn; } };
}

// A host that answers the way a current one does.
const answers = (stream) => async () => ({
  ok: true,
  json: async () => ({ ok: true, stream, w: 1920, h: 1080, pollMs: 30 }),
});

{
  const { api, calls, at, answer } = rateLever();

  api.want(20);
  await api.pushStream();
  ok("a failed rate call does not retry out of its own tail", calls.length === 1,
     calls.length + " calls");
  ok("...and stops claiming a rate nobody acknowledged", api.sent() === -1,
     "sent " + api.sent());
  ok("...and waits a second before the next attempt", api.retryAt() === 1000,
     "retryAt " + api.retryAt());

  await api.pushStream();
  ok("a call inside the backoff does not go out", calls.length === 1,
     calls.length + " calls");

  at(1000); await api.pushStream();
  ok("the wait doubles on the second failure", api.retryAt() === 3000,
     "retryAt " + api.retryAt());
  at(3000); await api.pushStream();
  ok("...and on the third", api.retryAt() === 7000, "retryAt " + api.retryAt());

  let t = 3000;
  for (let i = 0; i < 8; i++) { t = api.retryAt(); at(t); await api.pushStream(); }
  ok("and never waits longer than half a minute", api.retryAt() - t === 30000,
     "waiting " + (api.retryAt() - t) + " ms");
  ok("eleven attempts over eleven failures, not eleven thousand",
     calls.length === 11 && api.fails() === 11, calls.length + " calls");
  ok("every control call names this tab", calls.every((u) => u.includes("v=tab1")),
     calls[0]);

  // N1. The tick is what tries again, and only once its backoff has run.
  answer(answers(20));
  const before = calls.length;
  api.tickOnce();
  await sleep(5);
  ok("a tick inside the backoff sends nothing", calls.length === before,
     calls.length - before + " calls");
  at(api.retryAt());
  api.tickOnce();
  await sleep(5);
  ok("and the tick after it reconciles the rate the ladder wants",
     calls.length === before + 1 && api.sent() === 20, "sent " + api.sent());

  // F6. A host that predates the lever, and then a different one.
  answer(async () => ({ ok: true, json: async () => ({ ok: true, share: "primary" }) }));
  api.want(10);
  await api.pushStream();
  ok("a host with no stream field is asked once and then left alone",
     api.ok() === false && api.sent() === 0, "ok " + api.ok() + " sent " + api.sent());
  const quiet = calls.length;
  api.want(30);
  api.tickOnce();
  await sleep(5);
  ok("...and the tick does not go on knocking", calls.length === quiet,
     calls.length - quiet + " calls");

  api.reconnect();
  ok("a new session forgets what the last host proved about itself",
     api.ok() === true && api.sent() === -1 && api.fails() === 0 && api.retryAt() === 0,
     "ok " + api.ok() + " sent " + api.sent() + " fails " + api.fails());
  answer(answers(30));
  api.tickOnce();
  await sleep(5);
  ok("...and the lever works again on the new one", api.sent() === 30,
     "sent " + api.sent());
}

/* ========================================================================== */
/* == Half B - the bridge injector, assertions 9-19 ========================= */
/* ========================================================================== */

// Stand-in for TightVNC. It greets like RFB so the bridge's connect path completes,
// then records rather than answers - what reaches it is the whole point here.
// Recording resets per connection so a previous viewer's bytes cannot drift into
// the next one's measurement. `conns` keeps them apart as well as in order, which
// is what the two-viewer assertions need: the question there is which connection a
// request went down, and one shared list cannot answer it.
let seen = [];
let sink = null;
const conns = [];
const vnc = net.createServer((sock) => {
  const conn = { sock, bytes: [] };
  conns.push(conn);
  seen = [];
  sink = sock;
  sock.on("error", () => {});
  sock.on("data", (d) => { seen.push(d); conn.bytes.push(d); });
  sock.write("RFB 003.008\n");
});
await new Promise((r) => vnc.listen(VNC_PORT, "127.0.0.1", r));

// --lan because the session key is only ever inlined into the page, and the page is
// only served under --lan. --share nope so no tvnserver is touched on the machine
// running the tests.
const host = spawn(process.execPath, [
  HOST_SCRIPT, "--tunnel", "none", "--lan", "--port", String(PORT),
  "--vnc", "127.0.0.1:" + VNC_PORT, "--share", "nope",
], { cwd: REPO, windowsHide: true });

let out = "";
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("bridge did not start:\n" + out)), 15000);
  const scan = (c) => {
    out += String(c);
    if (/Leave this window open/.test(out)) { clearTimeout(t); resolve(); }
  };
  host.stdout.on("data", scan);
  host.stderr.on("data", scan);
  host.on("exit", (code) => { clearTimeout(t); reject(new Error("exited " + code + ":\n" + out)); });
});

const key = await new Promise((resolve) => {
  http.get({ host: "127.0.0.1", port: PORT, path: "/" }, (r) => {
    let b = "";
    r.on("data", (c) => (b += c));
    r.on("end", () => resolve((b.match(/CAST_DIRECT="([\w-]+)"/) || [])[1] || ""));
  });
});

const ctl = (query) => new Promise((resolve) => {
  http.get({ host: "127.0.0.1", port: PORT, path: "/ctl?" + query }, (r) => {
    let b = "";
    r.on("data", (c) => (b += c));
    r.on("end", () => resolve({ status: r.statusCode, body: b }));
  }).on("error", (e) => resolve({ status: 0, body: String(e.message) }));
});
// `v` names one viewer, the way the page names its own tab on both URLs. Left
// out of both here by default, because that is an older page and the behaviour it
// gets - one rate for the whole host - is what most of these assertions are about.
const stream = (hz, w = 1920, h = 1080, v = "") =>
  ctl("k=" + key + "&stream=" + hz + "&w=" + w + "&h=" + h + (v ? "&v=" + v : ""));

function upgrade(v = "") {
  const sock = net.connect(PORT, "127.0.0.1", () => {
    sock.write("GET /ws?k=" + key + (v ? "&v=" + v : "") +
      " HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\nSec-WebSocket-Key: " +
      crypto.randomBytes(16).toString("base64") +
      "\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n\r\n");
  });
  sock.on("error", () => {});
  return sock;
}

// A client frame with FIN under our control, which is the only reason this is here
// rather than borrowed from framing.test.mjs: that one always sets FIN, and the
// fragmentation guard is exactly the case where a browser would not. Two-byte
// lengths as well, because the other half of that guard is about messages too big
// for noVNC to have sent in one piece.
function clientFrame(op, payload, fin = true) {
  const n = payload.length;
  const mask = crypto.randomBytes(4);
  let head;
  if (n < 126) {
    head = Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | n]);
  } else {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | op;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(n, 2);
  }
  const body = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

// The ten bytes the bridge is supposed to be writing, for w=1920 h=1080:
// type 3, incremental 1, x 0, y 0, then w and h big-endian. 0x0780 = 1920,
// 0x0438 = 1080. Spelled out rather than computed, so a change to how the host
// builds it has to be noticed here rather than mirrored.
const REQ = Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x07, 0x80, 0x04, 0x38]);

// The bridge injects nothing for a viewer until that viewer has asked for this
// rectangle itself - which is how it knows the viewer is past its RFB handshake
// and that the rectangle is the one it wants. A real noVNC sends one of these
// after every update it finishes; here it has to be said out loud. Order matters:
// the rate has to be set first, or there is no rectangle to recognise yet.
const askOnce = (ws) => ws.write(clientFrame(0x2, REQ));

// How many requests are in what the stand-in received, or -1 if it received
// anything that is not a whole run of them. Assertion 10 wants both halves of that:
// the right number, and nothing else mixed in.
function onlyRequests(bufs) {
  const all = Buffer.concat(bufs);
  if (all.length % REQ.length !== 0) return -1;
  for (let i = 0; i < all.length; i += REQ.length) {
    if (!all.subarray(i, i + REQ.length).equals(REQ)) return -1;
  }
  return all.length / REQ.length;
}

/* ---- 9. With no stream parameter, nothing about today changes ------------- */
// First, and deliberately so: a rate is per viewer connection, but /ctl sets it on
// every live one, and a leftover rate from a later test would make this pass for
// the wrong reason.
{
  const ws = upgrade();
  await sleep(300);
  seen = [];
  ws.write(clientFrame(0x2, Buffer.from([1, 2, 3])));
  await sleep(800);
  const got = Buffer.concat(seen);
  ok("no stream parameter: VNC sees only what the client sent",
     got.equals(Buffer.from([1, 2, 3])), got.toString("hex") || "nothing");
  ws.destroy();
  await sleep(200);
}

/* ---- 10 + 13. The rate, the exact bytes, and the clamp ------------------- */
{
  const ws = upgrade();
  await sleep(300);

  const r = await stream(20);
  ok("stream=20 is accepted", r.status === 200, r.body);
  ok("...and the reply reports the rate the host settled on",
     /"stream":20/.test(r.body), r.body);
  ok("...and carries pollMs, so the viewer can say what the ceiling is",
     /"pollMs":/.test(r.body), r.body);

  askOnce(ws);
  await sleep(100);
  seen = [];
  await sleep(1000);
  const n = onlyRequests(seen);
  // 18-22 rather than exactly 20: Windows timers land on a ~15.6ms tick, so the
  // host chases deadlines instead of using a flat interval. This is the assertion
  // that catches it going back - a plain setInterval(50) measures 16 here.
  ok("20Hz asks for about twenty updates a second", n >= 18 && n <= 22, String(n));
  ok("...and every byte of it is a FramebufferUpdateRequest for 1920x1080",
     n > 0, n === -1 ? "found bytes that are not requests" : n + " clean requests");

  await stream(999);
  seen = [];
  await sleep(1000);
  const fast = onlyRequests(seen);
  ok("stream=999 is clamped to 60Hz or less", fast >= 0 && fast <= 61, String(fast));
  ok("...but the clamp is a ceiling, not an off switch", fast > 20, String(fast));

  /* ---- 11. stream=0 stops it ------------------------------------------- */
  await stream(0);
  await sleep(200);
  seen = [];
  await sleep(600);
  ok("stream=0 stops injection within 200ms", onlyRequests(seen) === 0,
     String(onlyRequests(seen)));

  /* ---- 12. A wrong key changes nothing --------------------------------- */
  const bad = await ctl("k=wrong&stream=30&w=1920&h=1080");
  ok("a wrong session key is refused", bad.status === 403, String(bad.status));
  seen = [];
  await sleep(600);
  ok("...and injects nothing on the way out", onlyRequests(seen) === 0,
     String(onlyRequests(seen)));

  ws.destroy();
  await sleep(200);
}

/* ---- 14. A fragmented client message must not be spliced ----------------- */
// The one that would otherwise work by luck. wsReader hands continuation frames
// straight through, so without the FIN/midMessage guard the injector is free to
// write its ten bytes into the gap - and TightVNC would spend the rest of the
// session parsing the stream one message out of step.
{
  const ws = upgrade();
  await sleep(300);
  await stream(30);
  askOnce(ws);
  await sleep(100);
  seen = [];

  ws.write(clientFrame(0x2, Buffer.from([0xaa, 0xbb]), false));   // FIN clear
  await sleep(100);                                               // a gap to splice into
  ws.write(clientFrame(0x0, Buffer.from([0xcc, 0xdd]), true));    // the continuation
  await sleep(200);

  const all = Buffer.concat(seen);
  ok("the two halves of a fragmented message arrive adjacent",
     all.includes(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd])), all.toString("hex").slice(0, 96));
  // And prove the gap was one the injector would otherwise have filled: at 30Hz a
  // 100ms pause is three requests' worth of opportunity.
  ok("...while the injector was running either side of them",
     all.includes(REQ), all.length + " bytes seen");

  await stream(0);
  ws.destroy();
  await sleep(200);
}

/* ---- 15. A viewer that stops reading stops the asking -------------------- */
// Asking a stalled session for more frames is the one way this feature could make
// the picture worse instead of better: the bytes have nowhere to go, so they queue.
{
  const ws = upgrade();
  ws.once("data", () => ws.pause());        // read the 101, then go quiet
  await sleep(300);
  await stream(30);
  askOnce(ws);                              // it asked once, then stopped reading
  await sleep(100);

  // Fill both socket buffers from the VNC side until the bridge backpressures and
  // stops reading, which is the condition the injector's `paused` guard watches.
  // Enough of it to be past every buffer between here and the viewer, not just
  // the first one: stopping at the first refused write leaves a few hundred KB in
  // flight, which the bridge hands on, drains, and unpauses again halfway through
  // the measurement. A viewer that is not reading cannot absorb eight megabytes.
  const chunk = Buffer.alloc(65536, 7);
  const until = Date.now() + 5000;
  for (let sent = 0; sent < 8 * 1024 * 1024 && Date.now() < until; sent += chunk.length) {
    if (!sink || sink.destroyed) break;
    sink.write(chunk);
    await new Promise((r) => setImmediate(r));
  }

  await sleep(500);
  seen = [];
  await sleep(1000);
  ok("a stalled viewer stops the injector rather than queueing on it",
     onlyRequests(seen) === 0, String(onlyRequests(seen)));

  await stream(0);
  ws.destroy();
  await sleep(300);
}

/* ---- 16. A rate belongs to the viewer that asked for it ------------------ */
// The one that used to fire inside the next viewer's RFB handshake. The rate was
// the host's rather than the session's, so a viewer that closed its tab left it
// set - the page's disconnect handler does not run on unload - and the next
// bridge began injecting at TCP connect, several round trips before the version
// exchange and the auth reply had finished with the socket. Ten bytes there is a
// session that dies or mis-authenticates, so a viewer gets nothing until it has
// asked for something itself.
{
  const ws = upgrade();
  await sleep(300);
  await stream(20);
  askOnce(ws);
  const one = conns[conns.length - 1];
  await sleep(300);
  one.bytes.length = 0;
  await sleep(500);
  ok("the viewer that asked is streamed to", onlyRequests(one.bytes) > 0,
     String(onlyRequests(one.bytes)));

  const ws2 = upgrade();                     // a second viewer, the first still up
  await sleep(600);                          // longer than a handshake would take
  const two = conns[conns.length - 1];
  const quiet = () => Buffer.concat(two.bytes);
  ok("a second viewer is not armed by the rate the first one set",
     quiet().length === 0, quiet().toString("hex").slice(0, 60) || "nothing");

  await stream(20);                          // nor by one pushed while it connects
  await sleep(400);
  ok("...nor by a rate arriving on /ctl before it has asked for anything",
     quiet().length === 0, quiet().toString("hex").slice(0, 60) || "nothing");

  askOnce(ws2);
  await sleep(200);
  two.bytes.length = 0;
  await sleep(500);
  ok("...and is streamed to from the moment it asks for itself",
     onlyRequests(two.bytes) > 0, String(onlyRequests(two.bytes)));

  await stream(0);
  ws.destroy();
  ws2.destroy();
  await sleep(300);
}

/* ---- 17. A message big enough to be a piece stands the injector down ----- */
// noVNC's send buffer is 10KiB and it flushes when it fills, so an RFB message
// larger than that leaves the browser as several whole, FIN-set messages and the
// fragmentation guard above cannot see between them. Only a message that big can
// be a piece of a larger one, so one of those buys a 50ms stand-off - and an
// ordinary keystroke must not, or the injector would stand down for good: the
// viewer answers every update with a request of its own.
{
  const ws = upgrade();
  await sleep(300);
  await stream(60);
  askOnce(ws);
  await sleep(150);

  const big = Buffer.alloc(10240, 0x5a);
  seen = [];
  ws.write(clientFrame(0x2, big));
  await sleep(35);
  const afterBig = Buffer.concat(seen);
  const at = afterBig.indexOf(big);
  ok("a 10KiB client message reaches VNC whole", at >= 0, afterBig.length + " bytes");
  ok("...and nothing is injected in the 50ms behind it",
     at >= 0 && !afterBig.subarray(at + big.length).includes(REQ),
     afterBig.subarray(at + big.length).toString("hex").slice(0, 40) || "nothing");

  const small = Buffer.from([0x04, 0x01, 0, 0, 0, 0, 0, 0x41]);   // a keystroke
  seen = [];
  ws.write(clientFrame(0x2, small));
  await sleep(60);
  const afterSmall = Buffer.concat(seen);
  const s = afterSmall.indexOf(small);
  ok("a keystroke does not stand the injector down",
     s >= 0 && afterSmall.subarray(s + small.length).includes(REQ),
     s < 0 ? "the keystroke never arrived"
           : onlyRequests([afterSmall.subarray(s + small.length)]) + " behind it");

  await stream(0);
  ws.destroy();
  await sleep(200);
}

/* ---- 18. The pieces of one client message stay adjacent, however slow ---- */
// The failure this exists for: a paste over 10KB, ten bytes spliced into the
// middle of its ClientCutText, and TightVNC one message out of step for the rest
// of the session.
//
// The gap is the point. noVNC pushes every piece of one message in a single
// synchronous call, so they leave the browser together - but they still have to
// cross the viewer's uplink, and 10KiB takes a good deal longer than a frame
// period on anything domestic. A stand-off measured in tens of milliseconds
// covered the loopback case in this file and none of the real ones. So: wait
// longer here than the pieces of a real paste would be apart on a slow link, and
// require the bridge to have said nothing in between.
{
  const ws = upgrade();
  await sleep(300);
  await stream(60);
  askOnce(ws);
  await sleep(150);
  seen = [];

  const a = Buffer.alloc(10240, 0x11);       // exactly what a full send buffer is
  const b = Buffer.alloc(10240, 0x22);
  const tail = Buffer.alloc(2048, 0x33);     // the remainder, under the threshold
  ws.write(clientFrame(0x2, a));
  await sleep(30);                           // at 60Hz, two ticks' worth of gap
  ws.write(clientFrame(0x2, b));
  await sleep(300);                          // and now a slow link's worth
  ws.write(clientFrame(0x2, tail));
  await sleep(150);

  const all = Buffer.concat(seen);
  const whole = Buffer.concat([a, b, tail]);
  ok("the pieces of one client message are not spliced, 300 ms apart",
     all.includes(whole), all.length + " bytes seen");
  // And the other half of it: the stand-off has to end, or a paste would cost
  // the session its frame rate. A whole message under the buffer size cannot be
  // a piece of a larger one, so it is what says the sequence is over - and the
  // viewer sends one after every update it finishes, so this heals itself.
  const after = all.subarray(all.indexOf(whole) + whole.length);
  ok("...and the injector comes back the moment a whole small one goes past",
     onlyRequests([after]) > 0, onlyRequests([after]) + " behind it");

  await stream(0);
  ws.destroy();
  await sleep(200);
}

/* ---- 18b. ...and the stand-off ends on its own if none ever comes -------- */
// The case the deadline is still there for: a paste whose last piece is itself
// over the threshold, onto a still screen. There is no update to answer, so the
// viewer sends nothing more, so "a smaller message" never arrives. Without a
// backstop the feature would switch itself off for the rest of the session.
{
  const ws = upgrade();
  await sleep(300);
  await stream(60);
  askOnce(ws);
  await sleep(150);
  seen = [];

  const big = Buffer.alloc(10240, 0x44);
  // From where the message actually landed, not from a fixed offset: the tick
  // that was already in flight when `seen` was cleared is allowed to be there.
  const behind = () => {
    const all = Buffer.concat(seen);
    const i = all.indexOf(big);
    return i < 0 ? -2 : onlyRequests([all.subarray(i + big.length)]);
  };
  ws.write(clientFrame(0x2, big));
  await sleep(200);
  const inside = behind();
  await sleep(500);
  const later = behind();
  ok("nothing is injected while the stand-off runs", inside === 0, String(inside));
  ok("...and the injector returns without being asked twice", later > 0,
     String(later));

  await stream(0);
  ws.destroy();
  await sleep(200);
}

/* ---- 19. A named viewer moves its own bridge and nobody else's ---------- */
// Two tabs on one host each run their own ladder, and /ctl used to move both:
// every call overwrote the other tab's rate for the whole session. Nothing
// downstream could tell them apart either - the shared screen is host-wide, so
// their framebuffers always match and the rectangle latch sees no difference. So
// the page names its tab on the socket URL, the bridge learns it during the
// upgrade, and the control call names it back.
{
  const one = upgrade("tabA");
  await sleep(300);
  const A = conns[conns.length - 1];
  const two = upgrade("tabB");
  await sleep(300);
  const B = conns[conns.length - 1];

  await stream(20, 1920, 1080, "tabA");
  askOnce(one);
  askOnce(two);                              // both viewers past their handshake
  await sleep(300);
  A.bytes.length = B.bytes.length = 0;
  await sleep(400);
  ok("the tab that asked is streamed to", onlyRequests(A.bytes) > 0,
     String(onlyRequests(A.bytes)));
  ok("...and the tab that did not is left alone", onlyRequests(B.bytes) === 0,
     String(onlyRequests(B.bytes)));

  await stream(20, 1920, 1080, "tabB");
  askOnce(two);
  await sleep(300);
  A.bytes.length = B.bytes.length = 0;
  await sleep(400);
  ok("...until it asks for itself, on its own call",
     onlyRequests(A.bytes) > 0 && onlyRequests(B.bytes) > 0,
     onlyRequests(A.bytes) + " and " + onlyRequests(B.bytes));

  await stream(0, 1920, 1080, "tabA");
  await sleep(200);
  A.bytes.length = B.bytes.length = 0;
  await sleep(400);
  ok("and one tab stopping does not stop the other",
     onlyRequests(A.bytes) === 0 && onlyRequests(B.bytes) > 0,
     onlyRequests(A.bytes) + " and " + onlyRequests(B.bytes));

  await stream(0, 1920, 1080, "tabB");
  one.destroy();
  two.destroy();
  await sleep(300);
}

/* ---- Teardown, on either socket ----------------------------------------- */
// A timer left behind would hold the process open and keep writing into a
// destroyed socket for as long as the host ran, and a stale entry in the host's
// set of injectors would take the next viewer down with it. Both directions of
// close, because either end can be the one that goes.
{
  const ws = upgrade();
  await sleep(300);
  await stream(30);
  askOnce(ws);
  await sleep(300);
  ws.destroy();                              // the viewer goes
  await sleep(400);
  seen = [];
  await sleep(600);
  ok("a closed viewer takes its injector with it", onlyRequests(seen) === 0,
     String(onlyRequests(seen)));

  const ws2 = upgrade();
  await sleep(300);
  await stream(30);
  askOnce(ws2);
  await sleep(200);
  seen = [];
  await sleep(600);
  ok("...and the next viewer gets its own updates", onlyRequests(seen) > 0,
     String(onlyRequests(seen)));

  if (sink) sink.destroy();                  // now the VNC side goes instead
  await sleep(600);
  ok("the host survives the VNC side dropping under a running injector",
     host.exitCode === null, "exit=" + host.exitCode);

  const ws3 = upgrade();
  await sleep(400);
  await stream(30);
  askOnce(ws3);
  await sleep(200);
  seen = [];
  await sleep(600);
  ok("...and a fresh viewer still reaches VNC afterwards", onlyRequests(seen) > 0,
     String(onlyRequests(seen)));

  await stream(0);
  ws3.destroy();
  ws2.destroy();
}

host.kill();
vnc.close();
console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

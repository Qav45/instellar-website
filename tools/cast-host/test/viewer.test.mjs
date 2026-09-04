// cast/index.html is one inline module and there is no browser here. The parts
// of it that decide whether a dropped session comes back, and what the card says
// while it waits, are plain functions with no DOM in them - so cut those out of
// the page by their source text and run them as they are. It fails loudly if
// someone renames one, which is the point: the test follows the code.
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
const grab = (from, to) => {
  const a = src.indexOf(from);
  if (a < 0) throw new Error("page no longer contains: " + from);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error("no end marker after: " + from);
  return src.slice(a, b + to.length) + "\n";
};

const sandbox = { location: { hash: "" } };
vm.createContext(sandbox);
// Lexical declarations stay inside the script, so hand them back as a value.
const { esc, hashToken, nextBackoff, retryFoot, offlineCard } = vm.runInContext(
  grab("const esc = ", "[c]);") +
  grab("function hashToken() {", "\n}\n") +
  grab("const nextBackoff = ", ";\n") +
  grab("const retryFoot = ", ': "");\n') +
  grab("function offlineCard(body) {", "\n}\n") +
  "({ esc, hashToken, nextBackoff, retryFoot, offlineCard });",
  sandbox);

/* ------------------------------------------------------------- backoff -- */

// Walk the schedule the way the page does: one step per failed attempt.
const steps = [];
for (let b = 4000, i = 0; i < 12; i++) { steps.push(b); b = nextBackoff(b); }
ok("the first retry is quick, because most drops are already over", steps[0] === 4000);
ok("the wait grows between attempts", steps[1] > steps[0] && steps[2] > steps[1],
   steps.slice(0, 3).join());
ok("the wait caps at thirty seconds", Math.max(...steps) === 30000, Math.max(...steps));
ok("it stays capped rather than resetting or overflowing",
   steps.slice(-3).every((s) => s === 30000), steps.slice(-3).join());
// A page left open overnight against a host that is off: at the cap that is
// under three thousand lookups in a day, not twenty thousand.
ok("the schedule reaches the cap within a minute of trying",
   steps.findIndex((s) => s === 30000) < 8, steps.findIndex((s) => s === 30000));

/* ----------------------------------------------------------------- card -- */

ok("the card counts the wait down in whole seconds", retryFoot(4000, 1) === "Reconnecting in 4s…");
ok("a wait mid-second rounds up rather than showing 0s early",
   retryFoot(1200, 1) === "Reconnecting in 2s…", retryFoot(1200, 1));
ok("a wait that has run out reads 0s, not a negative", retryFoot(-300, 1) === "Reconnecting in 0s…");
ok("the first attempt does not announce itself", !/attempt/.test(retryFoot(4000, 1)));
ok("later attempts say how many there have been",
   retryFoot(30000, 7) === "Reconnecting in 30s… (attempt 7)", retryFoot(30000, 7));

/* -------------------------------------------------------- remote start -- */

// The offline card is drawn from the 404 body, which only carries the agent
// fields for the right key. Nothing there means the card it always was.
{
  const plain = offlineCard({ error: "offline", detail: "No host is casting right now." });
  ok("with no agent the card is the old one, and has no button",
     /Run the host script/.test(plain.detail) && plain.button === "", JSON.stringify(plain));
  const idle = offlineCard({ error: "offline", agent: "desk", want: null });
  ok("a listening agent puts the host's name on the button",
     idle.button === "Start casting on desk", idle.button);
  ok("and does not claim to be waking it yet", !/Waking/.test(idle.detail), idle.detail);
  const waking = offlineCard({ error: "offline", agent: "desk", want: "start" });
  ok("a wake already asked for shows the waiting text without the button",
     waking.detail === "Waking desk…" && waking.button === "", JSON.stringify(waking));
  const stopping = offlineCard({ error: "offline", agent: "desk", want: "stop" });
  ok("a pending stop still offers to start", stopping.button === "Start casting on desk", stopping.button);
  const nameless = offlineCard({ error: "offline", agent: "", want: null });
  ok("an agent with no name is still an agent",
     nameless.button === "Start casting on the host", nameless.button);
  // The name comes off the wire and lands in innerHTML through esc(); this is
  // where the page must not trust it.
  const hostile = offlineCard({ error: "offline", agent: '<b onclick="1">', want: null });
  ok("a hostile name survives to be escaped, not run",
     esc(hostile.button) === "Start casting on &lt;b onclick=&quot;1&quot;&gt;", esc(hostile.button));
}

/* -------------------------------------------------------------- escaping -- */

// Both feeds into the cards: the host's own security reason off the RFB wire,
// and the error body from /api/cast.
ok("markup in a wire message cannot reach innerHTML",
   esc('<img src=x onerror="1">&') === "&lt;img src=x onerror=&quot;1&quot;&gt;&amp;",
   esc('<img src=x onerror="1">&'));
ok("non-strings are escaped as their text", esc(404) === "404");

/* --------------------------------------------------------------- the hash -- */

sandbox.location.hash = "#50%off";
ok("a bare % in the key does not throw the module away", hashToken() === "50%off", hashToken());
sandbox.location.hash = "#a%20b";
ok("a properly encoded key still decodes", hashToken() === "a b", hashToken());
sandbox.location.hash = "";
ok("no hash means no key", hashToken() === "");

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

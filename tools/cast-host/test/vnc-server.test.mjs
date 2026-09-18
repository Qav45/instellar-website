// VNC+ capability table. Everything here is a pure function over a frozen
// record, so the test needs no server, no socket and no machine that has any of
// these installed - discovery takes its filesystem probe as an argument.
//
// The properties worth proving are the ones a later integration will lean on:
// that the TightVNC argv is byte-for-byte what cast-host.mjs builds today, that
// an unrecognised share mode still produces nothing, that an unknown server is
// not mistaken for one that cannot push, and that importing the module changes
// nothing on the machine.
import {
  SERVERS, CAPTURE, serverById, pushesUpdates, defaultPort,
  discover, selectServer, shareArgv,
} from "../vnc-server.mjs";

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A machine described as a set of paths that exist.
const machine = (...paths) => (p) => paths.includes(p);

const TVN64 = "C:\\Program Files\\TightVNC\\tvnserver.exe";
const TVN32 = "C:\\Program Files (x86)\\TightVNC\\tvnserver.exe";
const TIGER = "C:\\Program Files\\TigerVNC Server\\winvnc4.exe";
const ULTRA = "C:\\Program Files\\uvnc bvba\\UltraVNC\\winvnc.exe";

/* ------------------------------------------------------------- the table -- */

ok("every record has the fields the bridge branches on",
   SERVERS.every((s) =>
     typeof s.id === "string" &&
     Array.isArray(s.bins) && s.bins.length > 0 &&
     Number.isInteger(s.defaultPort) &&
     typeof s.continuousUpdates === "boolean" &&
     Object.values(CAPTURE).includes(s.capture) &&
     Array.isArray(s.shareModes)),
   SERVERS.map((s) => s.id).join(","));

ok("ids are unique", new Set(SERVERS.map((s) => s.id)).size === SERVERS.length);

ok("records are frozen, so one caller cannot edit another's capabilities",
   (() => {
     const before = SERVERS[0].continuousUpdates;
     try { SERVERS[0].continuousUpdates = !before; } catch (_) { /* strict mode */ }
     return SERVERS[0].continuousUpdates === before;
   })());

ok("TightVNC is first, so nothing adopts a new server by accident",
   SERVERS[0].id === "tightvnc");

ok("serverById finds a known id and refuses an unknown one",
   serverById("tigervnc")?.id === "tigervnc" && serverById("nope") === null);

/* --------------------------------------------- the capability that matters -- */

ok("TightVNC is recorded as not pushing updates",
   pushesUpdates(serverById("tightvnc")) === false);

ok("TigerVNC is recorded as pushing updates",
   pushesUpdates(serverById("tigervnc")) === true);

ok("UltraVNC is recorded as not pushing updates",
   pushesUpdates(serverById("ultravnc")) === false);

// The bridge decides whether to run its request injector on this answer. An
// unknown or missing server must keep the injector, not lose it.
ok("an unknown server does not read as a pushing server",
   pushesUpdates(null) === false &&
   pushesUpdates(undefined) === false &&
   pushesUpdates({}) === false &&
   pushesUpdates({ continuousUpdates: "yes" }) === false);

ok("only TigerVNC among Windows servers claims fence support",
   SERVERS.filter((s) => s.fence).map((s) => s.id).join(",") === "tigervnc");

ok("TightVNC captures with desktop duplication, not the polling interval",
   serverById("tightvnc").capture === CAPTURE.dxgi &&
   serverById("tightvnc").captureFallback.includes(CAPTURE.poll));

ok("TigerVNC's capture is recorded as the step down it is",
   serverById("tigervnc").capture === CAPTURE.poll);

ok("UltraVNC is event driven with a hard 33ms floor",
   serverById("ultravnc").capture === CAPTURE.event &&
   serverById("ultravnc").pollMs.default === 33);

/* ------------------------------------------------------------------ port -- */

ok("TightVNC keeps 5900 and the two adoptable servers do not",
   defaultPort(serverById("tightvnc")) === 5900 &&
   defaultPort(serverById("tigervnc")) === 5901 &&
   defaultPort(serverById("ultravnc")) === 5901);

ok("defaultPort falls back to 5900 for a server it does not recognise",
   defaultPort(null) === 5900 && defaultPort({ defaultPort: "5901" }) === 5900);

/* ------------------------------------------------------------- discovery -- */

ok("discovery finds nothing on a machine with nothing",
   discover({ exists: () => false }).length === 0);

ok("discovery prefers the 64-bit TightVNC path, in probe order",
   discover({ exists: machine(TVN64, TVN32) })[0].bin === TVN64);

ok("a 32-bit TightVNC on 64-bit Windows is still found",
   discover({ exists: machine(TVN32) })[0].bin === TVN32);

ok("discovery lists every installed server, in table order",
   eq(discover({ exists: machine(ULTRA, TIGER, TVN64) }).map((s) => s.id),
      ["tightvnc", "tigervnc", "ultravnc"]));

ok("discovery does not mutate the shared records",
   (() => {
     discover({ exists: machine(TVN64) });
     return SERVERS.find((s) => s.id === "tightvnc").bin === undefined;
   })());

ok("two probes of different machines do not see each other's answers",
   discover({ exists: machine(TVN64) })[0].bin === TVN64 &&
   discover({ exists: machine(TVN32) })[0].bin === TVN32);

/* --------------------------------------------------------------- select -- */

ok("with no preference the incumbent wins even when a newer server is present",
   selectServer({ exists: machine(TVN64, TIGER) }).id === "tightvnc");

ok("a preference is honoured when that server is installed",
   selectServer({ prefer: "tigervnc", exists: machine(TVN64, TIGER) }).id === "tigervnc");

// Silently streaming from a different server than the one that was asked for is
// worse than not starting.
ok("a preference for a server that is not installed is null, not a fallback",
   selectServer({ prefer: "tigervnc", exists: machine(TVN64) }) === null);

ok("an empty machine selects nothing",
   selectServer({ exists: () => false }) === null);

/* ---------------------------------------------------------------- share -- */

const tvn = selectServer({ exists: machine(TVN64) });

ok("share argv for TightVNC is exactly what cast-host builds today",
   eq(shareArgv(tvn, "full"), [TVN64, ["-controlservice", "-sharefull"]]) &&
   eq(shareArgv(tvn, "primary"), [TVN64, ["-controlservice", "-shareprimary"]]) &&
   eq(shareArgv(tvn, "3"), [TVN64, ["-controlservice", "-sharedisplay", "3"]]));

ok("the display whitelist is unchanged: 1..99 and nothing else",
   shareArgv(tvn, "1") !== null &&
   shareArgv(tvn, "99") !== null &&
   shareArgv(tvn, "0") === null &&
   shareArgv(tvn, "100") === null &&
   shareArgv(tvn, "01") === null);

// This is the property that keeps /ctl?share= safe to pass straight through.
ok("nothing unmatched reaches a command line",
   ["", "full;rm", "-listen", "1 2", "2\n", "../x", "primaryy", null, undefined]
     .every((m) => shareArgv(tvn, m) === null));

ok("a server with no share CLI returns null for every mode, including full",
   ["full", "primary", "2"].every((m) =>
     shareArgv(selectServer({ prefer: "tigervnc", exists: machine(TIGER) }), m) === null &&
     shareArgv(selectServer({ prefer: "ultravnc", exists: machine(ULTRA) }), m) === null));

ok("an undiscovered record has no bin, so it cannot produce an argv",
   shareArgv(serverById("tightvnc"), "full") === null &&
   shareArgv(null, "full") === null);

/* ------------------------------------------------------------- no effects -- */

// The module is imported by the bridge at startup on a machine someone is
// streaming from. Nothing it does at load time may spawn, install or write, and
// the cheapest way to keep that true is to read the source and say so.
const src = await (await import("node:fs/promises"))
  .readFile(new URL("../vnc-server.mjs", import.meta.url), "utf8");

ok("the module imports no child_process and no registry helper",
   !/child_process|spawnSync|execSync|winreg/.test(src));

ok("the only filesystem call is the injectable existsSync default",
   eq([...new Set(src.match(/fs\.[a-zA-Z]+/g) || [])], ["fs.existsSync"]));

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);

// Fortnite's frame cap while the cast is in use. Uncapped, the game holds the
// GPU at full load and the desktop capture and NVENC queue behind it, so the
// stream's cadence goes as uneven as the game's. Sixty is all the stream
// carries anyway: the game is held to that while anyone is watching and gets
// its own setting back afterwards.
//
// Fortnite reads GameUserSettings.ini at launch and writes it back on exit, so
// the file is only touched while the game is not running - a change made under
// a running game would be overwritten when it closed. While it runs, this looks
// again every RECHECK_MS and lands the change once it has exited.
//
// The original value waits in ~/.instellar-cast/fortnite-fps while the cap is
// on, so a host that died with the cap applied gives it back at its next start.

import realFs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";

export const CAP = "60.000000";
const RECHECK_MS = 10000;
// ^ keeps it off FrontendFrameRateLimit; . and $ stop before the \r of CRLF.
const LINE = /^FrameRateLimit=(.*)$/m;

export const readLimit = (text) => (text.match(LINE) || [])[1];
export const withLimit = (text, v) => text.replace(LINE, "FrameRateLimit=" + v);

const defaultIni = () => process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "FortniteGame", "Saved", "Config", "WindowsClient", "GameUserSettings.ini")
  : "";

// Async so the relay's event loop never waits on tasklist. An answer it cannot
// read counts as running: the file is left alone and asked about again later.
const fortniteRunning = () => new Promise((resolve) => {
  execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true }, (err, out) =>
    resolve(err ? true : /^"fortnite/im.test(out)));
});

export function createGameCap({
  ini = defaultIni(),
  saved = path.join(os.homedir(), ".instellar-cast", "fortnite-fps"),
  running = fortniteRunning,
  fs = realFs,
  log = () => {},
  recheckMs = RECHECK_MS,
} = {}) {
  // No ini path is the off switch (tests boot the host with CAST_GAME_INI="").
  // Off means off: not even the saved file is looked at.
  if (!ini) return { watching: async () => {} };

  let want = false;
  let run = null;
  let again = false;
  let timer = null;
  let waiting = false;
  let warned = false;

  // latin1 round-trips every byte, so nothing but the one value changes.
  const read = (f) => { try { return fs.readFileSync(f, "latin1"); } catch (_) { return null; } };

  async function step() {
    clearTimeout(timer);
    timer = null;
    const original = read(saved);
    const capped = original !== null;
    if (want === capped) { waiting = false; return; }
    const text = read(ini);
    if (text === null || readLimit(text) === undefined) {
      // No game, or not a file we understand: nothing to cap, and nothing left
      // to give back to.
      if (capped) fs.unlinkSync(saved);
      return;
    }
    if (await running()) {
      if (!waiting) log("fortnite is running; its frame cap changes after it closes");
      waiting = true;
      timer = setTimeout(apply, recheckMs);
      timer.unref?.();
      return;
    }
    waiting = false;
    // Re-read: the game may have exited and rewritten the file during tasklist.
    const now = read(ini);
    if (now === null) return;
    if (want) {
      const was = readLimit(now);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.writeFileSync(saved, was, "latin1");
      fs.writeFileSync(ini, withLimit(now, CAP), "latin1");
      log("fortnite capped at 60 fps while casting (was " + was + ")");
    } else {
      // A cap changed in game since is the player's choice; leave it.
      if (readLimit(now) === CAP) {
        fs.writeFileSync(ini, withLimit(now, original.trim()), "latin1");
        log("fortnite frame cap back to " + original.trim());
      }
      fs.unlinkSync(saved);
    }
  }

  function apply() {
    if (run) { again = true; return run; }
    run = (async () => {
      try {
        do { again = false; await step(); } while (again);
      } catch (e) {
        if (!warned) log("fortnite frame cap: " + (e.message || e));
        warned = true;
      } finally {
        run = null;
      }
    })();
    return run;
  }

  return {
    // True while anyone is watching. The returned promise settles once the
    // file is where it should be, or the wait for the game to close has begun.
    watching(on) {
      want = !!on;
      return apply();
    },
  };
}

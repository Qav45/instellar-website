// Fortnite's frame cap: only FrameRateLimit changes, nothing lands while the
// game runs, the player's own setting comes back afterwards, and a change made
// in game in between is left alone. The filesystem and tasklist are fakes.
import { readLimit, withLimit, createGameCap, CAP } from "../game-cap.mjs";

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};

const INI = "C:/game/GameUserSettings.ini";
const SAVED = "C:/home/.instellar-cast/fortnite-fps";
const TEXT = "[/Script/FortniteGame.FortGameUserSettings]\r\nFrameRateLimit=0.000000\r\n" +
             "FrontendFrameRateLimit=120\r\nbUseVSync=False\r\n";

ok("the limit is read", readLimit(TEXT) === "0.000000");
ok("only FrameRateLimit changes and CRLF survives",
   withLimit(TEXT, CAP) === TEXT.replace("FrameRateLimit=0.000000", "FrameRateLimit=60.000000") &&
   withLimit(TEXT, CAP).includes("FrontendFrameRateLimit=120\r\n"));

function fake(files) {
  const map = new Map(Object.entries(files));
  const fs = {
    readFileSync: (f) => { if (!map.has(f)) throw new Error("ENOENT " + f); return map.get(f); },
    writeFileSync: (f, v) => map.set(f, v),
    unlinkSync: (f) => map.delete(f),
    mkdirSync: () => {},
  };
  const state = { game: false, fs, map };
  state.cap = (extra = {}) => createGameCap({ ini: INI, saved: SAVED, fs, running: async () => state.game,
                                              recheckMs: 20, ...extra });
  return state;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const f = fake({ [INI]: TEXT });
  const cap = f.cap();
  await cap.watching(true);
  ok("a viewer caps the game at 60 and keeps the original",
     readLimit(f.map.get(INI)) === CAP && f.map.get(SAVED) === "0.000000");
  await cap.watching(false);
  ok("the last viewer leaving gives the original back and forgets it",
     f.map.get(INI) === TEXT && !f.map.has(SAVED));
}
{
  const f = fake({ [INI]: TEXT });
  f.game = true;
  const cap = f.cap();
  await cap.watching(true);
  ok("nothing is written while the game runs", f.map.get(INI) === TEXT && !f.map.has(SAVED));
  f.game = false;
  await wait(60);
  ok("the cap lands once the game has closed", readLimit(f.map.get(INI)) === CAP);
}
{
  const f = fake({ [INI]: TEXT });
  const cap = f.cap();
  await cap.watching(true);
  f.map.set(INI, withLimit(f.map.get(INI), "120.000000"));
  await cap.watching(false);
  ok("a cap changed in game is left alone", readLimit(f.map.get(INI)) === "120.000000" && !f.map.has(SAVED));
}
{
  const f = fake({ [INI]: withLimit(TEXT, CAP), [SAVED]: "0.000000" });
  await f.cap().watching(false);
  ok("a host that died capped gives the original back at its next start",
     f.map.get(INI) === TEXT && !f.map.has(SAVED));
}
{
  const f = fake({});
  await f.cap().watching(true);
  ok("no game installed is a no-op", f.map.size === 0);
}
{
  const f = fake({ [INI]: TEXT, [SAVED]: "0.000000" });
  const cap = createGameCap({ ini: "", saved: SAVED, fs: f.fs, running: async () => false });
  await cap.watching(true);
  await cap.watching(false);
  ok("an empty ini path switches it off entirely", f.map.get(INI) === TEXT && f.map.get(SAVED) === "0.000000");
}
{
  const f = fake({ [INI]: TEXT });
  f.fs.writeFileSync = () => { throw new Error("EPERM"); };
  const lines = [];
  const cap = f.cap({ log: (m) => lines.push(m) });
  await cap.watching(true);
  await cap.watching(true);
  ok("a file that cannot be written is reported once", lines.length === 1 && /EPERM/.test(lines[0]), lines.join("|"));
}
process.exit(failed ? 1 : 0);

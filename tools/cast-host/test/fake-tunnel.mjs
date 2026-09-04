// Test-only cloudflared stand-in. The first process publishes a URL and crashes;
// the replacement publishes a different URL and stays up for the host to keep.
import fs from "node:fs";

const state = process.env.CAST_FAKE_TUNNEL_STATE;
let run = 0;
try { run = Number(fs.readFileSync(state, "utf8")); } catch (_) {}
run++;
fs.writeFileSync(state, String(run));
console.log("https://cast-restart-" + run + ".trycloudflare.com");

if (run === 1) setTimeout(() => process.exit(17), 200);
else setInterval(() => {}, 1000);

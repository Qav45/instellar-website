// Test-only ffmpeg stand-in for the mic. Writes 640-byte chunks of "PCM" to
// stdout - 20ms of s16le mono at 16 kHz - whose first four bytes are a u32
// sequence number, so a test can see which chunks a listener was spared. No
// device is opened and nothing is recorded: the samples are filler.
//
// Anything that is not a dshow capture (the video encoder chain, when a test
// touches /video) exits 1 at once, as a missing encoder would.
//
//   CAST_FAKE_MIC_PID      file to write this process id to
//   CAST_FAKE_MIC_ARGS     file to append the argv to, one JSON line per run
//   CAST_FAKE_MIC_MISSING  1: fail like ffmpeg does when the device is not there
//   CAST_FAKE_MIC_TICK_MS  ms between writes (20)
//   CAST_FAKE_MIC_BURST    chunks per write (1)
import fs from "node:fs";

const argv = process.argv.slice(2);
const env = process.env;
if (!argv.includes("dshow")) process.exit(1);

if (env.CAST_FAKE_MIC_ARGS) fs.appendFileSync(env.CAST_FAKE_MIC_ARGS, JSON.stringify(argv) + "\n");
if (env.CAST_FAKE_MIC_PID) fs.writeFileSync(env.CAST_FAKE_MIC_PID, String(process.pid));
if (env.CAST_FAKE_MIC_MISSING) {
  const dev = (argv.find((a) => a.startsWith("audio=")) || "").slice(6);
  process.stderr.write("[dshow @ 0000] Could not find audio only device with name [" + dev +
    "] among source devices of type audio.\naudio=" + dev + ": I/O error\n");
  process.exit(1);
}

const burst = Number(env.CAST_FAKE_MIC_BURST) || 1;
let seq = 0;
setInterval(() => {
  const out = Buffer.alloc(640 * burst, 0x11);
  for (let i = 0; i < burst; i++) out.writeUInt32BE(seq++, i * 640);
  process.stdout.write(out);
}, Number(env.CAST_FAKE_MIC_TICK_MS) || 20);

// Test-only ffmpeg stand-in. Writes a synthetic stream to stdout at a steady
// rate in whichever codec the -c:v name asks for: H.264 or HEVC Annex-B with
// the parameter sets + a keyframe every 30 pictures and P slices in between,
// or AV1 OBUs with a temporal delimiter, the sequence header + a key frame,
// then inter frames. Nothing here is a picture - the slice payloads are filler
// bytes a real decoder would reject - so the tests exercise splitting, caching
// and fan-out with no screen.
//
//   CAST_FAKE_FFMPEG_FAIL       comma list of -c:v names that exit 1 at once
//   CAST_FAKE_FFMPEG_PID        file to write this process id to
//   CAST_FAKE_FFMPEG_ARGS       file to append the argv to, one JSON line per run
//   CAST_FAKE_FFMPEG_DIE_AFTER  exit 3 after this many ms (each run)
//   CAST_FAKE_FFMPEG_BARE_IDR   1: keyframes after the first carry no parameter sets
import fs from "node:fs";

const argv = process.argv.slice(2);
const encoder = argv[argv.indexOf("-c:v") + 1] || "";
const env = process.env;

if (env.CAST_FAKE_FFMPEG_ARGS) fs.appendFileSync(env.CAST_FAKE_FFMPEG_ARGS, JSON.stringify(argv) + "\n");
if (env.CAST_FAKE_FFMPEG_PID) fs.writeFileSync(env.CAST_FAKE_FFMPEG_PID, String(process.pid));
if ((env.CAST_FAKE_FFMPEG_FAIL || "").split(",").includes(encoder)) {
  process.stderr.write("Cannot load " + encoder + "\n");
  process.exit(1);
}

// A real 1920x1080 High profile level 4.2 SPS (x264), and the PPS that goes with it.
const SPS = Buffer.from("Z2QAKqzZQHgCJ+XARAAAAwAEAAADAPA8YMZY", "base64");
const PPS = Buffer.from("aOvssiw=", "base64");
// Real 1920x1080 HEVC Main 4.1 VPS/SPS/PPS and an AV1 sequence header, as
// hevc_nvenc and av1_nvenc on an RTX 4070 write them.
const HVPS = Buffer.from("QAEMAf//AWAAAAMAkAAAAwAAAwB7lwJA", "base64");
const HSPS = Buffer.from("QgEBAWAAAAMAkAAAAwAAAwB7oAPAgBEHy5ZdKQhGRdUMBAQAAAMABAAAAwDxgBd5RAAD0JAABBLx", "base64");
const HPPS = Buffer.from("RAHA98DMkA==", "base64");
const SEQ = Buffer.from("CgsAAABKq7/DcAhmAQ==", "base64");
const TD = Buffer.from([0x12, 0x00]);
const SC = Buffer.from([0, 0, 0, 1]);
const codec = encoder === "libx264" ? "h264" : encoder.split("_")[0];

// Slice payload: NAL header, first bit set (first_mb_in_slice = 0, or HEVC's
// first_slice_segment_in_pic_flag), then the picture number in bytes that can
// never form a start code, then filler.
const slice = (key, n, size) => {
  const b = Buffer.alloc(size, 0x5a);
  let at = 1;
  if (codec === "hevc") { b[0] = key ? 0x26 : 0x02; b[1] = 0x01; at = 2; }
  else b[0] = key ? 0x65 : 0x41;
  b[at] = 0x80 | (n & 0x7f);
  b[at + 1] = 0x80 | ((n >> 7) & 0x7f);
  return b;
};

// A frame OBU: header, LEB128 size, then a payload whose first byte says KEY
// (show_existing_frame 0, frame_type 00) or INTER (01), the show_frame bit set.
const frameObu = (key, n, size) => {
  const b = Buffer.alloc(size, 0x5a);
  b[0] = key ? 0x10 : 0x30;
  b[1] = n & 0xff;
  b[2] = n >> 8;
  return Buffer.concat([Buffer.from([0x32, (size & 0x7f) | 0x80, size >> 7]), b]);
};

let n = 0;
const tick = () => {
  const key = n % 30 === 0;
  const parts = [];
  const params = key && (n === 0 || !env.CAST_FAKE_FFMPEG_BARE_IDR);
  if (codec === "av1") {
    parts.push(TD);
    if (params) parts.push(SEQ);
    parts.push(frameObu(key, n, key ? 4000 : 600));
  } else {
    if (params) parts.push(...(codec === "hevc" ? [SC, HVPS, SC, HSPS, SC, HPPS] : [SC, SPS, SC, PPS]));
    parts.push(SC, slice(key, n, key ? 4000 : 600));
  }
  process.stdout.write(Buffer.concat(parts));
  n++;
};
setInterval(tick, 16);
if (env.CAST_FAKE_FFMPEG_DIE_AFTER) setTimeout(() => process.exit(3), Number(env.CAST_FAKE_FFMPEG_DIE_AFTER));

// Stream mode: the host's GPU encodes the screen and the page decodes it with
// WebCodecs. This module owns the ffmpeg side of that - spawning it, cutting
// its raw output into access units, remembering the last GOP so a viewer who
// arrives mid-stream can start decoding at once, and fanning the units out to
// however many viewers are watching. cast-host.mjs wraps each viewer's WebSocket
// in a "sink" and hands it to subscribe(); nothing in here knows about sockets.
//
// Three codecs, because bytes are the constraint through the tunnel and the
// better codec buys frames and sharpness: AV1, HEVC and H.264, in that order of
// preference. The page says which its browser decodes in hardware, and the
// first codec on its list that this machine can encode wins. H.264 and HEVC
// arrive as Annex-B NAL streams that differ only in header layout and type
// numbers; AV1 arrives as a low-overhead OBU stream with its own splitter.
//
// Frames never touch disk. ffmpeg writes to a pipe, this reads the pipe, and the
// bytes go straight out to viewers or into a short in-memory cache. There is no
// image here at all - only compressed slices a decoder somewhere else turns back
// into a picture.

import { spawn } from "node:child_process";

/* --------------------------------------------------------------- Annex B -- */

const START3 = Buffer.from([0, 0, 1]);
const START4 = Buffer.from([0, 0, 0, 1]);
const KEEP_TAIL = 2;                                 // a start code can straddle chunks

// What tells one NAL stream from the other. H.264 has a one-byte NAL header
// with the type in its low five bits; HEVC a two-byte header with the type in
// bits 1-6 of the first. Each names the types that are slices, the slice
// types that are keyframes (H.264's IDR; HEVC's whole IRAP range 16-23, since
// a CRA opens a GOP just as well), the non-slice types that begin a picture
// when they follow a slice (7.4.1.2.3 / 7.4.2.4.4), the bit in a slice header
// that says "first slice of this picture" and how many bytes in it sits, and
// the parameter sets a keyframe has to carry, in the order a decoder wants them.
const NAL = {
  h264: {
    head: 2,
    type: (nal) => nal[0] & 0x1f,
    slice: (t) => t === 1 || t === 5,
    key: (t) => t === 5,
    first: (nal) => nal.length > 1 && (nal[1] & 0x80) !== 0,
    starts: (t) => t === 6 || t === 7 || t === 8 || t === 9,
    params: { 7: "sps", 8: "pps" },
  },
  hevc: {
    head: 3,
    type: (nal) => (nal[0] >> 1) & 0x3f,
    slice: (t) => t < 32,
    key: (t) => t >= 16 && t <= 23,
    first: (nal) => nal.length > 2 && (nal[2] & 0x80) !== 0,
    starts: (t) => t === 32 || t === 33 || t === 34 || t === 35 || t === 39,
    params: { 32: "vps", 33: "sps", 34: "pps" },
  },
};

// ffmpeg's h264 and hevc muxers emit a byte stream: NALs separated by 00 00 01
// or 00 00 00 01, with nothing saying where one picture ends and the next
// begins. The decoder on the far end wants whole access units, so this groups
// NALs the way the standards say a picture starts: an AUD, SPS, PPS or SEI
// that follows a slice, or a slice whose first_mb_in_slice is 0 (HEVC:
// first_slice_segment_in_pic_flag) after another slice. That last test matters
// because libx264 with sliced threads splits every picture into several slice
// NALs, and "a slice after a slice" alone would cut each frame into pieces the
// decoder rejects. first_mb_in_slice is the first ue(v) after the NAL header,
// and ue(v) codes zero as a single 1 bit.
export function parseAnnexB(codec = "h264") {
  const C = NAL[codec];
  let pending = Buffer.alloc(0);   // bytes of the NAL currently being received
  let inNal = false;               // false until the first start code is seen
  let opened = false;              // the pending NAL's header has been looked at
  let nals = [];                   // the AU under construction
  let hasSlice = false;
  const last = {};                 // parameter sets seen most recently, by name

  const startsPicture = (nal) => {
    const t = C.type(nal);
    if (C.slice(t)) return hasSlice && C.first(nal);
    return hasSlice && C.starts(t);
  };

  const finish = (out) => {
    if (!nals.length) return;
    let key = false;
    const seen = {};
    for (const nal of nals) {
      const t = C.type(nal);
      if (C.key(t)) key = true;
      else if (C.params[t]) { seen[C.params[t]] = nal; last[C.params[t]] = nal; }
    }
    // A decoder started at this keyframe needs the parameter sets in front of
    // it. NVENC repeats them on every IDR; other encoders may not, so put the
    // ones seen last back in. A keyframe before any SPS at all cannot be
    // decoded by anyone and is dropped.
    let parts = nals;
    if (key) {
      const missing = Object.values(C.params).filter((name) => !seen[name]);
      if (missing.some((name) => !last[name])) { nals = []; hasSlice = false; return; }
      if (missing.length) parts = missing.map((name) => last[name]).concat(nals);
      for (const name of missing) seen[name] = last[name];
    }
    const bytes = Buffer.concat(parts.flatMap((n) => [START4, n]));
    out.push(Object.assign({ key, bytes }, seen));
    nals = [];
    hasSlice = false;
  };

  // The previous AU is complete the moment the next NAL's header says a new
  // picture begins - a few bytes in, not at its end. Waiting for the whole NAL
  // would hold every picture back until the one after it had fully arrived.
  const open = (nal, out) => {
    if (opened) return;
    opened = true;
    if (startsPicture(nal)) finish(out);
  };

  const pushNal = (nal, out) => {
    // The zero in front of a 4-byte start code is trailing_zero_8bits of the
    // NAL before it, not payload. A NAL ends in a stop bit so it never ends in
    // 0x00 on its own; trimming zeros loses nothing.
    let end = nal.length;
    while (end > 0 && nal[end - 1] === 0) end--;
    if (!end) return;
    nal = nal.subarray(0, end);
    open(nal, out);
    nals.push(nal);
    if (C.slice(C.type(nal))) hasSlice = true;
  };

  const feed = (chunk) => {
    const out = [];
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let from = Math.max(0, pending.length - KEEP_TAIL);
    let nalStart = 0;
    for (;;) {
      const at = data.indexOf(START3, from);
      if (at < 0) break;
      if (inNal) pushNal(data.subarray(nalStart, at), out);
      inNal = true;
      opened = false;
      nalStart = at + 3;
      from = nalStart;
    }
    // Keep only the tail that can still matter: the partial NAL, or before
    // the first start code the last two bytes in case 00 00 | 01 was split.
    pending = inNal ? data.subarray(nalStart) : data.subarray(Math.max(0, data.length - KEEP_TAIL));
    if (inNal && pending.length >= C.head) open(pending, out);
    return out;
  };

  // The last AU of a stream has no successor to mark its end; called when the
  // encoder exits so a final picture is not lost.
  const flush = () => {
    const out = [];
    if (inNal) pushNal(pending, out);
    pending = Buffer.alloc(0);
    inNal = false;
    finish(out);
    return out;
  };

  return { feed, flush };
}

/* ------------------------------------------------------------------ OBUs -- */

// AV1 comes out of ffmpeg's obu muxer in the low-overhead format: every OBU is
// a header byte (type in bits 3-6, an extension flag, and a has_size flag the
// format requires to be set), an optional extension byte, a LEB128 size, then
// the payload. There are no start codes to search for; the size says where the
// next one begins. A temporal delimiter (type 2) opens every temporal unit,
// which is the AV1 name for an access unit and what WebCodecs takes as one
// chunk. Keyframes are frame (6) or frame header (3) OBUs whose header opens
// with show_existing_frame 0 and frame_type 00 (KEY) - the top three bits of
// the payload's first byte all clear. A keyframe needs the sequence header
// (type 1) ahead of it in the unit, so like the SPS above the last one seen is
// put back in when the encoder left it out.
const obuType = (b) => (b >> 3) & 0x0f;

export function parseObu() {
  let pending = Buffer.alloc(0);
  let obus = [];                   // the temporal unit under construction
  let key = false;
  let seq = null;                  // sequence header inside this unit
  let lastSeq = null;

  const finish = (out) => {
    if (!obus.length) return;
    let parts = obus;
    if (key && !seq) {
      if (!lastSeq) { obus = []; key = false; return; }
      // Behind the temporal delimiter when there is one: the unit must still
      // start with it.
      const td = obuType(obus[0][0]) === 2 ? 1 : 0;
      parts = obus.slice(0, td).concat([lastSeq], obus.slice(td));
      seq = lastSeq;
    }
    const au = { key, bytes: Buffer.concat(parts) };
    if (seq) au.seq = seq;
    out.push(au);
    obus = [];
    key = false;
    seq = null;
  };

  const feed = (chunk) => {
    const out = [];
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let at = 0;
    while (at < data.length) {
      const b = data[at];
      const type = obuType(b);
      if (!(b & 0x02)) { at = data.length; break; }  // no size field: not this format, drop it
      let p = at + 1 + ((b >> 2) & 1);
      let size = 0;
      let shift = 0;
      let more = true;
      while (more && p < data.length) {
        size += (data[p] & 0x7f) * Math.pow(2, shift);
        more = (data[p] & 0x80) !== 0;
        shift += 7;
        p++;
      }
      if (more || p + size > data.length) break;    // the rest is in the next chunk
      const obu = data.subarray(at, p + size);
      if (type === 2) finish(out);
      else if (type === 1) { seq = obu; lastSeq = obu; }
      else if ((type === 6 || type === 3) && size > 0 && (data[p] & 0xe0) === 0) key = true;
      obus.push(obu);
      at = p + size;
    }
    pending = data.subarray(at);
    return out;
  };

  const flush = () => {
    const out = [];
    pending = Buffer.alloc(0);
    finish(out);
    return out;
  };

  return { feed, flush };
}

/* ------------------------------------------------------------------- SPS -- */

function stripStart(nal) {
  if (nal.length >= 4 && nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1) return nal.subarray(4);
  if (nal.length >= 3 && nal[0] === 0 && nal[1] === 0 && nal[2] === 1) return nal.subarray(3);
  return nal;
}

// WebCodecs wants "avc1.PPCCLL": profile_idc, the constraint_set byte and
// level_idc, exactly the three bytes after the SPS NAL header.
export function codecString(sps) {
  const n = stripStart(sps);
  const hex = (b) => b.toString(16).padStart(2, "0");
  return "avc1." + hex(n[1]) + hex(n[2]) + hex(n[3]);
}

// Profiles whose SPS carries chroma_format_idc and the bit-depth fields
// (7.3.2.1.1). NVENC's -profile:v high is 100, so this is the common path.
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

// Exp-Golomb reader over a payload. For the NAL codecs, emulation prevention
// bytes (00 00 03) are removed first - a 1080p SPS contains them, and reading
// through one shifts every field after it. AV1 has no such escaping.
function bitReader(raw, escaped = true) {
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    if (escaped && i >= 2 && raw[i] === 3 && raw[i - 1] === 0 && raw[i - 2] === 0) continue;
    bytes.push(raw[i]);
  }
  let pos = 0;
  const u = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) {
      v = (v * 2) + ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
    }
    return v;
  };
  const ue = () => {
    let zeros = 0;
    while (u(1) === 0 && zeros < 32) zeros++;
    return zeros ? (1 << zeros) - 1 + u(zeros) : 0;
  };
  const se = () => {
    const k = ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  };
  return { u, ue, se };
}

export function spsDimensions(sps) {
  const r = bitReader(stripStart(sps).subarray(1));
  const profile = r.u(8);
  r.u(8);                                            // constraint flags
  r.u(8);                                            // level_idc
  r.ue();                                            // seq_parameter_set_id
  let chromaFormat = 1;
  let separatePlanes = 0;
  if (HIGH_PROFILES.has(profile)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) separatePlanes = r.u(1);
    r.ue();                                          // bit_depth_luma_minus8
    r.ue();                                          // bit_depth_chroma_minus8
    r.u(1);                                          // qpprime_y_zero_transform_bypass
    if (r.u(1)) {                                    // seq_scaling_matrix_present
      for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
        if (!r.u(1)) continue;
        // scaling_list(): every delta has to be read to find the field after it.
        let last = 8;
        let next = 8;
        const size = i < 6 ? 16 : 64;
        for (let j = 0; j < size; j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue();                                            // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue();                                          // log2_max_pic_order_cnt_lsb_minus4
  } else if (pocType === 1) {
    r.u(1);                                          // delta_pic_order_always_zero
    r.se();                                          // offset_for_non_ref_pic
    r.se();                                          // offset_for_top_to_bottom_field
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue();                                            // max_num_ref_frames
  r.u(1);                                            // gaps_in_frame_num_allowed
  const widthMbs = r.ue() + 1;
  const heightUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);                         // mb_adaptive_frame_field
  r.u(1);                                            // direct_8x8_inference
  let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
  if (r.u(1)) {
    cropL = r.ue(); cropR = r.ue(); cropT = r.ue(); cropB = r.ue();
  }
  // Coded size is whole macroblocks; 1080 lines is 67.5 of them, so the SPS
  // codes 1088 and crops 8 off the bottom. Crop units depend on chroma
  // subsampling (Table 6-1) and on interlacing.
  const chromaArray = separatePlanes ? 0 : chromaFormat;
  const subW = chromaArray === 1 || chromaArray === 2 ? 2 : 1;
  const subH = chromaArray === 1 ? 2 : 1;
  const unitX = chromaArray === 0 ? 1 : subW;
  const unitY = (chromaArray === 0 ? 1 : subH) * (2 - frameMbsOnly);
  return {
    width: widthMbs * 16 - (cropL + cropR) * unitX,
    height: (2 - frameMbsOnly) * heightUnits * 16 - (cropT + cropB) * unitY,
  };
}

// HEVC's SPS opens with profile_tier_level, which is what the WebCodecs string
// is made of (ISO 14496-15 E.3): "hvc1." then the profile (its space as a
// letter, A-C, when not 0), the 32 compatibility flags as hex with the bit
// order reversed and no leading zeros, the tier as L or H with the level_idc,
// and the six constraint bytes as hex with trailing zero bytes left off. Main
// 4.1 from NVENC comes out "hvc1.1.6.L123.90". The picture size follows a
// little further in, with a conformance window in chroma units doing the job
// H.264's frame cropping does.
export function hevcSpsInfo(sps) {
  const r = bitReader(stripStart(sps).subarray(2));
  r.u(4);                                            // sps_video_parameter_set_id
  const subLayers = r.u(3);                          // sps_max_sub_layers_minus1
  r.u(1);                                            // sps_temporal_id_nesting_flag
  const space = r.u(2);
  const tier = r.u(1);
  const profile = r.u(5);
  const flags = [];
  for (let i = 0; i < 32; i++) flags.push(r.u(1));
  let compat = 0;
  for (let i = 31; i >= 0; i--) compat = compat * 2 + flags[i];
  const constraint = [];
  for (let i = 0; i < 6; i++) constraint.push(r.u(8));
  const level = r.u(8);
  // Sub-layer profile/level entries are sized by two flags each, and padded
  // to eight entries with reserved bits when there is at least one.
  const present = [];
  for (let i = 0; i < subLayers; i++) present.push([r.u(1), r.u(1)]);
  if (subLayers > 0) for (let i = subLayers; i < 8; i++) r.u(2);
  for (const [p, l] of present) {
    if (p) r.u(88);
    if (l) r.u(8);
  }
  r.ue();                                            // sps_seq_parameter_set_id
  const chromaFormat = r.ue();
  if (chromaFormat === 3) r.u(1);                    // separate_colour_plane_flag
  const width = r.ue();
  const height = r.ue();
  let winL = 0, winR = 0, winT = 0, winB = 0;
  if (r.u(1)) {
    winL = r.ue(); winR = r.ue(); winT = r.ue(); winB = r.ue();
  }
  const subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
  const subH = chromaFormat === 1 ? 2 : 1;
  while (constraint.length > 1 && constraint[constraint.length - 1] === 0) constraint.pop();
  const hex = (b) => b.toString(16).padStart(2, "0");
  return {
    codec: "hvc1." + (space ? String.fromCharCode(64 + space) : "") + profile + "." +
      compat.toString(16) + "." + (tier ? "H" : "L") + level + "." + constraint.map(hex).join("."),
    width: width - (winL + winR) * subW,
    height: height - (winT + winB) * subH,
  };
}

// The AV1 sequence header OBU (with or without its OBU header and size). The
// string is "av01.<profile>.<level idx, 2 digits><M|H>.<bit depth, 2 digits>"
// (AV1 ISOBMFF 2.3): 1080p60 8-bit from NVENC is "av01.0.09M.08". Everything
// between the level and the bit depth in color_config has to be walked over
// field by field; the spec's conditionals are followed as written.
export function av1SeqInfo(obu) {
  let payload = obu;
  if (obuType(obu[0]) === 1 && (obu[0] & 0x02)) {
    let p = 1 + ((obu[0] >> 2) & 1);
    while (obu[p++] & 0x80);
    payload = obu.subarray(p);
  }
  const r = bitReader(payload, false);
  const profile = r.u(3);
  r.u(1);                                            // still_picture
  const reduced = r.u(1);
  let level = 0;
  let tier = 0;
  let bufferDelayBits = 0;
  let decoderModel = 0;
  if (reduced) {
    level = r.u(5);
  } else {
    if (r.u(1)) {                                    // timing_info_present_flag
      r.u(32); r.u(32);                              // num_units_in_display_tick, time_scale
      if (r.u(1)) {                                  // equal_picture_interval: uvlc()
        let zeros = 0;
        while (r.u(1) === 0 && zeros < 32) zeros++;
        if (zeros < 32) r.u(zeros);
      }
      decoderModel = r.u(1);
      if (decoderModel) {
        bufferDelayBits = r.u(5) + 1;
        r.u(32); r.u(5); r.u(5);
      }
    }
    const initialDelay = r.u(1);
    const ops = r.u(5) + 1;
    for (let i = 0; i < ops; i++) {
      r.u(12);                                       // operating_point_idc
      const l = r.u(5);
      const t = l > 7 ? r.u(1) : 0;
      if (i === 0) { level = l; tier = t; }
      if (decoderModel && r.u(1)) { r.u(bufferDelayBits); r.u(bufferDelayBits); r.u(1); }
      if (initialDelay && r.u(1)) r.u(4);
    }
  }
  const wBits = r.u(4) + 1;
  const hBits = r.u(4) + 1;
  const width = r.u(wBits) + 1;
  const height = r.u(hBits) + 1;
  if (!reduced && r.u(1)) { r.u(4); r.u(3); }        // frame_id_numbers_present_flag
  r.u(3);                                            // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
  if (!reduced) {
    r.u(4);                                          // interintra, masked compound, warped motion, dual filter
    const orderHint = r.u(1);
    if (orderHint) r.u(2);                           // enable_jnt_comp, enable_ref_frame_mvs
    const forceTools = r.u(1) ? 2 : r.u(1);          // seq_choose_screen_content_tools
    if (forceTools > 0 && !r.u(1)) r.u(1);           // seq_choose_integer_mv / seq_force_integer_mv
    if (orderHint) r.u(3);                           // order_hint_bits_minus_1
  }
  r.u(3);                                            // enable_superres, enable_cdef, enable_restoration
  const high = r.u(1);                               // color_config: high_bitdepth
  const depth = profile === 2 && high ? (r.u(1) ? 12 : 10) : high ? 10 : 8;
  const two = (n) => String(n).padStart(2, "0");
  return { codec: "av01." + profile + "." + two(level) + (tier ? "H" : "M") + "." + two(depth), width, height };
}

/* -------------------------------------------------------------- settings -- */

export const CODECS = ["av1", "hevc", "h264"];

// Everything here ends up on an ffmpeg command line, so nothing passes through
// unchanged: numbers are clamped, the display is matched against the same
// vocabulary the share dropdown uses, and the codec list keeps only the names
// this module knows, in the order the page prefers them. Unparseable input is
// refused outright; an empty codec list means H.264, which every host and
// browser has.
export function validateVideoSettings(q) {
  const fpsRaw = q.get("fps");
  const mbpsRaw = q.get("mbps");
  const display = q.get("display") || "primary";
  const fps = fpsRaw == null || fpsRaw === "" ? 60 : Math.round(Number(fpsRaw));
  const mbps = mbpsRaw == null || mbpsRaw === "" ? 8 : Number(mbpsRaw);
  if (!Number.isFinite(fps) || !Number.isFinite(mbps)) return null;
  if (display !== "primary" && display !== "full" && !/^[1-9][0-9]?$/.test(display)) return null;
  const codecs = (q.get("codecs") || "").split(",").filter((c, i, all) => CODECS.includes(c) && all.indexOf(c) === i);
  return {
    fps: Math.min(120, Math.max(1, fps)),
    mbps: Math.min(50, Math.max(1, Math.round(mbps * 10) / 10)),
    display,
    codecs: codecs.length ? codecs : ["h264"],
  };
}

/* --------------------------------------------------------------- encoder -- */

// Per codec, in the order they are tried. libx264 is the one CPU fallback:
// there is no point in a software AV1 or HEVC encoder at sixty frames a second.
const ENCODERS = {
  av1: ["av1_nvenc", "av1_amf", "av1_qsv"],
  hevc: ["hevc_nvenc", "hevc_amf", "hevc_qsv"],
  h264: ["h264_nvenc", "h264_amf", "h264_qsv", "libx264"],
};
export const codecOf = (encoder) => encoder === "libx264" ? "h264" : encoder.split("_")[0];
const BACKLOG_LIMIT = 1024 * 1024;   // bytes queued on a viewer before it is skipped
const IDLE_MS = 3000;                // keep the encoder warm this long after the last viewer
const STARTUP_MS = 2000;             // an exit sooner than this means "cannot start"
const CRASH_WINDOW_MS = 10000;       // a second death this soon after a restart is final

// The low-latency flags are per vendor, not per codec: ffmpeg 9's hevc_nvenc
// and av1_nvenc take the same preset/tune/zerolatency/rc/forced-idr options
// as h264_nvenc (checked with ffmpeg -h encoder=...), and likewise for AMF and
// QSV. NVENC repeats the parameter sets (or the AV1 sequence header) on every
// IDR when no global header is asked for; the parsers put them back for any
// encoder that does not. The raw muxer is the codec's own: h264, hevc, obu.
function ffmpegArgs(encoder, s) {
  const idx = s.display === "primary" || s.display === "full" ? 0 : Number(s.display) - 1;
  let filter = "ddagrab=output_idx=" + idx + ":framerate=" + s.fps + ":draw_mouse=1";
  // libx264 runs on the CPU and cannot read D3D11 textures; the others take the
  // captured frame straight from the GPU.
  if (encoder === "libx264") filter += ",hwdownload,format=nv12";
  const rate = ["-b:v", s.mbps + "M", "-maxrate", s.mbps + "M",
    "-bufsize", Math.round(s.mbps * 1000 / s.fps * 2) + "k", "-g", String(s.fps * 2), "-bf", "0"];
  const vendor = encoder.split("_")[1] || encoder;
  const tune = {
    nvenc: ["-preset", "p1", "-tune", "ull", "-zerolatency", "1", "-rc", "cbr"],
    amf: ["-usage", "ultralowlatency", "-rc", "cbr"],
    qsv: ["-preset", "veryfast", "-look_ahead", "0"],
    libx264: ["-preset", "ultrafast", "-tune", "zerolatency", "-x264-params", "repeat-headers=1"],
  }[vendor] || [];
  const after = vendor === "nvenc" ? ["-forced-idr", "1"].concat(encoder === "h264_nvenc" ? ["-profile:v", "high"] : []) : [];
  const mux = { av1: "obu", hevc: "hevc", h264: "h264" }[codecOf(encoder)];
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-fflags", "nobuffer",
    "-flags", "low_delay", "-init_hw_device", "d3d11va", "-filter_complex", filter,
    "-c:v", encoder].concat(tune, rate, after, ["-flush_packets", "1", "-f", mux, "pipe:1"]);
}

// A viewer can join the running encoder when the picture settings match and
// the codec it is producing is one the viewer can decode - not only when the
// lists are identical, or two browsers with different decoders would restart
// the encoder at each other for ever.
const canJoin = (a, b, encoder) =>
  a && b && a.fps === b.fps && a.mbps === b.mbps && a.display === b.display &&
  b.codecs.includes(codecOf(encoder));

// What the config message needs from the first keyframe: the WebCodecs codec
// string and the picture size, each read from the codec's own header.
const describe = {
  h264: (au) => Object.assign({ codec: codecString(au.sps) }, spsDimensions(au.sps)),
  hevc: (au) => hevcSpsInfo(au.sps),
  av1: (au) => av1SeqInfo(au.seq),
};

export function createVideoSource(opts) {
  const log = opts.log || (() => {});
  // Test-only, like CAST_TUNNEL_BIN: a JS file stands in for ffmpeg and is run
  // through this Node.
  const override = process.env.CAST_FFMPEG_BIN || "";
  const named = override || opts.ffmpeg || "ffmpeg";
  const bin = /\.[cm]?js$/i.test(named) ? process.execPath : named;
  const binArgs = bin === process.execPath ? [named] : [];

  const sinks = new Set();         // { sink, waitKey }
  let current = null;              // settings the running encoder was started with
  let child = null;
  let chain = [];                  // encoders for the requested codecs, in order
  let encoderIdx = 0;
  let encoder = "";
  let startedAt = 0;
  let proven = false;              // this encoder has produced a picture
  let lastCrashAt = 0;
  let config = null;
  let gop = [];                    // [{ flags, ts, bytes }] from the last keyframe on
  let idleTimer = null;
  let stopped = false;

  const closeAll = (code, reason) => {
    for (const e of sinks) { try { e.sink.close(code, reason); } catch (_) {} }
    sinks.clear();
  };

  // One place decides whether a viewer gets an AU. A viewer whose socket has
  // fallen a megabyte behind is skipped until the next keyframe rather than
  // buffered without limit: a delta whose predecessors were dropped would only
  // corrupt the picture, and a keyframe puts it right again.
  const deliver = (e, au) => {
    if (!e.waitKey && e.sink.buffered() > BACKLOG_LIMIT) e.waitKey = true;
    if (e.waitKey) {
      if (!(au.flags & 1)) return;
      e.waitKey = false;
    }
    e.sink.au(au.flags, au.ts, au.bytes);
  };

  const onAu = (parsed) => {
    if (!proven) {
      proven = true;
      log("video    " + codecOf(encoder) + " via " + encoder);
    }
    if (!config) {
      if (!parsed.key) return;                       // nothing to decode from yet
      const info = describe[codecOf(encoder)](parsed);
      config = {
        type: "config", codec: info.codec, width: info.width, height: info.height,
        fps: current.fps, encoder, display: current.display, mbps: current.mbps,
      };
      for (const e of sinks) e.sink.config(config);
    }
    const au = { flags: parsed.key ? 1 : 0, ts: Date.now() - startedAt, bytes: parsed.bytes };
    if (parsed.key) gop = [au]; else gop.push(au);
    for (const e of sinks) deliver(e, au);
  };

  const kill = () => {
    if (!child) return;
    const c = child;
    child = null;
    c.kill();
  };

  const start = (settings) => {
    current = settings;
    config = null;
    gop = [];
    proven = false;
    for (const e of sinks) e.waitKey = true;
    // The first requested codec's encoders, then the next codec's: a host
    // without an AV1 encoder still serves HEVC or H.264.
    chain = settings.codecs.flatMap((c) => ENCODERS[c]);
    encoder = chain[encoderIdx];
    if (!encoder) {
      log("video    no encoder could start (tried " + chain.join(", ") + ")");
      current = null;
      closeAll(1011, "no encoder");
      return;
    }
    const codec = codecOf(encoder);
    const parser = codec === "av1" ? parseObu() : parseAnnexB(codec);
    let errTail = "";
    const proc = spawn(bin, binArgs.concat(ffmpegArgs(encoder, settings)),
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child = proc;
    startedAt = Date.now();
    proc.stdout.on("data", (chunk) => {
      if (child !== proc) return;
      for (const au of parser.feed(chunk)) onAu(au);
    });
    proc.stderr.on("data", (c) => {
      errTail = (errTail + String(c)).slice(-2000);
    });
    proc.on("error", (e) => { errTail += e.message; });
    proc.on("exit", (code) => {
      if (child !== proc) return;                    // stopped or replaced on purpose
      child = null;
      for (const au of parser.flush()) onAu(au);
      const lived = Date.now() - startedAt;
      const why = errTail.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      if (!proven || lived < STARTUP_MS) {
        // Never produced a picture: this encoder is not available on this
        // machine (no such GPU, driver too old). Try the next one.
        log("video    " + encoder + " failed (exit " + code + ")" + (why ? ": " + why : ""));
        encoderIdx++;
        start(settings);
        return;
      }
      if (Date.now() - lastCrashAt < CRASH_WINDOW_MS) {
        log("video    " + encoder + " died again (exit " + code + ")" + (why ? ": " + why : ""));
        current = null;
        closeAll(1011, "encoder died");
        return;
      }
      lastCrashAt = Date.now();
      log("video    " + encoder + " exited (" + code + ")" + (why ? ": " + why : "") + " - restarting");
      start(settings);
    });
  };

  const stopEncoder = () => {
    kill();
    current = null;
    config = null;
    gop = [];
  };

  const subscribe = (settings, sink) => {
    if (stopped) { sink.close(1011, "stopped"); return () => {}; }
    clearTimeout(idleTimer);
    idleTimer = null;
    const entry = { sink, waitKey: true };
    sinks.add(entry);
    if (child && canJoin(current, settings, encoder)) {
      // Joining a running stream: the config and the cached GOP let the
      // decoder start on the keyframe it needs instead of waiting for the
      // next one.
      if (config) {
        sink.config(config);
        for (const au of gop) deliver(entry, au);
      }
    } else {
      // The first viewer picks the settings; a later one who wants something
      // else restarts the encoder for everyone. Start over at the top of the
      // chain: the failure may have been about the old settings.
      if (child) log("video    restarting for " + settings.fps + " fps / " + settings.mbps + " mbps / " + settings.display + " / " + settings.codecs.join(","));
      kill();
      encoderIdx = 0;
      start(settings);
    }
    return () => {
      if (!sinks.delete(entry)) return;
      if (sinks.size || !child) return;
      // Keep the encoder warm across a viewer's reconnect; stop it if nobody
      // comes back so an idle host is not burning GPU on nothing.
      idleTimer = setTimeout(() => { idleTimer = null; if (!sinks.size) stopEncoder(); }, IDLE_MS);
    };
  };

  const stop = () => {
    stopped = true;
    clearTimeout(idleTimer);
    stopEncoder();
    closeAll(1001, "stopped");
  };

  return { subscribe, settings: () => current, stop };
}

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

// How tall the encoded picture may be. The host's desktop is whatever it is -
// 1440p and 4K are ordinary now - and the viewer is the end that has to decode
// it. A built-in decoder on a light machine is bounded both by the picture it
// will take and by the level the bitstream declares, and the host is the only
// end that can choose either, so it chooses them here.
//
// 720 by default, because the viewer this cast is for is a Chromebook and its
// own comment at the configure site records the shape of the problem: 1080p60
// H.264 needs level 4.2, several rungs above what many built-in decoders carry,
// and such a decoder refuses the configure outright rather than falling back.
// 720p60 is level 3.2, which is inside what those decoders carry - a smaller
// picture that plays against a larger one that does not. A strong desktop asks
// for more with ?maxh=; nothing about this number is fixed.
//
// It is worth being clear that today this is not a default so much as the only
// value: the page sends no maxh at all, so every viewer gets 720 whatever it
// could decode. Two things could fix that and only one of them is right. The
// wrong one is to stop capping unless asked - that hands the Chromebook the
// 1080p60 the cap exists to prevent, and it is not justified by cost, because
// the scale was measured on this host and comes to about 1.2ms of one core per
// frame with no frames lost. The right one is for the page to ask: send
// ?maxh= from the viewer's own screen, so a 1440p monitor gets 1440 and the
// Chromebook gets 720, and the host keeps 720 for a page too old to ask.
// That change is in cast/index.html, not here.
const DEFAULT_MAX_HEIGHT = 720;

// Everything here ends up on an ffmpeg command line, so nothing passes through
// unchanged: numbers are clamped, the display is matched against the same
// vocabulary the share dropdown uses, and the codec list keeps only the names
// this module knows, in the order the page prefers them. Unparseable input is
// refused outright; an empty codec list means H.264, which every host and
// browser has.
export function validateVideoSettings(q) {
  const fpsRaw = q.get("fps");
  const mbpsRaw = q.get("mbps");
  const maxhRaw = q.get("maxh");
  const cqRaw = q.get("cq");
  const display = q.get("display") || "primary";
  const fps = fpsRaw == null || fpsRaw === "" ? 60 : Math.round(Number(fpsRaw));
  const mbps = mbpsRaw == null || mbpsRaw === "" ? 8 : Number(mbpsRaw);
  const maxh = maxhRaw == null || maxhRaw === "" ? DEFAULT_MAX_HEIGHT : Math.round(Number(maxhRaw));
  // The viewer's text setting: an offset on QUALITY, negative is sharper.
  const cq = cqRaw == null || cqRaw === "" ? 0 : Math.round(Number(cqRaw));
  if (!Number.isFinite(fps) || !Number.isFinite(mbps) || !Number.isFinite(maxh) || !Number.isFinite(cq)) return null;
  if (display !== "primary" && display !== "full" && !/^[1-9][0-9]?$/.test(display)) return null;
  const codecs = (q.get("codecs") || "").split(",").filter((c, i, all) => CODECS.includes(c) && all.indexOf(c) === i);
  // Kept even: every codec here subsamples chroma by two, and an odd dimension
  // is a picture half the encoders refuse and the rest quietly round.
  const capped = Math.min(2160, Math.max(240, maxh));
  return {
    fps: Math.min(120, Math.max(1, fps)),
    mbps: Math.min(50, Math.max(1, Math.round(mbps * 10) / 10)),
    maxh: capped - (capped % 2),
    cq: Math.min(12, Math.max(-12, cq)),
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
// ...and what it has to be back down to before a keyframe picks it up again.
// Still more than a 1080p keyframe, so the last one sent is never what holds
// a viewer off the next.
const RESUME_LIMIT = BACKLOG_LIMIT / 4;
// How long a viewer may stay more than RESUME_LIMIT behind before it is
// skipped as if it had reached BACKLOG_LIMIT. A keyframe passes through that
// band and out again; a viewer still in it a whole GOP later is not catching
// up, it is carrying the queue as standing latency.
const STANDING_MS = 1000;
// A keyframe costs around 190KB of the 1080p desktop and a delta on a still
// screen costs under a kilobyte, so on this cast the keyframes ARE the
// bitrate: one a second measured 1.89 mbps and one every three seconds 0.72,
// same screen, same quality. Over a tunnel each of those keyframes is also a
// burst that holds back the frames behind it, which is felt as latency. Two
// seconds halves both the bytes and the bursts while keeping the two costs of
// a long GOP bounded: a viewer that drops a frame waits at most this long for
// the next key, and the replay cache a joining viewer gets is at most this
// many seconds of frames.
const GOP_SECONDS = 1;               // recover dropped frames within one second
// What NVENC aims for when it is free to choose: a quantiser, not a bitrate.
// Per codec, because -cq is not a shared scale: the same number asked of
// hevc_nvenc or av1_nvenc means a higher quality and costs more bytes, not
// fewer. These three were measured to cost the same bytes on the same screen
// (0.97 / 0.96 / 0.99 mbps over six seconds), so a viewer that negotiates the
// better codec spends its efficiency on a sharper picture rather than on more
// bytes - and never arrives at a bitrate higher than H.264's by accident.
const QUALITY = { h264: 20, hevc: 26, av1: 32 };
const IDLE_MS = 3000;                // keep the encoder warm this long after the last viewer
const STARTUP_MS = 2000;             // an exit sooner than this means "cannot start"
const CRASH_WINDOW_MS = 10000;       // a second death this soon after a restart is final
// How far the counted cadence may drift from the wall clock before it is pulled
// back. See stamp() - a quarter second is long enough that no single slow
// keyframe moves it and short enough that real lost frames do not accumulate.
const CADENCE_SLIP_MS = 250;
// An encoder that is alive and has put out nothing for this long is wedged.
// ddagrab's dup_frames (default true, `ffmpeg -h filter=ddagrab`) repeats the
// last picture to hold its framerate, so a still screen is still a unit every
// period - at the lowest rate the page asks for, 20 fps, this is sixty of them.
const STALL_MS = 3000;

/* ------------------------------------------------- profile and level cap -- */

// A level is a promise about how much work the bitstream asks of a decoder, and
// a decoder that does not carry the level refuses the stream whatever else is
// true of it. Every level bounds the same three things: the frame (H.264 in
// macroblocks, HEVC and AV1 in luma samples), that number times the frame rate,
// and the bitrate. Asking for the lowest level the picture actually needs is
// the difference between a light decoder taking the stream and refusing it.
//
// Entries are [name, max size * rate, max size, max kbit/s], lowest first,
// starting at 3.0 because nothing below it can hold a desktop. From H.264
// Annex A table A-1, with MaxBR scaled by High profile's 1.25 cpbBrVclFactor;
// HEVC A.4.1 at Main tier; AV1 A.3 at tier 0. Nothing here was measured - they
// are the standards' own numbers.
const LEVELS = {
  h264: [
    ["3.0", 40500, 1620, 12500], ["3.1", 108000, 3600, 17500],
    ["3.2", 216000, 5120, 25000], ["4.0", 245760, 8192, 25000],
    ["4.1", 245760, 8192, 62500], ["4.2", 522240, 8704, 62500],
    ["5.0", 589824, 22080, 168750], ["5.1", 983040, 36864, 300000],
    ["5.2", 2073600, 36864, 300000], ["6.0", 4177920, 139264, 300000],
    ["6.1", 8355840, 139264, 600000], ["6.2", 16711680, 139264, 1000000],
  ],
  hevc: [
    ["3.0", 16588800, 552960, 6000], ["3.1", 33177600, 983040, 10000],
    ["4.0", 66846720, 2228224, 12000], ["4.1", 133693440, 2228224, 20000],
    ["5.0", 267386880, 8912896, 25000], ["5.1", 534773760, 8912896, 40000],
    ["5.2", 1069547520, 8912896, 60000], ["6.0", 1069547520, 35651584, 60000],
    ["6.1", 2139095040, 35651584, 120000], ["6.2", 4278190080, 35651584, 240000],
  ],
  av1: [
    ["3.0", 19975680, 665856, 6000], ["3.1", 31950720, 1065024, 10000],
    ["4.0", 70778880, 2359296, 12000], ["4.1", 141557760, 2359296, 20000],
    ["5.0", 267386880, 8912896, 30000], ["5.1", 534773760, 8912896, 40000],
    ["5.2", 1069547520, 8912896, 60000], ["6.0", 1069547520, 35651584, 60000],
    ["6.1", 2139095040, 35651584, 100000], ["6.2", 4278190080, 35651584, 160000],
  ],
};
export const levelFor = (codec, w, h, fps, mbps) => {
  const table = LEVELS[codec] || LEVELS.h264;
  const size = codec === "h264" ? Math.ceil(w / 16) * Math.ceil(h / 16) : w * h;
  const fit = table.find(([, rate, max, kbps]) =>
    size <= max && size * fps <= rate && mbps * 1000 <= kbps);
  return (fit || table[table.length - 1])[0];
};

// Profile per encoder, because the option's vocabulary differs per encoder and
// an option this build does not have is a start failure rather than a warning.
// What is listed was read out of `ffmpeg -h encoder=...` on this host, ffmpeg
// 9.0.1: av1_nvenc has no -profile at all (Main is the only profile NVENC's
// AV1 encoder produces), and QSV has no -level in its help, so QSV gets a
// profile and nothing more.
//
// High is the right H.264 profile for a weak decoder, not a concession it
// cannot afford. Every hardware H.264 decoder in service implements High - it
// is what broadcast and every streaming service send - while Main and Baseline
// only take away CABAC and the 8x8 transform, which is where a page of text
// gets most of its compression. What a built-in decoder runs out of is level,
// not profile, so the pin that was already here stays and the level joins it.
// Main is likewise the 8-bit 4:2:0 profile for HEVC and AV1; naming it stops a
// build whose default is main10 from handing a decoder ten-bit it will refuse.
const PROFILES = {
  h264_nvenc: "high", h264_amf: "high", h264_qsv: "high", libx264: "high",
  hevc_nvenc: "main", hevc_amf: "main", hevc_qsv: "main",
  av1_amf: "main", av1_qsv: "main",
};
const TAKES_LEVEL = new Set([
  "h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_amf", "hevc_amf", "av1_amf", "libx264",
]);

// The low-latency flags are per vendor, not per codec: ffmpeg 9's hevc_nvenc
// and av1_nvenc take the same preset/tune/zerolatency/rc/forced-idr options
// as h264_nvenc (checked with ffmpeg -h encoder=...), and likewise for AMF and
// QSV. NVENC repeats the parameter sets (or the AV1 sequence header) on every
// IDR when no global header is asked for; the parsers put them back for any
// encoder that does not. The raw muxer is the codec's own: h264, hevc, obu.
// Which DXGI output ddagrab is pointed at, for a share value that was picked
// to describe a VNC framebuffer. The two are not the same vocabulary and
// nothing makes them agree.
//
// tvnserver takes -shareprimary, -sharedisplay N and -sharefull: Windows
// display designations - the monitor marked primary in Display Settings, and
// the monitors in the order Windows enumerates them. ddagrab takes one
// output_idx, which is IDXGIAdapter::EnumOutputs order on one adapter - the
// order the outputs hang off the card. Neither API promises the two orders
// match, so both of the single-screen cases below are an assumption:
//
//  - "primary" is output 0, assuming the primary monitor is the first output
//    of the first adapter. That is the usual arrangement; it is NOT VERIFIED
//    here, because checking it needs a second monitor and a real capture. When
//    it is wrong the viewer is shown the wrong screen rather than a stretched
//    one, and two monitors of the same shape make that indistinguishable from
//    the right one at this end.
//  - "2" is output 1, the same assumption one step along.
//  - "full" is the one this cannot honour at all, and is why it is now written
//    out separately instead of sharing a branch with "primary" as if the two
//    were the same request. -sharefull is the whole virtual desktop, every
//    monitor in one framebuffer. ddagrab has exactly one output_idx and no
//    virtual-desktop mode (ffmpeg 9.0.1, `ffmpeg -h filter=ddagrab`: output_idx,
//    offset_x/y, video_size, and nothing that spans outputs), and this build
//    carries no stack filter that takes D3D11 frames - `ffmpeg -filters` lists
//    xstack, xstack_qsv and xstack_vaapi, and scale_d3d11 is the only d3d11
//    filter in it. One ddagrab per output would therefore mean hwdownload of
//    every desktop every frame into a CPU xstack and hwupload back, which is
//    the read-back this file already refuses to do for a single scale.
//
// So "full" is served output 0: one monitor's picture for a framebuffer that
// describes several. Nothing at this end can fix that, and the viewer is the
// end that can see it - the config message carries the encoded width and
// height, and the page compares their shape against the framebuffer it is
// measuring the mouse against before it draws anything.
export function captureIndex(display) {
  if (display === "primary" || display === "full") return 0;
  return Number(display) - 1;
}

export function ffmpegArgs(encoder, s, scale = true) {
  const idx = captureIndex(s.display);
  // No cursor in the capture: the page keeps the browser's own pointer over
  // the canvas, which has no lag at all, and a captured one arrives a frame or
  // more later as a second cursor trailing the first. A game under pointer
  // lock draws its own cursor into the frame anyway.
  //
  // framerate is a cadence and not a ceiling: desktop duplication only hands
  // ffmpeg a surface when the desktop changes, but ddagrab's dup_frames option
  // defaults to on (ffmpeg 9.0.1, `ffmpeg -h filter=ddagrab`), so a still
  // screen still produces a frame every period. That is what makes counting
  // access units a usable clock in stamp(); it is also why dup_frames is not
  // written out here - it is already the default, and an option an older
  // ffmpeg does not know is a start failure rather than a warning.
  let filter = "ddagrab=output_idx=" + idx + ":framerate=" + s.fps + ":draw_mouse=0";
  // The picture cap. The scale runs on the CPU, after reading the captured frame back off the
  // GPU. That is not the shape this wanted. It is the shape that works here,
  // and it was arrived at by trying the GPU ones on the real host and watching
  // each fail:
  //
  //  - scale_d3d11 is the only scaler in this build that takes a D3D11 frame,
  //    and it cannot allocate its own output. Every variant fails the same
  //    way, in AVHWFramesContext before a frame is ever pulled: "Could not
  //    create the texture (80070057)", E_INVALIDARG. That is with ddagrab's
  //    device, with an explicit adapter (d3d11va=d3d:0), with a device derived
  //    through hwmap, with format=bgra and with nv12 - and, decisively, with
  //    no ddagrab in the graph at all: `-f lavfi -i testsrc,format=bgra,
  //    hwupload,scale_d3d11=width=1280:height=720:format=bgra` fails
  //    identically. So it is not ddagrab's texture pool that scale_d3d11
  //    cannot cope with, as was first suspected; the filter cannot make an
  //    output pool on this build and driver at all. (Its options are also
  //    width/height, not w/h - written w=/h= it never reaches the texture and
  //    fails earlier still with "Option not found", which is the form that
  //    shipped first and the reason the cap had never once applied.)
  //  - scale_cuda would suit this card, and getting a frame to it does not
  //    work: hwmap=derive_device=cuda off ddagrab's device fails with
  //    "Failed to created derived device context: -40" (ENOSYS). Reaching it
  //    the long way round - hwdownload, hwupload_cuda, scale_cuda - was not
  //    run, because it reads the frame back anyway and then pushes the
  //    full-size picture up a second time: more traffic than scaling it on the
  //    way past, by arithmetic rather than by measurement.
  //
  // So the choice on this host is not GPU scale against CPU scale. It is CPU
  // scale against no cap at all, and measured on this machine the CPU scale is
  // cheap enough that it is not a real contest. Eight seconds of the 1920x1080
  // desktop at sixty frames into h264_nvenc through exactly the command line
  // this function builds, -f null, nothing written to disk, twice each:
  // uncapped encoded 443 and 465 frames for 0.09s and 0.08s of process CPU;
  // capped to 1280x720 it encoded 458 and 464 frames for 0.55s and 0.70s. The
  // readback costs no frames - both held the rate, and the spread between runs
  // is larger than the difference between them - and it costs roughly 1.2ms of
  // one core per frame, under 8% of a core at sixty. That is the whole price
  // of the cap, against a Chromebook being handed 1080p60 H.264 at level 4.2.
  // The measurement is a 1080p desktop; a 4K one reads back four times the
  // bytes and scales four times the pixels, and that was NOT measured here.
  //
  // format=bgra is what hwdownload can take from ddagrab's pool, and the
  // format=nv12 on the end is what the encoders want; swscale folds the
  // conversion into the same pass as the scale rather than making two.
  //
  // The box itself is 16:9 at the asked-for height rather than a height on its
  // own: a height alone leaves the width free, and an ultrawide desktop cut to 720
  // rows still carries half again the macroblocks of 1280x720 - a different
  // level, and possibly a level too far. The picture is fitted inside the box
  // with its aspect ratio kept and is never enlarged, so a desktop already
  // inside the box is encoded exactly as it is. Both dimensions are truncated
  // to even for the chroma planes. The sizes are expressions because the
  // desktop's size is not known until ddagrab has opened; scale evaluates them
  // once at init (eval defaults to init), not per frame.
  const capH = s.maxh || DEFAULT_MAX_HEIGHT;
  const capW = Math.round(capH * 16 / 9) - (Math.round(capH * 16 / 9) % 2);
  const fit = "min(1\\,min(" + capW + "/iw\\," + capH + "/ih))";
  // One hwdownload, not two. The capped chain already ends on the CPU in nv12,
  // which is what libx264 needs, so the libx264 branch below only has to fire
  // when the cap is off - a second hwdownload on a frame that is already in
  // system memory is an error, not a no-op.
  if (scale) {
    filter += ",hwdownload,format=bgra,scale=w=trunc(iw*" + fit + "/2)*2:h=trunc(ih*" +
      fit + "/2)*2,format=nv12";
  } else if (encoder === "libx264") {
    // libx264 runs on the CPU and cannot read D3D11 textures; the others take
    // the captured frame straight from the GPU.
    filter += ",hwdownload,format=nv12";
  }
  // Give rate control a quarter-second budget: the old two-frame VBV forced
  // large keyframes to sharply lower quality, causing periodic quality pulses.
  // This is an encoder rate-control budget, not a playback buffer; frames are
  // still emitted immediately, without B-frames or decoder-side buffering.
  const vendor = encoder.split("_")[1] || encoder;
  // Constant bitrate spends the whole budget whatever is on screen, and a
  // screen is mostly still: a menu, a paused game, a page of text all cost the
  // full eight megabits in padding. NVENC's variable mode spends what the
  // picture needs and keeps the same ceiling for the frames that need it, so
  // nothing about a moving picture changes and the quiet stretches cost a
  // fraction. Motion still climbs to -maxrate, which is the number the viewer
  // asked for.
  //
  // The other vendors keep constant bitrate: their low-latency modes are built
  // around it, and this host encodes with NVENC.
  const vbr = vendor === "nvenc";
  // An average bitrate was tried first and it starved the still screen this
  // cast mostly shows: aiming at a fraction of the ceiling, rate control kept
  // pushing padding into deltas that had nothing to say and still quantised
  // the picture coarsely. Asking for a quality instead lets the deltas fall to
  // nothing when nothing moves and spends the bits on sharpening what is
  // there. Measured on the same screen at the same moment, 8 mbps, sixty
  // frames: the average aim cost 2.31 mbps and quantised keyframes at 19.8 and
  // deltas at 11.3; the quality aim costs 0.97 mbps at 16.0 and 9.9. Cheaper
  // on every frame and sharper on every frame, which is what a page of text
  // needs. -maxrate is still the viewer's ceiling and
  // motion still climbs to it.
  //
  // What none of these numbers flattens is the keyframe itself. A keyframe
  // against a delta on a still screen is two orders of magnitude of bytes, and
  // that burst arrives late and holds back the frames behind it, which is felt
  // as uneven motion however even the encoder's own output cadence is. Three
  // levers were weighed and two were left alone:
  //
  // - Intra refresh is the textbook answer - it spreads a keyframe's cost over
  //   a whole refresh cycle - and it is ruled out here, not deferred. It works
  //   by not coding IDRs, and three things in this file are built on IDRs
  //   arriving: the config message is not sent until the first keyframe gives
  //   up an SPS, the replay cache a joining viewer gets is reset by a keyframe
  //   and would otherwise grow without bound, and a viewer whose socket fell a
  //   megabyte behind is held on waitKey until the next keyframe. With no IDR
  //   after the first, a viewer who joins late or drops a frame never recovers.
  //   Handling a recovery point the way a keyframe is handled would be a
  //   different change in a different place.
  // - A bigger VBV only permits a bigger burst; a smaller one is what the
  //   two-frame budget above already was, and the comment records what it did
  //   to keyframe quality. Neither moves without a measurement, and none was
  //   taken here.
  // - A longer GOP is the lever that works, and it is the one already spent:
  //   GOP_SECONDS is held at one second because it is also how long a viewer
  //   that drops a frame waits to see a picture again.
  //
  // What does flatten the burst in this change is the picture cap above: a
  // keyframe costs what its pixels cost, and a capped picture is a smaller
  // keyframe by the same ratio. That is arithmetic, not a measurement.
  const rate = vbr
    ? ["-b:v", "0", "-cq", String(Math.min(51, Math.max(1, (QUALITY[codecOf(encoder)] || QUALITY.h264) + (s.cq || 0)))),
       "-maxrate", s.mbps + "M", "-bufsize", Math.round(s.mbps * 250) + "k",
       "-g", String(s.fps * GOP_SECONDS), "-bf", "0"]
    : ["-b:v", s.mbps + "M", "-maxrate", s.mbps + "M",
       "-bufsize", Math.round(s.mbps * 250) + "k",
       "-g", String(s.fps * GOP_SECONDS), "-bf", "0"];
  // p4 over p1, and low latency over ultra low: p1 is the fastest preset there
  // is and it shows in the bitrate, spending bits where a slightly less hurried
  // search would not have needed them - 1.42 mbps against p4's 1.20 at the same
  // quantiser, measured on the same screen. p7 buys nothing back (1.08 against
  // 1.09) and ull is byte-for-byte identical to ll once -zerolatency is on, so
  // the middle preset is where this sits. On a card that encodes 1080p60 in a
  // couple of milliseconds either way, the picture is the same and the file is
  // smaller. Spatial AQ moves bits from flat regions to detailed ones, which
  // is most of what a desktop is.
  //
  // -delay 0 because -zerolatency does not cover it. ffmpeg's nvenc holds
  // finished packets back until "delay" frames are in flight, and the default
  // (INT_MAX) is clamped to the surface count less one - three with no
  // lookahead and no B-frames, so every picture left the encoder two captures
  // after it was taken: 33ms at sixty, and more as the rate comes down. That is
  // read from ffmpeg's nvenc.c (output_ready), not measured on this host.
  const tune = {
    nvenc: ["-preset", "p4", "-tune", "ll", "-zerolatency", "1", "-delay", "0", "-rc", "vbr", "-spatial-aq", "1"],
    amf: ["-usage", "ultralowlatency", "-rc", "cbr"],
    qsv: ["-preset", "veryfast", "-look_ahead", "0"],
    libx264: ["-preset", "ultrafast", "-tune", "zerolatency", "-x264-params", "repeat-headers=1"],
  }[vendor] || [];
  // The level is worked out from the cap, not from the desktop, because the
  // desktop's size is not known until ddagrab has opened. The cap is an upper
  // bound on what is encoded, so the level asked for is never lower than the
  // picture needs - at worst a rung high on a desktop smaller than the box.
  // With the cap off there is no upper bound at all, so no level is named and
  // the encoder picks its own.
  const bound = [];
  if (PROFILES[encoder]) bound.push("-profile:v", PROFILES[encoder]);
  if (scale && TAKES_LEVEL.has(encoder)) {
    bound.push("-level", levelFor(codecOf(encoder), capW, capH, s.fps, s.mbps));
  }
  const after = (vendor === "nvenc" ? ["-forced-idr", "1"] : []).concat(bound);
  const mux = { av1: "obu", hevc: "hevc", h264: "h264" }[codecOf(encoder)];
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-fflags", "nobuffer",
    "-flags", "low_delay", "-init_hw_device", "d3d11va", "-filter_complex", filter,
    "-c:v", encoder].concat(tune, rate, after, ["-flush_packets", "1", "-f", mux, "pipe:1"]);
}

// A viewer can join the running encoder when the picture settings match and
// the codec it is producing is one the viewer can decode - not only when the
// lists are identical, or two browsers with different decoders would restart
// the encoder at each other for ever.
//
// The cap joins fps and mbps in that test rather than being waved through:
// two viewers that disagree about the size of the picture disagree about the
// picture, and serving the second one whatever the first asked for is how a
// light client silently gets handed the stream it cannot decode.
const canJoin = (a, b, encoder) =>
  a && b && a.fps === b.fps && a.mbps === b.mbps && a.display === b.display &&
  a.maxh === b.maxh && (a.cq || 0) === (b.cq || 0) && b.codecs.includes(codecOf(encoder));

// What the config message needs from the first keyframe: the WebCodecs codec
// string and the picture size, each read from the codec's own header.
const describe = {
  h264: (au) => Object.assign({ codec: codecString(au.sps) }, spsDimensions(au.sps)),
  hevc: (au) => hevcSpsInfo(au.sps),
  av1: (au) => av1SeqInfo(au.seq),
};

// What to call the codec when its own header cannot be read. The family is
// known from the encoder name whatever the bitstream says, and these are the
// exact strings the page probes each family with before it asks for one - so a
// viewer that negotiated the family has already had its decoder say yes to the
// string it would get back here. It is a name, not a measurement: a picture
// size cannot be guessed, so that is left out of the config instead.
const FAMILY_CODEC = {
  h264: "avc1.64002a", hevc: "hvc1.1.6.L120.90", av1: "av01.0.08M.08",
};

// The one line out of a failed ffmpeg run that is worth showing a person.
//
// ffmpeg says how it ended after it says why it ended. The last line of a
// failed run is nearly always a generic trailer - the muxer noticing the write
// failed, then "Conversion failed!" - while the line that names the cause
// (ddagrab losing the desktop duplication, a driver refusing to open the
// encoder) is one or more lines above it. Taking the last line therefore
// reports the symptom reliably and hides the reason every time, which is most
// of why a person watching this console cannot say what they saw.
const TRAILERS = [
  /^Conversion failed!/,
  /^av_interleaved_write_frame\(\)/,
  /^Error writing trailer/,
  /^Error muxing a packet/,
  /^Error closing file/,
  /^Error while filtering/,
  /^Task finished with error code/,
  /^Terminating thread with return code/,
  /^Exiting normally, received signal/,
];
export function ffmpegReason(tail) {
  const lines = String(tail || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // ffmpeg prefixes its own lines with the component that wrote them
  // ("[out#0/h264 @ 000001f0...] Error muxing a packet"). The prefix carries a
  // pointer, so it is stripped before matching rather than written into the
  // patterns - but it is kept in what is returned, because on the line that
  // does name the cause it says which filter or encoder that cause is about.
  const bare = (l) => l.replace(/^\[[^\]]*\]\s*/, "");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!TRAILERS.some((t) => t.test(bare(lines[i])))) return lines[i];
  }
  // Every line was a trailer. ffmpeg never said why, so say how: the last line
  // is still the truest thing available, and an empty reason is not printed.
  return lines.length ? lines[lines.length - 1] : "";
}

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
  let scaled = true;               // the picture cap is in the filter chain
  let encoder = "";
  let startedAt = 0;
  let frames = 0;                  // access units since the cadence was anchored
  let origin = 0;                  // the timestamp that anchor carries
  let lastTs = 0;                  // the timestamp the last unit carried
  let proven = false;              // this encoder has produced a picture
  let lastCrashAt = 0;
  let config = null;
  let gop = [];                    // [{ flags, ts, bytes }] from the last keyframe on
  let gopBytes = 0;                // their total, for the replay cap below
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
  //
  // The limit is a size and not a duration, though queued bytes are input
  // delay and a megabyte is most of a second of them. A duration was tried and
  // reverted: a tenth of a second at these bitrates is smaller than one
  // keyframe, so queueing a keyframe put the socket over the limit by itself,
  // every delta behind it was skipped, and the viewer got one picture per GOP.
  // Anything tighter than this has to measure itself against the keyframe, not
  // against the average frame.
  //
  // Skipping is how the queue drains, so the keyframe that ends it waits for
  // the queue to have drained. Resuming the moment the socket was back under
  // the limit put the viewer back on the stream with most of a megabyte - on a
  // slow tunnel, seconds - still between it and the screen, where it stayed.
  //
  // A size alone never trips on a queue that settles under it. A link a little
  // slower than the picture holds a viewer at 900KB for as long as it lasts -
  // most of a second behind the screen, every frame delivered, nothing ever
  // skipped - so time spent above RESUME_LIMIT counts too.
  const deliver = (e, au) => {
    const buffered = e.sink.buffered();
    if (buffered <= RESUME_LIMIT) e.behindSince = 0;
    else if (!e.behindSince) e.behindSince = Date.now();
    if (buffered > BACKLOG_LIMIT || (e.behindSince && Date.now() - e.behindSince > STANDING_MS)) {
      e.waitKey = true;
      return;
    }
    if (e.waitKey) {
      if (!(au.flags & 1) || buffered > RESUME_LIMIT) return;
      e.waitKey = false;
    }
    e.sink.au(au.flags, au.ts, au.bytes);
  };

  // A capture clock, not an arrival clock. Date.now() at the moment an access
  // unit falls out of the pipe carries everything that happened to it on the
  // way there: the encoder spending longer on a keyframe than on a delta, the
  // pipe filling, this process being scheduled late. A viewer that presents on
  // those timestamps presents the host's jitter as motion, which is the whole
  // thing a presentation clock at the other end exists to stop.
  //
  // ddagrab produces a frame every period whether or not the desktop changed,
  // so counting access units from an anchor and multiplying by the period is
  // the cadence the screen was actually sampled at - even, by construction.
  // The wall clock stays as the anchor of last resort: if the count drifts
  // further than CADENCE_SLIP_MS from it, the encoder is not keeping up and
  // the count would otherwise fall behind real time for ever, so the anchor is
  // moved to now and the count starts again from there. That costs exactly one
  // irregular step, and never a backwards one, because a viewer ordering
  // frames by these would have to throw away any frame that went back.
  const stamp = () => {
    const wall = Date.now() - startedAt;
    let ts = origin + Math.round(frames * 1000 / current.fps);
    if (Math.abs(ts - wall) > CADENCE_SLIP_MS) {
      ts = Math.max(wall, lastTs);
      origin = ts;
      frames = 0;
    }
    frames++;
    lastTs = ts;
    return ts;
  };

  const onAu = (parsed) => {
    if (!proven) {
      proven = true;
      retryOnce = false;
      log("DECODER+ " + codecOf(encoder) + " via " + encoder);
    }
    if (!config) {
      if (!parsed.key) return;                       // nothing to decode from yet
      // Reading the picture size means running an exp-Golomb reader over a
      // parameter set this build has never seen: an encoder that writes one
      // differently, or a keyframe that carries none at all, walks the reader
      // off the end of the buffer and throws. This runs inside the encoder's
      // stdout handler, where nothing above it is listening - so the host has
      // been ending for every viewer, over a picture size.
      //
      // Both dimensions are optional on the wire and the page treats them as
      // optional, so a header that cannot be read costs the config those two
      // fields. The codec string cannot be left out the same way - the page
      // has nothing to configure a decoder with - so the family's own name
      // stands in for it; see FAMILY_CODEC.
      const family = codecOf(encoder);
      let info = null;
      try {
        info = describe[family](parsed);
      } catch (e) {
        log("DECODER+ could not read the " + family + " header (" + e.message +
          ") - sending the config without a picture size");
      }
      config = {
        type: "config", codec: (info && info.codec) || FAMILY_CODEC[family],
        width: info ? info.width : undefined, height: info ? info.height : undefined,
        fps: current.fps, encoder, display: current.display, mbps: current.mbps,
      };
      for (const e of sinks) { try { e.sink.config(config); } catch (_) {} }
    }
    const au = { flags: parsed.key ? 1 : 0, ts: stamp(), bytes: parsed.bytes };
    // The cache is one GOP whatever its length - up to fps * GOP_SECONDS AUs.
    if (parsed.key) { gop = [au]; gopBytes = 0; } else gop.push(au);
    gopBytes += au.bytes.length;
    // One viewer per iteration, and a throw from one of them is that viewer's
    // problem and nobody else's. The sink lives in cast-host.mjs and guards
    // itself today, but this loop is where every other viewer's next frame
    // comes from and it is a long way from that guard: a throw here ends the
    // fan-out part way through the set, and - being inside the encoder's
    // stdout handler - takes the host with it. A sink that threw may have put
    // half a frame on the wire, so it resumes on the next keyframe.
    for (const e of sinks) {
      try { deliver(e, au); } catch (_) { e.waitKey = true; }
    }
  };

  // Killing the encoder and starting its replacement are one decision, but
  // they cannot be one tick. On Windows kill() is TerminateProcess, and ffmpeg
  // holds the D3D11 desktop duplication until the process itself is gone - so
  // a replacement spawned in the same tick can find the desktop still taken
  // and fail to start. That failure is indistinguishable from "this encoder is
  // not available on this machine", which is what the exit handler concludes:
  // encoderIdx walks nvenc, amf, qsv, libx264, every one of them racing the
  // same dying process, and the run ends at closeAll(1011, "no encoder") - one
  // viewer changing its frame rate killing the stream for everybody, with a
  // reason that is not true.
  //
  // So the start waits, and it waits on the old process's own exit rather than
  // on a clock: a start with nothing to wait for is not delayed at all, and
  // the timeout below is a bound rather than a delay - it matters only if the
  // exit never arrives at all.
  //
  // That removes the cause. retryOnce bounds the damage, and it is a second
  // fix rather than the same one, because a start can still lose the screen
  // for a reason no exit event can be waited on: an ffmpeg that an *earlier*
  // run of this host orphaned is still on the duplication, and this process
  // never had its exit to wait for. Either way the first start after a restart
  // this host asked for is evidence about the screen and not about the
  // encoder, so it gets that encoder a second time before the chain moves on.
  // One extra spawn, once; every other failure walks the chain as before.
  const KILL_SETTLE_MS = 2000;
  let dying = null;                // killed, not yet seen to let go of the screen
  let queued = null;               // the start that is waiting for it
  let retryOnce = false;           // this start follows a kill; do not judge the encoder by it

  const kill = () => {
    if (!child) return;
    const c = child;
    child = null;
    dying = c;
    const settle = () => {
      if (dying !== c) return;
      dying = null;
      const next = queued;
      queued = null;
      if (next && !stopped) next();
    };
    const t = setTimeout(settle, KILL_SETTLE_MS);
    t.unref();
    // A spawn that never got as far as a process emits 'error' and may never
    // emit 'exit'; both mean the same thing here.
    c.once("exit", () => { clearTimeout(t); settle(); });
    c.once("error", () => { clearTimeout(t); settle(); });
    c.kill();
  };

  // Start, but not before whatever we just killed has let go of the screen.
  // Only ever one start is waiting: a second viewer restarting during the
  // settle replaces the first one's settings rather than queueing behind them,
  // which is the same last-writer-wins the immediate path already had.
  const startWhenFree = (settings) => {
    if (!dying) { start(settings); return; }
    queued = () => start(settings);
  };

  const start = (settings) => {
    current = settings;
    config = null;
    gop = [];
    gopBytes = 0;
    proven = false;
    frames = 0;
    origin = 0;
    lastTs = 0;
    for (const e of sinks) e.waitKey = true;
    // The first requested codec's encoders, then the next codec's: a host
    // without an AV1 encoder still serves HEVC or H.264.
    chain = settings.codecs.flatMap((c) => ENCODERS[c]);
    encoder = chain[encoderIdx];
    if (!encoder) {
      // Nothing started. If the picture cap was in the filter chain it is the
      // first thing to suspect, because it is the one part of the command line
      // that is the same for every encoder and could therefore fail for all of
      // them at once - and a host that cannot scale on its GPU should still
      // stream at its native size, as it did before there was a cap at all.
      if (scaled) {
        scaled = false;
        encoderIdx = 0;
        log("DECODER+ nothing started with the picture cap - retrying without it");
        start(settings);
        return;
      }
      log("DECODER+ no encoder could start (tried " + chain.join(", ") + ")");
      current = null;
      closeAll(1011, "no encoder");
      return;
    }
    const codec = codecOf(encoder);
    const parser = codec === "av1" ? parseObu() : parseAnnexB(codec);
    let errTail = "";
    const proc = spawn(bin, binArgs.concat(ffmpegArgs(encoder, settings, scaled)),
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child = proc;
    startedAt = Date.now();
    let lastAuAt = 0;
    proc.stdout.on("data", (chunk) => {
      if (child !== proc) return;
      for (const au of parser.feed(chunk)) { lastAuAt = Date.now(); onAu(au); }
    });
    // A process can outlive its picture: desktop duplication wedged after a
    // UAC prompt, the secure desktop or a mode change, without ffmpeg exiting.
    // Nothing else notices - the viewers' pings are answered by this host, not
    // by the encoder - so every viewer holds the last picture for ever. Killed
    // here rather than through kill(), so the exit handler below takes it as a
    // crash: restarted once, and closed with 1011 if it wedges again within
    // CRASH_WINDOW_MS. Not armed before the first picture (the exit handler's
    // start-up rules own that) or while nobody is watching.
    const watchdog = setInterval(() => {
      if (child !== proc) { clearInterval(watchdog); return; }
      if (!proven || !sinks.size || Date.now() - lastAuAt <= STALL_MS) return;
      clearInterval(watchdog);
      errTail += "\nno picture from the encoder for " + STALL_MS / 1000 + "s";
      proc.kill();
    }, 500);
    watchdog.unref();
    proc.stderr.on("data", (c) => {
      errTail = (errTail + String(c)).slice(-2000);
    });
    proc.on("error", (e) => { errTail += e.message; });
    proc.on("exit", (code) => {
      if (child !== proc) return;                    // stopped or replaced on purpose
      child = null;
      for (const au of parser.flush()) onAu(au);
      const lived = Date.now() - startedAt;
      const why = ffmpegReason(errTail);
      if (!proven || lived < STARTUP_MS) {
        // Never produced a picture: this encoder is not available on this
        // machine (no such GPU, driver too old). Try the next one.
        log("DECODER+ " + encoder + " failed (exit " + code + ")" + (why ? ": " + why : ""));
        if (retryOnce) {
          retryOnce = false;
          start(settings);                           // the same encoder, once
          return;
        }
        encoderIdx++;
        start(settings);
        return;
      }
      if (Date.now() - lastCrashAt < CRASH_WINDOW_MS) {
        log("DECODER+ " + encoder + " died again (exit " + code + ")" + (why ? ": " + why : ""));
        current = null;
        closeAll(1011, "encoder died");
        return;
      }
      lastCrashAt = Date.now();
      log("DECODER+ " + encoder + " exited (" + code + ")" + (why ? ": " + why : "") + " - restarting");
      // This encoder was producing pictures a moment ago, so a restart that
      // fails is about whatever ended it - the desktop duplication lost to a
      // UAC prompt or a mode change - not about the encoder. Walking the chain
      // on it would land on libx264 or an uncapped picture for the rest of the
      // session the moment the screen came back.
      retryOnce = true;
      start(settings);
    });
  };

  const stopEncoder = () => {
    kill();
    queued = null;                 // a deliberate stop outranks a waiting start
    current = null;
    config = null;
    gop = [];
    gopBytes = 0;
  };

  const subscribe = (settings, sink) => {
    if (stopped) { sink.close(1011, "stopped"); return () => {}; }
    clearTimeout(idleTimer);
    idleTimer = null;
    const entry = { sink, waitKey: true, behindSince: 0 };
    sinks.add(entry);
    if (child && canJoin(current, settings, encoder)) {
      // Joining a running stream: the config and the cached GOP let the
      // decoder start on the keyframe it needs instead of waiting for the
      // next one. A five-second GOP at the top bitrate is several megabytes,
      // and a replay that big would only be skipped by deliver part way
      // through, leaving the viewer on a half GOP; that viewer waits for the
      // next keyframe instead, as it would with no cache at all.
      if (config) {
        sink.config(config);
        if (gopBytes <= BACKLOG_LIMIT) for (const au of gop) deliver(entry, au);
      }
    } else {
      // The first viewer picks the settings; a later one who wants something
      // else restarts the encoder for everyone. Start over at the top of the
      // chain: the failure may have been about the old settings.
      if (child) log("DECODER+ restarting for " + settings.fps + " fps / " + settings.mbps + " mbps / " + settings.maxh + "p / cq " + (settings.cq > 0 ? "+" : "") + settings.cq + " / " + settings.display + " / " + settings.codecs.join(","));
      const deliberate = !!child || !!dying;
      kill();
      encoderIdx = 0;
      scaled = true;
      retryOnce = deliberate;
      startWhenFree(settings);
    }
    return () => {
      if (!sinks.delete(entry)) return;
      // A start still waiting on the old encoder's exit counts as running: a
      // viewer that switches settings and leaves inside that wait would
      // otherwise have the encoder start after it for nobody, with no idle
      // stop ever set - on the GPU until the next viewer or the host's end.
      if (sinks.size || (!child && !queued)) return;
      // Keep the encoder warm across a viewer's reconnect; stop it if nobody
      // comes back so an idle host is not burning GPU on nothing.
      // unref'd: keeping an idle encoder warm is worth three seconds of GPU,
      // not three seconds of a host that is otherwise finished and waiting.
      idleTimer = setTimeout(() => { idleTimer = null; if (!sinks.size) stopEncoder(); }, IDLE_MS);
      idleTimer.unref();
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

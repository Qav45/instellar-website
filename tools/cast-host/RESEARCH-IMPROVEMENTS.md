# /cast: what comparable tools do that we could copy

Researched 2026-10-19. Compared against `README.md`, `video.mjs` and `cast/index.html` as they
stand (including uncommitted work). Nothing here is implemented yet.

## Read this first: how solid the evidence is

The web research was thin. I could read Parsec's browser-client post and the Sunshine config docs.
The Sunshine and Parsec protocol internals, RustDesk's QoS code and KasmVNC's congestion handling
were **not** retrievable (rate-limited or not documented). Where an item rests on general
knowledge rather than a source I read, it is marked **(unverified)**. Verify before building.

## What we already do (so we don't "copy" it again)

| Technique (from other tools) | Already in `/cast` |
| --- | --- |
| Hardware encode, no B-frames, tiny VBV, zero-latency (Sunshine, Parsec, NVIDIA guidance) | `video.mjs`: NVENC `p4`, `-tune ll`, `-zerolatency`, `-delay 0`, `-bf 0`, quarter-second VBV |
| Quality-targeted VBR so still screens cost almost nothing (KasmVNC "idle sends nothing") | `-cq` with `-maxrate`; measured 0.97 vs 2.31 mbps |
| Codec negotiation by client hardware decode (Parsec/Moonlight) | AV1, then HEVC, then H.264 via `isConfigSupported` |
| Drop to the next keyframe when a viewer falls behind | 1 MiB socket backlog plus `LAG_QUEUE`/`LAG_MS` on the client |
| Presentation clock from host timestamps (jitter buffer) | "presentation clock", 8 to 50 ms |
| Client-side adaptation ladder (fps, mbps, height) | `STREAM_STEPS`, `STREAM_HEIGHTS` |
| Performance overlay telling CPU from network (KasmVNC) | fps tooltip: decode duty, backlog, requested rate |
| Cursor and relative mouse via a separate channel | `/mouse` plus `SendInput` |

Don't re-propose these. Intra refresh is already **ruled out in a comment** in `video.mjs`
(~line 829) because the viewer-join, replay and recovery logic all depend on IDRs.

## Candidates, ranked by value for this setup

Context: host is the RTX 4070 PC, viewer is a Chromebook, path is a Cloudflare quick tunnel
(TCP/WebSocket, ~50 ms RTT).

### 1. Change bitrate live instead of restarting the encoder (high value)
- **Who does it:** Parsec adjusts the encoder bitrate directly from transport feedback
  ([Parsec](https://blog.parsec.app/a-networking-protocol-built-for-the-lowest-latency-interactive-game-streaming-1fd5a03a6007/)).
  NVENC supports rate-control reconfiguration without a new session (NVIDIA programming guide,
  **unverified** in detail).
- **Us:** every step on the ladder is an ffmpeg restart. The comments in `index.html` say a
  height change "costs everyone on that encoder a restart and a fresh keyframe", and the ladder
  is deliberately coarse because of it. This is also why Higher Connectivity cannot trade
  quality for ping smoothly.
- **Constraint:** ffmpeg's CLI cannot reconfigure a running `h264_nvenc`. Options:
  (a) a small native sidecar using the NVENC SDK. This breaks the "no dependencies" rule for
  `tools/cast-host`, so it needs the owner's say; (b) keep ffmpeg and make restarts cheaper
  (reuse the cached GOP, send the keyframe first, restart on the quiet side); (c) run two
  encoders (high and low) and switch the viewer between them at a keyframe. (c) fits the
  dependency-free rule, costs a second NVENC session, and gives instant steps.
- **Recommendation:** prototype (c) behind a flag, measure the step-change freeze against today's
  restart.

### 2. Recover from loss without waiting for the 1 s GOP (medium)
- **Who does it:** Sunshine/Moonlight track IDR and reference-frame-invalidation as separate
  encoder states (Sunshine docs list `after_ref_frame_invalidation` and `idr` flags). Reference
  frame invalidation (RFI) re-predicts from a frame the client still has, avoiding an IDR burst.
  A related Apollo fix targeted IDR delays after packet loss
  ([commit](https://izackpgit.duckdns.org/izackp/Apollo/src/commit/667878d2ebeb636603c315101d96d621a3b6bece)).
- **Us:** a viewer that falls behind waits for the next scheduled keyframe (up to 1 s). Because
  the transport is TCP, true packet loss never reaches us; the stall is head-of-line blocking.
- **Cheap version (no RFI):** a client-to-host "keyframe now" message on the existing sockets, so
  recovery takes one RTT plus one IDR instead of up to a second. ffmpeg cannot force an IDR
  mid-stream from outside either (`-forced-idr` only honours keyframes ffmpeg itself requests),
  so this ties into item 1: with two encoders or a sidecar it becomes possible.
- **RFI proper:** needs the NVENC SDK directly. Not viable under the current rules.

### 3. Pause the stream when the tab is hidden: already done
- Parsec's web client halts the stream on a hidden tab
  ([Parsec](https://parsec.app/blog/game-streaming-tech-in-the-browser-with-parsec-5b70d0f359bc)).
- **Us:** the `visibilitychange` handler (`index.html`) already zeroes the VNC rate and flushes
  decoded frames. Leaving the `/video` socket open is a deliberate choice, documented there.
  Nothing to add.

### 4. Low-latency canvas hint: added, off by default
- noVNC owns the canvas context (`cast/novnc.js`), so the hint is set there:
  `localStorage.setItem("cast.desync","1")` and reload. It lets Chrome skip compositor sync and
  can shave a frame. **Unmeasured** on ChromeOS; possible tearing is the cost.

### 5. Readable text under H.264 (medium, speculative)
- **The problem:** 4:2:0 chroma subsampling puts halos on text. RDP added AVC 4:4:4 specifically
  to fix this, and earlier RDP used a separate text codec alongside H.264
  ([Microsoft](https://cloudblogs.Microsoft.com/enterprisemobility/2016/01/11/remote-desktop-protocol-rdp-10-avch-264-improvements-in-windows-10-and-windows-server-2016-technical-preview/)).
- **Us:** the README says text is softer in DECODER+ and tells users to switch it off to read
  code. That is a hybrid by hand.
- **Status: added as the Auto button (off by default; thresholds are starting values, untuned).**
- **Idea:** automatic hybrid: when the screen is mostly still, show Tight (lossless) and switch
  to the video path on sustained motion. The component pieces exist (`rfb.pixels` toggling,
  ladder parked at 0); the new part is the detector. KasmVNC does a version of this with
  "full screen video detection" ([docs](https://kasm.com/kasmvnc/docs/latest/clientside.html)).
  Detect motion from the incoming Tight update rate and area on the client, so no host change is
  needed.
- **HEVC 4:4:4:** NVENC can encode it, but Chromebook hardware decode of 4:4:4 is unlikely
  (**unverified**). Don't build this without a `isConfigSupported` check on the actual device.

### 6. Host audio (medium effort, a feature rather than latency)
- Parsec sends 20 ms Opus frames at 48 kHz on their own channel, decoded with WebAssembly Opus
  and played through Web Audio, with care to avoid overbuffering. The README says RFB has no
  audio and only the **mic** is relayed. Capturing system audio the same way as the mic
  path (`audio.mjs`) would reuse the existing channel. Wanting game or video sound on the
  Chromebook is a clear use of this tool; confirm that you want it before I scope it.

### 7. Delay-gradient congestion signal (medium, only if item 1 lands)
- WebRTC's congestion control watches the trend in packet arrival delay and cuts rate when it
  rises, before loss occurs
  ([GCC draft](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-01)).
- **Us:** strain detection is decode backlog plus ping-over-floor (`LAG_QUEUE_MS`), which is
  already a delay signal. The gain would be reacting in tens of milliseconds rather than
  seconds, which only matters if steps are cheap (item 1). Don't do this first.

## Looked at and rejected

- **Forward error correction (Sunshine's 20% default):** FEC protects UDP packets. Our transport
  is TCP over a tunnel, so there is no packet loss to correct.
- **Custom UDP protocol / WebRTC:** Cloudflare quick tunnels carry TCP and WebSocket only, and
  Vercel cannot hold a WebSocket (see `api/cast.mjs`). A UDP path would mean a different tunnel
  design and a real NAT-traversal story. Out of scope unless the tunnel is replaced. WebTransport
  has the same blocker (**unverified** that quick tunnels cannot carry it).
- **MSE low-delay mode (Parsec web):** we use WebCodecs, which gives direct control of the decode
  queue. The newer approach, not the older one.
- **Intra refresh:** already weighed and rejected in `video.mjs` for good reasons.
- **UHQ NVENC tuning:** an arXiv study reports UHQ breaks cloud-gaming latency limits
  ([paper](https://arxiv.org/pdf/2605.01187)). We use `p4`, and `p7` measured no gain.

## Suggested order

1. Items 3 and 4 first: small, independently testable, and answerable by measurement.
2. Item 5's motion detector: client-only, reversible, and addresses the one stated weakness.
3. Item 1 as a flagged prototype (two encoders); items 2 and 7 follow from it.
4. Item 6 only if you want sound.

## Constraints to respect

- `#1234` link and view key: none of the above touches either.
- No `npm install` in `tools/cast-host`; any sidecar needs your approval.
- `cast-host.mjs` and `video.mjs` have uncommitted edits from the adaptive-fps wave, so changes
  there should land after that set is committed.
- No frames written to disk; item 5's motion detection must read from the canvas or update
  stream in memory only.

## Sources

- [Parsec: BUD protocol](https://blog.parsec.app/a-networking-protocol-built-for-the-lowest-latency-interactive-game-streaming-1fd5a03a6007/)
- [Parsec: browser client](https://parsec.app/blog/game-streaming-tech-in-the-browser-with-parsec-5b70d0f359bc)
- [Sunshine configuration](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html)
- [KasmVNC client side](https://kasm.com/kasmvnc/docs/latest/clientside.html)
- [Apollo IDR-after-loss fix](https://izackpgit.duckdns.org/izackp/Apollo/src/commit/667878d2ebeb636603c315101d96d621a3b6bece)
- [IETF GCC draft](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-01)
- [Microsoft RDP 10 AVC 444](https://cloudblogs.Microsoft.com/enterprisemobility/2016/01/11/remote-desktop-protocol-rdp-10-avch-264-improvements-in-windows-10-and-windows-server-2016-technical-preview/)
- [NVENC tuning study (arXiv)](https://arxiv.org/pdf/2605.01187)

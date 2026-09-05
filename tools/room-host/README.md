# Room host

Run `node room-host.mjs` on this Windows machine to serve the camera at `/room`.
The host reads its gitignored `.env`; the watch link and publish key are separate.

## Video latency

The Wyze bridge feeds MediaMTX. Cloudflared exposes only its HLS port, 8888.
Compose explicitly sets `MTX_HLSVARIANT=lowLatency`: the bridge otherwise sets
an environment override of `mpegts`, even when mediamtx.yml says lowLatency.
The playlist must contain `EXT-X-PART` and `PART-HOLD-BACK`, with 200 ms parts.
The page lets hls.js follow that hold-back instead of forcing a full camera GOP.

A desktop browser check through the public tunnel measured approximately 1.4 s
behind the live edge. This is player-reported latency, not a glass-to-glass timing
measurement; network conditions and camera encoding add variability. Safari's
native player may buffer differently. WebRTC needs a separate direct ICE or TURN
media path; an HTTP tunnel alone only transports its signaling.

## Camera speaker

Speech is synthesized with Windows SAPI **to a WAV file**, then sent through
go2rtc's native Wyze talkback. The PC's speakers/headphones are never selected.
Messages play serially, with a synthesis watchdog and cleanup. The default voice
rate is -4 (David voice), slower than the initial test. The host collects speech every two seconds.
The website refuses new messages while the host reports an unavailable speaker.

This camera is a Wyze v3, firmware 4.36.10.4054. Native go2rtc 1.9.14 talkback was
tested and the owner confirmed sound from the camera. Its sendonly codec is
PCML/8000. No firmware change or microSD modification was needed.

go2rtc's default discovery port did not work here. `configure-camera.py` derives
the actual port from the bridge's live camera packets and reuses its cached
credentials without another cloud login. Re-run it after a camera reboot if
talkback stops connecting. The go2rtc API stays on 127.0.0.1:1984; never tunnel it,
because its responses contain camera credentials and it can launch FFmpeg.

## Speech to text

Local `faster-whisper` is the default, using `base.en` on the CPU. FFmpeg reads the
camera microphone through the bridge's loopback RTSP port. Recognition uses one
second chunks with one second of overlap, word timestamps to avoid repeating
overlap, and voice activity detection to suppress silence. Capture has a bounded
queue so slow inference cannot accumulate an unlimited audio backlog.

Transcription takes several seconds and is independent of the video player's
delay. Audio is processed locally; transcript text is sent to the website. The
first start downloads model files. `DEEPGRAM_KEY` optionally selects cloud
recognition instead. `--no-stt` disables recognition; `--no-say` disables speech.

## Setup / restart

1. Copy `.env.example` to `.env` and fill in Wyze credentials, view/publish keys,
   and the camera name. Keep the view and publish keys different.
2. Install FFmpeg (`winget install Gyan.FFmpeg`) and cloudflared.
3. Install local recognition: `python -m pip install -r requirements.txt`.
4. Run `docker compose up -d`. The `.runtime/tokens` mount preserves Wyze login
   cache across container recreations. All published ports bind to loopback.
5. Download the [official go2rtc 1.9.14 Windows binary](https://github.com/AlexxIT/go2rtc/releases/tag/v1.9.14)
   and extract `go2rtc.exe` into `.runtime`.
6. While the bridge is streaming, run `python configure-camera.py`.
7. Run `node room-host.mjs`. It starts go2rtc if its local API is not already up,
   creates a tunnel, starts recognition, and prints the watch link.

Do not run multiple hosts. Stop the old host and its children before restarting.
The tunnel URL changes on restart, but the watch link remains the same. Anyone
who learns the tunnel URL can watch until it is replaced. Keys, native camera
config, speech WAVs, binaries, and local logs stay in ignored files.

## Verification

`node test/registry.test.mjs` checks the real handler with a simulated Redis store:
view/publish authorization, blocked viewers, queue limits, transcript cursors,
and unavailable-speaker rejection. `node --test test/camera-speech.test.mjs`
checks WAV duration parsing used to serialize speech.

References: [native Wyze support](https://github.com/AlexxIT/go2rtc/tree/master/internal/wyze),
[stream-to-camera API](https://github.com/AlexxIT/go2rtc/tree/master/internal/streams),
[faster-whisper](https://github.com/SYSTRAN/faster-whisper).

RTSP probing is limited and FFmpeg input buffering disabled for recognition.
Measured first-second delivery improved from 3.7 s to 1.9 s. The page polls every
750 ms. Camera speech uses a speech-band filter and 85% synthesis volume.

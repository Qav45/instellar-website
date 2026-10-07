# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A static website with no build step and no root `package.json`. Every directory
with an `index.html` is a page served as-is: `/rules`, `/punishment`, `/apply`,
`/panel` (staff moderation panel), `/cast` (remote desktop viewer), `/room`
(room camera), `/cool-things`, `/desktop`. The serverless functions live in `api/`
(Vercel, `*.mjs`), and `vercel.json` sends every path that isn't under `/api/`
through `api/px.mjs` (the path-prefix proxy). Deploying means pushing to `main`.

- `panel/`: plain scripts on `window.P`, not modules, loaded in a fixed order.
  The screen-module contract is at the top of `panel/js/core.js`. It talks to
  Supabase directly. `panel/legacy/`, `extracted/` and the root `*.dc.html`
  files are the old bundled build: they are stale, so don't edit them.
- `supabase/*.sql`: schema and RLS changes. These are **not** applied
  automatically. The owner runs each one by hand in Supabase, so say so
  whenever a change depends on one.
- `tools/cast-host/`: Node 18+ with no dependencies (do not add an
  `npm install`). This is the host side of `/cast`: a TightVNC bridge (VNC+),
  a GPU video path via ffmpeg (DECODER+), and a cloudflared tunnel.
  `api/cast.mjs` is only a registry of the tunnel URL, backed by Upstash KV,
  because Vercel can't hold a WebSocket. Pixels go straight from the browser to
  the host's tunnel. Its README explains the design in depth, so read it before
  changing the stream.
- `tools/room-host/`: the host side of `/room` (`api/room.mjs`). It uses a Wyze
  bridge, MediaMTX HLS and go2rtc via `docker-compose.yml`, plus Python helpers
  (`requirements.txt`: faster-whisper, MediaPipe) for speech-to-text and palm
  lock. It reads a gitignored `.env` (see `.env.example`). Never tunnel the
  go2rtc API on :1984.
- `tools/panel-qa/`: runs the panel against a fake Supabase (see its README;
  the mock password is `test`).

## Commands

```
node --test tools/cast-host/test/*.test.mjs             # cast-host suite (node:test, fakes for ffmpeg/tunnel/mic)
node --test tools/cast-host/test/video.test.mjs         # a single file
node --test tools/room-host/test/*.test.mjs             # room-host suite
node tools/panel-qa/check.js                            # static panel checks; exits 1 on failure
tools\cast-host\cast.cmd [--lan]                        # run the cast host
node tools/room-host/room-host.mjs [--no-stt] [--no-say] # run the room host
```

For the panel, open `tools/panel-qa/dev.html?as=qav45#<screen>` from a static
server at the repo root. The README lists the query parameters.

## The room camera

Never take a screenshot, still, recording, or any other image out of the room
camera, and never look at its video. That covers the watch page, the HLS stream,
the bridge's RTSP ports, go2rtc, and any FFmpeg command that would write a frame
to a file - `-frames:v`, `image2`, `-f mjpeg`, a screenshot tool pointed at the
player, all of it. It is a camera in someone's home, and the person asking for a
feature has not asked to be photographed for it.

Reading frames in memory is allowed where a feature needs it: `gesture-lock.py`
decodes frames to detect a hand and drops them. Frames must stay in memory, never
reach disk, and never be shown to a model or a person. What may leave that loop is
derived data - measurements, verdicts, transcript text - not pictures.

If an image is ever captured, say so plainly and immediately, name the file, and
delete it. Do not wait to be asked.

## The cast view key is 1234. Leave it alone.

The view key in `~/.instellar-cast/token` is `1234`, the watch link is
`https://go.instellar.net/cast#1234`, and that is the owner's settled decision.
Do not rotate it, regenerate it, lengthen it, delete the token file, or "fix" it
as a security finding. It has already been raised with them, in detail and more
than once, and they have chosen this deliberately. Raising it again is not
diligence, it is nagging.

`1234` is also the ENTRY code for the calculator cover, and those two being the
same string is intentional, not a collision to be resolved. `#1234` supplies the
access key and skips the cover in one go, landing on the VNC+ password prompt.
The hash is the access key (`hash || store.get("castToken")`); `SKIP_COVER`
governs the cover only. If you change one of those, check the other.

An audit will keep reporting that a four-digit view key is the only thing in
front of a remote desktop. That finding is correct and it is accepted. Record it
if a report calls for it; do not act on it. The cover calculator is a disguise,
not security - the file's own "the way in" section says so.

If a change of yours would break the `#1234` link, stop and ask first.

# Watching a room from /room

Run `room-host.mjs` on the machine that shares a LAN with the Wyze camera, then
open `instellar.net/room#<view key>` anywhere else and you get the room's picture,
a running transcript of what is said in it, and a box that says things back.

## Why it is built this way

Wyze has no public streaming API, so nothing can talk to the camera directly - not
a browser, not a Vercel function. The only ways off a Wyze cam are the abandoned
RTSP firmware (v2/v3/Pan only, unmaintained since 2019) or `docker-wyze-bridge`,
which logs into the Wyze account, pulls the camera over Wyze's own P2P protocol
and re-serves it locally. This uses the bridge, which is why there has to be a
machine on the camera's network at all.

From there it is `/cast` again, and for the same reason written up in
`tools/cast-host/README.md`: a Vercel function cannot hold a socket open, so the
video does not flow through instellar.net. `/api/room` is only a registry that
remembers where the host's tunnel currently is, and the page fetches the playlist
straight from it.

```
Wyze v3 ──P2P──> wyze-bridge ──> cloudflared ──> browser <video>
                   │  :8888 HLS                        │
                   │  :8554 RTSP                       │
                   ▼                                   │
              ffmpeg ──> Deepgram ──┐                  │
                                    ▼                  ▼
              SAPI <── say queue ── /api/room <── GET (view key)
                                    ▲
                     POST tunnel URL every 30s
```

## HLS, not WebRTC

The bridge can serve WebRTC and it would be a second or two quicker, but it cannot
be used **through a tunnel**. WHEP signalling is HTTPS and would go through fine;
the media itself is UDP to an ICE candidate, and a Cloudflare tunnel carries HTTP.
The handshake would succeed and the picture would never appear.

So the video is HLS and arrives a few seconds late. That delay lands only on the
picture: the transcript is cut from the bridge's RTSP port on the host machine and
never goes near the tunnel, so what is said in the room reaches the page promptly
even though the lips moved several seconds ago.

## The camera's own speaker

It cannot be used, and this is worth writing down so it is not attempted twice.
Two-way audio in the Wyze app runs over their proprietary TUTK protocol.
`docker-wyze-bridge` has never implemented the sending half - issue #533 has been
open as an unimplemented enhancement since August 2022 - and its audio
documentation covers only audio *from* the camera. Home Assistant users hit the
same wall and are told to use the Wyze app.

So spoken messages come out of **this machine's speakers** instead, via Windows
SAPI. If the machine is not in the room, nothing about the rest of this changes:
point a phone or tablet in the room at the page and have it speak instead. The
registry, the transcript and the queue are all the same either way.

## Two keys, not one

The same split `/cast` uses, and it matters more here.

- **view key** (`ROOM_VIEW`) travels in the watch link, so it reaches everyone
  invited to watch. It reads the endpoint, reads the transcript, and queues speech.
- **publish key** (`ROOM_PUBLISH`) never leaves this machine. It is the only thing
  that can move the endpoint, add transcript lines, or take the room down.

Were they one key, any viewer could publish an endpoint of their own and every
other viewer's page would connect to it - handing a stranger the room's camera and
microphone. Only the SHA-256 of each is stored. `room-host.mjs` refuses to start
if the two are equal.

Blocking is shared with the proxy: an IP blocked in `/cool-things/ip` cannot read
this room or make it talk, deliberately, because one block switch should cover
everything.

## Setting it up

1. **Wyze API key.** From <https://developer-api-console.wyze.com/#/apikey/view>.
   Wyze requires this on top of the account password now.
2. **Turn off automatic firmware updates for the camera in the Wyze app.** The
   bridge tracks Wyze's firmware and v3 owners have had it break under them after
   an automatic update.
3. `cp .env.example .env` and fill it in. `.env` is gitignored and none of it is
   set on Vercel or reaches the browser.
4. `docker compose up -d` - the bridge takes a minute or two to log in and open
   the camera. `http://127.0.0.1:5000` shows what it thinks it has.
5. `winget install Gyan.FFmpeg` if there is to be a transcript. Without ffmpeg the
   video and the talking still work; there is simply no transcript.
6. `node room-host.mjs`

`--no-stt` runs without the transcriber, `--no-say` logs messages instead of
speaking them, `--tunnel none` publishes nothing and just serves locally.

Leaving `DEEPGRAM_KEY` blank is the switch that keeps the room's audio in the
house: nothing is sent anywhere, and everything except the transcript still works.

## Tests

```
node test/registry.test.mjs
```

Drives the real `api/room.mjs` against an in-memory stand-in for Upstash. The
cases that matter are the ones in capitals - a viewer cannot repoint the camera,
cannot unpublish it, cannot forge transcript lines, and a blocked address cannot
make the room talk.

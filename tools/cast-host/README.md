# Casting a machine to /cast

Run `cast.cmd` on the machine you want to reach, then open
`instellar.net/cast` anywhere else and you have its screen, keyboard
and mouse in a browser tab.

## Why it is built this way

Vercel functions cannot hold a WebSocket open, so the pixels cannot flow through
instellar.net. They do not: `/api/cast` is only a registry that remembers where
the host currently is, and the page then speaks RFB **straight** to the host's
tunnel. No serverless hop in the pixel path is the first reason this stays quick.

```
browser ──wss──> cloudflared ──> cast-host bridge :6080 ──tcp──> TightVNC :5900
   │                                        │
   └─── GET /api/cast (access key) ─────────┘ POST the tunnel URL every 30s
```

## Making it fast

Four things dominate how fast this feels, and the toolbar shows all four live so
they can be argued with rather than taken on faith. The fourth is the one that
says whether the other three worked: **fps** reads `delivered / asked for` and
goes amber, then red, as the gap widens — hover it for decode duty, receive
backlog and the rate currently being requested, which do not deserve toolbar
width. With nothing driving a rate it shows the delivered number alone rather
than inventing a target for a healthy stream to fall short of.

**ping — the floor on how fast a keystroke can echo.** Measured on this machine:

| path | round trip |
| --- | --- |
| bridge on loopback | **0 ms** |
| through a Cloudflare quick tunnel | **50 ms** |
| ICMP to Cloudflare (1.1.1.1) | 24 ms |

The tunnel figure is not overhead anyone can code away: it is almost exactly
twice the 24 ms it takes to reach Cloudflare and back, because the traffic goes
up to an edge and back down again. Which leads to the biggest single win here:

**`--lan` — skip the tunnel when you are in the same building.** Without it, a
laptop two metres away still pays the full 50 ms round trip out to Cloudflare and
back. The reason it cannot just connect locally is that a browser refuses a
`ws://` socket from an `https://` page, so going through the site forces the
long way round. With `--lan`, the bridge serves the viewer page itself and the
laptop loads it from `http://<lan-ip>:6080/` — same origin, no mixed content, no
Cloudflare. Measured from the host itself the round trip drops to 0 ms; over real
wifi expect a couple of ms rather than fifty.

**polling — how often the host notices the screen changed.** This one is not in
the browser at all, and it dwarfs the others when it bites. TightVNC hears about
changes two ways: hooks, which only cover the old GDI drawing path, and a
full-screen poll for everything else. Chrome, Electron apps, video and anything
composited are "everything else", and the poll ships at **1000 ms**. One frame a
second is not a slow link, it is a slow camera, and nothing tunable in the page
can make up for it.

```
tools\cast-host\tune-host.cmd          30 ms, about 33 screen polls/second
tools\cast-host\tune-host.cmd 100      less host CPU, but caps polling at 10 FPS
```

It asks for administrator rights, because the setting lives under HKLM where
only an administrator may even read it, and reloads the service rather than
restarting it so a cast in progress survives. TightVNC's own floor is 30 ms.
Nothing else in this tool needs elevation. It looks for `tvnserver.exe` in both
Program Files folders, in the order `cast-host.mjs` probes them, so a 32-bit
install does not leave the tuner looking broken on a machine the bridge is
already driving.

The reload is the half that actually changes anything: without it the value sits
in the registry while the running server keeps polling at the old rate. So the
script checks that the service accepted it, and if it did not, says so and exits
non-zero instead of claiming success — the fix there is to restart the tvnserver
service, which does drop any cast in progress. Only after a reload it watched
succeed does it record the interval in `%ProgramData%\instellar-cast\poll-ms`,
so that file never claims a rate the server is not using.

That file exists because the bridge cannot read HKLM. `cast-host.mjs` prints the
interval next to its `bridge on` line and returns it from `/ctl` as `pollMs`, so
the toolbar can name the ceiling instead of leaving a 1 FPS host looking like a
slow network. A host nobody has tuned says so rather than guessing.

The viewer asks for its frames a little faster than the host polls, which is why
the fps readout can say 34 against a 30 ms poll. A rate just *under* the poll rate
does not give a slightly slower picture, it gives an uneven one: the server
answers a request at the first poll that finds a change, so 30 Hz against a 33 Hz
poll delivers nine gaps of 30 ms and then one of 60, three times a second. Even
frames, uneven motion — invisible on scenery, obvious on a moving hand. Asking
past the poll rate makes every request wait for the next poll, and the poll grid
is even. Only the ladder's top rung does this; every rung below it is asking for
fewer frames on purpose.

The default is 30 ms so video and typing are not capped at ten updates per
second by the old 100 ms setting. Run the tuner once on existing hosts too;
updating the viewer page alone cannot change the host's polling interval.
Actual frame rate still depends on encoding, network and viewer speed.

**screen — every pixel is decode work.** Two 1080p monitors is a 3840×1080
framebuffer, twice what anyone needs to read code on, and on a weak laptop that
is the difference between smooth and not. So the host tells TightVNC to share one
display by default (`-shareprimary`), which halves bandwidth, memory and decode
in one move. The **Show** dropdown switches between the main screen, the second
screen and both without restarting anything, and the whole desktop is restored
when the cast stops.

**link — how much data is actually arriving.** Quality defaults to **Auto**,
which picks a preset from how much delay the session is adding on top of the
link's own floor, rather than from the raw ping — a host 100ms away is far, not
congested, and the two want opposite answers. It gives way after two seconds and
climbs back after six, because a stalled picture is felt at once and a premature
climb just stalls it again. It leans on lowering JPEG quality first, which costs
less than it sounds: Tight sends flat and low-colour regions — most of a code
editor — through zlib with a palette, and only photographic areas through JPEG.
Dropping quality blurs wallpaper, not text. Override it with Sharp/Balanced/Fast
if you would rather decide yourself.

The ladder is ordered by bytes per second rather than by frame rate, so every
down-step buys the link something. That ordering is what the low-quality pair at
20 and 30 Hz is for. A playing video changes every pixel of the viewport every
frame and is bound by the link long before anything else, and the ladder used to
answer that with rate alone: out of Balanced it gave away a third of the motion
and not one byte per frame, then another third, 30 Hz down to 10, still shipping
the same expensive frames. Dropping the quality pair instead cuts bytes about
threefold at the full rate. **Fast** is that rung, so pinning it is also the
manual answer for video. The ladder is deliberately not monotone in decode work —
one rung is thirty cheap frames where the one above is fifteen dearer ones — and
it cannot be, because bytes and decode disagree about what costs what. A viewer
bound by its own decoder rather than by the link keeps descending past that step.

For servers without continuous updates, the viewer asks for the next update as
soon as the current update's *header* arrives — before the previous frame has
finished rendering, not after it. That ordering is the whole of the win. The
render gate sits just below, and it waits for the last frame's queue to drain;
that queue is never empty after an update carrying a JPEG rect, because every
decoded bitmap is a promise that has not settled yet. So while the request sat
below the gate, photographic and video content — the case with the most bytes and
the most to gain — paid the round trip again on essentially every frame, and a
code editor, whose flat zlib and palette rects render synchronously, got the
overlap it needed least.

Moving it above the gate does not weaken the backpressure, because that was never
the gate's doing: a viewer that falls behind stops *parsing*, so no rectangle is
decoded over an unfinished frame either way, and one request outstanding is still
at most one update waiting in the receive queue. It is sent once per update, from
the header, so a rectangle split across TCP reads cannot send it twice.

A resize is the one thing that invalidates it. The outstanding request carries the
geometry the desktop had when it went out, so a screen that grew — a display
hot-plugged, the **Show** dropdown switching to both monitors — leaves it covering
only the old area. That is not one stale frame: the server has nothing to answer
with until something inside the old rectangle happens to change, which on a static
new half can be never. So a resize marks the request spent, and a correctly sized
one goes out the moment this update finishes parsing — the cost is the rest of an
update rather than a round trip.

This reduces idle time but does not remove the network latency or turn VNC into a
video codec. That is what the next part is for.

**streaming — asking for the next frame from this side of the tunnel.** Which is
what finally removes that latency. The loop above is still depth-1: the viewer
asks for one update, waits a full round trip for it, and only then asks again. So
the frame period is `RTT + poll/2` — about `50 + 15` = 65 ms through a quick
tunnel, or roughly 15 frames a second, and no quality setting can move it, because
quality changes bytes per frame and not frames per second. That is why every tier
looked equally choppy.

The bridge is 0 ms from TightVNC, so it can hold that request open on the viewer's
behalf and take the viewer's round trip out of the loop:

```
GET /ctl?k=<session key>&v=<tab id>&stream=<hz>&w=<width>&h=<height>
```

`hz` is clamped to 0–60, and **0 restores exactly the behaviour above**, so a
viewer that never asks — or one that hangs up — leaves the host as it was. The
rate belongs to the viewer, not to the host: every bridge starts at 0, so a rate
cannot outlive the session that asked for it or reach the next one.

`v` is which viewer is asking. The page mints an id per tab and appends it to the
endpoint it was handed, so it rides along on both the socket URL and every control
call for free, and the bridge learns it during the upgrade. Without it a call
moved every live bridge at once, so two tabs watching the same machine overwrote
each other's rate all session — and nothing downstream could tell them apart,
because the shared screen is host-wide and their framebuffers always match. A
call that names no viewer is still answered the old way, on every live bridge,
because there is nothing to match on; a name that matches nothing settles nothing
rather than fanning out to strangers. It is an identifier and not a credential —
`k` remains the only thing guarding this endpoint.

While the rate is set, the bridge writes a ten-byte `FramebufferUpdateRequest` at
that rate. It parses no RFB to do it: the request is ten fixed bytes and the
viewer already knows its own framebuffer size, so it sends it. `w`/`h` are
remembered per connection between calls; with none ever given the host accepts the
rate and injects nothing rather than guessing a size, and says so in the reply
(`{"ok":true,"stream":20,"w":0,"h":0,"pollMs":30}`).

Six things stop a request going out, and each one is a way this could make the
picture worse rather than better:

* the VNC socket is not connected yet, so there is nothing to ask;
* this viewer has not yet sent those exact ten bytes itself. A rate on `/ctl`
  proves only that whoever called it is past their RFB handshake; watching the
  viewer's own request go past proves it of this one, and proves the rectangle is
  the one it wants. The handshake is the window where ten stray bytes kill a
  session, so the bridge stays silent until the compare matches — and a rectangle
  it has never seen asked for is simply never injected, which is the depth-1 loop
  above and nothing worse;
* something of ours is still queued for it — never pile requests onto a socket
  that is already behind;
* the viewer is behind and the bridge has stopped reading TightVNC, so more
  frames would only grow a queue nobody is draining;
* a client message is half-delivered across WebSocket fragments. The reader hands
  fragments straight through, so injecting between two of them would splice ten
  bytes into the middle of another RFB message and desynchronise the server for
  the rest of the session;
* a client message of 8 KiB or more went past and nothing smaller has been seen
  since. noVNC's send buffer is 10 KiB and it flushes when full, so one RFB
  message larger than that — a paste — leaves the browser as several *whole*
  messages that the fragment guard cannot see between. Only a message that big can
  be a piece of a larger one, so only one of those arms the stand-off: standing
  off after every client write would switch the feature off, because the viewer
  answers each update with a request of its own.

  What lifts it is the next whole message *smaller* than 8 KiB, because that
  cannot be a piece of a larger one. That is proof rather than a guess — noVNC
  pushes every piece of one message in a single synchronous call and a WebSocket
  delivers in order, so a small one can only turn up once the last piece has gone
  by — and it costs nothing to wait for, since the viewer sends a ten-byte request
  after every update it finishes. A **500 ms** deadline is the backstop, for the
  paste whose last piece is itself over the threshold onto a still screen: no
  update to answer means no smaller message ever arrives, and without a deadline
  the feature would switch itself off for the session. Waiting on a deadline
  *alone* was the first version of this and it was set far too short: the pieces
  leave the browser together, but they still have to cross the viewer's uplink,
  and 10 KiB takes longer than 50 ms on anything under about 1.6 Mbit up.

The timer chases deadlines rather than using a flat interval, because Windows
timers land on a ~15.6 ms tick: `setInterval(50)` fires every 62 ms, and the 20
fps somebody asked for quietly becomes 16.

Two things this does not do. It is not ContinuousUpdates — TightVNC Server for
Windows does not implement that extension, and if a server ever did, the viewer
would stop asking and never call this at all. And it cannot beat the polling
interval above: asking 60 times a second for a screen the server looks at once a
second still gets one frame a second. `stream` removes the round trip; only
`tune-host.cmd` removes the ceiling.

The host prints the interval next to the `bridge on` line at startup and returns
it from `/ctl` as `pollMs`, reading it from
`%PROGRAMDATA%\instellar-cast\poll-ms`, which `tune-host.cmd` writes while it is
elevated. It has to come from there: `HKLM\SOFTWARE\TightVNC\Server` is
administrator-only even to *read*, so the bridge cannot ask the registry. A host
that has never been tuned says so instead of guessing. It stays a readout and
never becomes a lever — the poll rate is a machine-wide setting, and a remote page
moving it is a different question from which monitor it is looking at.

## Stream: hardware video for games and video

Everything above makes stills arrive faster. It cannot make them smaller: a game
or a video changes every pixel every frame, Tight has to compress each one from
scratch, and the link chokes at 15-20 fps whatever the ladder asks for. The GPU
has a hardware H.264 encoder that does this job for a living, and the browser has
a hardware decoder (WebCodecs) to match. **Stream** in the toolbar joins the two.

When it is on, the host runs ffmpeg — Desktop Duplication capture straight into
`h264_nvenc`, low-latency settings, no B-frames, a keyframe every five seconds —
and fans the raw stream out over a second WebSocket path, `/video`. The page
decodes it and paints into the same canvas noVNC draws on, so every coordinate
the mouse and keyboard rely on is unchanged. TightVNC stays connected for input
only: the page stops asking it for pixels (`rfb.pixels = false`) and the ladder
is parked at 0. Turn Stream off and all of that comes back exactly as it was.

It is a toggle rather than the default because text is softer. H.264 at 8 mbps
is built for motion, and Tight's lossless rectangles are what make a terminal
readable. Watch a video or play a game with Stream on; read code with it off.

The wire is deliberately small. `/video` takes the same `?k=` as `/ws`, plus
`fps` (1-120, default 60), `mbps` (1-50, default 8), `display` (the Show
dropdown's vocabulary) and `codecs` (see below). The host sends, and the client
never speaks:

1. A text frame, `{"type":"config","codec":"avc1.64002a","width":…,"height":…,
   "fps":…,"encoder":"h264_nvenc",…}` — first, and again whenever the encoder
   restarts. `codec` is what `VideoDecoder.configure` wants, read off the SPS.
2. Binary frames, one per access unit: a flags byte (bit 0 = keyframe), a
   big-endian u32 of milliseconds since the encoder started, then the Annex-B
   bytes. Keyframes always carry their SPS and PPS, so a decoder can start from
   any of them — and a new viewer always does: it receives the config, then the
   cached GOP from its last keyframe, then live frames.
3. A viewer more than 1 MiB behind has deltas dropped until the next keyframe,
   never a delta whose predecessor it did not get.

One encoder serves every viewer. The first subscriber starts it with its own
settings, a later one whose settings differ restarts it for everyone, and it
stops three seconds after the last one leaves — an idle encoder is a GPU and a
screen capture nobody is watching. If `h264_nvenc` will not start the host tries
`h264_amf`, then `h264_qsv`, then `libx264` on the CPU; if none will, every
`/video` socket is closed with code 1011 and "no encoder", and the page falls
back to Tight with a reason in the status text. An encoder that dies mid-stream
is restarted once.

H.264 is the floor, not the ceiling. Bytes are the constraint through the
tunnel, and AV1 buys the most picture per byte, then HEVC — so the page asks
the browser what it decodes in hardware (`VideoDecoder.isConfigSupported`) and
sends the answer as `codecs=av1,hevc,h264` in preference order; anything not on
that whitelist is ignored and an empty list means H.264. The host walks the
list: `av1_nvenc`, `av1_amf`, `av1_qsv`, then `hevc_nvenc`, `hevc_amf`,
`hevc_qsv`, then the H.264 chain above, with the same low-latency flags per
vendor and the codec's own raw muxer (`hevc`, `obu`). The config message's
`codec` says what won — `hvc1.1.6.L123.90` read off the HEVC SPS, `av01.0.09M.08`
off the AV1 sequence header — and the HUD's hover text names it. A viewer that
arrives while a codec it cannot decode is running restarts the encoder on its
own list, so mixed browsers settle on what they share. `--codec av1|hevc|h264`
pins the host's choice regardless of what the page asks for, trying only that
codec's encoders.

The route is on whenever ffmpeg is on PATH (`--ffmpeg <path>` names one that is
not) and off with `--video off`; either way the host prints a `video` line at
startup saying which, and `/ctl?stream=` answers `video:true|false` so the page
can grey the button out on a host that predates all this without opening a
socket to find out. A host with the route off answers `/video` with a plain 404.

One caveat on **Show**: TightVNC and ffmpeg count monitors differently. Tight's
"display N" is its own numbering; ffmpeg's `ddagrab` takes an output index, and
`primary` and `full` both map to output 0 while `N` maps to output N-1. On a
machine whose primary monitor is not the first output, Stream can show a
different screen from the one Tight was sharing. Pick the display by number if
that happens; the dropdown's choice is sent to both.

Frames never touch disk. ffmpeg writes to a pipe, the host parses the bytes in
memory and forwards them, and nothing in this path can write an image file.

## Requirements on the host

* **TightVNC Server** running with a password set. Verify with
  `sc query tvnserver`; the script refuses to start if nothing answers on 5900.
* **cloudflared** (`winget install Cloudflare.cloudflared`) or **ngrok**.
  cloudflared is preferred automatically: no account, no bandwidth cap, and no
  browser-warning page in front of the WebSocket upgrade.
* **Node 18+** — no `npm install`, the bridge is dependency-free on purpose.
* KV configured on the Vercel project (`UPSTASH_REDIS_REST_URL` /
  `UPSTASH_REDIS_REST_TOKEN`, or the `KV_REST_API_*` pair). The proxy already
  uses it, so this is almost certainly already set.

## Using it

```
tools\cast-host\cast.cmd            from anywhere, through the tunnel
tools\cast-host\cast.cmd --lan      also serve on the local network, much faster
```

It prints a watch link with the access key in the fragment:

```
Watch it at       https://go.instellar.net/cast#<key>
On this network   http://192.168.0.175:6080/          (with --lan)
```

Open either. The page asks for the TightVNC password, then you are in. On the LAN
URL there is no access key to type — the page is served by the bridge itself, so
it already knows where to connect. Ctrl+C in the console stops the cast.

## Starting it from the site

The host can listen in the background so nobody has to be standing at it when a
cast is needed. Install that listener once from a normal Command Prompt:

```
tools\cast-host\install-agent.cmd
tools\cast-host\install-agent.cmd --lan     also offer the fast local link
```

That creates the `InstellarCastAgent` scheduled task for the current user, starts
it immediately, and starts it again at every logon. Open the usual watch link
while the machine is not casting and it offers **Start casting on <machine>**.
The button wakes `cast-host.mjs`; **Stop cast** lets it unpublish and restore the
normal TightVNC share mode before it exits. A requested cast also comes back
after a host crash or reboot. To remove the listener, run
`tools\cast-host\uninstall-agent.cmd`; it first gives a running cast time to stop
cleanly, then removes the task.

Once the task is registered and running, the installer offers to run
`tune-host.cmd`, because that is the last moment anyone is standing at the machine
to answer a UAC prompt — and a host provisioned entirely through the agent is
otherwise capped at 1 FPS forever, which presents as a bad network rather than as
a setting. Answering no just says so and carries on. If the tuner has already run
the `poll-ms` file is there, so it reports the interval instead of asking again.

The agent writes its own activity to `%USERPROFILE%\.instellar-cast\agent.log`
and the cast-host output to `cast.log`, rotating that file at about 2 MB. It uses
the same `token` and `publish-key` files as a manual cast, creating them when it
is installed before the first manual run.

There are two keys, and only one of them is ever printed. The **view key** in the
watch link is generated once and kept in `%USERPROFILE%\.instellar-cast\token`, so
the link stays the same run to run even though the tunnel URL behind it does not.
The **publish key** sits beside it in `publish-key` and never leaves the machine;
it is what proves to `/api/cast` that this process owns the slot. Delete either
file to roll it.

### Flags

| Flag | Default | What it does |
| --- | --- | --- |
| `--lan` | off | Also listen on the local network and serve the viewer page |
| `--share` | `primary` | `primary`, `full`, or a display number |
| `--video` | `on` | `off` disables the `/video` route (see Stream above) |
| `--ffmpeg` | ffmpeg on PATH | The ffmpeg binary Stream should run |
| `--codec` | the page's preference | `av1`, `hevc` or `h264`: pin what Stream encodes |
| `--tunnel` | `auto` | `cloudflared`, `ngrok`, or `none` for LAN-only (publishes nothing) |
| `--url wss://…` | — | You already have a tunnel; publish this instead of starting one |
| `--port` | `6080` | Bridge port |
| `--vnc` | `127.0.0.1:5900` | Where the VNC server is |
| `--name` | hostname | Label shown in the browser tab |
| `--ngrok-domain` | — | Your reserved ngrok domain, for a URL that never changes |
| `--site` | `https://go.instellar.net` | Where to publish |

The agent accepts the same `--site`, `--name`, and cast-host flags. Arguments
given to `install-agent.cmd` are saved on the scheduled task and passed through
to every cast-host it starts. `CAST_AGENT_POLL_MS` changes its 10-second poll
interval for tests; `CAST_HOST_SCRIPT` points tests at a stand-in host.

The **Show** dropdown sets the shared display rather than reporting it, so if you
start with `--share full` it will still read "Main screen" until you touch it.

## In the browser

**Fit** scales the desktop into the window; turn it off for 1:1 with scrollbars,
which is what you want for reading code. **Watch only** ignores your input,
**Ctrl+Alt+Del** goes through, and the page reconnects itself when the tunnel
rotates. It never stops trying: every drop, and every "nobody is casting", puts up
a card that counts down to the next attempt and says how many there have been,
and the wait stretches from four seconds to thirty so a host that is off for the
night is not asked twenty thousand times. Coming back to the tab, or the network
coming back, skips whatever is left of that wait. The one card that does not
retry is the one saying this device has been blocked.

**The "nobody is casting" card can also be the on switch.** When the agent is
installed on the host, the card gains **Start casting on <machine>**, and clicking
it asks the site to pass that wish along; the card then reads "Waking…" and the
same retry loop finds the cast when it appears, ten seconds or so later. **Stop
cast** in the toolbar is the other direction: it confirms, asks the host to stop,
and puts the card back up with a longer first wait so the page does not walk
straight back into the session it just ended. Both go through the view key
alone, which is the same key that could read the cast anyway, and the site only
ever admits that a host is listening to the key that could wake it - a stranger
guessing at the address gets the same "offline" it always did.

**Copy and paste cross the gap in both directions.** Copying on the remote
machine puts the text on this device's clipboard, and Ctrl+V here pastes into the
remote machine. The second direction is two things in order - the text has to
reach the host's clipboard before the host sees the keystroke - so the page takes
Ctrl+V away from the remote session, sends the text, and sends the keystroke back
synthetically a moment later. Without that ordering the host pastes whatever it
had before. Two consequences worth knowing: the host sees Ctrl released at that
point, so a Ctrl you were holding for something else needs pressing again, and
the clipboard message carries Latin-1 only, so characters outside it arrive as
`?`. Shift+Insert does the same thing as Ctrl+V.

**Fullscreen is also the keyboard mode.** Outside it the browser keeps its own
shortcuts, so Ctrl+W closes this tab instead of a window on the remote machine.
Fullscreen is the only state in which a page may ask for those keys, so that is
where the cast claims them. Hold Escape, or click Fullscreen again, to leave.

**Video is the mode for a video playing on the host.** A playing video is one
photographic region changing every frame, which is the case the ladder is worst
at: it is written for text, where quality is nearly free and rate is the
expensive axis, and on video the trade runs the other way. **Video** pins a pair
chosen for moving pictures - JPEG quality 5, where motion stops looking like a
mosaic, and compression 6, the lowest level at which TightVNC cuts a frame into
its largest rects, so each frame is a few dozen JPEGs rather than hundreds - and
leaves the rate as the only thing that gives when the link cannot keep up, back
to whatever it can. It also turns Fit on, floats the toolbar over the picture
and fades it once the mouse rests, and asks the browser to keep the screen
awake, since a tab that only receives frames gives the OS no reason not to dim
it. What it cannot do is carry sound: RFB has no audio channel, so the video's
audio stays on the host.

**Mouse lock is the games mode.** RFB has no way to say "the mouse moved three
pixels left" - it carries positions and nothing else - so mouselook in a game
has nothing to work with, and the pointer is free to slide off the picture onto
another monitor halfway through a turn. **Mouse lock** captures the pointer in
the remote screen and adds each movement to a cursor position the page keeps,
which is the same thing in the only terms the protocol has. Turn Fullscreen on
with it: the keyboard claim that lives there is what lets Escape reach the game,
and holding Escape is then how you get the pointer back. Clicking the picture
takes the lock again after any release.

Its one limit is the edge of the remote screen. The position clamps there, so a
game that keeps turning while the pointer pushes against the edge stops turning,
and games that recentre the cursor themselves will fight it. Games played inside
a window, and anything driven by clicking rather than turning, do not meet that
edge. There is no fix for it on this protocol: relative motion would have to
come from the host, and TightVNC has no way to be told.

Pointer moves themselves are sent at up to 250 a second rather than the 59 noVNC
allows by default, which takes up to 17 ms out of the path between moving the
mouse and the host hearing about it. The extra traffic is under 2 KB/s.

If typing ever seems to go nowhere, it is focus: the keyboard follows the remote
screen, and clicking the black area beside it, or a toolbar control, used to hand
focus away with nothing on screen saying so. It is handed straight back now, but
one click on the picture always settles it.

## When it drops

A cast that keeps dropping is one of three things, and the host window now says
which. Every disconnect logs how long the session lasted, and the tunnel's own
warnings are printed for the whole run rather than being thrown away once the
URL has been scraped.

```
[14:02:11] viewer gone - viewer hung up after 104s (0 live)
[14:02:11] tunnel: 2026-09-03T14:02:10Z ERR Connection terminated error="..."
```

* **Drops clustered around one duration** are something expiring on a timer. The
  usual one was a tunnel hanging up on a connection it had seen no bytes on —
  Cloudflare's edge does that after roughly 100 seconds, and a still screen sends
  nothing at all, so a cast left alone died of being watched quietly. The bridge
  now pings the viewer every 20 seconds. The browser answers in its network stack
  rather than in JavaScript, which matters because a backgrounded tab has its
  timers throttled to about once a minute and cannot be relied on to make noise
  of its own. Two unanswered ping intervals mark the old path dead and release
  its TightVNC client slot, instead of leaving a half-open connection behind
  after the tunnel rebuilt. TCP keepalive runs on both legs as a slower safety
  net. The other timer worth knowing is TightVNC's: Server → Administration
  has an idle-timeout setting, and if it is not zero it will cut clients loose on
  its own schedule, which shows up here as `viewer gone` with no viewer reason.
* **A `tunnel:` line next to the drop** means the tunnel lost its connection to
  the edge and rebuilt it, which takes every WebSocket through it down with it.
  Quick tunnels are best-effort and do this. If the tunnel process itself exits,
  the host now starts it again with a 2-to-30-second backoff, publishes its new
  address, and keeps the same watch link; viewers find the replacement on their
  next reconnect attempt. Ten consecutive restarts that cannot produce and
  publish a URL still take the host down cleanly. A replacement that stays up for
  two minutes resets the failure count and backoff.
* **Nothing in the host window at all** means the viewer never lost the socket —
  look at the code in the page's own "Connection dropped" message. `1006` is the
  network or the tunnel cutting it with nobody deciding anything; `1000` is a
  deliberate hang-up.

The registry refresh is still every 30 seconds, but a failed refresh is retried
twice within seconds and only one POST can be in flight. The first publish gets
the same treatment, so a Vercel cold start or a short DNS/5xx wobble no longer
aborts startup or uses up the 90-second record lifetime waiting for the next
ordinary heartbeat. A longer outage is logged and retried every 10 seconds.

`--lan` sidesteps the whole category when the viewer is in the same building:
no tunnel, nothing between the two machines to time anything out.

## Security

Three gates stand between the internet and this machine:

1. The bridge binds **loopback only** unless you pass `--lan`, so the tunnel is
   normally the sole way in. `--lan` opens it to your local network as well —
   fine at home, think twice on a network you do not control.
2. The WebSocket URL carries a per-run `?k=` secret. Guessing the tunnel
   hostname is not enough — a wrong key gets a 403 before any bytes reach VNC,
   and the same key guards the display-switching endpoint.
3. TightVNC's own password.

Gate 2 only holds because the bridge serves the viewer page — which has that key
inlined — **only under `--lan`**. It used to serve it on every run, and the tunnel
reverse-proxies every path, so anyone who learned the tunnel hostname could read
the key straight out of `GET /` and open a socket onto TightVNC with it. Under
`--lan` the page is reachable from your own network, which is the same audience
that can already reach the bridge port.

### The two keys

Reading and publishing are separate secrets, and keeping them separate is what
stops a viewer becoming a host:

* **The view key** is in the watch link and is meant to be shared. It reads the
  endpoint out of `/api/cast`. That is all it does.
* **The publish key** never leaves the host. `/api/cast` will only move or delete
  the record for whoever presents it.

They used to be one key. That meant anyone you invited to watch could POST an
address of their own, and every other viewer's page would then connect to it and
hand over the VNC password — a full man-in-the-middle of the screen and every
keystroke, with the real host heartbeating underneath, none the wiser. The same
key could also delete the record on a timer and keep the cast down.

`/api/cast` stores only the SHA-256 of each key, never the key. The record carries
a 90-second TTL, so a host that dies stops being advertised on its own rather than
leaving a stale URL behind, and the slot is claimed atomically so two hosts cannot
both believe they hold it.

Three things worth knowing:

* **The watch link is a password.** Anyone holding it reaches this machine's VNC
  password prompt. It does not let them move the cast.
* **VNC auth truncates passwords at 8 characters** — a protocol limitation, not a
  TightVNC one. Make those 8 count, and do not reuse a password from anywhere
  else.
* **Claiming an empty slot is open** unless you set `CAST_TOKEN`. The site and the
  host share no other secret to authenticate a first publish with, so without it a
  stranger can squat the slot while nobody is casting and keep the real host out
  (it will refuse to start, saying another host holds the slot). Set `CAST_TOKEN`
  in the Vercel environment and in the host's environment under the same name; it
  gates publishing and unpublishing both.

### Tests

Suites, plain `node`, no install:

```
node tools\cast-host\test\registry.test.mjs    auth/claim logic and heartbeat retry behaviour
node tools\cast-host\test\agent.test.mjs       remote start/stop, restart and outage behaviour
node tools\cast-host\test\bridge.test.mjs      boots the real bridge against a stand-in VNC
node tools\cast-host\test\framing.test.mjs     RFC 6455 framing, backpressure, keepalive, lifetime
node tools\cast-host\test\render.test.mjs      the local bitmap change in cast\novnc.js
node tools\cast-host\test\pipeline.test.mjs    frame request overlap and render backpressure
node tools\cast-host\test\pixels.test.mjs      the rfb.pixels switch that stops framebuffer requests
node tools\cast-host\test\adaptive.test.mjs    the fps ladder, and the bridge's update injector
node tools\cast-host\test\paste.test.mjs       the order the clipboard and the keystroke are sent in
node tools\cast-host\test\viewer.test.mjs      reconnect backoff, the offline card, and its escaping
node tools\cast-host\test\video-route.test.mjs the /video route against a stand-in ffmpeg
node tools\cast-host\test\video.test.mjs       AU splitting, codec strings, the GOP cache and the encoder chain
node tools\cast-host\test\stream-client.test.mjs the page's pure Stream helpers: header, lag gate, reasons, codec list
```

The bridge, framing and adaptive suites bind loopback ports in the 59000 and
60800 ranges and never contact the live site. Framing takes about fifteen seconds
and adaptive about twelve, most of both deliberately spent watching a stalled
viewer to prove the host stalls with it.

`CAST_TUNNEL_BIN` is a test-only override used by the bridge suite to run
`fake-tunnel.mjs` in place of cloudflared, crash it, and prove the replacement URL
is published without letting the host exit. It is not a supported cast setting.
`CAST_FFMPEG_BIN` is its twin for the video-route suite, which runs
`fake-ffmpeg.mjs` in ffmpeg's place: it writes a synthetic H.264 stream, so the
test captures no screen and needs no GPU.

What they are for: the framing, the slot ownership, the render queue and the
update injector are all hand-rolled here, and their failures are the quiet kind.
A wedged render queue freezes the picture while input keeps working. A missed
backpressure pause shows up as memory rather than as an error. An injected
request landing between two halves of a fragmented message desynchronises the
server for the rest of the session. All of them read as "the cast is being weird"
and none of them throws anything a log would catch.

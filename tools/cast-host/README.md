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

Three things dominate how fast this feels, and the toolbar shows all three live
so they can be argued with rather than taken on faith.

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
tools\cast-host\tune-host.cmd          100 ms
tools\cast-host\tune-host.cmd 50       smoother, more host CPU
```

It asks for administrator rights, because the setting lives under HKLM where
only an administrator may even read it, and reloads the service rather than
restarting it so a cast in progress survives. TightVNC's own floor is 30 ms.
Nothing else in this tool needs elevation.

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

Six suites, plain `node`, no install:

```
node tools\cast-host\test\registry.test.mjs    auth/claim logic and heartbeat retry behaviour
node tools\cast-host\test\agent.test.mjs       remote start/stop, restart and outage behaviour
node tools\cast-host\test\bridge.test.mjs      boots the real bridge against a stand-in VNC
node tools\cast-host\test\framing.test.mjs     RFC 6455 framing, backpressure, keepalive, lifetime
node tools\cast-host\test\render.test.mjs      the local bitmap change in cast\novnc.js
node tools\cast-host\test\paste.test.mjs       the order the clipboard and the keystroke are sent in
```

The bridge and framing suites bind loopback ports in the 59000 and 60800 ranges
and never contact the live site. Framing takes about fifteen seconds, most of it
deliberately spent watching a stalled viewer to prove the host stalls with it.

`CAST_TUNNEL_BIN` is a test-only override used by the bridge suite to run
`fake-tunnel.mjs` in place of cloudflared, crash it, and prove the replacement URL
is published without letting the host exit. It is not a supported cast setting.

What they are for: the framing, the slot ownership and the render queue are all
hand-rolled here, and their failures are the quiet kind. A wedged render queue
freezes the picture while input keeps working. A missed backpressure pause shows
up as memory rather than as an error. Both read as "the cast is being weird" and
neither throws anything a log would catch.

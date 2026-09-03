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

The **Show** dropdown sets the shared display rather than reporting it, so if you
start with `--share full` it will still read "Main screen" until you touch it.

## In the browser

**Fit** scales the desktop into the window; turn it off for 1:1 with scrollbars,
which is what you want for reading code. **Watch only** ignores your input,
**Ctrl+Alt+Del** goes through, and the page reconnects itself when the tunnel
rotates.

**Fullscreen is also the keyboard mode.** Outside it the browser keeps its own
shortcuts, so Ctrl+W closes this tab instead of a window on the remote machine.
Fullscreen is the only state in which a page may ask for those keys, so that is
where the cast claims them. Hold Escape, or click Fullscreen again, to leave.

If typing ever seems to go nowhere, it is focus: the keyboard follows the remote
screen, and clicking the black area beside it, or a toolbar control, used to hand
focus away with nothing on screen saying so. It is handed straight back now, but
one click on the picture always settles it.

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

Four suites, plain `node`, no install:

```
node tools\cast-host\test\registry.test.mjs    the /api/cast auth split, against a fake KV
node tools\cast-host\test\bridge.test.mjs      boots the real bridge against a stand-in VNC
node tools\cast-host\test\framing.test.mjs     RFC 6455 framing, backpressure, socket lifetime
node tools\cast-host\test\render.test.mjs      the local bitmap change in cast\novnc.js
```

The bridge and framing suites bind loopback ports in the 59000 and 60800 ranges
and publish nothing. Framing takes about fifteen seconds, most of it deliberately
spent watching a stalled viewer to prove the host stalls with it.

What they are for: the framing, the slot ownership and the render queue are all
hand-rolled here, and their failures are the quiet kind. A wedged render queue
freezes the picture while input keeps working. A missed backpressure pause shows
up as memory rather than as an error. Both read as "the cast is being weird" and
neither throws anything a log would catch.

// VNC+ - everything the bridge needs to know about *which* VNC server it is
// driving, in one place and with no side effects.
//
// Today cast-host.mjs hardcodes two TightVNC paths (cast-host.mjs:781-782), the
// TightVNC argv for each share mode (shareCommand, cast-host.mjs:787), port 5900
// as the default (cast-host.mjs:70) and - most importantly - the *assumption*
// that the server cannot push. That assumption is written down twice: at
// cast-host.mjs:440 ("TightVNC Server for Windows does not implement the
// ContinuousUpdates extension") and at cast-host.mjs:82 ("TightVNC's polling
// interval is the hard ceiling on frames per second"). The first is true. The
// second is only true on TightVNC's *fallback* capture path; see CAPTURE below.
//
// Nothing here spawns, installs, writes a registry key or touches a service. It
// is a lookup table plus four small functions over it, so it can be imported by
// a test, by the bridge, or by a future tuner without any of them inheriting the
// others' side effects. Discovery takes its filesystem probe as an argument for
// the same reason.
//
// The research that produced the capability records, with sources, is in
// vnc-plus.md. Every performance property here is sourced from a server's own
// source code or documentation. None of it was measured on this machine, because
// nothing may be installed or restarted while the user is streaming.

import fs from "node:fs";

/* ------------------------------------------------------------- capability -- */

// CAPTURE is the vocabulary for "how does the server learn the screen changed",
// which is the thing that actually sets a frame rate ceiling. It matters more
// than any encoding option, because a server that finds out late cannot send
// early however fast it compresses.
//
//   dxgi    - DXGI Desktop Duplication. The GPU hands over a frame with its
//             dirty and move rectangles when one exists, so there is no interval
//             and no wasted comparison. This is the same mechanism ffmpeg's
//             ddagrab uses for the /cast video path.
//   event   - a driver or engine signals a Win32 event on change; the server
//             sleeps on the event rather than on a timer.
//   poll    - the server re-reads the screen on a timer and diffs it. The timer
//             is the ceiling, and the CPU cost is paid whether or not anything
//             moved.
//   hooks   - GDI drawing hooks. Cheap and prompt for the old drawing path, and
//             blind to anything composited - Chrome, Electron, video - which is
//             why every server that offers hooks also polls underneath them.
//   mirror  - a kernel mirror display driver. Removes polling entirely, but the
//             drivers are unsigned or Windows 7-era on every candidate below.
export const CAPTURE = Object.freeze({
  dxgi: "dxgi",
  event: "event",
  poll: "poll",
  hooks: "hooks",
  mirror: "mirror",
});

/* ---------------------------------------------------------------- servers -- */

// One record per server the bridge could plausibly be pointed at. `bins` is in
// probe order and is the only part of a record that touches this machine.
//
// `continuousUpdates` is the field the bridge should branch on instead of
// assuming false. When it is true the viewer negotiates pseudo-encoding -313,
// the server pushes updates on its own, and the request injector in bridge()
// must stay silent - noVNC stops sending FramebufferUpdateRequests once
// continuous updates are enabled (cast/novnc.js:17893, 17981), so an injected
// request is no longer a duplicate of something the viewer would have sent, it
// is a foreign message in a stream the viewer is no longer driving.
//
// `shareModes` is the honest answer to "can /ctl?share= work here". Only
// TightVNC has a command-line way to crop the served desktop to one display;
// the others expose it, if at all, through a settings dialog. A server with an
// empty list must have its share buttons hidden rather than failing silently.
const RECORDS = [
  {
    id: "tightvnc",
    name: "TightVNC Server for Windows",
    brand: "VNC+ (TightVNC)",
    version: "2.8.x",
    bins: [
      "C:\\Program Files\\TightVNC\\tvnserver.exe",
      "C:\\Program Files (x86)\\TightVNC\\tvnserver.exe",
    ],
    defaultPort: 5900,

    // Win32ScreenDriverFactory::createScreenDriver tries the Win8 duplication
    // API first and only falls back to the mirror driver and then to the
    // polling driver. UseD3D defaults to true (ServerConfig.cpp: m_D3DAllowed
    // (true)), and the duplication thread is an unthrottled AcquireNextFrame
    // loop with a 20ms wait - not an interval. PollingInterval, the number
    // tune-host.cmd writes, is a member of Win32ScreenDriver only: it is the
    // ceiling on the *fallback* path and has no effect while duplication works.
    capture: CAPTURE.dxgi,
    captureFallback: [CAPTURE.mirror, CAPTURE.poll, CAPTURE.hooks],
    // Only meaningful once capture has fallen back to CAPTURE.poll. 1000 is the
    // shipped default (ServerConfig.cpp: m_pollingInterval(1000)); 30 is the
    // floor TightVNC's own settings dialog enforces, which is what
    // tune-host.cmd writes.
    pollMs: { default: 1000, floor: 30 },

    continuousUpdates: false,     // no occurrence of the string in 2.8.88 source
    fence: false,
    encodings: ["Tight", "ZRLE", "Hextile", "RRE", "CopyRect", "Raw"],
    jpegTurbo: true,              // rfb-sconn/JpegCompressor.h, LIBJPEG_TURBO
    novnc: true,                  // what the bridge speaks to today

    shareModes: ["full", "primary", "display"],
    serviceName: "tvnserver",
    licence: "GPL-2.0",
    // The bundled installer is MSI-backed, so /quiet works. Not run by anything
    // here; recorded so a tuner does not have to guess.
    silentInstall: "tightvnc-<ver>-gpl-setup-64bit.msi /quiet",
    portSetting: "HKLM\\SOFTWARE\\TightVNC\\Server\\RfbPort (administrator only)",
  },

  {
    id: "tigervnc",
    name: "TigerVNC Server for Windows (winvnc4)",
    brand: "VNC+ (TigerVNC)",
    version: "1.16.x",
    bins: [
      "C:\\Program Files\\TigerVNC Server\\winvnc4.exe",
      "C:\\Program Files (x86)\\TigerVNC Server\\winvnc4.exe",
    ],
    // Deliberately not 5900. The whole point of this record is that TigerVNC can
    // sit beside the TightVNC the user is streaming through right now, so that
    // trying it costs nothing and undoing it is closing a process.
    defaultPort: 5901,

    // SDisplay::startCore builds either SDisplayCoreWMHooks (UpdateMethod=1) or
    // SDisplayCorePolling (UpdateMethod=0, the default). There is no duplication
    // core - the "2 - Driver hooking" the UpdateMethod help text mentions has no
    // branch left in the code. So this is the one candidate whose capture is a
    // step *down* from what is already installed.
    capture: CAPTURE.poll,
    captureFallback: [CAPTURE.hooks],
    // SDisplayCorePolling's constructor default is 50ms, split across 16 strips
    // (POLLING_SEGMENTS), with a 10ms floor per strip - so any given pixel is
    // revisited every 160ms at the shipped setting.
    pollMs: { default: 50, floor: 10, strips: 16 },

    // The reason this record exists. SConnection::enableContinuousUpdates and
    // VNCSConnectionST's fence/congestion handling are in common/rfb, which the
    // Windows server links; this is the only Windows server that ships them.
    continuousUpdates: true,
    fence: true,
    encodings: ["Tight", "ZRLE", "Hextile", "RRE", "CopyRect", "Raw"],
    jpegTurbo: true,              // libjpeg-turbo is a required build dependency
    novnc: true,

    // winvnc4 serves the whole desktop and has no share parameter.
    shareModes: [],
    serviceName: "TigerVNC Server",
    licence: "GPL-2.0",
    // Inno Setup. TASKS="" is the part that matters: it installs the files and
    // registers nothing, so no service appears and nothing starts.
    silentInstall: 'tigervnc64-winvnc-<ver>.exe /VERYSILENT /SUPPRESSMSGBOXES /TASKS=""',
    // winvnc4 takes `<setting>=<value>` on the command line, so the port can be
    // set per run without writing anything.
    portSetting: "PortNumber=<n> on the winvnc4 command line",
  },

  {
    id: "ultravnc",
    name: "UltraVNC Server",
    brand: "VNC+ (UltraVNC)",
    version: "1.4.3.x",
    bins: [
      "C:\\Program Files\\uvnc bvba\\UltraVNC\\winvnc.exe",
      "C:\\Program Files (x86)\\uvnc bvba\\UltraVNC\\winvnc.exe",
    ],
    defaultPort: 5901,

    // DeskDupEngine loads ddengine64.dll on Windows 10 and later - Windows 11
    // reports major version 10, so it takes this path - and the desktop thread
    // waits on the engine's screen event rather than on a timer
    // (vncdesktopthread.cpp: trigger_events[6] = getHScreenEvent()). The
    // Windows 7-era mirror driver is still in the tree but is not used here.
    capture: CAPTURE.event,
    captureFallback: [CAPTURE.hooks, CAPTURE.poll],
    // Not a poll interval - a floor on how often the desktop thread will act on
    // the event. MIN_UPDATE_INTERVAL starts and floors at 33ms and the code's
    // own comment beside it reads "MAX 30fps"; setting MaxCpu to 100 ("power
    // mode") pins it to 25ms instead. That is a hard ceiling no viewer can lift.
    pollMs: { default: 33, floor: 25 },

    continuousUpdates: false,     // absent from rfb/rfbproto.h
    fence: false,
    encodings: ["Tight", "ZRLE", "Hextile", "Zstd", "Ultra", "Ultra2", "CopyRect", "Raw"],
    jpegTurbo: null,              // not determined; see vnc-plus.md
    novnc: true,                  // Tight/ZRLE/Hextile and VncAuth are standard

    shareModes: [],
    serviceName: "uvnc_service",
    licence: "GPL-3.0",
    silentInstall: "UltraVNC_<ver>_X64.msi /quiet",
    portSetting: "PortNumber= in ultravnc.ini, or -portnumber <n>",
  },
];

export const SERVERS = Object.freeze(RECORDS.map((r) => Object.freeze(r)));

/* --------------------------------------------------------------- lookups -- */

export function serverById(id) {
  return SERVERS.find((s) => s.id === id) || null;
}

// True when the bridge may stop injecting FramebufferUpdateRequests on this
// server's behalf. Written as a function rather than read off the record so that
// a caller cannot accidentally get `undefined` from a typo and have it read as
// false - an unknown server is not a server with no continuous updates, it is a
// server we know nothing about, and the bridge should keep its injector.
export function pushesUpdates(server) {
  return !!(server && server.continuousUpdates === true);
}

export function defaultPort(server) {
  return server && Number.isInteger(server.defaultPort) ? server.defaultPort : 5900;
}

/* ------------------------------------------------------------- discovery -- */

// Which of the known servers are actually on this machine. `exists` is injected
// so a test can describe a machine without having one, and so this module can be
// imported somewhere that has no filesystem at all.
//
// Returns a new array of { ...record, bin } - the record is never mutated, so
// two callers with different probes cannot see each other's answers.
export function discover({ exists = fs.existsSync } = {}) {
  const found = [];
  for (const s of SERVERS) {
    const bin = s.bins.find((p) => exists(p));
    if (bin) found.push({ ...s, bin });
  }
  return found;
}

// The one the bridge should drive. `prefer` is an id - from a flag or an
// environment variable - and wins if that server is installed; asking for a
// server that is not there is an error worth surfacing rather than silently
// falling back to a different one, so it returns null.
//
// With no preference the order of SERVERS decides, which puts the incumbent
// first. That is deliberate: adopting a new server has to be something someone
// chose, not something that happened because an installer ran.
export function selectServer({ prefer = "", exists = fs.existsSync } = {}) {
  const found = discover({ exists });
  if (prefer) return found.find((s) => s.id === prefer) || null;
  return found[0] || null;
}

/* ----------------------------------------------------------------- share -- */

// The argv for a share mode, or null if this server cannot do it. Keeping the
// whitelist here is what makes the /ctl query parameter safe to pass through -
// nothing from the request ever reaches a command line unmatched. That property
// is inherited from shareCommand in cast-host.mjs and must not be lost in the
// move; the display number is still matched against /^[1-9][0-9]?$/ and nothing
// else.
//
// For a server with no shareModes this returns null for every mode including
// "full", which is the correct answer: there is nothing to restore either.
export function shareArgv(server, mode) {
  if (!server || !server.bin || !server.shareModes.length) return null;
  if (server.id !== "tightvnc") return null;   // only server with a share CLI
  if (mode === "primary") return [server.bin, ["-controlservice", "-shareprimary"]];
  if (mode === "full") return [server.bin, ["-controlservice", "-sharefull"]];
  if (server.shareModes.includes("display") && /^[1-9][0-9]?$/.test(mode)) {
    return [server.bin, ["-controlservice", "-sharedisplay", mode]];
  }
  return null;
}

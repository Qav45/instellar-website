// The host's microphone, for /audio. One ffmpeg reads the DirectShow device and
// writes raw PCM - s16le, mono - and every listener gets the same 20ms chunks.
// Raw PCM rather than Opus: at 16 kHz mono it is 256 kbps, which the tunnel
// carries without noticing beside the video, and it needs no framing, no codec
// support check and no decoder in the page - a chunk is its own AudioBuffer.
//
// Like video.mjs this owns the process and nothing about sockets: a sink is
// { config(obj), pcm(buf), buffered(), close(code, reason) }.
import { spawn } from "node:child_process";

export const RATE = 16000;
export const CHUNK = RATE / 50 * 2;       // 20ms of s16 mono: 640 bytes
// Kept this long after the last listener, so a reconnect does not pay ffmpeg's
// device open again. Short: a live microphone nobody is listening to is the
// one thing this module must not leave running.
const IDLE_MS = 2000;
// Bytes a listener's socket may hold that the kernel has not taken. Past it a
// chunk is dropped rather than queued: stale audio is worse than a gap, and a
// queue here is added latency that never comes back. 8KB is a quarter second.
export const BACKLOG_LIMIT = 8192;
export const DEFAULT_MIC = "Microphone (heyday Microphone 01)";

export function ffmpegAudioArgs(device) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    // dshow's default buffer is 500ms; this is what makes it live.
    "-f", "dshow", "-audio_buffer_size", "20", "-i", "audio=" + device,
    "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-flush_packets", "1", "pipe:1",
  ];
}

export function createAudioSource(opts) {
  const log = opts.log || (() => {});
  const device = opts.device || DEFAULT_MIC;
  // Same test hook as video.mjs: a JS file stands in for ffmpeg.
  const named = process.env.CAST_FFMPEG_BIN || opts.ffmpeg || "ffmpeg";
  const bin = /\.[cm]?js$/i.test(named) ? process.execPath : named;
  const binArgs = bin === process.execPath ? [named] : [];

  const sinks = new Set();
  let child = null;
  let idleTimer = null;
  let stopped = false;

  const closeAll = (code, reason) => {
    for (const s of sinks) { try { s.close(code, reason); } catch (_) {} }
    sinks.clear();
  };

  const kill = () => {
    const c = child;
    child = null;
    if (c) { try { c.kill(); } catch (_) {} }
  };

  const start = () => {
    let pending = Buffer.alloc(0);
    let heard = false;
    let errTail = "";
    const proc = spawn(bin, binArgs.concat(ffmpegAudioArgs(device)),
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child = proc;
    log("mic on (" + device + ")");
    proc.stdout.on("data", (c) => {
      if (child !== proc) return;
      heard = true;
      pending = pending.length ? Buffer.concat([pending, c]) : c;
      while (pending.length >= CHUNK) {
        const chunk = pending.subarray(0, CHUNK);
        pending = pending.subarray(CHUNK);
        for (const s of sinks) if (s.buffered() <= BACKLOG_LIMIT) s.pcm(chunk);
      }
    });
    proc.stderr.on("data", (c) => { errTail = (errTail + String(c)).slice(-1000); });
    const ended = (code) => {
      if (child !== proc) return;                  // stopped on purpose, or reported
      child = null;
      const why = errTail.trim().split(/\r?\n/).pop() || "exit " + code;
      log("mic " + (heard ? "stopped" : "unavailable") + ": " + why);
      // No restart: a device that vanished will not come back by asking again
      // sixty times a second. The page says so and the listener can retry.
      closeAll(1011, heard ? "mic stopped" : "no mic");
    };
    proc.on("exit", ended);
    // A binary that is not there never exits: it only reports here.
    proc.on("error", (e) => { errTail += "\n" + e.message; ended(e.code); });
  };

  const subscribe = (sink) => {
    if (stopped) { sink.close(1011, "stopped"); return () => {}; }
    clearTimeout(idleTimer);
    idleTimer = null;
    sinks.add(sink);
    sink.config({ rate: RATE, channels: 1, format: "s16le" });
    if (!child) start();
    return () => {
      if (!sinks.delete(sink) || sinks.size || !child) return;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (!sinks.size && child) { kill(); log("mic off (nobody listening)"); }
      }, IDLE_MS);
      idleTimer.unref();
    };
  };

  const stop = () => {
    stopped = true;
    clearTimeout(idleTimer);
    kill();
    closeAll(1001, "stopped");
  };

  return { subscribe, stop };
}

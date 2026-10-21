// Face guard for /cast: the last step after the VNC password, and a watch for as
// long as the page is open. Runs on the viewer's own webcam, entirely in the
// browser. Frames are read in memory and dropped; the only thing stored is a
// vector of face-shape ratios (localStorage "castFace"), never a picture.
//
// A face that is not the enrolled one AND looks 20 or over puts a Classroom
// lookalike over the page (decoy.mjs). Once no such face has been in view for a
// moment it comes down again (face-gate.mjs). Younger faces are ignored.
//
// Identity is landmark geometry, not a face-recognition network: ratios of
// distances between 26 stable points, divided by the eye-to-eye distance, so it
// does not care about distance or head turn. Age is a small model good to a few
// years. Both are disguise-grade, not security. console.debug logs each
// distance and age so MATCH and AGE_MIN can be tuned.

import { FaceLandmarker, FilesetResolver } from "/cool-things/vendor/vision_bundle.mjs";
import { createGate } from "./face-gate.mjs";
import * as decoy from "./decoy.mjs";
import { load as loadAge, estimateAge } from "./age.mjs";

const VENDOR = "/cool-things/vendor/";
const KEY = "castFace2";       // {sig, tol, age}; the first version stored a bare vector under "castFace"
const MATCH = 0.055;          // floor for "me": RMS relative difference; enrollment can only raise it
const MATCH_MAX = 0.12;
const AGE_MIN = 20;           // floor for "adult"; the real bar is the enrolled face's own estimate + AGE_MARGIN
const AGE_MARGIN = 5;
const AGE_SMOOTH = 3;         // an adult verdict is the median of this many readings
const ENROLL_FRAMES = 45;
const SCAN_FRAMES = 8;
const SCAN_TIMEOUT_MS = 10000;

const POINTS = [33, 133, 362, 263, 168, 6, 1, 4, 98, 327, 129, 358, 234, 454,
                93, 323, 132, 361, 58, 288, 172, 397, 152, 10, 127, 356];
const IOD = [133, 362];       // inner eye corners: the unit everything is divided by

let video = null, stream = null, marker = null, gate = null, run = 0;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Landmarks are normalised to the frame, so x and y are rescaled to the same
// units as z (which is already relative to the width) before measuring.
function signature(lm) {
  const w = video.videoWidth, h = video.videoHeight;
  const at = (i) => ({ x: lm[i].x * w, y: lm[i].y * h, z: lm[i].z * w });
  const p = POINTS.map(at);
  const unit = dist(at(IOD[0]), at(IOD[1]));
  const out = [];
  for (let i = 0; i < p.length; i++)
    for (let j = i + 1; j < p.length; j++) out.push(dist(p[i], p[j]) / unit);
  return out;
}

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = (a[i] - b[i]) / b[i]; s += d * d; }
  return Math.sqrt(s / a.length);
}

const mean = (rows) => rows[0].map((_, i) => rows.reduce((s, r) => s + r[i], 0) / rows.length);
const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];

function template() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); return v && v.sig ? v : null; } catch (_) { return null; }
}

async function open() {
  if (marker && stream) return;
  lastT = -1;
  const fileset = FilesetResolver.forVisionTasks(VENDOR + "wasm");
  const ageReady = loadAge();
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 480, height: 360, frameRate: { ideal: 60 } } });
  video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  video.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  await video.play();
  if (!marker) {
    const set = await fileset;
    const build = (delegate) => FaceLandmarker.createFromOptions(set, {
      baseOptions: { modelAssetPath: VENDOR + "face_landmarker.task", delegate },
      runningMode: "VIDEO", numFaces: 4,
    });
    try { marker = await build("GPU"); } catch (_) { marker = await build("CPU"); }
  }
  await ageReady;
}

// One frame, only when the camera has produced a new one. Returns null between
// frames, else the list of faces.
let lastT = -1;
function look() {
  if (video.readyState < 2 || video.currentTime === lastT) return null;
  lastT = video.currentTime;
  return marker.detectForVideo(video, performance.now()).faceLandmarks;
}

const frame = () => new Promise((r) => requestAnimationFrame(r));

// Gathers n readings of exactly one face. Frames with several faces are
// skipped, so a bystander cannot pollute an enrollment or a scan. withAge also
// estimates age (enrollment only: it is the camera's own bias we measure).
async function gather(n, timeoutMs, mine, withAge) {
  const rows = [], t0 = performance.now();
  while (rows.length < n) {
    if (mine !== run) throw new Error("stopped");
    if (performance.now() - t0 > timeoutMs) throw new Error("No clear single face found. Look at the camera and retry.");
    await frame();
    const faces = look();
    if (faces && faces.length === 1) {
      rows.push({ sig: signature(faces[0]), age: withAge ? await estimateAge(video, faces[0]) : 0 });
    }
  }
  return rows;
}

const p95 = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
const ageBar = (have) => Math.max(AGE_MIN, have.age + AGE_MARGIN);

// Resolves once the face on the camera is the enrolled one (enrolling it first
// if nothing is stored yet), then starts the watch. A face that is not the
// enrolled one gets the decoy and the scan keeps trying until it sees the
// enrolled face. Throws on camera, model or timeout trouble so the page can
// offer a retry. hooks.show / hooks.hide run when the decoy goes up and down.
//
// Enrollment measures this camera and this face: how much the face's own
// signature wanders while the head moves (that sets the match tolerance), and
// what age the model reads for it (the adult bar is that plus AGE_MARGIN, which
// cancels the model's habit of reading everyone old in bad light).
export async function scan(say, hooks) {
  const mine = ++run;
  gate = createGate({ revertMs: 1500, show: () => { decoy.show(); hooks.show(); }, hide: () => { decoy.hide(); hooks.hide(); } });
  say("Starting camera...");
  await open();
  let have = template();
  if (!have) {
    say("Enrolling your face. Look at the camera and slowly turn your head a little left and right.");
    const rows = await gather(ENROLL_FRAMES, SCAN_TIMEOUT_MS * 2, mine, true);
    const sig = mean(rows.map((r) => r.sig));
    const tol = Math.min(MATCH_MAX, Math.max(MATCH, p95(rows.map((r) => distance(r.sig, sig))) * 1.5));
    have = { sig, tol, age: median(rows.map((r) => r.age)) };
    localStorage.setItem(KEY, JSON.stringify(have));
    console.log("[face-guard] enrolled: tolerance", tol.toFixed(4), "own estimated age", have.age.toFixed(1), "-> adult bar", ageBar(have).toFixed(1));
    say("Face saved.");
  } else {
    say("Scanning...");
    for (;;) {
      const rows = await gather(SCAN_FRAMES, SCAN_TIMEOUT_MS, mine);
      const d = median(rows.map((r) => distance(r.sig, have.sig)));
      console.log("[face-guard] scan distance", d.toFixed(4), "limit", have.tol.toFixed(4));
      if (d <= have.tol) break;
      gate.feed(true, performance.now());   // not me: decoy up, keep looking
    }
    gate.feed(false, Infinity);             // it was me: take the decoy down
  }
  watch(have, mine);
}

// From here on, every camera frame: faces that are not the template are aged,
// and the gate is told whether any of them reads over the adult bar. No face
// in view, or only the enrolled one, or only younger ones, tells it "no".
function watch(have, mine) {
  let busy = false;
  const recent = [];
  const bar = ageBar(have);
  const tick = () => {
    if (mine !== run) return;
    const faces = look();
    if (faces) {
      const others = faces.filter((f) => distance(signature(f), have.sig) > have.tol);
      if (!others.length) { recent.length = 0; gate.feed(false, performance.now()); }
      else if (!busy) {
        busy = true;
        Promise.all(others.map((f) => estimateAge(video, f))).then((ages) => {
          busy = false;
          if (mine !== run) return;
          recent.push(Math.max(...ages));
          if (recent.length > AGE_SMOOTH) recent.shift();
          const seen = median(recent);
          console.log("[face-guard] other face, ages", ages.map((a) => a.toFixed(1)).join(", "), "smoothed", seen.toFixed(1), "bar", bar.toFixed(1));
          gate.feed(seen >= bar, performance.now());
        }, (e) => { busy = false; console.warn("[face-guard] age estimate failed:", e); });
      }
    }
    next();
  };
  // requestVideoFrameCallback fires the moment the camera delivers a frame,
  // instead of up to a display frame later; rAF is the fallback.
  const next = () => video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  next();
}

// Guard switched off: stop the loop, put the page back, let go of the camera.
export function stop() {
  run++;
  if (gate) gate.reset();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) { video.remove(); video = null; }
}

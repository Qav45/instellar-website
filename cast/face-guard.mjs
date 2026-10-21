// Face guard for /cast: the last step after the VNC password, and a watch for as
// long as the page is open. Runs on the viewer's own webcam, entirely in the
// browser. Frames are read in memory and dropped; the only thing stored is a
// vector of face-shape ratios (localStorage "castFace"), never a picture.
//
// Anything that is not the enrolled face - a second face in view, or one face
// whose shape does not match - sends the page to Google Classroom.
//
// Identity here is landmark geometry, not a face-recognition network: ratios of
// distances between 26 stable points, divided by the eye-to-eye distance, so it
// does not care about distance or head turn. That is a disguise-grade check, not
// security. console.debug logs each distance so MATCH can be tuned.

import { FaceLandmarker, FilesetResolver } from "/cool-things/vendor/vision_bundle.mjs";

const VENDOR = "/cool-things/vendor/";
const CLASSROOM = "https://classroom.google.com";
const KEY = "castFace";
const MATCH = 0.055;          // RMS relative difference at or under this is "me"
const ENROLL_FRAMES = 20;
const SCAN_FRAMES = 8;
const SCAN_TIMEOUT_MS = 10000;

const POINTS = [33, 133, 362, 263, 168, 6, 1, 4, 98, 327, 129, 358, 234, 454,
                93, 323, 132, 361, 58, 288, 172, 397, 152, 10, 127, 356];
const IOD = [133, 362];       // inner eye corners: the unit everything is divided by

let video = null, stream = null, marker = null, gone = false;

// location.replace first, so the navigation is already under way before the
// page is hidden and the camera released.
function bail(why) {
  if (gone) return;
  gone = true;
  console.debug("[face-guard] bail:", why);
  location.replace(CLASSROOM);
  document.documentElement.style.display = "none";
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Landmarks are normalised to the frame, so x and y are rescaled to the same
// units as z (which is already relative to the width) before measuring.
function signature(lm) {
  const w = video.videoWidth, h = video.videoHeight;
  const p = POINTS.map((i) => ({ x: lm[i].x * w, y: lm[i].y * h, z: lm[i].z * w }));
  const unit = dist(
    { x: lm[IOD[0]].x * w, y: lm[IOD[0]].y * h, z: lm[IOD[0]].z * w },
    { x: lm[IOD[1]].x * w, y: lm[IOD[1]].y * h, z: lm[IOD[1]].z * w });
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
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { return null; }
}

async function open() {
  if (marker) return;
  const fileset = FilesetResolver.forVisionTasks(VENDOR + "wasm");
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 480, height: 360, frameRate: { ideal: 60 } } });
  video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  video.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  await video.play();
  const set = await fileset;
  const build = (delegate) => FaceLandmarker.createFromOptions(set, {
    baseOptions: { modelAssetPath: VENDOR + "face_landmarker.task", delegate },
    runningMode: "VIDEO", numFaces: 2,
  });
  try { marker = await build("GPU"); } catch (_) { marker = await build("CPU"); }
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

// Gathers n signatures of exactly one face. A second face bails at once.
async function gather(n, timeoutMs) {
  const rows = [], t0 = performance.now();
  while (rows.length < n) {
    if (performance.now() - t0 > timeoutMs) throw new Error("No face found. Look at the camera and retry.");
    await frame();
    const faces = look();
    if (!faces) continue;
    if (faces.length > 1) bail("second face during scan");
    if (faces.length === 1) rows.push(signature(faces[0]));
  }
  return rows;
}

// Resolves once the face on the camera is the enrolled one (enrolling it first
// if nothing is stored yet), then starts the watch. Throws on camera or model
// trouble so the page can offer a retry; a wrong face never returns, it bails.
export async function scan(say) {
  say("Starting camera...");
  await open();
  const have = template();
  if (!have) {
    say("Enrolling your face. Look at the camera.");
    const rows = await gather(ENROLL_FRAMES, SCAN_TIMEOUT_MS);
    localStorage.setItem(KEY, JSON.stringify(mean(rows)));
    say("Face saved.");
  } else {
    say("Scanning...");
    const rows = await gather(SCAN_FRAMES, SCAN_TIMEOUT_MS);
    const d = median(rows.map((r) => distance(r, have)));
    console.debug("[face-guard] scan distance", d.toFixed(4), "limit", MATCH);
    if (d > MATCH) bail("scan mismatch " + d.toFixed(4));
  }
  watch();
}

// From here on, every camera frame is checked: a second face bails, and so does
// a single face that is not the template. No face in view does nothing.
function watch() {
  const have = template();
  const tick = () => {
    if (gone) return;
    const faces = look();
    if (faces) {
      if (faces.length > 1) return bail("second face");
      if (faces.length === 1) {
        const d = distance(signature(faces[0]), have);
        if (d > MATCH) return bail("different face " + d.toFixed(4));
      }
    }
    next();
  };
  // requestVideoFrameCallback fires the moment the camera delivers a frame,
  // instead of up to a display frame later; rAF is the fallback.
  const next = () => video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  next();
}

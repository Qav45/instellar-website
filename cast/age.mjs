// How old a face looks, on this machine. InsightFace's genderage model through
// onnxruntime-web (WASM, one thread, so the page needs no cross-origin
// isolation). Input is a 96x96 RGB crop at 0-255; output index 2 is age / 100.
// A guess good to a handful of years, not a fact. Both files are in vendor/.

import * as ort from "./vendor/ort.wasm.min.mjs";

const BASE = new URL("./vendor/", import.meta.url);
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = BASE.href;

let session = null;
const canvas = document.createElement("canvas");
canvas.width = canvas.height = 96;
const g = canvas.getContext("2d", { willReadFrequently: true });
const input = new Float32Array(3 * 96 * 96);

export async function load() {
  if (session) return;
  const res = await fetch(new URL("genderage.onnx", BASE));
  if (!res.ok) throw new Error("age model: HTTP " + res.status);
  session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()));
}

// The face's landmark box, grown by half, squared and cropped out of the frame.
export async function estimateAge(video, landmarks) {
  const w = video.videoWidth, h = video.videoHeight;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of landmarks) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  const size = Math.max((x1 - x0) * w, (y1 - y0) * h) * 1.5;
  const cx = (x0 + x1) / 2 * w, cy = (y0 + y1) / 2 * h;
  g.drawImage(video, cx - size / 2, cy - size / 2, size, size, 0, 0, 96, 96);
  const px = g.getImageData(0, 0, 96, 96).data;
  const plane = 96 * 96;
  for (let i = 0; i < plane; i++) {
    input[i] = px[i * 4];
    input[plane + i] = px[i * 4 + 1];
    input[2 * plane + i] = px[i * 4 + 2];
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 96, 96]) });
  return out[session.outputNames[0]].data[2] * 100;
}

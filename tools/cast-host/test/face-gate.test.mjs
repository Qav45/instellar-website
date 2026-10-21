import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate } from "../../../cast/face-gate.mjs";

function rig(revertMs) {
  const log = [];
  const gate = createGate({ revertMs, show: () => log.push("show"), hide: () => log.push("hide") });
  return { gate, log };
}

test("shows on the first flagged frame, once", () => {
  const { gate, log } = rig(1500);
  gate.feed(true, 0);
  gate.feed(true, 33);
  assert.deepEqual(log, ["show"]);
  assert.equal(gate.shown, true);
});

test("never shows while nobody is flagged", () => {
  const { gate, log } = rig(1500);
  for (let t = 0; t < 5000; t += 33) gate.feed(false, t);
  assert.deepEqual(log, []);
});

test("hides only after revertMs with nobody flagged", () => {
  const { gate, log } = rig(1500);
  gate.feed(true, 1000);
  gate.feed(false, 2000);
  gate.feed(false, 2499);
  assert.deepEqual(log, ["show"]);
  gate.feed(false, 2500);
  assert.deepEqual(log, ["show", "hide"]);
  assert.equal(gate.shown, false);
});

test("a flagged face coming back before the timeout cancels the revert", () => {
  const { gate, log } = rig(1500);
  gate.feed(true, 0);
  gate.feed(false, 1400);
  gate.feed(true, 1450);
  gate.feed(false, 2900);
  assert.deepEqual(log, ["show"]);
  gate.feed(false, 2950);
  assert.deepEqual(log, ["show", "hide"]);
});

test("reset hides at once, and only if shown", () => {
  const { gate, log } = rig(1500);
  gate.reset();
  assert.deepEqual(log, []);
  gate.feed(true, 0);
  gate.reset();
  assert.deepEqual(log, ["show", "hide"]);
});

// The cover's door logic: the double-click window, the entry-code check and the
// token fallback. Pure, so the block is cut out of cast/index.html and run under
// node rather than restructuring the page to export it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(new URL("../../../cast/index.html", import.meta.url));
const src = fs.readFileSync(PAGE, "utf8");

function slice(from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error("cast/index.html no longer contains: " + from);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error("cast/index.html no longer contains: " + to);
  return src.slice(a, b);
}

const { isDouble, codeOk, doorToken, digitOk } = vm.runInNewContext(
  'const ENTRY = "1234";\n' +
  slice("const DOUBLE_MS = 350;", "// One line in the visit log") +
  "\n({ isDouble, codeOk, doorToken, digitOk })",
  {}, { filename: "cast/index.html" });

test("isDouble: two taps within 350 ms", () => {
  assert.equal(isDouble(1000, 1200), true);
  assert.equal(isDouble(1000, 1400), false);
  assert.equal(isDouble(0, 100), false, "no previous tap is not a double");
});

test("codeOk: only the exact entry code", () => {
  assert.equal(codeOk("1234"), true);
  for (const c of ["123", "12345", ""]) assert.equal(codeOk(c), false, JSON.stringify(c));
});

test("doorToken: the entry code stands in for a missing key", () => {
  assert.equal(doorToken(""), "1234");
  assert.equal(doorToken("other"), "other");
});

test("digitOk: each digit is checked against its place in the code", () => {
  assert.equal(digitOk("", "1"), true);
  assert.equal(digitOk("1", "3"), false);
  assert.equal(digitOk("12", "3"), true);
});

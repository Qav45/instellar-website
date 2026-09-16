// The calculator standing in front of /cast is only a door as far as one string
// is concerned; the rest of it has to be a calculator, because a prop whose keys
// do not add up is one anybody spots. Its evaluator is pure, so - as with the
// other page logic tested here - the source is cut out of cast/index.html and
// run under node rather than restructuring the page to export it.
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

const sandbox = { calcToks: [] };
vm.createContext(sandbox);
vm.runInContext(
  slice("const CALC_FN = {", "function calcShow()") +
  "\nthis.calcEval = calcEval; this.calcFmt = calcFmt; this.calcSolve = calcSolve;" +
  "\nthis.setDeg = (v) => { calcDeg = v; }; this.setToks = (t) => { calcToks = t; };" +
  "\nthis.ENTRY_KEYS = CALC_KEYS;",
  sandbox, { filename: "cast/index.html" });

const { calcEval, calcFmt, calcSolve, setDeg, setToks } = sandbox;
const ev = (s) => calcFmt(calcEval(s));

test("arithmetic and precedence", () => {
  assert.equal(ev("2+3"), "5");
  assert.equal(ev("2+3×4"), "14", "times binds tighter than plus");
  assert.equal(ev("(2+3)×4"), "20");
  assert.equal(ev("10÷4"), "2.5");
  assert.equal(ev("7−3−2"), "2", "minus is left associative");
});

test("unary minus and powers", () => {
  assert.equal(ev("−5+8"), "3");
  assert.equal(ev("2^3"), "8");
  assert.equal(ev("2^3^2"), "512", "powers are right associative");
  assert.equal(ev("3²"), "9", "the x-squared key");
});

test("postfix keys", () => {
  assert.equal(ev("5!"), "120");
  assert.equal(ev("50%"), "0.5");
});

test("functions, in degrees and in radians", () => {
  setDeg(true);
  assert.equal(ev("sin(30)"), "0.5");
  assert.equal(ev("cos(60)"), "0.5");
  setDeg(false);
  assert.equal(ev("sin(0)"), "0");
  setDeg(true);
  assert.equal(ev("√(16)"), "4");
  assert.equal(ev("ln(e)"), "1");
  assert.equal(ev("log(1000)"), "3");
  assert.equal(ev("abs(−7)"), "7");
  assert.equal(ev("π").slice(0, 7), "3.14159");
});

test("what it refuses rather than answers", () => {
  assert.equal(ev("1÷0"), "Error", "divide by zero");
  assert.throws(() => calcEval("2+"), "a dangling operator is not an answer");
  assert.throws(() => calcEval("(2+3"), "an unclosed bracket is not an answer");
});

test("= closes the brackets a function key opened", () => {
  setToks(["√(", "9"]);
  assert.equal(calcSolve(), "3");
  setToks(["2", "+"]);
  assert.equal(calcSolve(), "Error", "but it does not invent a missing operand");
});

test("it prints no digit a double cannot back up", () => {
  assert.equal(ev("0.1+0.2"), "0.3", "float noise is rounded away");
  assert.equal(ev("1÷3").slice(0, 8), "0.333333");
});

// The door itself: the page compares the typed expression against ENTRY, so what
// matters here is that the digit keys write exactly the characters that string is
// made of. A digit key that wrote a prettified glyph would make the code untypeable.
test("the digit keys write plain digits", () => {
  for (const d of "0123456789") assert.ok(!(d in sandbox.ENTRY_KEYS), d + " is passed through as itself");
});

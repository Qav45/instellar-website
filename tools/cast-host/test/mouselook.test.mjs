// Exercise the bundled RFB's relative pointer - the grab button's half of
// mouselook. Same technique as pixels.test.mjs: cut the real methods out of
// cast/novnc.js and run them in a vm around a fake socket.
//
// The thing on the other end is a game that has grabbed the mouse. On Windows
// that is GLFW with the cursor disabled, which is what Minecraft is: it clips
// the cursor to its window, centres it once when the grab is taken, and from
// then on reads every mouse movement as the difference between where the cursor
// is now and where it last saw it. It does NOT warp the cursor back to the
// middle on a timer, and with raw input on it does not look at the cursor
// position at all - it reads the relative deltas that a SetCursorPos on the host
// generates, which are the same differences.
//
// So the only sequence of absolute positions that reaches such a game as the
// movement the user actually made is one whose consecutive differences are that
// movement: a free-running position. Anything that re-anchors between sends
// hands the game the difference of consecutive movements instead, which is
// noise that changes sign on every frame - the camera spins off on its own.
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../../../cast/novnc.js', import.meta.url), 'utf8');
const sent = [];
const sandbox = vm.createContext({
  RFB: { messages: {
    pointerEvent: (_, x, y, mask) => sent.push({ x, y, mask }),
    extendedPointerEvent: (_, x, y, mask) => sent.push({ x, y, mask, ext: true }),
  } },
  _element: { clientToElement: (x, y) => ({ x, y }) },
  clearTimeout: () => {},
});
function method(name) {
  const marker = `value: function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf('\n  }, {', start);
  return vm.runInContext('(' + source.slice(start + 'value: '.length, end) + '\n)', sandbox);
}
function accessor(name) {
  const marker = `key: "${name}",`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf('\n  }, {', start);
  return vm.runInContext('({' + source.slice(start, end) + '})', sandbox);
}

const relativePointer = accessor('relativePointer');
const WIDTH = 1920, HEIGHT = 1080;
const CX = WIDTH / 2, CY = HEIGHT / 2;

function rfb() {
  const r = {
    _relativePointer: false,
    _relPos: null,
    _mousePos: { x: 40, y: 40 },
    _mouseMoveTimer: null,
    _mouseButtonMask: 0,
    _rfbConnectionState: 'connected',
    _viewOnly: false,
    _extendedPointerEventSupported: false,
    _sock: null,
    // A viewport at half scale, scrolled: absolute positions go through it,
    // relative ones must not.
    _display: { width: WIDTH, height: HEIGHT, absX: (x) => x * 2 + 7, absY: (y) => y * 2 + 9 },
    _relCentre: method('_relCentre'),
    _pointerPos: method('_pointerPos'),
    _sendMouse: method('_sendMouse'),
    _flushMouseMoveTimer: method('_flushMouseMoveTimer'),
  };
  r._handleMouseButton = method('_handleMouseButton').bind(r);
  // One move, as the page delivers it: work out the position, then send it.
  r.move = (dx, dy) => {
    const p = r._pointerPos({ movementX: dx, movementY: dy });
    r._sendMouse(p.x, p.y, 0);
    return p;
  };
  return r;
}
function grabbed() {
  const r = rfb();
  relativePointer.set.call(r, true);
  return r;
}

// What a grabbed game makes of a stream of absolute positions: each one is
// measured against the previous one it saw, and nothing puts the cursor back.
// Returns the turn on each axis that the game would apply.
function turn(positions, from = { x: CX, y: CY }) {
  let last = from, x = 0, y = 0;
  for (const p of positions) {
    x += p.x - last.x;
    y += p.y - last.y;
    last = p;
  }
  return { x, y };
}

test.beforeEach(() => { sent.length = 0; });

test('a turn reaches the game as the movement that happened', () => {
  const r = grabbed();
  for (const dx of [12, 12, 12, 12, 12]) r.move(dx, 0);
  assert.deepEqual(turn(sent), { x: 60, y: 0 });
});

// The regression: uneven movement, which is all real movement. If every send
// leaves from the same anchor the game sees the differences between successive
// flicks rather than the flicks, so a steady drag reads as a jitter and a
// decelerating one reads as a turn backwards.
test('uneven movement is not differentiated into noise', () => {
  const r = grabbed();
  const moves = [4, 9, 30, 55, 40, 12, 3, -8, -25, -6];
  for (const dx of moves) r.move(dx, 0);
  assert.deepEqual(turn(sent), { x: moves.reduce((a, b) => a + b, 0), y: 0 });
  // Every individual frame, too - a right-hand drag must never read as a
  // left-hand one just because the previous frame was faster.
  let last = { x: CX, y: CY };
  for (let i = 0; i < moves.length; i++) {
    assert.equal(sent[i].x - last.x, moves[i], `frame ${i}`);
    last = sent[i];
  }
});

test('both axes move together and independently', () => {
  const r = grabbed();
  for (const [dx, dy] of [[10, -3], [10, -3], [-40, 60]]) r.move(dx, dy);
  assert.deepEqual(turn(sent), { x: -20, y: 54 });
});

test('movement between sends is carried, not lost', () => {
  const r = grabbed();
  // Three events, one send - what the move throttle does under a fast flick.
  r._pointerPos({ movementX: 5, movementY: 0 });
  r._pointerPos({ movementX: 5, movementY: 0 });
  const p = r._pointerPos({ movementX: 5, movementY: 0 });
  r._sendMouse(p.x, p.y, 0);
  assert.deepEqual(turn(sent), { x: 15, y: 0 });
});

// A click flushes a pending move and then sends the same position again
// (_handleMouseButton), and one wheel step sends its position four times. Those
// repeats have to be worth nothing to the game, which they are exactly when the
// position is free-running.
test('a click and a wheel step do not add a flick of their own', () => {
  const r = grabbed();
  r.move(30, 12);
  const p = r._pointerPos({ movementX: 0, movementY: 0 });
  r._mouseMoveTimer = 99;                        // a move waiting on the throttle
  r._handleMouseButton(p.x, p.y, 1);             // flush, then the button
  r._handleMouseButton(p.x, p.y, 1 << 3);        // a wheel step, up
  r._handleMouseButton(p.x, p.y, 0);
  assert.deepEqual(turn(sent), { x: 30, y: 12 });
});

// The old failure this must not come back to: a position that clamps against
// the edge of the framebuffer stops carrying movement, so a game being turned
// one way for long enough stops turning and never recovers.
test('turning does not stop at the edge of the screen', () => {
  const r = grabbed();
  // Far more movement in one direction than the screen is wide.
  const moves = new Array(400).fill(0).map(() => r.move(20, 0));
  const last = moves[moves.length - 1];
  const prev = moves[moves.length - 2];
  assert.ok(last.x >= 0 && last.x <= WIDTH - 1, 'stays inside the framebuffer');
  assert.notEqual(last.x, prev.x, 'the last frame still carries movement');
});

// Running out of framebuffer costs one flick, because an absolute protocol has
// no way to move the cursor without the game reading it. It must cost one per
// half a screen of turning and no more, and it must not disturb the other axis.
test('recentring is rare and stays on its own axis', () => {
  const r = grabbed();
  const moves = new Array(300).fill(0).map(() => r.move(20, 0));
  let jumps = 0;
  let last = { x: CX, y: CY };
  for (const p of moves) {
    if (p.x - last.x !== 20) jumps++;
    assert.equal(p.y, CY, 'pitch is untouched by a yaw recentre');
    last = p;
  }
  // 300 * 20 = 6000px of turn across a 1920px screen.
  assert.ok(jumps <= 7, `too many recentres: ${jumps}`);
  assert.ok(jumps >= 1, 'the runway cannot be infinite');
});

test('the viewport scale is not applied to a relative position', () => {
  const r = grabbed();
  r.move(10, 10);
  assert.deepEqual({ x: sent[0].x, y: sent[0].y }, { x: CX + 10, y: CY + 10 });
});

test('absolute mode is untouched', () => {
  const r = rfb();
  const p = r._pointerPos({ clientX: 100, clientY: 50 });
  assert.deepEqual(p, { x: 100, y: 50 });
  r._sendMouse(p.x, p.y, 0);
  assert.deepEqual({ x: sent[0].x, y: sent[0].y }, { x: 207, y: 109 });
});

test('letting go of the grab stops relative positions', () => {
  const r = grabbed();
  r.move(10, 10);
  relativePointer.set.call(r, false);
  assert.equal(r._relPos, null);
  const p = r._pointerPos({ clientX: 3, clientY: 4 });
  assert.deepEqual(p, { x: 3, y: 4 });
});

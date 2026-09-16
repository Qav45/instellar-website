// Exercise the bundled RFB's relative pointer - the grab button's half of
// mouselook. A game that has grabbed the mouse warps the host cursor back to the
// middle of its window every frame and reads the next position as a delta from
// there, so what we send has to come from the middle too. Same technique as
// pixels.test.mjs: cut the real methods out of cast/novnc.js and run them in a
// vm around a fake socket.
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
  };
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
// What the game makes of a stream of positions: it measures each one against
// where it last put the cursor, and it puts the cursor back in the middle once a
// frame. Told a frame boundary after every send, it is the strictest case.
function turn(positions, centre = { x: CX, y: CY }) {
  let last = centre, total = 0;
  for (const p of positions) {
    total += p.x - last.x;
    last = centre;
  }
  return total;
}

test.beforeEach(() => { sent.length = 0; });

test('a turn reaches the game as the movement that happened', () => {
  const r = grabbed();
  for (const dx of [12, 12, 12, 12, 12]) r.move(dx, 0);
  assert.equal(turn(sent), 60);
});

test('every send leaves from the centre, so nothing drifts', () => {
  const r = grabbed();
  r.move(30, -20);
  assert.deepEqual({ x: sent[0].x, y: sent[0].y }, { x: CX + 30, y: CY - 20 });
  r.move(30, -20);
  assert.deepEqual({ x: sent[1].x, y: sent[1].y }, { x: CX + 30, y: CY - 20 });
});

test('turning does not stop at the edge of the screen', () => {
  const r = grabbed();
  // Far more movement in one direction than the screen is wide.
  const moves = new Array(400).fill(0).map(() => r.move(20, 0));
  assert.equal(turn(moves), 400 * 20);
  // The last one still carries movement, rather than pinned against the edge.
  assert.equal(moves[moves.length - 1].x, CX + 20);
});

test('movement between sends is carried, not lost', () => {
  const r = grabbed();
  // Three events, one send - what the move throttle does under a fast flick.
  r._pointerPos({ movementX: 5, movementY: 0 });
  r._pointerPos({ movementX: 5, movementY: 0 });
  const p = r._pointerPos({ movementX: 5, movementY: 0 });
  r._sendMouse(p.x, p.y, 0);
  assert.equal(sent[0].x, CX + 15);
});

test('a click lands where the cursor is, not back where the turn ended', () => {
  const r = grabbed();
  r.move(300, 120);
  const p = r._pointerPos({ movementX: 0, movementY: 0 });
  r._sendMouse(p.x, p.y, 1);
  assert.deepEqual({ x: sent[1].x, y: sent[1].y, mask: sent[1].mask }, { x: CX, y: CY, mask: 1 });
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

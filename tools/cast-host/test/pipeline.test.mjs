// Exercise the actual bundled RFB parser with fragmented, synthetic updates.
// No desktop connection or screen capture is used.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../../../cast/novnc.js', import.meta.url), 'utf8');
const requests = [];
const sandbox = vm.createContext({
  RFB: { messages: { fbUpdateRequest: (...args) => requests.push(args.slice(1)) } },
  Log: { Debug() {} },
  // The frame event is guarded on CustomEvent existing, because a vm context has
  // the ECMAScript built-ins and none of the DOM ones. Supplying it is what makes
  // the dispatch reachable here at all - without this the parser runs the same
  // way it does in a browser minus the one line the page's controller lives on.
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
});
function method(name) {
  const marker = `value: function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf('\n  }, {', start);
  return vm.runInContext('(' + source.slice(start + 'value: '.length, end) + ')', sandbox);
}
const normalMsg = method('_normalMsg');
const framebufferUpdate = method('_framebufferUpdate');
const resizeFb = method('_resize');

function client({ continuous = false } = {}) {
  requests.length = 0;
  let bytes = [];
  let offset = 0;
  let consumed = 0;
  let pending = false;
  let release;
  const painted = [];
  const events = [];
  const sock = {
    rQwait(_, count, rewind = 0) {
      if (bytes.length - offset >= count) return false;
      offset -= rewind;
      return true;
    },
    rQshift8: () => bytes[offset++],
    rQshift16() { return this.rQshift8() * 256 + this.rQshift8(); },
    rQshift32() { return this.rQshift16() * 65536 + this.rQshift16(); },
    rQskipBytes: (n) => { offset += n; },
    // The event reports how many bytes the update carried and how far behind the
    // parser is, and both come off the socket rather than out of the parser.
    get rQlen() { return bytes.length; },
    get rQi() { return offset; },
    get rQpos() { return consumed + offset; },
  };
  const rfb = {
    _sock: sock,
    _FBU: { rects: 0, encoding: null },
    _fbWidth: 800, _fbHeight: 600,
    _enabledContinuousUpdates: continuous,
    _flushing: false,
    _framebufferUpdate: framebufferUpdate,
    _normalMsg: normalMsg,
    _display: {
      pending: () => pending,
      flush: () => new Promise((resolve) => { release = () => { pending = false; resolve(); }; }),
      flip() {},
      resize() {},
    },
    _resize: resizeFb,
    // The rest of what _resize touches; only the two size fields matter here.
    _updateClip() {}, _updateScale() {},
    _updateContinuousUpdates() {}, _saveExpectedClientSize() {},
    _handleRect() {
      if (sock.rQwait('synthetic pixel', 1)) return false;
      const pixel = sock.rQshift8();
      // 0xff stands in for a DesktopSize rect: the host changed resolution
      // partway through an update whose next request has already gone out.
      if (pixel === 0xff) this._resize(1600, 1200);
      else painted.push(pixel);
      return true;
    },
    _handleMessage() {
      while (!this._flushing && !sock.rQwait('message', 1)) {
        if (!this._normalMsg()) break;
      }
    },
    dispatchEvent(e) { events.push(e); },
    _fail(message) { throw new Error(message); },
  };
  return {
    rfb, painted, events,
    feed(chunk) { bytes.push(...chunk); rfb._handleMessage(); },
    blockRender() { pending = true; },
    async flush() { release(); await Promise.resolve(); },
    unread: () => bytes.length - offset,
  };
}
const header = [0, 0, 0, 1]; // message type, padding, one rectangle
const rect = (pixel) => [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, pixel];

{
  const c = client();
  c.feed(header.slice(0, 2));
  assert.equal(requests.length, 0, 'partial header must not request');
  c.feed(header.slice(2));
  assert.deepEqual(requests, [[true, 0, 0, 800, 600]], 'request before rectangle arrives');
  for (const byte of rect(7)) c.feed([byte]);
  assert.equal(requests.length, 1, 'fragmentation and completion must not duplicate the request');
  c.feed([...header, ...rect(8)]);
  assert.deepEqual(c.painted, [7, 8], 'updates retain wire order');
  assert.equal(requests.length, 2, 'exactly one request per update');
}
// A slow renderer must hold back decoding, not the request. Holding the request
// too meant every update carrying a JPEG rect - which always leaves an undecoded
// bitmap on the render queue - waited out the previous decode before asking for
// the next frame, putting the whole round trip back into the frame period on
// exactly the photographic content the overlap was built for.
{
  const c = client();
  c.blockRender();
  c.feed([...header, ...rect(1)]);
  assert.equal(requests.length, 1, 'the request goes out above the flush gate');
  assert.deepEqual(c.painted, [], 'do not decode over an unfinished frame');
  await c.flush();
  assert.deepEqual(c.painted, [1], 'the flush releases parsing, and it paints');
  assert.equal(requests.length, 1, 'the resumed pass must not re-request');
}
{
  const c = client();
  c.blockRender();
  c.feed([0, 0, 0, 0, ...header, ...rect(2)]);
  // Two headers, so two requests: an empty update asks at its own header like
  // any other, and the real one that follows asks at its.
  assert.equal(requests.length, 2, 'empty update is acknowledged without losing parser state');
  await c.flush();
  assert.deepEqual(c.painted, [2], 'message after an empty update is parsed correctly');
  assert.equal(c.unread(), 0);
  assert.equal(requests.length, 2, 'and neither header asked twice');
}
{
  const c = client({ continuous: true });
  c.feed([...header, ...rect(3), 0, 0, 0, 0, ...header, ...rect(4)]);
  assert.equal(requests.length, 0, 'continuous-update servers need no polling requests');
  assert.deepEqual(c.painted, [3, 4]);
}
// The request for the next update leaves with the header, so a resize inside
// this update leaves it asking for the old rectangle. Unanswered, that is not
// one stale frame: the server has nothing to send until something inside the
// old area changes, which on a newly revealed screen half can be never.
{
  const c = client();
  c.feed([...header, ...rect(0xff)]);
  assert.deepEqual(requests, [[true, 0, 0, 800, 600], [true, 0, 0, 1600, 1200]],
    'a resize mid-update is followed by a correctly sized request');
  assert.equal(c.rfb._fbWidth, 1600, 'and the resize itself applied');
}
// The frame event is the only thing the page's adaptive controller runs on, and
// its failure mode is silence: no events means no measurement, which means a
// controller that never climbs and a toolbar that reads a permanent dash. Exactly
// one per completed update, and none at all for an empty one - counting a "nothing
// changed" as a delivered frame is how an idle desktop reads as 30 FPS.
{
  const c = client();
  c.feed([...header, ...rect(5), ...header, ...rect(6)]);
  assert.equal(c.events.length, 2, 'one frame event per completed update');
  assert.equal(c.events[0].type, 'framebufferupdate');
  assert.equal(c.events[0].detail.rects, 1, 'the event counts the rectangles it painted');
  assert.equal(c.events[0].detail.continuous, false, 'and says which request loop is live');
  assert.ok(c.events[0].detail.bytes > 0, 'and how many bytes the update carried');
  assert.ok(c.events[0].detail.duration >= 0, 'and how long it took end to end');
}
{
  const c = client();
  c.feed([0, 0, 0, 0]);                       // an empty update, and nothing else
  assert.equal(c.events.length, 0, 'an empty update is not a delivered frame');
  c.feed([...header, ...rect(7)]);
  assert.equal(c.events.length, 1, 'but the real update after it is');
}
{
  const c = client();
  c.blockRender();
  c.feed([...header, ...rect(8)]);
  assert.equal(c.events.length, 0, 'no event until the update actually finishes');
  await c.flush();
  assert.equal(c.events.length, 1, 'and exactly one once it has');
}
console.log('PASS pipeline: early requests, fragmentation, render backpressure, empty updates, continuous mode, resize geometry, frame events');

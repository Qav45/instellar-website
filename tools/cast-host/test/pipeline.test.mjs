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
});
function method(name) {
  const marker = `value: function ${name}() {`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf('\n  }, {', start);
  return vm.runInContext('(' + source.slice(start + 'value: '.length, end) + ')', sandbox);
}
const normalMsg = method('_normalMsg');
const framebufferUpdate = method('_framebufferUpdate');

function client({ continuous = false } = {}) {
  requests.length = 0;
  let bytes = [];
  let offset = 0;
  let pending = false;
  let release;
  const painted = [];
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
    },
    _handleRect() {
      if (sock.rQwait('synthetic pixel', 1)) return false;
      painted.push(sock.rQshift8());
      return true;
    },
    _handleMessage() {
      while (!this._flushing && !sock.rQwait('message', 1)) {
        if (!this._normalMsg()) break;
      }
    },
    dispatchEvent() {},
    _fail(message) { throw new Error(message); },
  };
  return {
    rfb, painted,
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
{
  const c = client();
  c.blockRender();
  c.feed([...header, ...rect(1)]);
  assert.equal(requests.length, 0, 'slow renderer must hold back the next request');
  assert.deepEqual(c.painted, [], 'do not decode over an unfinished frame');
  await c.flush();
  assert.equal(requests.length, 1, 'render completion resumes requests');
  assert.deepEqual(c.painted, [1]);
}
{
  const c = client();
  c.blockRender();
  c.feed([0, 0, 0, 0, ...header, ...rect(2)]);
  assert.equal(requests.length, 1, 'empty update is acknowledged without losing parser state');
  await c.flush();
  assert.deepEqual(c.painted, [2], 'message after an empty update is parsed correctly');
  assert.equal(c.unread(), 0);
  assert.equal(requests.length, 2);
}
{
  const c = client({ continuous: true });
  c.feed([...header, ...rect(3), 0, 0, 0, 0, ...header, ...rect(4)]);
  assert.equal(requests.length, 0, 'continuous-update servers need no polling requests');
  assert.deepEqual(c.painted, [3, 4]);
}
console.log('PASS pipeline: early requests, fragmentation, render backpressure, empty updates, continuous mode');

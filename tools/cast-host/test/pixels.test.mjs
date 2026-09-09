// Exercise the bundled RFB's "pixels" property: false stops every
// FramebufferUpdateRequest, true asks for one full frame straight away, and
// neither touches the canvas. Same technique as pipeline.test.mjs: cut the real
// methods out of cast/novnc.js and run them in a vm around a fake socket.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../../../cast/novnc.js', import.meta.url), 'utf8');
const sent = [];
const sandbox = vm.createContext({
  RFB: { messages: {
    fbUpdateRequest: (_, ...args) => sent.push(['request', ...args]),
    enableContinuousUpdates: (_, ...args) => sent.push(['continuous', ...args]),
    pixelFormat() {},
  } },
  Log: { Debug() {}, Info() {} },
  _strings: { decodeUTF8: (s) => s },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
});
function method(name) {
  const marker = `value: function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf('\n  }, {', start);
  // The closing paren goes on its own line: a trailing comment sits between
  // some methods and the next key.
  return vm.runInContext('(' + source.slice(start + 'value: '.length, end) + '\n)', sandbox);
}
function accessor(name) {
  const marker = `key: "${name}",`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf('\n  }, {', start);
  return vm.runInContext('({' + source.slice(start, end) + '})', sandbox);
}
const normalMsg = method('_normalMsg');
const framebufferUpdate = method('_framebufferUpdate');
const updateContinuousUpdates = method('_updateContinuousUpdates');
const negotiateServerInit = method('_negotiateServerInit');
const pixels = accessor('pixels');
const canvas = accessor('canvas');

function client({ continuous = false, state = 'connected' } = {}) {
  sent.length = 0;
  let bytes = [];
  let offset = 0;
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
    rQshiftStr(n) { const s = String.fromCharCode(...bytes.slice(offset, offset + n)); offset += n; return s; },
    rQskipBytes: (n) => { offset += n; },
    get rQlen() { return bytes.length; },
    get rQi() { return offset; },
    get rQpos() { return offset; },
  };
  const target = { touched: 0 };
  const rfb = {
    _sock: sock,
    _canvas: target,
    _pixels: true,
    _rfbConnectionState: state,
    _FBU: { rects: 0, encoding: null, requestedNext: false },
    _fbWidth: 800, _fbHeight: 600,
    _enabledContinuousUpdates: continuous,
    _flushing: false,
    _framebufferUpdate: framebufferUpdate,
    _normalMsg: normalMsg,
    _updateContinuousUpdates: updateContinuousUpdates,
    _negotiateServerInit: negotiateServerInit,
    _display: { pending: () => false, flush: () => Promise.resolve(), flip() {}, resize() {} },
    _resize(w, h) { this._fbWidth = w; this._fbHeight = h; this._FBU.requestedNext = false; this._updateContinuousUpdates(); },
    _setDesktopName() {}, _sendEncodings() {}, _keyboard: { grab() {} },
    _updateConnectionState(s) { this._rfbConnectionState = s; },
    _viewOnly: false, _fbName: '', _rfbTightVNC: false,
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
  Object.defineProperty(rfb, 'pixels', { get: pixels.get, set: pixels.set });
  Object.defineProperty(rfb, 'canvas', { get: canvas.get });
  return {
    rfb, painted, target,
    feed(chunk) { bytes.push(...chunk); rfb._handleMessage(); },
    init(chunk) { bytes.push(...chunk); return rfb._negotiateServerInit(); },
  };
}
const header = [0, 0, 0, 1]; // message type, padding, one rectangle
const rect = (pixel) => [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, pixel];
// ServerInit: 800x600, a 16-byte pixel format, then a 2-byte name.
const serverInit = [3, 32, 2, 88, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0, 0, 0, 0, 2, 104, 105];
const full = ['request', false, 0, 0, 800, 600];
const incremental = ['request', true, 0, 0, 800, 600];

{
  const c = client();
  assert.equal(c.rfb.pixels, true, 'defaults to true');
  assert.equal(c.rfb.canvas, c.target, 'rfb.canvas is the target canvas');
  c.feed([...header, ...rect(1)]);
  assert.deepEqual(sent, [incremental], 'normal pipelining while true');
  c.rfb.pixels = false;
  assert.equal(c.rfb._display.present, false, 'video suppresses pending VNC presentation');
  assert.equal(sent.length, 1, 'turning off sends nothing');
  c.feed([...header, ...rect(2)]);
  c.feed([0, 0, 0, 0]);
  assert.equal(sent.length, 1, 'no request after an update, none after an empty update');
  assert.deepEqual(c.painted, [1, 2], 'updates that still arrive are decoded as usual');
  c.rfb.pixels = false;
  assert.equal(sent.length, 1, 'setting the same value again is a no-op');
  c.rfb.pixels = true;
  assert.equal(c.rfb._display.present, true, 'fallback restores VNC presentation');
  assert.deepEqual(sent.slice(1), [full], 'turning on asks for one full frame at once');
  assert.equal(c.rfb._FBU.requestedNext, true, 'and counts it as the outstanding request');
  c.feed([...header, ...rect(3)]);
  assert.deepEqual(sent.slice(2), [incremental], 'the reply resumes the incremental pipeline');
  assert.equal(c.target.touched, 0, 'the property never reaches the canvas');
}
{
  const c = client({ continuous: true });
  c.rfb._resize(1024, 768);
  assert.deepEqual(sent, [['continuous', true, 0, 0, 1024, 768]], 'resize re-enables continuous updates');
  c.rfb.pixels = false;
  assert.deepEqual(sent.slice(1), [['continuous', false, 0, 0, 1024, 768]], 'off switches a continuous stream off');
  c.rfb._resize(800, 600);
  c.feed([...header, ...rect(4)]);
  assert.equal(sent.length, 2, 'neither the resize path nor an update asks while off');
  c.rfb.pixels = true;
  assert.deepEqual(sent.slice(2), [['continuous', true, 0, 0, 800, 600], full], 'on restores continuous updates and asks for a full frame');
}
{
  // Set before the connection exists: the setter must not talk to the socket,
  // and ServerInit must then skip the initial request.
  const c = client({ state: 'connecting' });
  c.rfb.pixels = false;
  assert.equal(sent.length, 0, 'nothing is sent before connect');
  assert.equal(c.init(serverInit), true, 'ServerInit parses');
  assert.equal(c.rfb._rfbConnectionState, 'connected');
  assert.equal(sent.length, 0, 'and the initial request is skipped');
  c.rfb.pixels = true;
  assert.deepEqual(sent, [full], 'the first frame is asked for when pixels turns on');
}
{
  const c = client({ state: 'connecting' });
  assert.equal(c.init(serverInit), true);
  assert.deepEqual(sent, [full], 'ServerInit still asks for the first frame by default');
}
console.log('PASS pixels: default, off stops every request, on asks once, continuous updates, before connect, rfb.canvas');

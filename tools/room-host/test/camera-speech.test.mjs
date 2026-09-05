import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wavDuration } from '../camera-speech.mjs';

test('WAV duration uses format byte rate and skips unknown padded chunks', () => {
  const format = Buffer.alloc(24);
  format.write('fmt '); format.writeUInt32LE(16, 4); format.writeUInt32LE(16000, 16);
  const junk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 1, 0]);
  const data = Buffer.alloc(32008);
  data.write('data'); data.writeUInt32LE(32000, 4);
  const header = Buffer.alloc(12); header.write('RIFF'); header.write('WAVE', 8);
  assert.equal(wavDuration(Buffer.concat([header, format, junk, data])), 2);
});
test('Invalid or truncated speech files cannot schedule playback', () => {
  assert.throws(() => wavDuration(Buffer.from('not wave')));
  const file = Buffer.alloc(20);
  file.write('RIFF'); file.write('WAVE', 8); file.write('data', 12); file.writeUInt32LE(99, 16);
  assert.throws(() => wavDuration(file), /Truncated/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from './vendor/chess.js';
import { homography, sampleBoard, changedSquaresForMove, rankCameraMoves } from './tracker.js';

test('samples board squares in both camera orientations', () => {
  const width = 80, height = 80;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    data[at] = Math.floor(x / 10) * 10;
    data[at + 1] = Math.floor(y / 10) * 10;
  }
  const corners = [{ x: 0, y: 0 }, { x: 79, y: 0 }, { x: 79, y: 79 }, { x: 0, y: 79 }];
  assert.deepEqual(homography(corners).slice(0, 3), [79, 0, 0]);
  const white = sampleBoard({ width, height, data }, corners);
  const black = sampleBoard({ width, height, data }, corners, true);
  assert.deepEqual(white.a8, black.h1);
  assert.deepEqual(white.h1, black.a8);
});

test('camera differences select a legal move without changing the game', () => {
  const game = new Chess();
  const changes = Object.fromEntries('abcdefgh'.split('').flatMap(file =>
    Array.from({ length: 8 }, (_, index) => [`${file}${index + 1}`, 1])));
  changes.e2 = changes.e4 = 55;
  const result = rankCameraMoves(game, changes);
  assert.equal(result[0].move.san, 'e4');
  assert.deepEqual(changedSquaresForMove(game, result[0].move).sort(), ['e2', 'e4']);
  assert.equal(game.fen(), new Chess().fen());
});

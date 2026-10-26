// Camera frames and these samples stay in browser memory. Nothing is uploaded or saved.
export function homography(corners) {
  const points = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = points[i];
    const { x, y } = corners[i];
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    }
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    if (Math.abs(rows[col][col]) < 1e-9) throw new Error('Board corners are too close together.');
    const scale = rows[col][col];
    for (let j = col; j < 9; j++) rows[col][j] /= scale;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = rows[row][col];
      for (let j = col; j < 9; j++) rows[row][j] -= factor * rows[col][j];
    }
  }
  return rows.map(row => row[8]);
}

function project(h, u, v) {
  const divisor = h[6] * u + h[7] * v + 1;
  return [(h[0] * u + h[1] * v + h[2]) / divisor,
    (h[3] * u + h[4] * v + h[5]) / divisor];
}

export function sampleBoard(image, corners, blackAtBottom = false) {
  const h = homography(corners);
  const result = {};
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const square = `${'abcdefgh'[blackAtBottom ? 7 - file : file]}${blackAtBottom ? rank + 1 : 8 - rank}`;
      const pixels = [];
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const [px, py] = project(h, (file + 0.18 + x * 0.64 / 6) / 8,
            (rank + 0.18 + y * 0.64 / 6) / 8);
          const ix = Math.max(0, Math.min(image.width - 1, Math.round(px)));
          const iy = Math.max(0, Math.min(image.height - 1, Math.round(py)));
          const offset = (iy * image.width + ix) * 4;
          pixels.push(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
        }
      }
      result[square] = pixels;
    }
  }
  return result;
}

export function squareChanges(before, after) {
  const changes = {};
  for (const square of Object.keys(before)) {
    const a = before[square];
    const b = after[square];
    let total = 0;
    for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
    changes[square] = total / a.length;
  }
  return changes;
}

export function changedSquaresForMove(game, move) {
  const before = game.board();
  game.move(move);
  const after = game.board();
  game.undo();
  const changed = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const a = before[row][col];
      const b = after[row][col];
      if (a?.type !== b?.type || a?.color !== b?.color) {
        changed.push(`${'abcdefgh'[col]}${8 - row}`);
      }
    }
  }
  return changed;
}

export function rankCameraMoves(game, changes) {
  const sorted = Object.values(changes).sort((a, b) => b - a);
  const noise = sorted.slice(4).reduce((a, b) => a + b, 0) / 60;
  return game.moves({ verbose: true }).map(move => {
    const affected = changedSquaresForMove(game, move);
    const score = affected.reduce((sum, square) => sum + Math.max(0, changes[square] - noise), 0) / affected.length;
    return { move, affected, score };
  }).sort((a, b) => b.score - a.score);
}

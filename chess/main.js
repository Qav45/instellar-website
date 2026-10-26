import { Chess, validateFen } from './vendor/chess.js';
import { sampleBoard, squareChanges, rankCameraMoves } from './tracker.js';

const $ = id => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const context = overlay.getContext('2d');
const game = new Chess();
const glyphs = { wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙',
  bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟' };
let stream = null;
let corners = [];
let baseline = null;
let pending = null;
let bestSquares = [];

function status(message) { $('status').textContent = message; }
function drawCorners() {
  context.clearRect(0, 0, overlay.width, overlay.height);
  if (!corners.length) return;
  context.strokeStyle = '#70f0b7';
  context.fillStyle = '#70f0b7';
  context.lineWidth = Math.max(2, overlay.width / 250);
  context.beginPath();
  corners.forEach((corner, i) => i ? context.lineTo(corner.x, corner.y) : context.moveTo(corner.x, corner.y));
  if (corners.length === 4) context.closePath();
  context.stroke();
  corners.forEach((corner, i) => {
    context.beginPath(); context.arc(corner.x, corner.y, Math.max(5, overlay.width / 110), 0, 2 * Math.PI); context.fill();
    context.fillStyle = '#0d1a17'; context.font = `bold ${Math.max(12, overlay.width / 45)}px system-ui`;
    context.fillText(String(i + 1), corner.x + 9, corner.y - 9);
    context.fillStyle = '#70f0b7';
  });
}
function clearPending() { pending = null; $('confirm').disabled = true; }
function render() {
  $('fen').value = game.fen();
  const board = $('board');
  board.replaceChildren();
  const reversed = $('blackBottom').checked;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = `${'abcdefgh'[reversed ? 7 - col : col]}${reversed ? row + 1 : 8 - row}`;
      const piece = game.get(square);
      const cell = document.createElement('div');
      cell.className = `square ${(row + col) % 2 ? 'dark' : 'light'}${bestSquares.includes(square) ? ' mark' : ''}`;
      cell.textContent = piece ? glyphs[piece.color + piece.type] : '';
      cell.title = square;
      board.append(cell);
    }
  }
}
function capture() {
  if (!stream || video.readyState < 2 || corners.length !== 4) throw new Error('Start the camera and align all four corners first.');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const samples = sampleBoard(image, corners, $('blackBottom').checked);
  canvas.width = canvas.height = 0;
  return samples;
}
function setBaseline() {
  try { baseline = capture(); clearPending(); status('Baseline set. Make one physical move, then press Read move.'); }
  catch (error) { status(error.message); }
}

$('start').onclick = async () => {
  try {
    stream?.getTracks().forEach(track => track.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    await new Promise(resolve => video.addEventListener('loadedmetadata', resolve, { once: true }));
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    corners = []; baseline = null; drawCorners();
    status('Tap the four outer corners: top left, top right, bottom right, bottom left.');
  } catch (error) { status(`Camera unavailable: ${error.message}`); }
};
$('stop').onclick = () => {
  stream?.getTracks().forEach(track => track.stop());
  stream = null; video.srcObject = null; baseline = null; clearPending();
  status('Camera stopped. Start it again to continue.');
};
overlay.onclick = event => {
  if (!stream || corners.length === 4) return;
  const rect = overlay.getBoundingClientRect();
  corners.push({ x: (event.clientX - rect.left) * overlay.width / rect.width,
    y: (event.clientY - rect.top) * overlay.height / rect.height });
  drawCorners();
  status(corners.length === 4 ? 'Corners set. Press Set baseline before the first move.' : `Corner ${corners.length} set. Tap corner ${corners.length + 1}.`);
};
$('resetCorners').onclick = () => { corners = []; baseline = null; clearPending(); drawCorners(); status('Tap the four board corners again.'); };
$('blackBottom').onchange = () => { baseline = null; clearPending(); render(); status('Orientation changed. Set a new baseline.'); };
$('baseline').onclick = setBaseline;
$('read').onclick = () => {
  try {
    if (!baseline) throw new Error('Set a baseline before reading a move.');
    if (game.isGameOver()) throw new Error('The current game has ended.');
    const current = capture();
    const changes = squareChanges(baseline, current);
    const candidates = rankCameraMoves(game, changes);
    const first = candidates[0];
    const second = candidates[1];
    clearPending();
    if (!first || first.score < 12) throw new Error('No clear move detected. Keep the camera still and try again.');
    const gap = first.score - (second?.score ?? 0);
    if (gap < Math.max(3, first.score * 0.12)) {
      throw new Error('Move is ambiguous. Try again, or enter it manually below.');
    }
    pending = { move: first.move, samples: current };
    $('confirm').disabled = false;
    status(`Detected ${first.move.san} (${first.move.from} → ${first.move.to}). Check the position, then confirm.`);
  } catch (error) { status(error.message); }
};
$('confirm').onclick = () => {
  if (!pending) return;
  game.move({ from: pending.move.from, to: pending.move.to, promotion: pending.move.promotion });
  baseline = pending.samples;
  clearPending(); bestSquares = []; $('answer').textContent = '';
  render();
  status(game.turn() === 'b' ? 'Move confirmed. Find Black’s move.' : 'Move confirmed. Make the next physical move and read it.');
};
$('applyManual').onclick = () => {
  try {
    const input = $('manual').value.trim();
    const move = game.move(input);
    if (!move) throw new Error('That is not a legal move in this position.');
    $('manual').value = '';
    if (stream && corners.length === 4) {
      try { baseline = capture(); } catch (_) { baseline = null; }
    }
    clearPending(); bestSquares = []; $('answer').textContent = '';
    render(); status(`Applied ${move.san}.`);
  } catch (error) { status(error.message); }
};
$('loadFen').onclick = () => {
  try {
    const fen = $('fen').value.trim();
    const validity = validateFen(fen);
    if (!validity.ok) throw new Error(validity.error);
    game.load(fen);
    baseline = null; bestSquares = []; clearPending(); $('answer').textContent = '';
    render(); status('Position loaded. Set a new camera baseline.');
  } catch (error) { status(`Invalid FEN: ${error.message}`); }
};
$('newGame').onclick = () => {
  game.reset(); baseline = null; bestSquares = []; clearPending(); $('answer').textContent = '';
  render(); status('New game. Set a new camera baseline.');
};
$('analyze').onclick = async () => {
  if (game.turn() !== 'b') { status('It is White’s turn. Read or enter White’s move first.'); return; }
  if (game.isGameOver()) { status('The game has ended.'); return; }
  const button = $('analyze');
  button.disabled = true;
  $('answer').textContent = 'Stockfish is thinking…';
  let worker;
  try {
    worker = new Worker('./vendor/stockfish-19-lite-single.js');
    const uci = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The engine took too long to respond.')), 20000);
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message || 'The engine failed to load.')); };
      worker.onmessage = event => {
        for (const line of String(event.data).split(/\r?\n/)) {
          if (line === 'readyok') {
            worker.postMessage(`position fen ${game.fen()}`);
            worker.postMessage('go movetime 1600');
          }
          const match = /^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?)/.exec(line);
          if (match) { clearTimeout(timeout); resolve(match[1]); }
        }
      };
      worker.postMessage('uci');
      worker.postMessage('isready');
    });
    const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (!move) throw new Error('The engine returned a move that is not legal here.');
    game.undo();
    bestSquares = [move.from, move.to]; render();
    $('answer').textContent = `${move.san}  ·  ${move.from} → ${move.to}`;
    status('Black’s suggested move is highlighted. Make it on the physical board, then read the move.');
  } catch (error) { $('answer').textContent = ''; status(`Analysis failed: ${error.message}`); }
  finally { worker?.terminate(); button.disabled = false; }
};
window.addEventListener('pagehide', () => stream?.getTracks().forEach(track => track.stop()));
render();

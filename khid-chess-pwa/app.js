import { BOARD_PIXELS, findBoard, loadContours, readBoard, rememberContour, warmVision } from './vision.js';
import { silhouettes } from './neo-profiles.js';
import {
  canonicalPlacement, castlingOptions, enPassantOptions, formatScore, makeFen,
  moveNotation, positionForEngine, squareName, visibleIndex
} from './position.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries([
  'file', 'intake', 'upload-label', 'paste', 'crop', 'position', 'board', 'overlay', 'squares',
  'best-move', 'evaluation', 'flip', 'selection-note', 'editor', 'palette', 'restore', 'calibrate',
  'next-review', 'fen', 'copy-fen', 'ep', 'half', 'full', 'status-latest', 'status-items', 'install',
  'crop-dialog', 'crop-preview', 'crop-x', 'crop-y', 'crop-size', 'crop-apply'
].map(id => [id, $(id)]));
const BOARD = BOARD_PIXELS;
const TILE = BOARD / 8;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const CALIBRATION_KEY = 'khid-neo-contours-v1';
const SHARE_CACHE = 'khid-shares-v1';
const ROOT = new URL('./', import.meta.url);
const ENGINE_NAME = 'stockfish-18-lite-single';
const ENGINE_CDN = new URL('https://unpkg.com/stockfish@18.0.0/src/');
const ENGINE_LOCAL = new URL('./vendor/', ROOT);
const SEARCH_BUDGET_MS = 400;
const PIPELINE_BUDGET_MS = 475;
const DEFAULT_ENGINE = new URL(location.href).searchParams.get('engine') === 'cdn' ? 'cdn' : 'local';
const COLOR_SAMPLE_NAMES = { p: 'пішак', n: 'кінь', b: 'слон', r: 'тура', q: 'ферзь', k: 'король' };
const PIECES = 'PNBRQKpnbrqk'.split('');
const castlingInputs = [...document.querySelectorAll('.castling input')];
const turnInputs = [...document.querySelectorAll('input[name="turn"]')];
const boardCtx = ui.board.getContext('2d');
const overlay = ui.overlay.getContext('2d');
const cropCtx = ui['crop-preview'].getContext('2d');
const source = document.createElement('canvas');
const sourceCtx = source.getContext('2d', { willReadFrequently: true });
const boardSource = document.createElement('canvas');
boardSource.width = boardSource.height = BOARD;
const sampleCtx = boardSource.getContext('2d', { willReadFrequently: true });

const state = {
  bitmap: null, crop: null, draftCrop: null, tiles: [], imageData: null,
  selected: -1, focusSquare: 0, blackBottom: false, turn: 'w', move: null,
  inputVersion: 0, revision: 0, log: []
};
let savedContours = {};
try {
  savedContours = JSON.parse(localStorage.getItem(CALIBRATION_KEY) || '{}') || {};
} catch {
  savedContours = {};
}
let learned = loadContours(savedContours);
const pieceSprites = new Map();
const squares = [];
const palette = new Map();
let installPrompt;

function log(message, level = 'normal') {
  if (state.log[0] !== message) state.log.unshift(message);
  state.log.length = Math.min(state.log.length, 5);
  ui['status-latest'].textContent = state.log[0];
  ui['status-latest'].dataset.level = level;
  ui['status-items'].replaceChildren(...state.log.slice(1).map(text => {
    const entry = document.createElement('li');
    entry.textContent = text;
    return entry;
  }));
}

function pieceLabel(code) {
  if (!code) return 'порожньо';
  return COLOR_SAMPLE_NAMES[code.toLowerCase()] + (code === code.toUpperCase() ? ' білих' : ' чорних');
}

function pieceSprite(code) {
  if (pieceSprites.has(code)) return pieceSprites.get(code);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext('2d');
  const packed = atob(silhouettes[code]);
  const path = new Path2D();
  for (let i = 0; i < TILE ** 2; i++) {
    if (packed.charCodeAt(i >> 3) >> (7 - i % 8) & 1) path.rect(i % TILE, i >> 3, 1, 1);
  }
  const white = code === code.toUpperCase();
  ctx.shadowColor = white ? '#17211f' : '#cbcfc246';
  ctx.shadowBlur = 2.5;
  ctx.fillStyle = white ? '#f8f5e9' : '#292635';
  ctx.fill(path);
  pieceSprites.set(code, canvas);
  return canvas;
}

function initializeEditor() {
  const grid = document.createDocumentFragment();
  for (let index = 0; index < 64; index++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.square = index;
    button.tabIndex = index === 0 ? 0 : -1;
    squares.push(button);
    grid.append(button);
  }
  ui.squares.append(grid);

  for (const code of [...PIECES, '']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.piece = code;
    button.setAttribute('aria-label', pieceLabel(code));
    button.title = pieceLabel(code);
    if (code) {
      const canvas = pieceSprite(code);
      canvas.setAttribute('aria-hidden', 'true');
      button.append(canvas);
    } else {
      button.textContent = 'Очистити клітинку';
    }
    palette.set(code, button);
    ui.palette.append(button);
  }
}

function renderBoard() {
  boardCtx.drawImage(boardSource, 0, 0);
  state.tiles.forEach((tile, index) => {
    if (!tile.edited) return;
    const x = index % 8 * TILE, y = (index >> 3) * TILE;
    const background = tile.bg.map(Math.round);
    boardCtx.fillStyle = 'rgb(' + background.join(' ') + ')';
    boardCtx.fillRect(x, y, TILE, TILE);
    if (tile.code) boardCtx.drawImage(pieceSprite(tile.code), x, y);
  });
  state.tiles.forEach((tile, index) => {
    const button = squares[index];
    const name = squareName(index, state.blackBottom);
    const review = tile.uncertain && !tile.edited;
    button.classList.toggle('review', review);
    button.setAttribute('aria-label', name + ', ' + pieceLabel(tile.code) + (review ? ', перевірити' : ''));
    button.setAttribute('aria-pressed', String(index === state.selected));
    button.tabIndex = index === state.focusSquare ? 0 : -1;
  });
  renderArrow();
}

function renderArrow() {
  overlay.clearRect(0, 0, BOARD, BOARD);
  if (!state.move) return;
  const centers = [state.move.slice(0, 2), state.move.slice(2, 4)].map(square => {
    const index = visibleIndex(square, state.blackBottom);
    return [TILE * (index % 8 + 0.5), TILE * ((index >> 3) + 0.5)];
  });
  const [[startX, startY], [endX, endY]] = centers;
  const angle = Math.atan2(endY - startY, endX - startX);
  const length = Math.hypot(endX - startX, endY - startY);
  overlay.save();
  overlay.translate(startX, startY);
  overlay.rotate(angle);
  overlay.beginPath();
  overlay.moveTo(0, -4);
  overlay.lineTo(length - 15, -4);
  overlay.lineTo(length - 15, -10);
  overlay.lineTo(length + 1, 0);
  overlay.lineTo(length - 15, 10);
  overlay.lineTo(length - 15, 4);
  overlay.lineTo(0, 4);
  overlay.arc(0, 0, 4, Math.PI / 2, 3 * Math.PI / 2);
  overlay.closePath();
  overlay.fillStyle = 'rgba(191, 125, 255, .90)';
  overlay.strokeStyle = 'rgba(51, 24, 77, .76)';
  overlay.lineWidth = 1.5;
  overlay.stroke();
  overlay.fill();
  overlay.restore();
}

function renderEditor() {
  const uncertain = state.tiles.filter(tile => tile.uncertain && !tile.edited).length;
  ui['next-review'].hidden = !uncertain;
  ui['next-review'].textContent = 'Перевірити · ' + uncertain;
  ui.editor.hidden = state.selected < 0;
  const tile = state.tiles[state.selected];
  if (!tile) {
    ui['selection-note'].textContent = 'Торкнися клітинки, щоб змінити фігуру.';
    return;
  }
  const name = squareName(state.selected, state.blackBottom);
  ui['selection-note'].textContent = name + ' · ' + pieceLabel(tile.code);
  for (const [code, button] of palette) button.setAttribute('aria-pressed', String(code === tile.code));
  ui.restore.disabled = !tile.edited;
  ui.calibrate.disabled = !tile.code;
}

function selectSquare(index, focus = false) {
  state.selected = index;
  state.focusSquare = index;
  renderBoard();
  renderEditor();
  if (focus) squares[index].focus({ preventScroll: true });
}

class Stockfish {
  constructor() {
    this.source = DEFAULT_ENGINE;
    this.pending = null;
    this.active = null;
    this.ready = false;
    this.triedFallback = false;
    this.open();
  }

  open() {
    this.ready = false;
    try {
      const url = this.source === 'cdn'
        ? new URL('./engine-worker.js', ROOT)
        : new URL(ENGINE_NAME + '.js', ENGINE_LOCAL);
      if (this.source === 'cdn') {
        // The CDN bootstrap reads this fragment to locate its remote WASM file.
        url.hash = encodeURIComponent(new URL(ENGINE_NAME + '.wasm', ENGINE_CDN).href);
      }
      const worker = new Worker(url, { name: 'Stockfish' });
      this.worker = worker;
      worker.addEventListener('message', event => {
        if (worker === this.worker) this.receive(String(event.data));
      });
      worker.addEventListener('error', event => {
        if (worker !== this.worker) return;
        event.preventDefault();
        this.fail();
      });
      this.timer = setTimeout(() => this.fail(), 10000);
      worker.postMessage('uci');
    } catch {
      this.fail();
    }
  }

  fail() {
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    const latest = this.pending || this.active;
    this.active = null;
    this.pending = latest;
    this.ready = false;
    if (!this.triedFallback) {
      this.triedFallback = true;
      this.source = this.source === 'cdn' ? 'local' : 'cdn';
      this.open();
      return;
    }
    this.pending = null;
    if (latest?.revision === state.revision) {
      ui['best-move'].textContent = '—';
      log('Stockfish недоступний. Перезавантаж сторінку й повтори аналіз.', 'warning');
    }
  }

  set(job) {
    this.pending = job;
    if (this.active && !this.active.stopped) {
      this.active.stopped = true;
      this.worker.postMessage('stop');
    }
    if (!this.worker && job) {
      this.triedFallback = false;
      this.source = DEFAULT_ENGINE;
      this.open();
    }
    this.pump();
  }

  pump() {
    if (!(this.ready && !this.active && this.pending)) return;
    this.active = this.pending;
    this.pending = null;
    this.active.score = null;
    const remaining = this.active.startedAt + PIPELINE_BUDGET_MS - performance.now();
    const budget = Math.max(60, Math.min(SEARCH_BUDGET_MS, Math.floor(remaining)));
    this.worker.postMessage('position fen ' + this.active.fen);
    this.worker.postMessage('go depth 15 movetime ' + budget);
    this.timer = setTimeout(() => this.fail(), 6000);
  }

  receive(line) {
    if (line === 'uciok') {
      this.worker.postMessage('setoption name Hash value 16');
      this.worker.postMessage('isready');
      return;
    }
    if (line === 'readyok') {
      clearTimeout(this.timer);
      this.ready = true;
      this.pump();
      return;
    }
    if (!this.active) return;
    const score = /^info\b.*?\bscore (cp|mate) (-?\d+)(?: (lowerbound|upperbound))?/.exec(line);
    if (score && !score[3]) this.active.score = { type: score[1], value: Number(score[2]) };
    const best = /^bestmove\s+(\S+)/.exec(line);
    if (!best) return;
    clearTimeout(this.timer);
    const done = this.active;
    this.active = null;
    if (done.revision === state.revision && !done.stopped) showMove(best[1], done);
    this.pump();
  }
}

function showMove(uci, job) {
  const san = moveNotation(job.game, uci);
  if (!san) {
    ui['best-move'].textContent = '—';
    log('Stockfish не повернув легального ходу для цієї позиції.', 'warning');
    return;
  }
  state.move = uci;
  ui['best-move'].textContent = san;
  ui['evaluation'].textContent = formatScore(job.score, job.turn);
  renderArrow();
  const elapsed = Math.round(performance.now() - job.startedAt);
  log('Найкращий хід · ' + san + ' (' + uci + ') · ' + elapsed + ' мс');
}

function historyFields(placement) {
  const castling = castlingOptions(placement);
  for (const input of castlingInputs) {
    input.disabled = !castling.includes(input.value);
    if (input.disabled) input.checked = false;
  }
  const previous = ui.ep.value;
  const epOptions = ['-', ...enPassantOptions(placement, state.turn)];
  ui.ep.replaceChildren(...epOptions.map(value => new Option(value === '-' ? '—' : value, value)));
  ui.ep.value = epOptions.includes(previous) ? previous : '-';
  const number = (input, minimum, maximum) => Math.min(maximum, Math.max(minimum, Math.floor(Number(input.value) || minimum)));
  return {
    rights: castlingInputs.filter(input => input.checked).map(input => input.value).join(''),
    ep: ui.ep.value,
    half: number(ui.half, 0, 999),
    full: number(ui.full, 1, 9999)
  };
}

function analyze(start = performance.now()) {
  if (!state.tiles.length) return;
  const revision = ++state.revision;
  state.move = null;
  renderArrow();
  ui['best-move'].textContent = '—';
  ui['evaluation'].textContent = '—';
  const placement = canonicalPlacement(state.tiles, state.blackBottom);
  const { rights, ep, half, full } = historyFields(placement);
  const fen = makeFen(placement, state.turn, rights, ep, half, full);
  ui.fen.value = fen;
  ui['copy-fen'].disabled = false;
  log('FEN згенеровано за ' + Math.max(1, Math.round(performance.now() - start)) + ' мс');

  let game;
  try {
    game = positionForEngine(fen, placement, state.turn);
  } catch (error) {
    engine.set(null);
    log(error.message, 'warning');
    return;
  }
  if (game.isCheckmate() || game.isStalemate()) {
    engine.set(null);
    const mate = game.isCheckmate();
    ui['best-move'].textContent = mate ? 'Мат' : 'Пат';
    ui['evaluation'].textContent = mate ? (state.turn === 'w' ? '−M0' : 'M0') : '0.00';
    log(mate ? 'Мат · легальних ходів немає' : 'Пат · легальних ходів немає');
    return;
  }
  ui['best-move'].textContent = 'Аналіз…';
  engine.set({ revision, fen, game, turn: state.turn, startedAt: start });
}

function clearPosition() {
  state.tiles = [];
  state.imageData = null;
  state.move = null;
  state.selected = -1;
  state.focusSquare = 0;
  state.crop = null;
  state.revision++;
  ui.position.hidden = true;
  engine.set(null);
}

function updateFacing() {
  ui.flip.setAttribute('aria-pressed', String(state.blackBottom));
  ui.flip.title = state.blackBottom ? 'Зараз знизу чорні' : 'Зараз знизу білі';
  ui.flip.setAttribute('aria-label', 'Перевернути дошку. ' + ui.flip.title);
}

function applyCrop(rect, start) {
  state.crop = rect;
  sampleCtx.clearRect(0, 0, BOARD, BOARD);
  sampleCtx.drawImage(source, rect.x, rect.y, rect.size, rect.size, 0, 0, BOARD, BOARD);
  state.imageData = sampleCtx.getImageData(0, 0, BOARD, BOARD);
  const recognition = readBoard(state.imageData, learned);
  state.tiles = recognition.tiles.map(tile => ({ ...tile, original: tile.code, edited: false }));
  state.blackBottom = recognition.blackBottom;
  state.turn = recognition.turn;
  state.selected = -1;
  state.focusSquare = 0;
  state.move = null;
  ui.half.value = '0';
  ui.full.value = '1';
  ui.ep.value = '-';
  turnInputs.forEach(input => { input.checked = input.value === state.turn; });
  castlingInputs.forEach(input => { input.checked = false; });
  updateFacing();
  renderBoard();
  renderEditor();
  ui.position.hidden = false;
  const orientation = state.blackBottom ? 'Чорні знизу' : 'Білі знизу';
  log(orientation + (recognition.orientationUncertain ? ' (перевір орієнтацію)' : '')
    + ' · черга ' + (state.turn === 'w' ? 'білих' : 'чорних') + ' ' + recognition.turnSource);
  analyze(start);
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // HTMLImageElement may support a different set of image codecs.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function openImage(file) {
  if (!file) return;
  if (!file.size || file.size > MAX_IMAGE_BYTES) {
    log('Вибери непорожнє зображення розміром до 25 МіБ.', 'warning');
    return;
  }
  const start = performance.now();
  const token = ++state.inputVersion;
  state.log.length = 0;
  log('Пошук дошки…');
  clearPosition();
  ui['crop-dialog'].close();
  state.bitmap?.close?.();
  state.bitmap = null;
  ui.crop.hidden = true;
  let image;
  try {
    image = await decodeImage(file);
    if (token !== state.inputVersion) {
      image.close?.();
      return;
    }
    state.bitmap = image;
    const scale = Math.min(1, 900 / Math.max(image.width, image.height));
    source.width = Math.max(1, Math.round(image.width * scale));
    source.height = Math.max(1, Math.round(image.height * scale));
    sourceCtx.drawImage(image, 0, 0, source.width, source.height);
    const rect = findBoard(sourceCtx.getImageData(0, 0, source.width, source.height));

    ui.intake.classList.add('has-image');
    ui['upload-label'].textContent = 'Інший скріншот';
    ui.crop.hidden = false;
    if (!rect) {
      log('Дошку не знайдено. Спробуй обрізати її вручну.', 'warning');
      return;
    }
    applyCrop(rect, start);
  } catch {
    if (token === state.inputVersion) log('Не вдалося відкрити зображення. Спробуй PNG, JPG або WebP.', 'warning');
  }
}

function cropLimit(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function updateDraft(rect) {
  const size = cropLimit(Math.round(rect.size), Math.min(24, source.width, source.height),
    Math.min(source.width, source.height));
  const x = cropLimit(Math.round(rect.x), 0, source.width - size);
  const y = cropLimit(Math.round(rect.y), 0, source.height - size);
  state.draftCrop = { x, y, size };
  ui['crop-x'].max = source.width - size;
  ui['crop-y'].max = source.height - size;
  ui['crop-size'].min = Math.min(24, source.width, source.height);
  ui['crop-size'].max = Math.min(source.width, source.height);
  ui['crop-x'].value = x;
  ui['crop-y'].value = y;
  ui['crop-size'].value = size;
  cropCtx.drawImage(source, 0, 0);
  cropCtx.fillStyle = '#080f12a1';
  cropCtx.fillRect(0, 0, source.width, source.height);
  cropCtx.drawImage(source, x, y, size, size, x, y, size, size);
  cropCtx.strokeStyle = '#abf5c9';
  cropCtx.lineWidth = Math.max(2, source.width / 200);
  cropCtx.strokeRect(x, y, size, size);
}

function manualCrop() {
  if (!state.bitmap) return;
  ui['crop-dialog'].returnValue = 'cancel';
  ui['crop-preview'].width = source.width;
  ui['crop-preview'].height = source.height;
  const size = Math.min(source.width, source.height);
  updateDraft(state.crop || { x: (source.width - size) / 2, y: (source.height - size) / 2, size });
  ui['crop-dialog'].showModal();
}

function cropPoint(event) {
  const bounds = ui['crop-preview'].getBoundingClientRect();
  return {
    x: cropLimit((event.clientX - bounds.left) * source.width / bounds.width, 0, source.width),
    y: cropLimit((event.clientY - bounds.top) * source.height / bounds.height, 0, source.height)
  };
}

async function takeAndroidShare() {
  const url = new URL(location.href);
  const id = url.searchParams.get('shared');
  const error = url.searchParams.get('share-error');
  if (!id && !error) return;
  url.searchParams.delete('shared');
  url.searchParams.delete('share-error');
  history.replaceState(null, '', url);
  if (error || !/^[a-f0-9-]{36}$/i.test(id)) {
    log(error === 'large' ? 'Спільне зображення перевищує 25 МіБ.'
      : 'Не вдалося отримати зображення через меню «Поділитися».', 'warning');
    return;
  }
  try {
    const key = new URL('incoming/' + id, ROOT);
    const cache = await caches.open(SHARE_CACHE);
    const response = await cache.match(key.href);
    if (!response) throw new Error('Image missing');
    const file = await response.blob();
    await cache.delete(key.href);
    await openImage(file);
  } catch {
    log('Передане зображення недоступне. Поділися ним ще раз.', 'warning');
  }
}

function bindInputs() {
  ui.file.addEventListener('change', () => {
    const file = ui.file.files?.[0];
    ui.file.value = '';
    void openImage(file);
  });
  document.addEventListener('paste', event => {
    const item = [...(event.clipboardData?.items || [])].find(entry => entry.kind === 'file' && entry.type.startsWith('image/'));
    const file = item?.getAsFile() || [...(event.clipboardData?.files || [])].find(entry => entry.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void openImage(file);
  });
  ui.paste.addEventListener('click', async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(value => value.startsWith('image/'));
        if (!type) continue;
        await openImage(await item.getType(type));
        return;
      }
      log('У буфері обміну немає зображення.', 'warning');
    } catch {
      log('Буфер обміну недоступний. Встав скріншот через Ctrl+V або вибери файл.', 'warning');
    }
  });
  ui.crop.addEventListener('click', manualCrop);
  ui['crop-dialog'].addEventListener('close', () => {
    if (ui['crop-dialog'].returnValue !== 'apply' || !state.draftCrop || !state.bitmap) return;
    applyCrop(state.draftCrop, performance.now());
  });
  ui['crop-dialog'].addEventListener('cancel', () => { ui['crop-dialog'].returnValue = 'cancel'; });
  ui['crop-dialog'].querySelector('form').addEventListener('submit', event => {
    ui['crop-dialog'].returnValue = event.submitter?.value || 'cancel';
  });
  for (const field of ['x', 'y', 'size']) {
    ui['crop-' + field].addEventListener('input', event => {
      updateDraft({ ...state.draftCrop, [field]: Number(event.target.value) });
    });
  }
  let drag = null;
  const preview = ui['crop-preview'];
  preview.addEventListener('pointerdown', event => {
    if (!event.isPrimary) return;
    drag = cropPoint(event);
    preview.setPointerCapture(event.pointerId);
  });
  preview.addEventListener('pointermove', event => {
    if (!event.isPrimary || !drag) return;
    const point = cropPoint(event);
    const dx = point.x - drag.x, dy = point.y - drag.y;
    const size = (Math.abs(dx) + Math.abs(dy)) / 2;
    if (size < 5) return;
    updateDraft({ x: drag.x - (dx < 0 ? size : 0), y: drag.y - (dy < 0 ? size : 0), size });
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    preview.addEventListener(type, () => { drag = null; });
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    ui.install.hidden = false;
  });
  ui.install.addEventListener('click', async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    ui.install.hidden = true;
    await prompt.prompt();
  });
  window.addEventListener('appinstalled', () => { ui.install.hidden = true; });
}

function bindPosition() {
  ui.squares.addEventListener('click', event => {
    const item = event.target.closest('button[data-square]');
    if (item) selectSquare(Number(item.dataset.square));
  });
  ui.squares.addEventListener('keydown', event => {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const index = state.focusSquare + delta;
    if (index < 0 || index >= 64 || (Math.abs(delta) === 1 && (index >> 3) !== (state.focusSquare >> 3))) return;
    selectSquare(index, true);
  });
  ui['next-review'].addEventListener('click', () => {
    for (let offset = 1; offset <= 64; offset++) {
      const index = (state.selected + offset) % 64;
      const tile = state.tiles[index];
      if (tile.uncertain && !tile.edited) {
        selectSquare(index);
        return;
      }
    }
  });
  ui.palette.addEventListener('click', event => {
    const button = event.target.closest('button[data-piece]');
    if (!button || state.selected < 0) return;
    const tile = state.tiles[state.selected];
    tile.code = button.dataset.piece;
    tile.edited = true;
    renderBoard();
    renderEditor();
    analyze();
  });
  ui.restore.addEventListener('click', () => {
    const tile = state.tiles[state.selected];
    if (!tile?.edited) return;
    tile.code = tile.original;
    tile.edited = false;
    renderBoard();
    renderEditor();
    analyze();
  });
  ui.calibrate.addEventListener('click', () => {
    const tile = state.tiles[state.selected];
    if (!tile?.code) return;
    try {
      const contour = rememberContour(state.imageData, state.selected, tile.code);
      savedContours[tile.code] = [...(savedContours[tile.code] || []), contour].slice(-3);
      learned = loadContours(savedContours);
      localStorage.setItem(CALIBRATION_KEY, JSON.stringify(savedContours));
      log('Контур збережено · ' + pieceLabel(tile.code));
    } catch (error) {
      log(error.message, 'warning');
    }
  });
  ui.flip.addEventListener('click', () => {
    state.blackBottom = !state.blackBottom;
    updateFacing();
    renderBoard();
    renderEditor();
    log(state.blackBottom ? 'Орієнтація · чорні знизу' : 'Орієнтація · білі знизу');
    analyze();
  });
  for (const input of turnInputs) {
    input.addEventListener('change', () => {
      state.turn = input.value;
      analyze();
    });
  }
  for (const input of [...castlingInputs, ui.ep, ui.half, ui.full]) {
    input.addEventListener('change', () => analyze());
  }
  ui['copy-fen'].addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ui.fen.value);
      log('FEN скопійовано');
    } catch {
      ui.fen.select();
      log('FEN виділено. Скопіюй його через меню браузера.');
    }
  });
}

initializeEditor();
bindInputs();
bindPosition();
const engine = new Stockfish();
if ('requestIdleCallback' in window) requestIdleCallback(warmVision, { timeout: 350 });
else setTimeout(warmVision, 50);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('./sw.js', ROOT)).catch(() => {
    if (!state.tiles.length && !state.inputVersion) {
      log('Установлення й прийом файлів через «Поділитися» потребують HTTPS або localhost.', 'warning');
    }
  });
}
void takeAndroidShare();

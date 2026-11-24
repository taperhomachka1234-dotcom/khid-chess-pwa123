import { silhouettes } from './neo-profiles.js';

const TILE = 48;
const BOARD = TILE * 8;
const CROPS = [0.19, 0.81];
const NEIGHBORS = [-1, 1, -TILE, TILE];
const GREEN = [[238, 238, 210], [118, 150, 86]];
const PIECE_CODES = Object.keys(silhouettes);

function axisEdges(pixels, width, height, vertical) {
  const length = vertical ? height : width;
  const cross = vertical ? width : height;
  const alongStride = vertical ? width * 4 : 4;
  const crossStride = vertical ? 4 : width * 4;
  const votes = new Float32Array(length + 1);
  for (let line = 1; line < cross; line += 3) {
    const offset = line * crossStride;
    for (let pos = 2; pos < length - 1; pos++) {
      const a = offset + (pos - 2) * alongStride;
      const b = offset + (pos + 1) * alongStride;
      const delta = Math.abs(pixels[a] - pixels[b]) + Math.abs(pixels[a + 1] - pixels[b + 1])
        + Math.abs(pixels[a + 2] - pixels[b + 2]);
      if (delta > 27) votes[pos] += 1 + Math.min(3, (delta - 27) / 85);
    }
  }
  const scores = new Float32Array(length + 1);
  for (let i = 2; i < length - 1; i++) scores[i] = Math.max(votes[i - 1], votes[i], votes[i + 1]) * 3 / cross;
  return { scores, votes };
}

function axisCandidates(scores, step) {
  const last = Math.floor(scores.length - 1 - 8 * step);
  const starts = [];
  for (let edge = 0; edge <= last; edge++) {
    let sum = 0;
    let minimum = Infinity;
    for (let n = 1; n < 8; n++) {
      const strength = scores[Math.round(edge + n * step)];
      sum += strength;
      minimum = Math.min(minimum, strength);
    }
    const strength = sum + minimum * 3;
    if (minimum < 0.055) continue;
    const previous = starts.at(-1);
    if (previous && edge - previous.edge <= 2) {
      if (strength > previous.strength) starts[starts.length - 1] = { edge, strength };
    } else {
      starts.push({ edge, strength });
    }
  }
  return starts.sort((a, b) => b.strength - a.strength).slice(0, 4);
}

function distance(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function medianColor(colors) {
  return [0, 1, 2].map(channel => {
    const values = colors.map(color => color[channel]).sort((a, b) => a - b);
    return values[values.length >> 1];
  });
}

function checkGrid(pixels, width, { x, y, step }) {
  const phases = [[], []];
  const tiles = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const phase = (row + col) % 2;
      const taps = [];
      for (const oy of CROPS) {
        for (const ox of CROPS) {
          const index = (Math.floor(y + (row + oy) * step) * width
            + Math.floor(x + (col + ox) * step)) * 4;
          taps.push([pixels[index], pixels[index + 1], pixels[index + 2]]);
        }
      }
      phases[phase].push(...taps);
      tiles.push({ taps, phase });
    }
  }
  const colors = phases.map(medianColor);
  const contrast = distance(...colors);
  if (contrast < 42) return 0;
  const tolerance = Math.max(27, Math.min(84, contrast * 0.4));
  let matching = 0;
  let hits = 0;
  const rows = Array(8).fill(0);
  const cols = Array(8).fill(0);
  tiles.forEach(({ taps, phase }, index) => {
    const correct = taps.filter(color => {
      const error = distance(color, colors[phase]);
      return error < tolerance && error < distance(color, colors[1 - phase]) * 0.68;
    }).length;
    hits += correct;
    if (correct < 2) return;
    matching++;
    rows[index >> 3]++;
    cols[index % 8]++;
  });
  if (matching < 43 || Math.min(...rows) < 2 || Math.min(...cols) < 2) return 0;
  const greenError = Math.min(distance(colors[0], GREEN[0]) + distance(colors[1], GREEN[1]),
    distance(colors[0], GREEN[1]) + distance(colors[1], GREEN[0]));
  return matching + hits / 12 + (greenError < 58 ? 4 : 0);
}

function refineAxis(votes, start, step) {
  const peaks = [];
  for (let n = 1; n < 8; n++) {
    const center = Math.round(start + step * n);
    let best = center;
    for (let i = center - 3; i <= center + 3; i++) {
      if (votes[i] > votes[best]) best = i;
    }
    let sum = 0;
    let mass = 0;
    for (let i = best - 1; i <= best + 1; i++) {
      sum += i * votes[i];
      mass += votes[i];
    }
    if (mass) peaks.push([n, sum / mass]);
  }
  if (peaks.length < 5) return { start, step };
  const mean = peaks.reduce((sum, [n]) => sum + n, 0) / peaks.length;
  const average = peaks.reduce((sum, [, p]) => sum + p, 0) / peaks.length;
  const variance = peaks.reduce((sum, [n]) => sum + (n - mean) ** 2, 0);
  const slope = peaks.reduce((sum, [n, p]) => sum + (n - mean) * (p - average), 0) / variance;
  return { start: average - mean * slope, step: slope };
}

/** Return a square in the sampled image coordinate space. */
export function findBoard({ data, width, height }) {
  const horizontal = axisEdges(data, width, height, false);
  const vertical = axisEdges(data, width, height, true);
  const candidates = [];
  const maxStep = Math.min(width, height) / 8;
  for (let step = 10; step <= maxStep; step += 0.5) {
    const xs = axisCandidates(horizontal.scores, step);
    if (!xs.length) continue;
    const ys = axisCandidates(vertical.scores, step);
    for (const x of xs) {
      for (const y of ys) {
        candidates.push({ x: x.edge, y: y.edge, step,
          strength: Math.sqrt(x.strength * y.strength) + step / maxStep });
      }
    }
  }
  // Also test a board that touches the image edges at a fractional tile size.
  if (maxStep % 0.5 > 0.01) {
    for (const x of axisCandidates(horizontal.scores, maxStep)) {
      for (const y of axisCandidates(vertical.scores, maxStep)) {
        candidates.push({ x: x.edge, y: y.edge, step: maxStep,
          strength: Math.sqrt(x.strength * y.strength) + 1 });
      }
    }
  }
  candidates.sort((a, b) => b.strength - a.strength);
  let best = null;
  let bestScore = 0;
  const tried = new Set();
  for (const candidate of candidates) {
    const key = [Math.round(candidate.x / 4), Math.round(candidate.y / 4), Math.round(candidate.step)].join('/');
    if (tried.has(key)) continue;
    if (tried.size >= 65) break;
    tried.add(key);
    // A perfect checker contributes at most 64 matching squares, 256 taps and 4 theme points.
    const geometry = 3 * candidate.strength + 13 * (candidate.step / maxStep);
    if (geometry + 64 + 256 / 12 + 4 <= bestScore) continue;
    const checker = checkGrid(data, width, candidate);
    if (!checker) continue;
    const score = checker + geometry;
    if (score <= bestScore) continue;
    best = candidate;
    bestScore = score;
  }
  if (!best) return null;
  const x = refineAxis(horizontal.votes, best.x, best.step);
  const y = refineAxis(vertical.votes, best.y, best.step);
  const size = Math.min(width, height, 4 * (x.step + y.step));
  return {
    x: Math.max(0, Math.min(width - size, x.start + 4 * x.step - size / 2)),
    y: Math.max(0, Math.min(height - size, y.start + 4 * y.step - size / 2)),
    size
  };
}

function variants(mask) {
  const indices = [];
  for (const scale of [0.91, 1, 1.09]) {
    for (const dy of [-2, 0, 2]) {
      for (const dx of [-2, 0, 2]) {
        const pixels = [];
        for (let y = 3; y < TILE - 3; y++) {
          const sy = Math.round((y - 23.5 - dy) / scale + 23.5);
          if (sy < 0 || sy >= TILE) continue;
          for (let x = 3; x < TILE - 3; x++) {
            const sx = Math.round((x - 23.5 - dx) / scale + 23.5);
            if (sx >= 0 && sx < TILE && mask[sy * TILE + sx]) pixels.push(y * TILE + x);
          }
        }
        indices.push(Uint16Array.from(pixels));
      }
    }
  }
  return indices;
}

let templates;
function referenceTemplates() {
  templates ??= Object.fromEntries(PIECE_CODES.map(code => {
    const packed = atob(silhouettes[code]);
    const mask = Uint8Array.from({ length: TILE ** 2 }, (_, i) =>
      packed.charCodeAt(i >> 3) >> (7 - (i % 8)) & 1);
    return [code, variants(mask)];
  }));
  return templates;
}

export function warmVision() {
  referenceTemplates();
}

function tileBackground(data, offset) {
  const colors = new Map();
  for (const startY of [4, 37]) {
    for (const startX of [4, 37]) {
      for (let y = startY; y < startY + 7; y += 2) {
        for (let x = startX; x < startX + 7; x += 2) {
          const idx = offset + (y * BOARD + x) * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2];
          const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
          let bin = colors.get(key);
          if (!bin) {
            bin = [0, 0, 0, 0];
            colors.set(key, bin);
          }
          bin[0] += r;
          bin[1] += g;
          bin[2] += b;
          bin[3]++;
        }
      }
    }
  }
  const ordered = [...colors.values()].sort((a, b) => b[3] - a[3]);
  const [r, g, b, count] = ordered[0];
  return [r / count, g / count, b / count];
}

function tileFeatures(data, col, row) {
  const offset = (row * TILE * BOARD + col * TILE) * 4;
  const bg = tileBackground(data, offset);
  const raw = new Uint8Array(TILE ** 2);
  const luma = new Uint8Array(TILE ** 2);
  const ignored = new Uint8Array(TILE ** 2);
  let clipped = 0;
  // A notification crossing most of a tile row makes those pixels unreliable.
  for (let y = 3; y < TILE - 3; y++) {
    const a = offset + (y * BOARD + 5) * 4;
    const b = offset + (y * BOARD + 42) * 4;
    const left = [data[a], data[a + 1], data[a + 2]];
    const right = [data[b], data[b + 1], data[b + 2]];
    const average = left.map((value, i) => (value + right[i]) / 2);
    const local = distance(left, right) < 43 && distance(average, bg) < 86 ? average : bg;
    let rim = 0;
    let broad = 0;
    for (let x = 3; x < TILE - 3; x++) {
      const idx = offset + (y * BOARD + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const index = y * TILE + x;
      const contrast = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
      luma[index] = (r * 54 + g * 183 + b * 19) >> 8;
      if (contrast >= 43) {
        broad++;
        if (x < 6 || x >= TILE - 6) rim++;
      }
      const localDelta = Math.abs(r - local[0]) + Math.abs(g - local[1]) + Math.abs(b - local[2]);
      const chroma = Math.abs((g - b) - (local[1] - local[2]));
      if (localDelta >= 34 || (localDelta >= 20 && chroma >= 17)) raw[index] = 1;
    }
    if (broad >= 34 && rim >= 4) {
      ignored.fill(1, y * TILE, (y + 1) * TILE);
      clipped++;
    }
  }
  const stable = new Uint8Array(TILE ** 2);
  for (let y = 3; y < TILE - 3; y++) {
    for (let x = 3; x < TILE - 3; x++) {
      const index = y * TILE + x;
      if (!raw[index] || ignored[index]) continue;
      const neighbors = raw[index - 1] + raw[index + 1] + raw[index - TILE] + raw[index + TILE];
      if (neighbors < 2) continue;
      stable[index] = 1;
    }
  }
  const mask = new Uint8Array(TILE ** 2);
  let count = 0, dark = 0, light = 0;
  // Keep connected ink that reaches the center. This filters rank/file labels in the rim.
  const pending = new Uint16Array(TILE ** 2);
  for (let y = 8; y <= 41; y++) {
    for (let x = 10; x <= 37; x++) {
      const seed = y * TILE + x;
      if (!stable[seed]) continue;
      let size = 1;
      pending[0] = seed;
      stable[seed] = 0;
      for (let cursor = 0; cursor < size; cursor++) {
        const index = pending[cursor];
        for (let side = 0; side < 4; side++) {
          const next = index + NEIGHBORS[side];
          if (!stable[next]) continue;
          stable[next] = 0;
          pending[size++] = next;
        }
      }
      if (size < 11) continue;
      count += size;
      for (let i = 0; i < size; i++) {
        const index = pending[i];
        mask[index] = 1;
        if (luma[index] > 165) light++;
        if (luma[index] < 100) dark++;
      }
    }
  }
  return { mask, ignored, count, dark, light, clipped, bg };
}

function matchTile(features, learned) {
  const { mask, ignored, count, dark, light, clipped } = features;
  if (count < 53) return { code: '', uncertain: clipped >= 2 || count >= 31 };
  const scores = [];
  const colorBias = (light - dark) / count;
  const profiles = referenceTemplates();
  for (const code of PIECE_CODES) {
    const white = code === code.toUpperCase();
    if ((colorBias > 0.57 && !white) || (colorBias < -0.57 && white)) continue;
    const colorPenalty = Math.max(0, (white ? -colorBias : colorBias) + (white ? -0.38 : 0.12)) * 0.24;
    let maximum = 0;
    const allVariants = learned[code] ? [...profiles[code], ...learned[code]] : profiles[code];
    for (const indices of allVariants) {
      let intersection = 0;
      let visible = indices.length;
      for (const index of indices) {
        intersection += mask[index];
        visible -= ignored[index];
      }
      maximum = Math.max(maximum, 2 * intersection / (count + visible));
    }
    scores.push({ code, score: maximum - colorPenalty });
  }
  scores.sort((a, b) => b.score - a.score);
  const [best, next] = scores;
  return {
    code: best.score >= 0.48 ? best.code : '',
    uncertain: best.score < 0.73 || best.score - next.score < 0.035 || clipped >= 3
  };
}

export function rememberContour(imageData, index, code) {
  const tile = tileFeatures(imageData.data, index % 8, index >> 3);
  if (tile.count < 70 || tile.count > 1350 || tile.clipped > 1) {
    throw new Error('Для калібрування вибери клітинку з повністю видимою фігурою.');
  }
  return Array.from(tile.mask.entries()).filter(([, value]) => value).map(([index]) => index);
}

export function loadContours(saved) {
  const learned = {};
  for (const code of PIECE_CODES) {
    if (!Array.isArray(saved[code])) continue;
    learned[code] = saved[code].slice(-3).filter(Array.isArray).flatMap(indices => {
      const mask = new Uint8Array(TILE ** 2);
      for (const index of indices) if (Number.isInteger(index) && index >= 0 && index < mask.length) mask[index] = 1;
      return variants(mask);
    });
  }
  return learned;
}

function orientation(tiles) {
  let balance = 0;
  tiles.forEach(({ code, uncertain }, index) => {
    const row = index >> 3;
    if (!code || (row >= 2 && row < 6)) return;
    const color = code === code.toUpperCase() ? 1 : -1;
    balance += color * (row >= 6 ? 1 : -1) * (uncertain ? 0.4 : 1);
  });
  return { blackBottom: balance < 0, orientationUncertain: Math.abs(balance) < 2 };
}

function tilePhase(index) {
  return ((index >> 3) + index % 8) % 2;
}

function guessTurn(tiles, blackBottom) {
  const highlighted = tiles.filter(tile => tile.highlighted);
  if (highlighted.length === 2 && highlighted.filter(tile => tile.code).length === 1
      && !highlighted.some(tile => tile.uncertain)) {
    const { code } = highlighted.find(tile => tile.code);
    return { turn: code === code.toUpperCase() ? 'b' : 'w', turnSource: 'за підсвіткою ходу' };
  }
  return { turn: blackBottom ? 'b' : 'w', turnSource: 'за нижньою стороною' };
}

/** imageData must be a 384 × 384 board, in screenshot order. */
export function readBoard(imageData, learned = {}) {
  const tiles = Array.from({ length: 64 }, (_, i) => {
    const features = tileFeatures(imageData.data, i % 8, i >> 3);
    return { ...matchTile(features, learned), bg: features.bg };
  });
  const backgrounds = [0, 1].map(phase => medianColor(tiles.flatMap((tile, index) =>
    tilePhase(index) === phase ? [tile.bg] : [])));
  tiles.forEach((tile, index) => {
    const [r, g, b] = tile.bg;
    const difference = distance(tile.bg, backgrounds[tilePhase(index)]);
    tile.highlighted = difference > 50 && r > 155 && g > 155 && b + 22 < Math.min(r, g);
    if (difference > 105 && !tile.highlighted) tile.uncertain = true;
  });
  const facing = orientation(tiles);
  return { tiles, ...facing, ...guessTurn(tiles, facing.blackBottom) };
}

export const BOARD_PIXELS = BOARD;

import { Chess } from './vendor/chess.js';

const FILES = 'abcdefgh';
const PAWN = { w: 'P', b: 'p' };
const CASTLE = {
  K: ['e1', 'K', 'h1', 'R'], Q: ['e1', 'K', 'a1', 'R'],
  k: ['e8', 'k', 'h8', 'r'], q: ['e8', 'k', 'a8', 'r']
};

export function squareName(index, blackBottom) {
  const canonical = blackBottom ? 63 - index : index;
  return FILES[canonical % 8] + (8 - (canonical >> 3));
}

export function visibleIndex(square, blackBottom) {
  const canonical = FILES.indexOf(square[0]) + (8 - Number(square[1])) * 8;
  return blackBottom ? 63 - canonical : canonical;
}

export function canonicalPlacement(tiles, blackBottom) {
  const placement = [];
  tiles.forEach((tile, index) => { placement[blackBottom ? 63 - index : index] = tile.code; });
  return placement;
}

function pieceAt(placement, square) {
  return placement[visibleIndex(square, false)];
}

export function castlingOptions(placement) {
  return Object.entries(CASTLE).filter(([, [king, kingCode, rook, rookCode]]) =>
    pieceAt(placement, king) === kingCode && pieceAt(placement, rook) === rookCode).map(([right]) => right);
}

export function enPassantOptions(placement, turn) {
  const [target, current, previous, opposing] = turn === 'w' ? [6, 5, 7, 'b'] : [3, 4, 2, 'w'];
  const squares = [];
  for (let i = 0; i < 8; i++) {
    const file = FILES[i];
    if (pieceAt(placement, file + target) || pieceAt(placement, file + previous)
        || pieceAt(placement, file + current) !== PAWN[opposing]) continue;
    const neighbors = [FILES[i - 1], FILES[i + 1]].filter(Boolean);
    if (neighbors.some(next => pieceAt(placement, next + current) === PAWN[turn])) squares.push(file + target);
  }
  return squares;
}

export function makeFen(placement, turn, castling, ep, half, full) {
  const ranks = [];
  for (let rank = 0; rank < 8; rank++) {
    let text = '';
    let run = 0;
    for (const code of placement.slice(rank * 8, rank * 8 + 8)) {
      if (!code) {
        run++;
        continue;
      }
      if (run) text += run;
      text += code;
      run = 0;
    }
    ranks.push(text + (run || ''));
  }
  return [ranks.join('/'), turn, castling || '-', ep, half, full].join(' ');
}

export function positionForEngine(fen, placement, turn) {
  for (const [king, pawn, label] of [['K', 'P', 'білих'], ['k', 'p', 'чорних']]) {
    if (placement.filter(code => code === king).length !== 1) {
      throw new Error('Перевір короля ' + label + '. На дошці має бути рівно один.');
    }
    const pawns = placement.filter(code => code === pawn).length;
    const roster = placement.filter(code => code && (code === code.toUpperCase()) === (king === 'K'));
    if (pawns > 8 || roster.length > 16) throw new Error('Перевір кількість фігур ' + label + '.');
  }
  if ([...placement.slice(0, 8), ...placement.slice(56)].some(code => code.toLowerCase() === 'p')) {
    throw new Error('На першій або восьмій горизонталі є пішак. Перевір клітинки.');
  }
  const game = new Chess(fen);
  const otherKing = squareName(placement.indexOf(turn === 'w' ? 'k' : 'K'), false);
  if (game.isAttacked(otherKing, turn)) {
    throw new Error('Король суперника під шахом. Перевір чергу ходу та фігури.');
  }
  return game;
}

export function moveNotation(game, uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  try {
    const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return move.san;
  } catch {
    return null;
  }
}

export function formatScore(score, turn) {
  if (!score) return '—';
  const value = score.value * (turn === 'b' ? -1 : 1);
  if (score.type === 'mate') return (value < 0 ? '−' : '') + 'M' + Math.abs(value);
  if (!value) return '0.00';
  return (value < 0 ? '−' : '+') + (Math.abs(value) / 100).toFixed(2);
}

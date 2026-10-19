// Heuristic bot: scores every legal move with hand-tuned rules and plays the best,
// with a little noise so it isn't fully predictable. It reasons about unknown
// enemy pieces through the tracker's count-based rank odds.
//
// Rules, roughly in order of weight:
//   - attacks:   expected material from the battle (covers taking known weaker
//                pieces, not throwing high pieces at unknowns, and Miners at
//                unmoved pieces, which carry the Bomb odds)
//   - defense:   avoid ending next to an enemy likely to beat the piece, and
//                escape such squares
//   - Spy:       close in on a known enemy Marshal
//   - flag:      move toward and attack enemy pieces near our own flag
//   - progress:  otherwise advance toward enemies the piece is favored against,
//                or toward unexplored ones
const engine = require('./engine');
const { createTracker } = require('./tracker');

// Rough material values. The Flag is worth a lot but not everything, so a small
// chance of hitting it doesn't outweigh a likely Bomb.
const VALUE = { 10: 100, 9: 70, 8: 45, 7: 30, 6: 20, 5: 13, 4: 9, 3: 14, 2: 6, 1: 30, B: 12, F: 150 };
// Revealing a strong piece by attacking with it makes it a target (for the Spy especially).
const EXPOSURE = { 10: 30, 9: 20, 8: 8, 7: 4 };

// Tunable weights; bot-vs-bot runs can override any of them.
const DEFAULT_WEIGHTS = {
  info: 6,              // learning an unknown enemy piece's rank
  infoStrong: 0,        // multiplier on `info` when the attacker is worth more than a Captain
  hiddenRisk: 0.4,      // how likely an enemy attacks a piece whose rank it can't see
  progress: 3,          // per square closer to a target the piece is favored against
  explore: 1,           // per square closer to an unknown enemy piece
  spy: 4,               // per square the Spy closes on a known Marshal
  guard: 3,             // per square closer to an intruder near our flag
  guardAttack: 15,
  guardRadius: 3,
  repeat: 4,            // moving a piece back to a square it just left
  noise: 1.5,
  flagValue: VALUE.F,          // finding the Flag, worth more than any piece
  flagValueIfMiners: 0,        // the same for non-Miners while we still have Miners to send instead
  stall: 10,            // added to every attack per 50 plies without a battle, so endgames don't stall
};

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function manhattan(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function isEnemy(cell) {
  return cell && typeof cell === 'object' && !cell.own;
}

function isOwn(cell) {
  return cell && typeof cell === 'object' && cell.own;
}

/* ------------------------------------------------------------------ setup */

// Flag on the back row with bombs beside and in front of it, Miners kept back,
// Scouts up front, everything else shuffled. Listed in board order, since piece
// ids follow placement order and must not give ranks away.
function templateSetup(color, random) {
  // depth 0 is the front row, 3 the back row
  const rowAt = (depth) => (color === 'north' ? 3 - depth : 6 + depth);
  const ranks = {};
  const taken = new Set();
  const key = (r, c) => r * 10 + c;

  const place = (rank, r, c) => {
    ranks[key(r, c)] = rank;
    taken.add(key(r, c));
  };
  // A random free cell whose depth passes `ok`, or any free cell if none does.
  const pick = (ok) => {
    const free = [];
    const fallback = [];
    for (let depth = 0; depth < 4; depth++) {
      for (let c = 0; c < 10; c++) {
        const r = rowAt(depth);
        if (taken.has(key(r, c))) continue;
        fallback.push([r, c]);
        if (ok(depth)) free.push([r, c]);
      }
    }
    const pool = free.length ? free : fallback;
    return pool[Math.floor(random() * pool.length)];
  };
  const placeMany = (rank, count, ok) => {
    for (let i = 0; i < count; i++) {
      const [r, c] = pick(ok);
      place(rank, r, c);
    }
  };

  const flagCol = Math.floor(random() * 10);
  place('F', rowAt(3), flagCol);
  let bombs = 6;
  for (const [r, c] of [[rowAt(3), flagCol - 1], [rowAt(3), flagCol + 1], [rowAt(2), flagCol]]) {
    if (c >= 0 && c <= 9) {
      place('B', r, c);
      bombs--;
    }
  }
  placeMany('B', bombs, d => d >= 1);
  placeMany(3, 3, d => d >= 2);
  placeMany(3, 2, d => d >= 1);
  placeMany(2, 4, d => d === 0);
  placeMany(10, 1, d => d <= 2);
  placeMany(9, 1, d => d <= 2);
  placeMany(1, 1, d => d === 1 || d === 2);

  const rest = [];
  for (const { rank, count } of engine.RANKS) {
    const placed = Object.values(ranks).filter(x => x === rank).length;
    for (let i = placed; i < count; i++) rest.push(rank);
  }
  for (const rank of rest) placeMany(rank, 1, () => true);

  const placement = [];
  for (const r of engine.homeRows(color)) {
    for (let c = 0; c < 10; c++) placement.push({ rank: ranks[key(r, c)], r, c });
  }
  return placement;
}

/* ------------------------------------------------------------------- play */

// Expected material gain from `rank` attacking a piece with these odds, and
// the chance the attacker survives. `flagValue` is what finding the Flag is worth.
function attackValue(rank, odds, flagValue) {
  let gain = 0;
  let pWin = 0;
  for (const [key, p] of Object.entries(odds)) {
    const target = key === 'B' || key === 'F' ? key : Number(key);
    const outcome = engine.battleOutcome(rank, target);
    if (outcome === 'attacker') {
      gain += p * (target === 'F' ? flagValue : VALUE[target]);
      pWin += p;
    } else if (outcome === 'defender') {
      gain -= p * VALUE[rank];
    } else {
      gain += p * (VALUE[target] - VALUE[rank]);
    }
  }
  return { gain, pWin };
}

// Chance that an enemy piece with these odds beats `rank` if it attacks.
// Bombs and the Flag can't attack, so their share counts as no threat.
function threatFrom(odds, rank) {
  let p = 0;
  for (const [key, chance] of Object.entries(odds)) {
    if (key === 'B' || key === 'F') continue;
    const outcome = engine.battleOutcome(Number(key), rank);
    if (outcome === 'attacker') p += chance;
    else if (outcome === 'both') p += chance / 2;
  }
  return p;
}

// Distance from every square to the nearest of `targets`, walking around lakes
// and pieces. `open` squares count as passable even if occupied.
function distanceMap(board, targets, open) {
  const dist = Array(10).fill(null).map(() => Array(10).fill(Infinity));
  const queue = [];
  for (const [r, c] of targets) {
    dist[r][c] = 0;
    queue.push([r, c]);
  }
  const passable = (r, c) =>
    board[r][c] === null || open.some(([or, oc]) => or === r && oc === c);
  for (let i = 0; i < queue.length; i++) {
    const [r, c] = queue[i];
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr > 9 || nc < 0 || nc > 9) continue;
      if (dist[nr][nc] !== Infinity || !passable(nr, nc)) continue;
      dist[nr][nc] = dist[r][c] + 1;
      queue.push([nr, nc]);
    }
  }
  return dist;
}

function createHeuristicBot(random, overrides = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...overrides };
  const tracker = createTracker();
  const recentSquares = new Map(); // own piece id -> squares it recently left
  let quietPlies = 0;

  function chooseMove(view, moves) {
    if (!moves.length) return null;
    const board = view.board;

    // Probing likely Bombs for the Flag is a Miner's job; other pieces only take
    // that gamble once no Miner is left to send.
    const flagValueFor = (rank) => (rank !== 3 && myMiners > 0 ? w.flagValueIfMiners : w.flagValue);

    const oddsCache = new Map();
    const oddsOf = (cell) => {
      if (!oddsCache.has(cell.id)) oddsCache.set(cell.id, tracker.rankOdds(cell.id));
      return oddsCache.get(cell.id);
    };

    const enemies = [];
    let myFlag = null;
    let myMiners = 0;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const cell = board[r][c];
        if (isEnemy(cell)) enemies.push({ cell, at: [r, c] });
        else if (isOwn(cell) && cell.rank === 'F') myFlag = [r, c];
        else if (isOwn(cell) && cell.rank === 3) myMiners++;
      }
    }
    const knownMarshal = enemies.find(e => {
      const p = tracker.piece(e.cell.id);
      return p && p.rank === 10;
    });
    const intruders = myFlag ? enemies.filter(e => manhattan(e.at, myFlag) <= w.guardRadius) : [];

    // Expected loss if `rank` stands on `square` next to enemies who may strike.
    const danger = (square, rank, seen, ignore) => {
      let worst = 0;
      for (const [dr, dc] of DIRS) {
        const r = square[0] + dr;
        const c = square[1] + dc;
        if (r < 0 || r > 9 || c < 0 || c > 9) continue;
        if (ignore && ignore[0] === r && ignore[1] === c) continue;
        const cell = board[r][c];
        if (isEnemy(cell)) worst = Math.max(worst, threatFrom(oddsOf(cell), rank));
      }
      return worst * VALUE[rank] * (seen ? 1 : w.hiddenRisk);
    };

    // Per moving piece, distances to the targets it should head for.
    const routeCache = new Map();
    const routesFor = (from, rank) => {
      const k = from.join();
      if (routeCache.has(k)) return routeCache.get(k);
      const favored = enemies.filter(e => attackValue(rank, oddsOf(e.cell), flagValueFor(rank)).gain > 0).map(e => e.at);
      const unknown = enemies.filter(e => tracker.piece(e.cell.id).rank === null).map(e => e.at);
      const routes = {
        favored: favored.length ? distanceMap(board, favored, [from]) : null,
        unknown: unknown.length ? distanceMap(board, unknown, [from]) : null,
      };
      routeCache.set(k, routes);
      return routes;
    };
    const closer = (dist, from, to) => {
      if (!dist || dist[from[0]][from[1]] === Infinity) return 0;
      return Math.min(3, dist[from[0]][from[1]] - dist[to[0]][to[1]]);
    };

    let best = null;
    let bestScore = -Infinity;
    for (const move of moves) {
      const { from, to } = move;
      const piece = board[from[0]][from[1]];
      const target = board[to[0]][to[1]];
      const rank = piece.rank;
      let score = danger(from, rank, piece.revealed);

      if (target) {
        const { gain, pWin } = attackValue(rank, oddsOf(target), flagValueFor(rank));
        score += gain + w.stall * Math.floor(quietPlies / 50);
        if (tracker.piece(target.id).rank === null) score += w.info * (VALUE[rank] > VALUE[6] ? w.infoStrong : 1);
        if (!piece.revealed) score -= pWin * (EXPOSURE[rank] || 0);
        score -= pWin * danger(to, rank, true, to);
        if (intruders.some(e => e.at[0] === to[0] && e.at[1] === to[1])) score += w.guardAttack;
      } else {
        score -= danger(to, rank, piece.revealed);
        const routes = routesFor(from, rank);
        if (routes.favored) score += w.progress * closer(routes.favored, from, to);
        else score += w.explore * closer(routes.unknown, from, to);

        if (rank === 1 && knownMarshal) {
          score += w.spy * (manhattan(from, knownMarshal.at) - manhattan(to, knownMarshal.at));
        }
        if (intruders.length && rank >= 4) {
          const near = (sq) => Math.min(...intruders.map(e => manhattan(sq, e.at)));
          score += w.guard * (near(from) - near(to));
        }
      }

      const recent = recentSquares.get(piece.id) || [];
      if (recent.some(([r, c]) => r === to[0] && c === to[1])) score -= w.repeat;

      score += random() * w.noise;
      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
    }

    const piece = board[best.from[0]][best.from[1]];
    recentSquares.set(piece.id, [best.from, ...(recentSquares.get(piece.id) || [])].slice(0, 2));
    return best;
  }

  return {
    chooseSetup: (color) => templateSetup(color, random),
    observe: (view, battle) => {
      tracker.observe(view, battle);
      quietPlies = battle ? 0 : quietPlies + 1;
    },
    chooseMove,
  };
}

module.exports = { createHeuristicBot, templateSetup, DEFAULT_WEIGHTS };

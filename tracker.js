// Enemy tracker: a bot's memory of the opponent's army. Pure, like engine.js.
//
// It is fed exactly what a bot is fed: the redacted view after every ply, plus the
// battle (if any) that ply caused, and once more with the opening position before
// the first move. From that it keeps, per enemy piece id:
//   rank   - known for certain (revealed in battle, or a Scout given away by a long
//            move), else null
//   moved  - whether the piece has ever moved (pieces that haven't may be Bombs or the Flag)
// and how many enemy pieces of each rank are still alive.
//
// Memory is perfect: a rank seen once is kept even after a per-turn reveal lapses.
//
// Options (both off by default, which gives the plain count-based estimate):
//   balanced - rank odds for all unknown pieces are fitted together, so each rank's
//              odds add up across the army to how many of that rank are unknown
//   behavior - how strongly to read moves: an enemy piece that walks up to one of
//              our pieces it can see is likely to beat it, one that backs away is
//              likely to lose to it. Each such move multiplies the matching ranks'
//              weight by this much (1 = ignore behavior).
const engine = require('./engine');

const ALL_RANKS = engine.RANKS.map(r => r.rank);
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BALANCE_ROUNDS = 50;
// However much a piece's moves say, its most and least likely ranks stay within
// behavior^MAX_EVIDENCE of each other; players bluff, and weights must not overflow.
const MAX_EVIDENCE = 4;

function isMine(cell) {
  return cell && typeof cell === 'object' && cell.own;
}

// Our pieces the enemy can currently see, next to `square`, keyed by id.
function seenNeighbors(board, [r, c]) {
  const found = new Map();
  for (const [dr, dc] of DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nr > 9 || nc < 0 || nc > 9) continue;
    const cell = board[nr][nc];
    if (isMine(cell) && cell.revealed) found.set(cell.id, cell.rank);
  }
  return found;
}

function createTracker({ balanced = false, behavior = 1 } = {}) {
  const pieces = new Map(); // id -> { id, rank, moved, weights }
  const remaining = Object.fromEntries(engine.RANKS.map(r => [r.rank, r.count]));
  let balancedCache = null;

  // Behavior evidence: scale up the ranks for which `test(rank)` holds.
  function weigh(entry, test) {
    if (behavior === 1 || entry.rank !== null) return;
    for (const r of ALL_RANKS) {
      if (r !== 'B' && r !== 'F' && test(r)) entry.weights[r] *= behavior;
    }
    const top = Math.max(...Object.values(entry.weights));
    const floor = Math.pow(behavior, -MAX_EVIDENCE);
    for (const r of ALL_RANKS) entry.weights[r] = Math.max(entry.weights[r] / top, floor);
  }

  function observe(view, battle) {
    const enemy = view.you === 'south' ? 'north' : 'south';
    balancedCache = null;

    // Battles name both ranks, so every enemy loss can be counted off.
    if (battle) {
      const { attacker, defender, outcome } = battle;
      if ((outcome === 'attacker' || outcome === 'both') && defender.owner === enemy) remaining[defender.rank]--;
      if ((outcome === 'defender' || outcome === 'both') && attacker.owner === enemy) remaining[attacker.rank]--;
    }

    // Sync with the board: start tracking new ids, keep any rank currently on
    // show, and forget pieces that are no longer there (they died).
    const onBoard = new Set();
    for (let r = 0; r < 10; r++) {
      for (const cell of view.board[r]) {
        if (!cell || typeof cell !== 'object' || cell.own) continue;
        onBoard.add(cell.id);
        let entry = pieces.get(cell.id);
        if (!entry) {
          entry = { id: cell.id, rank: null, moved: false, weights: Object.fromEntries(ALL_RANKS.map(r => [r, 1])) };
          pieces.set(cell.id, entry);
        }
        if (cell.rank !== undefined) entry.rank = cell.rank;
      }
    }
    for (const id of pieces.keys()) {
      if (!onBoard.has(id)) pieces.delete(id);
    }

    // Whatever survived the last move is standing on its destination square:
    // the mover if it won or moved into an empty square, the defender if it held.
    const move = view.lastMove;
    if (!move) return;
    const [fr, fc] = move.from;
    const [tr, tc] = move.to;
    const cell = view.board[tr][tc];
    if (!cell || typeof cell !== 'object' || cell.own) return;

    const entry = pieces.get(cell.id);
    if (move.color === enemy) {
      entry.moved = true;
      if (Math.abs(fr - tr) + Math.abs(fc - tc) > 1) entry.rank = 2; // only Scouts move far

      // Our pieces didn't move on the enemy's turn, so adjacency before the move
      // can be read off the current board.
      if (!battle) {
        const before = seenNeighbors(view.board, move.from);
        const after = seenNeighbors(view.board, move.to);
        for (const [id, rank] of after) {
          if (!before.has(id)) weigh(entry, r => engine.battleOutcome(r, rank) === 'attacker');
        }
        for (const [id, rank] of before) {
          if (!after.has(id)) weigh(entry, r => engine.battleOutcome(rank, r) === 'attacker');
        }
      }
    }
    if (battle) {
      entry.rank = battle.attacker.owner === enemy ? battle.attacker.rank : battle.defender.rank;
    }
  }

  // Alive enemy pieces of each rank that haven't been identified yet.
  function unknownCounts() {
    const counts = { ...remaining };
    for (const p of pieces.values()) {
      if (p.rank !== null) counts[p.rank]--;
    }
    return counts;
  }

  // Every rank this piece could still be.
  function possibleRanks(id) {
    const p = pieces.get(id);
    if (!p) return [];
    if (p.rank !== null) return [p.rank];
    const unknown = unknownCounts();
    return ALL_RANKS.filter(r => unknown[r] > 0 && !(p.moved && (r === 'B' || r === 'F')));
  }

  // A simple count-based estimate of what this piece is, as { rank: probability }.
  // Bombs and the Flag can only be among the unknown pieces that never moved, so
  // their odds are shared out over those; mobile ranks share whatever is left.
  function rankOdds(id) {
    const p = pieces.get(id);
    if (!p) return {};
    if (p.rank !== null) return { [p.rank]: 1 };
    if (balanced) return { ...balancedOdds().get(id) };

    const unknown = unknownCounts();
    const immobile = unknown.B + unknown.F;
    let mobileTotal = 0;
    for (const r of ALL_RANKS) if (r !== 'B' && r !== 'F') mobileTotal += unknown[r];
    let unmovedUnknown = 0;
    for (const q of pieces.values()) if (q.rank === null && !q.moved) unmovedUnknown++;

    const pImmobile = p.moved || immobile === 0 ? 0 : Math.min(1, immobile / unmovedUnknown);
    const odds = {};
    for (const r of ALL_RANKS) {
      if (unknown[r] <= 0) continue;
      const chance = r === 'B' || r === 'F'
        ? pImmobile * unknown[r] / immobile
        : (1 - pImmobile) * unknown[r] / mobileTotal;
      if (chance > 0) odds[r] = chance;
    }
    if (behavior === 1) return odds;

    let total = 0;
    for (const r of Object.keys(odds)) total += (odds[r] *= p.weights[r]);
    for (const r of Object.keys(odds)) odds[r] /= total;
    return odds;
  }

  // Fit odds for every unknown piece at once (Sinkhorn balancing): start from each
  // piece's behavior weights, with Bomb and Flag ruled out for pieces that moved,
  // then alternately scale each rank's column to its unknown count and each
  // piece's row to 1.
  function balancedOdds() {
    if (balancedCache) return balancedCache;
    const unknown = unknownCounts();
    const ranks = ALL_RANKS.filter(r => unknown[r] > 0);
    const rows = [...pieces.values()].filter(p => p.rank === null);
    const m = rows.map(p => ranks.map(r => (p.moved && (r === 'B' || r === 'F') ? 0 : p.weights[r])));

    for (let round = 0; round < BALANCE_ROUNDS; round++) {
      ranks.forEach((r, j) => {
        let col = 0;
        for (const row of m) col += row[j];
        if (col > 0) for (const row of m) row[j] *= unknown[r] / col;
      });
      for (const row of m) {
        const total = row.reduce((a, b) => a + b, 0);
        if (total > 0) for (let j = 0; j < row.length; j++) row[j] /= total;
      }
    }

    balancedCache = new Map();
    rows.forEach((p, i) => {
      const odds = {};
      ranks.forEach((r, j) => { if (m[i][j] > 0) odds[r] = m[i][j]; });
      balancedCache.set(p.id, odds);
    });
    return balancedCache;
  }

  const summary = (p) => ({ id: p.id, rank: p.rank, moved: p.moved });

  return {
    observe,
    rankOdds,
    piece: (id) => (pieces.has(id) ? summary(pieces.get(id)) : undefined),
    enemyPieces: () => [...pieces.values()].map(summary),
    remaining: () => ({ ...remaining }),
    unknownCounts,
    possibleRanks,
  };
}

module.exports = { createTracker };

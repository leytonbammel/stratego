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
const engine = require('./engine');

const ALL_RANKS = engine.RANKS.map(r => r.rank);

function createTracker() {
  const pieces = new Map(); // id -> { id, rank, moved }
  const remaining = Object.fromEntries(engine.RANKS.map(r => [r.rank, r.count]));

  function observe(view, battle) {
    const enemy = view.you === 'south' ? 'north' : 'south';

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
          entry = { id: cell.id, rank: null, moved: false };
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
    return odds;
  }

  return {
    observe,
    rankOdds,
    piece: (id) => (pieces.has(id) ? { ...pieces.get(id) } : undefined),
    enemyPieces: () => [...pieces.values()].map(p => ({ ...p })),
    remaining: () => ({ ...remaining }),
    unknownCounts,
    possibleRanks,
  };
}

module.exports = { createTracker };

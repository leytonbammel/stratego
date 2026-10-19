const test = require('node:test');
const assert = require('node:assert');
const engine = require('./engine');
const { createTracker } = require('./tracker');
const { randomSetup, seededRandom } = require('./bot');

const ALL_RANKS = engine.RANKS.map(r => r.rank);
const FULL_COUNTS = Object.fromEntries(engine.RANKS.map(r => [r.rank, r.count]));

// A legal setup whose front row is `front` (10 ranks, left to right); the rest of
// the army fills the rows behind it.
function layout(color, front) {
  const rest = [];
  for (const { rank, count } of engine.RANKS) {
    const used = front.filter(r => r === rank).length;
    for (let i = used; i < count; i++) rest.push(rank);
  }
  const rows = color === 'south' ? [6, 7, 8, 9] : [3, 2, 1, 0];
  const ranks = [...front, ...rest];
  const placement = [];
  rows.forEach((r, i) => {
    for (let c = 0; c < 10; c++) placement.push({ rank: ranks[i * 10 + c], r, c });
  });
  return placement;
}

const SCOUT_ROW = [2, 2, 2, 2, 2, 2, 2, 2, 3, 3];

// South's tracker watching a game built from the given front rows.
function setupGame(northFront = SCOUT_ROW, settings = {}) {
  const gameState = engine.createGame(layout('south', SCOUT_ROW), layout('north', northFront));
  const tracker = createTracker();
  tracker.observe(engine.redactView(gameState, 'south', settings), null);
  const play = (color, from, to) => {
    const { battle } = engine.applyMove(gameState, color, from, to);
    assert.ok(gameState.lastMove && gameState.lastMove.color === color, `move ${from}->${to} was illegal`);
    tracker.observe(engine.redactView(gameState, 'south', settings), battle);
    return battle;
  };
  const idAt = (r, c) => gameState.board[r][c].id;
  return { gameState, tracker, play, idAt };
}

test('starts with every enemy piece unknown and unmoved', () => {
  const { tracker, idAt } = setupGame();
  assert.strictEqual(tracker.enemyPieces().length, 40);
  assert.deepStrictEqual(tracker.remaining(), FULL_COUNTS);
  const p = tracker.piece(idAt(3, 0));
  assert.strictEqual(p.rank, null);
  assert.strictEqual(p.moved, false);
  assert.deepStrictEqual(tracker.possibleRanks(p.id).sort(), [...ALL_RANKS].sort());
});

test('an enemy piece that moves can no longer be a Bomb or Flag', () => {
  const { tracker, play, idAt } = setupGame();
  const id = idAt(3, 9);
  play('south', [6, 0], [5, 0]);
  play('north', [3, 9], [4, 9]);
  assert.strictEqual(tracker.piece(id).moved, true);
  assert.strictEqual(tracker.piece(id).rank, null);
  const possible = tracker.possibleRanks(id);
  assert.ok(!possible.includes('B') && !possible.includes('F'));
  assert.ok(possible.includes(10));
});

test('an enemy piece that moves more than one square is a Scout', () => {
  const { tracker, play, idAt } = setupGame();
  const id = idAt(3, 0);
  play('south', [6, 9], [5, 9]);
  play('north', [3, 0], [5, 0]);
  assert.strictEqual(tracker.piece(id).rank, 2);
  assert.deepStrictEqual(tracker.possibleRanks(id), [2]);
});

test('a battle reveals the surviving enemy piece', () => {
  // North's Marshal sits in the front row; South's Scout strikes it from range.
  const { tracker, play, idAt } = setupGame([2, 10, 2, 2, 2, 2, 2, 2, 3, 3]);
  const marshal = idAt(3, 1);
  play('south', [6, 1], [3, 1]);
  assert.strictEqual(tracker.piece(marshal).rank, 10);
  assert.strictEqual(tracker.piece(marshal).moved, false);
  assert.deepStrictEqual(tracker.remaining(), FULL_COUNTS); // South lost the battle
  // With the only Marshal accounted for, no other unknown piece can be one.
  assert.ok(!tracker.possibleRanks(idAt(3, 0)).includes(10));
});

test('an enemy piece that dies leaves the tracker and the remaining counts', () => {
  const { tracker, play, idAt } = setupGame();
  const scout = idAt(3, 1);
  play('south', [6, 1], [3, 1]); // Scout vs Scout: both fall
  assert.strictEqual(tracker.piece(scout), undefined);
  assert.strictEqual(tracker.enemyPieces().length, 39);
  assert.strictEqual(tracker.remaining()[2], 7);
});

test('an enemy attacker that wins is revealed and marked as moved', () => {
  const { tracker, play, idAt } = setupGame([2, 10, 2, 2, 2, 2, 2, 2, 3, 3]);
  const marshal = idAt(3, 1);
  play('south', [6, 1], [4, 1]);
  play('north', [3, 1], [4, 1]); // Marshal takes the Scout
  assert.strictEqual(tracker.piece(marshal).rank, 10);
  assert.strictEqual(tracker.piece(marshal).moved, true);
});

test('a revealed rank is remembered after a per-turn reveal lapses', () => {
  const settings = { revealMode: 'oneturn' };
  const { gameState, tracker, play, idAt } = setupGame([2, 10, 2, 2, 2, 2, 2, 2, 3, 3], settings);
  const marshal = idAt(3, 1);
  play('south', [6, 1], [3, 1]);
  play('north', [3, 9], [4, 9]);
  play('south', [6, 9], [5, 9]);
  const cell = engine.redactView(gameState, 'south', settings).board[3][1];
  assert.strictEqual(cell.rank, undefined, 'the view should have gone dark');
  assert.strictEqual(tracker.piece(marshal).rank, 10);
});

test('rankOdds is certain for known pieces and sums to 1 for unknown ones', () => {
  const { tracker, play, idAt } = setupGame([2, 10, 2, 2, 2, 2, 2, 2, 3, 3]);
  const marshal = idAt(3, 1);
  play('south', [6, 1], [3, 1]);
  assert.deepStrictEqual(tracker.rankOdds(marshal), { 10: 1 });

  const odds = tracker.rankOdds(idAt(3, 0));
  const total = Object.values(odds).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.strictEqual(odds[10], undefined, 'the Marshal is already accounted for');
});

test('rankOdds puts Bomb and Flag only on unmoved pieces', () => {
  const { tracker, play, idAt } = setupGame();
  const mover = idAt(3, 9);
  const stayer = idAt(0, 0);
  play('south', [6, 0], [5, 0]);
  play('north', [3, 9], [4, 9]);
  const moved = tracker.rankOdds(mover);
  assert.strictEqual(moved.B, undefined);
  assert.strictEqual(moved.F, undefined);
  // 6 Bombs among the 39 pieces that haven't moved.
  assert.ok(Math.abs(tracker.rankOdds(stayer).B - 6 / 39) < 1e-9);
});

// A hand-built view from South's side: a full unknown North army on rows 0-3,
// plus any extra cells. Returns helpers to move North pieces and re-observe.
function handView(tracker, extra = []) {
  const board = Array(10).fill(null).map((_, r) =>
    Array(10).fill(null).map((__, c) => (engine.isLake(r, c) ? 'lake' : null)));
  let id = 1;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) board[r][c] = { own: false, revealed: false, id: id++ };
  for (const { r, c, cell } of extra) board[r][c] = cell;
  const view = { you: 'south', turn: 'south', phase: 'play', lastMove: null, board };
  tracker.observe(view, null);
  return {
    board,
    northMove(from, to) {
      board[to[0]][to[1]] = board[from[0]][from[1]];
      board[from[0]][from[1]] = null;
      view.lastMove = { from, to, color: 'north' };
      tracker.observe(view, null);
    },
  };
}

const sum = (odds) => Object.values(odds).reduce((a, b) => a + b, 0);
const chanceOf = (odds, test) => Object.entries(odds).reduce((a, [r, p]) => a + (test(r) ? p : 0), 0);

// Moves twelve North pieces forward (into empty, non-lake squares only).
function advanceTwelve(northMove) {
  for (const c of [0, 1, 4, 5, 8, 9]) northMove([3, c], [4, c]);
  for (const c of [0, 1, 4, 5, 8, 9]) northMove([2, c], [3, c]);
}

test('balanced odds: rows sum to 1 and each rank adds up to its unknown count', () => {
  const tracker = createTracker({ balanced: true, behavior: 3 });
  const captain = { own: true, rank: 6, revealed: true, id: 100 };
  const { northMove } = handView(tracker, [{ r: 5, c: 4, cell: captain }]);
  advanceTwelve(northMove); // [3,4] -> [4,4] walks up to the Captain on the way

  const unknown = tracker.unknownCounts();
  const totals = Object.fromEntries(ALL_RANKS.map(r => [r, 0]));
  for (const p of tracker.enemyPieces()) {
    const odds = tracker.rankOdds(p.id);
    assert.ok(Math.abs(sum(odds) - 1) < 1e-9);
    if (p.moved) assert.ok(!odds.B && !odds.F, 'a moved piece cannot be a Bomb or Flag');
    for (const [r, pr] of Object.entries(odds)) totals[r] += pr;
  }
  for (const r of ALL_RANKS) assert.ok(Math.abs(totals[r] - unknown[r]) < 0.05, `rank ${r}: ${totals[r]} vs ${unknown[r]}`);
});

test('balanced odds share Bombs and the Flag evenly over the unmoved pieces', () => {
  const tracker = createTracker({ balanced: true });
  const { northMove } = handView(tracker);
  advanceTwelve(northMove);
  // 28 unmoved pieces must hold all 6 Bombs and the Flag.
  const stayer = 1; // id of [0,0], never moved
  assert.ok(Math.abs(tracker.rankOdds(stayer).B - 6 / 28) < 0.01);
  assert.ok(Math.abs(chanceOf(tracker.rankOdds(stayer), r => r === 'B' || r === 'F') - 7 / 28) < 0.01);
});

test('an enemy piece that walks up to a revealed piece is probably stronger', () => {
  const play = (tracker) => {
    const captain = { own: true, rank: 6, revealed: true, id: 100 };
    const { board, northMove } = handView(tracker, [{ r: 5, c: 4, cell: captain }]);
    const ids = { neutral: board[3][0].id, approacher: board[3][4].id };
    northMove([3, 0], [4, 0]);
    northMove([3, 4], [4, 4]); // now next to the Captain
    return ids;
  };
  const tracker = createTracker({ balanced: true, behavior: 3 });
  const { neutral, approacher } = play(tracker);
  const plain = createTracker({ balanced: true });
  play(plain);

  const stronger = (r) => r !== 'B' && r !== 'F' && Number(r) > 6;
  assert.ok(chanceOf(tracker.rankOdds(approacher), stronger) > chanceOf(tracker.rankOdds(neutral), stronger) + 0.1);
  // Balancing: if that piece is likely the Marshal, the others are a little less likely to be.
  assert.ok(tracker.rankOdds(neutral)[10] < plain.rankOdds(neutral)[10]);
});

test('an enemy piece that backs away from a revealed piece is probably weaker', () => {
  const tracker = createTracker({ balanced: true, behavior: 3 });
  const major = { own: true, rank: 7, revealed: true, id: 100 };
  const { board, northMove } = handView(tracker, [{ r: 4, c: 4, cell: major }]);
  const neutral = board[3][0].id;
  const runner = board[3][4].id; // starts next to the Major
  northMove([3, 0], [4, 0]);
  northMove([3, 5], [4, 5]);
  northMove([3, 4], [3, 5]); // steps out of the Major's reach
  const weaker = (r) => r !== 'B' && r !== 'F' && Number(r) < 7;
  assert.ok(chanceOf(tracker.rankOdds(runner), weaker) > chanceOf(tracker.rankOdds(neutral), weaker) + 0.1);
});

test('repeated behavior evidence stays bounded', () => {
  const tracker = createTracker({ balanced: true, behavior: 3 });
  const captain = { own: true, rank: 6, revealed: true, id: 100 };
  const { board, northMove } = handView(tracker, [{ r: 5, c: 4, cell: captain }]);
  const shuffler = board[3][4].id;
  northMove([3, 4], [4, 4]);
  for (let i = 0; i < 1000; i++) { // approach over and over from the side
    northMove([4, 4], [4, 5]);
    northMove([4, 5], [4, 4]);
  }
  const odds = tracker.rankOdds(shuffler);
  assert.ok(Object.values(odds).every(Number.isFinite));
  assert.ok(Math.abs(sum(odds) - 1) < 1e-9);
  assert.ok(odds[2] > 0.001, 'weaker ranks should never be ruled out by behavior alone');
});

test('behavior ignores pieces the enemy cannot see', () => {
  const tracker = createTracker({ balanced: true, behavior: 3 });
  const hidden = { own: true, rank: 6, revealed: false, id: 100 };
  const { board, northMove } = handView(tracker, [{ r: 5, c: 4, cell: hidden }]);
  const neutral = board[3][0].id;
  const approacher = board[3][4].id;
  northMove([3, 0], [4, 0]);
  northMove([3, 4], [4, 4]);
  assert.deepStrictEqual(tracker.rankOdds(approacher), tracker.rankOdds(neutral));
});

test('the tracker agrees with the real game state throughout random games', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const random = seededRandom(seed);
    const settings = { revealMode: seed % 2 ? 'permanent' : 'oneturn' };
    const gameState = engine.createGame(randomSetup('south', random), randomSetup('north', random));
    const options = [{}, { balanced: true }, { balanced: true, behavior: 3 }][seed % 3];
    const trackers = { south: createTracker(options), north: createTracker(options) };
    const moved = new Set();
    const observeAll = (battle) => {
      for (const c of ['south', 'north']) trackers[c].observe(engine.redactView(gameState, c, settings), battle);
    };
    observeAll(null);

    while (!gameState.gameOver && gameState.ply < 600) {
      const color = gameState.turn;
      const moves = engine.legalMoves(gameState, color);
      const move = moves[Math.floor(random() * moves.length)];
      moved.add(gameState.board[move.from[0]][move.from[1]].id);
      const { battle } = engine.applyMove(gameState, color, move.from, move.to);
      observeAll(battle);

      for (const c of ['south', 'north']) {
        const enemy = c === 'south' ? 'north' : 'south';
        const tracker = trackers[c];
        const truthCounts = Object.fromEntries(ALL_RANKS.map(r => [r, 0]));
        let alive = 0;
        for (const row of gameState.board) for (const piece of row) {
          if (!piece || piece.owner !== enemy) continue;
          alive++;
          truthCounts[piece.rank]++;
          const seen = tracker.piece(piece.id);
          assert.ok(seen, `seed ${seed}: enemy piece ${piece.id} is not tracked`);
          if (seen.rank !== null) assert.strictEqual(seen.rank, piece.rank, `seed ${seed}: wrong rank for ${piece.id}`);
          assert.strictEqual(seen.moved, moved.has(piece.id), `seed ${seed}: wrong moved flag for ${piece.id}`);
          assert.ok(tracker.possibleRanks(piece.id).includes(piece.rank), `seed ${seed}: true rank ruled out for ${piece.id}`);
          assert.ok(tracker.rankOdds(piece.id)[piece.rank] > 0, `seed ${seed}: true rank given zero odds for ${piece.id}`);
        }
        assert.strictEqual(tracker.enemyPieces().length, alive);
        assert.deepStrictEqual(tracker.remaining(), truthCounts);
      }
    }
  }
});

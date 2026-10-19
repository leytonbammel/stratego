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

test('the tracker agrees with the real game state throughout random games', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const random = seededRandom(seed);
    const settings = { revealMode: seed % 2 ? 'permanent' : 'oneturn' };
    const gameState = engine.createGame(randomSetup('south', random), randomSetup('north', random));
    const trackers = { south: createTracker(), north: createTracker() };
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
        }
        assert.strictEqual(tracker.enemyPieces().length, alive);
        assert.deepStrictEqual(tracker.remaining(), truthCounts);
      }
    }
  }
});

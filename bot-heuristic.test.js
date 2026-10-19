const test = require('node:test');
const assert = require('node:assert');
const engine = require('./engine');
const { createBot, seededRandom } = require('./bot');
const { playMatch } = require('./bot-match');

// A sparse position for the heuristic bot playing north. Each piece is
// { r, c, rank, owner, revealed }; revealed enemy pieces show their rank.
function position(pieces) {
  const board = Array(10).fill(null).map(() => Array(10).fill(null));
  let id = 1;
  for (const p of pieces) {
    board[p.r][p.c] = { rank: p.rank, owner: p.owner, revealed: !!p.revealed, revealedPly: 0, id: id++ };
  }
  return {
    board, turn: 'north', phase: 'play', winner: null, reason: null,
    history: { south: [], north: [] }, lastMove: null, gameOver: false, ply: 0, fullReveal: false,
  };
}

function choose(pieces, seed = 1) {
  const gameState = position(pieces);
  const bot = createBot('heuristic', seededRandom(seed));
  const view = engine.redactView(gameState, 'north', {});
  bot.observe(view, null);
  return bot.chooseMove(view, engine.legalMoves(gameState, 'north'));
}

const N = (r, c, rank, revealed) => ({ r, c, rank, owner: 'north', revealed });
const S = (r, c, rank, revealed) => ({ r, c, rank, owner: 'south', revealed });
// Flags and some bombs tucked away so each side has a full-looking back line.
const BACKDROP = [N(0, 0, 'F'), N(0, 1, 'B'), N(1, 0, 'B'), S(9, 9, 'F'), S(9, 8, 'B'), S(8, 9, 'B')];

test('heuristic setup is valid, in board order, with the flag on the back row behind bombs', () => {
  for (const color of ['south', 'north']) {
    for (let seed = 1; seed <= 30; seed++) {
      const placement = createBot('heuristic', seededRandom(seed)).chooseSetup(color);
      assert.deepStrictEqual(engine.validateSetup(placement, color), { ok: true });
      const cells = placement.map(p => p.r * 10 + p.c);
      assert.deepStrictEqual(cells, [...cells].sort((a, b) => a - b));

      const flag = placement.find(p => p.rank === 'F');
      assert.strictEqual(flag.r, color === 'north' ? 0 : 9);
      const bombNextToFlag = placement.some(p =>
        p.rank === 'B' && Math.abs(p.r - flag.r) + Math.abs(p.c - flag.c) === 1);
      assert.ok(bombNextToFlag, `seed ${seed}: flag has no bomb beside it`);
    }
  }
});

test('takes a known enemy piece it outranks', () => {
  const move = choose([...BACKDROP, N(3, 4, 7), S(4, 4, 6, true), N(2, 8, 4), S(7, 2, 5)]);
  assert.deepStrictEqual(move, { from: [3, 4], to: [4, 4] });
});

test('the Spy strikes a known Marshal next to it', () => {
  const move = choose([...BACKDROP, N(3, 4, 1), S(4, 4, 10, true), N(2, 8, 5), S(7, 2, 5)]);
  assert.deepStrictEqual(move, { from: [3, 4], to: [4, 4] });
});

test('moves a revealed piece away from a known stronger enemy', () => {
  // North's revealed Captain sits next to South's revealed General.
  const move = choose([...BACKDROP, N(3, 4, 6, true), S(4, 4, 9, true), N(1, 8, 4), S(8, 2, 5)]);
  assert.deepStrictEqual(move.from, [3, 4]);
  assert.notDeepStrictEqual(move.to, [4, 4], 'should not attack a stronger piece');
});

test('does not throw the Marshal at an unknown piece', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const move = choose([...BACKDROP, N(3, 4, 10), S(4, 4, 'B'), S(6, 0, 4), N(3, 0, 5), N(2, 6, 2)], seed);
    assert.ok(!(move.from[0] === 3 && move.from[1] === 4 && move.to[0] === 4 && move.to[1] === 4),
      `seed ${seed}: Marshal attacked an unknown piece`);
  }
});

test('beats the random bot almost every game', () => {
  const random = seededRandom(42);
  let wins = 0;
  const games = 40;
  for (let i = 0; i < games; i++) {
    // Alternate sides so moving first doesn't flatter either bot.
    const heuristicSouth = i % 2 === 0;
    const h = createBot('heuristic', random);
    const r = createBot('random', random);
    const result = heuristicSouth ? playMatch(h, r) : playMatch(r, h);
    if (result.winner === (heuristicSouth ? 'south' : 'north')) wins++;
  }
  assert.ok(wins >= games * 0.9, `heuristic won only ${wins}/${games}`);
});

test('heuristic vs heuristic games finish or stop at the ply cap', () => {
  const random = seededRandom(5);
  for (let i = 0; i < 3; i++) {
    const result = playMatch(createBot('heuristic', random), createBot('heuristic', random), { plyCap: 2000 });
    assert.ok(result.winner || result.reason === 'ply-cap');
  }
});

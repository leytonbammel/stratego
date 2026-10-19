const test = require('node:test');
const assert = require('node:assert');
const engine = require('./engine');
const { createBot, randomSetup, seededRandom } = require('./bot');
const { playMatch } = require('./bot-match');

test('randomSetup produces a valid placement for both colors', () => {
  for (const color of ['south', 'north']) {
    for (let seed = 1; seed <= 20; seed++) {
      const placement = randomSetup(color, seededRandom(seed));
      assert.deepStrictEqual(engine.validateSetup(placement, color), { ok: true });
    }
  }
});

test('randomSetup lists pieces in board order so piece ids cannot leak ranks', () => {
  // createGame hands out ids in placement order. A placement grouped by rank
  // would let anyone reading ids from the redacted view work out the ranks.
  const placement = randomSetup('north', seededRandom(7));
  const cells = placement.map(p => p.r * 10 + p.c);
  assert.deepStrictEqual(cells, [...cells].sort((a, b) => a - b));
});

test('randomSetup varies with the random source', () => {
  const a = randomSetup('south', seededRandom(1)).map(p => p.rank).join();
  const b = randomSetup('south', seededRandom(2)).map(p => p.rank).join();
  assert.notStrictEqual(a, b);
});

test('random bot picks one of the legal moves it is given', () => {
  const bot = createBot('random', seededRandom(3));
  const moves = [
    { from: [3, 0], to: [4, 0] },
    { from: [3, 1], to: [4, 1] },
    { from: [3, 4], to: [4, 4] },
  ];
  for (let i = 0; i < 20; i++) {
    assert.ok(moves.includes(bot.chooseMove({}, moves)));
  }
});

test('random bot returns null when it has no legal moves', () => {
  const bot = createBot('random', seededRandom(3));
  assert.strictEqual(bot.chooseMove({}, []), null);
});

test('createBot rejects unknown levels', () => {
  assert.throws(() => createBot('grandmaster'), /Unknown bot level/);
});

test('playMatch between random bots ends in a result within the ply cap', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const rng = seededRandom(seed);
    const result = playMatch(createBot('random', rng), createBot('random', rng), { plyCap: 3000 });
    assert.ok(result.plies <= 3000);
    if (result.winner) {
      assert.ok(['south', 'north'].includes(result.winner));
      assert.ok(['flag', 'no-moves'].includes(result.reason));
    } else {
      assert.strictEqual(result.reason, 'ply-cap');
      assert.strictEqual(result.plies, 3000);
    }
  }
});

test('playMatch shows both bots the opening position and every ply', () => {
  const rng = seededRandom(11);
  const seen = { south: 0, north: 0 };
  const watcher = (color) => {
    const inner = createBot('random', rng);
    return {
      chooseSetup: inner.chooseSetup,
      chooseMove: inner.chooseMove,
      observe(view) {
        // Bots only ever get the redacted view: no unrevealed enemy rank.
        for (const row of view.board) for (const cell of row) {
          if (cell && typeof cell === 'object' && !cell.own && !cell.revealed) {
            assert.strictEqual(cell.rank, undefined);
          }
        }
        assert.strictEqual(view.you, color);
        seen[color]++;
      },
    };
  };
  const result = playMatch(watcher('south'), watcher('north'), { plyCap: 200 });
  assert.strictEqual(seen.south, result.plies + 1);
  assert.strictEqual(seen.north, result.plies + 1);
});

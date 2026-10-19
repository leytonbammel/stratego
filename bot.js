// Computer opponents. Like engine.js this is pure, dependency-free logic: a bot
// never touches sockets or the real game state. It only ever receives the same
// redacted view a human client gets, plus its own legal moves, so it can't cheat.
//
// Every bot has the same shape:
//   chooseSetup(color)          -> a 40-piece placement for validateSetup
//   observe(view, battle)       -> called once with the opening position (battle null),
//                                  then after every ply, both sides' moves
//   chooseMove(view, moves)     -> one of `moves`, or null if there are none
const engine = require('./engine');
const { createHeuristicBot, ADVANCED } = require('./bot-heuristic');

// Small deterministic PRNG (mulberry32) so tests and bot-vs-bot runs can be replayed.
function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// Ranks are shuffled across the home rows, but the placement is listed in board
// order. createGame hands out piece ids in placement order, so a list grouped by
// rank would make id 1 the Marshal for anyone reading ids off the redacted view.
function randomSetup(color, random = Math.random) {
  const ranks = [];
  for (const { rank, count } of engine.RANKS) {
    for (let i = 0; i < count; i++) ranks.push(rank);
  }
  shuffle(ranks, random);

  const placement = [];
  for (const r of engine.homeRows(color)) {
    for (let c = 0; c < 10; c++) {
      placement.push({ rank: ranks[placement.length], r, c });
    }
  }
  return placement;
}

function createRandomBot(random) {
  return {
    chooseSetup(color) {
      return randomSetup(color, random);
    },
    observe() {},
    chooseMove(view, moves) {
      if (!moves.length) return null;
      return moves[Math.floor(random() * moves.length)];
    },
  };
}

const LEVELS = {
  random: createRandomBot,
  heuristic: createHeuristicBot,
  advanced: (random) => createHeuristicBot(random, ADVANCED),
};

function createBot(level = 'random', random = Math.random) {
  const make = LEVELS[level];
  if (!make) throw new Error(`Unknown bot level: ${level}`);
  return make(random);
}

module.exports = {
  LEVELS: Object.keys(LEVELS),
  createBot,
  randomSetup,
  seededRandom,
};

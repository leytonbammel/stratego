// Bot-vs-bot matches, played straight on the engine with no server. Used as a
// regression check: each new bot level should beat the previous one.
//
// Run: node bot-match.js [games] [southLevel] [northLevel] [seed]
//   e.g. node bot-match.js 200 random random 1
const engine = require('./engine');
const { createBot, seededRandom } = require('./bot');

// The engine has no draw or move-limit rule, so two passive bots could shuffle
// forever. A game that hits the cap is reported as unfinished.
const DEFAULT_PLY_CAP = 3000;

function playMatch(southBot, northBot, { plyCap = DEFAULT_PLY_CAP, settings = {} } = {}) {
  const bots = { south: southBot, north: northBot };
  const gameState = engine.createGame(southBot.chooseSetup('south'), northBot.chooseSetup('north'));
  for (const c of ['south', 'north']) {
    bots[c].observe(engine.redactView(gameState, c, settings), null);
  }

  while (!gameState.gameOver && gameState.ply < plyCap) {
    const color = gameState.turn;
    const view = engine.redactView(gameState, color, settings);
    const move = bots[color].chooseMove(view, engine.legalMoves(gameState, color));
    if (!move) break; // can't happen: the engine ends the game when a side has no moves

    const { battle } = engine.applyMove(gameState, color, move.from, move.to);
    for (const c of ['south', 'north']) {
      bots[c].observe(engine.redactView(gameState, c, settings), battle);
    }
  }

  return {
    winner: gameState.winner || null,
    reason: gameState.winner ? gameState.reason : 'ply-cap',
    plies: gameState.ply,
  };
}

if (require.main === module) {
  const [games = '100', southLevel = 'random', northLevel = 'random', seed = String(Date.now())] = process.argv.slice(2);
  const random = seededRandom(Number(seed));
  const tally = { south: 0, north: 0, unfinished: 0 };
  const reasons = {};
  let totalPlies = 0;

  for (let i = 0; i < Number(games); i++) {
    const result = playMatch(createBot(southLevel, random), createBot(northLevel, random));
    tally[result.winner || 'unfinished']++;
    reasons[result.reason] = (reasons[result.reason] || 0) + 1;
    totalPlies += result.plies;
  }

  console.log(`${games} games, seed ${seed}: south (${southLevel}) vs north (${northLevel})`);
  console.log(`  south wins:  ${tally.south}`);
  console.log(`  north wins:  ${tally.north}`);
  console.log(`  unfinished:  ${tally.unfinished} (hit the ${DEFAULT_PLY_CAP}-ply cap)`);
  console.log(`  end reasons: ${JSON.stringify(reasons)}`);
  console.log(`  avg plies:   ${Math.round(totalPlies / Number(games))}`);
}

module.exports = { playMatch, DEFAULT_PLY_CAP };

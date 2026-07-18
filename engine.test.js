const test = require('node:test');
const assert = require('node:assert');
const engine = require('./engine');

const {
  RANKS, RANK_NAMES, isLake, homeRows, validateSetup,
  createGame, isLegalMove, legalMoves, applyMove, redactView, checkGameOver
} = engine;

function createValidPlacement(color) {
  const placement = [];
  const rows = homeRows(color);
  let rIdx = 0;
  let cIdx = 0;
  for (const { rank, count } of RANKS) {
    for (let i = 0; i < count; i++) {
      placement.push({ rank, r: rows[rIdx], c: cIdx });
      cIdx++;
      if (cIdx >= 10) {
        cIdx = 0;
        rIdx++;
      }
    }
  }
  return placement;
}

function mockGameState() {
  const board = Array(10).fill(null).map(() => Array(10).fill(null));
  return {
    board,
    turn: "south",
    phase: "play",
    winner: null,
    reason: null,
    history: { south: [], north: [] },
    lastMove: null,
    gameOver: false
  };
}

test('1. validateSetup', (t) => {
  const validSouth = createValidPlacement("south");
  assert.strictEqual(validateSetup(validSouth, "south").ok, true);

  // Wrong counts
  const badCounts = JSON.parse(JSON.stringify(validSouth));
  badCounts[0].rank = 9; // Changed a Marshal to a General
  assert.strictEqual(validateSetup(badCounts, "south").ok, false);

  // Out of home row
  const outOfHome = JSON.parse(JSON.stringify(validSouth));
  outOfHome[0].r = 5;
  assert.strictEqual(validateSetup(outOfHome, "south").ok, false);

  // Duplicate cell
  const dupCell = JSON.parse(JSON.stringify(validSouth));
  dupCell[1].r = dupCell[0].r;
  dupCell[1].c = dupCell[0].c;
  assert.strictEqual(validateSetup(dupCell, "south").ok, false);
});

test('2. Movement', (t) => {
  const state = mockGameState();
  state.board[6][0] = { rank: 6, owner: "south", revealed: false, id: 1 };
  
  // one-step orthogonal ok
  assert.strictEqual(isLegalMove(state, "south", [6, 0], [5, 0]).ok, true);

  // diagonal rejected
  assert.strictEqual(isLegalMove(state, "south", [6, 0], [5, 1]).ok, false);

  // moving into lake rejected
  state.board[5][2] = { rank: 6, owner: "south", revealed: false, id: 2 };
  assert.strictEqual(isLegalMove(state, "south", [5, 2], [4, 2]).ok, false);

  // onto own piece rejected
  state.board[5][0] = { rank: 7, owner: "south", revealed: false, id: 3 };
  assert.strictEqual(isLegalMove(state, "south", [6, 0], [5, 0]).ok, false);
});

test('3. Scout', (t) => {
  const state = mockGameState();
  state.board[9][0] = { rank: 2, owner: "south", revealed: false, id: 1 };

  // long straight move over empty ok
  assert.strictEqual(isLegalMove(state, "south", [9, 0], [2, 0]).ok, true);

  // blocked by intervening piece rejected
  state.board[5][0] = { rank: 6, owner: "south", revealed: false, id: 2 };
  assert.strictEqual(isLegalMove(state, "south", [9, 0], [4, 0]).ok, false);

  // scout attack at distance ok
  state.board[5][0] = { rank: 6, owner: "north", revealed: false, id: 3 };
  assert.strictEqual(isLegalMove(state, "south", [9, 0], [5, 0]).ok, true);
});

test('4. Combat', (t) => {
  const runCombat = (atkRank, defRank) => {
    const state = mockGameState();
    state.board[6][0] = { rank: atkRank, owner: "south", revealed: false, id: 1 };
    state.board[5][0] = { rank: defRank, owner: "north", revealed: false, id: 2 };
    return applyMove(state, "south", [6, 0], [5, 0]);
  };

  // higher beats lower
  const res1 = runCombat(7, 6);
  assert.strictEqual(res1.battle.outcome, "attacker");
  assert.strictEqual(res1.state.board[5][0].rank, 7);

  // equal both die
  const res2 = runCombat(6, 6);
  assert.strictEqual(res2.battle.outcome, "both");
  assert.strictEqual(res2.state.board[5][0], null);
  assert.strictEqual(res2.state.board[6][0], null);

  // Spy(1) vs Marshal(10) - Spy attacking Marshal wins
  const res3 = runCombat(1, 10);
  assert.strictEqual(res3.battle.outcome, "attacker");
  assert.strictEqual(res3.state.board[5][0].rank, 1);

  // Marshal attacking Spy wins
  const state4 = mockGameState();
  state4.board[5][0] = { rank: 10, owner: "south", revealed: false, id: 1 };
  state4.board[6][0] = { rank: 1, owner: "north", revealed: false, id: 2 };
  const res4 = applyMove(state4, "south", [5, 0], [6, 0]);
  assert.strictEqual(res4.battle.outcome, "attacker");
  assert.strictEqual(res4.state.board[6][0].rank, 10);

  // Miner(3) vs Bomb wins/removes bomb
  const res5 = runCombat(3, "B");
  assert.strictEqual(res5.battle.outcome, "attacker");
  assert.strictEqual(res5.state.board[5][0].rank, 3);

  // non-miner vs Bomb -> attacker dies
  const res6 = runCombat(4, "B");
  assert.strictEqual(res6.battle.outcome, "defender");
  assert.strictEqual(res6.state.board[6][0], null);
  assert.strictEqual(res6.state.board[5][0].rank, "B");

  // attacking Flag ends game
  const res7 = runCombat(2, "F");
  assert.strictEqual(res7.battle.outcome, "attacker");
  assert.strictEqual(res7.gameOver, true);
  assert.strictEqual(res7.winner, "south");
  assert.strictEqual(res7.reason, "flag");
});

test('5. redactView', (t) => {
  const state = mockGameState();
  state.board[6][0] = { rank: 5, owner: "south", revealed: false, id: 1 };
  state.board[3][0] = { rank: 6, owner: "north", revealed: false, id: 2 };
  state.board[3][1] = { rank: 7, owner: "north", revealed: true, id: 3 };

  const view = redactView(state, "south");

  // unrevealed enemy cell has no `rank` field
  assert.strictEqual(view.board[3][0].rank, undefined);
  assert.strictEqual(view.board[3][0].own, false);
  assert.strictEqual(view.board[3][0].revealed, false);

  // revealed enemy cell includes `rank`
  assert.strictEqual(view.board[3][1].rank, 7);
  assert.strictEqual(view.board[3][1].revealed, true);

  // own cells include rank
  assert.strictEqual(view.board[6][0].rank, 5);
  assert.strictEqual(view.board[6][0].own, true);
  
  // lakes are "lake"
  assert.strictEqual(view.board[4][2], "lake");
  // empty cells are null
  assert.strictEqual(view.board[4][0], null);
});

test('6. Two-squares rule', (t) => {
  const state = mockGameState();
  state.board[6][0] = { rank: 5, owner: "south", revealed: false, id: 1 };
  
  applyMove(state, "south", [6, 0], [5, 0]); // south moves
  
  state.board[3][0] = { rank: 5, owner: "north", revealed: false, id: 2 };
  applyMove(state, "north", [3, 0], [2, 0]); // north moves
  
  applyMove(state, "south", [5, 0], [6, 0]); // south moves back
  applyMove(state, "north", [2, 0], [3, 0]); // north moves back
  
  // South attempts 3rd repetition: 6,0 -> 5,0 again.
  const res = isLegalMove(state, "south", [6, 0], [5, 0]);
  assert.strictEqual(res.ok, false);
});

test('7. checkGameOver', (t) => {
  const state = mockGameState();
  // South has only a Bomb and a Flag
  state.board[6][0] = { rank: "B", owner: "south", revealed: false, id: 1 };
  state.board[6][1] = { rank: "F", owner: "south", revealed: false, id: 2 };
  // North has a piece
  state.board[0][0] = { rank: 5, owner: "north", revealed: false, id: 3 };

  state.turn = "south";
  const gameOverStatus = checkGameOver(state);
  assert.strictEqual(gameOverStatus.over, true);
  assert.strictEqual(gameOverStatus.winner, "north");
  assert.strictEqual(gameOverStatus.reason, "no-moves");
});

const RANKS = [
  { rank: 10, name: 'Marshal', count: 1 },
  { rank: 9, name: 'General', count: 1 },
  { rank: 8, name: 'Colonel', count: 2 },
  { rank: 7, name: 'Major', count: 3 },
  { rank: 6, name: 'Captain', count: 4 },
  { rank: 5, name: 'Lieutenant', count: 4 },
  { rank: 4, name: 'Sergeant', count: 4 },
  { rank: 3, name: 'Miner', count: 5 },
  { rank: 2, name: 'Scout', count: 8 },
  { rank: 1, name: 'Spy', count: 1 },
  { rank: 'B', name: 'Bomb', count: 6 },
  { rank: 'F', name: 'Flag', count: 1 },
];

const RANK_NAMES = {
  10: "Marshal",
  9: "General",
  8: "Colonel",
  7: "Major",
  6: "Captain",
  5: "Lieutenant",
  4: "Sergeant",
  3: "Miner",
  2: "Scout",
  1: "Spy",
  "B": "Bomb",
  "F": "Flag"
};

function isLake(r, c) {
  return (r === 4 || r === 5) && ((c === 2 || c === 3) || (c === 6 || c === 7));
}

function homeRows(color) {
  return color === "north" ? [0, 1, 2, 3] : [6, 7, 8, 9];
}

function validateSetup(placement, color) {
  if (!Array.isArray(placement)) return { ok: false, error: "Placement must be an array" };
  if (placement.length !== 40) return { ok: false, error: "Must place exactly 40 pieces" };

  const expectedCounts = {};
  for (const r of RANKS) expectedCounts[r.rank] = r.count;

  const actualCounts = {};
  const seenCells = new Set();
  const validRows = new Set(homeRows(color));

  for (const p of placement) {
    const { rank, r, c } = p;
    if (r === undefined || c === undefined || rank === undefined) {
      return { ok: false, error: "Invalid piece format" };
    }
    if (r < 0 || r > 9 || c < 0 || c > 9) return { ok: false, error: "Out of bounds" };
    if (!validRows.has(r)) return { ok: false, error: "Out of home rows" };
    if (isLake(r, c)) return { ok: false, error: "Cannot place in lake" };
    const cellKey = `${r},${c}`;
    if (seenCells.has(cellKey)) return { ok: false, error: "Duplicate cell" };
    seenCells.add(cellKey);
    actualCounts[rank] = (actualCounts[rank] || 0) + 1;
  }

  for (const r of RANKS) {
    if ((actualCounts[r.rank] || 0) !== r.count) {
      return { ok: false, error: `Incorrect count for rank ${r.rank}` };
    }
  }

  return { ok: true };
}

function createGame(setupSouth, setupNorth) {
  const board = Array(10).fill(null).map(() => Array(10).fill(null));
  let idCounter = 1;

  for (const p of setupSouth) {
    board[p.r][p.c] = { rank: p.rank, owner: "south", revealed: false, id: idCounter++ };
  }
  for (const p of setupNorth) {
    board[p.r][p.c] = { rank: p.rank, owner: "north", revealed: false, id: idCounter++ };
  }

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

function isLegalMove(gameState, color, from, to) {
  if (gameState.phase !== "play") return { ok: false, error: "Game is not in play phase" };
  if (gameState.turn !== color) return { ok: false, error: "Not your turn" };

  const [fr, fc] = from;
  const [tr, tc] = to;

  if (fr < 0 || fr > 9 || fc < 0 || fc > 9) return { ok: false, error: "From out of bounds" };
  if (tr < 0 || tr > 9 || tc < 0 || tc > 9) return { ok: false, error: "To out of bounds" };
  if (fr === tr && fc === tc) return { ok: false, error: "Must move to a different square" };

  const piece = gameState.board[fr][fc];
  if (!piece) return { ok: false, error: "No piece at from square" };
  if (piece.owner !== color) return { ok: false, error: "Not your piece" };
  if (piece.rank === "B" || piece.rank === "F") return { ok: false, error: "Bomb and Flag cannot move" };
  if (isLake(tr, tc)) return { ok: false, error: "Cannot move into lake" };

  const target = gameState.board[tr][tc];
  if (target && target.owner === color) return { ok: false, error: "Cannot move onto your own piece" };

  if (fr !== tr && fc !== tc) return { ok: false, error: "Must move orthogonally" };

  if (piece.rank === 2) {
    const dr = Math.sign(tr - fr);
    const dc = Math.sign(tc - fc);
    let cr = fr + dr;
    let cc = fc + dc;
    while (cr !== tr || cc !== tc) {
      if (isLake(cr, cc)) return { ok: false, error: "Path blocked by lake" };
      if (gameState.board[cr][cc]) return { ok: false, error: "Path blocked by piece" };
      cr += dr;
      cc += dc;
    }
  } else {
    if (Math.abs(fr - tr) + Math.abs(fc - tc) !== 1) {
      return { ok: false, error: "Must move exactly 1 square" };
    }
  }

  const hist = gameState.history[color];
  if (hist.length >= 2) {
    const last = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    if (
      last.to[0] === fr && last.to[1] === fc && last.from[0] === tr && last.from[1] === tc &&
      prev.from[0] === fr && prev.from[1] === fc && prev.to[0] === tr && prev.to[1] === tc
    ) {
      return { ok: false, error: "Two-squares rule: cannot oscillate" };
    }
  }

  return { ok: true };
}

function legalMoves(gameState, color) {
  const moves = [];
  if (gameState.phase !== "play" || gameState.turn !== color) return moves;

  for (let fr = 0; fr < 10; fr++) {
    for (let fc = 0; fc < 10; fc++) {
      const piece = gameState.board[fr][fc];
      if (piece && piece.owner === color && piece.rank !== "B" && piece.rank !== "F") {
        const from = [fr, fc];
        if (piece.rank === 2) {
          const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
          for (const [dr, dc] of dirs) {
            let tr = fr + dr;
            let tc = fc + dc;
            while (tr >= 0 && tr <= 9 && tc >= 0 && tc <= 9) {
              if (isLegalMove(gameState, color, from, [tr, tc]).ok) {
                moves.push({ from, to: [tr, tc] });
              }
              if (gameState.board[tr][tc] || isLake(tr, tc)) break;
              tr += dr;
              tc += dc;
            }
          }
        } else {
          const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
          for (const [dr, dc] of dirs) {
            const tr = fr + dr;
            const tc = fc + dc;
            if (tr >= 0 && tr <= 9 && tc >= 0 && tc <= 9) {
              if (isLegalMove(gameState, color, from, [tr, tc]).ok) {
                moves.push({ from, to: [tr, tc] });
              }
            }
          }
        }
      }
    }
  }
  return moves;
}

function checkGameOver(gameState) {
  if (gameState.phase === "gameover" || gameState.winner) {
    return { over: true, winner: gameState.winner, reason: gameState.reason };
  }
  const moves = legalMoves(gameState, gameState.turn);
  if (moves.length === 0) {
    return { over: true, winner: gameState.turn === "south" ? "north" : "south", reason: "no-moves" };
  }
  return { over: false };
}

function applyMove(gameState, color, from, to) {
  const legal = isLegalMove(gameState, color, from, to);
  if (!legal.ok) return { state: gameState, battle: null, gameOver: false, winner: null, reason: null };

  const [fr, fc] = from;
  const [tr, tc] = to;
  const attacker = gameState.board[fr][fc];
  const defender = gameState.board[tr][tc];

  gameState.lastMove = { from, to, color };
  gameState.history[color].push({ from, to });
  
  let battle = null;

  if (!defender) {
    gameState.board[tr][tc] = attacker;
    gameState.board[fr][fc] = null;
  } else {
    attacker.revealed = true;
    defender.revealed = true;

    let outcome;
    let defenderDied = false;
    let attackerDied = false;

    if (defender.rank === "F") {
      outcome = "attacker";
      defenderDied = true;
      gameState.winner = color;
      gameState.reason = "flag";
      gameState.gameOver = true;
    } else if (defender.rank === "B") {
      if (attacker.rank === 3) {
        outcome = "attacker";
        defenderDied = true;
      } else {
        outcome = "defender";
        attackerDied = true;
      }
    } else {
      if (attacker.rank === 1 && defender.rank === 10) {
        outcome = "attacker";
        defenderDied = true;
      } else if (attacker.rank > defender.rank) {
        outcome = "attacker";
        defenderDied = true;
      } else if (attacker.rank < defender.rank) {
        outcome = "defender";
        attackerDied = true;
      } else {
        outcome = "both";
        attackerDied = true;
        defenderDied = true;
      }
    }

    battle = {
      from, to,
      attacker: { rank: attacker.rank, owner: attacker.owner },
      defender: { rank: defender.rank, owner: defender.owner },
      outcome
    };

    if (defenderDied && !attackerDied) {
      gameState.board[tr][tc] = attacker;
      gameState.board[fr][fc] = null;
    } else if (!defenderDied && attackerDied) {
      gameState.board[fr][fc] = null;
    } else if (defenderDied && attackerDied) {
      gameState.board[fr][fc] = null;
      gameState.board[tr][tc] = null;
    }
  }

  if (!gameState.gameOver) {
    gameState.turn = color === "south" ? "north" : "south";
    const overCheck = checkGameOver(gameState);
    if (overCheck.over) {
      gameState.gameOver = true;
      gameState.winner = overCheck.winner;
      gameState.reason = overCheck.reason;
    }
  }

  if (gameState.gameOver) {
    gameState.phase = "gameover";
  }

  return {
    state: gameState,
    battle,
    gameOver: gameState.gameOver,
    winner: gameState.winner || null,
    reason: gameState.reason || null
  };
}

function redactView(gameState, color) {
  const board = [];
  for (let r = 0; r < 10; r++) {
    const row = [];
    for (let c = 0; c < 10; c++) {
      if (isLake(r, c)) {
        row.push("lake");
      } else {
        const piece = gameState.board[r][c];
        if (!piece) {
          row.push(null);
        } else {
          if (piece.owner === color) {
            row.push({ own: true, rank: piece.rank, revealed: piece.revealed, id: piece.id });
          } else {
            const redactedPiece = { own: false, revealed: piece.revealed, id: piece.id };
            if (piece.revealed) {
              redactedPiece.rank = piece.rank;
            }
            row.push(redactedPiece);
          }
        }
      }
    }
    board.push(row);
  }

  return {
    you: color,
    turn: gameState.turn,
    phase: gameState.phase,
    winner: gameState.winner || null,
    reason: gameState.reason || null,
    lastMove: gameState.lastMove,
    board
  };
}

module.exports = {
  RANKS,
  RANK_NAMES,
  isLake,
  homeRows,
  validateSetup,
  createGame,
  isLegalMove,
  legalMoves,
  applyMove,
  redactView,
  checkGameOver
};

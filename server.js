const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const engine = require('./engine');
const bots = require('./bot');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 4300;

// no-store so browsers never serve a stale client after an update
app.use(express.static('public', {
  etag: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

const rooms = new Map();

// Room codes are drawn from an unambiguous uppercase alphabet, so accept whatever
// the player typed — any case, with stray spaces or punctuation from a phone
// keyboard's autocorrect — and normalize it to the canonical form.
function normalizeRoomCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Room rules chosen by the host when the room is created.
//   revealMode 'permanent' — a piece that has fought stays face-up for the rest
//                            of the game (standard behaviour).
//   revealMode 'oneturn'   — it is only shown to the opponent for their single
//                            next turn, then goes dark again.
const DEFAULT_SETTINGS = { revealMode: 'permanent' };
const REVEAL_MODES = ['permanent', 'oneturn'];

function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (raw && REVEAL_MODES.includes(raw.revealMode)) s.revealMode = raw.revealMode;
  return s;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

function generateToken() {
  return crypto.randomUUID();
}

function sendTo(ws, message) {
  if (ws && ws.readyState === 1) { // 1 = OPEN
    ws.send(JSON.stringify(message));
  }
}

// Deliver to any socket that is actually open. We deliberately do NOT gate on the
// `connected` bookkeeping flag: if a player's socket is open they must receive the
// game, even if our bookkeeping is momentarily wrong. `connected` drives the
// "opponent dropped" banner only.
function broadcastToRoom(room, message) {
  const msgStr = JSON.stringify(message);
  ['south', 'north'].forEach(color => {
    const p = room.players[color];
    if (p && p.ws && p.ws.readyState === 1) {
      p.ws.send(msgStr);
    }
  });
}

// Both sides of a battle are always revealed to both players, so the capture
// log is public information — safe to send verbatim to either client.
function stateMessage(room, color) {
  return {
    type: 'state',
    view: engine.redactView(room.gameState, color, room.settings),
    captured: room.captured || []
  };
}

function sendStateToBoth(room) {
  if (!room.gameState) return;
  ['south', 'north'].forEach(color => {
    const p = room.players[color];
    if (p) sendTo(p.ws, stateMessage(room, color)); // sendTo already checks readyState
  });
}

// A battle removes the loser(s); record them in the order they fell.
function recordCaptures(room, battle) {
  if (!battle) return;
  if (battle.outcome === 'attacker' || battle.outcome === 'both') {
    room.captured.push({ rank: battle.defender.rank, owner: battle.defender.owner });
  }
  if (battle.outcome === 'defender' || battle.outcome === 'both') {
    room.captured.push({ rank: battle.attacker.rank, owner: battle.attacker.owner });
  }
}

function sendSetupStatus(room) {
  const pSouth = room.players.south;
  const pNorth = room.players.north;
  
  if (pSouth && pSouth.connected) {
    sendTo(pSouth.ws, {
      type: 'setupStatus',
      youReady: pSouth.ready,
      opponentReady: pNorth ? pNorth.ready : false,
      opponentPresent: !!pNorth && pNorth.connected,
      opponentIsBot: !!(pNorth && pNorth.bot)
    });
  }
  if (pNorth && pNorth.connected) {
    sendTo(pNorth.ws, {
      type: 'setupStatus',
      youReady: pNorth.ready,
      opponentReady: pSouth ? pSouth.ready : false,
      opponentPresent: !!pSouth && pSouth.connected,
      opponentIsBot: !!(pSouth && pSouth.bot)
    });
  }
}

// Once the game is over there is nothing left to hide, so flip every piece face-up
// and push the state again. This is what lets both players review the final board.
function revealAllAndSend(room) {
  if (!room.gameState) return;
  // Overrides any per-turn reveal expiry — the review board shows everything.
  room.gameState.fullReveal = true;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const piece = room.gameState.board[r][c];
      if (piece) piece.revealed = true;
    }
  }
  sendStateToBoth(room);
}

function setPhase(room, phase) {
  room.phase = phase;
  if (room.gameState) room.gameState.phase = phase;
  broadcastToRoom(room, { type: 'phase', phase });
}

function opponentOf(color) {
  return color === 'south' ? 'north' : 'south';
}

// The one path every move takes, whether it came from a socket or a bot.
function handleMove(room, color, from, to) {
  if (room.phase !== 'play') return { ok: false, error: 'Not in play phase.' };
  if (room.gameState.turn !== color) return { ok: false, error: 'Not your turn.' };

  const legality = engine.isLegalMove(room.gameState, color, from, to);
  if (!legality.ok) return { ok: false, error: legality.error || 'Illegal move.' };

  const result = engine.applyMove(room.gameState, color, from, to);
  if (result.state) {
    room.gameState = result.state;
  }

  recordCaptures(room, result.battle);
  notifyBots(room, result.battle);

  sendStateToBoth(room);

  if (result.battle) {
    broadcastToRoom(room, { type: 'battle', battle: result.battle });
  }

  if (result.gameOver) {
    setPhase(room, 'gameover');
    revealAllAndSend(room);
    broadcastToRoom(room, { type: 'gameover', winner: result.winner, reason: result.reason });
  } else {
    const go = engine.checkGameOver(room.gameState);
    if (go && go.over) {
      setPhase(room, 'gameover');
      revealAllAndSend(room);
      broadcastToRoom(room, { type: 'gameover', winner: go.winner, reason: go.reason });
    } else {
      scheduleBotMove(room);
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------- bots */

const DEFAULT_BOT_LEVEL = 'advanced';

// A bot seat looks like a player seat, with `bot` holding the bot itself and no
// socket. It counts as connected, so the human sees an opponent who is present;
// anything that reacts to a seat's socket must skip it via `p.bot`.
function createBotSeat(level) {
  return {
    token: generateToken(), // never sent anywhere, so the seat can't be claimed by reconnect
    ws: null,
    connected: true,
    placement: null,
    ready: false,
    wantsRematch: false,
    botLevel: level,
    bot: bots.createBot(level),
  };
}

// Called at the start of every game. Each game gets a fresh bot, so nothing the
// bot remembered about the last game carries over into a rematch.
function readyBots(room) {
  ['south', 'north'].forEach(color => {
    const p = room.players[color];
    if (p && p.bot) {
      p.bot = bots.createBot(p.botLevel);
      p.placement = p.bot.chooseSetup(color);
      p.ready = true;
    }
  });
}

// Bots learn about each ply the same way humans do: through the redacted view.
function notifyBots(room, battle) {
  ['south', 'north'].forEach(color => {
    const p = room.players[color];
    if (p && p.bot) p.bot.observe(engine.redactView(room.gameState, color, room.settings), battle);
  });
}

// A short pause before each bot move so it feels like an opponent, not a reflex.
// Tests set BOT_THINK_MS to keep things fast.
function botThinkMs() {
  if (process.env.BOT_THINK_MS !== undefined) return Number(process.env.BOT_THINK_MS);
  return 500 + Math.random() * 500;
}

function scheduleBotMove(room) {
  if (room.phase !== 'play' || !room.gameState) return;
  const color = room.gameState.turn;
  const p = room.players[color];
  if (!p || !p.bot) return;

  const game = room.gameState;
  const ply = game.ply;
  setTimeout(() => {
    // While the bot was thinking the room may have closed, the human may have
    // resigned, or a rematch may have started. Only move in the exact position
    // the bot was asked about.
    if (rooms.get(room.code) !== room || room.gameState !== game) return;
    if (room.phase !== 'play' || game.ply !== ply || game.turn !== color) return;

    const view = engine.redactView(game, color, room.settings);
    const move = p.bot.chooseMove(view, engine.legalMoves(game, color));
    if (move) handleMove(room, color, move.from, move.to);
  }, botThinkMs());
}

// Both seats are ready once the human readies up, since bots are ready at once.
function startGameIfReady(room) {
  const s = room.players.south;
  const n = room.players.north;
  if (!(s && s.ready && n && n.ready)) return;
  room.gameState = engine.createGame(s.placement, n.placement);
  notifyBots(room, null); // let bots see the opening position before anyone moves
  setPhase(room, 'play');
  sendStateToBoth(room);
  scheduleBotMove(room);
}

wss.on('connection', (ws) => {
  let wsRoomCode = null;
  let wsColor = null;

  // Heartbeat bookkeeping — see the sweep below.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (messageRaw) => {
    let msg;
    try {
      msg = JSON.parse(messageRaw);
    } catch (e) {
      return;
    }

    const { type } = msg;

    // Application-level heartbeat. Protocol ping frames keep the connection warm
    // through proxies, but a browser can't observe them, so the client needs its
    // own round trip to tell "quiet game" apart from "dead socket".
    if (type === 'ping') {
      return sendTo(ws, { type: 'pong' });
    }

    if (type === 'create') {
      const code = generateRoomCode();
      const token = generateToken();
      const room = {
        code,
        players: {
          south: { token, ws, connected: true, placement: null, ready: false, wantsRematch: false },
          north: null
        },
        gameState: null,
        chat: [],
        captured: [],
        settings: sanitizeSettings(msg.settings),
        phase: 'waiting',
        lastActivity: Date.now()
      };
      rooms.set(code, room);
      wsRoomCode = code;
      wsColor = 'south';

      // "Play vs Computer": the bot takes the north seat and is ready at once,
      // so the room skips waiting and goes straight to setup.
      const vsBot = !!msg.vsBot;
      if (vsBot) {
        const level = bots.LEVELS.includes(msg.botLevel) ? msg.botLevel : DEFAULT_BOT_LEVEL;
        room.players.north = createBotSeat(level);
        readyBots(room);
      }

      sendTo(ws, { type: 'created', roomCode: code, color: 'south', token, vsBot });
      sendTo(ws, { type: 'settings', settings: room.settings });
      if (vsBot) {
        setPhase(room, 'setup');
        sendSetupStatus(room);
      } else {
        sendTo(ws, { type: 'phase', phase: 'waiting' });
      }
      return;
    }

    if (type === 'join') {
      const code = normalizeRoomCode(msg.roomCode);
      const room = rooms.get(code);
      if (!room) {
        return sendTo(ws, { type: 'error', message: 'Room not found.' });
      }
      if (room.players.north) {
        return sendTo(ws, { type: 'error', message: 'Room is full.' });
      }
      
      const token = generateToken();
      room.players.north = { token, ws, connected: true, placement: null, ready: false, wantsRematch: false };
      wsRoomCode = code;
      wsColor = 'north';
      room.lastActivity = Date.now();
      
      sendTo(ws, { type: 'joined', roomCode: code, color: 'north', token });
      sendTo(ws, { type: 'settings', settings: room.settings });

      const pSouth = room.players.south;
      if (pSouth && pSouth.connected) {
        sendTo(pSouth.ws, { type: 'opponent', status: 'joined' });
      }
      
      setPhase(room, 'setup');
      sendSetupStatus(room);
      return;
    }

    if (type === 'reconnect') {
      const code = normalizeRoomCode(msg.roomCode);
      const token = msg.token;
      const room = rooms.get(code);
      if (!room) {
        return sendTo(ws, { type: 'error', message: 'Room not found.' });
      }
      
      let color = null;
      if (room.players.south && room.players.south.token === token) color = 'south';
      else if (room.players.north && room.players.north.token === token) color = 'north';
      
      if (!color) {
        return sendTo(ws, { type: 'error', message: 'Invalid token.' });
      }
      
      const p = room.players[color];
      // Retire the socket this one replaces, so we never leave an orphan open.
      // Its close handler is a no-op now that p.ws points elsewhere.
      const previous = p.ws;
      p.ws = ws;
      p.connected = true;
      if (previous && previous !== ws && previous.readyState === 1) {
        previous.close(1000, 'superseded by reconnect');
      }
      wsRoomCode = code;
      wsColor = color;
      room.lastActivity = Date.now();

      const oppColor = color === 'south' ? 'north' : 'south';
      const opp = room.players[oppColor];
      if (opp && opp.connected) {
        sendTo(opp.ws, { type: 'opponent', status: 'reconnected' });
      }
      // Tell the returning player where their opponent stands, so a player who
      // reloads mid-game isn't left guessing whether the other side is still there.
      sendTo(ws, { type: 'opponent', status: opp && opp.connected ? 'reconnected' : 'left', quiet: true });

      sendTo(ws, { type: 'settings', settings: room.settings });
      sendTo(ws, { type: 'phase', phase: room.phase });
      if (room.phase === 'setup' || room.phase === 'waiting') {
        sendSetupStatus(room);
      } else if (room.gameState) {
        sendTo(ws, stateMessage(room, color));
      }
      
      return;
    }

    if (!wsRoomCode || !wsColor) return;
    const room = rooms.get(wsRoomCode);
    if (!room) return;
    room.lastActivity = Date.now();
    const player = room.players[wsColor];
    if (!player) return;

    if (type === 'setup') {
      if (room.phase !== 'setup') {
        return sendTo(ws, { type: 'error', message: 'Not in setup phase.' });
      }
      const placement = msg.placement;
      const validation = engine.validateSetup(placement, wsColor);
      if (!validation.ok) {
        return sendTo(ws, { type: 'error', message: validation.error || 'Invalid setup.' });
      }
      player.placement = placement;
      player.ready = true;
      
      sendSetupStatus(room);
      startGameIfReady(room);
      return;
    }

    if (type === 'move') {
      const outcome = handleMove(room, wsColor, msg.from, msg.to);
      if (!outcome.ok) {
        return sendTo(ws, { type: 'error', message: outcome.error });
      }
      return;
    }

    // The host may still adjust the rules while the room is being set up; once
    // pieces are moving the rules are locked for the rest of the game.
    if (type === 'settings') {
      if (wsColor !== 'south') {
        return sendTo(ws, { type: 'error', message: 'Only the host can change the rules.' });
      }
      if (room.phase !== 'waiting' && room.phase !== 'setup') {
        return sendTo(ws, { type: 'error', message: 'Rules are locked once the game starts.' });
      }
      room.settings = sanitizeSettings(msg.settings);
      broadcastToRoom(room, { type: 'settings', settings: room.settings });
      return;
    }

    if (type === 'chat') {
      const text = msg.text;
      if (typeof text !== 'string') return;
      room.chat.push({ fromColor: wsColor, text });
      
      const oppColor = wsColor === 'south' ? 'north' : 'south';
      const opp = room.players[oppColor];
      
      sendTo(ws, { type: 'chat', from: 'you', text });
      if (opp && opp.connected) {
        sendTo(opp.ws, { type: 'chat', from: 'opponent', text });
      }
      return;
    }

    if (type === 'resign') {
      if (room.phase !== 'play') return;
      setPhase(room, 'gameover');
      revealAllAndSend(room);
      const oppColor = wsColor === 'south' ? 'north' : 'south';
      broadcastToRoom(room, { type: 'gameover', winner: oppColor, reason: 'resign' });
      return;
    }

    if (type === 'endRoom') {
      // Only the host (south, the creator) may close the room.
      if (wsColor !== 'south') {
        return sendTo(ws, { type: 'error', message: 'Only the host can close the room.' });
      }
      broadcastToRoom(room, { type: 'roomClosed' });
      rooms.delete(room.code);
      ['south', 'north'].forEach(color => {
        const p = room.players[color];
        if (p && p.ws) {
          p.connected = false;
          p.ws.close(1000, 'room closed');
        }
      });
      return;
    }

    if (type === 'rematch') {
      if (room.phase !== 'gameover') return;
      player.ready = false;
      player.placement = null;
      player.wantsRematch = true;
      
      const oppColor = wsColor === 'south' ? 'north' : 'south';
      const opp = room.players[oppColor];
      // A bot always agrees to a rematch and sets up again straight away.
      if (opp && (opp.wantsRematch || opp.bot)) {
        player.wantsRematch = false;
        opp.wantsRematch = false;
        room.gameState = null;
        room.captured = [];
        if (opp.bot) readyBots(room);
        setPhase(room, 'setup');
        sendSetupStatus(room);
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!wsRoomCode || !wsColor) return;
    const room = rooms.get(wsRoomCode);
    if (!room) return;

    const player = room.players[wsColor];
    if (!player) return;

    // A socket that has already been superseded by a reconnect must NOT mark the
    // player offline. When a network blips, the client notices within milliseconds
    // and reconnects on a fresh socket, but the OS can take many seconds to report
    // the old half-open socket as closed — so this handler routinely runs *after*
    // the player is already back. Without this guard the late close silently muted
    // a live player (no state, no moves, no chat) until they reloaded the page.
    if (player.ws !== ws) return;

    player.connected = false;

    const oppColor = wsColor === 'south' ? 'north' : 'south';
    const opp = room.players[oppColor];
    if (opp && opp.connected) {
      sendTo(opp.ws, { type: 'opponent', status: 'left' });
    }
    // During setup the other player must not be able to hit Ready into an empty room.
    if (room.phase === 'setup' || room.phase === 'waiting') {
      sendSetupStatus(room);
    }
  });
});

// Stratego turns can be slow, and a socket with nothing on it gets culled by
// proxies and mobile NAT tables after ~60s. Pinging every 25s keeps the
// connection warm and, just as importantly, detects sockets that have died
// without a FIN — otherwise a player sits on a dead connection believing the
// game is merely quiet.
const HEARTBEAT_MS = 25000;
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate(); // missed two rounds; fires 'close' so the player is marked offline
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    // A bot seat always reads as connected, so only humans count here; otherwise
    // a vs-Computer room would live forever after its player left.
    const s = room.players.south;
    const n = room.players.north;
    const sConn = s && !s.bot && s.connected;
    const nConn = n && !n.bot && n.connected;

    if (!sConn && !nConn) {
      if (now - room.lastActivity > 5 * 60 * 1000) {
        rooms.delete(code);
      }
    }
  }
}, 60000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use by another program.`);
    console.error(`  Start Stratego on a different port, e.g.:  PORT=4400 npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  Stratego Online is running.`);
  console.log(`  Open http://localhost:${PORT} in your browser (and share the room code).\n`);
});

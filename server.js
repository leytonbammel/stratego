const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const engine = require('./engine');

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

function broadcastToRoom(room, message) {
  const msgStr = JSON.stringify(message);
  ['south', 'north'].forEach(color => {
    const p = room.players[color];
    if (p && p.ws && p.connected && p.ws.readyState === 1) {
      p.ws.send(msgStr);
    }
  });
}

function sendStateToBoth(room) {
  if (!room.gameState) return;
  ['south', 'north'].forEach(color => {
    const p = room.players[color];
    if (p && p.connected) {
      const view = engine.redactView(room.gameState, color);
      sendTo(p.ws, { type: 'state', view });
    }
  });
}

function sendSetupStatus(room) {
  const pSouth = room.players.south;
  const pNorth = room.players.north;
  
  if (pSouth && pSouth.connected) {
    sendTo(pSouth.ws, {
      type: 'setupStatus',
      youReady: pSouth.ready,
      opponentReady: pNorth ? pNorth.ready : false,
      opponentPresent: !!pNorth && pNorth.connected
    });
  }
  if (pNorth && pNorth.connected) {
    sendTo(pNorth.ws, {
      type: 'setupStatus',
      youReady: pNorth.ready,
      opponentReady: pSouth ? pSouth.ready : false,
      opponentPresent: !!pSouth && pSouth.connected
    });
  }
}

function setPhase(room, phase) {
  room.phase = phase;
  if (room.gameState) room.gameState.phase = phase;
  broadcastToRoom(room, { type: 'phase', phase });
}

wss.on('connection', (ws) => {
  let wsRoomCode = null;
  let wsColor = null;

  ws.on('message', (messageRaw) => {
    let msg;
    try {
      msg = JSON.parse(messageRaw);
    } catch (e) {
      return;
    }

    const { type } = msg;

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
        phase: 'waiting',
        lastActivity: Date.now()
      };
      rooms.set(code, room);
      wsRoomCode = code;
      wsColor = 'south';
      
      sendTo(ws, { type: 'created', roomCode: code, color: 'south', token });
      sendTo(ws, { type: 'phase', phase: 'waiting' });
      return;
    }

    if (type === 'join') {
      const code = (msg.roomCode || '').toUpperCase();
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
      
      const pSouth = room.players.south;
      if (pSouth && pSouth.connected) {
        sendTo(pSouth.ws, { type: 'opponent', status: 'joined' });
      }
      
      setPhase(room, 'setup');
      sendSetupStatus(room);
      return;
    }

    if (type === 'reconnect') {
      const code = (msg.roomCode || '').toUpperCase();
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
      p.ws = ws;
      p.connected = true;
      wsRoomCode = code;
      wsColor = color;
      room.lastActivity = Date.now();
      
      const oppColor = color === 'south' ? 'north' : 'south';
      const opp = room.players[oppColor];
      if (opp && opp.connected) {
        sendTo(opp.ws, { type: 'opponent', status: 'reconnected' });
      }
      
      sendTo(ws, { type: 'phase', phase: room.phase });
      if (room.phase === 'setup' || room.phase === 'waiting') {
        sendSetupStatus(room);
      } else if (room.gameState) {
        const view = engine.redactView(room.gameState, color);
        sendTo(ws, { type: 'state', view });
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
      
      const oppColor = wsColor === 'south' ? 'north' : 'south';
      const opp = room.players[oppColor];
      
      if (player.ready && opp && opp.ready) {
        room.gameState = engine.createGame(room.players.south.placement, room.players.north.placement);
        setPhase(room, 'play');
        sendStateToBoth(room);
      }
      return;
    }

    if (type === 'move') {
      if (room.phase !== 'play') {
        return sendTo(ws, { type: 'error', message: 'Not in play phase.' });
      }
      if (room.gameState.turn !== wsColor) {
        return sendTo(ws, { type: 'error', message: 'Not your turn.' });
      }
      
      const { from, to } = msg;
      const legality = engine.isLegalMove(room.gameState, wsColor, from, to);
      if (!legality.ok) {
        return sendTo(ws, { type: 'error', message: legality.error || 'Illegal move.' });
      }
      
      const result = engine.applyMove(room.gameState, wsColor, from, to);
      if (result.state) {
        room.gameState = result.state;
      }
      
      sendStateToBoth(room);
      
      if (result.battle) {
        broadcastToRoom(room, { type: 'battle', battle: result.battle });
      }
      
      if (result.gameOver) {
        setPhase(room, 'gameover');
        broadcastToRoom(room, { type: 'gameover', winner: result.winner, reason: result.reason });
      } else {
        const go = engine.checkGameOver(room.gameState);
        if (go && go.over) {
           setPhase(room, 'gameover');
           broadcastToRoom(room, { type: 'gameover', winner: go.winner, reason: go.reason });
        }
      }
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
      const oppColor = wsColor === 'south' ? 'north' : 'south';
      broadcastToRoom(room, { type: 'gameover', winner: oppColor, reason: 'resign' });
      return;
    }

    if (type === 'rematch') {
      if (room.phase !== 'gameover') return;
      player.ready = false;
      player.placement = null;
      player.wantsRematch = true;
      
      const oppColor = wsColor === 'south' ? 'north' : 'south';
      const opp = room.players[oppColor];
      if (opp && opp.wantsRematch) {
        player.wantsRematch = false;
        opp.wantsRematch = false;
        room.gameState = null;
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
    if (player) {
      player.connected = false;
    }
    
    const oppColor = wsColor === 'south' ? 'north' : 'south';
    const opp = room.players[oppColor];
    if (opp && opp.connected) {
      sendTo(opp.ws, { type: 'opponent', status: 'left' });
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const s = room.players.south;
    const n = room.players.north;
    const sConn = s && s.connected;
    const nConn = n && n.connected;
    
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

const wsUrl = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;
let ws = null;
let reconnectBackoff = 1000;
let reconnectTimer = null;
let outbox = [];          // messages queued while the socket isn't OPEN yet
let connReady = false;

// Heartbeat. A WebSocket can die without the browser noticing — the phone sleeps,
// wifi hands over to cellular, a proxy culls an idle connection during a long
// turn — and readyState happily still reports OPEN. Without a round trip of our
// own we'd sit on a dead socket thinking the opponent was just slow.
const HEARTBEAT_MS = 20000;
const PONG_GRACE_MS = 8000;
let heartbeatTimer = null;
let awaitingPong = false;

// Always send through this helper: it sends immediately when the socket is open,
// otherwise queues the message and flushes it once the connection is (re)established.
function send(obj) {
  const data = JSON.stringify(obj);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
    return;
  }
  outbox.push(data);
  setConnStatus(false);
  ensureConnected();
}

function setConnStatus(online) {
  connReady = online;
  const el = document.getElementById('conn-status');
  if (el) {
    el.textContent = online ? '' : 'Connecting to server…';
    el.classList.toggle('hidden', online);
  }
}

let roomCode = localStorage.getItem('roomCode');
let token = localStorage.getItem('token');
let myColor = localStorage.getItem('color');
let phase = 'lobby';
let gameState = null;
let trayCounts = {};
let setupBoard = [];
let selectedTrayRank = null;
let selectedBoardCell = null;
let legalTargets = [];
let opponentPresent = false;
let setupInitialized = false;
let opponentOnline = true;
let capturedList = [];   // [{rank, owner}] in the order pieces fell, from the server

const RANKS = {
  '10': { name: 'Marshal', count: 1 },
  '9': { name: 'General', count: 1 },
  '8': { name: 'Colonel', count: 2 },
  '7': { name: 'Major', count: 3 },
  '6': { name: 'Captain', count: 4 },
  '5': { name: 'Lieutenant', count: 4 },
  '4': { name: 'Sergeant', count: 4 },
  '3': { name: 'Miner', count: 5 },
  '2': { name: 'Scout', count: 8 },
  '1': { name: 'Spy', count: 1 },
  "B": { name: 'Bomb', count: 6 },
  "F": { name: 'Flag', count: 1 }
};
const RANK_ORDER = ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1', 'B', 'F'];

// Display only — internal ranks stay 10-high so every engine comparison is untouched.
// Classic counts up as rank falls (Marshal 1 … Scout 9, Spy S); modern shows the
// internal strength directly (Marshal 10 … Spy 1).
const NUMBERING_LABELS = {
  classic: {
    '10': '1', '9': '2', '8': '3', '7': '4', '6': '5',
    '5': '6', '4': '7', '3': '8', '2': '9', '1': 'S',
    'B': 'B', 'F': 'F'
  },
  modern: {
    '10': '10', '9': '9', '8': '8', '7': '7', '6': '6',
    '5': '5', '4': '4', '3': '3', '2': '2', '1': '1',
    'B': 'B', 'F': 'F'
  }
};

// Which numbering *you* read the board in. Purely cosmetic, so it is a personal
// preference rather than a room rule — the two players may differ.
let numbering = localStorage.getItem('numbering') === 'modern' ? 'modern' : 'classic';

// Room rules. Owned by the host and pushed by the server once a room exists;
// until then this holds the host's remembered preference for the next room.
let roomSettings = {
  revealMode: localStorage.getItem('revealMode') === 'oneturn' ? 'oneturn' : 'permanent'
};

function rankLabel(rank) {
  const key = String(rank);
  return NUMBERING_LABELS[numbering][key] || key;
}

// Modern numbering has one two-character label ("10"); it gets a narrower
// treatment so it still fits the same badge as every other rank.
function rankSpan(rank) {
  const label = rankLabel(rank);
  return `<span class="p-rank${label.length > 1 ? ' wide' : ''}">${label}</span>`;
}

/* ---------------------------------------------------------------- settings */

// Numbering is yours alone; the reveal rule belongs to the room, so only the
// host may set it, and only before pieces start moving.
function canEditRules() {
  const beforePlay = phase === 'lobby' || phase === 'waiting' || phase === 'setup';
  return !roomCode || (myColor === 'south' && beforePlay);
}

function describeNumbering() {
  return numbering === 'modern' ? 'Modern (10 → 1)' : 'Classic (1 → 9, S)';
}

function describeReveal() {
  return roomSettings.revealMode === 'oneturn' ? 'next turn only' : 'rest of the game';
}

function renderRulesSummary() {
  const text = `Numbering: ${describeNumbering()} · Combat reveals: ${describeReveal()}`;
  document.querySelectorAll('.rules-summary').forEach(el => { el.textContent = text; });
}

function syncSettingsForm() {
  document.querySelectorAll('input[name="numbering"]').forEach(i => {
    i.checked = i.value === numbering;
  });

  const editable = canEditRules();
  document.querySelectorAll('input[name="revealMode"]').forEach(i => {
    i.checked = i.value === roomSettings.revealMode;
    i.disabled = !editable;
  });

  const group = document.getElementById('setting-reveal');
  if (group) group.classList.toggle('locked', !editable);

  const note = document.getElementById('reveal-note');
  if (note) {
    if (editable) {
      note.textContent = 'A room rule — applies to both players.';
    } else if (myColor !== 'south') {
      note.textContent = 'Chosen by the host for this room.';
    } else {
      note.textContent = 'Locked once the game is under way.';
    }
  }
  renderRulesSummary();
}

// Re-label everything on screen. Only display strings change; no game state moves.
function applyNumbering(next) {
  numbering = next === 'modern' ? 'modern' : 'classic';
  localStorage.setItem('numbering', numbering);
  if (setupBoard.length) { renderSetupBoard(); renderTray(); }
  if (gameState && (phase === 'play' || phase === 'gameover')) renderPlayBoard();
  renderCaptured();
  renderRulesSummary();
}

function applyRevealMode(mode) {
  roomSettings = { ...roomSettings, revealMode: mode === 'oneturn' ? 'oneturn' : 'permanent' };
  localStorage.setItem('revealMode', roomSettings.revealMode); // default for the next room
  if (roomCode) send({ type: 'settings', settings: roomSettings });
  syncSettingsForm();
}

function openSettings() {
  syncSettingsForm();
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

const screens = ['lobby', 'setup', 'play'];
function showScreen(name) {
  screens.forEach(s => document.getElementById(s + '-screen').classList.remove('active'));
  document.getElementById(name + '-screen').classList.add('active');
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (awaitingPong) {
      // Last ping went unanswered: the socket is dead however OPEN it claims to
      // be. Close it so onclose runs and we reconnect on a fresh one.
      awaitingPong = false;
      ws.close();
      return;
    }
    awaitingPong = true;
    ws.send(JSON.stringify({ type: 'ping' }));
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  awaitingPong = false;
}

function scheduleReconnect() {
  if (reconnectTimer) return; // exactly one attempt in flight, never a pile-up
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initWebSocket();
  }, reconnectBackoff);
  reconnectBackoff = Math.min(reconnectBackoff * 2, 15000);
}

// The single entry point for getting a socket. Opening a second one while the
// first is alive used to be possible, and the loser's later close event would
// take the live player's connection down with it.
function initWebSocket() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const sock = new WebSocket(wsUrl);
  ws = sock;

  sock.onopen = () => {
    if (ws !== sock) return sock.close(); // superseded before it finished opening
    reconnectBackoff = 1000;
    setConnStatus(true);
    startHeartbeat();
    if (token && roomCode) {
      sock.send(JSON.stringify({ type: 'reconnect', roomCode, token }));
    }
    // flush anything the user tried to do before the socket was ready
    const queued = outbox;
    outbox = [];
    queued.forEach((d) => sock.send(d));
  };

  sock.onmessage = (e) => {
    if (ws !== sock) return; // ignore anything from a socket we've moved on from
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      return;
    }
    if (msg.type === 'pong') { awaitingPong = false; return; }
    handleMessage(msg);
  };

  sock.onerror = () => { if (ws === sock) setConnStatus(false); };

  sock.onclose = () => {
    if (ws !== sock) return; // a retired socket closing is expected, not a drop
    stopHeartbeat();
    setConnStatus(false);
    scheduleReconnect();
  };
}

// Called whenever the device may have been asleep or offline. A socket that
// looks OPEN after a wake is often already dead, so prove it with a ping
// instead of trusting readyState.
function ensureConnected() {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    reconnectBackoff = 1000;
    initWebSocket();
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;

  const sock = ws;
  awaitingPong = true;
  try {
    sock.send(JSON.stringify({ type: 'ping' }));
  } catch (err) {
    sock.close();
    return;
  }
  setTimeout(() => {
    if (awaitingPong && ws === sock && sock.readyState === WebSocket.OPEN) sock.close();
  }, PONG_GRACE_MS);
}

// The "Close Room" control belongs to the host (south) only.
function updateHostControls() {
  const isHost = myColor === 'south';
  ['btn-end-room-setup', 'btn-end-room-play'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !isHost);
  });
}

// Persistent "your opponent dropped" banner, shown on both the setup and play screens.
// Cleared as soon as they come back, so it always reflects the live connection.
function setOpponentOnline(online, note) {
  opponentOnline = online;
  ['setup-opponent-status', 'play-opponent-status'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = note || '';
    el.classList.toggle('hidden', online);
  });
}

// Tear down all room state and return to the lobby.
function resetToLobby() {
  localStorage.removeItem('roomCode');
  localStorage.removeItem('token');
  localStorage.removeItem('color');
  roomCode = null;
  token = null;
  myColor = null;
  gameState = null;
  phase = 'lobby';
  opponentPresent = false;
  setupInitialized = false;
  setOpponentOnline(true);
  hideGameOver();
  capturedList = [];
  renderCaptured();
  // Back to your own remembered rule preference for the next room you host.
  roomSettings = {
    revealMode: localStorage.getItem('revealMode') === 'oneturn' ? 'oneturn' : 'permanent'
  };
  syncSettingsForm();
  document.getElementById('join-code').value = '';
  updateHostControls();
  showScreen('lobby');
}

function handleMessage(msg) {
  switch(msg.type) {
    case 'created':
    case 'joined':
      roomCode = msg.roomCode;
      token = msg.token;
      myColor = msg.color;
      localStorage.setItem('roomCode', roomCode);
      localStorage.setItem('token', token);
      localStorage.setItem('color', myColor);
      document.querySelector('#room-code-display span').textContent = roomCode;
      updateHostControls();
      break;
    case 'roomClosed':
      resetToLobby();
      showToast(myColor === 'south' ? 'Room closed.' : 'The host closed the room.');
      break;
    case 'settings':
      if (msg.settings) roomSettings = msg.settings;
      syncSettingsForm();
      break;
    case 'phase':
      phase = msg.phase;
      syncSettingsForm(); // rules lock as soon as play begins
      if (phase === 'waiting' || phase === 'setup') {
        if (!setupInitialized) { initSetup(); setupInitialized = true; }
        capturedList = [];      // fresh board on a rematch
        renderCaptured();
        showScreen('setup');
        document.getElementById('btn-rematch').disabled = false;
        hideGameOver();
        document.querySelector('#room-code-display span').textContent = roomCode;
        if (phase === 'waiting') {
          opponentPresent = false;
          document.getElementById('setup-status').textContent =
            'Room created! Share the code above with your opponent. Waiting for them to join…';
        } else {
          opponentPresent = true;
        }
        checkReady();
      } else if (phase === 'play') {
        setupInitialized = false;
        showScreen('play');
        hideGameOver();
      } else if (phase === 'gameover') {
        // Stay on the play screen so the final board stays visible for review.
        // The result card itself is filled in by the 'gameover' message.
        setupInitialized = false;
        showScreen('play');
      }
      break;
    case 'state':
      gameState = msg.view;
      if (Array.isArray(msg.captured)) {
        capturedList = msg.captured;
        renderCaptured();
      }
      // Keep rendering after the game ends — this is the revealed board players review.
      if (phase === 'play' || phase === 'gameover') {
        renderPlayBoard();
        updateGameStatus();
      }
      break;
    case 'setupStatus':
      if (typeof msg.opponentPresent === 'boolean') {
        opponentPresent = msg.opponentPresent;
        checkReady();
      }
      if (msg.youReady) {
        document.getElementById('setup-status').textContent = msg.opponentReady ? 'Both ready! Starting...' : 'Waiting for opponent...';
      } else {
        document.getElementById('setup-status').textContent =
          msg.opponentIsBot ? 'Playing the computer. Place your pieces!'
          : msg.opponentPresent ? 'Opponent joined. Place your pieces!' : 'Waiting for opponent to join...';
      }
      break;
    case 'battle':
      toastBattle(msg.battle);
      break;
    case 'gameover':
      showGameOver(msg.winner, msg.reason);
      break;
    case 'chat':
      appendChat(msg.from, msg.text);
      break;
    case 'opponent':
      // `quiet` marks the status echo we get on our own reconnect: update the
      // banner, but don't announce news the player didn't just miss.
      if (msg.status === 'left') {
        setOpponentOnline(false, 'Opponent disconnected — waiting for them to reconnect…');
        if (!msg.quiet) showToast('Your opponent disconnected.', true);
      } else {
        setOpponentOnline(true);
        if (!msg.quiet) {
          showToast(msg.status === 'joined' ? 'Opponent joined.' : 'Opponent reconnected.');
        }
      }
      break;
    case 'error':
      showToast(msg.message, true);
      break;
  }
}

function showToast(msg, isError=false) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast' + (isError ? ' error' : '');
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fadeout');
    setTimeout(() => toast.remove(), 500);
  }, 3000);
}

function toastBattle(b) {
  if (!b) return;
  let myRole = b.attacker.owner === myColor ? 'You' : 'Opponent';
  let aName = pieceLabel(b.attacker.rank);
  let dName = pieceLabel(b.defender.rank);
  
  let text = '';
  if (b.outcome === 'attacker') {
    text = `${myRole === 'You' ? 'Your' : "Opponent's"} ${aName} defeated ${myRole === 'You' ? "their" : "your"} ${dName}!`;
  } else if (b.outcome === 'defender') {
    text = `${myRole === 'You' ? 'Your' : "Opponent's"} ${aName} died to ${myRole === 'You' ? "their" : "your"} ${dName}!`;
  } else {
    text = `${aName} and ${dName} both destroyed!`;
  }
  showToast(text);
}

function getRankName(r) {
  if (RANKS[r]) return `${RANKS[r].name}`;
  return String(r);
}

// "Miner (8)" — name plus the symbol shown on the board, so the toast text
// matches what the player is actually looking at.
function pieceLabel(r) {
  return `${getRankName(r)} (${rankLabel(r)})`;
}

function appendChat(from, text) {
  const box = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (from === 'you' ? 'me' : 'them');
  div.textContent = (from === 'you' ? 'You: ' : 'Them: ') + text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

const REASON_TEXT = {
  flag: 'The flag was captured.',
  resign: 'Resignation.',
  nomoves: 'No legal moves remaining.',
  'no-moves': 'No legal moves remaining.'
};

// The result is a side card, not an overlay, so the final board stays fully visible.
function showGameOver(winner, reason) {
  const panel = document.getElementById('gameover-panel');
  const won = winner === myColor;
  panel.classList.remove('hidden');
  panel.classList.toggle('win', won);
  panel.classList.toggle('loss', !won);
  document.getElementById('gameover-title').textContent = won ? 'You Win!' : 'You Lose!';
  document.getElementById('gameover-reason').textContent = REASON_TEXT[reason] || `Reason: ${reason}`;
  document.getElementById('btn-rematch').disabled = false;
  document.getElementById('btn-resign').classList.add('hidden');
  selectedBoardCell = null;
  legalTargets = [];
  if (gameState) renderPlayBoard();
}

function hideGameOver() {
  const panel = document.getElementById('gameover-panel');
  if (panel) panel.classList.add('hidden');
  const resign = document.getElementById('btn-resign');
  if (resign) resign.classList.remove('hidden');
}

// Running log of every piece that has been taken, newest last, split by side.
// Battle results are public knowledge, so nothing here leaks hidden information.
function renderCaptured() {
  const lists = {
    own: document.getElementById('cap-list-own'),
    enemy: document.getElementById('cap-list-enemy')
  };
  if (!lists.own || !lists.enemy) return;

  lists.own.innerHTML = '';
  lists.enemy.innerHTML = '';

  capturedList.forEach((p, i) => {
    const mine = p.owner === myColor;
    const chip = document.createElement('span');
    chip.className = 'cap-chip ' + (mine ? 'own' : 'enemy');
    chip.textContent = rankLabel(p.rank);
    chip.title = `#${i + 1}: ${pieceLabel(p.rank)} — ${mine ? 'yours' : 'theirs'}`;
    (mine ? lists.own : lists.enemy).appendChild(chip);
  });

  ['own', 'enemy'].forEach(side => {
    if (!lists[side].childElementCount) {
      const none = document.createElement('span');
      none.className = 'cap-empty';
      none.textContent = 'None yet';
      lists[side].appendChild(none);
    } else {
      lists[side].scrollTop = lists[side].scrollHeight;
    }
  });
}

function isHomeRow(r) {
  return myColor === 'south' ? r >= 6 : r <= 3;
}

function isLake(r, c) {
  return (r === 4 || r === 5) && (c === 2 || c === 3 || c === 6 || c === 7);
}

function absToScreen(r, c) {
  if (myColor === 'north') return { sr: 9 - r, sc: 9 - c };
  return { sr: r, sc: c };
}

function screenToAbs(sr, sc) {
  if (myColor === 'north') return { r: 9 - sr, c: 9 - sc };
  return { r: sr, c: sc };
}

function initSetup() {
  setupBoard = Array(10).fill(null).map(() => Array(10).fill(null));
  for (let r in RANKS) trayCounts[r] = RANKS[r].count;
  selectedTrayRank = null;
  renderSetupBoard();
  renderTray();
  checkReady();
}

function handleSetupCellClick(sr, sc) {
  let { r, c } = screenToAbs(sr, sc);
  if (!isHomeRow(r)) return;
  
  let existing = setupBoard[r][c];
  if (existing) {
    trayCounts[existing]++;
    setupBoard[r][c] = null;
  }
  
  if (selectedTrayRank && trayCounts[selectedTrayRank] > 0) {
    setupBoard[r][c] = selectedTrayRank;
    trayCounts[selectedTrayRank]--;
    if (trayCounts[selectedTrayRank] === 0) {
      selectedTrayRank = null;
    }
  }
  
  renderSetupBoard();
  renderTray();
  checkReady();
}

function renderSetupBoard() {
  const container = document.getElementById('setup-board');
  container.innerHTML = '';
  
  for (let sr = 0; sr < 10; sr++) {
    for (let sc = 0; sc < 10; sc++) {
      let { r, c } = screenToAbs(sr, sc);
      let cellDiv = document.createElement('div');
      cellDiv.className = 'cell';
      
      if (isLake(r, c)) cellDiv.classList.add('lake');
      if (isHomeRow(r)) cellDiv.classList.add('home-row');
      
      let piece = setupBoard[r][c];
      if (piece) {
        let pDiv = document.createElement('div');
        pDiv.className = 'piece own';
        let shortName = RANKS[piece] ? RANKS[piece].name.substring(0,3) : piece;
        pDiv.innerHTML = `${rankSpan(piece)}<span class="p-name">${shortName}</span>`;
        cellDiv.appendChild(pDiv);
      }
      
      cellDiv.onclick = () => handleSetupCellClick(sr, sc);
      container.appendChild(cellDiv);
    }
  }
}

function renderTray() {
  const tray = document.getElementById('tray');
  tray.innerHTML = '';
  for (let rank of RANK_ORDER) {
    let count = trayCounts[rank];
    let div = document.createElement('div');
    div.className = 'tray-item' + (selectedTrayRank === rank ? ' selected' : '') + (count === 0 ? ' empty' : '');
    div.innerHTML = `
      <div class="tray-piece">
        ${rankSpan(rank)}
      </div>
      <div class="tray-count">x${count}</div>
    `;
    div.onclick = () => {
      if (count > 0) {
        selectedTrayRank = rank;
        renderTray();
      }
    };
    tray.appendChild(div);
  }
}

function checkReady() {
  let placed = 0;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (setupBoard[r][c]) placed++;
    }
  }
  document.getElementById('btn-ready').disabled = placed < 40 || !opponentPresent;
}

function autoFill() {
  let remaining = [];
  for (let rank in trayCounts) {
    for (let i=0; i<trayCounts[rank]; i++) remaining.push(rank);
  }
  remaining.sort(() => Math.random() - 0.5);
  
  for (let r = 0; r < 10; r++) {
    if (isHomeRow(r)) {
      for (let c = 0; c < 10; c++) {
        if (!setupBoard[r][c] && remaining.length > 0) {
          setupBoard[r][c] = remaining.pop();
        }
      }
    }
  }
  for (let rank in trayCounts) trayCounts[rank] = 0;
  selectedTrayRank = null;
  renderSetupBoard();
  renderTray();
  checkReady();
}

function clearSetup() {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (setupBoard[r][c]) {
        trayCounts[setupBoard[r][c]]++;
        setupBoard[r][c] = null;
      }
    }
  }
  selectedTrayRank = null;
  renderSetupBoard();
  renderTray();
  checkReady();
}

function readySetup() {
  let placement = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (setupBoard[r][c]) {
        let rankStr = setupBoard[r][c];
        let rankVal = ['B','F'].includes(rankStr) ? rankStr : parseInt(rankStr, 10);
        placement.push({ rank: rankVal, r, c });
      }
    }
  }
  send({ type: 'setup', placement });
}

function computeLegalTargets(r, c) {
  let targets = [];
  let piece = gameState.board[r][c];
  if (!piece || !piece.own) return [];
  if (piece.rank === 'B' || piece.rank === 'F') return [];
  
  let isScout = String(piece.rank) === '2';
  const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
  
  for (let [dr, dc] of dirs) {
    let nr = r + dr;
    let nc = c + dc;
    if (isScout) {
      while (nr >= 0 && nr < 10 && nc >= 0 && nc < 10 && !isLake(nr, nc)) {
        let tgt = gameState.board[nr][nc];
        if (!tgt || tgt === 'lake') {
          targets.push({r: nr, c: nc});
        } else if (!tgt.own) {
          targets.push({r: nr, c: nc});
          break;
        } else {
          break;
        }
        nr += dr;
        nc += dc;
      }
    } else {
      if (nr >= 0 && nr < 10 && nc >= 0 && nc < 10 && !isLake(nr, nc)) {
        let tgt = gameState.board[nr][nc];
        if (!tgt || tgt === 'lake' || !tgt.own) {
          targets.push({r: nr, c: nc});
        }
      }
    }
  }
  return targets;
}

function renderPlayBoard() {
  const container = document.getElementById('play-board');
  container.innerHTML = '';
  
  for (let sr = 0; sr < 10; sr++) {
    for (let sc = 0; sc < 10; sc++) {
      let { r, c } = screenToAbs(sr, sc);
      let cellData = gameState.board[r][c];
      
      let cellDiv = document.createElement('div');
      cellDiv.className = 'cell';
      
      if (isLake(r, c)) cellDiv.classList.add('lake');
      
      if (cellData && cellData !== 'lake') {
        let pieceDiv = document.createElement('div');
        pieceDiv.className = 'piece ' + (cellData.own ? 'own' : 'enemy');
        // Mark your own pieces whose rank the opponent has already seen. Skipped
        // once the game is over, since the review reveals everything anyway.
        if (cellData.own && cellData.revealed && phase === 'play') {
          pieceDiv.classList.add('revealed-to-enemy');
          pieceDiv.title = 'Your opponent has seen this piece';
        }
        if (cellData.own || cellData.revealed) {
           let rankStr = String(cellData.rank);
           let shortName = RANKS[rankStr] ? RANKS[rankStr].name.substring(0,3) : rankStr;
           pieceDiv.innerHTML = `${rankSpan(rankStr)}<span class="p-name">${shortName}</span>`;
        } else {
           pieceDiv.classList.add('unrevealed');
        }
        if (selectedBoardCell && selectedBoardCell.r === r && selectedBoardCell.c === c) {
          pieceDiv.classList.add('selected');
        }
        cellDiv.appendChild(pieceDiv);
      }
      
      if (selectedBoardCell && legalTargets.some(t => t.r === r && t.c === c)) {
        cellDiv.classList.add('legal-target');
      }
      
      if (gameState.lastMove && ((gameState.lastMove.from[0]===r && gameState.lastMove.from[1]===c) || 
                                 (gameState.lastMove.to[0]===r && gameState.lastMove.to[1]===c))) {
        cellDiv.classList.add('last-move');
      }

      cellDiv.onclick = () => handlePlayCellClick(r, c, cellData);
      container.appendChild(cellDiv);
    }
  }
}

function handlePlayCellClick(r, c, cellData) {
  if (phase !== 'play') return;
  if (gameState.turn !== myColor) return;
  
  if (cellData && cellData !== 'lake' && cellData.own) {
    if (cellData.rank === 'B' || cellData.rank === 'F') return; // Cannot move
    if (selectedBoardCell && selectedBoardCell.r === r && selectedBoardCell.c === c) {
      selectedBoardCell = null;
      legalTargets = [];
    } else {
      selectedBoardCell = {r, c};
      legalTargets = computeLegalTargets(r, c);
    }
    renderPlayBoard();
  } else if (selectedBoardCell) {
    if (legalTargets.some(t => t.r === r && t.c === c)) {
      send({
        type: 'move',
        from: [selectedBoardCell.r, selectedBoardCell.c],
        to: [r, c]
      });
      selectedBoardCell = null;
      legalTargets = [];
      renderPlayBoard();
    } else {
      selectedBoardCell = null;
      legalTargets = [];
      renderPlayBoard();
    }
  }
}

function updateGameStatus() {
  const indicator = document.getElementById('turn-indicator');
  if (phase === 'gameover') {
    indicator.textContent = 'Game over — reviewing board';
    indicator.className = 'their-turn';
  } else if (gameState.turn === myColor) {
    indicator.textContent = "Your Turn";
    indicator.className = "my-turn";
  } else {
    indicator.textContent = "Opponent's Turn";
    indicator.className = "their-turn";
  }
  
  let ownPieces = 0, enemyPieces = 0;
  for (let r=0; r<10; r++) {
    for (let c=0; c<10; c++) {
      let cell = gameState.board[r][c];
      if (cell && cell !== 'lake') {
        if (cell.own) ownPieces++;
        else enemyPieces++;
      }
    }
  }
  document.getElementById('captured-own').textContent = `${ownPieces} left`;
  document.getElementById('captured-enemy').textContent = `${enemyPieces} left`;
}

// Room codes use an unambiguous uppercase alphabet, so accept any case and drop
// the spaces and punctuation a phone keyboard likes to add.
function normalizeRoomCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

document.addEventListener('DOMContentLoaded', () => {
  initWebSocket();
  syncSettingsForm();

  document.getElementById('btn-create').onclick = () => {
    send({ type: 'create', settings: { revealMode: roomSettings.revealMode } });
  };
  document.getElementById('btn-vs-bot').onclick = () => {
    send({ type: 'create', vsBot: true, settings: { revealMode: roomSettings.revealMode } });
  };

  const joinInput = document.getElementById('join-code');
  const doJoin = () => {
    const code = normalizeRoomCode(joinInput.value);
    if (code) send({ type: 'join', roomCode: code });
  };
  document.getElementById('btn-join').onclick = doJoin;
  // Normalize as they type, so the field always shows the code as the server reads it.
  joinInput.addEventListener('input', () => {
    const cleaned = normalizeRoomCode(joinInput.value);
    if (cleaned !== joinInput.value) joinInput.value = cleaned;
  });
  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doJoin(); }
  });

  ['btn-settings-lobby', 'btn-settings-setup', 'btn-settings-play'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.onclick = openSettings;
  });
  document.getElementById('btn-settings-close').onclick = closeSettings;
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') closeSettings(); // click the backdrop to dismiss
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });
  document.querySelectorAll('input[name="numbering"]').forEach(input => {
    input.addEventListener('change', () => { if (input.checked) applyNumbering(input.value); });
  });
  document.querySelectorAll('input[name="revealMode"]').forEach(input => {
    input.addEventListener('change', () => { if (input.checked) applyRevealMode(input.value); });
  });

  // Coming back from a locked phone or a dropped network is exactly when the
  // socket is most likely to be quietly dead — check it rather than wait.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureConnected(); });
  window.addEventListener('online', ensureConnected);
  window.addEventListener('focus', ensureConnected);


  document.getElementById('btn-autofill').onclick = autoFill;
  document.getElementById('btn-clear').onclick = clearSetup;
  document.getElementById('btn-ready').onclick = readySetup;
  
  document.getElementById('btn-resign').onclick = () => {
    if (confirm("Are you sure you want to resign?")) {
      send({ type: 'resign' });
    }
  };
  document.getElementById('btn-rematch').onclick = () => {
    send({ type: 'rematch' });
    document.getElementById('btn-rematch').disabled = true;
  };

  ['btn-end-room-setup', 'btn-end-room-play'].forEach(id => {
    document.getElementById(id).onclick = () => {
      if (confirm("Close this room? This ends the game and disconnects both players.")) {
        send({ type: 'endRoom' });
      }
    };
  });
  
  document.getElementById('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    if (input.value.trim()) {
      send({ type: 'chat', text: input.value.trim() });
      input.value = '';
    }
  };
});

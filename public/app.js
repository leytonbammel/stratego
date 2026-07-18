const wsUrl = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;
let ws;
let reconnectBackoff = 1000;
let outbox = [];          // messages queued while the socket isn't OPEN yet
let connReady = false;

// Always send through this helper: it sends immediately when the socket is open,
// otherwise queues the message and flushes it once the connection is (re)established.
function send(obj) {
  const data = JSON.stringify(obj);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  } else {
    outbox.push(data);
    setConnStatus(false);
    // if the socket is fully closed, kick off a fresh connection right away
    if (!ws || ws.readyState === WebSocket.CLOSED) initWebSocket();
  }
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

const screens = ['lobby', 'setup', 'play'];
function showScreen(name) {
  screens.forEach(s => document.getElementById(s + '-screen').classList.remove('active'));
  document.getElementById(name + '-screen').classList.add('active');
}

function initWebSocket() {
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    reconnectBackoff = 1000;
    setConnStatus(true);
    if (token && roomCode) {
      ws.send(JSON.stringify({ type: 'reconnect', roomCode, token }));
    }
    // flush anything the user tried to do before the socket was ready
    const queued = outbox;
    outbox = [];
    queued.forEach((d) => ws.send(d));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onerror = () => setConnStatus(false);

  ws.onclose = () => {
    setConnStatus(false);
    setTimeout(initWebSocket, reconnectBackoff);
    reconnectBackoff = Math.min(reconnectBackoff * 2, 30000);
  };
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
      break;
    case 'phase':
      phase = msg.phase;
      if (phase === 'waiting' || phase === 'setup') {
        if (!setupInitialized) { initSetup(); setupInitialized = true; }
        showScreen('setup');
        document.getElementById('btn-rematch').disabled = false;
        document.getElementById('gameover-modal').classList.add('hidden');
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
        document.getElementById('gameover-modal').classList.add('hidden');
      } else if (phase === 'gameover') {
        // gameover modal is handled via gameover event
      }
      break;
    case 'state':
      gameState = msg.view;
      if (phase === 'play') {
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
        document.getElementById('setup-status').textContent = msg.opponentPresent ? 'Opponent joined. Place your pieces!' : 'Waiting for opponent to join...';
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
      showToast(`Opponent ${msg.status}`);
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
  let aName = getRankName(b.attacker.rank);
  let dName = getRankName(b.defender.rank);
  
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

function appendChat(from, text) {
  const box = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (from === 'you' ? 'me' : 'them');
  div.textContent = (from === 'you' ? 'You: ' : 'Them: ') + text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function showGameOver(winner, reason) {
  const modal = document.getElementById('gameover-modal');
  modal.classList.remove('hidden');
  document.getElementById('gameover-title').textContent = winner === myColor ? 'You Win!' : 'You Lose!';
  document.getElementById('gameover-reason').textContent = `Reason: ${reason}`;
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
        pDiv.innerHTML = `<span class="p-rank">${piece}</span><span class="p-name">${shortName}</span>`;
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
        <span class="p-rank">${rank}</span>
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
        if (cellData.own || cellData.revealed) {
           let rankStr = String(cellData.rank);
           let shortName = RANKS[rankStr] ? RANKS[rankStr].name.substring(0,3) : rankStr;
           pieceDiv.innerHTML = `<span class="p-rank">${rankStr}</span><span class="p-name">${shortName}</span>`;
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
  if (gameState.turn === myColor) {
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
  document.getElementById('captured-own').textContent = `Your side: ${ownPieces} alive`;
  document.getElementById('captured-enemy').textContent = `Enemy side: ${enemyPieces} alive`;
}

document.addEventListener('DOMContentLoaded', () => {
  initWebSocket();
  
  document.getElementById('btn-create').onclick = () => {
    send({ type: 'create' });
  };
  document.getElementById('btn-join').onclick = () => {
    let code = document.getElementById('join-code').value.trim().toUpperCase();
    if (code) {
      send({ type: 'join', roomCode: code });
    }
  };
  
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
  
  document.getElementById('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    if (input.value.trim()) {
      send({ type: 'chat', text: input.value.trim() });
      input.value = '';
    }
  };
});

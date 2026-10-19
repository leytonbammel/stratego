// Headless end-to-end smoke test: spawns the server, connects two ws clients,
// runs create/join/setup/move and asserts redaction + turn handling, then plays
// a vs-Computer room against the bot.
// Run: node smoke.js   (exits 0 on pass, 1 on fail)
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3999;
const fail = (m) => { console.error('SMOKE FAIL:', m); cleanup(1); };
let server;
const cleanup = (code) => { try { server && server.kill(); } catch (_) {} process.exit(code); };

// Build a valid 40-piece placement for a color, mobile pieces in the FRONT row.
function placement(color) {
  const ranks = [];
  const add = (r, n) => { for (let i = 0; i < n; i++) ranks.push(r); };
  // mobile first (fills front rows), immovable last (fills back row)
  add(2, 8); add(3, 5); add(4, 4); add(5, 4); add(6, 4);
  add(7, 3); add(8, 2); add(9, 1); add(10, 1); add(1, 1); // 34 mobile
  add('B', 6); add('F', 1); // 6 back
  const rows = color === 'south' ? [6, 7, 8, 9] : [0, 1, 2, 3];
  const cells = [];
  for (const r of rows) for (let c = 0; c < 10; c++) cells.push([r, c]);
  return ranks.map((rank, i) => ({ rank, r: cells[i][0], c: cells[i][1] }));
}

function connect() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.q = [];
  ws.pending = [];
  const tryResolve = () => {
    for (let i = 0; i < ws.pending.length; i++) {
      const p = ws.pending[i];
      const idx = ws.q.findIndex((m) => m.type === p.type);
      if (idx >= 0) {
        const [m] = ws.q.splice(idx, 1);
        clearTimeout(p.timer);
        ws.pending.splice(i, 1);
        i--;
        p.resolve(m);
      }
    }
  };
  ws.on('message', (d) => { ws.q.push(JSON.parse(d.toString())); tryResolve(); });
  ws.next = (type, timeout = 4000) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timeout waiting for ' + type)), timeout);
    ws.pending.push({ type, resolve: res, timer });
    tryResolve();
  });
  ws.send2 = (o) => ws.send(JSON.stringify(o));
  return new Promise((res) => ws.on('open', () => res(ws)));
}

(async () => {
  server = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '150' }, stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 1200));

  const a = await connect(); // host -> south
  a.send2({ type: 'create' });
  const created = await a.next('created');
  if (created.color !== 'south') fail('host should be south, got ' + created.color);
  const code = created.roomCode;
  if (!code) fail('no roomCode in created');

  const b = await connect(); // joiner -> north
  b.send2({ type: 'join', roomCode: code });
  const joined = await b.next('joined');
  if (joined.color !== 'north') fail('joiner should be north, got ' + joined.color);

  a.send2({ type: 'setup', placement: placement('south') });
  b.send2({ type: 'setup', placement: placement('north') });

  const stateA = await a.next('state', 6000);
  const view = stateA.view;
  if (!view || !Array.isArray(view.board)) fail('no board in state view');
  if (view.turn !== 'south') fail('south should move first, turn=' + view.turn);

  // Redaction check: every enemy (north) unrevealed cell must NOT expose rank.
  let enemyCells = 0, leaked = 0, ownCells = 0;
  for (const row of view.board) for (const cell of row) {
    if (cell && typeof cell === 'object') {
      if (cell.own === false) { enemyCells++; if (!cell.revealed && cell.rank !== undefined) leaked++; }
      if (cell.own === true) { ownCells++; if (cell.rank === undefined) fail('own cell missing rank'); }
    }
  }
  if (enemyCells !== 40) fail('expected 40 enemy cells, got ' + enemyCells);
  if (ownCells !== 40) fail('expected 40 own cells, got ' + ownCells);
  if (leaked > 0) fail(leaked + ' unrevealed enemy cells leaked their rank (anti-cheat breach)');

  // South makes a legal opening move: front-row scout [6,0] -> [5,0] (empty, not a lake).
  a.send2({ type: 'move', from: [6, 0], to: [5, 0] });
  const stateA2 = await a.next('state', 6000);
  if (stateA2.view.turn !== 'north') fail('turn should flip to north after move, got ' + stateA2.view.turn);
  const moved = stateA2.view.board[5][0];
  if (!(moved && moved.own === true)) fail('south piece did not land on [5,0]');
  if (stateA2.view.board[6][0] !== null) fail('[6,0] should be empty after move');

  // ---- vs Computer ----
  const c = await connect();
  c.send2({ type: 'create', vsBot: true });
  const botRoom = await c.next('created');
  if (!botRoom.vsBot) fail('created should echo vsBot');
  const botPhase = await c.next('phase');
  if (botPhase.phase !== 'setup') fail('bot room should start in setup, got ' + botPhase.phase);
  const botStatus = await c.next('setupStatus');
  if (!botStatus.opponentPresent || !botStatus.opponentReady) fail('bot should be present and ready');

  // The bot seat can't be taken by joining, or claimed with a missing token.
  const d = await connect();
  d.send2({ type: 'join', roomCode: botRoom.roomCode });
  if (!/full/i.test((await d.next('error')).message)) fail('joining a bot room should report it full');
  d.send2({ type: 'reconnect', roomCode: botRoom.roomCode, token: null });
  if (!/token/i.test((await d.next('error')).message)) fail('null token must not claim the bot seat');

  c.send2({ type: 'setup', placement: placement('south') });
  const botStart = await c.next('state', 6000);
  if (botStart.view.turn !== 'south') fail('human should move first vs bot');

  c.send2({ type: 'move', from: [6, 0], to: [5, 0] });
  const afterHuman = await c.next('state');
  if (afterHuman.view.turn !== 'north') fail('turn should pass to the bot');
  const afterBot = await c.next('state', 3000);
  if (afterBot.view.turn !== 'south') fail('bot did not move back, turn=' + afterBot.view.turn);
  if (afterBot.view.lastMove.color !== 'north') fail('last move should be the bot\'s');

  // Resigning while the bot is thinking must leave the bot silent.
  c.send2({ type: 'move', from: [6, 1], to: [5, 1] });
  await c.next('state');
  c.q = []; // earlier battles (the bot may have attacked) are not what this checks
  c.send2({ type: 'resign' });
  const over = await c.next('gameover');
  if (over.winner !== 'north' || over.reason !== 'resign') fail('resign should hand the bot the win');
  await new Promise((r) => setTimeout(r, 400));
  // The resign sends exactly one state (the final reveal); a late bot move would add more.
  const lateStates = c.q.filter((m) => m.type === 'state').length;
  if (lateStates !== 1 || c.q.some((m) => m.type === 'battle')) fail('bot moved after the game ended');
  c.q = c.q.filter((m) => m.type !== 'state' && m.type !== 'phase');

  c.send2({ type: 'rematch' });
  const rematchPhase = await c.next('phase');
  if (rematchPhase.phase !== 'setup') fail('bot should accept a rematch at once');
  const rematchStatus = await c.next('setupStatus');
  if (!rematchStatus.opponentReady) fail('bot should be ready again after rematch');

  console.log('SMOKE PASS: create/join/setup/redaction/move and vs-Computer all OK');
  cleanup(0);
})().catch((e) => fail(e.message));

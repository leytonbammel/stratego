// Headless end-to-end smoke test: spawns the server, connects two ws clients,
// runs create/join/setup/move and asserts redaction + turn handling.
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
  server = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
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

  console.log('SMOKE PASS: create/join/setup/redaction/move all OK');
  cleanup(0);
})().catch((e) => fail(e.message));

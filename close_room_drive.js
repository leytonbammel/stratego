// Verifies the host-only "Close Room" control: guest never sees it, host click
// returns BOTH players to the lobby, and the closed room code no longer joins.
const { chromium } = require('playwright');
const URL = 'http://localhost:4300';
const DIR = process.env.SHOT_DIR || '.';
const errs = [];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const A = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  const B = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  for (const [p, t] of [[A, 'A'], [B, 'B']]) {
    p.on('console', (m) => m.type() === 'error' && errs.push(t + ': ' + m.text()));
    p.on('pageerror', (e) => errs.push(t + ': PAGEERROR ' + e.message));
    p.on('dialog', (d) => d.accept()); // auto-confirm the close prompt
  }

  await A.goto(URL); await B.goto(URL);
  await A.click('#btn-create');
  await A.waitForFunction(() => {
    const s = document.querySelector('#room-code-display span');
    return s && s.textContent.trim().length >= 4;
  }, { timeout: 8000 });
  const code = (await A.textContent('#room-code-display span')).trim();
  await B.fill('#join-code', code); await B.click('#btn-join');
  await B.waitForSelector('#setup-screen.active', { timeout: 8000 });

  const hostSees = await A.isVisible('#btn-end-room-setup');
  const guestSees = await B.isVisible('#btn-end-room-setup');
  console.log('host sees Close Room:', hostSees, '| guest sees it:', guestSees);

  // Get into play so we close a live game, not just a setup lobby.
  for (const p of [A, B]) {
    await p.click('#btn-autofill');
    await p.waitForFunction(() => !document.getElementById('btn-ready').disabled, { timeout: 8000 });
    await p.click('#btn-ready');
  }
  await A.waitForSelector('#play-screen.active', { timeout: 8000 });
  await B.waitForSelector('#play-screen.active', { timeout: 8000 });
  console.log('both in play phase');

  await A.click('#btn-end-room-play');
  await A.waitForSelector('#lobby-screen.active', { timeout: 8000 });
  await B.waitForSelector('#lobby-screen.active', { timeout: 8000 });
  console.log('both returned to lobby');
  await A.screenshot({ path: `${DIR}/close-A-lobby.png` });
  await B.screenshot({ path: `${DIR}/close-B-lobby.png` });

  const storageCleared = await A.evaluate(() => !localStorage.getItem('roomCode') && !localStorage.getItem('token'));
  console.log('host localStorage cleared:', storageCleared);

  // The room must be gone server-side: rejoining the old code should error.
  await B.fill('#join-code', code); await B.click('#btn-join');
  await B.waitForTimeout(1500);
  const stillLobby = await B.isVisible('#lobby-screen.active');
  console.log('rejoin closed room rejected (still lobby):', stillLobby);

  console.log('CONSOLE ERRORS:', errs.length ? errs : 'none');
  const ok = hostSees && !guestSees && storageCleared && stillLobby && errs.length === 0;
  console.log(ok ? 'CLOSE ROOM OK' : 'CLOSE ROOM FAILED');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('DRIVER FAIL:', e.message); process.exit(1); });

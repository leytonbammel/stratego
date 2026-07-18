// Drives the live app with two players (south=creator, north=joiner) via Playwright.
const { chromium } = require('playwright');
const fs = require('fs');
const DIR = process.env.SHOT_DIR || '.';
const URL = 'http://localhost:4300';
const shot = (page, name) => page.screenshot({ path: `${DIR}/${name}.png` });
const errs = { A: [], B: [] };

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctxA = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  A.on('console', (m) => m.type() === 'error' && errs.A.push(m.text()));
  B.on('console', (m) => m.type() === 'error' && errs.B.push(m.text()));
  A.on('pageerror', (e) => errs.A.push('PAGEERROR ' + e.message));
  B.on('pageerror', (e) => errs.B.push('PAGEERROR ' + e.message));

  // --- Lobby: A creates, B joins ---
  await A.goto(URL); await B.goto(URL);
  await A.click('#btn-create');
  await A.waitForFunction(() => {
    const s = document.querySelector('#room-code-display span');
    return s && s.textContent.trim().length >= 4;
  }, { timeout: 8000 });
  const code = (await A.textContent('#room-code-display span')).trim();
  console.log('room code =', code);
  await shot(A, '1-A-created');

  await B.fill('#join-code', code);
  await B.click('#btn-join');
  await B.waitForSelector('#setup-screen.active', { timeout: 8000 });
  console.log('B joined; both in setup');

  // --- Setup: auto-fill + ready on both ---
  for (const [p, tag] of [[A, 'A'], [B, 'B']]) {
    await p.click('#btn-autofill');
    await p.waitForFunction(() => !document.getElementById('btn-ready').disabled, { timeout: 8000 });
  }
  await shot(A, '2-A-setup-filled');
  await A.click('#btn-ready');
  await B.click('#btn-ready');

  // --- Play screen appears on both ---
  await A.waitForSelector('#play-screen.active', { timeout: 8000 });
  await B.waitForSelector('#play-screen.active', { timeout: 8000 });
  console.log('both in play phase');
  await shot(A, '3-A-play-start');
  await shot(B, '3-B-play-start');

  // Verify hidden info in the DOM: A must see zero enemy ranks (all enemy pieces unrevealed at start)
  const enemyRankLeak = await A.evaluate(() => {
    const enemies = [...document.querySelectorAll('#play-board .piece.enemy')];
    const revealedText = enemies.filter(e => e.querySelector('.p-rank')).length;
    return { count: enemies.length, showingRank: revealedText };
  });
  console.log('A view enemy pieces:', enemyRankLeak.count, 'showing rank:', enemyRankLeak.showingRank);

  // --- A (south, moves first) makes a real move: find an own movable piece with a legal target ---
  const cells = A.locator('#play-board .cell');
  const n = await cells.count();
  let moved = false;
  for (let i = 0; i < n && !moved; i++) {
    const cell = cells.nth(i);
    const own = await cell.locator('.piece.own').count();
    if (!own) continue;
    const rank = (await cell.locator('.p-rank').first().textContent().catch(() => '')) || '';
    if (rank === 'B' || rank === 'F') continue; // immovable
    await cell.click();
    const targets = A.locator('#play-board .cell.legal-target');
    if (await targets.count() > 0) {
      await shot(A, '4-A-selected');
      await targets.first().click();
      moved = true;
    } else {
      await cell.click(); // deselect and try next
    }
  }
  console.log('A made a move:', moved);
  await A.waitForFunction(() => {
    const t = document.getElementById('turn-indicator');
    return t && /north|opponent|their/i.test(t.textContent);
  }, { timeout: 6000 }).catch(() => {});
  await shot(A, '5-A-after-move');
  await shot(B, '5-B-after-move');
  console.log('A turn indicator:', (await A.textContent('#turn-indicator')).trim());
  console.log('B turn indicator:', (await B.textContent('#turn-indicator')).trim());

  console.log('CONSOLE ERRORS A:', errs.A.length ? errs.A : 'none');
  console.log('CONSOLE ERRORS B:', errs.B.length ? errs.B : 'none');
  console.log(moved && errs.A.length === 0 && errs.B.length === 0 ? 'BROWSER RUN OK' : 'BROWSER RUN COMPLETED WITH NOTES');
  await browser.close();
})().catch((e) => { console.error('DRIVER FAIL:', e.message); process.exit(1); });

// Development-only browser integration tests. Production files are served
// unchanged except connect(), which uses the shared in-memory SDK below.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve, extname } from 'node:path';
const require = createRequire(resolve(process.env.MM_TEST_TOOLS || '/tmp/mystery-monster-tools', 'package.json'));
const { chromium } = require('playwright');
const root = resolve(new URL('../', import.meta.url).pathname);
const store = await readFile(resolve(root, 'js/store.js'), 'utf8');
const docs = new Map();
function merge(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) result[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? (Object.keys(value).length ? merge(base?.[key] || {}, value) : {}) : value;
  return result;
}
const testConnect = `export async function connect() {
  const uid = localStorage.getItem('test-uid') || crypto.randomUUID();
  localStorage.setItem('test-uid', uid);
  const snapshot = async ref => {
    const data = await window.testDB({ op: 'get', ref });
    return { exists: () => data !== null, data: () => data };
  };
  const sdk = {
    doc: (_, ...parts) => parts.join('/'),
    setDoc: (ref, data, options) => window.testDB({op: 'set', ref, data, options}),
    onSnapshot(ref, cb, error) {
      let last, stopped = false;
      const poll = async () => {
        try {
          const snap = await snapshot(ref), key = JSON.stringify(snap.data());
          if (!stopped && last !== key) { last = key; cb(snap); }
        } catch (err) { if (!stopped) error?.(err); }
      };
      poll(); const timer = setInterval(poll, 30);
      return () => { stopped = true; clearInterval(timer); };
    },
    async runTransaction(_, fn) {
      const writes = [];
      const result = await fn({get: snapshot, set: (...args) => writes.push(args)});
      for (const args of writes) await sdk.setDoc(...args);
      return result;
    },
  };
  return makeSession(sdk, {}, {uid});
}`;
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    let data = await readFile(path);
    if (path.endsWith('/js/firebase-config.js') && req.headers['x-production'] === 'true') {
      data = 'export const firebaseConfig = { apiKey: "YOUR_FIREBASE_API_KEY" };';
    }
    if (path.endsWith('/js/store.js') && req.headers['x-production'] !== 'true') {
      data = store.slice(0, store.indexOf('export async function connect()')) + testConnect;
    }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' })[extname(path)] || 'text/plain');
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const errors = [], brokenImages = [];
let checks = 0;
function passed(name) { checks++; console.log(`PASS ${name}`); }
async function wait(fn) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 40)); }
  throw new Error('Timed out waiting for game state');
}
async function context(options = {}) {
  const ctx = await browser.newContext(options);
  await ctx.exposeBinding('testDB', (_, {op, ref, data, options}) => {
    if (op === 'get') return docs.has(ref) ? structuredClone(docs.get(ref)) : null;
    docs.set(ref, options?.merge ? merge(docs.get(ref), data) : structuredClone(data));
  });
  // No third-party requests in the local harness; system font fallbacks apply.
  await ctx.route('https://**', route => route.abort());
  ctx.on('page', page => {
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (/\.(?:jpg|png|webp)$/.test(new URL(r.url()).pathname) && r.status() !== 200) brokenImages.push(r.url()); });
  });
  return ctx;
}
async function click(page, selector) {
  if (/^\[data-(act|t|g)[=]/.test(selector) && await page.locator("#hostPanel").isVisible()) await page.locator("#finishSetup").click();
  const target = page.locator(selector);
  if (await target.count() && await target.evaluate(el => !!el.closest('#hostPanel')) && !await target.isVisible()) await page.locator('#roomSetupBtn').click();
  if (await target.count() && await target.evaluate(el => !!el.closest('#game')) && !await target.isVisible() && await page.locator('#hostPanel').isVisible()) await page.locator('#finishSetup').click();
  await target.click();
  if (/^\[data-(q|mode)[=]/.test(selector)) await page.locator("#finishSetup").click();
  if (selector === '#createRoom') {
    assert.equal(await page.locator('#hostPanel').isVisible(), true);
    assert.equal(await page.locator('#game').isVisible(), false);
    assert.equal(await page.locator('#guestForm').count(), 0);
    assert.equal(await page.locator('#difficulty').inputValue(), 'normal');
    await page.locator('[data-q="10"]').click();
    assert.equal(await page.locator('[data-q="10"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-q="15"]').click();
    await page.locator('#finishSetup').click();
  }
}
async function confirm(page) { await click(page, '#confirmOk'); }
async function guidePick(page, name) {
  await click(page, `[data-g="go"][data-name="${name.replaceAll('"', '\\"')}"]`);
  await click(page, '[data-g="pick"]'); await confirm(page);
}
try {
  // Verify missing configuration reaches a useful failure panel.
  // Supply a placeholder fixture without changing the saved project settings.
  const prod = await context();
  await prod.setExtraHTTPHeaders({ 'x-production': 'true' });
  const pp = await prod.newPage(); await pp.goto(origin);
  await pp.locator('#unavailable:not(.hidden)').waitFor();
  assert.match(await pp.locator('#connectionError').textContent(), /Firebase Web app settings/);
  passed('unconfigured production app shows setup guidance'); await prod.close();

  const hostCtx = await context(), host = await hostCtx.newPage();
  await host.goto(origin);
  await host.fill('#displayName', 'Pumpkin'); await click(host, '#createRoom');
  await host.locator('#game:not(.hidden)').waitFor();
  const code = new URL(host.url()).searchParams.get('room');
  const roomPath = `rooms/${code}`, state = () => docs.get(roomPath);
  const hostId = state().hostUid;
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(state().players[hostId].name, 'Pumpkin');
  assert.ok(await host.locator('#inviteArea').isVisible());
  assert.equal(await host.locator('.game-logo').evaluate(img => img.complete && img.naturalWidth > 0), true);
  assert.equal(await host.locator('link[rel=icon]').count(), 2);
  passed('create room, host role, named player, invite code and custom logo');

  const playerCtx = await context({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const player = await playerCtx.newPage(); await player.goto(`${origin}/?room=${code}`);
  await player.locator('#inviteJoin:not(.hidden)').waitFor();
  assert.equal(await player.locator('#roomChoices').isVisible(), false);
  await player.fill('#displayName', 'Ghost'); await click(player, '#inviteJoin button[type=submit]');
  await wait(() => Object.keys(state().players).length === 2);
  const playerId = Object.keys(state().players).find(id => id !== hostId);
  await wait(async () => (await host.locator('#board').textContent()).includes('Ghost'));
  assert.equal(await player.locator('#hostPanel').isVisible(), false);
  assert.equal(await player.locator('#gameHostControls').isVisible(), false);
  assert.equal(await host.locator('#gameHostControls').isVisible(), true);
  assert.equal(await player.locator('#board [data-rm]').count(), 0);
  assert.equal(await host.locator('#board [data-rm]').count(), 2);
  const playersBeforeRemovalAttempt = structuredClone(state().players);
  await player.locator('#board').evaluate((board, hostId) => {
    const attempt = document.createElement('button');
    attempt.dataset.rm = hostId;
    board.append(attempt);
    attempt.click();
    attempt.remove();
  }, hostId);
  assert.deepEqual(state().players, playersBeforeRemovalAttempt);
  assert.equal(await player.locator('#inviteArea').isVisible(), false);
  passed('invite skips room choice; second device joins and scoreboard updates');

  await click(host, '[data-act=draw]'); await wait(() => state().drawn);
  const secretPath = `rooms/${code}/secrets/${hostId}`;
  const secretName = docs.get(secretPath).name;
  await host.locator('#secretArea .secret-pic').waitFor();
  await host.locator('#secretArea .desc').waitFor();
  assert.equal(await host.locator('#secretArea [data-act=draw]').count(), 0);
  assert.equal(await host.locator('#secretArea .stats').isVisible(), false);
  await host.locator('#secretArea .secret-more summary').click();
  await host.locator('#secretArea .stats').waitFor();
  assert.equal(await host.locator('#secretArea .stats').isVisible(), true);
  assert.equal(await player.locator('#secretArea .name').count(), 0);
  assert.equal(await player.locator('#secretArea .stats').count(), 0);
  await player.locator('button.glow').waitFor();
  passed('private monster draw, stats, turn skips monster, glowing guess button');

  await click(host, '[data-t=yes]'); await wait(() => state().questions === 1);
  assert.equal(await host.locator('#secretArea .stats').isVisible(), true);
  await click(host, '[data-t=sometimes]'); await wait(() => state().questions === 2);
  await wait(async () => await player.locator('.candle.out').count() === 2);
  assert.deepEqual(state().clues.map(c => c.ans), ['yes', 'sometimes']);
  assert.equal(await host.locator('#clues .ans.sometimes').textContent(), 'Sometimes');
  passed('yes/sometimes answers sync clues and extinguish candles');

  await player.evaluate(() => {
    window.pageTurnStarts = 0;
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) { window.pageTurnStarts++; return original.apply(this, args); };
  });
  await click(player, '[data-t=guess]');
  assert.ok(await player.evaluate(() => window.pageTurnStarts > 0));
  await click(player, '#guideClose'); await click(player, '#soundBtn');
  const starts = await player.evaluate(() => window.pageTurnStarts);
  await click(player, '[data-t=guess]');
  assert.equal(await player.evaluate(() => window.pageTurnStarts), starts);
  await click(player, '#guideClose'); await click(player, '#soundBtn');
  await click(player, '[data-t=guess]');
  passed('Field Guide opening plays page-turn audio and respects mute');
  const names = await player.locator('.gentry .gname').allTextContents();
  assert.equal(names.length, 48);
  const thumbnail = player.locator('.gentry img').first();
  assert.equal(await thumbnail.getAttribute('loading'), 'lazy');
  assert.match(await thumbnail.getAttribute('src'), /^images\/optimized\/portraits\/.*\.webp$/);
  await thumbnail.evaluate(img => img.decode());
  assert.ok(await thumbnail.evaluate(img => img.naturalWidth > 0 && img.naturalWidth <= 192));
  const personalName = names.find(n => n !== secretName);
  const personalButton = `[data-g="rule-out"][data-name="${personalName}"]`;
  const personalEntry = `.gentry[data-name="${personalName}"]`;
  const beforeNotes = structuredClone([...docs]);
  await click(player, personalButton);
  assert.equal(await player.locator(personalButton).getAttribute('aria-pressed'), 'true');
  assert.match(await player.locator(personalEntry).getAttribute('class'), /out/);
  await click(host, '#guideBtn');
  assert.doesNotMatch(await host.locator(personalEntry).getAttribute('class'), /out/);
  assert.deepEqual([...docs], beforeNotes, 'Personal eliminations must not write to Firebase');
  await click(host, '#guideClose');
  await click(player, '#guideClose'); await click(player, '#guideBtn');
  assert.equal(await player.locator(personalButton).getAttribute('aria-pressed'), 'true');
  await click(player, `[data-g="go"][data-name="${personalName}"]`);
  assert.equal(await player.locator('.personally-out').textContent(), personalName);
  await click(player, personalButton);
  assert.equal(await player.locator('.personally-out').count(), 0);
  await click(player, '.guide-top [data-g=index]');
  await click(player, `[data-g="rule-out"][data-name="${secretName}"]`);
  assert.equal(await player.locator('#guideTimer').isVisible(), true);
  assert.equal(await player.evaluate(() => document.getElementById('guideCountdown').textContent === document.getElementById('roundCountdown').textContent), true);
  for (const viewport of [{width: 390, height: 844}, {width: 1280, height: 900}]) {
    await player.setViewportSize(viewport);
    const timerBox = await player.locator('#guideTimer').boundingBox();
    const bookBox = await player.locator('.book').boundingBox();
    assert.ok(timerBox.x >= 0 && timerBox.x + timerBox.width <= viewport.width);
    assert.ok(viewport.width > 760 ? timerBox.x >= bookBox.x + bookBox.width : timerBox.y + timerBox.height <= bookBox.y);
  }
  await player.setViewportSize({width: 390, height: 844});
  passed('personal rule-outs are private, reversible, survive reopening, and timer is visible on mobile and desktop');
  await click(player, '[data-g=go][data-name="Dracula"]');
  await player.locator('.leaf.text .stats').waitFor();
  await player.locator('.leaf.art img').evaluate(img => img.decode());
  assert.ok(await player.locator('.leaf.art img').evaluate(img => img.naturalWidth > 0 && img.naturalWidth <= 680));
  assert.equal(await player.locator('.guide-top').evaluate(e => getComputedStyle(e).position), 'sticky');
  await click(player, '.guide-top [data-g=go][aria-label="Next monster"]');
  await click(player, '.guide-top [data-g=index]');
  const wrong = names.find(n => n !== secretName);
  await guidePick(player, wrong);
  await wait(() => state().players[playerId].score === -1);
  assert.equal(state().questions, 3);
  await click(player, '[data-t=guess]');
  await player.locator(`.gentry.out[data-name="${wrong}"]`).waitFor();
  await click(player, '#guideClose');
  passed('Field Guide pages, stats, sticky navigation, confirmed wrong guess −1, crossed-out entry');

  // Identity and score survive a page reload; a room link still asks for a name.
  await player.reload(); await player.locator('#inviteJoin:not(.hidden)').waitFor();
  assert.equal(await player.inputValue('#displayName'), 'Ghost');
  await click(player, '#inviteJoin button[type=submit]');
  await player.locator('#game:not(.hidden)').waitFor();
  assert.equal(state().players[playerId].score, -1);
  await click(player, '[data-t=guess]');
  await click(player, `[data-g="rule-out"][data-name="${secretName}"]`);
  await guidePick(player, secretName);
  await wait(() => state().round === 2);
  assert.equal(state().players[playerId].score, 1);
  await player.locator('#reveal:not(.hidden)').waitFor();
  await host.locator('#reveal:not(.hidden)').waitFor();
  assert.equal(await player.locator('#revealHead').textContent(), secretName);
  assert.match(await host.locator('#board').textContent(), /👑/);
  passed('refresh preserves identity/seat/score; correct guess +2, shared reveal, leader crown');
  await click(host, '#revealClose'); await click(player, '#revealClose');
  await click(player, '#guideBtn');
  assert.equal(await player.locator('[data-g="rule-out"][aria-pressed="true"]').count(), 0);
  assert.equal(await player.locator('.gentry.out').count(), 0);
  await click(player, '#guideClose');
  passed('personal and shared eliminations reset next round');

  if (process.env.MM_FIELD_GUIDE_ONLY === '1') {
    await click(host, '#guideBtn');
    docs.set(roomPath, { ...state(), drawn: true, roundDeadline: Date.now() + 65000 });
    await wait(async () => (await host.locator('#guideCountdown').textContent()).startsWith('1:'));
    await click(host, '[data-g=go][data-name="Dracula"]');
    docs.set(roomPath, { ...state(), roundDeadline: Date.now() + 20000 });
    await wait(async () => (await host.locator('#guideTimer').getAttribute('class')).includes('timer-low'));
    assert.equal(await host.evaluate(() => document.getElementById('guideCountdown').textContent === document.getElementById('roundCountdown').textContent), true);
    docs.set(roomPath, { ...state(), difficulty: 'casual', roundDeadline: null });
    await wait(async () => await host.locator('#guideCountdown').textContent() === 'No timer');
    assert.doesNotMatch(await host.locator('#guideTimer').getAttribute('class'), /timer-low/);
    passed('guide countdown updates on monster pages, shows low time, and supports Casual mode');
  } else {

  // Host manual fallback ends a round with no access to the monster's secret;
  // the monster device then backfills the reveal with the private name.
  await click(player, '[data-act=draw]'); await wait(() => state().drawn);
  const secondSecret = docs.get(`rooms/${code}/secrets/${playerId}`).name;
  await click(host, '#roomSetupBtn');
  await click(host, '[data-q="5"]'); await wait(() => state().maxQ === 5);
  for (let i = 1; i <= 5; i++) { await click(player, '[data-t=no]'); await wait(() => state().questions === i); }
  await host.locator('[data-t=pass]').waitFor();
  await click(host, '[data-t=pass]'); await confirm(host);
  await wait(() => state().round === 3 && state().lastRound.name === secondSecret);
  assert.equal(state().players[playerId].score, 4);
  await host.locator('#reveal:not(.hidden)').waitFor();
  assert.match(await host.locator('#revealKicker').textContent(), /Nobody got it/);
  passed('5-candle setting, final Pass, monster +3, reveal backfill from private device');
  await click(host, '#revealClose'); await click(player, '#revealClose');

  await click(host, '[data-mode=host]'); await wait(() => state().hostMode);
  await click(host, '[data-act=draw]'); await wait(() => state().drawn);
  await host.locator('.secret-body.blurwrap').waitFor();
  await click(host, '[data-act=peek]'); await host.locator('.secret-body:not(.blurwrap)').waitFor();
  await click(host, '[data-act=peek]');
  assert.equal(await host.locator('#guestForm').count(), 0);
  const thirdCtx = await context(), third = await thirdCtx.newPage();
  await third.goto(`${origin}/?room=${code}`);
  await third.fill('#displayName', 'Boo'); await click(third, '#inviteJoin button[type=submit]');
  await wait(() => Object.keys(state().players).length === 3);
  const guestId = Object.keys(state().players).find(id => id !== hostId && id !== playerId);
  const turn = state().turn;
  await click(host, '#skipTurnBtn'); await wait(() => state().turn === turn + 1);
  await host.selectOption('#monsterSelect', guestId); await click(host, '#setMonsterBtn'); await confirm(host);
  await wait(() => state().monsterId === guestId && !state().drawn);
  await click(host, '[data-act=self]'); await click(host, '#guideClose');
  await wait(() => state().selfPick);
  await host.locator('[data-t=right]').waitFor();
  await host.locator('[data-t=wrongq]').waitFor();
  await host.locator('[data-t=guess]').waitFor();
  passed('host-run blur/show, automatic player join, skip turn, switch monster, self-pick, host guess controls');
  const wrongAsker = Object.keys(state().players).filter(id => id !== guestId)[(state().round + state().turn) % 2];
  const oldScore = state().players[wrongAsker].score;
  await click(host, '[data-t=wrongq]'); await wait(() => state().questions === 1);
  assert.equal(state().players[wrongAsker].score, oldScore - 1);
  const rightAsker = Object.keys(state().players).filter(id => id !== guestId)[(state().round + state().turn) % 2];
  const rightScore = state().players[rightAsker].score;
  await click(host, '[data-t=right]'); await guidePick(host, 'Dracula');
  await wait(() => state().round === 4);
  assert.equal(state().players[rightAsker].score, rightScore + 2);
  assert.equal(state().lastRound.name, 'Dracula');
  await host.locator('#reveal:not(.hidden)').waitFor(); await click(host, '#revealClose');
  await player.locator('#reveal:not(.hidden)').waitFor(); await click(player, '#revealClose');
  passed('host manually marks wrong guesses and selects a self-picked monster for a correct reveal');
  const beforeSkip = structuredClone(state().players);
  await click(host, '#skipBtn'); await confirm(host); await wait(() => state().round === 5);
  assert.deepEqual(state().players, beforeSkip);
  passed('skip round retains all players and scores under Firestore merge behavior');

  await click(host, '[data-act=draw]'); await wait(() => state().drawn);
  await host.locator('.secret-body.blurwrap').waitFor();
  const proxySecret = docs.get(secretPath).name;
  await click(host, '[data-t=guess]'); await host.locator('#guide:not(.hidden)').waitFor(); await click(host, '#guideClose');
  for (let i = 1; i <= 5; i++) { await click(host, '[data-t=no]'); await wait(() => state().questions === i); }
  const finalAsker = [hostId, guestId][(state().round + state().turn) % 2];
  const finalScore = state().players[finalAsker].score;
  const monsterScore = state().players[playerId].score;
  await click(host, '[data-t=guess]'); await guidePick(host, names.find(n => n !== proxySecret));
  await wait(() => state().round === 6);
  assert.equal(state().players[finalAsker].score, finalScore - 1);
  assert.equal(state().players[playerId].score, monsterScore + 3);
  await host.locator('#reveal:not(.hidden)').waitFor(); await click(host, '#revealClose');
  await player.locator('#reveal:not(.hidden)').waitFor(); await click(player, '#revealClose');
  passed('host draws for another player, Pick their guess opens guide, final wrong guess costs −1 and awards +3');
  for (const count of [10, 15, 5]) {
    await click(host, `[data-q="${count}"]`); await wait(() => state().maxQ === count);
    await wait(async () => await host.locator('.candle').count() === count);
  }
  passed('all 5/10/15 question settings update candle count');

  await click(host, '#roomSetupBtn');
  await host.fill('#newMonster', 'Test beast'); await host.fill('#newDesc', 'A test monster.');
  await click(host, '#monForm button'); await wait(() => docs.get(`${roomPath}/config/monsters`)?.list.includes('Test beast'));
  await click(host, '#restoreMon'); await wait(() => docs.get(`${roomPath}/config/monsters`)?.list.length === 48);
  passed('host monster-list editing and restore');

  await click(player, '#soundBtn'); assert.equal(await player.locator('#soundBtn').getAttribute('aria-pressed'), 'false');
  await player.reload();
  assert.equal(await player.locator('#soundBtn').getAttribute('aria-pressed'), 'false');
  await click(player, '#inviteJoin button[type=submit]'); await player.locator('#game:not(.hidden)').waitFor();
  assert.equal(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await player.locator('.candle .flame').first().evaluate(e => getComputedStyle(e).animationName), 'none');
  passed('sound preference survives refresh, mobile layout fits, reduced motion disables candle animation');

  // Leave writes a null tombstone rather than deleting everyone else's entry.
  await click(player, '#leaveBtn'); await confirm(player); await wait(() => state().players[playerId] === null);
  assert.equal(state().players[hostId].name, 'Pumpkin');
  passed('leave removes only the selected player');

  // Room code entry, missing room errors, and separate-room isolation.
  const otherCtx = await context(), other = await otherCtx.newPage(); await other.goto(origin);
  await other.fill('#displayName', 'Other'); await other.fill('#roomCode', 'AAAAAA'); await click(other, '#joinRoom');
  await wait(async () => (await other.locator('#entryError').textContent()).includes('No game'));
  await click(other, '#createRoom'); await other.locator('#game:not(.hidden)').waitFor();
  assert.notEqual(new URL(other.url()).searchParams.get('room'), code);
  assert.equal(Object.keys(state().players).length, 3);
  passed('typed room-code validation and separate-room isolation');

  const timedCode = new URL(other.url()).searchParams.get('room');
  const timedPath = `rooms/${timedCode}`, timedState = () => docs.get(timedPath);
  assert.equal(timedState().difficulty, 'normal');
  await click(other, '#roomSetupBtn');
  for (const [mode, minutes] of [['easy', 10], ['normal', 7], ['hard', 5], ['extreme', 2], ['casual', 0]]) {
    await other.selectOption('#difficulty', mode);
    await wait(() => timedState().difficulty === mode);
    await wait(async () => (await other.locator('#roundTimer').textContent()).includes(minutes ? `${minutes}:00` : 'No timer'));
  }
  await click(other, '#finishSetup');
  await click(other, '[data-act=draw]'); await wait(() => timedState().drawn);
  assert.equal(timedState().roundDeadline, null);
  await click(other, '#guideBtn');
  assert.equal(await other.locator('#guideCountdown').textContent(), 'No timer');
  await click(other, '#guideClose');
  passed('Normal default, all five mode settings, and Casual draws without a timer');
  await click(other, '#roomSetupBtn');
  assert.equal(await other.locator('#difficulty').isDisabled(), true);
  await click(other, '#skipBtn'); await confirm(other); await wait(() => timedState().round === 2);
  await other.selectOption('#difficulty', 'extreme'); await wait(() => timedState().difficulty === 'extreme');
  await click(other, '#finishSetup');
  const watcherCtx = await context(), watcher = await watcherCtx.newPage();
  await watcher.goto(`${origin}/?room=${timedCode}`);
  await watcher.fill('#displayName', 'Watcher'); await click(watcher, '#inviteJoin button[type=submit]');
  await watcher.locator('#game:not(.hidden)').waitFor();
  const started = Date.now();
  await click(other, '[data-act=draw]'); await wait(() => timedState().drawn);
  assert.ok(timedState().roundDeadline >= started + 120000);
  assert.ok(timedState().roundDeadline < Date.now() + 121000);
  await wait(async () => (await watcher.locator('#roundTimer').textContent()).includes('2:00'));
  const deadline = timedState().roundDeadline;
  await watcher.reload(); await click(watcher, '#inviteJoin button[type=submit]');
  assert.equal(timedState().roundDeadline, deadline);
  passed('shared Extreme deadline starts on draw and survives a player refresh');
  await click(watcher, '#guideBtn');
  // Move the shared deadline forward for a real countdown without a two-minute test wait.
  docs.set(timedPath, { ...timedState(), roundDeadline: Date.now() + 2500 });
  await wait(async () => (await other.locator('#roundTimer').textContent()).includes('0:02'));
  await wait(async () => (await watcher.locator('#roundTimer').textContent()).includes('0:02'));
  await wait(async () => await watcher.locator('#guideCountdown').textContent() === '0:02');
  assert.match(await watcher.locator('#guideTimer').getAttribute('class'), /timer-low/);
  await click(watcher, '#guideClose');
  await wait(() => timedState().round === 3);
  assert.equal(timedState().lastRound.timedOut, true);
  assert.equal(timedState().lastRound.outcome, 'stump');
  assert.equal(timedState().players[timedState().hostUid].score, 3);
  assert.equal(timedState().roundDeadline, null);
  await other.locator('#reveal:not(.hidden)').waitFor();
  await watcher.locator('#reveal:not(.hidden)').waitFor();
  assert.match(await watcher.locator('#revealKicker').textContent(), /Time’s up!/);
  passed('all players see countdown and timeout reveal; monster wins exactly +3');

  await click(other, '#revealClose'); await click(watcher, '#revealClose');
  await click(other, '#roomSetupBtn');
  await other.fill('#totalRounds', '3'); await other.locator('#totalRounds').dispatchEvent('change');
  await wait(() => timedState().totalRounds === 3);
  await click(other, '#finishSetup');
  await click(watcher, '[data-act=draw]'); await wait(() => timedState().drawn);
  const finalSecret = docs.get(`rooms/${timedCode}/secrets/${timedState().monsterId}`).name;
  await click(other, '[data-t=guess]'); await guidePick(other, finalSecret);
  await wait(() => !!timedState().gameResult);
  assert.equal(timedState().round, 3);
  assert.equal(timedState().monsterId, null);
  assert.equal(timedState().monsterTurns.length, 2);
  assert.equal(timedState().gameResult.score, 5);
  await other.locator('#gameOver:not(.hidden)').waitFor();
  await watcher.locator('#gameOver:not(.hidden)').waitFor();
  assert.equal(await other.locator('#winnerNames').textContent(), 'Other');
  assert.equal(await watcher.locator('#winnerNames').textContent(), 'Other');
  assert.equal(await other.locator('#viewResults').count(), 0);
  await click(other, '#winnerClose');
  assert.equal(await other.locator('[data-act=draw]').count(), 0);
  assert.equal(await other.locator('#gameOver').isVisible(), false);
  await watcher.reload(); await click(watcher, '#inviteJoin button[type=submit]');
  await watcher.locator('#gameOver:not(.hidden)').waitFor();
  passed('configured final round ends play and announces the winner to all players, including after refresh');
  const finishedResult = structuredClone(timedState().gameResult);
  await click(other, '#gameNew'); await confirm(other);
  await other.locator('#roomChoices:not(.hidden)').waitFor();
  assert.equal(new URL(other.url()).searchParams.has('room'), false);
  assert.deepEqual(timedState().gameResult, finishedResult);
  await other.fill('#displayName', 'Other');
  await other.locator('#createRoom').click();
  await other.locator('#hostPanel:not(.hidden)').waitFor();
  await other.selectOption('#difficulty', 'easy');
  await other.locator('[data-q="5"]').click();
  await other.fill('#totalRounds', '4');
  await other.locator('#totalRounds').dispatchEvent('change');
  await other.locator('#finishSetup').click();
  await other.locator('#game:not(.hidden)').waitFor();
  const nextCode = new URL(other.url()).searchParams.get('room');
  assert.notEqual(nextCode, timedCode);
  const nextPath = `rooms/${nextCode}`, nextState = () => docs.get(nextPath);
  assert.equal(nextState().difficulty, 'easy');
  assert.equal(nextState().maxQ, 5);
  assert.equal(nextState().totalRounds, 4);
  assert.deepEqual(timedState().gameResult, finishedResult);
  await watcher.goto(`${origin}/?room=${nextCode}`);
  await watcher.locator('#inviteJoin button[type=submit]').waitFor();
  await click(watcher, '#inviteJoin button[type=submit]');
  await wait(() => Object.values(nextState().players).filter(Boolean).length === 2);
  passed('Start a new game returns home, creates a room with selected options, and preserves the finished room');

  const skippedTurn = nextState().turn;
  await click(other, '#gameSkipTurn'); await wait(() => nextState().turn === skippedTurn + 1);
  await click(other, '#gameEnd'); await click(other, '#confirmCancel');
  assert.ok(!nextState().gameResult);
  await click(other, '#gameEnd'); await confirm(other);
  await wait(() => nextState().gameResult?.endedEarly);
  await other.locator('#gameOver:not(.hidden)').waitFor();
  await watcher.locator('#gameOver:not(.hidden)').waitFor();
  assert.match(await other.locator('#winnerTitle').textContent(), /tie/);
  assert.equal(nextState().gameResult.winners.length, 2);
  await click(other, '#winnerClose');
  assert.equal(await other.locator('#gameEnd').isDisabled(), true);
  await click(other, '#gameNew'); await confirm(other);
  await other.locator('#roomChoices:not(.hidden)').waitFor();
  assert.equal(new URL(other.url()).searchParams.has('room'), false);
  assert.equal(nextState().gameResult.endedEarly, true);
  passed('host controls skip turns and end games, then Start a new game returns home');

  }
  assert.deepEqual(errors, []); assert.deepEqual(brokenImages, []);
  console.log(`${checks} browser checks passed; no uncaught errors or missing requested images.`);
} catch (error) { console.error('Browser errors:', errors); throw error; } finally { await browser.close(); await new Promise(r => server.close(r)); }

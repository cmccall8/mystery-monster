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
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' })[extname(path)] || 'text/plain');
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
    page.on('response', r => { if (r.url().endsWith('.jpg') && r.status() !== 200) brokenImages.push(r.url()); });
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
  passed('create room, host role, named player, invite code');

  const playerCtx = await context({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const player = await playerCtx.newPage(); await player.goto(`${origin}/?room=${code}`);
  await player.locator('#inviteJoin:not(.hidden)').waitFor();
  assert.equal(await player.locator('#roomChoices').isVisible(), false);
  await player.fill('#displayName', 'Ghost'); await click(player, '#inviteJoin button[type=submit]');
  await wait(() => Object.keys(state().players).length === 2);
  const playerId = Object.keys(state().players).find(id => id !== hostId);
  await wait(async () => (await host.locator('#board').textContent()).includes('Ghost'));
  assert.equal(await player.locator('#hostPanel').isVisible(), false);
  assert.equal(await player.locator('#inviteArea').isVisible(), false);
  passed('invite skips room choice; second device joins and scoreboard updates');

  await click(host, '[data-act=draw]'); await wait(() => state().drawn);
  const secretPath = `rooms/${code}/secrets/${hostId}`;
  const secretName = docs.get(secretPath).name;
  await host.locator('#secretArea .stats').waitFor();
  assert.equal(await player.locator('#secretArea .name').count(), 0);
  assert.equal(await player.locator('#secretArea .stats').count(), 0);
  await player.locator('button.glow').waitFor();
  passed('private monster draw, stats, turn skips monster, glowing guess button');

  await click(host, '[data-t=yes]'); await wait(() => state().questions === 1);
  await click(host, '[data-t=no]'); await wait(() => state().questions === 2);
  await wait(async () => await player.locator('.candle.out').count() === 2);
  assert.deepEqual(state().clues.map(c => c.ans), ['yes', 'no']);
  passed('yes/no answers sync clues and extinguish candles');

  await click(player, '[data-t=guess]');
  const names = await player.locator('.gentry .gname').allTextContents();
  assert.equal(names.length, 48);
  await click(player, '[data-g=go][data-name="Dracula"]');
  await player.locator('.leaf.text .stats').waitFor();
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
  await click(player, '[data-t=guess]'); await guidePick(player, secretName);
  await wait(() => state().round === 2);
  assert.equal(state().players[playerId].score, 1);
  await player.locator('#reveal:not(.hidden)').waitFor();
  await host.locator('#reveal:not(.hidden)').waitFor();
  assert.equal(await player.locator('#revealHead').textContent(), secretName);
  assert.match(await host.locator('#board').textContent(), /👑/);
  passed('refresh preserves identity/seat/score; correct guess +2, shared reveal, leader crown');
  await click(host, '#revealClose'); await click(player, '#revealClose');

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

  const gameId = state().gameId;
  await click(host, '#newGameBtn'); await confirm(host);
  await wait(() => state().gameId !== gameId);
  assert.equal(state().hostUid, hostId);
  assert.equal(state().hostMode, true);
  assert.ok(Object.values(state().players).every(p => p.score === 0));
  if (await host.locator('#hostPanel').isVisible()) await click(host, '#finishSetup');
  await host.locator('[data-act=draw]').waitFor();
  await click(host, '[data-act=draw]'); await wait(() => state().drawn);
  await click(host, '[data-t=yes]'); await wait(() => state().questions === 1);
  passed('new game resets scores, retains host/mode, invalidates old secrets and answer guards');

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

  assert.deepEqual(errors, []); assert.deepEqual(brokenImages, []);
  console.log(`${checks} browser checks passed; no uncaught errors or missing requested images.`);
} finally { await browser.close(); await new Promise(r => server.close(r)); }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { pictureMaps, slug } from '../scripts/extract-images.mjs';
import * as monsters from '../js/monsters.js';
import { makeSession, normalizeCode, randomCode } from '../js/store.js';
import { completeRound, roundPlan } from '../js/rounds.js';

const root = new URL('../', import.meta.url);
const reference = await readFile(new URL('reference/mystery-monster-scorekeeper.html', root), 'utf8');
const dataDeclaration = key => reference.match(new RegExp(`const ${key} = (${['TRAIT_LABELS', 'TRAIT_WORDS'].includes(key) ? '.*?' : '\\{[\\s\\S]*?\\n\\}'});`))[1];
for (const key of ['MONSTER_INFO', 'MONSTER_STATS', 'TRAIT_LABELS', 'TRAIT_WORDS', 'ALIASES']) {
  test(`${key} matches the reference exactly`, () => {
    assert.deepEqual(monsters[key], JSON.parse(JSON.stringify(vm.runInNewContext(`(${dataDeclaration(key)})`))));
  });
}
test('extracted JPEGs match embedded originals except custom poster overrides', async () => {
  const maps = pictureMaps(reference);
  assert.equal(monsters.MONSTER_POSTERS.Dracula, 'images/posters/dracula-full.jpg');
  assert.equal(monsters.MONSTER_POSTERS.Kelpie, 'images/posters/kelpie.jpg');
  assert.equal(monsters.MONSTER_POSTERS.Doppelgänger, 'images/posters/changeling.jpg');
  assert.equal(monsters.MONSTER_POSTERS.Changeling, 'images/posters/doppelganger.jpg');
  assert.equal(monsters.MONSTER_PICS.Changeling, 'images/portraits/changeling.jpg');
  assert.equal(monsters.MONSTER_PICS.Kelpie, 'images/portraits/kelpie.jpg');
  for (const [key, map] of Object.entries(maps)) {
    assert.equal(Object.keys(map).length, 28);
    assert.deepEqual(Object.keys(monsters[key]).slice(0, Object.keys(map).length), Object.keys(map));
    for (const [name, uri] of Object.entries(map)) {
      const bytes = await readFile(new URL(monsters[key][name], root));
      if (key !== 'MONSTER_POSTERS' || !['Dracula', 'Doppelgänger'].includes(name)) {
        assert.deepEqual(bytes, Buffer.from(uri.split(',')[1], 'base64'), name);
      }
      assert.equal(bytes.readUInt16BE(0), 0xffd8);
      assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9);
    }
    for (const [name, path] of Object.entries(monsters[key])) {
      const bytes = await readFile(new URL(path, root));
      assert.equal(bytes.readUInt16BE(0), 0xffd8, `${key}.${name} JPEG start`);
      assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9, `${key}.${name} JPEG end`);
    }
  }
});
test('browser image variants exist, preserve monster mappings, and reduce download bytes', async () => {
  let sourceBytes = 0, webBytes = 0;
  for (const [originals, optimized] of [[monsters.MONSTER_PICS, monsters.MONSTER_WEB_PICS], [monsters.MONSTER_POSTERS, monsters.MONSTER_WEB_POSTERS]]) {
    assert.deepEqual(Object.keys(optimized), Object.keys(originals));
    for (const [name, path] of Object.entries(originals)) {
      assert.equal(optimized[name], path.replace('images/', 'images/optimized/').replace(/\.jpg$/, '.webp'));
      const original = await readFile(new URL(path, root));
      const web = await readFile(new URL(optimized[name], root));
      assert.equal(web.toString('ascii', 0, 4), 'RIFF');
      assert.equal(web.toString('ascii', 8, 12), 'WEBP');
      sourceBytes += original.length;
      webBytes += web.length;
    }
  }
  assert.ok(webBytes < sourceBytes * 0.5, `Browser images use ${webBytes} of ${sourceBytes} original bytes`);
});
test('slug examples and non-ASCII accents', () => {
  assert.equal(slug("Frankenstein's monster"), 'frankensteins-monster');
  assert.equal(slug("Will-o'-the-wisp"), 'will-o-the-wisp');
  assert.equal(slug('Doppelgänger'), 'doppelganger');
});
test('original styles remain intact and runtime assets contain no old host calls or embedded images', async () => {
  const css = await readFile(new URL('css/style.css', root), 'utf8');
  assert.ok(css.startsWith(reference.match(/<style>([\s\S]*?)<\/style>/)[1]));
  let size = 0;
  for (const path of ['index.html', 'css/style.css', 'js/app.js', 'js/store.js', 'js/monsters.js', 'js/firebase-config.js']) {
    const text = await readFile(new URL(path, root), 'utf8');
    assert.doesNotMatch(text, /window\.claude|claude\.use|data:image\/jpeg;base64/);
    size += Buffer.byteLength(text);
  }
  assert.ok(size < 200_000, `Runtime page and code total ${size} bytes`);
});
test('original synthesized sound effects and persistent sound toggle are unchanged', async () => {
  const app = await readFile(new URL('js/app.js', root), 'utf8');
  const soundBlock = text => text.slice(text.indexOf('// ---------- sound ----------'), text.indexOf('const $ ='));
  assert.equal(soundBlock(app), soundBlock(reference));
});
test('room codes exclude lookalikes and accept lowercase invites', () => {
  assert.equal(normalizeCode(' abc234 '), 'ABC234');
  for (const code of ['ABC', 'ABC123', 'ABCO23', '../ABC', 'ABC230']) assert.throws(() => normalizeCode(code));
  for (let i = 0; i < 100; i++) assert.match(randomCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
});

// A Firestore API test double. Browser tests exercise the UI with this same
// recursive-merge contract; actual authorization is covered by rules.test.mjs.
export function merge(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? (Object.keys(value).length ? merge(base?.[key] || {}, value) : {}) : value;
  }
  return result;
}
function fixture() {
  const docs = new Map(), calls = [];
  const snapshot = ref => ({ exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) });
  const sdk = {
    doc: (_, ...parts) => parts.join('/'),
    async setDoc(ref, data, options) {
      calls.push({ ref, data, options });
      docs.set(ref, options?.merge ? merge(docs.get(ref), data) : structuredClone(data));
    },
    onSnapshot(ref, cb) { cb(snapshot(ref)); return () => {}; },
    async runTransaction(_, fn) { return fn({ get: async ref => snapshot(ref), set: (ref, data, opts) => sdk.setDoc(ref, data, opts) }); },
  };
  return { docs, calls, sdk, session: uid => makeSession(sdk, {}, { uid }) };
}
test('room creation, joining, refresh, path mapping, merge, null removal, and reset metadata', async () => {
  const f = fixture(), host = f.session('host');
  const code = await host.createRoom({ round: 1 }, 'Pumpkin');
  assert.equal((await host.user.me()).isOwner, true);
  const original = structuredClone(f.docs.get(`rooms/${code}`));
  const player = f.session('player');
  await player.joinRoom(code.toLowerCase(), 'Ghost');
  assert.equal((await player.user.me()).isOwner, false);
  await player.db.doc('game/state').update({ players: { player: { score: 2 } }, used: ['Dracula'], pending: null });
  const state = f.docs.get(`rooms/${code}`);
  assert.equal(state.players.player.name, 'Ghost');
  assert.equal(state.players.host.name, 'Pumpkin');
  assert.deepEqual(f.calls.at(-1).options, { merge: true });
  const refreshed = f.session('player');
  await refreshed.joinRoom(code, 'Ghost again');
  assert.equal(f.docs.get(`rooms/${code}`).players.player.score, 2);
  assert.equal((await refreshed.user.profiles(['player'])).player.name, 'Ghost again');
  await refreshed.db.doc('game/state').update({ players: { player: null }, used: [] });
  assert.equal(f.docs.get(`rooms/${code}`).players.player, null);
  assert.deepEqual(f.docs.get(`rooms/${code}`).used, []);
  await host.db.doc('game/monsters').set({ list: ['Ghost'] });
  await host.db.doc('data/users/host/secret').set({ name: 'Ghost' });
  assert.equal(f.calls.at(-1).ref, `rooms/${code}/secrets/host`);
  assert.throws(() => host.db.doc('data/users/player/secret'));
  assert.equal(f.docs.get(`rooms/${code}/config/monsters`).list[0], 'Ghost');
  await host.db.doc('game/state').set({ round: 1, players: {} });
  assert.equal(f.docs.get(`rooms/${code}`).hostUid, 'host');
  assert.equal(f.docs.get(`rooms/${code}`).createdAt, original.createdAt);
  let exists;
  const off = host.db.doc('game/state').onSnapshot(snap => { exists = snap.exists; });
  assert.equal(exists, true); off();
});
test('missing rooms and invalid paths fail without creating a game', async () => {
  const f = fixture(), player = f.session('player');
  await assert.rejects(player.joinRoom('ABC234', 'Guest'), /No game/);
  assert.equal(f.docs.size, 0);
  assert.throws(() => player.db.doc('game/state'), /Join a room/);
});
test('room creation retries a collision without overwriting an existing room', async () => {
  const f = fixture(), originalRun = f.sdk.runTransaction;
  let attempt = 0;
  f.sdk.runTransaction = async (_, fn) => {
    if (attempt++ === 0) return fn({ get: async () => ({ exists: () => true }), set: () => assert.fail('Collision overwritten') });
    return originalRun(_, fn);
  };
  await f.session('host').createRoom({}, 'Host');
  assert.equal(attempt, 2);
  assert.equal(f.docs.size, 1);
});

test('round completion rejects stale results, late correct guesses, and duplicate timeouts', async () => {
  const f = fixture(), host = f.session('host');
  const code = await host.createRoom({ gameId: 'game', round: 1, turn: 0, drawn: true, roundDeadline: Date.now() - 1000 }, 'Pumpkin');
  const path = `rooms/${code}`;
  const expected = { gameId: 'game', round: 1, turn: 0, monsterId: 'host', roundDeadline: f.docs.get(path).roundDeadline };
  const patch = { round: 2, drawn: false, roundDeadline: null, players: { host: { score: 3 } }, lastRound: { outcome: 'stump', timedOut: true } };
  assert.equal(await host.finishRound(expected, { ...patch, lastRound: { outcome: 'right' } }), false);
  assert.equal(await host.finishRound({ ...expected, gameId: 'old' }, patch, true), false);
  assert.equal(await host.finishRound(expected, patch, true), true);
  assert.equal(await host.finishRound(expected, patch, true), false);
  assert.equal(f.docs.get(path).players.host.score, 3);
  assert.equal(f.docs.get(path).players.host.name, 'Pumpkin');
  const state = { ...f.docs.get(path), round: 3, turn: 0, drawn: true, roundDeadline: Date.now() + 600000 };
  f.docs.set(path, state);
  const active = { ...expected, round: 3, roundDeadline: state.roundDeadline };
  assert.equal(await host.finishRound(active, patch, true), false);
  assert.equal(await host.finishRound(active, { ...patch, round: 4, lastRound: { outcome: 'right' } }), true);
  f.docs.set(path, { ...state, roundDeadline: null });
  assert.equal(await host.finishRound({ ...active, roundDeadline: null }, patch, true), false);
});

test('round count covers every player, includes late arrivals, and chooses unserved monsters first', () => {
  const players = { a: { name: 'A', joinedAt: 1, score: 0 }, b: { name: 'B', joinedAt: 2, score: 0 }, c: { name: 'C', joinedAt: 3, score: 0 } };
  let state = { players, round: 1, totalRounds: 1, monsterId: 'a', monsterTurns: [] };
  assert.equal(roundPlan(state).total, 3);
  let patch = completeRound(state, {});
  assert.equal(patch.gameResult, null);
  assert.equal(patch.monsterId, 'b');
  assert.equal(patch.totalRounds, 3);
  state = { ...state, ...patch, round: 3, monsterId: 'a' }; // Host manually repeats a monster.
  patch = completeRound(state, {});
  assert.equal(patch.totalRounds, 5);
  assert.equal(patch.monsterId, 'b');
  assert.equal(patch.gameResult, null);
  state = { ...state, ...patch };
  patch = completeRound(state, {});
  assert.equal(patch.monsterId, 'c');
  state = { ...state, ...patch };
  patch = completeRound(state, { players: { c: { score: 3 } } });
  assert.equal(patch.gameResult.winners[0].id, 'c');
  assert.equal(patch.gameResult.score, 3);
  assert.equal(patch.round, 5);
  assert.equal(patch.monsterId, null);
  const late = { ...state, players: { ...players, d: { name: 'D', joinedAt: 4, score: 0 } } };
  const extended = completeRound(late, {});
  assert.equal(extended.gameResult, null);
  assert.equal(extended.monsterId, 'd');
  assert.equal(extended.totalRounds, 6);
});
test('final winners include final-round points and all ties, including negative scores', () => {
  const state = { round: 2, totalRounds: 2, monsterId: 'b', monsterTurns: ['a'], players: {
    a: { name: 'A', joinedAt: 1, score: 2 }, b: { name: 'B', joinedAt: 2, score: 0 } } };
  assert.deepEqual(completeRound(state, { players: { b: { score: 2 } } }).gameResult.winners.map(p => p.id), ['a', 'b']);
  const result = completeRound(state, { players: { a: { score: -2 }, b: { score: -1 } } }).gameResult;
  assert.equal(result.winners[0].name, 'B');
  assert.equal(result.score, -1);
});

test('only the host can end a game early and the result uses current scores', async () => {
  const f = fixture(), host = f.session('host');
  const code = await host.createRoom({ gameId: 'early', round: 2, drawn: true, roundDeadline: Date.now() + 50000 }, 'Pumpkin');
  const player = f.session('player'); await player.joinRoom(code, 'Ghost');
  await host.db.doc('game/state').update({ players: { player: { score: 4 } } });
  assert.equal(await player.endGame('early'), false);
  assert.equal(await host.endGame('stale'), false);
  assert.equal(await host.endGame('early'), true);
  const state = f.docs.get(`rooms/${code}`);
  assert.equal(state.gameResult.winners[0].name, 'Ghost');
  assert.equal(state.gameResult.endedEarly, true);
  assert.equal(state.roundDeadline, null);
  assert.equal(state.monsterId, null);
  assert.equal(await host.endGame('early'), false);
});

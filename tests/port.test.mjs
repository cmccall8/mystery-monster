import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { pictureMaps, slug } from '../scripts/extract-images.mjs';
import * as monsters from '../js/monsters.js';
import { makeSession, normalizeCode, randomCode } from '../js/store.js';

const root = new URL('../', import.meta.url);
const reference = await readFile(new URL('reference/mystery-monster-scorekeeper.html', root), 'utf8');
const dataDeclaration = key => reference.match(new RegExp(`const ${key} = (${['TRAIT_LABELS', 'TRAIT_WORDS'].includes(key) ? '.*?' : '\\{[\\s\\S]*?\\n\\}'});`))[1];
for (const key of ['MONSTER_INFO', 'MONSTER_STATS', 'TRAIT_LABELS', 'TRAIT_WORDS', 'ALIASES']) {
  test(`${key} matches the reference exactly`, () => {
    assert.deepEqual(monsters[key], JSON.parse(JSON.stringify(vm.runInNewContext(`(${dataDeclaration(key)})`))));
  });
}
test('all 56 extracted JPEGs match the embedded originals byte for byte', async () => {
  const maps = pictureMaps(reference);
  for (const [key, map] of Object.entries(maps)) {
    assert.equal(Object.keys(map).length, 28);
    assert.deepEqual(Object.keys(monsters[key]), Object.keys(map));
    for (const [name, uri] of Object.entries(map)) {
      const bytes = await readFile(new URL(monsters[key][name], root));
      assert.deepEqual(bytes, Buffer.from(uri.split(',')[1], 'base64'), name);
      assert.equal(bytes.readUInt16BE(0), 0xffd8);
      assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9);
    }
  }
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

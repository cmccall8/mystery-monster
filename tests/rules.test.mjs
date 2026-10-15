// Run with the Firestore emulator; see tests/README.md.
import { test, before, after, beforeEach } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve(process.env.MM_TEST_TOOLS || '/tmp/mystery-monster-tools', 'package.json'));
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc } = require('firebase/firestore');
let env;
before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run these tests with firebase emulators:exec; no live project is used.');
  env = await initializeTestEnvironment({ projectId: 'demo-mystery-monster', firestore: {
    rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'),
  }});
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });
const db = uid => uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
const room = database => doc(database, 'rooms/ABC234');
async function create() { await setDoc(room(db('host')), { hostUid: 'host', players: {}, round: 1 }); }

test('anonymous Firebase identities can create only their own host role; unauthenticated access fails', async () => {
  await assertFails(getDoc(room(db())));
  await assertFails(setDoc(room(db()), { hostUid: 'host' }));
  await assertFails(setDoc(room(db('player')), { hostUid: 'host' }));
  await assertSucceeds(setDoc(room(db('host')), { hostUid: 'host' }));
});
test('shared room reads and player writes work, host reassignment and non-host deletion fail', async () => {
  await create();
  await assertSucceeds(getDoc(room(db('player'))));
  await assertSucceeds(setDoc(room(db('player')), { players: { player: { name: 'Ghost', score: 0 } } }, { merge: true }));
  await assertFails(updateDoc(room(db('player')), { hostUid: 'player' }));
  await assertFails(updateDoc(room(db('host')), { hostUid: 'player' }));
  await assertFails(deleteDoc(room(db('player'))));
  await assertSucceeds(deleteDoc(room(db('host'))));
});
test('only the host edits the monster list; signed-in players can read it', async () => {
  await create();
  await assertSucceeds(setDoc(doc(db('host'), 'rooms/ABC234/config/monsters'), { list: ['Dracula'] }));
  await assertSucceeds(getDoc(doc(db('player'), 'rooms/ABC234/config/monsters')));
  await assertFails(setDoc(doc(db('player'), 'rooms/ABC234/config/monsters'), { list: [] }));
  await assertFails(getDoc(doc(db(), 'rooms/ABC234/config/monsters')));
});
test('secrets are private even from the host', async () => {
  await create();
  await assertSucceeds(setDoc(doc(db('player'), 'rooms/ABC234/secrets/player'), { name: 'Dracula' }));
  await assertSucceeds(getDoc(doc(db('player'), 'rooms/ABC234/secrets/player')));
  await assertFails(getDoc(doc(db('host'), 'rooms/ABC234/secrets/player')));
  await assertFails(getDoc(doc(db('other'), 'rooms/ABC234/secrets/player')));
  await assertFails(setDoc(doc(db('host'), 'rooms/ABC234/secrets/player'), { name: 'Ghost' }));
  await assertFails(getDoc(doc(db(), 'rooms/ABC234/secrets/player')));
});

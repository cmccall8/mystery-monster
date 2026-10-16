import { firebaseConfig } from './firebase-config.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function normalizeCode(code) {
  const normalized = String(code).trim().toUpperCase();
  if (normalized.length !== 6 || [...normalized].some(c => !ALPHABET.includes(c))) {
    throw new Error('Enter a 6-character room code, using the letters and numbers in your invite.');
  }
  return normalized;
}
export function randomCode() {
  // Rejection sampling avoids bias without depending on Math.random().
  let code = '';
  const limit = 256 - (256 % ALPHABET.length);
  while (code.length < 6) {
    for (const byte of crypto.getRandomValues(new Uint8Array(12))) {
      if (byte < limit) code += ALPHABET[byte % ALPHABET.length];
      if (code.length === 6) break;
    }
  }
  return code;
}
export function savedPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Private browsing can disable storage. */ }
}

// Kept separate from SDK loading so the adapter can be tested against the same
// documented API without adding a runtime dependency or bundler.
export function makeSession(sdk, firestore, identity) {
  const { doc, setDoc, onSnapshot, runTransaction } = sdk;
  let code = null, room = null;
  const uid = identity.uid;
  const roomRef = () => doc(firestore, 'rooms', code);
  function requireRoom() { if (!code) throw new Error('Join a room first.'); }
  function pathRef(path) {
    requireRoom();
    if (path === 'game/state') return roomRef();
    if (path === 'game/monsters') return doc(firestore, 'rooms', code, 'config', 'monsters');
    if (path === `data/users/${uid}/secret`) return doc(firestore, 'rooms', code, 'secrets', uid);
    throw new Error('Unsupported game document path.');
  }
  function remember(name) {
    savePreference('mm-name', name); savePreference('mm-room', code);
  }
  const session = {
    get code() { return code; },
    db: {
      doc(path) {
        const ref = pathRef(path);
        return {
          onSnapshot(cb, errCb) {
            return onSnapshot(ref, snap => {
              if (path === 'game/state') room = snap.exists() ? snap.data() : null;
              cb({ exists: snap.exists(), data: () => snap.data() });
            }, errCb);
          },
          async set(data) {
            // Starting a new game replaces state, never the immutable host role.
            if (path === 'game/state') {
              if (!room) throw new Error('This room no longer exists.');
              data = { ...data, hostUid: room.hostUid, createdAt: room.createdAt };
            }
            await setDoc(ref, data);
          },
          async update(data) {
            // Firestore's recursive merge retains nested player data and stores
            // null tombstones, while arrays are replaced as in the reference.
            await setDoc(ref, data, { merge: true });
          },
        };
      },
    },
    user: {
      async me() { return { id: uid, isOwner: uid === room?.hostUid, canEdit: false }; },
      async profiles(ids) {
        return Object.fromEntries(ids.map(id => [id, {
          name: room?.players?.[id]?.name || 'Someone', avatarUrl: null,
        }]));
      },
    },
    async finishRound(expected, patch, timedOut = false) {
      requireRoom();
      return runTransaction(firestore, async tx => {
        const ref = roomRef(), snap = await tx.get(ref);
        if (!snap.exists()) return false;
        const state = snap.data();
        if (state.gameId !== expected.gameId || state.round !== expected.round || state.monsterId !== expected.monsterId || state.turn !== expected.turn || (state.roundDeadline || null) !== expected.roundDeadline) return false;
        const expired = state.drawn && state.roundDeadline && Date.now() >= state.roundDeadline;
        if (timedOut ? !expired : patch.lastRound.outcome === 'right' && expired) return false;
        tx.set(ref, patch, { merge: true });
        return true;
      });
    },
    async createRoom(initialState, name) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = randomCode();
        const ref = doc(firestore, 'rooms', candidate);
        const state = {
          ...initialState, hostUid: uid, createdAt: Date.now(), monsterId: uid,
          players: { [uid]: { name, joinedAt: Date.now(), score: 0 } },
        };
        const created = await runTransaction(firestore, async tx => {
          const existing = await tx.get(ref);
          if (existing.exists()) return false;
          tx.set(ref, state); return true;
        });
        if (!created) continue;
        code = candidate; room = state; remember(name); return code;
      }
      throw new Error('Could not find an unused room code. Try creating a game again.');
    },
    async joinRoom(input, name) {
      const candidate = normalizeCode(input);
      const ref = doc(firestore, 'rooms', candidate);
      const state = await runTransaction(firestore, async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('No game has that room code. Check the code with your host.');
        const data = snap.data();
        const entry = data.players?.[uid]
          ? { ...data.players[uid], name }
          : { name, joinedAt: Date.now(), score: 0 };
        const patch = { players: { [uid]: entry } };
        if (!data.monsterId || !data.players?.[data.monsterId]) patch.monsterId = uid;
        tx.set(ref, patch, { merge: true });
        return { ...data, ...patch, players: { ...data.players, [uid]: entry } };
      });
      code = candidate; room = state; remember(name); return code;
    },
  };
  return session;
}

export async function connect() {
  if (!firebaseConfig.apiKey || Object.values(firebaseConfig).some(v => String(v).includes('YOUR_'))) {
    throw new Error('The host needs to add their Firebase Web app settings to js/firebase-config.js. See README.md for setup.');
  }
  // Exact SDK version; load failures also reach the app's Can't connect panel.
  const [appSDK, authSDK, firestoreSDK] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'),
  ]);
  const app = appSDK.initializeApp(firebaseConfig);
  const auth = authSDK.getAuth(app);
  await authSDK.setPersistence(auth, authSDK.browserLocalPersistence);
  // Wait for stored auth state before deciding whether a new identity is needed.
  const identity = await new Promise((resolve, reject) => {
    const unsubscribe = authSDK.onAuthStateChanged(auth, user => {
      unsubscribe();
      if (user) resolve(user);
      else authSDK.signInAnonymously(auth).then(result => resolve(result.user), reject);
    }, reject);
  });
  return makeSession(firestoreSDK, firestoreSDK.getFirestore(app), identity);
}

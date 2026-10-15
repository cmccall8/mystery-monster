# Mystery Monster: port to GitHub Pages + Firebase

You are porting a finished, working multiplayer Halloween party game to a standalone static site. The game already exists as a single HTML file built for a different host. Your job is to keep the game **exactly as it looks and plays today** while replacing the host-specific parts with GitHub Pages (hosting) and Firebase (live data and anonymous sign-in).

## Source of truth

`reference/mystery-monster-scorekeeper.html` is the original game. Read it in full before writing code. It contains all game logic, styling, sounds, monster data, and pictures (embedded as base64 JPEG data URIs). Do not redesign anything. Port it.

The reference file talks to its old host through `window.claude`. Every use of `window.claude` must be replaced. Nothing else about the game logic should need to change beyond what this document describes.

## Tech constraints

- Static site, no build step, no bundler, no npm runtime dependencies. It must run on GitHub Pages as plain files.
- Plain JavaScript ES modules (`<script type="module">`).
- Firebase JS SDK v10 (modular), loaded from `https://www.gstatic.com/firebasejs/10.x.x/` as ES modules. Pin an exact version.
- Firebase products: **Authentication (Anonymous provider only)** and **Cloud Firestore**.
- Fonts stay on Google Fonts (Pirata One, Figtree) as in the reference.
- `localStorage` is allowed (the old host blocked it). Use it for the sound on/off preference, the player's display name, and the last room code.

## Target repository layout

```
index.html               page markup (ported from the reference)
css/style.css            all styles from the reference, unchanged except where noted
js/firebase-config.js    exported Firebase config object (template with placeholders, see below)
js/store.js              Firebase adapter that mimics the old db/user API (see "Data layer")
js/monsters.js           monster data: MONSTER_INFO, MONSTER_STATS, ALIASES, picture paths
js/app.js                game logic ported from the reference
images/portraits/*.jpg   round portraits (from MONSTER_PICS in the reference)
images/posters/*.jpg     3:4 posters for the reveal card and Field Guide (from MONSTER_POSTERS)
scripts/extract-images.mjs  one-time Node script that pulls the base64 images out of the reference into files
firestore.rules          security rules (see below)
README.md                setup and deploy instructions for a non-developer
reference/mystery-monster-scorekeeper.html
```

## Step 1: extract the pictures

Write `scripts/extract-images.mjs` (Node 18+, no dependencies). It must:

1. Read `reference/mystery-monster-scorekeeper.html`.
2. Find the `MONSTER_PICS = { ... }` and `MONSTER_POSTERS = { ... }` object literals inside the script.
3. For each `"Monster name": "data:image/jpeg;base64,..."` entry, decode and write the JPEG to `images/portraits/<slug>.jpg` or `images/posters/<slug>.jpg`.
4. Slug rule: lowercase, strip accents (doppelgänger → doppelganger), replace any run of non `a-z0-9` with `-`, trim dashes. Example: `"Frankenstein's monster"` → `frankensteins-monster`, `"Will-o'-the-wisp"` → `will-o-the-wisp`.
5. Print the list of names written so the mapping can be checked.

Run it once and commit the images. In `js/monsters.js`, replace the base64 maps with path maps built from the same slug rule, for example `MONSTER_PICS["Dracula"] = "images/portraits/dracula.jpg"`. Only monsters that had a picture in the reference get an entry. Everything else keeps falling back to its emoji, exactly as today.

Move `MONSTER_INFO`, `MONSTER_STATS`, `TRAIT_LABELS`, `TRAIT_WORDS` and `ALIASES` into `js/monsters.js` unchanged and export them. The page size should drop from about 4 MB to well under 200 KB plus images.

## Step 2: rooms

The old host gave each copy of the game its own private database. On a public site, many groups may play at once, so every game lives in a **room** with a short code.

- Landing screen (styled like the rest of the game): **Create a game** or **Join a game** with a room code field.
- Room codes: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no lookalike characters). Create retries if the code already exists.
- The room code goes in the URL as `?room=CODE` so the host can paste one link into the Zoom chat. Opening that link skips the landing screen.
- Show the room code and a **Copy invite link** button in the header for the host.
- Whoever creates the room is the **host**. Their Firebase anonymous `uid` is stored as `hostUid` on the room.
- Before joining, a player enters a display name (prefilled from `localStorage`).

## Step 3: data layer

Write `js/store.js` that exposes the **same small API the reference already uses**, so `app.js` can stay close to the original:

```js
const db = {
  doc(path) {
    return {
      onSnapshot(cb, errCb) {},   // cb receives { exists, data() }
      async set(data) {},         // replace the whole document
      async update(data) {},      // deep-merge maps, replace arrays, keep null values as null
    };
  },
};
const user = {
  async me() {},                  // { id: uid, isOwner: uid === room.hostUid, canEdit: false }
  async profiles(ids) {},         // { [id]: { name, avatarUrl: null } } using names stored in the room
};
```

Implementation notes:

- `update(data)` must behave like the old host: **recursive merge of nested objects, arrays replaced wholesale, `null` stored as `null`**. Implement it as `setDoc(ref, data, { merge: true })`. Do **not** use `updateDoc` with nested objects, because Firestore replaces whole maps that way and you will lose players and scores.
- The reference removes a player by writing `players: { [id]: null }` and filtering falsy entries. Keep that behavior.
- Optional improvement: when a write only adds or removes points, use Firestore `increment()` for the score field.

Path mapping from the reference to Firestore:

| Reference path | Firestore path | Who can read and write |
|---|---|---|
| `game/state` | `rooms/{code}` | Everyone signed in |
| `game/monsters` | `rooms/{code}/config/monsters` | Everyone reads, host writes |
| `data/users/{me}/secret` | `rooms/{code}/secrets/{uid}` | Only that `uid` |

The room document keeps every field the reference keeps in `game/state` (`round`, `monsterId`, `questions`, `turn`, `drawn`, `used`, `log`, `lastRound`, `pending`, `clues`, `selfPick`, `maxQ`, `hostMode`, `players`) and adds `hostUid` and `createdAt`.

Player entries gain a `name` field: `players[uid] = { name, joinedAt, score }`. Players the host adds manually keep the reference behavior (`g-` id prefix, `guestName`). `nameOf()` should read `name` for real players and `guestName` for added players. Avatars become initials only.

## Step 4: replace `window.claude`

Search the reference for every `window.claude`, `claude.use`, `user.me`, and `user.profiles` use and route it through `store.js`.

- Host checks (`isHost = v.isOwner || v.canEdit`) become `uid === room.hostUid`.
- The reference shows a "Can't connect" panel when the host is missing. Show it if Firebase fails to initialize or sign in.
- Anonymous sign-in with `signInAnonymously`, and wait for `onAuthStateChanged` before subscribing. The same browser keeps its uid across refreshes, so refreshing keeps a player's seat and score.

Everything else stays as is, including: the guess auto-check that runs on the monster's own device, the reveal backfill in `afterChange`, the write queue (`enqueue`), the in-app confirm dialog, and the keyed rendering that avoids wiping inputs.

## Step 5: security rules

Put this in `firestore.rules`. This is a friendly party game, so players may write to the shared room (they must, to join and play). The rules protect three things: a player's secret monster, the host role, and the monster list.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{code} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.hostUid == request.auth.uid;
      allow update: if request.auth != null
        && request.resource.data.hostUid == resource.data.hostUid;
      allow delete: if request.auth != null
        && resource.data.hostUid == request.auth.uid;

      match /config/{docId} {
        allow read: if request.auth != null;
        allow write: if request.auth != null
          && get(/databases/$(database)/documents/rooms/$(code)).data.hostUid == request.auth.uid;
      }

      match /secrets/{uid} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
    }
  }
}
```

## Features that must survive the port

Test each of these against the reference before calling the work done:

1. Join flow, scoreboard with live scores, crown on the leader, monster badge only.
2. Turn order that skips the monster, the glowing pulsing **Make a guess** button on your turn.
3. Monster draws privately on their own device. Secret card blurs when the host is running the game from their screen. Monster sees their monster's stats card.
4. Yes/No answering by the monster, candles going out with the blow-out sound, clue list.
5. Field Guide: book-style overlay, alphabetical index with portraits, monster pages with poster, description and stats card, sticky top bar with **Back to all monsters** and previous/next arrows, wrong guesses crossed out for the round.
6. Guessing only through the Field Guide with a "Lock it in?" confirm. Correct is +2, wrong is −1 and a candle. Final guess when candles are out, Pass option.
7. Success card for everyone with the poster, plus the organ fanfare. "Nobody got it" card with the thunder sting and +3 to the monster.
8. Host tools: game mode switch (everyone on their own screen, or host runs it from their screen), skip turn, skip round, switch monster, questions per round (5, 10, 15), add players by name, monster list editing, start a new game. Host-run mode extras: blur and show, draw for a player or let them pick their own, Guessed it, Wrong guess, Pick their guess.
9. Sound toggle that remembers its setting.
10. Dark theme, mobile layout, safe-area padding, reduced-motion handling.

## README for the host

Write `README.md` for someone who is not a developer. Cover:

1. Create a Firebase project. Add a Web app and copy its config into `js/firebase-config.js`. Explain that this config is safe to be public and the rules protect the data.
2. In Authentication, enable the **Anonymous** sign-in provider.
3. Create a Firestore database in production mode, then paste `firestore.rules` into the Rules tab and publish.
4. In GitHub, put the files in a repository, open Settings, then Pages, and deploy from the `main` branch root.
5. In Firebase Authentication settings, add the GitHub Pages domain (for example `yourname.github.io`) to Authorized domains.
6. How to start a game, share the invite link, and become host.
7. How to add a monster: add entries to `MONSTER_INFO` and `MONSTER_STATS` in `js/monsters.js`, drop a square portrait into `images/portraits/` and a 3:4 poster into `images/posters/` named with the slug rule.
8. Don't push changes during a live game. Keep a second Firebase project for testing.

## Notes

- Keep all copy, labels, colors, fonts, sounds and animations identical to the reference unless this document says otherwise.
- Pictures are AI-generated art supplied by the game's owner. The Frankenstein's monster picture uses a well-known movie design, and Godzilla is a studio-owned character. Leave a note in the README that these may be worth replacing before sharing the site publicly.
- Do not add analytics, ads, or third-party scripts beyond Firebase and Google Fonts.

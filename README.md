# 🎃 Mystery Monster

A Halloween guessing game for a group on Zoom or in the same room. One player secretly draws a monster; everyone else asks yes/no questions and guesses through the Monster Field Guide. Correct guesses earn **2 points**. Wrong guesses cost **1 point** and a candle. If nobody gets it, the monster earns **3 points**.

The site uses plain HTML, CSS and JavaScript. There is **no build step, npm install, or application server**. GitHub Pages serves the files; Firebase keeps each room in sync.

## Set up Firebase once

1. Open the [Firebase console](https://console.firebase.google.com/) and create a project. You do not need Google Analytics for this game.
2. On the project's overview page, choose **Add app → Web** (the `</>` icon). Give it a nickname. You do not need Firebase Hosting.
3. Copy the Web app's Firebase configuration into [`js/firebase-config.js`](js/firebase-config.js), replacing every `YOUR_…` placeholder. You can find this again under **Project settings → General → Your apps → SDK setup and configuration → Config**. Keep the `export const firebaseConfig = …` wrapper in the file.
4. Under **Build → Authentication**, choose **Get started**, then **Sign-in method → Anonymous → Enable → Save**. No other sign-in provider is needed.
5. Under **Build → Firestore Database**, choose **Create database**, choose a location, and select **Production mode**. Use the default database.
6. Open Firestore's **Rules** tab, replace its contents with [`firestore.rules`](firestore.rules), and click **Publish**. This is a required step.
7. In **Authentication → Settings → Authorized domains**, add your GitHub Pages hostname, such as `yourname.github.io`. Use only the hostname, without `https://` or the repository path. For local testing, also add `localhost` if it is not already listed.

The Web app config is safe to be public: it identifies your Firebase project and is not an administrator password. The rules protect each player's secret, prevent changing the host, and reserve monster-list editing for the host. The shared room is intentionally writable by signed-in players, as needed by this friendly party game. Share room links with your group.

Use a **second Firebase project for testing** so test games do not affect a party. Keep service account credentials out of this repository; the game never needs them.

## Put the game on GitHub Pages

1. Put this repository's files on the `main` branch of your GitHub repository, keeping `index.html` in its top folder.
2. Open the repository's **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Choose **main**, choose **/ (root)**, and click **Save**.
5. Wait for GitHub to display your published site address. It will usually be `https://yourname.github.io/mystery-monster/`.
6. Check that the hostname is in Firebase's Authorized domains list, then open the site.

Do not push changes during a live game. Players should use the published site rather than opening `index.html` directly from their computer.

## Play

- Enter your display name and choose **Create a game**. You become that room's host and its first monster.
- Use **Copy invite link** in the header and paste it into your Zoom chat. Players open the link, enter a name, and join. They can also open the site and enter the six-character room code.
- Draw your secret monster on your own device. Keep that screen private. Players take turns asking questions out loud; the monster taps **Yes** or **No**. Each answer extinguishes a candle.
- On your turn, choose **Make a guess**, open a monster's page in the Field Guide, and confirm **Lock it in**. After the candles go out, there is one final guess or a **Pass**.
- Use **Rule out** in the Field Guide to grey out and cross off possibilities in your own view. **Undo rule out** restores them. These private notes stay while you close and reopen the guide and clear next round (or on refresh). Wrong guesses remain crossed out for everyone. The round timer stays visible beside the open guide, or above it on phones.
- Choose **Create a game** to open **Room setup**, set the game mode, candle count, and monster list, then choose **Create room**. You join automatically; other players join through your invite link. Choose a game mode: **Casual** has unlimited time, **Easy** gives 10 minutes, **Normal** (the default) gives 7 minutes, **Hard** gives 5 minutes, and **Extreme** gives 2 minutes. Each round’s countdown starts when the monster is drawn and is visible to everyone. When time runs out, the monster wins +3 points. Refreshing keeps the same deadline. Modes can be changed between rounds. **Round count** defaults to 10 and automatically increases if needed so every player gets at least one turn as the monster, including players joining during the game. At the end, everyone sees the winner (or tied winners) and final score. The in-game **Host controls** let the host skip a turn, end the game early and announce the current winner, or start a new game. Use **View results** to reopen the popup, or **Room setup → Start a new game** to play again. Opening the Field Guide plays a short page-turn sound when sound is enabled. During play, the host can open **Room setup** from the header to change settings, skip turns or rounds, switch monsters, or reset scores.
- For a shared screen, choose **I run it from my screen**. The host operates everyone's buttons. Secret cards start blurred; use **Show** only when it is safe. Added players can draw through the host or pick their own monster privately from the Field Guide.
- Your sound preference, display name, and last room code are remembered on your device. Refreshing and joining the same room in the same browser preserves your anonymous identity, seat, and score. Keep using that browser profile to retain the host role. Clearing site data or switching browsers creates a different identity.

## Run locally

Use Node 18 or later only if you want to run the image extraction and validation scripts. Python 3 is sufficient to serve the site:

```sh
cd /path/to/mystery-monster
python3 -m http.server 8000 --bind 127.0.0.1
```

Open the local server in your browser. Configure the test Firebase project first. An unconfigured site shows **Can't connect to the game** with setup guidance. ES modules require an HTTP server, so do not double-click the HTML file.

The app loads the pinned Firebase **10.14.1** ES modules from `www.gstatic.com` and the original Pirata One and Figtree fonts from Google Fonts. A working game needs access to Firebase Authentication and Cloud Firestore (`identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `firestore.googleapis.com`), the SDK CDN, and the font domains (`fonts.googleapis.com`, `fonts.gstatic.com`). No analytics or additional third-party scripts are loaded.

## Add a monster

1. Add an entry to `MONSTER_INFO` in [`js/monsters.js`](js/monsters.js): its name, emoji, and description.
2. Add its `MONSTER_STATS` entry using the existing entries as a guide. The first eight values are type, origin, comes from, habitat, size, active time, weakness, and known-for text. The last seven are traits in `TRAIT_LABELS` order (`Y` yes, `N` no, `S` sometimes, `K` sort of, `U` unknown, `R` rarely).
3. Add a square JPEG portrait in `images/portraits/` and a 3:4 JPEG poster in `images/posters/`. Use lowercase names, remove accents and apostrophes, replace other punctuation/spaces with hyphens, and trim leading/trailing hyphens. Examples: `doppelganger.jpg`, `frankensteins-monster.jpg`, `will-o-the-wisp.jpg`.
4. Add the corresponding paths to `MONSTER_PICS` and `MONSTER_POSTERS` in `js/monsters.js`. Monsters without pictures use their emoji.
5. If a room already has an edited list, the host can choose **Restore the default list** to load the updated defaults.

The host can also add a name and description in Room setup; these room-specific additions use an emoji unless the site includes art for that exact name.

## Reference and checks

The original game is preserved in [`reference/mystery-monster-scorekeeper.html`](reference/mystery-monster-scorekeeper.html). The port retains its rendering, rules of play, styling, generated sounds, and monster data while replacing the old hosting integration.

To extract the original 28 portraits and 28 posters again (no dependencies):

```sh
node scripts/extract-images.mjs
```

The extracted files are included, so this is not needed to run the game. To check extraction fidelity, reference data, and the store adapter:

```sh
node --test tests/port.test.mjs
```

Browser and Firebase emulator test instructions are in [`tests/README.md`](tests/README.md). Live Firebase configuration and deployment must be verified against your own project before hosting a party.

The pictures are AI-generated art supplied by the game's owner. Frankenstein's monster uses a well-known movie design, and Godzilla is a studio-owned character; consider replacing those depictions before sharing the site publicly.

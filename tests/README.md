# Development validation

The app has no npm runtime dependencies or build. These optional tools are only for development tests.

## Dependency-free checks

From the repository root, with Node 18+:

```sh
node --test tests/port.test.mjs
```

This checks exact reference data, byte-for-byte extraction of all 56 JPEGs, preserved CSS, runtime size, room-code behavior, adapter path mapping and merge options, metadata preservation, collision retries, and missing-room errors.

## Browser game flows

Install the development tools outside the repository:

```sh
npm install --prefix /tmp/mystery-monster-tools playwright@1.64.1 firebase-tools@15.34.0 @firebase/rules-unit-testing@6.0.0 firebase@13.0.0
```

The browser test uses a system Chromium. Set `CHROMIUM_PATH` if yours is elsewhere:

```sh
MM_TEST_TOOLS=/tmp/mystery-monster-tools CHROMIUM_PATH=/usr/bin/chromium node tests/browser.mjs
```

The script starts and stops its own local HTTP server and launches separate browser profiles. It covers room entry, host controls, private card visibility, clues/candles, Field Guide navigation and guesses, scores and reveals, refresh persistence, host-run play, guests, new games, room isolation, sound preference, reduced motion, and mobile overflow. All application UI code and the real store adapter run; **only `connect()` is replaced** with an in-memory Firestore API test double. No production configuration file is changed. External requests are blocked in this harness, so it does not validate CDN access, Firebase sign-in, security rules, or live networking. Test-double privacy checks verify the UI; use the rules tests below to verify access control.

The browser suite was exercised with Node 24 and system Chromium. Firebase Tools 15 and the current rules test packages require a recent Node release (use Node 22+), and the Firestore emulator needs Java 21+.

## Firestore security rules

Use the same development tool installation, then run from the repository root:

```sh
MM_TEST_TOOLS=/tmp/mystery-monster-tools /tmp/mystery-monster-tools/node_modules/.bin/firebase emulators:exec --only firestore --project demo-mystery-monster --config tests/firebase.json 'node --test tests/rules.test.mjs'
```

This uses a demo project, never a live Firebase database. It tests authenticated room access, host ownership protection, host-only monster-list writes, and per-player secrets (including denial to the host). The emulator's first download needs `storage.googleapis.com`. In restricted cloud environments you may also need writable cache paths:

```sh
XDG_CONFIG_HOME=/tmp/mm-config FIREBASE_EMULATORS_PATH=/tmp/mm-emulators MM_TEST_TOOLS=/tmp/mystery-monster-tools /tmp/mystery-monster-tools/node_modules/.bin/firebase emulators:exec --only firestore --project demo-mystery-monster --config tests/firebase.json 'node --test tests/rules.test.mjs'
```

The initial cloud build could not run this suite because the network proxy denied the emulator download. These tests are included but must not be treated as passed until executed.

## Live Firebase acceptance check

Configure a separate test project using the main README, publish the rules, and serve the actual site without the browser test harness. Use two browser profiles (not merely two tabs, which share the same identity).

1. Create a room and join its invite on the second profile. Verify both scoreboards update, and only the creator sees Host tools.
2. Draw privately, answer Yes and No, make a wrong Field Guide guess and a correct guess. Verify −1 and +2, extinguished candles, crossed-out entries, and the reveal on both screens. Listen for the blow-out and organ sounds.
3. Reach the candle limit and Pass or guess wrong. Verify +3 to the monster and the thunder sting. Keep the monster's device connected so it can check guesses and backfill the reveal.
4. Refresh both profiles, enter the room again, and verify identity, host role and scores persist. Verify sound preference persists.
5. Exercise host-run mode: blur/show, guest draw, self-pick, Guessed it, Wrong guess, Pick their guess; then skip, switch monster, change question counts, edit the list, and start a new game.
6. Repeat the Field Guide and turn controls on a narrow mobile screen and with reduced motion enabled.

A passing in-memory browser test does not establish successful Firebase configuration or deployment. Test the live project before a party.

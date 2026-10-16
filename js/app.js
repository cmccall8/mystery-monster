import { MONSTER_INFO, MONSTER_PICS, MONSTER_POSTERS, MONSTER_STATS, TRAIT_LABELS, TRAIT_WORDS, ALIASES } from "./monsters.js";
import { connect, savedPreference } from "./store.js";


// Pictures for monsters, keyed by name. Monsters without one use their emoji.

// Taller versions of the pictures for the end-of-round card.

// Field-guide stats for each monster, to help players ask sharp questions and the monster answer them.
// [type, origin, comes from, habitat, size, active, weakness, known for, once human, can fly, near water, undead, solid body, can be seen, can talk]
// Trait codes: Y yes, N no, S sometimes, K sort of, U unknown, R rarely.



function statsHtml(name) {
  const s = MONSTER_STATS[name]; if (!s) return "";
  const rows = [["Type", s[0]], ["Origin", s[1]], ["Comes from", s[2]], ["Habitat", s[3]], ["Size", s[4]], ["Active", s[5]], ["Weakness", s[6], true], ["Known for", s[7], true]];
  const traits = TRAIT_LABELS.map((label, i) => {
    const v = s[8 + i], cls = v === "Y" ? "t-y" : v === "N" ? "t-n" : "t-m", icon = v === "Y" ? "✓" : v === "N" ? "✗" : "~";
    return `<li class="${cls}"><span class="ti" aria-hidden="true">${icon}</span>${esc(label)}${TRAIT_WORDS[v] ? `<span class="tv">${TRAIT_WORDS[v]}</span>` : ""}<span class="sr-only">${v === "Y" ? ": yes" : v === "N" ? ": no" : ""}</span></li>`;
  }).join("");
  return `<div class="stats"><p class="stats-title">Monster stats</p>
    <dl class="srows">${rows.map(([k, v, wide]) => `<div class="${wide ? "wide" : ""}"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    <ul class="traits">${traits}</ul></div>`;
}
const DEFAULT_MONSTERS = Object.keys(MONSTER_INFO);
let customDescs = {};
function info(name) {
  const d = MONSTER_INFO[name];
  return { emoji: d ? d[0] : "👹", pic: MONSTER_PICS[name] || null, poster: MONSTER_POSTERS[name] || null, desc: customDescs[name] || (d ? d[1] : "A mystery monster added by the host.") };
}
function artHtml(name) { const i = info(name); return i.pic ? `<img src="${i.pic}" alt="">` : esc(i.emoji); }
let seenLast, revealOpen = false, showGallery = false;
let turnMode = "choose", turnModeFor = null, lastTurnHtml = null, focusTurn = false;
const resolvedGuesses = new Set();
const DEFAULT_Q = 15;
const maxQ = () => (S && S.maxQ) || DEFAULT_Q;

let db = null, user = null, me = null, isHost = false, session = null;
let S = null, stateLoaded = false;
let monsters = DEFAULT_MONSTERS;
let secret = null;
let showSecret = false;
let profiles = {};
let backfilled = -1;
let renderSeq = 0;

// ---------- sound ----------
let audio = null, soundOn = true, prevQ = null, prevRound = null;
try { soundOn = localStorage.getItem("mm-sound") !== "off"; } catch (e) {}
function ensureAudio() {
  try {
    if (!audio) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; audio = new AC(); }
    if (audio.state === "suspended") audio.resume();
  } catch (e) { return null; }
  return audio;
}
document.addEventListener("pointerdown", () => { if (soundOn) ensureAudio(); }, { once: true });
function playBlowOut() {
  if (!soundOn || !audio || audio.state !== "running") return;
  const t = audio.currentTime;
  // a breath that snuffs the flame
  const len = Math.floor(audio.sampleRate * 0.6), buf = audio.createBuffer(1, len, audio.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const n = audio.createBufferSource(); n.buffer = buf;
  const bp = audio.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(1800, t); bp.frequency.exponentialRampToValueAtTime(300, t + 0.5);
  const ng = audio.createGain(); ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(0.35, t + 0.05); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  n.connect(bp).connect(ng).connect(audio.destination); n.start(t); n.stop(t + 0.6);
  // a falling ghostly wail
  const o = audio.createOscillator(); o.type = "sine";
  o.frequency.setValueAtTime(520, t + 0.15); o.frequency.exponentialRampToValueAtTime(180, t + 1.4);
  const lfo = audio.createOscillator(); lfo.frequency.value = 6;
  const lg = audio.createGain(); lg.gain.value = 12; lfo.connect(lg).connect(o.frequency);
  const og = audio.createGain(); og.gain.setValueAtTime(0.0001, t + 0.15);
  og.gain.exponentialRampToValueAtTime(0.18, t + 0.35); og.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
  o.connect(og).connect(audio.destination);
  o.start(t + 0.15); lfo.start(t + 0.15); o.stop(t + 1.55); lfo.stop(t + 1.55);
}
function organ(freq, start, dur, vol = 0.1) {
  const t = audio.currentTime + start;
  const g = audio.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
  g.gain.setValueAtTime(vol, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const lp = audio.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1600;
  const vib = audio.createOscillator(); vib.frequency.value = 5.5;
  const vg = audio.createGain(); vg.gain.value = freq * 0.006; vib.connect(vg);
  [[1, "sawtooth", 0.45], [2, "sine", 0.25], [0.5, "sine", 0.35]].forEach(([m, type, v]) => {
    const o = audio.createOscillator(); o.type = type; o.frequency.value = freq * m;
    vg.connect(o.frequency);
    const og = audio.createGain(); og.gain.value = v;
    o.connect(og).connect(lp); o.start(t); o.stop(t + dur + 0.05);
  });
  vib.start(t); vib.stop(t + dur + 0.05);
  lp.connect(g).connect(audio.destination);
}
function chime(freq, start, vol = 0.09) {
  const t = audio.currentTime + start;
  const o = audio.createOscillator(); o.type = "sine"; o.frequency.value = freq;
  const o2 = audio.createOscillator(); o2.type = "sine"; o2.frequency.value = freq * 2.76;
  const g = audio.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
  const g2 = audio.createGain(); g2.gain.value = 0.3;
  o.connect(g); o2.connect(g2).connect(g); g.connect(audio.destination);
  o.start(t); o2.start(t); o.stop(t + 1.7); o2.stop(t + 1.7);
}
function thunder(start, dur = 2.6, vol = 0.55) {
  const t = audio.currentTime + start;
  const len = Math.floor(audio.sampleRate * dur), buf = audio.createBuffer(1, len, audio.sampleRate), d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
  const n = audio.createBufferSource(); n.buffer = buf;
  const lp = audio.createBiquadFilter(); lp.type = "lowpass";
  lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(120, t + dur);
  const g = audio.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.06); g.gain.exponentialRampToValueAtTime(vol * 0.4, t + 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  n.connect(lp).connect(g).connect(audio.destination); n.start(t); n.stop(t + dur);
}
function playReveal(outcome) {
  if (!soundOn || !audio || audio.state !== "running") return;
  if (outcome === "right") {
    // a haunted organ fanfare climbing a minor chord, then a shimmer of bells
    [293.66, 349.23, 440, 587.33].forEach((f, i) => organ(f, i * 0.13, 1.6 - i * 0.1, 0.07));
    [1174.66, 1396.91, 1760, 2349.32].forEach((f, i) => chime(f, 0.55 + i * 0.1));
  } else if (outcome === "stump") {
    // a thunderclap and a sinister "dun, dun, DUNNN"
    thunder(0);
    organ(164.81, 0.15, 0.4, 0.11); organ(196, 0.15, 0.4, 0.07);
    organ(155.56, 0.6, 0.4, 0.11); organ(185, 0.6, 0.4, 0.07);
    [130.81, 155.56, 185, 92.5].forEach(f => organ(f, 1.05, 2.2, 0.08));
  }
}
function updateSoundBtn() {
  const b = document.getElementById("soundBtn");
  b.textContent = soundOn ? "🔊 Sound on" : "🔇 Sound off";
  b.setAttribute("aria-pressed", String(soundOn));
}
document.getElementById("soundBtn").onclick = () => {
  soundOn = !soundOn;
  try { localStorage.setItem("mm-sound", soundOn ? "on" : "off"); } catch (e) {}
  updateSoundBtn();
  if (soundOn && ensureAudio()) setTimeout(playBlowOut, 50);
};
updateSoundBtn();

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(msg) { $("toast").textContent = msg; clearTimeout(toast.t); toast.t = setTimeout(() => $("toast").textContent = "", 4500); }

function askConfirm(msg, okLabel = "Yes") {
  return new Promise(resolve => {
    const box = $("confirmBox"), ok = $("confirmOk"), cancel = $("confirmCancel");
    $("confirmMsg").textContent = msg; ok.textContent = okLabel;
    box.classList.remove("hidden"); ok.focus();
    const done = v => { box.classList.add("hidden"); ok.onclick = cancel.onclick = box.onclick = document.onkeydown = null; resolve(v); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    box.onclick = e => { if (e.target === box) done(false); };
    document.onkeydown = e => { if (e.key === "Escape") done(false); };
  });
}

let chain = Promise.resolve();
function enqueue(fn) {
  chain = chain.then(fn).catch(err => {
    console.error(err);
    toast(err && err.code === "invalid_argument"
      ? "That change is not allowed. Check the Firebase security rules."
      : "That didn't save. Try again.");
  });
  return chain;
}
const stateRef = () => db.doc("game/state");
const freshState = (players = {}, monsterId = null) => ({ gameId: crypto.randomUUID(), round: 1, monsterId, questions: 0, turn: 0, drawn: false, used: [], log: [], lastRound: null, pending: null, clues: [], selfPick: false, maxQ: DEFAULT_Q, hostMode: false, players });

// ---------- derived ----------
const players = () => (S && S.players) || {};
const order = () => Object.entries(players()).filter(([, p]) => p).sort((a, b) => a[1].joinedAt - b[1].joinedAt).map(([id]) => id);
const isGuest = id => typeof id === "string" && id.startsWith("g-");
const askers = () => order().filter(id => id !== S.monsterId);
function currentAsker() { const a = askers(); return a.length ? a[(S.round + S.turn) % a.length] : null; }
const iAmMonster = () => !!(S && me && S.monsterId === me);
const hostRun = () => !!(S && S.hostMode);
// Who works the buttons for a player: in host-run mode the host does everything; otherwise each player does, and the host covers added players.
function controls(id) { if (hostRun()) return isHost; return id === me || (isHost && isGuest(id)); }
const iDraw = () => !!(S && S.monsterId && controls(S.monsterId));
const canRun = () => !!(S && S.monsterId && players()[S.monsterId] && (isHost || iAmMonster()));
const joined = () => !!(me && players()[me]);
function roundSecret() { return secret && S && secret.gameId === S.gameId && secret.round === S.round && secret.forId === S.monsterId ? secret.name : null; }
function nameOf(id) {
  if (!id) return "Someone";
  if (isGuest(id)) return (players()[id] && players()[id].guestName) || "Guest";
  return (players()[id] && players()[id].name) || (profiles[id] && profiles[id].name) || "Someone";
}
function avatarHtml(id, lg) {
  const cls = "avatar" + (lg ? " lg" : "");
  return `<span class="${cls}" aria-hidden="true">${esc(nameOf(id).trim().charAt(0).toUpperCase() || "?")}</span>`;
}

// ---------- startup and rooms ----------
let setupOpen = false, setupQ = DEFAULT_Q, setupHostMode = false;
let requestedRoom = new URL(location.href).searchParams.get("room") || "";
$("displayName").value = savedPreference("mm-name") || "";
$("roomCode").value = requestedRoom || savedPreference("mm-room") || "";

function showEntry() {
  $("loading").classList.add("hidden");
  $("roomEntry").classList.remove("hidden");
  $("roomChoices").classList.toggle("hidden", !!requestedRoom);
  $("inviteJoin").classList.toggle("hidden", !requestedRoom);
  $("inviteNote").classList.toggle("hidden", !requestedRoom);
  $("inviteNote").textContent = requestedRoom ? `You're joining room ${requestedRoom.toUpperCase()}.` : "";
}
$("otherRoom").onclick = () => {
  requestedRoom = "";
  const url = new URL(location.href); url.searchParams.delete("room"); history.replaceState(null, "", url);
  showEntry();
};
async function enterRoom(create = false) {
  if (!session || !$("roomForm").reportValidity()) return;
  const name = $("displayName").value.trim();
  if (!name) { $("entryError").textContent = "Enter your display name."; return; }
  $("entryError").textContent = "";
  const buttons = [...$("roomForm").querySelectorAll("button"), $("finishSetup"), $("cancelSetup")]; buttons.forEach(b => b.disabled = true);
  try {
    if (create) {
      await session.createRoom({ ...freshState(), maxQ: setupQ, hostMode: setupHostMode }, name);
      await session.db.doc("game/monsters").set({ list: monsters, descs: customDescs });
    }
    else await session.joinRoom(requestedRoom || $("roomCode").value, name);
    [db, user] = [session.db, session.user];
    const v = await user.me(); me = v.id; isHost = v.isOwner;
    const url = new URL(location.href); url.searchParams.set("room", session.code); history.replaceState(null, "", url);
    setupOpen = false;
    $("hostPanel").classList.add("hidden");
    $("roomEntry").classList.add("hidden");
    $("inviteCode").textContent = session.code;
    $("inviteArea").classList.toggle("hidden", !isHost);
    stateRef().onSnapshot(snap => {
      S = snap.exists ? snap.data() : null;
      if (!S) { showUnavailable(new Error("This room no longer exists. Open the site without its room link to create a game.")); return; }
      isHost = me === S.hostUid; stateLoaded = true;
      $("inviteArea").classList.toggle("hidden", !isHost);
      afterChange();
    }, showUnavailable);
    db.doc("game/monsters").onSnapshot(snap => {
      const d = snap.exists ? snap.data() : null;
      monsters = d && Array.isArray(d.list) ? d.list : DEFAULT_MONSTERS;
      customDescs = (d && d.descs) || {}; render();
    }, showUnavailable);
    db.doc(`data/users/${me}/secret`).onSnapshot(snap => { secret = snap.exists ? snap.data() : null; afterChange(); }, showUnavailable);
  } catch (err) { $("entryError").textContent = err.message || "Couldn't join this game. Try again."; }
  finally { buttons.forEach(b => b.disabled = false); }
}
$("roomForm").onsubmit = e => { e.preventDefault(); enterRoom(); };
function showSetup() {
  setupOpen = true;
  $("hostPanel").classList.remove("hidden");
  $("roomChoices").classList.add("hidden");
  $("game").classList.add("hidden");
  $("finishSetup").textContent = S ? "Back to game" : "Create room";
  document.querySelectorAll(".liveTools").forEach(el => el.classList.toggle("hidden", !S));
  renderSetup();
}
function closeSetup() {
  setupOpen = false;
  $("hostPanel").classList.add("hidden");
  if (S) render(); else showEntry();
}
$("createRoom").onclick = () => { if ($("roomForm").reportValidity()) showSetup(); };
$("roomSetupBtn").onclick = showSetup;
$("finishSetup").onclick = () => S ? closeSetup() : enterRoom(true);
$("cancelSetup").onclick = closeSetup;
$("copyInvite").onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast("Invite link copied. Paste it into the Zoom chat."); }
  catch { toast(`Copy the address from your browser to invite players. Room: ${session.code}`); }
};
(async () => {
  try { session = await connect(); showEntry(); }
  catch (err) { showUnavailable(err); }
})();

function showUnavailable(err) {
  console.error(err);
  $("loading").classList.add("hidden"); $("game").classList.add("hidden"); $("roomEntry").classList.add("hidden");
  $("unavailable").classList.remove("hidden");
  $("connectionError").textContent = err?.message || "Check your connection and Firebase setup, then reload to try again.";
}

function afterChange() {
  // If the round ended before the drawer's name made it into the reveal, fill it in from the drawer's device.
  const lr = S && S.lastRound;
  if (lr && !lr.name && secret && secret.gameId === S.gameId && lr.round === secret.round && lr.monsterId === secret.forId && backfilled !== `${S.gameId}:${lr.round}`) {
    backfilled = `${S.gameId}:${lr.round}`;
    const name = secret.name;
    enqueue(() => stateRef().update({ lastRound: { name }, used: [...(S.used || []), name] }));
  }
  // The monster's own device checks guesses against the secret automatically.
  const pd = S && S.pending;
  if (pd && pd.type === "guess" && iDraw() && roundSecret() && !resolvedGuesses.has(pd.id)) {
    resolvedGuesses.add(pd.id);
    if (pd.name === roundSecret()) endRound("right", pd.by); else wrongGuess(pd);
  }
  if (S) {
    if (prevRound === S.round && prevQ !== null && S.questions > prevQ) playBlowOut();
    prevQ = S.questions; prevRound = S.round;
    const lrNum = S.lastRound ? S.lastRound.round : null;
    if (seenLast === undefined) seenLast = lrNum;
    else if (lrNum !== seenLast) {
      seenLast = lrNum;
      if (S.lastRound && (S.lastRound.outcome === "right" || S.lastRound.outcome === "stump")) { revealOpen = true; playReveal(S.lastRound.outcome); }
    }
  }
  render();
}

// ---------- render ----------
async function render() {
  if (!stateLoaded) return;
  const seq = ++renderSeq;
  if (user) {
    const ids = order().filter(id => !isGuest(id));
    if (me && !ids.includes(me)) ids.push(me);
    if (ids.length) profiles = await user.profiles(ids);
  }
  if (seq !== renderSeq) return;
  $("loading").classList.add("hidden");
  $("game").classList.toggle("hidden", setupOpen);

  const st = S || freshState();
  $("roundNum").textContent = st.round;
  const canJoin = !!me && !joined();
  $("joinTop").classList.toggle("hidden", !canJoin);
  $("joinBoard").classList.toggle("hidden", !canJoin);
  $("leaveBtn").classList.toggle("hidden", !joined());
  $("roomSetupBtn").classList.toggle("hidden", !isHost);
  $("hostPanel").classList.toggle("hidden", !isHost || !setupOpen);

  const lr = st.lastRound;

  // monster + secret
  const mId = st.monsterId && players()[st.monsterId] ? st.monsterId : null;
  $("monsterWho").innerHTML = mId
    ? `${avatarHtml(mId, true)}<div class="big"><strong>${esc(nameOf(mId))}</strong>${mId === me ? " (you)" : ""} is the monster</div>`
    : `<p class="muted">${order().length ? "No monster yet. The host can pick one in Room setup." : "Waiting for players to join."}</p>`;

  const sa = $("secretArea");
  if (mId && iDraw()) {
    const nm = roundSecret();
    const forGuest = mId !== me;
    if (!nm && st.selfPick) {
      sa.innerHTML = `<div class="secret"><p>${esc(nameOf(mId))} is picking their own monster from the Field Guide. Keep it secret! When someone guesses, ask them if it's right and mark it.</p>
        <div class="row" style="margin-top:12px"><button data-act="gallery">📖 Open the Field Guide</button></div></div>`;
    } else if (!nm) {
      sa.innerHTML = `<div class="secret"><p>${forGuest ? `Draw a monster for ${esc(nameOf(mId))} and send it to them privately, or let them pick their own so you can play along.` : "You're the monster! Draw your secret monster. Only you will see it."}</p>
        <div class="row" style="margin-top:12px"><button class="primary" data-act="draw">${forGuest ? "Draw a monster" : "Draw my monster"}</button>${forGuest ? `<button data-act="self">They'll pick their own</button>` : ""}</div></div>`;
    } else {
      const hideable = forGuest || hostRun();
      const blur = hideable && !showSecret;
      sa.innerHTML = `<div class="secret"><p class="muted">${forGuest ? `${esc(nameOf(mId))}'s monster` : "Your secret monster"}</p>
        <div class="secret-body ${blur ? "blurwrap" : ""}"><div class="secret-pic" aria-hidden="true">${artHtml(nm)}</div>
          <div><span class="name">${esc(nm)}</span><p class="desc">${esc(info(nm).desc)}</p>${statsHtml(nm)}</div></div>
        <div class="row">
          ${hideable ? `<button data-act="peek">${showSecret ? "Hide" : "Show"}</button>` : ""}${forGuest ? `<button data-act="copy">Copy</button>` : ""}
          ${st.questions === 0 ? `<button class="ghost" data-act="draw">Draw again</button>` : ""}
        </div></div>`;
    }
  } else if (mId) {
    sa.innerHTML = `<p class="muted">${st.drawn ? `${esc(nameOf(mId))} has a secret monster. Start asking!` : `Waiting for ${esc(nameOf(mId))} to draw a monster…`}</p>`;
  } else sa.innerHTML = "";

  // turn
  const asker = mId ? currentAsker() : null;
  const mq = maxQ();
  const tk = `${st.gameId}:${st.round}:${st.turn}:${asker}`;
  if (turnModeFor !== tk) { turnMode = "choose"; turnModeFor = tk; }
  const th = turnHtml(st, mId, asker, mq);
  if (th !== lastTurnHtml) {
    $("turnArea").innerHTML = th; lastTurnHtml = th;
    const f = $("askText") || $("guessText") || $("correctText");
    if (f && focusTurn) f.focus();
  }
  focusTurn = false;

  // candles
  const left = Math.max(0, mq - st.questions);
  $("qLeft").textContent = left;
  $("candles").style.gridTemplateColumns = `repeat(${mq}, 1fr)`;
  $("candles").innerHTML = Array.from({ length: mq }, (_, i) => `<div class="candle ${i >= left ? "out" : ""}"><span class="flame"></span></div>`).join("");

  // clues
  const clues = st.clues || [];
  $("clues").innerHTML = clues.map(c => `<li><span class="cn">${c.ans === "wrong" ? "✗" : "Q" + c.n}</span>
    <span class="ctext">${esc(nameOf(c.by))}${c.ans === "wrong" ? (c.guess ? ` guessed ${esc(c.guess)}` : " made a wrong guess") : c.text ? `: ${esc(c.text)}` : " asked"}</span>
    <span class="ans ${c.ans}">${c.ans === "yes" ? "Yes" : c.ans === "no" ? "No" : "Wrong"}</span></li>`).join("");
  $("cluesWrap").classList.toggle("hidden", !clues.length);
  const cl = $("clues"); cl.scrollTop = cl.scrollHeight;

  // board
  const ids = order();
  const sorted = [...ids].sort((a, b) => (players()[b].score || 0) - (players()[a].score || 0));
  const top = sorted.length ? players()[sorted[0]].score || 0 : 0;
  $("orderNote").classList.toggle("hidden", ids.length < 2);
  $("board").innerHTML = sorted.length ? sorted.map((id, i) => {
    const sc = players()[id].score || 0, lead = sc === top && top > 0;
    return `<li class="${lead ? "leader" : ""}">
      <span class="rank">${lead ? "👑" : i + 1}</span>
      ${avatarHtml(id)}
      <span class="pname">${esc(nameOf(id))}${id === mId ? '<span class="tag monster">monster</span>' : ""}</span>
      <span class="score">${sc}</span>
      ${isHost ? `<span class="hostctl">
        <button class="sm ghost" data-rm="${esc(id)}" aria-label="Remove ${esc(nameOf(id))}">✕</button></span>` : ""}
    </li>`;
  }).join("") : `<li class="empty">Nobody has joined yet. Share this page's link in the Zoom chat so everyone can join.</li>`;

  $("log").innerHTML = (st.log || []).map(e => {
    const t = e.k === "right" ? `${nameOf(e.id)} guessed it (+2)` : e.k === "wrong" ? `${nameOf(e.id)} guessed wrong (−1)`
      : e.k === "stump" ? `${nameOf(e.id)} stumped everyone (+3)` : "Round skipped";
    return `<p>Round ${e.r}: ${esc(t)}</p>`;
  }).join("");

  renderGuide();

  // success card
  const rv = $("reveal");
  if (revealOpen && lr) {
    const nm = lr.name, inf = nm ? info(nm) : null;
    const k = $("revealKicker");
    k.className = "card-kicker" + (lr.outcome === "stump" ? " stump" : "");
    k.textContent = lr.outcome === "right" ? `${nameOf(lr.winnerId)} guessed it! +2` : `Nobody got it! ${nameOf(lr.monsterId)} gets +3`;
    const ra = $("revealArt");
    ra.classList.toggle("poster", !!(inf && inf.poster));
    ra.innerHTML = inf ? (inf.poster ? `<img src="${inf.poster}" alt="">` : artHtml(nm)) : "❔";
    $("revealHead").textContent = nm || (lr.selfPick ? "A mystery!" : "Revealing…");
    $("revealDesc").textContent = inf ? inf.desc : lr.selfPick ? `Ask ${nameOf(lr.monsterId)} to reveal what it was.` : "";
    $("revealMeta").textContent = `Round ${lr.round} monster: ${nameOf(lr.monsterId)}`;
    if (rv.classList.contains("hidden")) { rv.classList.remove("hidden"); $("revealClose").focus(); }
  } else rv.classList.add("hidden");

  if (isHost) renderSetup();
}

function renderSetup() {
    document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.q === (S ? maxQ() : setupQ))));
    $("skipWho").textContent = currentAsker() ? `${nameOf(currentAsker())} is up${S?.pending ? " (waiting on the monster)" : ""}` : "Nobody is up right now";
    document.querySelectorAll(".modeseg button").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.mode === "host") === (S ? hostRun() : setupHostMode))));
    $("modeNote").textContent = (S ? hostRun() : setupHostMode)
      ? "You work every button from your screen. Players ask, answer and guess out loud on Zoom. Players join using the invite link."
      : "Players join from the link and use their own buttons. Their screens show their turn and keep their monster private.";
    $("skipTurnBtn").disabled = !currentAsker();
    const sel = $("monsterSelect"), keep = sel.value;
    const opts = order().map(id => `<option value="${esc(id)}">${esc(nameOf(id))}${id === S?.monsterId ? " (monster now)" : ""}</option>`).join("");
    if (sel.dataset.opts !== opts) {
      sel.innerHTML = opts; sel.dataset.opts = opts;
      if (keep && order().includes(keep)) sel.value = keep;
      else { const firstOther = order().find(id => id !== S?.monsterId); if (firstOther) sel.value = firstOther; }
    }
    $("setMonsterBtn").disabled = !order().length;
    const used = S?.used || [];
    $("monCount").textContent = `(${monsters.length}, ${monsters.filter(m => used.includes(m)).length} used)`;
    $("chips").innerHTML = monsters.map((m, i) => `<span class="chip ${used.includes(m) ? "used" : ""}">${esc(m)}<button data-mrm="${i}" aria-label="Remove ${esc(m)}">✕</button></span>`).join("");
}

// ---------- actions ----------
function join() {
  if (!me) return;
  enqueue(async () => {
    const entry = { name: savedPreference("mm-name") || "Player", joinedAt: Date.now(), score: 0 };
    if (!S) await stateRef().set(freshState({ [me]: entry }, me));
    else await stateRef().update({ players: { [me]: entry }, ...(S.monsterId && players()[S.monsterId] ? {} : { monsterId: me }) });
  });
  toast("You're in! Watch for your turn.");
}
$("joinTop").onclick = join; $("joinBoard").onclick = join;
$("leaveBtn").onclick = async () => { if (await askConfirm("Leave the game? Your score will be removed.", "Leave")) removePlayer(me); };

function removePlayer(id) {
  enqueue(async () => {
    const patch = { players: { [id]: null } };
    if (S.monsterId === id) {
      const o = order(), i = o.indexOf(id), rest = o.filter(x => x !== id);
      patch.monsterId = rest.length ? o.filter(x => x !== id)[i % rest.length] : null;
      patch.drawn = false; patch.questions = 0; patch.turn = 0; patch.pending = null; patch.clues = []; patch.selfPick = false;
    }
    await stateRef().update(patch);
  });
}

function adjust(id, d) {
  const p = players()[id]; if (!p) return;
  enqueue(() => stateRef().update({ players: { [id]: { score: (p.score || 0) + d } } }));
}

function draw() {
  const used = S.used || [], current = roundSecret();
  let pool = monsters.filter(m => !used.includes(m) && m !== current);
  if (!pool.length) pool = monsters.filter(m => m !== current);
  if (!pool.length) pool = monsters;
  if (!pool.length) { toast("The monster list is empty. Ask the host to add some."); return; }
  const name = pool[Math.floor(Math.random() * pool.length)];
  const gameId = S.gameId, round = S.round, forId = S.monsterId;
  showSecret = false;
  secret = { name, gameId, round, forId }; render();
  enqueue(() => db.doc(`data/users/${me}/secret`).set({ name, gameId, round, forId }));
  if (!S.drawn) enqueue(() => stateRef().update({ drawn: true }));
}

function turnHtml(st, mId, asker, mq) {
  if (!mId || !st.drawn) return "";
  const pend = st.pending, out = st.questions >= mq;
  const mName = esc(nameOf(mId));
  const canAnswer = controls(mId);
  if (pend && pend.type === "ask") {
    const by = esc(nameOf(pend.by)), q = pend.text ? `“${esc(pend.text)}”` : "";
    if (canAnswer) return `<div class="turnbox hot"><p><strong>${by}</strong> asks${q ? ":" : " a question out loud."}</p>${q ? `<p class="qtext">${q}</p>` : ""}
      <div class="row big"><button class="yes" data-t="yes">Yes</button><button class="no" data-t="no">No</button></div>
      <p class="muted">Say your answer out loud too, then tap it.</p></div>`;
    return `<div class="turnbox"><p><strong>${by}</strong> is asking${q ? `: <span class="qtext">${q}</span>` : " a question out loud."}</p>
      <p class="muted">Waiting for ${mName} to answer…</p>${pend.by === me || isHost ? `<div><button class="ghost" data-t="cancel">Cancel question</button></div>` : ""}</div>`;
  }
  if (pend && pend.type === "guess") {
    return `<div class="turnbox"><p><strong>${esc(nameOf(pend.by))}</strong> guessed <strong>${esc(pend.name)}</strong>…</p><p class="muted">Checking the answer…</p>
      ${isHost && (!iDraw() || !roundSecret()) ? `<p class="muted">${st.selfPick ? `Is it right? Ask ${mName} and mark it:` : `Stuck? Ask ${mName} out loud and mark it yourself:`}</p>
        <div class="row"><button data-t="mright">Right</button><button data-t="mwrong">Wrong</button><button class="ghost" data-t="cancel">Cancel</button></div>` : ""}</div>`;
  }
  if (!asker) return "";
  const aName = esc(nameOf(asker));
  const actFor = controls(asker);
  const proxy = canAnswer && (hostRun() || (isHost && isGuest(mId)));
  if (canAnswer && !(actFor && turnMode === "guess")) {
    const marks = proxy ? `<div class="row"><button data-t="right">✓ Guessed it</button><button data-t="wrongq">✗ Wrong guess</button>${actFor ? `<button class="ghost" data-t="guess">📖 Pick their guess</button>` : ""}</div>` : "";
    if (!out) return `<div class="turnbox hot"><p><strong>${aName}</strong> ${proxy ? "is up. They ask a question or make a guess out loud." : "is asking a question out loud."}</p>
      <div class="row big"><button class="yes" data-t="yes">Yes</button><button class="no" data-t="no">No</button></div>
      ${marks}
      <p class="muted">${proxy ? "Tap Yes or No for a question, or mark their guess." : "Answer out loud too, then tap. If they guess instead, the app checks it for you."}</p></div>`;
    return `<div class="turnbox hot"><p><strong>${aName}</strong> gets a final guess.</p>${marks || `<p class="muted">The app will check it for you.</p>`}</div>`;
  }
  if (!actFor) return `<div class="turnbox"><p class="turn">${aName} is up${out ? " for a final guess" : ""}.</p>
    <p class="muted">${out ? "The candles are out. One last chance!" : "They'll ask a yes/no question or make a guess."}</p></div>`;
  const head = asker === me ? (out ? "Last chance! The candles are out." : "Your turn!") : `${aName}'s turn (you're playing for them)${out ? ": final guess" : ""}`;
  let body;
  if (turnMode === "ask" && !out) body = `<label for="askText">Your question <span class="muted" style="font-weight:400">(optional: type it so it shows in the clues)</span></label>
    <input type="text" id="askText" maxlength="140" placeholder="Does it fly?" autocomplete="off">
    <div class="row"><button class="primary" data-t="sendAsk">Ask ${mName}</button><button class="ghost" data-t="back">Back</button></div>`;
  else if (turnMode === "guess") body = `<label for="guessText">Which monster is it?</label>
    <input type="text" id="guessText" maxlength="50" placeholder="Start typing a monster…" autocomplete="off">
    <div id="sugg" class="sugg"><span class="muted">Type at least 3 letters.</span></div>
    <p class="muted">Right is +2. Wrong is −1 ${out ? `and ${mName} wins the round` : "and a candle goes out"}.</p>
    <div><button class="ghost" data-t="back">Back</button></div>`;
  else body = `${out ? "" : `<p>Ask your yes/no question out loud. ${mName} will answer. Ready to guess? Pick from the Field Guide.</p>`}<div class="row big">
    <button class="glow ${out ? "primary" : ""}" data-t="guess">📖 Make a guess</button>
    ${out ? `<button class="ghost" data-t="pass">Pass (${mName} wins)</button>` : ""}</div>`;
  return `<div class="turnbox hot"><p class="turn mine">${head}</p>${body}</div>`;
}

function endRound(outcome, winnerId, extra = {}, baseLog = (S.log || []), nameOverride = null) {
  const name = nameOverride || roundSecret() || (outcome === "right" && S.pending && S.pending.type === "guess" ? S.pending.name : null);
  const o = order(), i = o.indexOf(S.monsterId);
  const next = o.length ? o[(i + 1) % o.length] : null;
  const pl = { ...extra };
  if (outcome === "right" && players()[winnerId]) pl[winnerId] = { score: (players()[winnerId].score || 0) + 2 };
  if (outcome === "stump" && players()[S.monsterId]) pl[S.monsterId] = { score: (players()[S.monsterId].score || 0) + 3 };
  const entry = { r: S.round, k: outcome, id: outcome === "right" ? winnerId : S.monsterId };
  const patch = {
    round: S.round + 1, monsterId: next, questions: 0, turn: 0, drawn: false,
    lastRound: { round: S.round, monsterId: S.monsterId, winnerId: winnerId || null, outcome, name: name || null, selfPick: !!S.selfPick },
    log: [entry, ...baseLog].slice(0, 40),
    pending: null, clues: [], selfPick: false,
    ...(Object.keys(pl).length ? { players: pl } : {}),
  };
  if (name) patch.used = [...(S.used || []), name];
  showSecret = false;
  enqueue(() => stateRef().update(patch));
}

$("secretArea").addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  if (b.dataset.act === "draw") draw();
  if (b.dataset.act === "self" && isHost) { enqueue(() => stateRef().update({ drawn: true, selfPick: true })); openGuide("browse"); }
  if (b.dataset.act === "gallery") openGuide("browse");
  if (b.dataset.act === "peek") { showSecret = !showSecret; render(); }
  if (b.dataset.act === "copy") {
    try { await navigator.clipboard.writeText(`Your monster is: ${roundSecret()}. Shh! 🤫`); toast("Copied. Paste it into a private Zoom chat."); }
    catch (err) { showSecret = true; render(); toast("Couldn't copy here, so the name is showing instead."); }
  }
});

// ---------- turns, questions and guesses ----------

const norm = s => String(s).toLowerCase().replace(/^(a|an|the)\s+/, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
function searchMonsters(q) {
  const n = norm(q); if (n.length < 3) return [];
  return monsters.filter(m => [m, ...(ALIASES[m] || [])].some(x => norm(x).includes(n))).slice(0, 6);
}
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function actingAsker() { const a = currentAsker(); return a && controls(a) ? a : null; }

// ---------- field guide ----------
let guideOpen = false, guideMode = "browse", guideView = null, lastGuideHtml = null, lastGuideView = undefined, indexScroll = 0;
function guideList() { return [...monsters].sort((a, b) => norm(a).localeCompare(norm(b))); }
function ruledOut() { return S ? (S.clues || []).filter(c => c.ans === "wrong" && c.guess).map(c => c.guess) : []; }
function guideCanAct(mode = guideMode) {
  if (!S || !S.monsterId || !S.drawn || S.pending) return false;
  if (mode === "guess") return !!actingAsker();
  if (mode === "correct") return controls(S.monsterId) && !!currentAsker();
  return false;
}
function openGuide(mode = "browse") {
  guideMode = mode; guideView = null; guideOpen = true; lastGuideHtml = null; lastGuideView = undefined; indexScroll = 0;
  $("guide").classList.remove("hidden");
  renderGuide();
  $("guideClose").focus();
}
function closeGuide() { guideOpen = false; $("guide").classList.add("hidden"); }
function renderGuide() {
  if (!guideOpen) return;
  if (guideMode !== "browse" && !guideCanAct()) guideMode = "browse";
  const list = guideList(), out = ruledOut(), act = guideMode !== "browse";
  const asker = S ? currentAsker() : null;
  let banner = "";
  if (guideMode === "guess") banner = asker === me ? "Your turn: pick the monster you think it is. Right is +2, wrong is −1." : `Picking a guess for ${nameOf(asker)}. Right is +2, wrong is −1.`;
  if (guideMode === "correct") banner = `${nameOf(asker)} guessed it! Pick the monster they named.`;
  $("guideBanner").textContent = banner;
  $("guideBanner").classList.toggle("hidden", !banner);
  if (guideView && !list.includes(guideView)) guideView = null;
  let html;
  if (guideView) {
    const i = list.indexOf(guideView), m = guideView, inf = info(m), isOut = out.includes(m);
    const art = inf.poster ? `<img src="${inf.poster}" alt="">` : inf.pic ? `<img src="${inf.pic}" alt="">` : `<span class="emoji">${esc(inf.emoji)}</span>`;
    html = `<div class="guide-top">
        <button class="ghost" data-g="index">◂ Back to all monsters</button>
        <span class="row">
          <button class="ghost" data-g="go" data-name="${esc(list[(i - 1 + list.length) % list.length])}" aria-label="Previous monster">◂</button>
          <button class="ghost" data-g="go" data-name="${esc(list[(i + 1) % list.length])}" aria-label="Next monster">▸</button>
        </span>
      </div>
      <div class="spread">
      <div class="leaf art ${inf.poster ? "poster" : ""}" aria-hidden="true">${art}</div>
      <div class="leaf text">
        <p class="pnum">Page ${i + 1} of ${list.length}</p>
        <h3>${esc(m)}</h3>
        <p class="entry">${esc(inf.desc)}</p>
        ${isOut ? `<p class="ruled">✗ Already guessed wrong this round</p>` : ""}
        ${act && !isOut ? `<button class="primary" data-g="pick" data-name="${esc(m)}">${guideMode === "guess" ? "Guess this monster" : "This is the one"}</button>` : ""}
        ${statsHtml(m)}
        <div class="row nav">
          <button class="ghost" data-g="index">All monsters</button>
          <button class="ghost" data-g="go" data-name="${esc(list[(i - 1 + list.length) % list.length])}">◂ Previous</button>
          <button class="ghost" data-g="go" data-name="${esc(list[(i + 1) % list.length])}">Next ▸</button>
        </div>
      </div></div>`;
  } else {
    html = `<p class="intro">${list.length} monsters. ${act ? "Open a monster's page to choose it." : "Tap one to read its page."}</p>
      <div class="gindex">${list.map(m => { const isOut = out.includes(m);
        return `<button class="gentry ${isOut ? "out" : ""}" data-g="go" data-name="${esc(m)}"><span class="gpic" aria-hidden="true">${artHtml(m)}</span><span class="gname">${esc(m)}</span>${isOut ? '<span class="gx">Wrong</span>' : ""}</button>`; }).join("")}</div>`;
  }
  if (html === lastGuideHtml) return;
  const page = $("guidePage"), viewChanged = guideView !== lastGuideView, keep = page.scrollTop;
  page.innerHTML = html; lastGuideHtml = html;
  page.scrollTop = !viewChanged ? keep : guideView ? 0 : indexScroll;
  lastGuideView = guideView;
}
$("guideBtn").onclick = () => openGuide(guideCanAct("guess") ? "guess" : "browse");
$("guideClose").onclick = closeGuide;
$("guide").addEventListener("click", e => { if (e.target.id === "guide") closeGuide(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && guideOpen && $("confirmBox").classList.contains("hidden")) closeGuide(); });
$("guidePage").addEventListener("click", async e => {
  const b = e.target.closest("button[data-g]"); if (!b) return;
  const g = b.dataset.g;
  if (g === "go") { if (!guideView) indexScroll = $("guidePage").scrollTop; guideView = b.dataset.name; renderGuide(); return; }
  if (g === "index") { guideView = null; renderGuide(); return; }
  if (g === "pick") {
    const name = b.dataset.name, mode = guideMode;
    if (!guideCanAct(mode)) { renderGuide(); return; }
    const a = currentAsker();
    const msg = mode === "guess" ? `Lock in ${name} as ${a === me ? "your" : nameOf(a) + "'s"} guess?` : `${nameOf(a)} guessed ${name}. End the round?`;
    const ok = await askConfirm(msg, mode === "guess" ? "Lock it in" : "Yes, they got it");
    if (!ok || !guideCanAct(mode) || currentAsker() !== a) return;
    if (mode === "guess") submitGuess(name);
    else {
      const key = `${S.gameId}:${S.round}:${S.turn}`; if (answeredKey === key) return; answeredKey = key;
      endRound("right", a, {}, undefined, name);
    }
    closeGuide();
  }
});

function submitGuess(name) {
  const a = actingAsker(); if (!a || S.pending || !monsters.includes(name)) return;
  enqueue(() => stateRef().update({ pending: { type: "guess", by: a, name, id: rid() } }));
}
let answeredKey = null;
function answer(ans) {
  if (!controls(S.monsterId)) return;
  if (S.pending && S.pending.type === "guess") return;
  if (S.questions >= maxQ()) return;
  const key = `${S.gameId}:${S.round}:${S.turn}`; if (answeredKey === key) return; answeredKey = key;
  const by = S.pending ? S.pending.by : currentAsker(); if (!by) return;
  const n = S.questions + 1;
  const clues = [...(S.clues || []), { n, by, text: (S.pending && S.pending.text) || "", ans }];
  enqueue(() => stateRef().update({ pending: null, questions: n, turn: S.turn + 1, clues }));
}
function wrongGuess(p) {
  const pl = players()[p.by];
  const minus = pl ? { [p.by]: { score: (pl.score || 0) - 1 } } : {};
  const log = [{ r: S.round, k: "wrong", id: p.by }, ...(S.log || [])].slice(0, 40);
  if (S.questions >= maxQ()) { endRound("stump", null, minus, log); return; }
  const clues = [...(S.clues || []), { n: S.questions + 1, by: p.by, guess: p.name, ans: "wrong" }];
  enqueue(() => stateRef().update({ pending: null, players: minus, questions: S.questions + 1, turn: S.turn + 1, clues, log }));
}

$("turnArea").addEventListener("click", e => {
  const b = e.target.closest("button[data-t]"); if (!b || !S) return;
  const t = b.dataset.t;
  if (t === "guess") { openGuide("guess"); return; }
  if (t === "ask") { turnMode = t; focusTurn = true; render(); return; }
  if (t === "back") { turnMode = "choose"; render(); return; }
  if (t === "sendAsk") {
    const a = actingAsker(); if (!a || S.pending) return;
    const text = (($("askText") || {}).value || "").trim().slice(0, 140);
    enqueue(() => stateRef().update({ pending: { type: "ask", by: a, text, id: rid() } }));
    return;
  }
  if (t === "right" || t === "rightNoName" || t === "pickCorrect" || t === "wrongq") {
    if (!controls(S.monsterId) || S.pending) return;
    const a = currentAsker(); if (!a) return;
    if (t === "right" && !roundSecret()) { openGuide("correct"); return; }
    const key = `${S.gameId}:${S.round}:${S.turn}`; if (answeredKey === key) return; answeredKey = key;
    if (t === "wrongq") { wrongGuess({ by: a, name: "" }); toast(`${nameOf(a)} loses a point.`); return; }
    endRound("right", a, {}, undefined, t === "pickCorrect" ? b.dataset.name : null);
    return;
  }
  if (t === "pick") { submitGuess(b.dataset.name); return; }
  if (t === "pass") { if (actingAsker()) askConfirm(`Pass? ${nameOf(S.monsterId)} wins the round.`, "Pass").then(ok => { if (ok) endRound("stump"); }); return; }
  if (t === "cancel") { enqueue(() => stateRef().update({ pending: null })); return; }
  if (t === "yes" || t === "no") { answer(t); return; }
  if (isHost && S.pending && S.pending.type === "guess") {
    const p = S.pending;
    if (t === "mright") { resolvedGuesses.add(p.id); endRound("right", p.by); }
    if (t === "mwrong") { resolvedGuesses.add(p.id); wrongGuess(p); }
  }
});
$("turnArea").addEventListener("input", e => {
  if (e.target.id !== "guessText" && e.target.id !== "correctText") return;
  const act = e.target.id === "guessText" ? "pick" : "pickCorrect";
  const hits = searchMonsters(e.target.value);
  $("sugg").innerHTML = norm(e.target.value).length < 3 ? `<span class="muted">Type at least 3 letters.</span>`
    : hits.length ? hits.map(m => `<button data-t="${act}" data-name="${esc(m)}">${info(m).emoji} ${esc(m)}</button>`).join("")
    : `<span class="muted">No monster on the list matches that. Try another name.</span>`;
});
$("turnArea").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if (e.target.id === "askText") { e.preventDefault(); const b = $("turnArea").querySelector('[data-t="sendAsk"]'); if (b) b.click(); }
  if (e.target.id === "guessText") { e.preventDefault(); const hits = searchMonsters(e.target.value); if (hits.length === 1) submitGuess(hits[0]); }
  if (e.target.id === "correctText") { e.preventDefault(); const hits = searchMonsters(e.target.value); if (hits.length === 1 && controls(S.monsterId) && currentAsker()) endRound("right", currentAsker(), {}, undefined, hits[0]); }
});

$("board").addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t || !isHost) return;
  if (t.dataset.inc) adjust(t.dataset.inc, 1);
  if (t.dataset.dec) adjust(t.dataset.dec, -1);
  if (t.dataset.mon) enqueue(() => stateRef().update({ monsterId: t.dataset.mon, drawn: false, questions: 0, turn: 0, pending: null, clues: [] }));
  if (t.dataset.rm) { const id = t.dataset.rm; askConfirm(`Remove ${nameOf(id)} from the game?`, "Remove").then(ok => { if (ok) removePlayer(id); }); }
});

$("skipTurnBtn").onclick = () => {
  if (!isHost || !S) return;
  const who = currentAsker();
  enqueue(() => stateRef().update({ turn: S.turn + 1, pending: null }));
  if (who) toast(`Skipped ${nameOf(who)}'s turn.`);
};
$("setMonsterBtn").onclick = async () => {
  if (!isHost || !S) return;
  const id = $("monsterSelect").value; if (!id || !players()[id]) return;
  if (id === S.monsterId) { toast(`${nameOf(id)} is already the monster.`); return; }
  if (S.drawn && !(await askConfirm(`Make ${nameOf(id)} the monster? This round starts over with a fresh draw.`, "Switch monster"))) return;
  enqueue(() => stateRef().update({ monsterId: id, drawn: false, questions: 0, turn: 0, pending: null, clues: [], selfPick: false }));
  toast(`${nameOf(id)} is now the monster.`);
};
document.querySelector(".modeseg").addEventListener("click", e => {
  const b = e.target.closest("button[data-mode]"); if (!b || (S && !isHost)) return;
  const on = b.dataset.mode === "host";
  if (!S) { setupHostMode = on; renderSetup(); return; }
  if (on === hostRun()) return;
  enqueue(() => stateRef().update({ hostMode: on }));
  toast(on ? "You're now running every turn from your screen." : "Players now use their own screens.");
});

// host tools
$("skipBtn").onclick = async () => { if (S && await askConfirm("Skip this round? Nobody gets points.", "Skip round")) endRound("skip"); };
$("newGameBtn").onclick = async () => {
  if (!(await askConfirm("Start a new game? Scores reset to zero. Players stay.", "Start new game"))) return;
  const pl = {}; order().forEach(id => { pl[id] = { ...players()[id], score: 0 }; });
  enqueue(() => stateRef().set({ ...freshState(pl, order()[0] || null), maxQ: maxQ(), hostMode: hostRun() }));
};
document.querySelector(".seg").addEventListener("click", e => {
  const b = e.target.closest("button[data-q]"); if (!b || (S && !isHost)) return;
  const n = +b.dataset.q;
  if (!S) { setupQ = n; renderSetup(); return; }
  enqueue(() => stateRef().update({ maxQ: n, questions: Math.min(S.questions, n) }));
  toast(`Each round now has ${n} questions.`);
});
const saveMonsters = (list, descs = customDescs) => {
  if (!S) { monsters = list; customDescs = descs; renderSetup(); return; }
  if (isHost) return enqueue(() => db.doc("game/monsters").set({ list, descs }));
};
function closeReveal() { revealOpen = false; render(); }
$("revealClose").onclick = closeReveal;
$("reveal").addEventListener("click", e => { if (e.target.id === "reveal") closeReveal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && revealOpen) closeReveal(); });
$("monForm").addEventListener("submit", e => {
  e.preventDefault();
  const m = $("newMonster").value.trim(); if (!m) return;
  if (monsters.some(x => x.toLowerCase() === m.toLowerCase())) { toast(`${m} is already on the list.`); return; }
  const desc = $("newDesc").value.trim();
  saveMonsters([...monsters, m], desc ? { ...customDescs, [m]: desc } : customDescs);
  $("newMonster").value = ""; $("newDesc").value = "";
});
$("chips").addEventListener("click", e => {
  const t = e.target.closest("button[data-mrm]"); if (!t) return;
  saveMonsters(monsters.filter((_, i) => i !== +t.dataset.mrm));
});
$("restoreMon").onclick = () => { saveMonsters([...DEFAULT_MONSTERS], {}); if (S) enqueue(() => stateRef().update({ used: [] })); toast("Default monster list restored."); };

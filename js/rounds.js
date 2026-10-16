export const DEFAULT_ROUNDS = 10;

function playerOrder(state) {
  return Object.entries(state.players || {}).filter(([, player]) => player)
    .sort((a, b) => a[1].joinedAt - b[1].joinedAt).map(([id]) => id);
}

export function roundPlan(state) {
  const ids = playerOrder(state);
  const served = new Set(state.monsterTurns || []);
  const remaining = ids.filter(id => id !== state.monsterId && !served.has(id));
  const minimum = Math.max(1, ids.length, (state.round || 1) + remaining.length);
  return { minimum, total: Math.max(state.totalRounds || DEFAULT_ROUNDS, minimum), remaining };
}

// Decide the final round inside the same transaction that awards its points.
// A player joining just before the write must still get their monster turn.
export function completeRound(state, patch) {
  const ids = playerOrder(state);
  const monsterTurns = [...new Set([...(state.monsterTurns || []), state.monsterId].filter(Boolean))];
  const remaining = ids.filter(id => !monsterTurns.includes(id));
  const totalRounds = Math.max(state.totalRounds || DEFAULT_ROUNDS, state.round + remaining.length, ids.length);
  const finished = state.round >= totalRounds;
  const next = remaining[0] || ids[(ids.indexOf(state.monsterId) + 1) % ids.length] || null;
  const gameResult = finished ? gameResultFor(state, patch, state.round) : null;
  return { ...patch, monsterTurns, totalRounds, gameResult,
    round: finished ? state.round : state.round + 1, monsterId: finished ? null : next };
}

export function gameResultFor(state, patch = {}, rounds = Math.max(0, (state.round || 1) - 1)) {
  const scores = playerOrder(state).map(id => ({ id,
    name: state.players[id].name || state.players[id].guestName || 'Player',
    score: patch.players?.[id]?.score ?? state.players[id].score ?? 0 }));
  const score = scores.length ? Math.max(...scores.map(player => player.score)) : 0;
  return { winners: scores.filter(player => player.score === score), score, rounds };
}

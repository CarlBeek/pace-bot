// Only public account metadata supplied with the game's match snapshot is used.
// A display name, avatar, guest name or apparent playing style is not identity.
export function readOpponentIdentity(player) {
  if (player == null) return undefined; // Missing metadata is not a new identity.
  if (player.kind !== 'twitter' || typeof player.username !== 'string') return null;
  const username = player.username.toLowerCase();
  if (!/^[a-z0-9_]{1,64}$/.test(username)) return null;
  return { kind: 'twitter', username };
}

// Frozen to the forecast20 candidate in runs/cash-validation.json. Selection is
// based on own expected cash, not wins. Replay gains are not live validation.
export const ERGONOMIC_CASH = Object.freeze({
  id: 'ergonomic-cash-v1', label: '@ergonomic cash',
  params: Object.freeze({ forecast: 2, opponentForecast: 3, wealth: 1, winWeight: 0,
    opponentModel: 'anchored', maxTargetGap: 2, motionModel: 'pending',
    catchupToDeployed: true, endgameSeconds: 6, endgameForecast: 2, deadlineAware: true,
    slowdownFactor: 0, deploymentForecastBoost: 0 }),
});

export function selectOpponentProfile(objective, identity) {
  return objective === 'leaderboard' && identity?.kind === 'twitter' && identity.username === 'ergonomic'
    ? ERGONOMIC_CASH : null;
}

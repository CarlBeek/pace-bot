// Online policy: infer opponent motion from visible deployed research, then choose a
// profit/risk target. Constants/formulas match the verified public PACE engine.
import { project, stopDistance, frontierSlope, validObservation } from './policy.mjs';
import { speedCap } from './controller.mjs';

export const DEPLOYMENT_SECONDS = 2;
export const YEARS_PER_SECOND = 7 / 365;
export const COMPETITIVE_PRESETS = {
  leaderboard: { forecast: 1, opponentForecast: 3, wealth: 1, winWeight: .25,
    opponentModel: 'anchored', maxTargetGap: 2, motionModel: 'pending' },
  competitive: { forecast: 1.5, opponentForecast: 3, wealth: 1, winWeight: .5 },
};

export function annualProfit(own, opponent) {
  const base = 5e9 + 1e10 * Math.log1p(.025 * Math.max(0, own));
  const lead = own - opponent;
  if (lead >= 0) return base + 3e9 * Math.log1p(lead / 2);
  const lag = -lead, discounted = base / (1 + .4 * Math.log1p(lag / 2));
  const z = Math.log(lag) + (opponent - 22) / 4;
  const softplus = Math.max(0, z) + Math.log1p(Math.exp(-Math.abs(z)));
  const competitive = (discounted + 8e9) / (1 + softplus) - 8e9;
  const u = Math.min(1, lag / 2), blend = u * u * (3 - 2 * u);
  return discounted + (competitive - discounted) * blend;
}

export function catastropheRate(deployed, safety) {
  const x = Math.max(0, deployed), gap = Math.max(0, x - safety);
  if (!x || !gap) return 0;
  return .24 / (1 + (12 / x) ** 2) / (1 + 75 / (gap * gap));
}

export function opponentSpeed(obs, history, window = .75) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i], dt = obs.t - h.t;
    if (dt >= window - 1e-6 && Number.isFinite(h.opponent))
      return Math.max(0, Math.min(speedCap(obs.opponent.deployed), (obs.opponent.deployed - h.opponent) / dt));
  }
  return 0;
}

export function decideCompetitive(obs, { held = false, history = [], lookahead = 5, delayFrames = 0, pendingFrames = 0, params = {} } = {}) {
  if (!validObservation(obs) || ![obs.own.cash, obs.own.deployed, obs.opponent.cash].every(Number.isFinite))
    return { held: false, reason: 'invalid or inactive observation' };
  const { forecast = 2, opponentForecast = 2, lead = 0, wealth = 1, winWeight = 0, hysteresis = .08,
    opponentModel = 'bounded', maxTargetGap = Infinity, motionModel = 'issued' } = params;
  const slope = frontierSlope(obs, history);
  const velocity = opponentSpeed(obs, history);
  const predictedSafety = obs.safety + Math.min(3, forecast * slope);
  const gaps = history.filter(h => h.t <= obs.t && obs.t - h.t <= 2 && Number.isFinite(h.opponent)).map(h => h.opponent - h.safety).sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : obs.opponent.deployed - obs.safety;
  // Deployment speed oscillates as players tap the accelerator. Leaderboard uses the
  // recent frontier offset through brief pauses; Win-focused retains the v0.2 forecast.
  const anchor = obs.safety + Math.min(3, opponentForecast * slope) + gap;
  const prediction = opponentModel === 'anchored' ? anchor : Math.min(
    obs.opponent.deployed + Math.min(4, opponentForecast * velocity), anchor);
  const predictedOpponent = Math.max(obs.opponent.deployed, prediction) + lead;
  // Wealth exposed to a catastrophe includes the bank and future earning potential.
  const remaining = Math.max(0, 92 - obs.t - DEPLOYMENT_SECONDS);
  const futureRate = Math.max(1e8, annualProfit(Math.max(obs.safety, obs.own.deployed), predictedOpponent) * YEARS_PER_SECOND);
  const atRisk = wealth * Math.max(5e9, obs.own.cash + futureRate * remaining);
  // Spend less risk defending a cash lead; increase competitive pressure when behind.
  const pressure = winWeight * Math.max(0, Math.min(2, 1 - (obs.own.cash - obs.opponent.cash) / 1e9));
  const floor = Math.max(0, obs.safety - .5);
  // This bounds the research target, not total risk: frontier forecasts can be wrong
  // and already-deployed research cannot be taken back.
  const ceiling = Math.min(Math.max(predictedSafety + 6, predictedOpponent + 3), predictedSafety + maxTargetGap);
  let target = floor, best = -Infinity;
  const step = Math.max(.125, (ceiling - floor) / 128);
  for (let x = floor; x <= ceiling + 1e-8; x += step) {
    const profit = annualProfit(x, predictedOpponent);
    const utility = (profit + pressure * (profit - annualProfit(predictedOpponent, x))) * YEARS_PER_SECOND
      - catastropheRate(Math.max(x, predictedOpponent), predictedSafety) * atRisk;
    if (utility > best) { target = x; best = utility; }
  }
  let { position: x, speed: v } = obs.own;
  const delay = Math.max(0, Math.round(delayFrames));
  // A command still in transit cannot affect motion at the start of this projection.
  const pending = motionModel === 'pending' && typeof obs.own.held === 'boolean' ? Math.max(0, Math.min(delay, Math.round(pendingFrames))) : 0;
  if (pending) ({ x, v } = project(x, v, obs.own.held, pending));
  ({ x, v } = project(x, v, held, delay - pending));
  const next = project(x, v, true, Math.max(1, Math.round(lookahead)));
  const stop = next.x + stopDistance(next.x, next.v);
  const accelerate = stop < target - (held ? 0 : hysteresis);
  return { held: accelerate, reason: accelerate ? 'building profitable lead' : 'protecting cash', stop, target, slope,
    predictedOpponent, predictedSafety, opponentSpeed: velocity, delayFrames, atRisk };
}

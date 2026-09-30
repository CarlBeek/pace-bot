// Pure policy functions over player-visible observations. No browser or engine access.
// Observation shape (all numbers finite unless noted):
//   { t, phase: 'running'|..., safety, own: { position, speed, deployed }, opponent: { deployed } }
// history: [{ t, safety }] of past observed frontier samples, oldest first.
import { speedCap, decide as decideReproduction } from './controller.mjs';

export { speedCap };
export const ACCEL = .62;
export const DT = 1 / 60;

export function stopDistance(x, v) {
  return v * v / (2 * ACCEL * speedCap(x));
}

// Advance own research under the original movement law (trapezoid, per-frame cap), for `steps` frames.
export function project(x, v, held, steps) {
  for (let i = 0; i < steps; i++) {
    const V = speedCap(x);
    if (held) {
      const nv = Math.min(V, v + ACCEL * V * DT);
      x += (v + nv) / 2 * DT; v = nv;
    } else {
      const a = ACCEL * V, tt = Math.min(DT, v / a), nv = Math.max(0, v - a * DT);
      x += (v + nv) / 2 * tt; v = nv;
    }
  }
  return { x, v };
}

export function validObservation(obs) {
  return !!obs && obs.phase === 'running' &&
    [obs.t, obs.safety, obs.own?.position, obs.own?.speed, obs.opponent?.deployed].every(Number.isFinite) &&
    obs.own.speed >= 0;
}

export function frontierSlope(obs, history, window = .5) {
  for (let i = history.length - 1; i >= 0; --i) {
    const h = history[i];
    if (Number.isFinite(h.t) && Number.isFinite(h.safety) && obs.t - h.t >= window - 1e-6)
      return Math.max(0, (obs.safety - h.safety) / (obs.t - h.t));
  }
  return 0;
}

export const PRESETS = {
  // Production presets, tuned on training seeds (LCG indices 0..599) under the practice timing model
  // (15 Hz snapshots, decision on arrival). `lookahead` is one decision interval in frames.
  cash: { forecast: .25, maxLead: 2, offset: -.3, matchOpponent: true, oppLead: 0, hysteresis: .1, horizon: 0, lookahead: 4 },
  win: { forecast: 1, maxLead: 2, offset: -.1, matchOpponent: true, oppLead: 0, hysteresis: .1, horizon: 0, lookahead: 4 },
  // Handoff reproduction family (described as 5 Hz in the original benchmark).
  'repro-cash': { forecast: .5, maxLead: 2, offset: -.1, matchOpponent: true, oppLead: 0, hysteresis: .3, horizon: 0, lookahead: 0 },
  'repro-win': { forecast: 1, maxLead: 2, offset: -.1, matchOpponent: true, oppLead: 0, hysteresis: .3, horizon: 0, lookahead: 0 },
};

// Generalized target-tracking controller. With horizon=0 and a preset it is the handoff baseline;
// horizon>0 is the latency-compensated variant: it projects own state forward `horizon` frames under
// the last issued control (observation/delivery delay), then asks whether holding for one more
// decision interval (`lookahead` frames) would still leave a stop point below target.
export function decideTarget(obs, { params = PRESETS.cash, held = false, history = [], lookahead } = {}) {
  if (!validObservation(obs)) return { held: false, reason: 'invalid or inactive observation' };
  const p = { ...PRESETS.cash, ...params };
  lookahead ??= p.lookahead;
  const slope = frontierSlope(obs, history);
  let { position: x, speed: v } = obs.own;
  if (p.horizon > 0) ({ x, v } = project(x, v, held, Math.round(p.horizon)));
  const target = Math.max(p.matchOpponent ? obs.opponent.deployed + p.oppLead : -Infinity,
    obs.safety + p.offset + Math.min(p.maxLead, p.forecast * slope));
  let stop;
  if (lookahead > 0) {
    const f = project(x, v, true, Math.round(lookahead));
    stop = f.x + stopDistance(f.x, f.v);
  } else stop = x + stopDistance(x, v);
  const next = stop < target - (held ? 0 : p.hysteresis);
  return { held: next, reason: next ? 'headroom' : (stop >= target ? 'braking: stop point at target' : 'waiting: hysteresis'), stop, target, slope };
}

// Offline baselines.
export function decideSafeFrontier(obs, { offset = 0, held = false, hysteresis = .3 } = {}) {
  if (!validObservation(obs)) return { held: false, reason: 'invalid' };
  const stop = obs.own.position + stopDistance(obs.own.position, obs.own.speed);
  return { held: stop < obs.safety + offset - (held ? 0 : hysteresis), reason: 'frontier', stop, target: obs.safety + offset };
}

// The official CPU rule, evaluated on our own visible observation.
export function decideCpuMirror(obs, { held = false } = {}) {
  if (!validObservation(obs)) return { held: false, reason: 'invalid' };
  const behind = obs.own.deployed < obs.opponent.deployed;
  const target = Math.max(obs.safety, behind ? obs.opponent.deployed + 1.5 : 0);
  const stop = obs.own.position + stopDistance(obs.own.position, obs.own.speed);
  return { held: stop < target - (held ? 0 : .3), reason: 'cpu mirror', stop, target };
}

export function decideAlways(obs) {
  return { held: validObservation(obs), reason: 'always' };
}

export { decideReproduction };

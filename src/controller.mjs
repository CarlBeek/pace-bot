// Deterministic baseline only. Browser adapter and latency compensation are separate.
export function speedCap(x) {
  const p = Math.max(0, x);
  const q = Math.max(0, p - 24) / 12;
  return 1.5 + 1.74 * (.08 * -Math.expm1(-p / 12) + .92 * -Math.expm1(-(q*q)));
}

export function decide(obs, { mode = 'cash', held = false, history = [] } = {}) {
  if (!['cash', 'win'].includes(mode)) throw new Error('Unknown objective');
  if (!obs || obs.phase !== 'running' ||
      ![obs.t, obs.safety, obs.own?.position, obs.own?.speed,
        obs.opponent?.deployed].every(Number.isFinite) || obs.own.speed < 0) {
    return { held: false, reason: 'invalid or inactive observation' };
  }
  let slope = 0;
  for (let i = history.length - 1; i >= 0; --i) {
    const h = history[i];
    if (Number.isFinite(h.t) && Number.isFinite(h.safety) && obs.t - h.t >= .5 - 1e-6) {
      slope = Math.max(0, (obs.safety - h.safety) / (obs.t - h.t));
      break;
    }
  }
  const stop = obs.own.position + obs.own.speed ** 2 / (2 * .62 * speedCap(obs.own.position));
  const forecast = mode === 'win' ? 1 : .5;
  const target = Math.max(obs.opponent.deployed, obs.safety - .1 + Math.min(2, forecast * slope));
  const next = stop < target - (held ? 0 : .3);
  return { held: next, reason: next ? 'headroom' : 'braking', stop, target, slope };
}

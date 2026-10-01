// Frozen ablations of opponent-aware catch-up and finish-aware control.
// Tuning: seeds 8000..8007 and the 15-game v0.3.1 export. Validation: 9000+.
// No network access, live games, or leaderboard writes.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { runDuel, runReplay, readTraceMatches, aggregate, OPPONENTS } from './online.mjs';
import { decideTarget, PRESETS } from '../src/policy.mjs';
import { lcgSeeds } from './seeds.mjs';

const n = Number(process.argv[2] || 40);
if (!Number.isInteger(n) || n < 2) throw new Error('Expected at least two seeds');
const baseline = { forecast: 1, opponentForecast: 3, wealth: 1, winWeight: .25,
  opponentModel: 'anchored', maxTargetGap: 2, motionModel: 'pending',
  catchupToDeployed: false, endgameSeconds: 0, endgameForecast: 1, deadlineAware: false };
const candidates = {
  v031: { objective: 'leaderboard', params: baseline },
  catchupOnly: { objective: 'leaderboard', params: { ...baseline, catchupToDeployed: true } },
  v04: { objective: 'leaderboard', params: { ...baseline, catchupToDeployed: true,
    endgameSeconds: 6, endgameForecast: 2, deadlineAware: true } },
  v02: { objective: 'leaderboard', params: { ...baseline, forecast: 1.5, opponentModel: 'bounded', maxTargetGap: 1e6, motionModel: 'issued' } },
};
const overdrive = { ...PRESETS.win, offset: 3, forecast: 2 };
const opponents = { ...Object.fromEntries(Object.keys(OPPONENTS).map(k => [k, k])),
  overdrive: (o, s) => decideTarget(o, { ...s, params: overdrive }),
  lateSurge: (o, s) => decideTarget(o, { ...s, params: o.t < 70 ? OPPONENTS.frontier : overdrive }),
};
const seeds = lcgSeeds(n, { start: 9000 });
const report = { generatedAt: new Date().toISOString(), seedStart: 9000, seedsPerOpponent: n,
  engineSha256: createHash('sha256').update(readFileSync(new URL('../engine/engine-original.cjs', import.meta.url))).digest('hex'),
  candidates, tuning: 'Eight seeds 8000..8007, six opponent styles, eight candidates, plus the 15-game v0.3.1 export.',
  caveat: 'Expected cash and wins include catastrophe probability. Equal-weight synthetic opponents are not the online population. Replay paths were used in development, are not held out, and cannot model changed opponent reactions. Early terminal paths are excluded from full-game replay averages.',
  scenarios: [], replays: [], replaySummary: {} };

function paired(deltas) {
  const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  const se = Math.sqrt(deltas.reduce((s, x) => s + (x - mean) ** 2, 0) / (deltas.length - 1) / deltas.length);
  return { meanBillions: mean, lower95: mean - 1.96 * se, upper95: mean + 1.96 * se };
}
for (const [scenario, timing] of Object.entries({ normal: { obsDelay: 3, inputDelay: 4 }, delayed: { obsDelay: 6, inputDelay: 8, drop: .05 } })) {
  const games = Object.fromEntries(Object.keys(candidates).map(k => [k, []])), rows = [];
  for (const [opponent, opponentSpec] of Object.entries(opponents)) {
    for (const [name, spec] of Object.entries(candidates)) {
      const results = seeds.map(seed => runDuel(seed, spec, opponentSpec, timing));
      games[name].push(...results);
      const row = { opponent, name, ...aggregate(results) }; rows.push(row);
      console.log(JSON.stringify({ scenario, ...row }));
    }
  }
  const overall = Object.fromEntries(Object.entries(games).map(([name, rs]) => [name, aggregate(rs)]));
  const differences = {};
  for (const [name, reference] of [['catchupOnly', 'v031'], ['v04', 'v031'], ['v04', 'catchupOnly'], ['v04', 'v02']]) {
    // Cluster by frontier seed, not individual seed/opponent pairs.
    const deltas = seeds.map((_, i) => Object.keys(opponents).reduce((sum, _op, j) => sum +
      (games[name][j * n + i].expectedCash - games[reference][j * n + i].expectedCash) / 1e9, 0) / Object.keys(opponents).length);
    differences[`${name} - ${reference}`] = paired(deltas);
  }
  report.scenarios.push({ scenario, timing, rows, overall, differences });
  console.log(JSON.stringify({ scenario, overall, differences }));
}
if (process.argv[3]) {
  const path = process.argv[3], data = JSON.parse(readFileSync(path, 'utf8'));
  report.trace = { file: basename(path), botVersion: data.botVersion, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  for (const [i, samples] of readTraceMatches(path).entries()) {
    const delays = samples.map(s => s.delayFrames).filter(Number.isFinite).sort((a, b) => a - b);
    // Only total delay is estimated; the observation/input split is not measured.
    const delay = Math.max(1, Math.round(delays[Math.floor(delays.length / 2)] ?? 7));
    const timing = { cadence: 5, obsDelay: 1, inputDelay: delay - 1 };
    const last = samples.at(-1), complete = last.phase === 'finished' && last.t >= 92 - 1e-6;
    for (const [name, spec] of Object.entries(candidates)) {
      const row = { match: i + 1, name, complete, through: last.t, observedPhase: last.phase,
        observedCash: last.cash, observedOpponentCash: last.oppCash, timing, ...runReplay(samples, spec, timing) };
      report.replays.push(row);
    }
  }
  for (const name of Object.keys(candidates)) {
    const complete = report.replays.filter(r => r.name === name && r.complete);
    if (complete.length) report.replaySummary[name] = aggregate(complete);
  }
  console.log(JSON.stringify({ replaySummary: report.replaySummary }));
}
const out = process.argv[4] || 'runs/finish-validation.json';
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log('Wrote ' + out);

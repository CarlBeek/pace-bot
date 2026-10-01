// Paired, held-out comparison of the frozen v0.2 leaderboard policy and refinements.
// No leaderboard submissions. Tuning used indices 6000..6215; validation starts at 7000.
import { writeFileSync } from 'node:fs';
import { runDuel, runReplay, readTraceMatches, aggregate, OPPONENTS } from './online.mjs';
import { decideTarget, PRESETS } from '../src/policy.mjs';
import { lcgSeeds } from './seeds.mjs';

const n = Number(process.argv[2] || 40);
if (!Number.isInteger(n) || n < 1) throw new Error('Expected a positive game count');
// Explicitly override every new setting so this remains the v0.2 baseline after upgrades.
const params = { forecast: 1.5, opponentForecast: 3, wealth: 1, winWeight: .25,
  motionModel: 'issued', opponentModel: 'bounded', maxTargetGap: 1e6,
  catchupToDeployed: false, endgameSeconds: 0, deadlineAware: false };
const candidates = {
  v02: { objective: 'leaderboard', params },
  capped: { objective: 'leaderboard', params: { ...params, forecast: 1, opponentModel: 'anchored', maxTargetGap: 2 } },
  cappedPending: { objective: 'leaderboard', params: { ...params, forecast: 1, opponentModel: 'anchored', maxTargetGap: 2, motionModel: 'pending' } },
};
const opponents = {
  ...Object.fromEntries(Object.keys(OPPONENTS).map(k => [k, k])),
  gentle: (o, s) => decideTarget(o, { ...s, params: { ...PRESETS.cash, offset: -.5, forecast: .8 } }),
  lateEscalation: (o, s) => decideTarget(o, { ...s, params: o.t < 45 ? OPPONENTS.cautious : OPPONENTS.aggressive }),
};
const seeds = lcgSeeds(n, { start: 7000 });
const report = { generatedAt: new Date().toISOString(), seedStart: 7000, seedsPerOpponent: n, candidates,
  caveat: 'Equal-weight simulated opponent mix; does not establish live performance or leaderboard placement.', scenarios: [], replays: [] };
const paired = differences => {
  const mean = differences.reduce((a, b) => a + b, 0) / differences.length;
  const se = Math.sqrt(differences.reduce((a, b) => a + (b - mean) ** 2, 0) / (differences.length - 1) / differences.length);
  return { meanBillions: mean, lower95: mean - 1.96 * se, upper95: mean + 1.96 * se };
};
for (const [scenario, timing] of Object.entries({ normal: { obsDelay: 3, inputDelay: 4 }, delayed: { obsDelay: 6, inputDelay: 8, drop: .05 } })) {
  const games = Object.fromEntries(Object.keys(candidates).map(k => [k, []]));
  const rows = [];
  for (const [opponent, opponentSpec] of Object.entries(opponents)) {
    for (const [name, spec] of Object.entries(candidates)) {
      const results = seeds.map(seed => runDuel(seed, spec, opponentSpec, timing));
      games[name].push(...results);
      const row = { opponent, name, ...aggregate(results) }; rows.push(row);
      console.log(JSON.stringify({ scenario, ...row }));
    }
  }
  const overall = Object.fromEntries(Object.entries(games).map(([name, results]) => [name, aggregate(results)]));
  const differences = {};
  for (const name of Object.keys(candidates).filter(k => k !== 'v02')) {
    // Aggregate each seed across opponent styles before the paired interval: games
    // sharing a frontier seed are correlated, not independent samples.
    const perSeed = seeds.map((_, i) => Object.keys(opponents).reduce((sum, _k, j) => sum +
      (games[name][j * n + i].expectedCash - games.v02[j * n + i].expectedCash) / 1e9, 0) / Object.keys(opponents).length);
    differences[name] = paired(perSeed);
  }
  report.scenarios.push({ scenario, timing, rows, overall, differences });
  console.log(JSON.stringify({ scenario, overall, differences }));
}
if (process.argv[3]) {
  for (const [i, samples] of readTraceMatches(process.argv[3]).entries())
    for (const [name, spec] of Object.entries(candidates)) report.replays.push({ match: i + 1, name, ...runReplay(samples, spec) });
}
const out = process.argv[4] || 'runs/refinement-validation.json';
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log('Wrote ' + out);

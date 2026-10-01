// Cash-only tuning and a separate paired validation. All games are offline.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDuel, runReplay, readTraceMatches, aggregate, OPPONENTS } from './online.mjs';
import { decideTarget, PRESETS } from '../src/policy.mjs';
import { lcgSeeds } from './seeds.mjs';

// Fully specified: changing production defaults must not change the reference.
export const V04 = Object.freeze({ forecast: 1, opponentForecast: 3, wealth: 1, winWeight: .25,
  opponentModel: 'anchored', maxTargetGap: 2, motionModel: 'pending',
  catchupToDeployed: true, endgameSeconds: 6, endgameForecast: 2, deadlineAware: true,
  slowdownFactor: 0, deploymentForecastBoost: 0 });
export const PURE_CASH = Object.freeze({ ...V04, winWeight: 0 });
const spec = params => ({ objective: 'leaderboard', params });
export const CASH_CANDIDATES = {
  v04: spec(V04),
  pureCash: spec(PURE_CASH),
  forecast05: spec({ ...PURE_CASH, forecast: .5 }),
  forecast15: spec({ ...PURE_CASH, forecast: 1.5 }),
  gap15: spec({ ...PURE_CASH, maxTargetGap: 1.5 }),
  gap3: spec({ ...PURE_CASH, maxTargetGap: 3 }),
  gap4: spec({ ...PURE_CASH, maxTargetGap: 4 }),
  wealth08: spec({ ...PURE_CASH, wealth: .8 }),
  wealth125: spec({ ...PURE_CASH, wealth: 1.25 }),
  bounded: spec({ ...PURE_CASH, opponentModel: 'bounded' }),
  forecast20: spec({ ...PURE_CASH, forecast: 2 }),
  slowdown15: spec({ ...PURE_CASH, forecast: 1.5, slowdownFactor: .5 }),
  slowdown20: spec({ ...PURE_CASH, forecast: 2, slowdownFactor: .5 }),
  slowdownStrong: spec({ ...PURE_CASH, forecast: 2, slowdownFactor: 1 }),
  adaptive: spec({ ...PURE_CASH, deploymentForecastBoost: 1 }),
  adaptiveSlow: spec({ ...PURE_CASH, deploymentForecastBoost: 1, slowdownFactor: .5 }),
  adaptiveHalf: spec({ ...PURE_CASH, deploymentForecastBoost: .5, slowdownFactor: .5 }),
  adaptive15: spec({ ...PURE_CASH, forecast: 1.5, deploymentForecastBoost: 1, slowdownFactor: .5 }),
};

export function pairedCash(differences) {
  const mean = differences.reduce((a, b) => a + b, 0) / differences.length;
  const se = Math.sqrt(differences.reduce((a, b) => a + (b - mean) ** 2, 0) / (differences.length - 1) / differences.length);
  return { meanBillions: mean, lower95: mean - 1.96 * se, upper95: mean + 1.96 * se };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2], tuning = mode?.startsWith('tune'), n = Number(process.argv[3] || (tuning ? 8 : 64));
  if (!['tune', 'tune-basic', 'tune-slowdown', 'tune-adaptive', 'validate'].includes(mode) || !Number.isInteger(n) || n < 2 || (tuning && n > 1000))
    throw new Error('Usage: node sim/cash.mjs tune[-basic|-slowdown|-adaptive]|validate [seeds >= 2] [output.json] [trace.json ...]; tuning uses at most 1000 seeds');
  const candidates = tuning ? Object.fromEntries(Object.entries(CASH_CANDIDATES).filter(([k], i) =>
    mode === 'tune' || (mode === 'tune-basic' && i < 10) || (mode === 'tune-slowdown' && i < 14) ||
    (mode === 'tune-adaptive' && (i < 2 || k.startsWith('adaptive'))))) : {
    v04: CASH_CANDIDATES.v04, pureCash: CASH_CANDIDATES.pureCash,
    forecast15: CASH_CANDIDATES.forecast15, forecast20: CASH_CANDIDATES.forecast20,
    slowdown20: CASH_CANDIDATES.slowdown20,
  };
  const seedStart = tuning ? 11000 : 12000;
  const seeds = lcgSeeds(n, { start: seedStart });
  const overdrive = { ...PRESETS.win, offset: 3, forecast: 2 };
  const opponents = { ...Object.fromEntries(Object.keys(OPPONENTS).map(k => [k, k])),
    overdrive: (o, s) => decideTarget(o, { ...s, params: overdrive }),
    lateSurge: (o, s) => decideTarget(o, { ...s, params: o.t < 70 ? OPPONENTS.frontier : overdrive }),
  };
  const report = { generatedAt: new Date().toISOString(), mode, seedStart, seedsPerOpponent: n, candidates,
    tuning: 'Eighteen candidates on indices 11000..11007 plus the two online trace exports. Validation candidates were frozen before inspecting indices 12000+.',
    metric: 'Mean terminal own cash, with catastrophe outcomes worth zero. Neither wins nor opponent cash enter candidate ranking.',
    engineSha256: createHash('sha256').update(readFileSync(new URL('../engine/engine-original.cjs', import.meta.url))).digest('hex'),
    caveat: 'Equal-weight synthetic opponents are not the online population. Intervals cluster by frontier seed. Replays freeze opponent behavior and cannot model reactions; incomplete paths are excluded from full-game averages. No live games or leaderboard writes.',
    scenarios: [], replays: [], replaySummary: {} };
  for (const [scenario, timing] of Object.entries({ normal: { obsDelay: 3, inputDelay: 4 }, delayed: { obsDelay: 6, inputDelay: 8, drop: .05 } })) {
    const games = Object.fromEntries(Object.keys(candidates).map(k => [k, []])), rows = [];
    for (const [opponent, opponentSpec] of Object.entries(opponents)) {
      for (const [name, policy] of Object.entries(candidates)) {
        const results = seeds.map(seed => runDuel(seed, policy, opponentSpec, timing));
        games[name].push(...results);
        rows.push({ opponent, name, ...aggregate(results) });
      }
      console.log(JSON.stringify({ scenario, opponent, done: true }));
    }
    const overall = Object.fromEntries(Object.entries(games).map(([name, results]) => [name, aggregate(results)]));
    const differences = {};
    for (const name of Object.keys(candidates).filter(k => k !== 'v04')) {
      const deltas = seeds.map((_, i) => Object.keys(opponents).reduce((sum, _op, j) => sum +
        (games[name][j * n + i].expectedCash - games.v04[j * n + i].expectedCash) / 1e9, 0) / Object.keys(opponents).length);
      differences[`${name} - v04`] = pairedCash(deltas);
    }
    report.scenarios.push({ scenario, timing, rows, overall, differences });
    console.log(JSON.stringify({ scenario, overall, differences }));
  }
  for (const path of process.argv.slice(5)) {
    const data = JSON.parse(readFileSync(path, 'utf8')), file = basename(path);
    const trace = { file, botVersion: data.botVersion, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    for (const [i, samples] of readTraceMatches(path).entries()) {
      const delays = samples.map(s => s.delayFrames).filter(Number.isFinite).sort((a, b) => a - b);
      // Only the total delay is measured; this observation/input split is an approximation.
      const delay = Math.max(1, Math.round(delays[Math.floor(delays.length / 2)] ?? 7));
      const timing = { cadence: 5, obsDelay: 1, inputDelay: delay - 1 };
      const last = samples.at(-1), complete = last.phase === 'finished' && last.t >= 92 - 1e-6;
      for (const [name, policy] of Object.entries(candidates)) report.replays.push({ trace, match: i + 1, name, complete,
        through: last.t, observedPhase: last.phase, observedCash: last.cash, timing, ...runReplay(samples, policy, timing) });
    }
    report.replaySummary[file] = {};
    for (const name of Object.keys(candidates)) {
      const complete = report.replays.filter(r => r.trace.file === file && r.name === name && r.complete);
      if (complete.length) report.replaySummary[file][name] = aggregate(complete);
    }
  }
  const out = process.argv[4] || `runs/cash-${tuning ? 'tuning' : 'validation'}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ replaySummary: report.replaySummary }));
  console.log('Wrote ' + out);
}

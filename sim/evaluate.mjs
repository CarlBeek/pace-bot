// Offline evaluator over the verbatim public engine. Catastrophe is disabled only here, and terminal
// cash is weighted by exp(-integrated hazard). Policies see only player-visible fields.
import { createRequire } from 'node:module';
import { decideTarget, decideSafeFrontier, decideCpuMirror, decideAlways, PRESETS } from '../src/policy.mjs';
import { decide as decideReproduction } from '../src/controller.mjs';
import { lcgSeeds } from './seeds.mjs';
const E = createRequire(import.meta.url)('../engine/engine-original.cjs');

function visible(g, history) {
  const me = g.labs[0];
  return { t: g.t, phase: g.phase, safety: g.safety,
    own: { position: me.position, speed: me.speed, deployed: me.deployed, held: me.held },
    opponent: { deployed: g.labs[1].deployed, cash: g.labs[1].cash }, history };
}

export function makePolicy(spec) {
  switch (spec.type) {
    case 'repro': return (o, s) => decideReproduction(o, { mode: spec.mode, held: s.held, history: o.history });
    case 'target': return (o, s) => decideTarget(o, { params: { ...PRESETS[spec.preset || 'cash'], ...spec.params }, held: s.held, history: o.history, lookahead: spec.lookahead });
    case 'frontier': return (o, s) => decideSafeFrontier(o, { offset: spec.offset || 0, held: s.held });
    case 'mirror': return (o, s) => decideCpuMirror(o, { held: s.held });
    case 'always': return o => decideAlways(o);
    default: throw new Error('unknown policy ' + spec.type);
  }
}

// timing:
//  { kind:'grid', cadence:.2, phase:0 }  — decisions on a simulation-time grid (handoff reproduction)
//  { kind:'live', snapEvery:[4,5], jitterP, obsDelay:fn(rng)->frames, inputDelay:fn(rng)->frames, drop, stallP, stallFrames }
//    models the practice client: snapshots every ~4 frames, decision on arrival, input effective after delay.
export function runGame(seed, spec, timing = { kind: 'grid', cadence: .2, phase: 0 }) {
  const policy = makePolicy(spec);
  const g = E.newGame(seed); g.threshold = Infinity;
  let rng = (seed ^ 0x9e3779b9) >>> 0;
  const rand = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296;
  const hist = [];
  let held = false, k = -1, frame = 0, nextSnap = 0;
  const pendingObs = [], pendingInput = [];
  let lastIssued = false;
  while (E.active(g)) {
    if (timing.kind === 'grid') {
      const n = Math.floor((g.t - (timing.phase || 0) + 1e-8) / timing.cadence);
      if (g.phase === 'running' && n > k) {
        k = n;
        held = policy(visible(g, g.history), { held: g.labs[0].held }).held;
      }
    } else {
      // Snapshot emission.
      if (frame >= nextSnap) {
        const [a, b] = timing.snapEvery || [4, 4];
        nextSnap = frame + (rand() < (timing.jitterP ?? 0) ? b : a);
        if (!(rand() < (timing.drop || 0))) {
          const o = visible(g, null);
          o.history = hist.slice();
          const dly = timing.obsDelay ? timing.obsDelay(rand) : 0;
          pendingObs.push({ at: frame + dly, o });
          if (!hist.length || hist.at(-1).t < o.t) hist.push({ t: o.t, safety: o.safety });
        }
      }
      while (pendingObs.length && pendingObs[0].at <= frame) {
        const { o } = pendingObs.shift();
        if (o.phase !== 'running') continue;
        const d = policy(o, { held: lastIssued, age: frame - Math.round(o.t * 60) });
        if (d.held !== lastIssued) {
          lastIssued = d.held;
          pendingInput.push({ at: frame + (timing.inputDelay ? timing.inputDelay(rand) : 0), held: d.held });
        }
      }
      while (pendingInput.length && pendingInput[0].at <= frame) held = pendingInput.shift().held;
      if (timing.stallP && rand() < timing.stallP) nextSnap += timing.stallFrames || 6;
      frame++;
    }
    E.setHeld(g, 0, held); E.botStep(g); E.step(g);
  }
  const surv = Math.exp(-g.hazard);
  return { seed, cash: g.labs[0].cash, opp: g.labs[1].cash, hazard: g.hazard, surv,
    ev: g.labs[0].cash * surv, win: (g.labs[0].cash > g.labs[1].cash) * surv };
}

export function evaluate(spec, seeds, timing) {
  let ev = 0, ev2 = 0, surv = 0, win = 0, win2 = 0, cash = 0, opp = 0;
  for (const s of seeds) {
    const r = runGame(s, spec, timing);
    ev += r.ev; ev2 += r.ev * r.ev; surv += r.surv; win += r.win; win2 += r.win * r.win; cash += r.cash; opp += r.opp;
  }
  const N = seeds.length, m = ev / N, w = win / N;
  return { N, ev: m / 1e9, evSE: Math.sqrt(Math.max(0, ev2 / N - m * m) / N) / 1e9, surv: surv / N,
    win: w, winSE: Math.sqrt(Math.max(0, win2 / N - w * w) / N), cash: cash / N / 1e9, opp: opp / N / 1e9 };
}

export const SEEDS = {
  train: (n = 1000) => lcgSeeds(n, { start: 0 }),
  handoffValidation: () => lcgSeeds(1000, { start: 1000 }),
  fresh: (n = 1000) => lcgSeeds(n, { start: 2000 }),
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const seeds = SEEDS.handoffValidation();
  const grid = { kind: 'grid', cadence: .2, phase: 0 };
  const cases = [
    ['always_accelerate', { type: 'always' }, grid],
    ['ideal_cpu_mirror (60Hz)', { type: 'mirror' }, { kind: 'grid', cadence: 1 / 60, phase: 0 }],
    ['constant_frontier_plus1 (5Hz)', { type: 'frontier', offset: 1 }, grid],
    ['handoff cash (5Hz, phase .05)', { type: 'repro', mode: 'cash' }, { ...grid, phase: .05 }],
    ['handoff win (5Hz, phase .1)', { type: 'repro', mode: 'win' }, { ...grid, phase: .1 }],
  ];
  const f = x => x.toFixed(6);
  for (const [name, spec, timing] of cases) {
    const r = evaluate(spec, seeds, timing);
    console.log(`${name.padEnd(32)} ev $${f(r.ev)}B ±${(1.96 * r.evSE).toFixed(4)}  surv ${f(r.surv)}  win ${f(r.win)}`);
  }
}

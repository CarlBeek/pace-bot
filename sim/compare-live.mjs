import { evaluate, SEEDS } from './evaluate.mjs';
const seeds = SEEDS.train(Number(process.argv[2] || 400));
const live = { kind: 'live', snapEvery: [4, 5], jitterP: .1 };
const cases = [
  ['repro cash @15Hz', { type: 'repro', mode: 'cash' }],
  ['repro win @15Hz', { type: 'repro', mode: 'win' }],
  ['cpu mirror @15Hz', { type: 'mirror' }],
  ['frontier -0.1', { type: 'frontier', offset: -.1 }],
  ['frontier 0', { type: 'frontier', offset: 0 }],
  ['target cash lookahead4', { type: 'target', preset: 'cash', lookahead: 4 }],
  ['target cash noOpp', { type: 'target', preset: 'cash', params: { matchOpponent: false } }],
  ['target f0 off-.1 +opp', { type: 'target', params: { forecast: 0 } }],
  ['target f0 off0 +opp', { type: 'target', params: { forecast: 0, offset: 0 } }],
  ['target f0 off-.3 +opp', { type: 'target', params: { forecast: 0, offset: -.3 } }],
];
const which = process.argv[3];
for (const [name, spec] of cases) {
  if (which && !name.includes(which)) continue;
  const r = evaluate(spec, seeds, live);
  console.log(`${name.padEnd(26)} ev ${r.ev.toFixed(4)} ±${(1.96 * r.evSE).toFixed(3)} surv ${r.surv.toFixed(4)} win ${r.win.toFixed(4)} own ${r.cash.toFixed(2)} opp ${r.opp.toFixed(2)}`);
}

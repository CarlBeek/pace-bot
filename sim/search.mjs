// Grid search over the target family under the practice timing model, on TRAINING seeds only.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { evaluate, SEEDS } from './evaluate.mjs';
const live = JSON.parse(process.env.TIMING || 'null') || { kind: 'live', snapEvery: [4, 5], jitterP: .1 };
if (isMainThread) {
  const N = Number(process.argv[2] || 300), objective = process.argv[3] || 'ev';
  const grid = [];
  const G = JSON.parse(process.argv[4] || '{}');
  for (const forecast of G.forecast || [0, .25, .5, 1])
    for (const offset of G.offset || [-.25, -.15, -.1, -.05, 0])
      for (const oppLead of G.oppLead || [-1, -.3, 0])
        for (const hysteresis of G.hysteresis || [.1, .3])
          for (const lookahead of G.lookahead || [0, 4])
            grid.push({ type: 'target', lookahead, params: { forecast, offset, oppLead, hysteresis, maxLead: 2, matchOpponent: true } });
  const results = []; let next = 0;
  await new Promise(done => {
    let running = 0;
    const spawn = () => {
      if (next >= grid.length) { if (!running) done(); return; }
      const spec = grid[next++]; running++;
      const w = new Worker(new URL(import.meta.url), { workerData: { spec, N } });
      w.on('message', r => { results.push({ spec, r }); running--; w.terminate(); spawn(); });
    };
    for (let i = 0; i < cpus().length; i++) spawn();
  });
  results.sort((a, b) => b.r[objective] - a.r[objective]);
  for (const { spec, r } of results.slice(0, 15))
    console.log(JSON.stringify({ ...spec.params, lookahead: spec.lookahead }), r.ev.toFixed(4), r.surv.toFixed(4), r.win.toFixed(4));
} else {
  parentPort.postMessage(evaluate(workerData.spec, SEEDS.train(workerData.N), live));
}

// Final comparison on FRESH held-out seeds (LCG indices 2000..2999), never used for tuning.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { evaluate, SEEDS } from './evaluate.mjs';
const u = (a, b) => r => a + Math.floor(r() * (b - a + 1));
const TIMINGS = {
  'measured (5f, headless)': { kind: 'live', snapEvery: [5, 6], jitterP: .03 },
  '4f (60Hz timers)': { kind: 'live', snapEvery: [4, 5], jitterP: .1 },
  'degraded': { kind: 'live', snapEvery: [5, 6], jitterP: .1, obsDelay: 'u02', inputDelay: 'u02', drop: .05, stallP: .002, stallFrames: 12 },
};
const POLICIES = look => ({
  'cash (compensated)': { type: 'target', preset: 'cash', lookahead: look },
  'cash (no lookahead)': { type: 'target', preset: 'cash', lookahead: 0 },
  'cash (lookahead+horizon2)': { type: 'target', preset: 'cash', lookahead: look, params: { horizon: 2 } },
  'win (compensated)': { type: 'target', preset: 'win', lookahead: look },
  'repro-cash (handoff)': { type: 'target', preset: 'repro-cash' },
  'repro-win (handoff)': { type: 'target', preset: 'repro-win' },
  'cpu mirror': { type: 'mirror' },
  'frontier -0.1': { type: 'frontier', offset: -.1 },
});
if (isMainThread) {
  const N = Number(process.argv[2] || 1000);
  const jobs = [];
  for (const [tn, timing] of Object.entries(TIMINGS))
    for (const [pn, spec] of Object.entries(POLICIES(timing.snapEvery[0]))) jobs.push({ tn, pn, spec, timing, N });
  const results = [];
  let next = 0;
  await new Promise(done => {
    let running = 0;
    const spawn = () => {
      if (next >= jobs.length) { if (!running) done(); return; }
      const job = jobs[next++]; running++;
      const w = new Worker(new URL(import.meta.url), { workerData: job });
      w.on('message', r => { results.push({ ...job, r }); running--; w.terminate(); spawn(); });
    };
    for (let i = 0; i < cpus().length; i++) spawn();
  });
  const lines = [];
  for (const tn of Object.keys(TIMINGS)) {
    lines.push(`\n## ${tn}  (N=${N} fresh seeds)`);
    lines.push('policy'.padEnd(28) + 'E[cash] $B   ±95%    survival   P(win)   own/opp raw');
    for (const x of results.filter(x => x.tn === tn).sort((a, b) => b.r.ev - a.r.ev))
      lines.push(`${x.pn.padEnd(28)}${x.r.ev.toFixed(4).padStart(8)}  ±${(1.96 * x.r.evSE).toFixed(3)}   ${x.r.surv.toFixed(5)}   ${x.r.win.toFixed(4)}   ${x.r.cash.toFixed(2)}/${x.r.opp.toFixed(2)}`);
  }
  console.log(lines.join('\n'));
  await writeFile(new URL('../runs/offline-final.txt', import.meta.url), lines.join('\n') + '\n');
} else {
  const t = { ...workerData.timing };
  for (const k of ['obsDelay', 'inputDelay']) if (t[k] === 'u02') t[k] = u(0, 2);
  parentPort.postMessage(evaluate(workerData.spec, SEEDS.fresh(workerData.N), t));
}

// Offline head-to-head testing over the public engine. No live matches or network writes.
// Catastrophe is integrated analytically: expected cash/wins are weighted by exp(-hazard).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Agent } from '../src/agent.mjs';
import { decideTarget, PRESETS } from '../src/policy.mjs';
import { lcgSeeds } from './seeds.mjs';
const E = createRequire(import.meta.url)('../engine/engine-original.cjs');

export const OPPONENTS = {
  cpu: null,
  cautious: { ...PRESETS.cash, offset: 0, forecast: .5 },
  oldWin: { ...PRESETS.win },
  frontier: { ...PRESETS.win, offset: .5, forecast: 2 },
  aggressive: { ...PRESETS.win, offset: 1.5, forecast: 2 },
  chaser: { ...PRESETS.win, offset: .5, forecast: 1.5, oppLead: 1.5 },
};

export function observation(g, player = 0) {
  const me = g.labs[player], op = g.labs[1 - player];
  return { t: g.t, phase: g.phase, safety: g.safety, hazard: g.hazard,
    own: { position: me.position, speed: me.speed, deployed: me.deployed, held: me.held, cash: me.cash, profit: me.profit },
    opponent: { deployed: op.deployed, cash: op.cash, profit: op.profit } };
}

export function controller(spec) {
  if (typeof spec === 'function') return spec;
  return (o, state) => decideTarget(o, { params: { ...PRESETS.win, ...spec }, ...state });
}

export function runDuel(seed, spec, opponent = 'cpu', timing = {}) {
  const { cadence = 5, obsDelay = 3, inputDelay = 4, opponentDelay = 0, drop = 0 } = timing;
  const g = E.newGame(seed); g.threshold = Infinity;
  const agent = typeof spec === 'string' ? new Agent({ objective: spec }) : spec?.objective ? new Agent({ objective: spec.objective, policyParams: spec.params }) : null;
  agent?.arm(0);
  const policy = agent ? null : controller(spec);
  const opp = typeof opponent === 'function' ? opponent : OPPONENTS[opponent];
  if (opp === undefined) throw new Error('Unknown opponent: ' + opponent);
  const histories = [[], []], held = [false, false], packets = [], commands = [];
  let rng = seed >>> 0;
  const rand = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let frame = 0; E.active(g); frame++) {
    if (frame % cadence === 0 && rand() >= drop) {
      packets.push({ at: frame + obsDelay, o: observation(g), snap: { room: 'simulation', match: seed, player: 0, game: E.view(g, 0) } });
    }
    while (packets.length && packets[0].at <= frame) {
      const { o, snap } = packets.shift();
      histories[0].push({ t: o.t, safety: o.safety, opponent: o.opponent.deployed });
      if (histories[0].length > 64) histories[0].shift();
      const cmd = agent ? agent.onSnapshot(snap, frame * 1000 / 60) : policy(o, { held: held[0], history: histories[0], lookahead: cadence, delayFrames: obsDelay + inputDelay });
      if (cmd && cmd.held !== held[0]) {
        held[0] = cmd.held; commands.push({ at: frame + inputDelay, player: 0, held: cmd.held });
      }
    }
    if (opp && frame % cadence === 0) {
      const o = observation(g, 1);
      histories[1].push({ t: o.t, safety: o.safety });
      if (histories[1].length > 64) histories[1].shift();
      const state = { held: held[1], history: histories[1], lookahead: cadence };
      const d = typeof opp === 'function' ? opp(o, state) : decideTarget(o, { params: opp, ...state });
      if (d.held !== held[1]) {
        held[1] = d.held; commands.push({ at: frame + opponentDelay, player: 1, held: d.held });
      }
    }
    for (let i = 0; i < commands.length;) {
      if (commands[i].at > frame) { i++; continue; }
      const c = commands.splice(i, 1)[0]; E.setHeld(g, c.player, c.held);
    }
    if (!opp) E.botStep(g);
    E.step(g);
  }
  const survival = Math.exp(-g.hazard), cash = g.labs[0].cash, oppCash = g.labs[1].cash;
  return { cash, oppCash, survival, expectedCash: cash * survival, win: Number(cash > oppCash) * survival };
}

export function aggregate(results) {
  const mean = k => results.reduce((sum, r) => sum + r[k], 0) / results.length;
  const expectedCash = mean('expectedCash') / 1e9;
  const se = Math.sqrt(results.reduce((sum, r) => sum + (r.expectedCash / 1e9 - expectedCash) ** 2, 0) / results.length / results.length);
  return { n: results.length, expectedCash, cashSE: se, cash: mean('cash') / 1e9, opponentCash: mean('oppCash') / 1e9, win: mean('win'), survival: mean('survival') };
}

export function readTraceMatches(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const matches = [];
  for (const e of data.trace) {
    if (e.k === 'match') matches.push([]);
    if (e.k === 'obs' && matches.length) matches.at(-1).push(e);
  }
  return matches.filter(xs => xs.length > 1);
}

// Fixed opponent replay: observed safety/deployment are interpolated. It cannot model an
// opponent changing strategy in response to our new actions. Use duels for that question.
export function runReplay(samples, spec, timing = {}) {
  const { cadence = 5, obsDelay = 3, inputDelay = 4 } = timing;
  const g = E.newGame(1); g.threshold = Infinity;
  const agent = typeof spec === 'string' ? new Agent({ objective: spec }) : spec?.objective ? new Agent({ objective: spec.objective, policyParams: spec.params }) : null;
  agent?.arm(0);
  const policy = agent ? null : controller(spec);
  const history = [], packets = [], commands = [];
  let held = false, index = 0, hazard = 0, cash = 0, oppCash = 0;
  function force(t) {
    while (index + 1 < samples.length && samples[index + 1].t < t) index++;
    const a = samples[index], b = samples[Math.min(index + 1, samples.length - 1)];
    const f = b.t === a.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
    g.safety = a.S + f * (b.S - a.S);
    g.labs[1].deployed = a.opp + f * (b.opp - a.opp);
  }
  for (let frame = 0; g.t < Math.min(92, samples.at(-1).t) - 1e-7; frame++) {
    force(g.t);
    if (frame % cadence === 0) packets.push({ at: frame + obsDelay, o: observation(g), snap: {
      room: 'replay', match: 1, player: 0,
      players: [null, samples[index].opponentIdentity === null ? { kind: 'unknown' } : samples[index].opponentIdentity],
      game: E.view(g, 0) } });
    while (packets.length && packets[0].at <= frame) {
      const { o, snap } = packets.shift();
      history.push({ t: o.t, safety: o.safety, opponent: o.opponent.deployed });
      if (history.length > 64) history.shift();
      const cmd = agent ? agent.onSnapshot(snap, frame * 1000 / 60) : policy(o, { held, history, lookahead: cadence, delayFrames: obsDelay + inputDelay });
      if (cmd && cmd.held !== held) { held = cmd.held; commands.push({ at: frame + inputDelay, held }); }
    }
    while (commands.length && commands[0].at <= frame) E.setHeld(g, 0, commands.shift().held);
    const x = g.labs[0].deployed, y = g.labs[1].deployed;
    const r0 = E.hazardRate(Math.max(x, y), g.safety), p0 = E.profit(x, y), q0 = E.profit(y, x);
    E.step(g); force(g.t);
    const nx = g.labs[0].deployed, ny = g.labs[1].deployed;
    hazard += (r0 + E.hazardRate(Math.max(nx, ny), g.safety)) / 120;
    cash = Math.max(0, cash + (p0 + E.profit(nx, ny)) / 120 * E.econ.yearsPerSecond);
    oppCash = Math.max(0, oppCash + (q0 + E.profit(ny, nx)) / 120 * E.econ.yearsPerSecond);
    g.hazard = hazard; g.labs[0].cash = cash; g.labs[1].cash = oppCash;
  }
  const survival = Math.exp(-hazard);
  return { cash, oppCash, survival, expectedCash: cash * survival, win: Number(cash > oppCash) * survival };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = Number(process.argv[2] || 100);
  if (!Number.isInteger(n) || n < 1) throw new Error('game count must be a positive integer');
  const seeds = lcgSeeds(n, { start: 4000 });
  const report = { generatedAt: new Date().toISOString(), seedStart: 4000, seedsPerOpponent: n,
    engineSha256: createHash('sha256').update(readFileSync(new URL('../engine/engine-original.cjs', import.meta.url))).digest('hex'),
    timing: { cadence: 5, obsDelay: 3, inputDelay: 4, opponentDelay: 0 },
    interpretation: 'Expected cash and wins include catastrophe probability. Fixed-opponent replay cannot model opponent reactions. These are simulations, not live online results.',
    duels: [], replays: [] };
  for (const mode of ['cash', 'win', 'leaderboard', 'competitive']) {
    for (const opponent of Object.keys(OPPONENTS)) {
      const row = { mode, opponent, ...aggregate(seeds.map(seed => runDuel(seed, mode, opponent, report.timing))) };
      report.duels.push(row); console.log(JSON.stringify(row));
    }
  }
  if (process.argv[3]) {
    for (const [i, samples] of readTraceMatches(process.argv[3]).entries()) {
      for (const mode of ['cash', 'win', 'leaderboard', 'competitive']) {
        const row = { replay: i + 1, mode, observedCash: samples.at(-1).cash, observedOpponentCash: samples.at(-1).oppCash, ...runReplay(samples, mode, report.timing) };
        report.replays.push(row); console.log(JSON.stringify(row));
      }
    }
  }
  if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify(report, null, 2) + '\n');
}

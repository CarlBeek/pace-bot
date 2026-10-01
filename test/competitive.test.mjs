import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { annualProfit, catastropheRate, decideCompetitive, opponentSpeed, COMPETITIVE_PRESETS } from '../src/competitive.mjs';
import { project } from '../src/policy.mjs';

const frozen031 = { forecast: 1, opponentForecast: 3, wealth: 1, winWeight: .25,
  opponentModel: 'anchored', maxTargetGap: 2, motionModel: 'pending',
  catchupToDeployed: false, endgameSeconds: 0, deadlineAware: false };

const observation = (cash = 1e9) => ({ t: 15, phase: 'running', safety: 12,
  own: { position: 12, speed: .8, deployed: 11.5, cash }, opponent: { deployed: 12, cash: 1e9 } });

test('Leaderboard enables catch-up and the finish controller without changing Win-focused', () => {
  const p = COMPETITIVE_PRESETS.leaderboard;
  assert.equal(p.catchupToDeployed, true);
  assert.equal(p.deadlineAware, true);
  assert.equal(p.endgameSeconds, 6);
  assert.equal(p.endgameForecast, 2);
  const o = observation(); o.opponent.deployed = 18;
  assert.equal(decideCompetitive(o, { params: p }).catchup, true);
  assert.equal(decideCompetitive(o, { params: COMPETITIVE_PRESETS.competitive }).catchup, false);
  assert.equal(decideCompetitive(o, { params: COMPETITIVE_PRESETS.competitive }).endgameBlend, 0);
});

test('online delay makes the policy brake before a zero-delay policy', () => {
  const o = observation();
  assert.equal(decideCompetitive(o, { held: true, delayFrames: 0 }).held, true);
  assert.equal(decideCompetitive(o, { held: true, delayFrames: 12 }).held, false);
});

test('a larger cash balance reduces the target risk on a flat frontier', () => {
  assert.ok(decideCompetitive(observation(30e9)).target < decideCompetitive(observation(1e9)).target);
});

test('prediction uses only past public observations and caps implausible opponent speed', () => {
  const o = observation();
  const history = [{ t: 14, safety: 12, opponent: 0 }, { t: 15, safety: 12, opponent: 12 }];
  assert.ok(opponentSpeed(o, history) < 2);
  const future = [...history, { t: 16, safety: 50, opponent: 100 }];
  assert.deepEqual(decideCompetitive(o, { history: future }), decideCompetitive(o, { history }));
});

test('competitive policy rejects unavailable cash and inactive games', () => {
  const o = observation();
  assert.equal(decideCompetitive({ ...o, phase: 'finished' }).held, false);
  assert.equal(decideCompetitive({ ...o, own: { ...o.own, cash: NaN } }).held, false);
});

test('the frozen v0.3.1 ceiling remains available for comparisons', () => {
  const o = observation(); o.opponent.deployed = 18;
  const d = decideCompetitive(o, { params: frozen031 });
  assert.ok(d.target <= d.predictedSafety + 2);
});

test('catch-up exception reaches toward deployed opposition without increasing its existing hazard', () => {
  const o = observation(); o.opponent.deployed = 18;
  const d = decideCompetitive(o, { params: { ...frozen031, catchupToDeployed: true } });
  assert.ok(d.target > d.predictedSafety + 2);
  assert.ok(d.target <= o.opponent.deployed);
  assert.equal(d.targetCeiling, o.opponent.deployed);
  assert.equal(d.catchup, true);
  assert.equal(catastropheRate(Math.max(d.target, o.opponent.deployed), o.safety), catastropheRate(o.opponent.deployed, o.safety));
});

test('catch-up exception does not chase speculative future opposition above the normal ceiling', () => {
  const o = observation(); o.opponent.deployed = 14;
  const history = [{ t: 14, safety: 10, opponent: 13 }, { t: 15, safety: 12, opponent: 14 }];
  const d = decideCompetitive(o, { history, params: { ...frozen031, catchupToDeployed: true } });
  assert.ok(d.predictedOpponent > d.predictedSafety + 2);
  assert.ok(d.target <= d.predictedSafety + 2);
  assert.equal(d.catchup, false);
});

test('catch-up exception leaves the ordinary policy unchanged when the opponent is below the ceiling', () => {
  const o = observation();
  const old = decideCompetitive(o, { params: frozen031 });
  const next = decideCompetitive(o, { params: { ...frozen031, catchupToDeployed: true } });
  assert.deepEqual(next, old);
});

test('endgame forecast ramps only near the finish and does not read future history', () => {
  const o = observation(); o.t = 83;
  const params = { ...frozen031, endgameSeconds: 6, endgameForecast: 2, deadlineAware: true };
  assert.deepEqual(decideCompetitive(o, { params }), decideCompetitive(o, { params: frozen031 }));
  o.t = 89;
  const history = [{ t: 88, safety: 11, opponent: 11 }, { t: 89, safety: 12, opponent: 12 }];
  const d = decideCompetitive(o, { params, history });
  assert.ok(d.forecastSeconds > 1 && d.forecastSeconds < 2);
  assert.ok(d.predictedSafety > 13 && d.predictedSafety < 14);
  assert.deepEqual(d, decideCompetitive(o, { params, history: [...history, { t: 90, safety: 100, opponent: 100 }] }));
});

test('deadline-aware braking does not reserve coasting distance past the engine cutoff', () => {
  const o = { t: 89.9, phase: 'running', safety: 50.5,
    own: { position: 50, speed: 2.4, deployed: 48, held: true, cash: 18e9 }, opponent: { deployed: 49, cash: 17e9 } };
  const old = decideCompetitive(o, { held: true, params: frozen031 });
  const d = decideCompetitive(o, { held: true, params: { ...frozen031, deadlineAware: true } });
  assert.equal(old.held, false);
  assert.equal(d.held, true);
  assert.ok(d.stop < old.stop);
  assert.equal(d.deadlineLimited, true);
  const held = project(50, 2.4, true, 5);
  assert.equal(d.stop, project(held.x, held.v, false, 1).x);
});

test('deadline projection includes latency and rejects acceleration arriving after cutoff', () => {
  const o = { t: 89.9, phase: 'running', safety: 60,
    own: { position: 50, speed: 2, deployed: 48, held: false, cash: 18e9 }, opponent: { deployed: 49, cash: 17e9 } };
  const params = { ...frozen031, deadlineAware: true };
  const d = decideCompetitive(o, { held: false, delayFrames: 3, params });
  const delayed = project(50, 2, false, 3);
  assert.equal(d.stop, project(delayed.x, delayed.v, true, 3).x);
  assert.equal(decideCompetitive(o, { held: true, delayFrames: 12, params }).held, false);
  assert.equal(decideCompetitive({ ...o, phase: 'settling' }, { params }).held, false);
});

test('a release still in transit retains forward motion in the stopping projection', () => {
  const o = observation(); o.own.held = true;
  const options = { held: false, delayFrames: 12, pendingFrames: 6 };
  const pending = decideCompetitive(o, { ...options, params: { motionModel: 'pending' } });
  const immediate = decideCompetitive(o, { ...options, params: { motionModel: 'issued' } });
  assert.ok(pending.stop > immediate.stop);
  assert.ok(Number.isFinite(pending.stop));
});

let engine;
try { engine = createRequire(import.meta.url)('../engine/engine-original.cjs'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
test('profit and hazard formulas match the extracted public engine', { skip: !engine && 'run npm run engine for engine parity checks' }, () => {
  for (const x of [0, .01, 1, 12, 24, 40, 70]) {
    for (const y of [0, .01, 1, 12, 24, 40, 70]) {
      assert.ok(Math.abs(annualProfit(x, y) - engine.profit(x, y)) < 1e-4);
      assert.ok(Math.abs(catastropheRate(x, y) - engine.hazardRate(x, y)) < 1e-12);
    }
  }
});

test('deadline-limited stopping agrees with actual engine movement at 90 seconds', { skip: !engine && 'run npm run engine for engine parity checks' }, () => {
  const g = engine.newGame(1); g.threshold = Infinity; g.t = 89.9; g.safety = 50.5;
  Object.assign(g.labs[0], { position: 50, speed: 2.4, deployed: 48, held: true, cash: 18e9 });
  Object.assign(g.labs[1], { deployed: 49, cash: 17e9 });
  const o = { t: g.t, phase: g.phase, safety: g.safety, own: g.labs[0], opponent: g.labs[1] };
  const d = decideCompetitive(o, { held: true, params: { ...frozen031, deadlineAware: true } });
  for (let frame = 0; frame < 6; frame++) {
    engine.setHeld(g, 0, frame < 5); engine.step(g);
  }
  assert.equal(g.phase, 'settling');
  assert.equal(g.labs[0].speed, 0);
  assert.ok(Math.abs(g.labs[0].position - d.stop) < 1e-10);
});

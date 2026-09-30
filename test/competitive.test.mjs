import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { annualProfit, catastropheRate, decideCompetitive, opponentSpeed, COMPETITIVE_PRESETS } from '../src/competitive.mjs';

const observation = (cash = 1e9) => ({ t: 15, phase: 'running', safety: 12,
  own: { position: 12, speed: .8, deployed: 11.5, cash }, opponent: { deployed: 12, cash: 1e9 } });

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

test('leaderboard bounds its target during an opponent escalation', () => {
  const o = observation(); o.opponent.deployed = 18;
  const d = decideCompetitive(o, { params: COMPETITIVE_PRESETS.leaderboard });
  assert.ok(d.target <= d.predictedSafety + 2);
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

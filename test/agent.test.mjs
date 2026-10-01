import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, extractObservation } from '../src/agent.mjs';
import { decideTarget, project, PRESETS } from '../src/policy.mjs';

const snap = ({ t = 10, phase = 'running', x = 0, v = 0, held = false, S = 12, opp = 0, match = 1, room = 'practice', bot = true, ranked = false, player = 0 } = {}) => {
  const me = { position: x, speed: v, held, deployed: x, cash: 1e9, profit: 5e9 }, op = { deployed: opp, cash: 1e9, profit: 5e9 };
  return { room, match, bot, ranked, player, game: { t, phase, safety: S, hazard: 0, threshold: 0.5, labs: player === 0 ? [me, op] : [op, me], history: [] } };
};

test('observation allowlist omits hidden engine fields', () => {
  const o = extractObservation({ ...snap(), secret: 1, ticket: 'x' });
  assert.equal(JSON.stringify(o).includes('threshold'), false);
  assert.equal(JSON.stringify(o).includes('ticket'), false);
  assert.equal(extractObservation(snap({ player: 1 })).own.speed, 0);
});

test('compensated policy brakes one interval earlier than the uncompensated rule', () => {
  const obs = { t: 20, phase: 'running', safety: 12, own: { position: 10.6, speed: 1.3 }, opponent: { deployed: 0 } };
  const p = { ...PRESETS.cash, offset: 0, forecast: 0 };
  assert.equal(decideTarget(obs, { params: p, held: true, lookahead: 0 }).held, true);
  assert.equal(decideTarget(obs, { params: p, held: true, lookahead: 12 }).held, false);
});

test('projection follows the movement law and never reverses', () => {
  const s = project(5, .2, false, 60);
  assert.equal(s.v, 0);
  assert.ok(s.x > 5 && s.x < 5.1);
  assert.ok(project(0, 0, true, 60).v <= 1.5 + 1e-9);
});

test('disarmed on load; issues nothing until armed', () => {
  const a = new Agent();
  assert.equal(a.armed, false);
  assert.equal(a.onSnapshot(snap({ t: 1 }), 0), null);
  a.arm(0);
  assert.deepEqual(a.onSnapshot(snap({ t: 1.1 }), 80).held, true);
});

test('no redundant inputs while the desired state is unchanged', () => {
  const a = new Agent(); a.arm(0);
  assert.equal(a.onSnapshot(snap({ t: 1 }), 0).held, true);
  assert.equal(a.onSnapshot(snap({ t: 1.08, held: true, v: .1, x: .01 }), 80), null);
  assert.equal(a.stats.ackMs.length, 1);
});

test('duplicate and out-of-order snapshots are rejected', () => {
  const a = new Agent(); a.arm(0);
  a.onSnapshot(snap({ t: 2 }), 0);
  assert.equal(a.onSnapshot(snap({ t: 2 }), 10), null);
  assert.equal(a.onSnapshot(snap({ t: 1.9 }), 20), null);
  assert.equal(a.stats.duplicates, 1); assert.equal(a.stats.outOfOrder, 1);
});

test('match change resets history and command state', () => {
  const a = new Agent(); a.arm(0);
  a.onSnapshot(snap({ t: 30, S: 20 }), 0);
  a.onSnapshot(snap({ t: 30.5, S: 21 }), 500);
  assert.equal(a.history.length, 2);
  a.onSnapshot(snap({ t: 0.1, match: 2 }), 600);
  assert.equal(a.history.length, 1);
  assert.equal(a.match, 'practice:2');
});

test('hidden page and user stop release and disarm permanently', () => {
  for (const f of [a => a.tick(10, { hidden: true }), a => a.disarm(10)]) {
    const a = new Agent(); a.arm(0);
    assert.equal(a.onSnapshot(snap({ t: 1 }), 0).held, true);
    const cmd = f(a);
    assert.equal(cmd.held, false);
    assert.equal(a.armed, false);
    assert.equal(a.onSnapshot(snap({ t: 1.1 }), 80), null);
    assert.equal(a.onSnapshot(snap({ t: 1.2 }), 160), null);
  }
});

test('a stale snapshot pauses and releases once, then resumes after two advancing snapshots', () => {
  const a = new Agent({ staleMs: 250 }); a.arm(0);
  a.onSnapshot(snap({ t: 1 }), 0);
  assert.equal(a.tick(300).held, false);
  assert.equal(a.armed, true);
  assert.equal(a.paused, true);
  assert.equal(a.tick(350), null);
  assert.equal(a.stats.stale, 1);
  assert.equal(a.onSnapshot(snap({ t: 1 }), 360), null); // Duplicate cannot resume.
  assert.equal(a.onSnapshot(snap({ t: 1.1 }), 400), null);
  assert.equal(a.tick(420, { uiHeld: true }), null); // No stale re-press/resync.
  assert.equal(a.paused, true);
  assert.equal(a.onSnapshot(snap({ t: 1.2 }), 480)?.held, true);
  assert.equal(a.paused, false);
  assert.equal(a.trace.filter(e => e.k === 'resume').length, 1);
});

test('isolated snapshots separated by another stall do not resume input', () => {
  const a = new Agent({ staleMs: 250 }); a.arm(0);
  a.onSnapshot(snap({ t: 1 }), 0);
  a.tick(300);
  a.onSnapshot(snap({ t: 1.1 }), 400);
  assert.equal(a.onSnapshot(snap({ t: 1.2 }), 800), null);
  assert.equal(a.paused, true);
  assert.equal(a.onSnapshot(snap({ t: 1.3 }), 880)?.held, true);
});

test('Stop during a stale pause cannot auto-resume', () => {
  const a = new Agent({ staleMs: 250 }); a.arm(0);
  a.onSnapshot(snap({ t: 1 }), 0); a.tick(300); a.disarm(350);
  assert.equal(a.onSnapshot(snap({ t: 1.1 }), 400), null);
  assert.equal(a.onSnapshot(snap({ t: 1.2 }), 480), null);
  assert.equal(a.armed, false);
});

test('online and ranked snapshots are handled like any other game', () => {
  for (const s of [snap({ bot: false, room: 'abc' }), snap({ ranked: true })]) {
    const a = new Agent(); a.arm(0);
    const cmd = a.onSnapshot(s, 0);
    assert.equal(cmd?.held, true);
    assert.equal(a.armed, true);
  }
});

test('malformed snapshot disarms', () => {
  const a = new Agent(); a.arm(0);
  a.onSnapshot(snap({ t: 1 }), 0);
  assert.equal(a.onSnapshot({ game: null }, 10).held, false);
  assert.equal(a.armed, false);
});

test('match limit stops after the configured number of completed games', () => {
  const a = new Agent({ matchLimit: 1 }); a.arm(0);
  a.onSnapshot(snap({ t: 1 }), 0);
  a.onSnapshot(snap({ t: 92, phase: 'finished' }), 100);
  assert.equal(a.armed, false);
  assert.equal(a.completed, 1);
  assert.equal(a.arm(200), false);
});

test('UI disagreement is re-synced, rate limited', () => {
  const a = new Agent(); a.arm(0);
  a.onSnapshot(snap({ t: 1 }), 0);
  a.onSnapshot(snap({ t: 1.08, held: true }), 80);
  assert.equal(a.tick(90, { uiHeld: false }).held, true);
  assert.equal(a.tick(100, { uiHeld: false }), null);
});

test('new match reissues a hold even when the previous match ended without a release snapshot', () => {
  const a = new Agent(); a.arm(0);
  assert.equal(a.onSnapshot(snap({ t: 20, match: 1 }), 0).held, true);
  assert.equal(a.onSnapshot(snap({ t: .1, match: 2 }), 100).held, true);
  assert.equal(a.recentAckGame.length, 0);
});

test('resync retries preserve acknowledgement timing and remain rate limited', () => {
  const a = new Agent(); a.arm(0);
  a.onSnapshot(snap({ t: 1 }), 0);
  assert.equal(a.tick(60, { uiHeld: false }).held, true);
  assert.equal(a.tick(80, { uiHeld: false }), null);
  a.onSnapshot(snap({ t: 1 + 10 / 60, held: true }), 167);
  assert.deepEqual(a.stats.ackMs, [167]);
  assert.ok(Math.abs(a.recentAckGame[0] - 10 / 60) < 1e-10);
  assert.ok(a.decision.delayFrames > 0);
});

test('run cash average includes zero-score crashes, honors terminal scores, and counts each match once', () => {
  const a = new Agent({ matchLimit: 3 }); a.arm(0);
  assert.equal(a.performance().averageCash, null);
  a.onSnapshot(snap({ t: 1 }), 0);
  const finish = snap({ t: 92, phase: 'finished' });
  finish.game.scores = [20e9, 15e9];
  a.onSnapshot(finish, 100);
  a.onSnapshot(finish, 110);
  assert.deepEqual(a.performance(), { games: 1, averageCash: 20e9, wins: 1, crashes: 0 });
  a.onSnapshot(snap({ t: 1, match: 2 }), 200);
  a.onSnapshot(snap({ t: 30, match: 2, phase: 'crashed' }), 300);
  assert.deepEqual(a.performance(), { games: 2, averageCash: 10e9, wins: 1, crashes: 1 });
  a.onSnapshot(snap({ t: 1, match: 3, player: 1 }), 400);
  const forfeit = snap({ t: 20, match: 3, player: 1, phase: 'finished' });
  forfeit.game.scores = [10e9, 0];
  a.onSnapshot(forfeit, 500);
  assert.deepEqual(a.performance(), { games: 3, averageCash: 20e9 / 3, wins: 1, crashes: 1 });
});

test('participated games finishing while disarmed still count toward the limit and average', () => {
  const a = new Agent({ matchLimit: 1 }); a.arm(0);
  a.onSnapshot(snap({ t: 1 }), 0);
  a.disarm(50);
  a.onSnapshot(snap({ t: 92, phase: 'finished' }), 100);
  assert.equal(a.completed, 1);
  assert.equal(a.performance().games, 1);
  assert.equal(a.arm(150), false);
});

test('a terminal snapshot during a pause counts, but merely observed games do not', () => {
  const a = new Agent({ matchLimit: 2, staleMs: 250 });
  a.onSnapshot(snap({ t: 92, phase: 'finished' }), 0);
  assert.equal(a.completed, 0);
  a.arm(100);
  a.onSnapshot(snap({ t: 1, match: 2 }), 200);
  a.tick(500);
  a.onSnapshot(snap({ t: 2, match: 2, phase: 'crashed' }), 600);
  assert.equal(a.completed, 1);
  assert.equal(a.paused, false);
  assert.equal(a.armed, true);
  assert.equal(a.onSnapshot(snap({ t: .1, match: 3 }), 700)?.held, true);
});

test('a same-time terminal transition counts exactly once', () => {
  const a = new Agent(); a.arm(0);
  a.onSnapshot(snap({ t: 10 }), 0);
  a.onSnapshot(snap({ t: 10, phase: 'finished' }), 100);
  a.onSnapshot(snap({ t: 10, phase: 'finished' }), 200);
  assert.equal(a.completed, 1);
  assert.equal(a.armed, false);
});

test('match limits are whole numbers from 1 to 50 and lowering to the completed count stops', () => {
  const a = new Agent({ matchLimit: 3 }); a.arm(0);
  a.onSnapshot(snap({ t: 1 }), 0);
  a.onSnapshot(snap({ t: 92, phase: 'finished' }), 100);
  a.setMatchLimit(1, 200);
  assert.equal(a.armed, false);
  assert.equal(a.arm(300), false);
  for (const [n, expected] of [[NaN, 1], [0, 1], [Infinity, 50], [2.7, 2], ['5', 5], [999, 50]]) {
    a.setMatchLimit(n, 400);
    assert.equal(a.matchLimit, expected);
  }
});

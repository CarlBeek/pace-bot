import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.mjs';
import { ReplayQueue } from '../src/replay.mjs';

function snapshot(match, phase = 'running') {
  return { room: 'online', match, player: 0, game: { t: phase === 'running' ? 1 : 92, phase, safety: 12, hazard: 0,
    labs: [{ position: 0, speed: 0, deployed: 0, held: false, cash: 1e9, profit: 5e9 }, { deployed: 0, cash: 1e9, profit: 5e9 }] } };
}

function fixture(limit = 3) {
  const agent = new Agent({ matchLimit: limit }), queue = new ReplayQueue();
  let clicks = 0;
  const button = { isConnected: true, disabled: false, getAttribute: () => null, getClientRects: () => [1], click: () => { clicks++; } };
  agent.arm(0);
  const finish = (match, now, phase = 'finished') => {
    agent.onSnapshot(snapshot(match), now);
    agent.onSnapshot(snapshot(match, phase), now + 80);
  };
  return { agent, queue, button, finish, clicks: () => clicks,
    tick: (now, extra = {}) => queue.tick(now, { agent, button, ...extra }) };
}

test('automatically requests successive games once each, including after a crash, then stops at the limit', () => {
  const f = fixture(3);
  f.finish(1, 0); f.tick(100); f.tick(1099);
  assert.equal(f.clicks(), 0);
  f.tick(1100); f.tick(2000); f.tick(5000);
  assert.equal(f.clicks(), 1);
  f.finish(2, 6000, 'crashed'); f.tick(6100); f.tick(7100);
  assert.equal(f.clicks(), 2);
  f.finish(3, 8000); f.tick(8100); f.tick(20000);
  assert.equal(f.clicks(), 2);
  assert.equal(f.agent.completed, 3);
  assert.equal(f.agent.armed, false);
  assert.equal(f.agent.trace.filter(e => e.k === 'replay').length, 2);
});

test('Stop cancels a pending replay; rearming does not duplicate an already requested replay', () => {
  const f = fixture(); f.finish(1, 0); f.tick(100);
  f.agent.disarm(500); f.tick(1100);
  assert.equal(f.clicks(), 0);
  f.agent.arm(1200); f.tick(1200); f.tick(2200);
  assert.equal(f.clicks(), 1);
  f.agent.disarm(2300); f.tick(2300); f.agent.arm(2400); f.tick(4000);
  assert.equal(f.clicks(), 1);
});

test('replay waits for an enabled visible connected button, and never clicks while hidden', () => {
  const f = fixture(); f.finish(1, 0); f.tick(100);
  f.button.disabled = true; f.tick(1100);
  f.button.disabled = false; f.button.isConnected = false; f.tick(1200);
  f.button.isConnected = true; f.button.getClientRects = () => []; f.tick(1300);
  f.button.getClientRects = () => [1]; f.button.getAttribute = () => 'true'; f.tick(1400);
  f.button.getAttribute = () => null; f.tick(1500, { hidden: true });
  assert.equal(f.clicks(), 0);
  f.tick(1600); f.tick(2600);
  assert.equal(f.clicks(), 1);
});

test('lowering the limit or starting another game cancels a scheduled click', () => {
  for (const action of [f => f.agent.setMatchLimit(1, 500), f => f.agent.onSnapshot(snapshot(2), 500)]) {
    const f = fixture(); f.finish(1, 0); f.tick(100); action(f); f.tick(1100);
    assert.equal(f.clicks(), 0);
  }
});

test('does not queue from the lobby, an active game, or a game only observed while disarmed', () => {
  const f = fixture(); f.tick(0); f.tick(2000);
  f.agent.onSnapshot(snapshot(1), 2100); f.tick(2200); f.tick(4000);
  assert.equal(f.clicks(), 0);
  const other = fixture(); other.agent.disarm(0); other.finish(1, 100); other.agent.arm(200);
  other.tick(300); other.tick(3000);
  assert.equal(other.clicks(), 0);
});

test('raising a reached limit and rearming continues from the last result without resetting the count', () => {
  const f = fixture(1); f.finish(1, 0); f.tick(100); f.tick(1100);
  assert.equal(f.clicks(), 0);
  f.agent.setMatchLimit(2, 1200); f.agent.arm(1200); f.tick(1200); f.tick(2200);
  assert.equal(f.clicks(), 1);
  assert.equal(f.agent.completed, 1);
});

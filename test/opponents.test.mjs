import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent, extractObservation } from '../src/agent.mjs';
import { EGORNOMIC_CASH, readOpponentIdentity, selectOpponentProfile } from '../src/opponents.mjs';

const account = username => ({ kind: 'twitter', username });
function match({ opponent = account('egornomic'), player = 0, match = 1, t = 30, phase = 'running', metadata = true } = {}) {
  const players = [account('carl'), opponent];
  const labs = [{ position: 20, speed: 1, held: false, deployed: 18, cash: 5e9, profit: 5e9 },
    { deployed: 19, cash: 9e9, profit: 5e9 }];
  return { room: 'online', match, player, ...(metadata ? { players: player ? players.reverse() : players } : {}),
    game: { t, phase, safety: 20, hazard: 0, labs: player ? labs.reverse() : labs } };
}

test('identity allowlist copies only public account type and canonical username', () => {
  assert.deepEqual(readOpponentIdentity({ ...account('EgOrNoMiC'), id: 'unused', token: 'secret', avatar: 'unused', name: 'unused' }), account('egornomic'));
  assert.equal(readOpponentIdentity(undefined), undefined);
  for (const p of [{ kind: 'guest', name: '@egornomic' }, { kind: 'bot', username: 'egornomic' },
    account('egornomic '), account('@egornomic'), account('egornomіc'), account('<script>'), account(123), {}]) {
    assert.equal(readOpponentIdentity(p), null);
  }
  const o = extractObservation(match({ opponent: { ...account('egornomic'), token: 'secret' } }));
  assert.deepEqual(o.opponent.identity, account('egornomic'));
  assert.equal(JSON.stringify(o).includes('secret'), false);
});

test('only the exact account selects the dedicated Leaderboard policy', () => {
  assert.equal(selectOpponentProfile('leaderboard', account('egornomic')), EGORNOMIC_CASH);
  for (const username of ['ergonomic', 'egornomic_bot', 'notegornomic', 'egornomi', 'constructor', '__proto__'])
    assert.equal(selectOpponentProfile('leaderboard', account(username)), null);
  for (const mode of ['competitive', 'cash', 'win', 'repro-cash', 'repro-win'])
    assert.equal(selectOpponentProfile(mode, account('egornomic')), null);
  assert.equal(selectOpponentProfile('leaderboard', null), null);
});

test('opponent selection uses the other seat and switches on the first running snapshot', () => {
  for (const player of [0, 1]) {
    const a = new Agent(); a.arm(0); a.onSnapshot(match({ player, opponent: account('EgOrNoMiC') }), 0);
    assert.equal(a.profileId, EGORNOMIC_CASH.id);
    assert.equal(a.decision.forecastSeconds, 2);
    assert.equal(a.trace.find(e => e.k === 'obs').profile, EGORNOMIC_CASH.id);
    const b = new Agent(); b.arm(0);
    const snap = match({ player, opponent: account('someone_else') }); snap.players[player] = account('egornomic');
    b.onSnapshot(snap, 0);
    assert.equal(b.profileId, 'leaderboard');
    assert.equal(b.decision.forecastSeconds, 1);
  }
});

test('metadata-free deltas retain identity, but each new match starts from general', () => {
  const a = new Agent(); a.arm(0); a.onSnapshot(match(), 0);
  a.onSnapshot(match({ t: 30.1, metadata: false }), 80);
  assert.equal(a.profileId, EGORNOMIC_CASH.id);
  a.onSnapshot(match({ t: .1, match: 2, metadata: false }), 160);
  assert.equal(a.profileId, 'leaderboard');
  assert.equal(a.opponentIdentity, null);
  assert.equal(a.decision.forecastSeconds, 1);
  a.onSnapshot(match({ t: .2, match: 2 }), 240);
  assert.equal(a.profileId, EGORNOMIC_CASH.id);
  a.onSnapshot(match({ t: .1, match: 3, opponent: account('someone_else') }), 320);
  assert.equal(a.profileId, 'leaderboard');
});

test('contradictory or invalid metadata clears the profile; stale snapshots cannot select it', () => {
  const a = new Agent(); a.arm(0); a.onSnapshot(match(), 0);
  a.onSnapshot(match({ t: 30.1, opponent: { kind: 'guest', name: '@egornomic' } }), 80);
  assert.equal(a.profileId, 'leaderboard');
  a.onSnapshot(match({ t: 30 }), 160);
  a.onSnapshot(match({ t: 30.1 }), 240);
  assert.equal(a.profileId, 'leaderboard');
});

test('manual objective changes bypass routing without changing armed or match-limit state', () => {
  const a = new Agent({ matchLimit: 3 }); a.arm(0); a.onSnapshot(match(), 0);
  a.objective = 'competitive'; a.onSnapshot(match({ t: 30.1 }), 80);
  assert.equal(a.profileId, 'competitive');
  assert.equal(a.decision.forecastSeconds, 1.5);
  a.objective = 'leaderboard'; a.onSnapshot(match({ t: 30.2 }), 160);
  assert.equal(a.profileId, EGORNOMIC_CASH.id);
  assert.equal(a.armed, true);
  assert.equal(a.matchLimit, 3);
  assert.equal(a.completed, 0);
});

test('cash-only profile ignores relative bankroll and records zero-score crashes under its identity', () => {
  const decisions = [];
  for (const cash of [0, 100e9]) {
    const a = new Agent(); a.arm(0);
    const s = match(); s.game.labs[1].cash = cash; a.onSnapshot(s, 0); decisions.push(a.decision);
    a.onSnapshot(match({ t: 31, phase: 'crashed', metadata: false }), 80);
    assert.equal(a.results[0].cash, 0);
    assert.equal(a.results[0].profile, EGORNOMIC_CASH.id);
    assert.deepEqual(a.results[0].profilesUsed, [EGORNOMIC_CASH.id]);
    assert.deepEqual(a.results[0].opponent, account('egornomic'));
    assert.equal(a.performance().averageCash, 0);
    assert.equal(a.armed, false);
  }
  assert.deepEqual(decisions[0], decisions[1]);
});

test('dedicated profile exactly matches the frozen cash-validation candidate', () => {
  const report = JSON.parse(readFileSync(new URL('../runs/cash-validation.json', import.meta.url), 'utf8'));
  assert.deepEqual(EGORNOMIC_CASH.params, report.candidates.forecast20.params);
  assert.equal(EGORNOMIC_CASH.params.winWeight, 0);
  assert.equal(Object.isFrozen(EGORNOMIC_CASH.params), true);
});

let replay;
try { ({ runReplay: replay } = await import('../sim/online.mjs')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
test('identity-bearing trace replay routes exactly like the validated cash-only candidate', { skip: !replay && 'run npm run engine for replay checks' }, () => {
  const samples = Array.from({ length: 81 }, (_, i) => ({ t: i / 2, S: 12 + Math.max(0, i / 2 - 18) * .8,
    opp: Math.min(12, i / 2) + Math.max(0, i / 2 - 18) * .9, opponentIdentity: account('egornomic') }));
  const explicit = { objective: 'leaderboard', params: EGORNOMIC_CASH.params };
  const anonymous = samples.map(({ opponentIdentity, ...s }) => s);
  const routed = replay(samples, 'leaderboard');
  assert.deepEqual(routed, replay(anonymous, explicit));
  assert.notEqual(routed.cash, replay(anonymous, 'leaderboard').cash);
});

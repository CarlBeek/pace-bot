import test from 'node:test';
import assert from 'node:assert/strict';

let traceMatches;
try { ({ traceMatches } = await import('../sim/online.mjs')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
test('offline analysis reads both session traces and saved-game archives without merging matches',
  { skip: !traceMatches && 'run npm run engine for replay checks' }, () => {
    const one = { trace: [{ k: 'match', match: 'one' }, { k: 'obs', t: 0 }, { k: 'obs', t: 92 }] };
    const two = { trace: [{ k: 'obs', t: 500 }, { k: 'match', match: 'two' }, { k: 'obs', t: 0 }, { k: 'obs', t: 30 }] };
    assert.deepEqual(traceMatches(one), [[one.trace[1], one.trace[2]]]);
    assert.deepEqual(traceMatches({ type: 'pace-bot-archive', traces: [one, two] }),
      [[one.trace[1], one.trace[2]], [two.trace[2], two.trace[3]]]);
  });

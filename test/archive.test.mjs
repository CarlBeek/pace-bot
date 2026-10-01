import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { TraceArchive } from '../src/archive.mjs';

const record = (id, cash = 1e9) => ({ id, data: { trace: [{ k: 'match', match: id }, { k: 'end', cash }] } });

test('committed traces persist across archive instances and duplicate keys do not create extra records', async () => {
  const database = new IDBFactory(), a = new TraceArchive(database);
  assert.equal(await a.save(record('one')), true);
  assert.equal(await a.save(record('one')), true);
  assert.equal(await a.save(record('two', 0)), true);
  assert.equal(a.pending.size, 0);
  const b = new TraceArchive(database);
  assert.equal(await b.count(), 2);
  assert.deepEqual((await b.records()).records, [record('one'), record('two', 0)]);
});

test('an aborted transaction is not reported as saved even if the put request succeeds', async () => {
  const a = new TraceArchive(new IDBFactory());
  const db = await a.open(), original = db.transaction.bind(db);
  db.transaction = (...args) => {
    const tx = original(...args), objectStore = tx.objectStore.bind(tx);
    tx.objectStore = (...storeArgs) => {
      const store = objectStore(...storeArgs), put = store.put.bind(store);
      store.put = value => { const request = put(value); request.onsuccess = () => tx.abort(); return request; };
      return store;
    };
    return tx;
  };
  assert.equal(await a.save(record('failed')), false);
  assert.equal(a.saved, 0);
  assert.equal(a.pending.size, 1);
  assert.match(a.error, /aborted/);
  db.transaction = original;
  assert.equal(await a.count(), 0);
  assert.deepEqual((await a.records()).records, [record('failed')]);
  assert.equal(await a.save(record('failed')), true);
  assert.equal(await a.count(), 1);
  assert.equal(a.pending.size, 0);
  assert.equal(a.error, null);
});

test('storage quota errors retain data and reads merge persisted and pending traces', async () => {
  const a = new TraceArchive(new IDBFactory());
  await a.save(record('saved'));
  const db = await a.open(), original = db.transaction.bind(db);
  db.transaction = (...args) => { if (args[1] === 'readwrite') throw new Error('QuotaExceededError'); return original(...args); };
  assert.equal(await a.save(record('pending')), false);
  assert.match(a.error, /QuotaExceededError/);
  assert.deepEqual((await a.records()).records, [record('pending'), record('saved')]);
});

test('unavailable storage exposes a warning rather than silently claiming a complete archive', async () => {
  const a = new TraceArchive(null);
  await assert.rejects(a.records(), /Could not read stored traces/);
  assert.equal(await a.save(record('in-memory')), false);
  const exported = await a.records();
  assert.deepEqual(exported.records, [record('in-memory')]);
  assert.match(exported.warning, /Only in-memory/);
});

test('archive export sorts games chronologically rather than by their random match IDs', async () => {
  const a = new TraceArchive(new IDBFactory());
  for (const [id, gameNumber] of [['a', 10], ['z', 2]]) {
    const r = record(id); Object.assign(r.data, { exportedAt: '2026-10-01T03:00:00.000Z', gameNumber });
    await a.save(r);
  }
  assert.deepEqual((await a.records()).records.map(r => r.data.gameNumber), [2, 10]);
});

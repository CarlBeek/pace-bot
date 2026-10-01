// Exercise the generated extension and its timers without opening the user's browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTick } from 'node:timers/promises';
import { IDBFactory } from 'fake-indexeddb';
import { TraceArchive } from '../src/archive.mjs';

let sessionNumber = 0;
async function browserFixture({ database = new IDBFactory() } = {}) {
  let now = 0, clicks = 0, match = 0;
  const timers = new Map();
  const downloads = [], urls = new Map(), timeouts = [];
  const waitFor = async predicate => {
    for (let i = 0; i < 10000; i++) { if (predicate()) return; await nextTick(); }
    assert.fail('timed out waiting for database operation');
  };
  const docEvents = new Map(), winEvents = new Map();
  const listen = events => (type, cb) => events.set(type, [...(events.get(type) ?? []), cb]);
  const emit = (events, type, event = {}) => { for (const cb of events.get(type) ?? []) cb(event); };
  class Element {
    constructor() { this.attributes = new Map(); this.isConnected = true; this.disabled = false; this.value = ''; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    getClientRects() { return this.hidden ? [] : [1]; }
    attachShadow() { return this.shadowRoot = new Root(); }
    appendChild(child) { this.child = child; }
    remove() { this.isConnected = false; }
    click() {
      if (this.download) downloads.push({ filename: this.download, blob: urls.get(this.href) });
      return this.onclick?.();
    }
  }
  class Root {
    constructor() { this.elements = new Map(); }
    set innerHTML(html) {
      for (const [tag, id] of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const e = new Element();
        for (const [, k, v] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) e.setAttribute(k, v);
        e.value = e.getAttribute('value') ?? '';
        this.elements.set(id, e);
      }
    }
    getElementById(id) { return this.elements.get(id) ?? null; }
    querySelector(selector) { return this.getElementById(selector.slice(1)); }
  }
  class Host extends Element {
    constructor() {
      super(); this.attachShadow();
      this.shadowRoot.innerHTML = '<button id="accelerator"></button><button id="again"></button>';
      this.shadowRoot.querySelector('#again').onclick = () => { clicks++; start(); };
    }
    showMatch(snap) { this.shadowRoot.querySelector('#again').disabled = ['running', 'settling'].includes(snap.game.phase); }
    dispatchEvent(event) { this.shadowRoot.querySelector('#accelerator').setAttribute('aria-pressed', event.type === 'keydown'); }
  }
  const host = new Host(), body = new Element();
  const doc = { body, hidden: false, createElement: () => new Element(), querySelector: () => host, addEventListener: listen(docEvents) };
  const win = { document: doc, performance: { now: () => now }, customElements: { get: () => Host, whenDefined: () => Promise.resolve() },
    indexedDB: database, crypto: { randomUUID: () => `test-session-${++sessionNumber}` }, setTimeout: cb => timeouts.push(cb),
    setInterval: cb => { const id = timers.size + 1; timers.set(id, cb); return id; }, clearInterval: id => timers.delete(id), addEventListener: listen(winEvents) };
  runInNewContext(readFileSync(new URL('../extension/pace-bot.js', import.meta.url), 'utf8'), {
    Blob, URL: { createObjectURL: blob => { const url = `blob:test-${urls.size}`; urls.set(url, blob); return url; }, revokeObjectURL: url => urls.delete(url) },
    window: win, KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  });
  await Promise.resolve(); // customElements.whenDefined() patches Host.showMatch.
  const api = win.__paceBot;
  function deliver(t, phase = 'running', players) {
    host.showMatch({ room: 'test', match, player: 0, players, game: { t, phase, safety: 12, hazard: 0,
      labs: [{ position: 0, speed: 0, deployed: 0, held: false, cash: 1e9, profit: 5e9 }, { deployed: 0, cash: 1e9, profit: 5e9 }] } });
  }
  function start(players) { match++; deliver(.1, 'running', players); }
  const tick = time => { now = time; for (const cb of timers.values()) cb(); };
  return { api, doc, host, start, deliver, tick, clicks: () => clicks, ui: body.child.shadowRoot,
    database, downloads, waitFor, readSaved: () => new TraceArchive(database).records(),
    setHidden: value => { doc.hidden = value; emit(docEvents, 'visibilitychange'); },
    emitWindow: (type, event) => emit(winEvents, type, event) };
}

test('built extension plays the next game through the UI and stops exactly at the limit', async () => {
  const f = await browserFixture();
  assert.equal(f.api.status().patched, true);
  f.api.setMatchLimit(2); f.start();
  assert.equal(f.api.status().issued, true);
  f.deliver(92, 'finished'); f.tick(100); f.tick(1100);
  assert.equal(f.clicks(), 1);
  assert.equal(f.api.status().last.match, 'test:2');
  assert.equal(f.api.status().armed, true);
  assert.equal(f.api.status().issued, true);
  f.deliver(30, 'crashed'); f.tick(1200); f.tick(3000);
  assert.equal(f.clicks(), 1);
  assert.equal(f.api.status().completed, 2);
  assert.equal(f.api.status().armed, false);
  assert.equal(f.api.export().botVersion, '0.7.0');
  assert.equal(f.ui.getElementById('cnt').textContent, '2 / 2');
  assert.equal(f.ui.getElementById('st').textContent, 'LIMIT REACHED');
});

test('live extension has one cash objective and no policy selector or switching API', async () => {
  const f = await browserFixture();
  assert.equal(f.ui.getElementById('obj'), null);
  assert.equal(f.api.setObjective, undefined);
  assert.equal(f.api.status().objective, 'leaderboard');
  assert.throws(() => { f.api.agent.objective = 'competitive'; }, TypeError);
  f.start();
  assert.equal(f.api.status().profile, 'leaderboard');
  assert.equal(f.api.status().objective, 'leaderboard');
});

test('built extension shows exact opponent routing, exports it, and resets on autoplay', async () => {
  const f = await browserFixture();
  f.api.setMatchLimit(2);
  f.start([{ kind: 'twitter', username: 'carl' }, { kind: 'twitter', username: 'EgOrNoMiC' }]);
  f.tick(100);
  assert.equal(f.api.status().profile, 'egornomic-cash-v1');
  assert.equal(f.ui.getElementById('opponent').textContent, '@egornomic');
  assert.equal(f.ui.getElementById('profile').textContent, '@egornomic cash');
  assert.equal(f.api.agent.decision.forecastSeconds, 2);
  f.deliver(92, 'finished');
  const exported = f.api.export();
  assert.equal(exported.version, 3);
  assert.equal(exported.results[0].profile, 'egornomic-cash-v1');
  assert.equal(exported.results[0].opponent.username, 'egornomic');
  assert.ok(exported.trace.some(e => e.k === 'profile' && e.profile === 'egornomic-cash-v1'));
  f.tick(200); f.tick(1200);
  assert.equal(f.clicks(), 1);
  assert.equal(f.api.status().profile, 'leaderboard');
  assert.equal(f.api.status().opponent, null);
  assert.equal(f.api.agent.decision.forecastSeconds, 1);
  f.tick(1300);
  assert.equal(f.ui.getElementById('profile').textContent, 'general');
  assert.equal(f.ui.getElementById('cnt').textContent, '1 / 2');
});

test('built extension keeps the old misspelled account on the general profile', async () => {
  const f = await browserFixture();
  f.start([{ kind: 'twitter', username: 'carl' }, { kind: 'twitter', username: 'ergonomic' }]);
  f.tick(100);
  assert.equal(f.api.status().profile, 'leaderboard');
  assert.equal(f.ui.getElementById('opponent').textContent, '@ergonomic');
  assert.equal(f.ui.getElementById('profile').textContent, 'general');
  assert.equal(f.api.agent.decision.forecastSeconds, 1);
});

test('built extension is armed on load with no Start/Stop controls and a 999 default and ceiling', async () => {
  const f = await browserFixture();
  assert.equal(f.api.status().armed, true);
  assert.equal(f.ui.getElementById('st').textContent, 'ARMED');
  assert.equal(f.ui.getElementById('start'), null);
  assert.equal(f.ui.getElementById('stop'), null);
  assert.equal(f.api.arm, undefined);
  assert.equal(f.api.stop, undefined);
  const lim = f.ui.getElementById('lim');
  assert.equal(lim.getAttribute('max'), '999');
  assert.equal(Number(lim.value), 999);
  assert.equal(f.api.agent.matchLimit, 999);
  f.api.setMatchLimit(10000);
  assert.equal(f.api.agent.matchLimit, 999);
  lim.value = '77'; lim.onchange();
  assert.equal(f.api.agent.matchLimit, 77);
  f.start();
  f.emitWindow('keydown', { key: 'Escape', isTrusted: true });
  assert.equal(f.api.status().armed, true);
});

test('lowering the limit cancels autoplay; raising it resumes without Start', async () => {
  const f = await browserFixture();
  f.api.setMatchLimit(3); f.start();
  f.deliver(92, 'finished'); f.tick(100);
  f.api.setMatchLimit(1); f.tick(1500);
  assert.equal(f.clicks(), 0);
  assert.equal(f.api.status().armed, false);
  f.api.setMatchLimit(999); f.tick(1600); f.tick(2600);
  assert.equal(f.clicks(), 1);
  assert.equal(f.api.status().armed, true);
  assert.equal(f.api.status().completed, 1);
});

test('built extension pauses through a brief stall and resumes automatically even while hidden', async () => {
  const f = await browserFixture(); f.start(); f.setHidden(true); f.tick(400);
  assert.equal(f.api.status().paused, true);
  assert.equal(f.api.status().uiHeld, false);
  assert.equal(f.ui.getElementById('st').textContent, 'PAUSED');
  f.deliver(.2); assert.equal(f.api.status().paused, true);
  f.tick(480); f.deliver(.3);
  assert.equal(f.api.status().paused, false);
  assert.equal(f.api.status().issued, true);
  f.tick(500);
  assert.equal(f.api.status().armed, true);
  f.setHidden(false); f.deliver(.4); f.deliver(.5);
  assert.equal(f.api.status().armed, true);
});

test('hidden pages continue playing and queuing new matches up to the limit', async () => {
  const f = await browserFixture(); f.api.setMatchLimit(2); f.start();
  f.setHidden(true); f.tick(100); f.deliver(.2);
  assert.equal(f.api.status().armed, true);
  assert.equal(f.api.status().issued, true);
  f.deliver(92, 'finished'); f.tick(200); f.tick(1200);
  assert.equal(f.clicks(), 1);
  assert.equal(f.api.status().issued, true);
  f.deliver(40, 'crashed'); f.tick(1300); f.tick(3000);
  assert.equal(f.clicks(), 1);
  assert.equal(f.api.status().armed, false);
});

test('page suspension releases input and restoration recovers without manual arming', async () => {
  const f = await browserFixture(); f.start();
  f.emitWindow('pagehide');
  assert.equal(f.api.status().armed, true);
  assert.equal(f.api.status().paused, true);
  assert.equal(f.api.status().uiHeld, false);
  f.deliver(.2); f.tick(1000);
  assert.equal(f.api.status().last.t, .1);
  f.emitWindow('pageshow'); f.deliver(.3);
  assert.equal(f.api.status().paused, true);
  f.tick(1080); f.deliver(.4);
  assert.equal(f.api.status().paused, false);
  assert.equal(f.api.status().issued, true);
});

test('malformed snapshots and adapter errors pause without permanently disabling play', async () => {
  for (const kind of ['malformed', 'error']) {
    const f = await browserFixture(); f.start();
    if (kind === 'malformed') f.host.showMatch({ game: { phase: 'running' } });
    else {
      const original = f.api.agent.onSnapshot;
      f.api.agent.onSnapshot = () => { throw new Error('test fault'); };
      f.deliver(.2); f.api.agent.onSnapshot = original;
    }
    assert.equal(f.api.status().armed, true);
    assert.equal(f.api.status().paused, true);
    assert.equal(f.api.status().uiHeld, false);
    f.tick(80); f.deliver(.3);
    assert.equal(f.api.status().paused, true);
    f.tick(160); f.deliver(.4);
    assert.equal(f.api.status().paused, false);
    assert.equal(f.api.status().issued, true);
  }
});

test('destroy releases input and cannot be revived by callbacks or raising the limit', async () => {
  const f = await browserFixture(); f.start(); f.api.destroy();
  f.emitWindow('pageshow'); f.api.setMatchLimit(999); f.deliver(.2); f.tick(5000);
  assert.equal(f.api.status().armed, false);
  assert.equal(f.api.status().uiHeld, false);
  assert.equal(f.clicks(), 0);
});

test('a full 999-game session counts every result and never queues game 1000', async () => {
  const f = await browserFixture(); f.start();
  for (let n = 1; n <= 999; n++) {
    f.deliver(n % 2 ? 92 : 30, n % 2 ? 'finished' : 'crashed');
    f.tick(n * 2000); f.tick(n * 2000 + 1000);
  }
  assert.equal(f.api.status().completed, 999);
  assert.equal(f.api.export().results.length, 999);
  assert.equal(f.api.status().performance.crashes, 499);
  assert.equal(f.clicks(), 998);
  assert.equal(f.api.status().armed, false);
  assert.equal(f.ui.getElementById('cnt').textContent, '999 / 999');
  assert.equal(f.ui.getElementById('st').textContent, 'LIMIT REACHED');
  await f.waitFor(() => f.api.status().storage.saved === 999 && f.api.status().storage.pending === 0);
  assert.equal((await f.readSaved()).records.length, 999);
  assert.equal(f.downloads.length, 0);
});

test('each finished or crashed game is stored once with its own full trace and terminal input', async () => {
  const f = await browserFixture(); f.api.setMatchLimit(2);
  f.start([{ kind: 'twitter', username: 'carl' }, { kind: 'twitter', username: 'EgOrNoMiC' }]);
  f.deliver(92, 'finished'); f.deliver(92, 'finished');
  f.tick(100); f.tick(1100); f.deliver(30, 'crashed'); f.deliver(30, 'crashed');
  await f.waitFor(() => f.api.status().storage.saved === 2);
  const { records } = await f.readSaved();
  assert.equal(records.length, 2);
  assert.equal(f.downloads.length, 0);
  for (const [i, { data }] of records.entries()) {
    assert.equal(data.scope, 'game');
    assert.equal(data.gameNumber, i + 1);
    assert.equal(data.results.length, 1);
    assert.equal(data.performance.games, 1);
    assert.equal(data.trace.filter(e => e.k === 'match').length, 1);
    assert.equal(data.trace.find(e => e.k === 'match').match, data.match);
    assert.equal(data.trace.filter(e => e.k === 'end').length, 1);
    assert.equal(data.trace.filter(e => e.k === 'obs').at(-1).phase, i ? 'crashed' : 'finished');
    assert.equal(data.traceTruncated, false);
  }
  assert.equal(records[0].data.profile, 'egornomic-cash-v1');
  assert.equal(records[0].data.opponent.username, 'egornomic');
  assert.equal(records[1].data.results[0].cash, 0);
  assert.equal(records[1].data.performance.crashes, 1);
  assert.ok(records[1].data.trace.some(e => e.k === 'disarm' && e.reason === 'match limit 2 reached'));
  assert.equal(records[1].data.trace.at(-1).held, false);
});

test('game storage remains complete after the session trace cap and does not store unfinished games', async () => {
  const f = await browserFixture(); f.api.agent.traceLimit = 3;
  f.start(); f.deliver(1); f.deliver(2);
  assert.equal(f.api.status().storage.pending, 0);
  f.deliver(92, 'finished'); f.tick(100); f.tick(1100); f.deliver(30, 'crashed');
  await f.waitFor(() => f.api.status().storage.saved === 2);
  const { records } = await f.readSaved();
  assert.equal(f.api.export().trace.length, 3);
  assert.equal(f.api.export().traceTruncated, true);
  assert.ok(f.api.export().traceDropped > 0);
  assert.ok(records[0].data.trace.length > 3);
  assert.equal(records[1].data.trace[0].k, 'match');
  assert.equal(records[1].data.trace.filter(e => e.k === 'obs').at(-1).phase, 'crashed');
});

test('database survives a new page session and saved traces export only on request', async () => {
  const database = new IDBFactory();
  const first = await browserFixture({ database }); first.start(); first.deliver(92, 'finished');
  await first.waitFor(() => first.api.status().storage.saved === 1); first.api.destroy();
  const second = await browserFixture({ database });
  await second.waitFor(() => second.api.status().storage.saved === 1);
  assert.equal(second.api.status().completed, 0);
  assert.equal(second.ui.getElementById('backups').textContent, '1 in database');
  second.start(); second.deliver(30, 'crashed');
  await second.waitFor(() => second.api.status().storage.saved === 2);
  assert.equal(second.downloads.length, 0);
  await second.ui.getElementById('archive').click();
  assert.equal(second.downloads.length, 1);
  const exported = JSON.parse(await second.downloads[0].blob.text());
  assert.equal(exported.type, 'pace-bot-archive');
  assert.equal(exported.traces.length, 2);
  assert.notEqual(exported.traces[0].session.id, exported.traces[1].session.id);
  second.ui.getElementById('exp').click();
  assert.equal(second.downloads.length, 2);
  assert.equal(JSON.parse(await second.downloads[1].blob.text()).scope, 'session');
});

test('unavailable storage keeps data in memory for manual recovery without stopping autoplay', async () => {
  const f = await browserFixture({ database: null }); f.api.setMatchLimit(2);
  f.start(); f.deliver(92, 'finished');
  await f.waitFor(() => f.api.status().storage.error !== null);
  assert.equal(f.api.status().storage.pending, 1);
  assert.match(f.ui.getElementById('save-error').textContent, /unavailable/i);
  f.tick(100); f.tick(1100);
  assert.equal(f.clicks(), 1);
  assert.equal(f.api.status().armed, true);
  await f.api.exportSavedTraces();
  const exported = JSON.parse(await f.downloads[0].blob.text());
  assert.equal(exported.traces.length, 1);
  assert.match(exported.warning, /Only in-memory/);
  assert.equal(exported.traces[0].results[0].phase, 'finished');
});

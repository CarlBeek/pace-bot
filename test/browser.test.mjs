// Exercise the generated extension and its timers without opening the user's browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

async function browserFixture() {
  let now = 0, clicks = 0, match = 0;
  const timers = new Map();
  class Element {
    constructor() { this.attributes = new Map(); this.isConnected = true; this.disabled = false; this.value = ''; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    getClientRects() { return this.hidden ? [] : [1]; }
    attachShadow() { return this.shadowRoot = new Root(); }
    appendChild(child) { this.child = child; }
    click() { this.onclick?.(); }
  }
  class Root {
    constructor() { this.elements = new Map(); }
    set innerHTML(html) {
      for (const [, id] of html.matchAll(/id="([^"]+)"/g)) this.elements.set(id, new Element());
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
  const doc = { body, hidden: false, createElement: () => new Element(), querySelector: () => host, addEventListener() {} };
  const win = { document: doc, performance: { now: () => now }, customElements: { get: () => Host, whenDefined: () => Promise.resolve() },
    setInterval: cb => { const id = timers.size + 1; timers.set(id, cb); return id; }, clearInterval: id => timers.delete(id), addEventListener() {} };
  runInNewContext(readFileSync(new URL('../extension/pace-bot.js', import.meta.url), 'utf8'), {
    window: win, KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  });
  await Promise.resolve(); // customElements.whenDefined() patches Host.showMatch.
  const api = win.__paceBot;
  function deliver(t, phase = 'running') {
    host.showMatch({ room: 'test', match, player: 0, game: { t, phase, safety: 12, hazard: 0,
      labs: [{ position: 0, speed: 0, deployed: 0, held: false, cash: 1e9, profit: 5e9 }, { deployed: 0, cash: 1e9, profit: 5e9 }] } });
  }
  function start() { match++; deliver(.1); }
  const tick = time => { now = time; for (const cb of timers.values()) cb(); };
  return { api, doc, host, start, deliver, tick, clicks: () => clicks, ui: body.child.shadowRoot };
}

test('built extension plays the next game through the UI and stops exactly at the limit', async () => {
  const f = await browserFixture();
  assert.equal(f.api.status().patched, true);
  f.api.setMatchLimit(2); f.api.arm(); f.start();
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
  assert.equal(f.api.export().botVersion, '0.3.1');
  assert.equal(f.ui.getElementById('cnt').textContent, '2 / 2');
});

test('built extension STOP button cancels a pending next game', async () => {
  const f = await browserFixture();
  f.api.setMatchLimit(3); f.ui.getElementById('start').click(); f.start();
  f.deliver(92, 'finished'); f.tick(100);
  f.ui.getElementById('stop').click(); f.tick(1500);
  assert.equal(f.clicks(), 0);
  assert.equal(f.api.status().armed, false);
});

test('built extension pauses through a brief stall, resumes, and still honors a hidden-page stop', async () => {
  const f = await browserFixture(); f.api.arm(); f.start(); f.tick(400);
  assert.equal(f.api.status().paused, true);
  assert.equal(f.api.status().uiHeld, false);
  assert.equal(f.ui.getElementById('st').textContent, 'PAUSED');
  f.deliver(.2); assert.equal(f.api.status().paused, true);
  f.tick(480); f.deliver(.3);
  assert.equal(f.api.status().paused, false);
  assert.equal(f.api.status().issued, true);
  f.doc.hidden = true; f.tick(500);
  assert.equal(f.api.status().armed, false);
  f.doc.hidden = false; f.deliver(.4); f.deliver(.5);
  assert.equal(f.api.status().armed, false);
});

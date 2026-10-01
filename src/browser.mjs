// Browser adapter: observes snapshots at the pace-game render boundary (showMatch) and operates the
// game's own keyboard handler (Space on the widget host), which applies the app's blocked/phase checks
// before emitting pace:input. Runs in the page's main world.
import { Agent, summarize } from './agent.mjs';
import { ReplayQueue } from './replay.mjs';

export function install(win = window) {
  if (win.__paceBot) return win.__paceBot;
  const doc = win.document;
  const perf = win.performance;
  const agent = new Agent({ objective: 'leaderboard', matchLimit: 999, alwaysArmed: true });
  agent.log({ k: 'arm', now: perf.now(), objective: agent.objective, automatic: true });
  // Live play has one objective. Legacy objectives are for offline comparisons only.
  Object.defineProperty(agent, 'objective', { value: 'leaderboard', writable: false, configurable: false });
  const replay = new ReplayQueue();
  let host = null, patched = false, lastKeySent = null, suspended = false, destroyed = false;

  function uiHeld() {
    const b = host?.shadowRoot?.querySelector('#accelerator');
    return b ? b.getAttribute('aria-pressed') === 'true' : null;
  }

  function send(cmd) {
    if (!cmd) return;
    const target = host && host.isConnected ? host : doc.querySelector('pace-game');
    if (!target) return;
    const type = cmd.held ? 'keydown' : 'keyup';
    target.dispatchEvent(new KeyboardEvent(type, { code: 'Space', key: ' ', bubbles: true, cancelable: true, composed: true }));
    lastKeySent = { type, at: perf.now() };
    render();
  }

  function patch() {
    const C = win.customElements.get('pace-game');
    if (!C || patched || destroyed) return;
    const orig = C.prototype.showMatch;
    if (typeof orig !== 'function') return;
    patched = true;
    C.prototype.showMatch = function (snapshot) {
      const result = orig.apply(this, arguments);
      if (destroyed || suspended) return result;
      try {
        host = this;
        send(agent.onSnapshot(snapshot, perf.now()));
        render();
      } catch (e) {
        agent.log({ k: 'error', now: perf.now(), msg: String(e) });
        send(agent.pause(perf.now(), 'paused: adapter error'));
      }
      return result;
    };
  }
  win.customElements.whenDefined('pace-game').then(patch);

  const timer = win.setInterval(() => {
    if (destroyed || suspended) return;
    try {
      const now = perf.now();
      send(agent.tick(now, { hidden: doc.hidden, uiHeld: uiHeld() }));
      replay.tick(now, { agent, hidden: doc.hidden, button: host?.shadowRoot?.querySelector('#again') });
    } catch (e) {
      agent.log({ k: 'error', now: perf.now(), msg: String(e) });
      send(agent.pause(perf.now(), 'paused: adapter error'));
    }
  }, 16);
  // Switching tabs is supported. Actual navigation/BFCache suspension releases input;
  // a restored page resumes after fresh snapshots, without a manual arming step.
  win.addEventListener('pagehide', () => {
    if (destroyed) return;
    suspended = true;
    send(agent.pause(perf.now(), 'paused: page suspended'));
  });
  win.addEventListener('pageshow', () => { if (!destroyed) suspended = false; });

  // ---- operator panel ----
  let panel, ui = {};
  function buildPanel() {
    if (panel || !doc.body || destroyed) return;
    panel = doc.createElement('div');
    panel.id = 'pace-bot-panel';
    const root = panel.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px/1.35 ui-monospace,Menlo,monospace}
      .p{background:#111;color:#eee;border:1px solid #444;border-radius:8px;padding:10px;width:270px;box-shadow:0 4px 18px #0006}
      h1{font-size:12px;margin:0 0 6px;display:flex;justify-content:space-between}
      .row{display:flex;justify-content:space-between;gap:8px}.k{color:#999}
      .armed{color:#4ade80}.off{color:#f87171}
      .ctl{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center}
      button,input{font:inherit;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 6px}
      input{width:40px}.why{margin-top:6px;color:#fbbf24;min-height:1.3em;word-break:break-word}
    </style><div class="p"><h1><span>PACE bot · v0.6.0</span><span id="st" class="armed">ARMED</span></h1>
      <div class="row"><span class="k">goal</span><span>Avg cash / game</span></div>
      <div class="row"><span class="k">opponent</span><span id="opponent">unknown</span></div>
      <div class="row"><span class="k">profile</span><span id="profile">general</span></div>
      <div class="row"><span class="k">input</span><span id="inp">–</span></div>
      <div class="row"><span class="k">state age</span><span id="age">–</span></div>
      <div class="row"><span class="k">input ack (median)</span><span id="dly">–</span></div>
      <div class="row"><span class="k">own / opp cash</span><span id="cash">–</span></div>
      <div class="row"><span class="k">cumulative risk</span><span id="risk">–</span></div>
      <div class="row"><span class="k">matches</span><span id="cnt">0</span></div>
      <div class="row"><span class="k">run cash / game</span><span id="avg">–</span></div>
      <div class="why" id="why"></div>
      <div class="ctl"><label class="k">limit <input id="lim" type="number" min="1" max="999" value="999"></label>
        <button id="exp">Export trace</button></div></div>`;
    for (const id of ['st', 'opponent', 'profile', 'inp', 'age', 'dly', 'cash', 'risk', 'cnt', 'avg', 'why', 'lim', 'exp']) ui[id] = root.getElementById(id);
    ui.lim.onchange = () => { send(agent.setMatchLimit(ui.lim.value, perf.now())); ui.lim.value = agent.matchLimit; render(true); };
    ui.exp.onclick = exportTrace;
    doc.body.appendChild(panel);
    render(true);
  }
  const fmt = c => Number.isFinite(c) ? `$${(c / 1e9).toFixed(2)}B` : '–';
  let lastRender = 0;
  function render(force) {
    if (!panel) return;
    const now = perf.now();
    if (!force && now - lastRender < 100) return;
    lastRender = now;
    const o = agent.last;
    ui.st.textContent = agent.armed ? agent.paused ? 'PAUSED' : 'ARMED' :
      agent.completed >= agent.matchLimit ? 'LIMIT REACHED' : 'DISABLED';
    ui.st.className = agent.armed ? 'armed' : 'off';
    ui.opponent.textContent = agent.opponentIdentity ? `@${agent.opponentIdentity.username}` : 'unknown';
    ui.profile.textContent = agent.opponentProfile?.label ?? 'general';
    ui.inp.textContent = `issued ${agent.lastIssued ? 'HOLD' : 'release'} · ui ${uiHeld() == null ? '?' : uiHeld() ? 'HOLD' : 'release'}`;
    ui.age.textContent = agent.lastRecv == null ? '–' : `${Math.round(now - agent.lastRecv)} ms (t=${o.t.toFixed(2)}s ${o.phase})`;
    const a = summarize(agent.stats.ackMs.slice(-200));
    ui.dly.textContent = a.median == null ? '–' : `${a.median.toFixed(1)} ms (p95 ${a.p95.toFixed(1)})`;
    ui.cash.textContent = o ? `${fmt(o.own.cash)} / ${fmt(o.opponent.cash)}` : '–';
    ui.risk.textContent = o && Number.isFinite(o.hazard) ? `${(100 * (1 - Math.exp(-o.hazard))).toFixed(3)}%` : '–';
    ui.cnt.textContent = `${agent.completed} / ${agent.matchLimit}`;
    const results = agent.performance();
    ui.avg.textContent = results.games ? `${fmt(results.averageCash)} · ${results.crashes} crashes` : '–';
    const d = agent.decision;
    ui.why.textContent = agent.armed && replay.status ? replay.status :
      agent.armed && !agent.paused && o?.phase === 'running' && d?.target != null ? `${agent.reason} · stop ${d.stop.toFixed(2)} vs target ${d.target.toFixed(2)}` : agent.reason;
  }
  function exportTrace() {
    const blob = new Blob([JSON.stringify(api.export(), null, 1)], { type: 'application/json' });
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pace-bot-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  if (doc.body) buildPanel(); else doc.addEventListener('DOMContentLoaded', buildPanel);
  const renderTimer = win.setInterval(() => render(), 250);

  const api = {
    agent,
    setMatchLimit: n => { if (!destroyed) { send(agent.setMatchLimit(n, perf.now())); ui.lim && (ui.lim.value = agent.matchLimit); render(true); } },
    status: () => ({ armed: agent.armed, paused: agent.paused, objective: agent.objective, completed: agent.completed, reason: agent.reason, replay: replay.status,
      profile: agent.profileId, opponent: agent.opponentIdentity,
      last: agent.last, issued: !!agent.lastIssued, uiHeld: uiHeld(), patched, lastKeySent, performance: agent.performance() }),
    export: () => ({ version: 3, botVersion: '0.6.0', exportedAt: new Date().toISOString(), objective: agent.objective,
      profile: agent.profileId, opponent: agent.opponentIdentity,
      latency: agent.latency(), performance: agent.performance(), results: agent.results.map(r => ({ ...r })), trace: agent.trace }),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      send(agent.disarm(perf.now(), 'adapter destroyed'));
      win.clearInterval(timer); win.clearInterval(renderTimer); panel?.remove(); panel = null;
    },
  };
  win.__paceBot = api;
  return api;
}

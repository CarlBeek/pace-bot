// Browser adapter: observes snapshots at the pace-game render boundary (showMatch) and operates the
// game's own keyboard handler (Space on the widget host), which applies the app's blocked/phase checks
// before emitting pace:input. Runs in the page's main world.
import { Agent, OBJECTIVES, summarize } from './agent.mjs';

export function install(win = window) {
  if (win.__paceBot) return win.__paceBot;
  const doc = win.document;
  const perf = win.performance;
  const agent = new Agent({ objective: 'leaderboard', matchLimit: 1 });
  const labels = { leaderboard: 'Leaderboard', competitive: 'Win-focused', cash: 'Cash (legacy CPU)', win: 'Win (legacy CPU)', 'repro-cash': 'Repro cash', 'repro-win': 'Repro win' };
  let host = null, patched = false, lastKeySent = null;

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
    if (!C || patched) return;
    const orig = C.prototype.showMatch;
    if (typeof orig !== 'function') return;
    patched = true;
    C.prototype.showMatch = function (snapshot) {
      const result = orig.apply(this, arguments);
      try {
        host = this;
        send(agent.onSnapshot(snapshot, perf.now()));
        render();
      } catch (e) { agent.log({ k: 'error', now: perf.now(), msg: String(e) }); }
      return result;
    };
  }
  win.customElements.whenDefined('pace-game').then(patch);

  const timer = win.setInterval(() => {
    try { send(agent.tick(perf.now(), { hidden: doc.hidden, uiHeld: uiHeld() })); } catch (e) { /* keep ticking */ }
  }, 16);
  const onHide = () => send(agent.disarm(perf.now(), 'page hidden'));
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) onHide(); });
  win.addEventListener('pagehide', onHide);
  win.addEventListener('keydown', e => {
    if (e.key === 'Escape' && e.isTrusted && agent.armed) send(agent.disarm(perf.now(), 'emergency stop (Esc)'));
  }, true);

  // ---- operator panel ----
  let panel, ui = {};
  function buildPanel() {
    if (panel || !doc.body) return;
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
      button,select,input{font:inherit;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 6px}
      button.go{background:#14532d}button.stop{background:#7f1d1d;font-weight:bold}
      input{width:40px}.why{margin-top:6px;color:#fbbf24;min-height:1.3em;word-break:break-word}
    </style><div class="p"><h1><span>PACE bot · v0.3</span><span id="st" class="off">DISARMED</span></h1>
      <div class="row"><span class="k">mode</span><span id="mode">no game</span></div>
      <div class="row"><span class="k">input</span><span id="inp">–</span></div>
      <div class="row"><span class="k">state age</span><span id="age">–</span></div>
      <div class="row"><span class="k">input ack (median)</span><span id="dly">–</span></div>
      <div class="row"><span class="k">own / opp cash</span><span id="cash">–</span></div>
      <div class="row"><span class="k">cumulative risk</span><span id="risk">–</span></div>
      <div class="row"><span class="k">matches</span><span id="cnt">0</span></div>
      <div class="row"><span class="k">run cash / game</span><span id="avg">–</span></div>
      <div class="why" id="why"></div>
      <div class="ctl"><button class="go" id="start">Start</button><button class="stop" id="stop">STOP</button>
        <select id="obj">${OBJECTIVES.map(o => `<option value="${o}">${labels[o]}</option>`).join('')}</select>
        <label class="k">limit <input id="lim" type="number" min="1" max="50" value="1"></label>
        <button id="exp">Export trace</button></div></div>`;
    for (const id of ['st', 'mode', 'inp', 'age', 'dly', 'cash', 'risk', 'cnt', 'avg', 'why', 'start', 'stop', 'obj', 'lim', 'exp']) ui[id] = root.getElementById(id);
    ui.start.onclick = () => { agent.arm(perf.now()); render(); };
    ui.stop.onclick = () => send(agent.disarm(perf.now(), 'user stop')) || render();
    ui.obj.onchange = () => { agent.objective = ui.obj.value; render(); };
    ui.lim.onchange = () => { agent.matchLimit = Math.max(1, Math.min(50, Number(ui.lim.value) || 1)); render(); };
    ui.exp.onclick = exportTrace;
    doc.body.appendChild(panel);
    render();
  }
  const fmt = c => Number.isFinite(c) ? `$${(c / 1e9).toFixed(2)}B` : '–';
  let lastRender = 0;
  function render(force) {
    if (!panel) return;
    const now = perf.now();
    if (!force && now - lastRender < 100) return;
    lastRender = now;
    const o = agent.last;
    ui.st.textContent = agent.armed ? 'ARMED' : 'DISARMED';
    ui.st.className = agent.armed ? 'armed' : 'off';
    ui.mode.textContent = !o ? 'no game' : labels[agent.objective];
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
    ui.why.textContent = agent.armed && d?.target != null ? `${agent.reason} · stop ${d.stop.toFixed(2)} vs target ${d.target.toFixed(2)}` : agent.reason;
    if (ui.obj.value !== agent.objective) ui.obj.value = agent.objective;
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
  win.setInterval(() => render(), 250);

  const api = {
    agent,
    arm: () => { const ok = agent.arm(perf.now()); render(true); return ok; },
    stop: reason => { send(agent.disarm(perf.now(), reason || 'api stop')); render(true); },
    setObjective: o => { if (!OBJECTIVES.includes(o)) throw new Error('unknown objective'); agent.objective = o; render(true); },
    setMatchLimit: n => { agent.matchLimit = n; render(true); },
    status: () => ({ armed: agent.armed, objective: agent.objective, completed: agent.completed, reason: agent.reason,
      last: agent.last, issued: !!agent.lastIssued, uiHeld: uiHeld(), patched, lastKeySent, performance: agent.performance() }),
    export: () => ({ version: 2, botVersion: '0.3.0', exportedAt: new Date().toISOString(), objective: agent.objective,
      latency: agent.latency(), performance: agent.performance(), results: agent.results.map(r => ({ ...r })), trace: agent.trace }),
    destroy: () => { send(agent.disarm(perf.now(), 'adapter destroyed')); win.clearInterval(timer); panel?.remove(); },
  };
  win.__paceBot = api;
  return api;
}

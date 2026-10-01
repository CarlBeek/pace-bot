// Controlled live integration test: launches a separate Chrome with a throwaway profile (never the
// user's profile), injects extension/pace-bot.js exactly as the MAIN-world content script would run,
// opens the real PACE page, starts a practice game vs the computer, and records the auto-armed bot's trace.
// Usage: node tools/live-practice.mjs [--games N] [--headful] [--out dir]
//        [--test-controls]   (automatic press and teardown release checks before playing)
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const games = Number(opt('--games', 1)), objective = 'leaderboard';
if (!Number.isInteger(games) || games < 1 || games > 999) throw new Error('--games must be an integer from 1 to 999');
if (args.includes('--objective')) throw new Error('Live play always optimizes average cash. Use offline evaluators to compare other objectives.');
const outDir = opt('--out', join(root, 'runs'));
const headful = args.includes('--headful'), testControls = args.includes('--test-controls');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_ = 'https://www.paradigm.xyz/research/pace/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'pace-bot-chrome-'));
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', ...(headful ? [] : ['--headless=new']), '--window-size=1280,900', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  chrome.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  chrome.on('exit', c => rej(new Error('chrome exited ' + c)));
  setTimeout(() => rej(new Error('chrome did not start')), 20000);
});

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const waiting = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});

const { targetInfos } = await send('Target.getTargets');
const page = targetInfos.find(t => t.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const evaluate = async (expression) => {
  const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
await S('Page.enable'); await S('Runtime.enable');
await S('Page.addScriptToEvaluateOnNewDocument', { source: await readFile(join(root, 'extension', 'pace-bot.js'), 'utf8') });
await S('Page.navigate', { url: URL_ });

async function waitFor(expr, ms = 20000, every = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const v = await evaluate(expr); if (v) return v; } catch { } await sleep(every); }
  throw new Error('timeout waiting for ' + expr);
}
const clickPlayComputer = `(() => { const again=document.querySelector('pace-game')?.shadowRoot?.querySelector('#again'); const b=[...document.querySelectorAll('button')].find(b=>/Play Computer/.test(b.textContent)&&!b.disabled&&b.offsetParent) || (again&&!again.disabled&&again.offsetParent?again:null); if(!b) return false; b.click(); return true; })()`;
const gameState = `(() => { const s=window.__paceBot?.status(); return s && s.last ? {t:s.last.t, phase:s.last.phase, objective:s.objective, armed:s.armed, completed:s.completed, reason:s.reason, uiHeld:s.uiHeld, issued:s.issued} : null })()`;

const report = { startedAt: new Date().toISOString(), chrome: 'separate throwaway profile', url: URL_, objective, controls: null, games: [] };
try {
  await waitFor('!!window.__paceBot');
  await waitFor(`!!document.querySelector('pace-game')?.shadowRoot && [...document.querySelectorAll('button')].some(b=>/Play Computer/.test(b.textContent)&&!b.disabled)`);
  console.log('page loaded; bot installed:', await evaluate('JSON.stringify(window.__paceBot.status().patched)'));

  if (testControls) {
    // Confirm automatic control without an arm command, then teardown release.
    await evaluate(clickPlayComputer);
    await waitFor(`(() => { const s=window.__paceBot.status(); return s.armed && s.last?.phase==='running' && s.last.own.held && s.last.own.speed>0 })()`);
    const snap = () => evaluate(`(() => { const s=window.__paceBot.status(); return {t:s.last.t, held:s.last.own.held, speed:s.last.own.speed, ui:s.uiHeld} })()`);
    const c = {};
    c.automaticallyHolding = await snap();
    await evaluate(`window.__paceBot.destroy()`); await sleep(300);
    // Teardown stops observing snapshots, so verify the widget input rather than stale agent state.
    c.afterDestroy = await evaluate(`(() => { const s=window.__paceBot.status(); return {armed:s.armed, issued:s.issued, ui:s.uiHeld} })()`);
    c.pass = c.automaticallyHolding.held === true && c.automaticallyHolding.speed > 0 &&
      c.afterDestroy.armed === false && c.afterDestroy.issued === false && c.afterDestroy.ui === false;
    report.controls = c;
    console.log('controls test:', JSON.stringify(c));
    if (!c.pass) throw new Error('automatic control or teardown release check failed');
    // Leave that match: reload to get a clean lobby, bot re-installs armed.
    await S('Page.reload'); await sleep(1500);
    await waitFor(`!!window.__paceBot && [...document.querySelectorAll('button')].some(b=>/Play Computer/.test(b.textContent)&&!b.disabled)`);
  }

  await evaluate(`window.__paceBot.setMatchLimit(${games}); true`);
  for (let gi = 0; gi < games; gi++) {
    // Only launch the first game manually; subsequent games exercise adapter autoplay.
    if (gi === 0) await waitFor(clickPlayComputer, 10000, 200).catch(() => { throw new Error('could not start practice game'); });
    await waitFor(`(() => { const s=window.__paceBot.status(); return s.last && s.last.phase==='running' && s.completed === ${gi} && s.last.t < 1 })()`);
    if (gi === 0 && !(await evaluate(`window.__paceBot.status().armed`))) throw new Error('bot did not arm automatically');
    let last = null;
    while (true) {
      const st = await evaluate(gameState);
      if (st && st.t !== last?.t && Math.floor(st.t / 10) !== Math.floor((last?.t ?? -10) / 10)) console.log(`  game ${gi + 1} t=${st.t.toFixed(1)} ${st.phase} armed=${st.armed} ${st.reason}`);
      last = st;
      if (st && ['finished', 'crashed', 'quit'].includes(st.phase)) break;
      if (st && !st.armed && st.completed <= gi) throw new Error('bot disarmed mid-game: ' + st.reason);
      await sleep(250);
    }
    const end = await evaluate(`(() => { const e=window.__paceBot.agent.trace.filter(x=>x.k==='end').at(-1); const s=window.__paceBot.status(); return {phase:s.last.phase, t:s.last.t, cash:s.last.own.cash, oppCash:s.last.opponent.cash, hazard:s.last.hazard, end:e} })()`);
    report.games.push(end);
    console.log(`game ${gi + 1}: ${end.phase} own $${(end.cash / 1e9).toFixed(3)}B opp $${(end.oppCash / 1e9).toFixed(3)}B risk ${(100 * (1 - Math.exp(-end.hazard))).toFixed(3)}%`);
    await sleep(800);
  }
  const exp = await evaluate(`window.__paceBot.export()`);
  report.latency = exp.latency;
  report.finalStatus = await evaluate(`window.__paceBot.status().reason`);
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(join(outDir, `practice-${stamp}.trace.json`), JSON.stringify(exp));
  await writeFile(join(outDir, `practice-${stamp}.report.json`), JSON.stringify(report, null, 2));
  console.log('latency:', JSON.stringify(exp.latency, null, 1));
  console.log('final status:', report.finalStatus);
  console.log('wrote', join(outDir, `practice-${stamp}.report.json`));
} finally {
  try { await send('Browser.close'); } catch { chrome.kill(); }
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => { });
}

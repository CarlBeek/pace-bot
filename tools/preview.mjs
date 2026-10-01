// Offline browser smoke test for the built extension against the actual public engine.
// Run `node tools/preview.mjs`, then open the printed loopback URL. No online matches.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>PACE bot offline verification</title>
<style>body{font:16px system-ui;background:#f3f2ee;color:#202020;margin:48px;max-width:760px}button{font:inherit;padding:8px 16px;margin-right:8px}pre{font:14px monospace;line-height:1.6}h1{font-size:28px}</style>
<h1>PACE bot · offline verification</h1><p>Public game engine. Simulated opponent. No online match or leaderboard submission.</p>
<p>Set a match limit, arm the bot, then start the first simulation. Later games start automatically until the limit. Each game runs at 8× speed.</p>
<button id="new">New simulation</button><pace-game></pace-game>
<script src="/engine.js"></script><script>
const E = window.paceTestEngine;
let game = null, match = 0, steps = 0, issued = false;
class PaceGame extends HTMLElement {
  constructor() {
    super(); const root = this.attachShadow({mode:'open'});
    root.innerHTML = '<p><button id="accelerator" aria-pressed="false">Accelerator: released</button><button id="again" hidden>Play again</button></p><pre id="status">No simulation running</pre>';
    root.getElementById('again').onclick = () => document.getElementById('new').click();
    this.addEventListener('keydown', e => { if(e.code==='Space') this.input(true); });
    this.addEventListener('keyup', e => { if(e.code==='Space') this.input(false); });
  }
  input(held) {
    issued = held; if(game) E.setHeld(game,0,held);
    const b=this.shadowRoot.getElementById('accelerator'); b.setAttribute('aria-pressed',String(held)); b.textContent='Accelerator: '+(held?'held':'released');
  }
  showMatch(snap) {
    const g=snap.game;
    this.shadowRoot.getElementById('again').hidden=E.active(g);
    this.shadowRoot.getElementById('status').textContent='Match '+match+' · '+g.phase+' · t='+g.t.toFixed(2)+'s\\nOwn cash: $'+(g.labs[0].cash/1e9).toFixed(2)+'B\\nOpponent cash: $'+(g.labs[1].cash/1e9).toFixed(2)+'B\\nObserved accelerator: '+g.labs[0].held+'\\nCompleted: '+(['finished','crashed'].includes(g.phase)?'yes':'no');
  }
}
customElements.define('pace-game', PaceGame);
const host=document.querySelector('pace-game');
const snapshot=()=>host.showMatch({room:'offline-preview',match,player:0,bot:false,ranked:true,game:E.view(game,0)});
document.getElementById('new').onclick=()=>{ match++; game=E.newGame((2654435761+match*1664525)>>>0);steps=0;host.input(false);snapshot(); };
setInterval(()=>{
  if(!game||!E.active(game))return;
  for(let i=0;i<8&&E.active(game);i++){
    E.setHeld(game,0,issued);E.botStep(game);E.step(game);steps++;
    if(steps%5===0||!E.active(game))snapshot();
  }
},1000/60);
</script><script src="/pace-bot.js"></script></html>`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  let body, type;
  if (pathname === '/') { body = html; type = 'text/html'; }
  else if (pathname === '/engine.js') {
    body = '(() => {\n' + readFileSync(new URL('engine/engine-original.cjs', root), 'utf8').replace('module.exports=', 'window.paceTestEngine=') + '\n})();'; type = 'text/javascript';
  } else if (pathname === '/pace-bot.js') {
    body = readFileSync(new URL('extension/pace-bot.js', root), 'utf8'); type = 'text/javascript';
  } else { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body);
});
server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => console.log('Preview: http://127.0.0.1:' + server.address().port));

// Fetches the public PACE bundle, verifies its hash, and writes a verbatim slice of the
// practice engine (from `var E=Object.freeze` through the end of function Be) as CommonJS.
// Offline evaluation only; the live game is never modified.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = 'index-D8uBXVz5.js';
const URL_ = `https://www.paradigm.xyz/research/pace/assets/${BUNDLE}`;
const SHA256 = '738c689c4509e9444515789409bcdbaaa2cb71b968e1f684b486c1dec7191a46';
const START = 'var E=Object.freeze';
const END = 'async function Ve(';

const cache = join(here, '..', 'vendor', BUNDLE);
let src;
if (existsSync(cache)) src = await readFile(cache, 'utf8');
else {
  src = await (await fetch(URL_)).text();
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, src);
}
const hash = createHash('sha256').update(src).digest('hex');
if (hash !== SHA256) throw new Error(`bundle hash changed: ${hash}; inspect the delta before use`);
const a = src.indexOf(START), b = src.indexOf(END);
if (a < 0 || b < a || src.indexOf(START, a + 1) >= 0) throw new Error('engine boundaries not found or ambiguous');
const slice = src.slice(a, b);
const out = `// VERBATIM slice of ${URL_} (sha256 ${SHA256}), bytes ${a}..${b}.\n` +
  slice + '\n' +
  'module.exports={econ:E,config:pe,newGame:Te,setHeld:Ee,step:Me,botAction:Re,botStep:ze,view:Le,active:Ne,advance:Fe,speedCap:k,stopDistance:Ce,hazardRate:ke,risk:Ae,profit:ie,localSession:Be};\n';
await writeFile(join(here, 'engine-original.cjs'), out);
console.log(`wrote engine-original.cjs (${slice.length} bytes, sha256 ok)`);

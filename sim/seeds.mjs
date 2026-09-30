// Full-width uint32 LCG seeds used by the handoff validation (indices 1000..1999 held out).
export function lcgSeeds(count, { start = 0, state = 538324 } = {}) {
  const out = [];
  let x = state >>> 0;
  for (let i = 0; i < start + count; i++) {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    if (i >= start) out.push(x);
  }
  return out;
}

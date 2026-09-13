// Throwaway: what opacity keeps `.fact-inactive` text at or above AA?
import { readFileSync } from 'node:fs';
import { contrast, readTokens, SURFACES, AA_NORMAL_TEXT } from './apps/web/.verify/cssContrast.ts';

const css = readFileSync('apps/web/src/styles.css', 'utf8');
const tokens = readTokens(css);
const dim = tokens.get('--text-dim');
console.log('--text-dim =', dim);
for (const surface of SURFACES) {
  const bg = tokens.get(surface);
  if (bg === undefined || dim === undefined) continue;
  const full = contrast(dim, bg);
  console.log(`${surface} ${bg}: --text-dim as-is = ${full.toFixed(2)}:1`);

  // Compositing `opacity` over the surface is a linear blend of the two colours.
  const mix = (a, b, t) => {
    const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [ar, ag, ab] = parse(a);
    const [br, bg2, bb] = parse(b);
    const to = (x) => Math.round(x).toString(16).padStart(2, '0');
    return `#${to(ar * t + br * (1 - t))}${to(ag * t + bg2 * (1 - t))}${to(ab * t + bb * (1 - t))}`;
  };
  for (const opacity of [0.62, 0.7, 0.75, 0.8, 0.85, 0.9, 1]) {
    const blended = mix(dim, bg, opacity);
    const c = contrast(blended, bg);
    const verdict = c >= AA_NORMAL_TEXT ? 'PASS' : 'fail';
    console.log(`  opacity ${opacity}: ${blended} = ${c.toFixed(2)}:1 ${verdict}`);
  }
}

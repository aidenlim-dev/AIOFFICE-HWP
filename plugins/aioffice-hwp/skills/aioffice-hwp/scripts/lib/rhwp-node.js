// loadRhwp: load the vendored rhwp WASM in Node and install the
// globalThis.measureTextWidth layout stub it imports. Browsers measure with a
// <canvas>; Node has none, so this stub approximates: CJK = 1em,
// everything else = 0.55em, size parsed from the CSS font string ("12px ...").
// Scripts that compare two layouts (render, page-guard, layout-check) should
// all load through here so before/after errors cancel out.
import fs from 'node:fs';

let mod = null;

export function measureTextWidth(font, text) {
  const m = String(font || '').match(/([0-9.]+)px/);
  const size = m ? parseFloat(m[1]) : 12;
  let w = 0;
  for (const ch of String(text || '')) {
    const cp = ch.codePointAt(0) ?? 0;
    // U+1100..U+FFDC roughly covers Hangul Jamo, CJK and full-width forms.
    w += cp >= 0x1100 && cp <= 0xffdc ? size : size * 0.55;
  }
  return w;
}

export async function loadRhwp() {
  if (mod) return mod;
  if (typeof globalThis.measureTextWidth !== 'function') globalThis.measureTextWidth = measureTextWidth;
  const rhwp = await import('../vendor/rhwp/rhwp.js');
  await rhwp.default({ module_or_path: fs.readFileSync(new URL('../vendor/rhwp/rhwp_bg.wasm', import.meta.url)) });
  return (mod = rhwp);
}

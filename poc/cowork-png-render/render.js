#!/usr/bin/env node
// POC: rhwp WASM + @napi-rs/canvas — headless page → PNG renderer.
// Goal: prove that option A (PNG pre-render server-side) is feasible
// in a Node-only environment such as the claude.ai cowork bash sandbox.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import pkg from '@napi-rs/canvas';
const { createCanvas, Canvas, Image: NapiImage } = pkg;
// @napi-rs/canvas does NOT export CanvasRenderingContext2D as a public class.
// Pull it off a real instance so rhwp's `instanceof CanvasRenderingContext2D`
// shim succeeds.
const NapiCtx = createCanvas(1, 1).getContext('2d').constructor;

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RHWP_DIR = path.join(
  REPO_ROOT,
  'plugins',
  'claw-hwp',
  'skills',
  'hwp',
  'scripts',
  'vendor',
  'rhwp',
);
const SAMPLE_PATH =
  process.argv[2] ?? path.join(REPO_ROOT, 'spike', 'samples', 'sample-gov.hwpx');
const OUT_DIR = path.join(__dirname, 'out');
const SCALE = 2.0;

const log = (...a) => console.log('[poc]', ...a);

// --- Step 1: shim browser globals rhwp expects --------------------------------

// rhwp internals run `instanceof HTMLCanvasElement` and `instanceof
// CanvasRenderingContext2D`. @napi-rs/canvas's classes are NOT subclasses of
// those DOM types — so we map the DOM names to @napi-rs's classes and hope
// rhwp's V8 instanceof check finds them in globalThis at WASM init time.
globalThis.HTMLCanvasElement = Canvas;
globalThis.CanvasRenderingContext2D = NapiCtx;
globalThis.Image = NapiImage;

// rhwp looks up `globalThis.measureTextWidth(font, text)` — args are
// (fontSpec, text), matching preview-viewer.js. Returns px width.
const scratchCanvas = createCanvas(1, 1);
const scratchCtx = scratchCanvas.getContext('2d');
let lastFont = '';
globalThis.measureTextWidth = (font, text) => {
  if (font !== lastFont) {
    scratchCtx.font = font;
    lastFont = font;
  }
  return scratchCtx.measureText(text).width;
};

// Optional polyfills rhwp may probe.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

// --- Step 2: load rhwp WASM ---------------------------------------------------

log('loading rhwp WASM from', RHWP_DIR);
const wasmBytes = fs.readFileSync(path.join(RHWP_DIR, 'rhwp_bg.wasm'));
const rhwp = await import(path.join(RHWP_DIR, 'rhwp.js'));
await rhwp.default({ module_or_path: wasmBytes });
log('rhwp loaded — exports:', Object.keys(rhwp).filter(k => /^[A-Z]/.test(k)).join(', '));

// --- Step 3: load sample document --------------------------------------------

log('reading sample', SAMPLE_PATH);
const docBytes = fs.readFileSync(SAMPLE_PATH);
const doc = new rhwp.HwpDocument(new Uint8Array(docBytes));

// Page count probe — rhwp exposes it differently depending on version. Try
// the common names; fall back to 1.
let pageCount = 1;
for (const candidate of ['pageCount', 'getPageCount', 'numPages']) {
  if (typeof doc[candidate] === 'function') {
    pageCount = doc[candidate]();
    break;
  } else if (typeof doc[candidate] === 'number') {
    pageCount = doc[candidate];
    break;
  }
}
log('pageCount =', pageCount);

// --- Step 4: render each page to PNG -----------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });
const t0 = Date.now();
let totalBytes = 0;

for (let p = 0; p < pageCount; p++) {
  // rhwp's renderPageToCanvas sets canvas.width/height itself from page size.
  // Start with a placeholder; rhwp will resize it.
  const canvas = createCanvas(100, 100);

  // The borrow-release dance from the browser viewer:
  //   renderPageToCanvas → getPageTextLayout to drop internal borrow
  try {
    doc.renderPageToCanvas(p, canvas, SCALE);
  } catch (e) {
    console.error('[poc] renderPageToCanvas threw on page', p);
    console.error('  typeof:', typeof e);
    console.error('  constructor:', e && e.constructor && e.constructor.name);
    console.error('  message:', e && e.message);
    console.error('  stack:', e && e.stack);
    console.error('  toString:', String(e));
    if (e && typeof e === 'object') {
      console.error('  keys:', Object.keys(e));
      try {
        console.error('  json:', JSON.stringify(e, null, 2).slice(0, 500));
      } catch {}
    }
    process.exit(2);
  }
  try {
    doc.getPageTextLayout(p);
  } catch {
    /* discard — only called for its side effect of releasing the borrow */
  }

  const png = canvas.toBuffer('image/png');
  const outPath = path.join(OUT_DIR, `page-${String(p + 1).padStart(3, '0')}.png`);
  fs.writeFileSync(outPath, png);
  totalBytes += png.length;
  log(
    `page ${p + 1}/${pageCount} → ${path.relative(REPO_ROOT, outPath)} ` +
      `(${canvas.width}×${canvas.height}, ${(png.length / 1024).toFixed(1)} KB)`,
  );
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
log(`done — ${pageCount} pages, ${(totalBytes / 1024).toFixed(1)} KB total, ${elapsed}s`);

if (typeof doc.free === 'function') doc.free();

#!/usr/bin/env node
// render.js - Render .hwp/.hwpx pages to SVG (rhwp) and PNG, so an agent can
// look at its own edit. rhwp layout is an approximation: this is a visual
// self-check, NOT a Hancom compatibility check.
//
// Usage: node render.js <file> [--pages 1,3-5] [--out dir] [--scale 2] [--svg-only]
// Pages are 1-based. --out defaults to a fresh temp dir.
// stdout: {status, file, pageCount, rasterizer, outDir, pages:[{page, svg, png}], note?}
//
// PNG converters, first that works wins: Chrome/Edge/Chromium headless
// --screenshot, rsvg-convert, ImageMagick. None found = SVG only.
// (qlmanage is skipped: it crops to a square thumbnail.)
// Idea from pgc3344/hwp-cowork runner.py and kukiwa/skill-hwpx-master (both MIT).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadRhwp } from './lib/rhwp-node.js';
import { safeUnzip } from './lib/safe-unzip.js';

// Throw instead of process.exit: exiting right after rhwp WASM loads can hang Node.
function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const o = { scale: 2, svgOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pages') o.pages = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--scale') o.scale = Number(argv[++i]);
    else if (a === '--svg-only') o.svgOnly = true;
    else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else if (!o.file) o.file = a;
    else fail(`unexpected argument ${a}`);
  }
  if (!o.file) fail('usage: node render.js <file> [--pages 1,3-5] [--out dir] [--scale 2] [--svg-only]');
  if (!(o.scale > 0 && o.scale <= 8)) fail('--scale must be in (0, 8]');
  return o;
}

// "1,3-5" -> [0,2,3,4] (0-based, sorted, unique). No spec = every page.
function parsePages(spec, count) {
  if (!spec) return [...Array(count).keys()];
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) fail(`bad --pages part "${part}"`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b < a || b > count) fail(`--pages ${part} out of range (document has ${count} page(s))`);
    for (let p = a; p <= b; p++) set.add(p - 1);
  }
  return [...set].sort((x, y) => x - y);
}

function onPath(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const fixed = {
    darwin: ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Chromium.app/Contents/MacOS/Chromium'].map((p) => path.join('/Applications', p)),
    win32: [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)
      .flatMap((d) => [path.join(d, 'Google/Chrome/Application/chrome.exe'), path.join(d, 'Microsoft/Edge/Application/msedge.exe')]),
  }[process.platform] || [];
  const hit = fixed.find((p) => fs.existsSync(p));
  if (hit) return hit;
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome', 'msedge']) {
    const p = onPath(n);
    if (p) return p;
  }
  return null;
}

// Each converter: (svgPath, pngPath, {w, h}) -> boolean (PNG written).
function converters(scale) {
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 60000 }).status === 0;
  const list = [];
  const chrome = findChrome();
  if (chrome) {
    list.push(['chrome', (svg, png, { w, h }) => {
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aioffice-render-chrome-'));
      try {
        return run(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
          '--no-default-browser-check', `--user-data-dir=${profile}`, `--window-size=${w},${h}`,
          `--force-device-scale-factor=${scale}`, `--screenshot=${png}`,
          // Chrome refuses to start as root (Linux sandboxes, containers) unless sandboxing is off.
          ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), url.pathToFileURL(svg).href]);
      } finally {
        fs.rmSync(profile, { recursive: true, force: true });
      }
    }]);
  }
  const rsvg = onPath('rsvg-convert');
  if (rsvg) list.push(['rsvg-convert', (svg, png, { w }) => run(rsvg, ['-w', String(Math.round(w * scale)), '-b', 'white', '-o', png, svg])]);
  const magick = onPath('magick');
  if (magick) list.push(['magick', (svg, png) => run(magick, ['-density', String(96 * scale), '-background', 'white', svg, '-flatten', png])]);
  return list;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let bytes;
  try { bytes = new Uint8Array(fs.readFileSync(opts.file)); } catch (e) { fail(`cannot read ${opts.file}: ${e.message}`); }
  // HWPX is a ZIP: run the same bomb/entity limits as the other readers before rhwp sees it.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    try { safeUnzip(bytes); } catch (e) { fail(e.message); }
  }

  const rhwp = await loadRhwp();
  let doc;
  try { doc = new rhwp.HwpDocument(bytes); } catch (e) { fail(`rhwp could not open ${opts.file}: ${e?.message || e}`); }
  const pageCount = doc.pageCount();
  const pages = parsePages(opts.pages, pageCount);
  const outDir = opts.out ? path.resolve(opts.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'aioffice-render-'));
  fs.mkdirSync(outDir, { recursive: true });

  let convs = opts.svgOnly ? [] : converters(opts.scale);
  let rasterizer = null;
  const out = [];
  for (const i of pages) {
    const name = `p${String(i + 1).padStart(2, '0')}`;
    const svgPath = path.join(outDir, `${name}.svg`);
    const svg = doc.renderPageSvg(i);
    fs.writeFileSync(svgPath, svg);
    const m = svg.match(/<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/);
    const size = { w: Math.ceil((m && +m[1]) || 794), h: Math.ceil((m && +m[2]) || 1123) };
    const pngPath = path.join(outDir, `${name}.png`);
    let png = null;
    while (convs.length) {
      const [label, conv] = convs[0];
      fs.rmSync(pngPath, { force: true });
      if (conv(svgPath, pngPath, size) && fs.existsSync(pngPath)) { png = pngPath; rasterizer = label; break; }
      convs = convs.slice(1); // broken here, skip it for later pages too
    }
    out.push({ page: i + 1, svg: svgPath, png });
  }
  doc.free?.();

  const result = { status: 'success', file: path.resolve(opts.file), pageCount, rasterizer, outDir, pages: out };
  if (!opts.svgOnly && !rasterizer) {
    result.note = 'No PNG converter found (Chrome/Edge/Chromium, rsvg-convert, magick). Only SVG was written.';
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

try {
  await main();
} catch (e) {
  process.stdout.write(JSON.stringify({ status: 'error', message: e?.message || String(e) }) + '\n');
  process.exitCode = 1;
}

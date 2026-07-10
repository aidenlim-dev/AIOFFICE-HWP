#!/usr/bin/env node
// font-inventory.js — Inventory declared fonts and rough run usage in .hwpx files.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import childProcess from 'node:child_process';
import { unzipSync, strFromU8 } from './vendor/fflate/index.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const LANG_ATTR_TO_FACE = {
  hangul: 'HANGUL',
  latin: 'LATIN',
  hanja: 'HANJA',
  japanese: 'JAPANESE',
  other: 'OTHER',
  symbol: 'SYMBOL',
  user: 'USER',
};
const LANG_ORDER = Object.values(LANG_ATTR_TO_FACE);

function printUsage() {
  process.stderr.write(
    '사용법: node font-inventory.js <파일.hwpx|파일.hwp> [--json]\n'
  );
}

function parseArgs(argv) {
  const opts = { input: null, json: false };
  for (const a of argv) {
    if (a === '--json') {
      opts.json = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a.startsWith('--')) {
      throw new Error(`알 수 없는 옵션: ${a}`);
    } else if (!opts.input) {
      opts.input = a;
    } else {
      throw new Error('입력 파일은 하나만 지정할 수 있습니다');
    }
  }
  return opts;
}

function writeOut(str) {
  const buf = Buffer.from(str, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(1, buf, off, buf.length - off); }
    catch (e) { if (e.code === 'EAGAIN') continue; throw e; }
  }
}

function getAttr(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${escapeRegex(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = attrs.match(re);
  return m ? (m[2] ?? m[3] ?? '') : null;
}

function attrsToObject(attrs) {
  const out = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrs)) !== null) {
    const raw = m[1];
    const local = raw.includes(':') ? raw.split(':').pop() : raw;
    out[local] = m[3] ?? m[4] ?? '';
  }
  return out;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchElements(xml, localName) {
  const name = escapeRegex(localName);
  const pref = '(?:[A-Za-z_][\\w.-]*:)?';
  const re = new RegExp(
    `<${pref}${name}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/${pref}${name}\\s*>)`,
    'g'
  );
  return [...xml.matchAll(re)].map((m) => ({ attrs: m[1] || '', inner: m[2] || '', raw: m[0] }));
}

function normName(name) {
  return String(name || '').trim().toLocaleLowerCase();
}

function looseName(name) {
  return normName(name)
    .replace(/\.(ttf|ttc|otf|otc|dfont|woff2?|fon)$/i, '')
    .replace(/[\s._-]+/g, '');
}

function loadAset() {
  const p = path.join(__dirname, 'aset-fonts.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const names = [...(data.korean || []), ...(data.latin || [])];
  return new Set(names.map(normName));
}

function collectInstalledFonts() {
  const fc = childProcess.spawnSync('fc-list', [':family'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (!fc.error && fc.status === 0 && fc.stdout.trim()) {
    const names = new Set();
    for (const line of fc.stdout.split(/\r?\n/)) {
      for (const part of line.split(',')) {
        const n = part.trim();
        if (n) names.add(looseName(n));
      }
    }
    return names.size ? names : null;
  }

  if (process.platform === 'darwin') {
    const dirs = [
      '/System/Library/Fonts',
      '/Library/Fonts',
      path.join(process.env.HOME || '', 'Library', 'Fonts'),
    ];
    const names = new Set();
    for (const dir of dirs) {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const entry of walkFontDir(dir)) {
        names.add(looseName(path.basename(entry)));
      }
    }
    return names.size ? names : null;
  }

  return null;
}

function walkFontDir(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFontDir(full));
    } else if (/\.(ttf|ttc|otf|otc|dfont|woff2?|fon)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function classifyFont(name, asetNames, installedNames) {
  if (asetNames.has(normName(name))) return 'aset';
  if (!installedNames) return 'unknown';
  return installedNames.has(looseName(name)) ? 'installed' : 'missing';
}

function parseHwpxInventory(bytes) {
  let files;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new Error(`HWPX ZIP을 열 수 없습니다: ${e.message}`);
  }
  const headerName = Object.keys(files).find((n) => /^Contents\/header\.xml$/i.test(n));
  if (!headerName) throw new Error('Contents/header.xml을 찾을 수 없습니다');
  const sectionNames = Object.keys(files)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => sectionIndex(a) - sectionIndex(b));
  if (sectionNames.length === 0) throw new Error('Contents/section*.xml을 찾을 수 없습니다');

  const headerXml = strFromU8(files[headerName]);
  const fontData = parseFontfaces(headerXml);
  const charPrFonts = parseCharPrFonts(headerXml, fontData.fontByLangId);

  for (const name of sectionNames) {
    const xml = strFromU8(files[name]);
    for (const m of xml.matchAll(/\bcharPrIDRef\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const charPrId = m[2] ?? m[3] ?? '';
      const fontNames = charPrFonts.get(charPrId);
      if (!fontNames) continue;
      for (const fontName of fontNames) {
        const info = fontData.fontsByName.get(fontName);
        if (info) info.runs += 1;
      }
    }
  }

  return [...fontData.fontsByName.values()];
}

function parseFontfaces(headerXml) {
  const fontsByName = new Map();
  const fontByLangId = new Map();
  for (const face of matchElements(headerXml, 'fontface')) {
    const lang = (getAttr(face.attrs, 'lang') || '').toUpperCase();
    if (!lang) continue;
    for (const font of matchElements(face.inner, 'font')) {
      const id = getAttr(font.attrs, 'id');
      const name = getAttr(font.attrs, 'face');
      if (id == null || !name) continue;
      const key = normName(name);
      fontByLangId.set(`${lang}:${id}`, key);
      if (!fontsByName.has(key)) {
        fontsByName.set(key, { name, langs: new Set(), runs: 0 });
      }
      fontsByName.get(key).langs.add(lang);
    }
  }
  if (fontsByName.size === 0) throw new Error('<hh:fontfaces>에서 폰트 선언을 찾지 못했습니다');
  return { fontsByName, fontByLangId };
}

function parseCharPrFonts(headerXml, fontByLangId) {
  const out = new Map();
  for (const charPr of matchElements(headerXml, 'charPr')) {
    const id = getAttr(charPr.attrs, 'id');
    if (id == null) continue;
    const fontRef = matchElements(charPr.inner, 'fontRef')[0];
    if (!fontRef) continue;
    const attrs = attrsToObject(fontRef.attrs);
    const names = new Set();
    for (const [attr, lang] of Object.entries(LANG_ATTR_TO_FACE)) {
      const ref = attrs[attr];
      if (ref == null) continue;
      const key = fontByLangId.get(`${lang}:${ref}`);
      if (key) names.add(key);
    }
    if (names.size) out.set(id, names);
  }
  return out;
}

function sectionIndex(name) {
  const m = name.match(/section(\d+)\.xml/i);
  return m ? parseInt(m[1], 10) : 0;
}

function buildResult(file, fonts) {
  const asetNames = loadAset();
  const installedNames = collectInstalledFonts();
  const classified = fonts
    .map((f) => ({
      name: f.name,
      langs: [...f.langs].sort((a, b) => {
        const ai = LANG_ORDER.indexOf(a);
        const bi = LANG_ORDER.indexOf(b);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        return a.localeCompare(b, 'ko');
      }),
      runs: f.runs,
      class: classifyFont(f.name, asetNames, installedNames),
    }))
    .sort((a, b) => (b.runs - a.runs) || a.name.localeCompare(b.name, 'ko'));

  const primaryFont = classified.length ? classified[0].name : null;
  return {
    file,
    fonts: classified,
    primaryFont,
    hasMissing: classified.some((f) => f.class === 'missing'),
  };
}

function classMessage(cls) {
  if (cls === 'aset') return '한컴독스·어디서나 렌더 OK';
  if (cls === 'installed') return '이 컴퓨터에는 있음, 한컴독스에선 대체될 수 있음';
  if (cls === 'unknown') return '이 환경에서는 로컬 설치 여부 판단 불가';
  return '로컬에도 없음: 설치하거나 대체 폰트로 작업 필요';
}

function renderText(result) {
  const lines = [`문서 선언 폰트 ${result.fonts.length}개`];
  for (const font of result.fonts) {
    const label = `[${font.class}]`.padEnd(12);
    lines.push(`${label}${font.name} (run ${font.runs}개) — ${classMessage(font.class)}`);
  }
  const primary = result.fonts[0] || null;
  if (primary && primary.class === 'missing') {
    lines.push(`요약: 주요 폰트(${primary.name})가 missing입니다 — 설치하거나 A-set 대체 폰트로 작업하세요.`);
  }
  return lines.join('\n') + '\n';
}

function isZip(bytes) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`오류: ${e.message}\n\n`);
  printUsage();
  process.exit(1);
}

if (opts.help || !opts.input) {
  printUsage();
  process.exit(opts.help ? 0 : 1);
}

if (!fs.existsSync(opts.input)) {
  process.stderr.write(`오류: 파일을 찾을 수 없습니다: ${opts.input}\n`);
  process.exit(1);
}

const bytes = fs.readFileSync(opts.input);
if (!isZip(bytes)) {
  if (path.extname(opts.input).toLowerCase() === '.hwp') {
    process.stderr.write('hwp 바이너리는 폰트 인벤토리 미지원 — hwpx 변환 후 사용\n');
    process.exit(2);
  }
  process.stderr.write('오류: 파싱 실패: HWPX ZIP 파일이 아닙니다\n');
  process.exit(1);
}

try {
  const fonts = parseHwpxInventory(bytes);
  const result = buildResult(path.resolve(opts.input), fonts);
  if (opts.json) {
    writeOut(JSON.stringify(result, null, 2) + '\n');
  } else {
    writeOut(renderText(result));
  }
} catch (e) {
  process.stderr.write(`오류: 파싱 실패: ${e.message}\n`);
  process.exit(1);
}

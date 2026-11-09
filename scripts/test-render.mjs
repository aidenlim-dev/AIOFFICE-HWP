import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SKILL = '../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/';
const scriptPath = (p) => fileURLToPath(new URL(SKILL + p, import.meta.url));
const stub = scriptPath('templates/hancom_native_stub.hwpx');

function render(args) {
  const r = spawnSync(process.execPath, [scriptPath('render.js'), ...args], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.signal, null, 'render.js must not hang');
  return { status: r.status, json: JSON.parse(r.stdout.trim().split('\n').pop()) };
}

test('stub renders to SVG only with --svg-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aioffice-render-'));
  try {
    const { status, json } = render([stub, '--svg-only', '--out', dir]);
    assert.equal(status, 0, JSON.stringify(json));
    assert.equal(json.pageCount, 1);
    assert.equal(json.rasterizer, null);
    assert.equal(json.pages.length, 1);
    assert.equal(json.pages[0].png, null);
    assert.match(readFileSync(json.pages[0].svg, 'utf8'), /^<svg/);
    assert.deepEqual(readdirSync(dir), ['p01.svg']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-page create.js output: --pages picks pages, PNG when a rasterizer exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aioffice-render-'));
  try {
    const doc = join(dir, 'two.hwpx');
    const c = spawnSync(process.execPath, [scriptPath('create.js')], {
      input: JSON.stringify({ path: doc, operations: [
        { type: 'append_paragraph', text: '첫째 쪽 한글 렌더' },
        { type: 'append_page_break' },
        { type: 'append_paragraph', text: '둘째 쪽' },
      ] }), encoding: 'utf8', timeout: 30000,
    });
    assert.equal(c.status, 0, c.stdout + c.stderr);

    const out = join(dir, 'out');
    const { status, json } = render([doc, '--pages', '2', '--out', out]);
    assert.equal(status, 0, JSON.stringify(json));
    assert.equal(json.pageCount, 2);
    assert.deepEqual(json.pages.map((p) => p.page), [2]);
    assert.match(readFileSync(json.pages[0].svg, 'utf8'), /^<svg/);
    if (json.rasterizer) {
      const png = readFileSync(json.pages[0].png);
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `PNG magic from ${json.rasterizer}`);
    } else {
      assert.match(json.note, /Only SVG/);
    }

    const bad = render([doc, '--pages', '3']);
    assert.equal(bad.status, 1);
    assert.match(bad.json.message, /out of range/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

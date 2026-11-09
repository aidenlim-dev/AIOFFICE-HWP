import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SKILL = '../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/';
const scriptPath = (p) => fileURLToPath(new URL(SKILL + p, import.meta.url));
const { zipSync, unzipSync, strToU8, strFromU8 } = await import(new URL(SKILL + 'vendor/fflate/index.mjs', import.meta.url));
const SEC = 'Contents/section0.xml';

function run(input, output, operations) {
  return spawnSync(process.execPath, [scriptPath('hwpx-edit.js')], {
    input: JSON.stringify({ path: input, output, operations }), encoding: 'utf8', timeout: 20000,
  });
}

const attr = (s, n) => Number((s.match(new RegExp(`\\b${n}="(\\d+)"`)) || [])[1]);

// 4x4 table, text "r{r}c{c}", then: A = 2x2 merge at (0,0), B = rowSpan 3 at (1,2),
// and a cellzone on row 3 cols 0-1.
//   row0: A  A  02 03
//   row1: A  A  B  13
//   row2: 20 21 B  23
//   row3: 30 31 B  33
const fixture = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'aioffice-merge-'));
  try {
    const out = join(dir, 't.hwpx');
    const cells = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => `r${r}c${c}`));
    const res = run(scriptPath('templates/hancom_native_stub.hwpx'), out, [{ type: 'insert_table', index: 0, rows: 4, cols: 4, cells }]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const files = unzipSync(new Uint8Array(readFileSync(out)));
    let xml = strFromU8(files[SEC]);
    xml = xml.replace(/<hp:tc\b[\s\S]*?<\/hp:tc>/g, (tc) => {
      const r = attr(tc, 'rowAddr'), c = attr(tc, 'colAddr');
      const w = attr(tc, 'width'), h = attr(tc, 'height');
      const span = (cs, rs) => tc.replace(/colSpan="1" rowSpan="1"/, `colSpan="${cs}" rowSpan="${rs}"`)
        .replace(/<hp:cellSz width="\d+" height="\d+"/, `<hp:cellSz width="${w * cs}" height="${h * rs}"`);
      if (r === 0 && c === 0) return span(2, 2);
      if (r === 1 && c === 2) return span(1, 3);
      if ((r < 2 && c < 2) || (r > 1 && c === 2)) return '';
      return tc;
    });
    xml = xml.replace(/(<hp:tbl\b[\s\S]*?)(<hp:tr>)/, '$1<hp:cellzoneList><hp:cellzone startRowAddr="3" startColAddr="0" endRowAddr="3" endColAddr="1" borderFillIDRef="4"/></hp:cellzoneList>$2');
    files[SEC] = strToU8(xml);
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// Apply ops to the fixture; return { ok, stdout, table } where table is parsed grid info.
function edit(operations) {
  const dir = mkdtempSync(join(tmpdir(), 'aioffice-merge-'));
  try {
    const input = join(dir, 'in.hwpx'), output = join(dir, 'out.hwpx');
    writeFileSync(input, zipSync(fixture));
    const res = run(input, output, operations);
    if (res.status !== 0) return { ok: false, stdout: res.stdout, written: existsSync(output) };
    const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(output)))[SEC]);
    return { ok: true, table: parseTable(xml.match(/<hp:tbl\b[\s\S]*<\/hp:tbl>/)[0]) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseTable(tbl) {
  const open = tbl.match(/<hp:tbl\b[^>]*>/)[0];
  const head = tbl.slice(0, tbl.indexOf('<hp:tr>'));
  const sz = head.match(/<hp:sz\b[^>]*>/)[0];
  const rows = tbl.split('<hp:tr>').slice(1).map((tr, ti) => (tr.match(/<hp:tc\b[\s\S]*?<\/hp:tc>/g) || []).map((tc) => ({
    ti, ra: attr(tc, 'rowAddr'), ca: attr(tc, 'colAddr'), cs: attr(tc, 'colSpan'), rs: attr(tc, 'rowSpan'),
    w: attr(tc.match(/<hp:cellSz[^>]*>/)[0], 'width'), h: attr(tc.match(/<hp:cellSz[^>]*>/)[0], 'height'),
    text: (tc.match(/<hp:t>([^<]*)<\/hp:t>/) || [, ''])[1],
  })));
  return {
    rowCnt: attr(open, 'rowCnt'), colCnt: attr(open, 'colCnt'), width: attr(sz, 'width'), height: attr(sz, 'height'),
    zones: [...head.matchAll(/<hp:cellzone\b[^>]*>/g)].map((m) => m[0]), hasLineseg: /linesegarray/.test(tbl),
    rows, cells: rows.flat(),
  };
}

// Every slot covered exactly once, counts match, rowAddr = tr index, colAddr ascending in each tr.
function assertGrid(t) {
  assert.equal(t.rows.length, t.rowCnt, 'tr count = rowCnt');
  const seen = new Map();
  for (const c of t.cells) {
    assert.equal(c.ra, c.ti, `cell ${c.text} rowAddr = its tr index`);
    for (let r = c.ra; r < c.ra + c.rs; r++) for (let k = c.ca; k < c.ca + c.cs; k++) {
      assert.ok(r < t.rowCnt && k < t.colCnt, `cell ${c.text} inside the grid`);
      assert.ok(!seen.has(`${r},${k}`), `slot ${r},${k} covered once`);
      seen.set(`${r},${k}`, 1);
    }
  }
  assert.equal(seen.size, t.rowCnt * t.colCnt, 'every slot covered');
  for (const row of t.rows) for (let i = 1; i < row.length; i++) assert.ok(row[i].ca > row[i - 1].ca, 'colAddr ascending in tr');
}

const base = edit([]).table;
const cell = (t, text) => t.cells.find((c) => c.text === text);
const H = cell(base, 'r2c0').h, W = cell(base, 'r2c0').w;

test('fixture is a valid merged 4x4 grid', () => {
  assertGrid(base);
  assert.deepEqual([base.rowCnt, base.colCnt], [4, 4]);
  assert.deepEqual([cell(base, 'r0c0').cs, cell(base, 'r0c0').rs, cell(base, 'r1c2').rs], [2, 2, 3]);
});

test('delete_table_row through a rowSpan shrinks the span, its height, the table and shifts cells', () => {
  const { ok, table: t } = edit([{ type: 'delete_table_row', table: 0, row: 2 }]);
  assert.ok(ok);
  assertGrid(t);
  assert.equal(t.rowCnt, 3);
  const B = cell(t, 'r1c2');
  assert.deepEqual([B.ra, B.rs, B.h], [1, 2, 2 * H]);
  assert.equal(cell(t, 'r3c0').ra, 2);
  assert.equal(cell(t, 'r2c0'), undefined);
  assert.equal(t.height, base.height - H);
  assert.match(t.zones[0], /startRowAddr="2"[^>]*endRowAddr="2"/);
  assert.equal(t.hasLineseg, false);
});

test('delete_table_row drops a cellzone that lived only on that row', () => {
  const { ok, table: t } = edit([{ type: 'delete_table_row', table: 0, row: 3 }]);
  assert.ok(ok);
  assertGrid(t);
  assert.equal(cell(t, 'r1c2').rs, 2);
  assert.deepEqual(t.zones, []);
});

test('delete_table_row on a merge origin is refused and the batch writes nothing', () => {
  for (const row of [0, 1]) {
    const r = edit([{ type: 'set_cell_text', table: 0, row: 3, col: 3, text: 'x' }, { type: 'delete_table_row', table: 0, row }]);
    assert.equal(r.ok, false);
    assert.match(r.stdout, /unmerge_cells first/);
    assert.equal(r.written, false);
  }
});

test('insert_table_row inside merges grows spans and adds cells only in uncovered columns', () => {
  const { ok, table: t } = edit([{ type: 'insert_table_row', table: 0, row: 1, cells: ['x0', 'x1', 'x2', 'x3'] }]);
  assert.ok(ok);
  assertGrid(t);
  assert.equal(t.rowCnt, 5);
  const A = cell(t, 'r0c0');
  assert.deepEqual([A.rs, A.h], [3, 3 * H]);
  assert.equal(cell(t, 'r1c2').ra, 2);
  assert.deepEqual(t.rows[1].map((c) => [c.ca, c.text]), [[2, 'x2'], [3, 'x3']]);
  assert.equal(t.height, base.height + H);
  assert.match(t.zones[0], /startRowAddr="4"[^>]*endRowAddr="4"/);
});

test('insert_table_row after the last row adds a full row', () => {
  const { ok, table: t } = edit([{ type: 'insert_table_row', table: 0, row: 3, where: 'after' }]);
  assert.ok(ok);
  assertGrid(t);
  assert.equal(t.rows[4].length, 4);
  assert.equal(cell(t, 'r1c2').rs, 3, 'span ending at the insert point is not grown');
});

test('insert_table_column inside a colSpan grows it; new cells go to uncovered rows', () => {
  const { ok, table: t } = edit([{ type: 'insert_table_column', table: 0, col: 1, cells: ['y0', 'y1', 'y2', 'y3'] }]);
  assert.ok(ok);
  assertGrid(t);
  assert.equal(t.colCnt, 5);
  const A = cell(t, 'r0c0');
  // The fixture is full text width, so the 5th column is scaled back by 4/5 to fit the page.
  assert.deepEqual([A.cs, A.w], [3, Math.round(3 * W * 4 / 5)]);
  assert.deepEqual(t.cells.filter((c) => /^y/.test(c.text)).map((c) => [c.ra, c.ca, c.text]), [[2, 1, 'y2'], [3, 1, 'y3']]);
  assert.equal(cell(t, 'r1c2').ca, 3);
  assert.equal(t.width, base.width);
});

test('insert_table_column addresses by colAddr, not position in the tr', () => {
  // Row 1 holds only B and r1c3, so position 2 would be r1c3; colAddr 2 is B.
  const { ok, table: t } = edit([{ type: 'insert_table_column', table: 0, col: 2, where: 'after' }]);
  assert.ok(ok);
  assertGrid(t);
  assert.deepEqual(t.cells.filter((c) => c.ca === 3).map((c) => c.ra), [0, 1, 2, 3]);
  assert.equal(cell(t, 'r1c3').ca, 4);
});

test('delete_table_column through a colSpan shrinks it; a colSpan origin is refused', () => {
  const { ok, table: t } = edit([{ type: 'delete_table_column', table: 0, col: 1 }]);
  assert.ok(ok);
  assertGrid(t);
  assert.equal(t.colCnt, 3);
  const A = cell(t, 'r0c0');
  assert.deepEqual([A.cs, A.w], [1, W]);
  assert.equal(cell(t, 'r2c1'), undefined);
  assert.equal(cell(t, 'r1c2').ca, 1);
  assert.equal(t.width, base.width - W);
  assert.match(t.zones[0], /startColAddr="0"[^>]*endColAddr="0"/);

  const r = edit([{ type: 'delete_table_column', table: 0, col: 0 }]);
  assert.equal(r.ok, false);
  assert.match(r.stdout, /colSpan 2.*unmerge_cells first/);
});

test('delete_table_column removes a rowSpan cell that sits wholly in the column', () => {
  const { ok, table: t } = edit([{ type: 'delete_table_column', table: 0, col: 2 }]);
  assert.ok(ok);
  assertGrid(t);
  assert.equal(cell(t, 'r1c2'), undefined);
  assert.equal(cell(t, 'r3c3').ca, 2);
});

test('four ops chained in one batch keep the grid valid', () => {
  const { ok, table: t } = edit([
    { type: 'insert_table_row', table: 0, row: 1 },
    { type: 'insert_table_column', table: 0, col: 1 },
    { type: 'delete_table_row', table: 0, row: 3 },
    { type: 'delete_table_column', table: 0, col: 2 },
  ]);
  assert.ok(ok);
  assertGrid(t);
  assert.deepEqual([t.rowCnt, t.colCnt], [4, 4]);
});

test('merge_cells then insert/delete through the merge re-sums the merged cell size', () => {
  // merge_cells keeps the single-cell cellSz, so the shift must not add to or subtract from it.
  // merge_cells counts tr positions: row 0 positions 1-2 = cols 2-3, col position 2 in rows 2-3 = col 3.
  const hz = { type: 'merge_cells', table: 0, mode: 'horizontal', row: 0, start: 1, count: 2 };
  let { ok, table: t } = edit([hz, { type: 'delete_table_column', table: 0, col: 3 }]);
  assert.ok(ok);
  assertGrid(t);
  assert.deepEqual([cell(t, 'r0c2').cs, cell(t, 'r0c2').w], [1, W]);
  ({ ok, table: t } = edit([hz, { type: 'insert_table_column', table: 0, col: 3 }]));
  assert.ok(ok);
  assertGrid(t);
  assert.deepEqual([cell(t, 'r0c2').cs, cell(t, 'r0c2').w], [3, Math.round(3 * W * 4 / 5)]); // fitted to page
  const vt = { type: 'merge_cells', table: 0, mode: 'vertical', col: 2, start: 2, count: 2 };
  ({ ok, table: t } = edit([vt, { type: 'delete_table_row', table: 0, row: 3 }]));
  assert.ok(ok);
  assertGrid(t);
  assert.deepEqual([cell(t, 'r2c3').rs, cell(t, 'r2c3').h], [1, H]);
});

test('insert_table_column on a full-width table with a horizontal merge stays inside the text width', () => {
  // Verified in Hancom: without the fit, the new column pushed the table past the right margin.
  const dir = mkdtempSync(join(tmpdir(), 'aioffice-colfit-'));
  try {
    const out = join(dir, 'f.hwpx');
    const cells = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => `r${r}c${c}`));
    const res = run(scriptPath('templates/hancom_native_stub.hwpx'), out, [
      { type: 'insert_table', index: 0, rows: 4, cols: 4, cells },
      { type: 'merge_cells', table: 0, mode: 'horizontal', row: 0, start: 1, count: 2 },
      { type: 'insert_table_column', table: 0, col: 3, where: 'before' },
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(JSON.parse(res.stdout).results[2].fittedToPage, true);
    const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(out)))[SEC]);
    const textW = 59528 - 8504 * 2; // stub: A4, 30mm side margins
    const widest = Math.max(...[...xml.matchAll(/<hp:tr>([\s\S]*?)<\/hp:tr>/g)]
      .map(([, tr]) => [...tr.matchAll(/<hp:cellSz width="(\d+)"/g)].reduce((a, m) => a + Number(m[1]), 0)));
    assert.ok(widest <= textW + 5, `widest row ${widest} > text width ${textW}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

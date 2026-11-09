import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const SKILL = '../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/';
const scriptPath = (p) => fileURLToPath(new URL(SKILL + p, import.meta.url));
const { unzipSync, zipSync, strFromU8, strToU8 } = await import(new URL(SKILL + 'vendor/fflate/index.mjs', import.meta.url));
const { xmlEscape, xmlText, sanitizeHwpText, HP_TAB } = await import(new URL(SKILL + 'cell-patch.js', import.meta.url));

const dir = mkdtempSync(join(tmpdir(), 'aioffice-sanitize-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const STUB = scriptPath('templates/hancom_native_stub.hwpx');

function run(cmd, args, input) {
  return spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 60000 });
}
function editHwpx(out, operations, extra = {}) {
  const r = run(process.execPath, [scriptPath('hwpx-edit.js')], JSON.stringify({ path: STUB, output: out, operations, ...extra }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}
const sectionXml = (p) => strFromU8(unzipSync(new Uint8Array(readFileSync(p)))['Contents/section0.xml']);

test('xmlText maps tab/newline to inline controls and drops XML-illegal chars', () => {
  // Element content keeps quotes raw (replace_text matches the stored text); attributes escape them.
  assert.equal(xmlText('a\tb\nc"\'<\x01'), `a${HP_TAB}b<hp:lineBreak/>c"'&lt;`);
  assert.equal(xmlText('x\r\ny\rz'), 'x<hp:lineBreak/>y<hp:lineBreak/>z');
  assert.equal(xmlEscape(`a"b'c&d>`), 'a&quot;b&#39;c&amp;d&gt;');
  // Paired surrogate kept, lone ones and U+FFFE/FFFF dropped.
  assert.equal(xmlEscape('\u{1F600}\uD800x\uDC00￾￿'), '\u{1F600}x');
});

test('sanitizeHwpText keeps only \\n below 0x20 and turns tab into a space', () => {
  assert.equal(sanitizeHwpText('a\tb\r\nc\rd\x01\x0Be\x1F'), 'a b\nc\nde');
  assert.equal(sanitizeHwpText(undefined), '');
});

test('HWPX writes tab/lineBreak controls, quotes in attributes stay valid, round-trips', () => {
  const out = join(dir, 'p.hwpx');
  editHwpx(out, [
    { type: 'set_paragraph_text', index: 0, text: 'a\tb\nc"<\x01' },
    { type: 'insert_bookmark', index: 0, name: 'bm"1' },
    { type: 'insert_table', index: 0, rows: 1, cols: 2 },
    { type: 'set_cell_text', table: 0, row: 0, col: 0, text: 'L\tR' },
  ]);
  const xml = sectionXml(out);
  assert.ok(xml.includes(`a${HP_TAB}b<hp:lineBreak/>c"&lt;`), 'paragraph text');
  assert.ok(xml.includes('name="bm&quot;1"'), 'bookmark attribute');

  const v = run('python3', [scriptPath('validate.py'), out]);
  assert.equal(v.status, 0, v.stderr);

  const e = run(process.execPath, [scriptPath('extract_text.js'), out]);
  assert.equal(e.status, 0, e.stderr);
  assert.ok(e.stdout.includes('a\tb'), e.stdout);
  assert.ok(e.stdout.includes('c"<'), e.stdout);

  // Cell reader sees through inline controls (was [^<]* and read nothing).
  const cells = editHwpx(out, [], { path: out, inspect: 'cells' }).tables[0].cells;
  assert.equal(cells[0].text, 'L\tR');
});

test('HWPX text with quotes, line breaks and literal entities stays findable and extracts as written', () => {
  const out = join(dir, 'q.hwpx');
  editHwpx(out, [{ type: 'append_paragraph', text: `Kim's "form"\nLINE2 &lt; x` }]);
  // Hancom-style numeric refs decode; an out-of-range one must not crash the reader.
  const files = unzipSync(new Uint8Array(readFileSync(out)));
  files['Contents/section0.xml'] = strToU8(strFromU8(files['Contents/section0.xml']).replace('LINE2', 'L&#39;&#x41;&#99999999;'));
  const numRef = join(dir, 'qn.hwpx');
  writeFileSync(numRef, zipSync(files));
  const en = run(process.execPath, [scriptPath('extract_text.js'), numRef]);
  assert.equal(en.status, 0, en.stderr);
  assert.ok(en.stdout.includes("L'A&#99999999;"), en.stdout);
  const e = run(process.execPath, [scriptPath('extract_text.js'), out]);
  assert.equal(e.status, 0, e.stderr);
  assert.ok(e.stdout.includes(`Kim's "form"\nLINE2 &lt; x`), e.stdout);
  const r1 = editHwpx(join(dir, 'q1.hwpx'), [{ type: 'replace_text', find: "Kim's", replace: 'Lee' }], { path: out });
  assert.match(JSON.stringify(r1), /"replaced":1\b/);
  editHwpx(join(dir, 'q2.hwpx'), [{ type: 'replace_text', find: '"form"', replace: 'X', expected_count: 1 }], { path: out });
});

test('validate.py flags a raw tab inside <hp:t>', () => {
  const p = join(dir, 'raw.hwpx');
  const files = unzipSync(new Uint8Array(readFileSync(STUB)));
  const sec = strFromU8(files['Contents/section0.xml']);
  assert.ok(sec.includes('<hp:t>'));
  files['Contents/section0.xml'] = strToU8(sec.replace('<hp:t>', '<hp:t>x\ty'));
  writeFileSync(p, zipSync(files)); // unzip keeps insertion order, mimetype stays first
  const v = run('python3', [scriptPath('validate.py'), p]);
  assert.equal(v.status, 1, v.stderr);
  assert.match(v.stderr, /raw tab inside <hp:t>/);
});

test('.hwp: tab and control chars are sanitized before PARA_TEXT is written', () => {
  const p = join(dir, 'h.hwp');
  const create = (operations) => {
    const r = run(process.execPath, [scriptPath('create.js')], JSON.stringify({ path: p, operations }));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  };
  create([{ type: 'append_paragraph', text: 'TOKEN' }, { type: 'append_paragraph', text: 'end' }]); // new file: rhwp path
  // Existing file: raw-patch path (cell-patch.js).
  create([{ type: 'append_paragraph', text: 'P\tQ\x01R' }, { type: 'replace_text', query: 'TOKEN', replacement: 'S\tT\x02U' }]);
  const e = run(process.execPath, [scriptPath('extract_text.js'), p]);
  assert.equal(e.status, 0, e.stderr);
  assert.ok(e.stdout.includes('P QR'), e.stdout);
  assert.ok(e.stdout.includes('S TU'), e.stdout);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const SKILL = '../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/';
const scriptPath = (p) => fileURLToPath(new URL(SKILL + p, import.meta.url));
const { zipSync, unzipSync, strToU8, strFromU8 } = await import(new URL(SKILL + 'vendor/fflate/index.mjs', import.meta.url));

const dir = mkdtempSync(join(tmpdir(), 'aioffice-replace-count-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const DOT = '\u2027';   // hyphenation point, what Hancom forms often store
const MID = '\u00B7';   // middle dot, what people usually type
const SEC = 'Contents/section0.xml';

function node(script, payload) {
  const r = spawnSync(process.execPath, [scriptPath(script)], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 60000 });
  const text = r.stdout.trim();
  return { status: r.status, out: JSON.parse(text.startsWith('{\n') ? text : text.split('\n').pop()) };
}

// .hwpx fixture: the stub with the token "부데소니드" twice in one paragraph.
function hwpxFixture(name) {
  const files = unzipSync(new Uint8Array(readFileSync(scriptPath('templates/hancom_native_stub.hwpx'))));
  files[SEC] = strToU8(strFromU8(files[SEC]).replace('부데소니드', `부데소니드 연구${DOT}개발, 부데소니드`));
  const p = join(dir, name);
  writeFileSync(p, zipSync(files));
  return p;
}
const editHwpx = (p, operations) => node('hwpx-edit.js', { path: p, output: p, operations });
const sectionText = (p) => strFromU8(unzipSync(new Uint8Array(readFileSync(p)))[SEC]);

// .hwp fixture: built once by create.js, copied per test.
const hwpBase = join(dir, 'base.hwp');
assert.equal(node('create.js', { path: hwpBase, operations: [
  { type: 'append_paragraph', text: '성명: 홍길동 (갑)' },
  { type: 'append_paragraph', text: `대리인: 홍길동, 연구${DOT}개발 담당` },
  { type: 'append_table', headers: ['이름', '값'], rows: [['a', 'b']] },
] }).out.status, 'success');
function hwpFixture(name) {
  const p = join(dir, name);
  writeFileSync(p, readFileSync(hwpBase));
  return p;
}
const editHwp = (p, operations) => node('create.js', { path: p, operations });
const hwpText = (p) => spawnSync(process.execPath, [scriptPath('extract_text.js'), p], { encoding: 'utf8' }).stdout;

test('hwpx: expected_count 1 on a doubled token throws and leaves the file byte-identical', () => {
  const p = hwpxFixture('a.hwpx');
  const before = readFileSync(p);
  const r = editHwpx(p, [{ type: 'replace_text', find: '부데소니드', replace: 'X', expected_count: 1 }]);
  assert.equal(r.status, 1);
  assert.equal(r.out.code, 'AMBIGUOUS_TARGET');
  assert.equal(r.out.candidates.length, 2);
  assert.match(r.out.candidates[0].context, /부데소니드/);
  assert.ok(readFileSync(p).equals(before));
});

test('hwpx: expected_count 2 succeeds, and a replacement containing find counts once per spot', () => {
  const p = hwpxFixture('b.hwpx');
  const r = editHwpx(p, [{ type: 'replace_text', find: '부데소니드', replace: '부데소니드(수정)', expected_count: 2, section: 0 }]);
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.equal(r.out.results[0].replaced, 2);
  assert.equal(sectionText(p).split('부데소니드(수정)').length - 1, 2);
});

test('hwpx: a middle-dot typo gets a near-match hint with the real document text', () => {
  const p = hwpxFixture('c.hwpx');
  const r = editHwpx(p, [{ type: 'replace_text', find: `연구${MID}개발`, replace: 'R&D', expected_count: 1 }]);
  assert.equal(r.status, 1);
  assert.equal(r.out.code, 'TARGET_NOT_FOUND');
  assert.equal(r.out.near[0].text, `연구${DOT}개발`);
});

test('hwpx: occurrence is refused, fill_template require_unique reports positions only', () => {
  const p = hwpxFixture('d.hwpx');
  assert.match(editHwpx(p, [{ type: 'replace_text', find: '부데소니드', replace: 'X', occurrence: 0 }]).out.error, /occurrence/);
  const r = editHwpx(p, [{ type: 'fill_template', values: { '부데소니드': 'X' }, require_unique: true }]);
  assert.equal(r.out.code, 'AMBIGUOUS_TARGET');
  assert.match(r.out.error, /matched 2 spots \(section 0 para 0, section 0 para 0\)/);
  assert.doesNotMatch(r.out.error, /연구/);
});

test('hwp: expected_count 1 on a doubled token throws and leaves the file byte-identical', () => {
  const p = hwpFixture('a.hwp');
  const before = readFileSync(p);
  const r = editHwp(p, [{ type: 'replace_text', query: '홍길동', replacement: '김철수', expected_count: 1 }]);
  assert.equal(r.out.status, 'error');
  assert.equal(r.out.code, 'AMBIGUOUS_TARGET');
  assert.deepEqual(r.out.candidates.map((c) => c.para), [0, 1]);
  assert.ok(readFileSync(p).equals(before));
});

test('hwp: expected_count 2 replaces both, even when the replacement contains the query', () => {
  const p = hwpFixture('b.hwp');
  const r = editHwp(p, [{ type: 'replace_text', query: '홍길동', replacement: '홍길동님', expected_count: 2 }]);
  assert.equal(r.out.status, 'success', JSON.stringify(r.out));
  assert.equal(hwpText(p).split('홍길동님').length - 1, 2);
});

test('hwp: a middle-dot typo gets a near-match hint and writes nothing', () => {
  const p = hwpFixture('c.hwp');
  const before = readFileSync(p);
  const r = editHwp(p, [{ type: 'replace_text', query: `연구${MID}개발`, replacement: 'R&D', expected_count: 1 }]);
  assert.equal(r.out.code, 'TARGET_NOT_FOUND');
  assert.equal(r.out.near[0].text, `연구${DOT}개발`);
  assert.ok(readFileSync(p).equals(before));
});

test('hwp: occurrence picks one match, default still replaces only the first per section', () => {
  const p = hwpFixture('d.hwp');
  assert.equal(editHwp(p, [{ type: 'replace_text', query: '홍길동', replacement: 'X', occurrence: 1 }]).out.status, 'success');
  assert.match(hwpText(p), /성명: 홍길동 \(갑\)[\s\S]*대리인: X,/);
  const q = hwpFixture('e.hwp');
  assert.equal(editHwp(q, [{ type: 'replace_text', query: '홍길동', replacement: 'X' }]).out.status, 'success');
  assert.match(hwpText(q), /성명: X \(갑\)[\s\S]*대리인: 홍길동,/);
});

test('hwp: a count mismatch after a cell edit in the same batch rolls the cell edit back', () => {
  const p = hwpFixture('f.hwp');
  const before = readFileSync(p);
  const r = editHwp(p, [
    { type: 'set_cell_text_by_label', label: '이름', text: 'ZZZ' },
    { type: 'replace_text', query: '홍길동', replacement: 'X', expected_count: 1 },
  ]);
  assert.equal(r.out.code, 'AMBIGUOUS_TARGET');
  assert.ok(readFileSync(p).equals(before));
});

test('hwp: count options in a batch that leaves the raw-patch path are refused, not ignored', () => {
  const p = hwpFixture('g.hwp');
  const before = readFileSync(p);
  const r = editHwp(p, [
    { type: 'replace_text', query: '홍길동', replacement: 'X', expected_count: 1 },
    { type: 'set_header', text: 'H' },
  ]);
  assert.equal(r.out.status, 'error');
  assert.match(r.out.message, /expected_count is only honoured on the \.hwp raw-patch path/);
  assert.ok(readFileSync(p).equals(before));
});

test('hwpx: replace_text leaves hyperlink field params alone and keeps <hp:ctrl> out of <hp:t>', () => {
  const p = hwpxFixture('link.hwpx');
  assert.equal(editHwpx(p, [{ type: 'insert_hyperlink', url: 'https://example.com/?q=1', text: '링크' }]).out.ok, true);
  const r = editHwpx(p, [{ type: 'replace_text', find: 'example', replace: 'zzz' }]);
  assert.equal(r.out.ok, true);
  assert.equal(r.out.results[0].replaced, 0);
  const xml = sectionText(p);
  assert.match(xml, /name="Path">https:\/\/example\.com\/\?q=1</);
  assert.doesNotMatch(xml, /<hp:t(?:\s[^>/]*)?>(?:(?!<\/hp:t>)[\s\S])*<hp:ctrl/);
});

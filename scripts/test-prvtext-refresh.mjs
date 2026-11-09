import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SKILL = '../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/';
const scriptPath = (p) => fileURLToPath(new URL(SKILL + p, import.meta.url));
const { zipSync, unzipSync, strToU8, strFromU8 } = await import(new URL(SKILL + 'vendor/fflate/index.mjs', import.meta.url));
const stub = new Uint8Array(readFileSync(scriptPath('templates/hancom_native_stub.hwpx')));
const PRV = 'Preview/PrvText.txt';

// Run hwpx-edit.js on `files` with `operations`, return the output entries.
function edit(files, operations) {
  const dir = mkdtempSync(join(tmpdir(), 'aioffice-prvtext-'));
  try {
    const input = join(dir, 'in.hwpx');
    const output = join(dir, 'out.hwpx');
    writeFileSync(input, zipSync(files));
    const r = spawnSync(process.execPath, [scriptPath('hwpx-edit.js')], {
      input: JSON.stringify({ path: input, output, operations }), encoding: 'utf8', timeout: 20000,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return unzipSync(new Uint8Array(readFileSync(output)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('replace_text rebuilds PrvText: new text in, old text out, within 1022 chars', () => {
  const before = strFromU8(unzipSync(stub)[PRV]);
  assert.match(before, /키프리스/, 'stub PrvText carries stale template text');
  const out = edit(unzipSync(stub), [{ type: 'replace_text', find: '부데소니드', replace: '새보고서' }]);
  const prv = strFromU8(out[PRV]);
  assert.match(prv, /새보고서 관련 특허 조사 보고서 \(v3\)\r\n/);
  assert.doesNotMatch(prv, /부데소니드/);
  assert.doesNotMatch(prv, /키프리스/);
  assert.ok(prv.length <= 1022);
  assert.deepEqual(out['Preview/PrvImage.png'], unzipSync(stub)['Preview/PrvImage.png'], 'PrvImage untouched');
});

test('tabs become spaces, entities decode, long text cut at 1022, BOM kept', () => {
  const files = unzipSync(stub);
  files[PRV] = strToU8('\uFEFFold');
  const long = 'x'.repeat(2000);
  const out = edit(files, [
    { type: 'replace_text', find: '부데소니드', replace: 'a&b' },
    { type: 'append_paragraph', text: long },
  ]);
  const bytes = out[PRV];
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const prv = strFromU8(bytes); // TextDecoder drops the BOM
  assert.match(prv, /^a&b 관련/);
  assert.equal(prv.length, 1022);

  const tabbed = unzipSync(stub);
  tabbed['Contents/section0.xml'] = strToU8(strFromU8(tabbed['Contents/section0.xml'])
    .replace('관련 특허', '관련<hp:tab width="4000" leader="0" type="1"/>특허'));
  const prv2 = strFromU8(edit(tabbed, [{ type: 'replace_text', find: '부데소니드', replace: 'B' }])[PRV]);
  assert.match(prv2, /^B 관련 특허/);
});

test('missing PrvText is not created; no section edit leaves it alone', () => {
  const files = unzipSync(stub);
  delete files[PRV];
  assert.equal(PRV in edit(files, [{ type: 'replace_text', find: '부데소니드', replace: 'X' }]), false);
  assert.deepEqual(edit(unzipSync(stub), [])[PRV], unzipSync(stub)[PRV]);
});

test('hidden comment and memo body stay out of PrvText, field text stays in', () => {
  const sub = (t) => `<hp:subList><hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p></hp:subList>`;
  const hidden = `<hp:ctrl><hp:hiddenComment>${sub('SECRET-HIDDEN')}</hp:hiddenComment></hp:ctrl>`;
  const memo = `<hp:ctrl><hp:fieldBegin id="1" type="MEMO" name=""><hp:parameters cnt="0" name=""/>${sub('SECRET-MEMO')}</hp:fieldBegin></hp:ctrl>`
    + '<hp:t>VISIBLE-FIELD</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="1"/></hp:ctrl>'
    + '<hp:ctrl><hp:fieldBegin id="2" type="CLICK_HERE"/></hp:ctrl><hp:t>AFTER-SELF-CLOSED</hp:t>';
  const files = unzipSync(stub);
  files['Contents/section0.xml'] = strToU8(strFromU8(files['Contents/section0.xml'])
    .replace(/(<hp:run\b[^>]*>)/, '$1' + hidden + memo));
  const prv = strFromU8(edit(files, [{ type: 'replace_text', find: '부데소니드', replace: 'N' }])[PRV]);
  assert.doesNotMatch(prv, /SECRET/);
  assert.match(prv, /^VISIBLE-FIELDAFTER-SELF-CLOSEDN 관련 특허/);
});

// set_paragraph_text on a section's first paragraph must keep <hp:secPr>/<hp:ctrl>
// (page size, columns). Losing them collapsed the stub into 19 one-glyph pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from '../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/vendor/fflate/index.mjs';

const S = path.join(path.dirname(fileURLToPath(import.meta.url)), '../plugins/aioffice-hwp/skills/aioffice-hwp/scripts');
const stub = path.join(S, 'templates/hancom_native_stub.hwpx');

test('set_paragraph_text index 0 keeps secPr and colPr ctrl', () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'secpr-')), 'a.hwpx');
  const r = spawnSync(process.execPath, [path.join(S, 'hwpx-edit.js')], {
    input: JSON.stringify({ path: stub, output: out, operations: [{ type: 'set_paragraph_text', index: 0, text: '제목' }] }),
  });
  assert.equal(JSON.parse(r.stdout).ok, true, String(r.stdout));
  const before = strFromU8(unzipSync(readFileSync(stub))['Contents/section0.xml']);
  const after = strFromU8(unzipSync(readFileSync(out))['Contents/section0.xml']);
  assert.equal((after.match(/<hp:secPr\b/g) || []).length, (before.match(/<hp:secPr\b/g) || []).length);
  assert.equal((after.match(/<hp:colPr\b/g) || []).length, (before.match(/<hp:colPr\b/g) || []).length);
  const ins = spawnSync(process.execPath, [path.join(S, 'extract_text.js'), out]);
  assert.match(String(ins.stdout), /제목/);
});

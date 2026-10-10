import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/vendor/fflate/index.mjs';

test('vendored ZIP library preserves Korean text', () => {
  const text = '한글 압축 왕복 검증';
  const zip = zipSync({ 'document.txt': strToU8(text) });
  assert.equal(strFromU8(unzipSync(zip)['document.txt']), text);
});

test('document reader rejects malformed ZIP64 without hanging', () => {
  // Construct a ZIP64 directory with a missing per-file ZIP64 extra field.
  // The same fixture times out with fflate 0.8.2 (CVE-2026-45820).
  const zip = zipSync({ 'Contents/section0.xml': strToU8('<section/>') });
  const end = zip.length - 22;
  const central = new DataView(zip.buffer).getUint32(end + 16, true);
  const data = new Uint8Array(zip.length + 76);
  data.set(zip.subarray(0, end));
  data.set(zip.subarray(end), end + 76);
  const view = new DataView(data.buffer);
  view.setUint32(central + 20, 0xffffffff, true);
  view.setUint32(end, 0x06064b50, true);
  view.setUint32(end + 4, 44, true);
  view.setUint32(end + 24, 1, true);
  view.setUint32(end + 32, 1, true);
  view.setUint32(end + 40, end - central, true);
  view.setUint32(end + 48, central, true);
  view.setUint32(end + 56, 0x07064b50, true);
  view.setUint32(end + 64, end, true);
  view.setUint32(end + 72, 1, true);
  view.setUint16(end + 76 + 8, 0xffff, true);
  view.setUint16(end + 76 + 10, 0xffff, true);
  view.setUint32(end + 76 + 16, 0xffffffff, true);

  const dir = mkdtempSync(join(tmpdir(), 'aioffice-zip64-'));
  try {
    const file = join(dir, 'malformed.hwpx');
    writeFileSync(file, data);
    const script = fileURLToPath(new URL('../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/extract_text.js', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--format', 'text', file], {
      timeout: 5000, encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0, 'malformed input must be rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SKILL = '../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/';
const scriptPath = (p) => fileURLToPath(new URL(SKILL + p, import.meta.url));
const { zipSync, unzipSync, strToU8 } = await import(new URL(SKILL + 'vendor/fflate/index.mjs', import.meta.url));
const { safeUnzip } = await import(new URL(SKILL + 'lib/safe-unzip.js', import.meta.url));
const stub = new Uint8Array(readFileSync(scriptPath('templates/hancom_native_stub.hwpx')));

// Overwrite the declared uncompressed size of the first central directory entry.
function setDeclaredSize(zip, size) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  const central = view.getUint32(end + 16, true);
  view.setUint32(central + 24, size, true);
  return zip;
}

function stubWith(name, text) {
  const files = unzipSync(stub);
  files[name] = strToU8(text);
  return zipSync(files);
}

const DOCTYPE_XML = '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "xx">]><a>&x;</a>';

test('bundled stub passes unchanged', () => {
  const files = safeUnzip(stub);
  const ref = unzipSync(stub);
  assert.deepEqual(Object.keys(files), Object.keys(ref));
  for (const name of Object.keys(ref)) assert.deepEqual(Buffer.from(files[name]), Buffer.from(ref[name]), name);
  const korean = { 'BinData/한글.txt': strToU8('가'.repeat(5000)) };
  assert.deepEqual(Buffer.from(safeUnzip(zipSync(korean))['BinData/한글.txt']), Buffer.from(korean['BinData/한글.txt']));
});

test('fake huge originalSize is rejected before inflating', () => {
  const zip = setDeclaredSize(zipSync({ 'a.xml': strToU8('<a/>') }), 0xf0000000);
  assert.throws(() => safeUnzip(zip), /too large/);
});

test('declared size that does not match the data is rejected', () => {
  const data = strToU8('<a>' + 'x'.repeat(100) + '</a>');
  for (const level of [0, 6]) {
    const zip = setDeclaredSize(zipSync({ 'a.xml': [data, { level }] }), data.length + 7);
    assert.throws(() => safeUnzip(zip), /size mismatch/);
  }
});

test('under-declared deflate size is rejected without inflating the whole stream', () => {
  // fflate clamps output to the declared size, so this used to pass with truncated data.
  const small = zipSync({ 'a.xml': [strToU8('<a>' + 'x'.repeat(4000) + '</a>'), { level: 6 }] });
  assert.throws(() => safeUnzip(setDeclaredSize(small, 100)), /size mismatch/);
  const bomb = zipSync({ 'BinData/bomb.bin': [new Uint8Array(64 * 1024 * 1024), { level: 9 }] });
  const t = Date.now();
  assert.throws(() => safeUnzip(setDeclaredSize(bomb, 16)), /size mismatch/);
  assert.ok(Date.now() - t < 1000, 'must stop at the declared size');
});

test('central directory entries sharing one data blob are rejected', () => {
  const zip = zipSync({ 'BinData/a.bin': [new Uint8Array(1000).map((_, i) => (i * 7919) % 251), { level: 0 }] });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  const central = view.getUint32(end + 16, true);
  const entry = zip.subarray(central, end);
  const copies = 3;
  const out = new Uint8Array(central + entry.length * copies + 22);
  out.set(zip.subarray(0, central));
  for (let i = 0; i < copies; i++) out.set(entry, central + i * entry.length);
  out.set(zip.subarray(end), central + entry.length * copies);
  const ov = new DataView(out.buffer);
  const oe = out.length - 22;
  ov.setUint16(oe + 8, copies, true);
  ov.setUint16(oe + 10, copies, true);
  ov.setUint32(oe + 12, entry.length * copies, true);
  assert.throws(() => safeUnzip(out), /overlap/);
});

test('too many entries is rejected', () => {
  const files = {};
  for (let i = 0; i <= 10000; i++) files[`e${i}`] = new Uint8Array(0);
  assert.throws(() => safeUnzip(zipSync(files)), /too many entries/);
  delete files.e0;
  assert.equal(Object.keys(safeUnzip(zipSync(files))).length, 10000);
});

test('high compression ratio over 1MiB is rejected', () => {
  const zip = zipSync({ 'bin/zeros': new Uint8Array(2 * 1024 * 1024) });
  assert.throws(() => safeUnzip(zip), /compression ratio/);
});

test('DOCTYPE and ENTITY in XML entries are rejected, comments are ignored', () => {
  assert.throws(() => safeUnzip(zipSync({ 'Contents/section0.xml': strToU8(DOCTYPE_XML) })), /DOCTYPE/);
  const hidden = '<?xml version="1.0"?><!-- ' + 'pad '.repeat(1000) + ' --><!doctype a><a/>';
  assert.throws(() => safeUnzip(zipSync({ 'Contents/content.hpf': strToU8(hidden) })), /DOCTYPE/);
  assert.throws(() => safeUnzip(zipSync({ 'a.xml': strToU8('<a><!ENTITY x "y"></a>') })), /DOCTYPE/);
  const commented = '<?xml version="1.0"?><!-- <!DOCTYPE a> --><a/>';
  assert.doesNotThrow(() => safeUnzip(zipSync({ 'a.xml': strToU8(commented) })));
});

test('CLI entry points reject a DOCTYPE section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aioffice-untrusted-'));
  try {
    const file = join(dir, 'evil.hwpx');
    writeFileSync(file, stubWith('Contents/section0.xml', DOCTYPE_XML));
    const run = (script, args, input) => spawnSync(process.execPath, [scriptPath(script), ...args], {
      input, timeout: 10000, encoding: 'utf8',
    });

    const edit = run('hwpx-edit.js', [], JSON.stringify({ path: file, operations: [] }));
    assert.notEqual(edit.status, 0);
    assert.match(edit.stdout, /"ok": false[\s\S]*DOCTYPE/);

    const extract = run('extract_text.js', ['--format', 'text', file]);
    assert.notEqual(extract.status, 0);
    assert.match(extract.stderr, /DOCTYPE/);

    const fonts = run('font-inventory.js', [file]);
    assert.notEqual(fonts.status, 0);
    assert.match(fonts.stdout + fonts.stderr, /DOCTYPE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

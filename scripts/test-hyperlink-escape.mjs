import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const skillScripts = fileURLToPath(new URL('../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/', import.meta.url));
const { unzipSync, strFromU8 } = await import(pathToFileURL(join(skillScripts, 'vendor/fflate/index.mjs')).href);
const { escapeHyperlinkCommand, buildHyperlinkCommand } = await import(pathToFileURL(join(skillScripts, 'cell-patch.js')).href);

const URL_IN = 'https://ex.com/a?b=1;c#d';
const COMMAND = 'https\\://ex.com/a\\?b=1\\;c\\#d;1;0;0;';

test('HWP field command escapes Hancom separators once', () => {
  assert.equal(buildHyperlinkCommand(URL_IN), COMMAND);
  // Single pass: an already escaped colon is not escaped into "\\\:".
  assert.equal(escapeHyperlinkCommand('a\\:b'), 'a\\\\\\:b');
  assert.equal(escapeHyperlinkCommand('https://plain.example/x'), 'https\\://plain.example/x');
});

test('HWPX insert_hyperlink writes escaped Command and raw Path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aioffice-hlink-'));
  try {
    const out = join(dir, 'out.hwpx');
    const run = spawnSync(process.execPath, [join(skillScripts, 'hwpx-edit.js')], {
      input: JSON.stringify({
        path: join(skillScripts, 'templates/hancom_native_stub.hwpx'),
        output: out,
        operations: [{ type: 'insert_hyperlink', url: URL_IN + '&e=2', text: 'link' }],
      }),
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const files = unzipSync(readFileSync(out));
    const xml = Object.keys(files)
      .filter((n) => /^Contents\/section\d+\.xml$/.test(n))
      .map((n) => strFromU8(files[n]))
      .join('');
    const param = (name) => xml.match(new RegExp(`<hp:stringParam name="${name}">([^<]*)<`))[1];
    assert.equal(param('Command'), 'https\\://ex.com/a\\?b=1\\;c\\#d&amp;e=2;1;0;0;');
    assert.equal(param('Path'), 'https://ex.com/a?b=1;c#d&amp;e=2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

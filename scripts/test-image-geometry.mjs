import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';

const skillScripts = fileURLToPath(new URL('../plugins/aioffice-hwp/skills/aioffice-hwp/scripts/', import.meta.url));
const { unzipSync, zipSync, strFromU8, strToU8 } = await import(pathToFileURL(join(skillScripts, 'vendor/fflate/index.mjs')).href);
const STUB = join(skillScripts, 'templates/hancom_native_stub.hwpx');

// Minimal valid PNG (grey, 8-bit). `dpi` adds a pHYs chunk.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  let c = 0xffffffff;
  for (const b of td) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function png(w, h, dpi) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (dpi) {
    const p = Buffer.alloc(9); const ppm = Math.round(dpi / 0.0254);
    p.writeUInt32BE(ppm, 0); p.writeUInt32BE(ppm, 4); p[8] = 1;
    parts.push(chunk('pHYs', p));
  }
  parts.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
const gif = (w, h) => { const b = Buffer.alloc(13); b.write('GIF89a', 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };

function edit(dir, input, operations, name) {
  const output = join(dir, name);
  const run = spawnSync(process.execPath, [join(skillScripts, 'hwpx-edit.js')], {
    input: JSON.stringify({ path: input, output, operations }), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const files = unzipSync(readFileSync(output));
  const xml = strFromU8(files['Contents/section0.xml']);
  return { output, pics: xml.match(/<hp:pic\b[\s\S]*?<\/hp:pic>/g) || [] };
}
const num = (pic, re) => pic.match(re).slice(1).map(Number);
function geom(pic) {
  return {
    org: num(pic, /<hp:orgSz width="(\d+)" height="(\d+)"/),
    cur: num(pic, /<hp:curSz width="(\d+)" height="(\d+)"/),
    sz: num(pic, /<hp:sz width="(\d+)"[^>]*height="(\d+)"/),
    dim: num(pic, /<hp:imgDim dimwidth="(\d+)" dimheight="(\d+)"/),
    clip: num(pic, /<hp:imgClip left="0" right="(\d+)" top="0" bottom="(\d+)"/),
    rect: num(pic, /<hc:pt2 x="(\d+)" y="(\d+)"/),
    sca: num(pic, /<hc:scaMatrix e1="([\d.]+)"[^>]*e5="([\d.]+)"/),
    ref: pic.match(/binaryItemIDRef="([^"]+)"/)[1],
  };
}
function assertNatural(g, w, h) {
  for (const k of ['org', 'dim', 'clip', 'rect']) assert.deepEqual(g[k], [w * 75, h * 75], k);
  assert.deepEqual(g.cur, g.sz);
  assert.ok(Math.abs(g.sca[0] - g.cur[0] / g.org[0]) < 1e-5 && Math.abs(g.sca[1] - g.cur[1] / g.org[1]) < 1e-5, 'scaMatrix');
}

test('insert sets px*75 natural size, replace refits width-kept height-by-aspect', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aioffice-imggeom-'));
  try {
    writeFileSync(join(dir, 'sq.png'), png(40, 40));
    writeFileSync(join(dir, 'wide.png'), png(80, 40));
    writeFileSync(join(dir, 'wide300.png'), png(120, 60, 300));
    writeFileSync(join(dir, 'tall.gif'), gif(30, 60));

    // 1st insert = fallback template, 2nd = clone of the first; 3rd shares no binary.
    const a = edit(dir, STUB, [
      { type: 'insert_image', source: join(dir, 'sq.png'), width_mm: 50, height_mm: 50 },
      { type: 'insert_image', source: join(dir, 'sq.png'), width: 10000, height: 10000 },
      { type: 'insert_image', source: join(dir, 'tall.gif'), width: 6000 },
    ], 'a.hwpx');
    assert.equal(a.pics.length, 3);
    const [p1, p2, p3] = a.pics.map(geom);
    assertNatural(p1, 40, 40);
    assertNatural(p2, 40, 40);
    assert.deepEqual(p2.cur, [10000, 10000]);
    assertNatural(p3, 30, 60);
    assert.deepEqual(p3.cur, [6000, 12000], 'missing height follows GIF aspect');

    // Point pic 2 at image1 too, so one binary is shown twice at different sizes.
    const files = unzipSync(readFileSync(a.output));
    const sec = strFromU8(files['Contents/section0.xml']);
    files['Contents/section0.xml'] = strToU8(sec.replace(`binaryItemIDRef="${p2.ref}"`, `binaryItemIDRef="${p1.ref}"`));
    const shared = join(dir, 'shared.hwpx');
    writeFileSync(shared, zipSync(files));

    // Square -> 2:1. Both pics bound to image1 are refit; the GIF pic is untouched.
    const b = edit(dir, shared, [{ type: 'replace_image', target: p1.ref, source: join(dir, 'wide.png') }], 'b.hwpx');
    const [q1, q2, q3] = b.pics.map(geom);
    for (const [before, after] of [[p1, q1], [p2, q2]]) {
      assert.equal(after.ref, p1.ref);
      assertNatural(after, 80, 40);
      assert.equal(after.cur[0], before.cur[0], 'width kept');
      assert.equal(after.cur[1], Math.round(before.cur[0] / 2), 'height halves');
    }
    assert.deepEqual(q3, p3);

    // pHYs 300 DPI: imgDim is still px*75 (DPI ignored), no crop.
    const c = edit(dir, b.output, [{ type: 'replace_image', target: p1.ref, source: join(dir, 'wide300.png') }], 'c.hwpx');
    assertNatural(geom(c.pics[0]), 120, 60);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('derived image size never exceeds the page body (insert and replace)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aioffice-imgbody-'));
  try {
    // Stub A4 body: 59528-8504-8504 = 48520 wide, 84186-5668-4252-4252-4252 = 65762 tall.
    const BODY_W = 48520, BODY_H = 65762;
    writeFileSync(join(dir, 'tall.gif'), gif(30, 90));
    writeFileSync(join(dir, 'wide.gif'), gif(90, 30));
    const a = edit(dir, STUB, [
      { type: 'insert_image', source: join(dir, 'tall.gif') },
      { type: 'insert_image', source: join(dir, 'tall.gif'), width_mm: 150 },
      { type: 'insert_image', source: join(dir, 'wide.gif'), width_mm: 150 },
      { type: 'insert_image', source: join(dir, 'tall.gif'), width: 30000, height: 90000 },
    ], 'a.hwpx');
    const [p1, p2, p3, p4] = a.pics.map(geom);
    for (const g of [p1, p2]) {
      assertNatural(g, 30, 90);
      assert.equal(g.cur[1], BODY_H, 'tall image clamped to body height');
      assert.ok(Math.abs(g.cur[0] * 3 - g.cur[1]) <= 3, 'aspect kept');
    }
    assert.equal(p3.cur[0], 42519, 'fits already: untouched');
    assert.deepEqual(p4.cur, [30000, 90000], 'explicit width+height is respected');

    // Wide 150mm pic refit to a 1:3 bitmap: height capped at the body, aspect kept.
    const b = edit(dir, a.output, [{ type: 'replace_image', target: p3.ref, source: join(dir, 'tall.gif') }], 'b.hwpx');
    const q3 = geom(b.pics[2]);
    assertNatural(q3, 30, 90);
    assert.ok(q3.cur[1] <= BODY_H && q3.cur[0] <= BODY_W, `fits body: ${q3.cur}`);
    assert.ok(Math.abs(q3.cur[0] * 3 - q3.cur[1]) <= 3, 'aspect kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// safeUnzip: unzipSync for user-supplied .hwpx bytes, with zip bomb and XML
// entity limits. Limits follow CoreDotToday/coredotdocs zipgate.py (Apache-2.0),
// reimplemented here. Bundled templates are trusted and keep using fflate unzipSync.
// The central directory is walked here instead of fflate unzipSync because fflate
// inflates a deflate stream to its end even when the header under-declares the
// size (CPU bomb, silent truncation). zlib maxOutputLength stops at the declared size.
import { inflateRawSync } from 'node:zlib';
import { strFromU8 } from '../vendor/fflate/index.mjs';

const MiB = 1024 * 1024;
export const LIMITS = {
  maxEntries: 10000,
  maxEntryBytes: 128 * MiB,
  maxTotalBytes: 256 * MiB,
  maxRatio: 200, // only checked for entries over ratioFloor
  ratioFloor: MiB,
};

const XML_NAME = /\.(xml|hpf|rels|opf)$/i;
const DECL = /<!\s*(DOCTYPE|ENTITY)/i;
const MAX32 = 0xffffffff;

export function safeUnzip(bytes, limits = LIMITS) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u16 = (o) => v.getUint16(o, true);
  const u32 = (o) => v.getUint32(o, true);
  const u64 = (o) => u32(o) + u32(o + 4) * 2 ** 32;

  let e = d.length - 22;
  for (;; --e) {
    if (e < 0 || d.length - e > 65557) throw new Error('not a zip file (no end of central directory)');
    if (u32(e) === 0x06054b50) break;
  }
  let count = u16(e + 10);
  let o = u32(e + 16);
  if (e >= 20 && u32(e - 20) === 0x07064b50) {
    const ze = u64(e - 12);
    if (u32(ze) === 0x06064b50) { count = u64(ze + 32); o = u64(ze + 48); }
  }
  if (count > limits.maxEntries) throw new Error(`zip has too many entries (> ${limits.maxEntries})`);

  const files = {};
  let total = 0;
  let packed = 0;
  for (let i = 0; i < count; i++) {
    if (u32(o) !== 0x02014b50) throw new Error('malformed zip central directory');
    const method = u16(o + 10), nl = u16(o + 28), xl = u16(o + 30);
    const name = strFromU8(d.subarray(o + 46, o + 46 + nl), !(u16(o + 8) & 2048));
    let size = u32(o + 20), originalSize = u32(o + 24), off = u32(o + 42);
    if (size === MAX32 || originalSize === MAX32 || off === MAX32) {
      // zip64 extra field (id 1) holds only the fields set to 0xffffffff, in this order.
      let x = o + 46 + nl;
      while (x + 4 <= o + 46 + nl + xl && u16(x) !== 1) x += 4 + u16(x + 2);
      if (x + 4 > o + 46 + nl + xl) throw new Error(`zip64 entry without zip64 extra field: ${name}`);
      x += 4;
      if (originalSize === MAX32) { originalSize = u64(x); x += 8; }
      if (size === MAX32) { size = u64(x); x += 8; }
      if (off === MAX32) off = u64(x);
    }
    o += 46 + nl + xl + u16(o + 32);

    if (originalSize > limits.maxEntryBytes) throw new Error(`zip entry too large (${originalSize} B): ${name}`);
    if (originalSize > limits.ratioFloor && (!size || originalSize / size > limits.maxRatio)) {
      throw new Error(`zip entry has suspicious compression ratio: ${name}`);
    }
    total += originalSize;
    if (total > limits.maxTotalBytes) throw new Error(`zip expands too large (> ${limits.maxTotalBytes} B)`);
    // Entries sharing one data blob would multiply inflate work without growing the file.
    packed += size;
    if (packed > d.length) throw new Error(`zip entries overlap or exceed the file: ${name}`);

    if (u32(off) !== 0x04034b50) throw new Error(`malformed zip local header: ${name}`);
    const start = off + 30 + u16(off + 26) + u16(off + 28);
    const raw = d.subarray(start, start + size);
    if (raw.length !== size) throw new Error(`zip entry is truncated: ${name}`);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      try {
        const out = inflateRawSync(raw, { maxOutputLength: Math.max(1, originalSize) });
        data = new Uint8Array(out.buffer, out.byteOffset, out.length);
      } catch (err) {
        if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`zip entry size mismatch (inflates past declared ${originalSize} B): ${name}`);
        throw new Error(`zip entry is corrupt (${err.message}): ${name}`);
      }
    } else throw new Error(`unsupported zip compression method ${method}: ${name}`);
    if (data.length !== originalSize) throw new Error(`zip entry size mismatch (declared ${originalSize}, actual ${data.length}): ${name}`);
    if (XML_NAME.test(name) && DECL.test(strFromU8(data, true).replace(/<!--[\s\S]*?-->/g, ''))) {
      throw new Error(`XML with DOCTYPE/ENTITY declaration is not accepted: ${name}`);
    }
    files[name] = data;
  }
  return files;
}

// cell-patch.js — Hancom-Docs-compatible in-place table cell editor.
//
// Why this exists: rhwp's exportHwp() emits a CFB layout (Sh33tJ5 marker,
// reordered streams) that Hancom Docs' strict cloud parser rejects with
// "문서를 열 수 없습니다." Hancom Office Desktop accepts it; Hancom Docs
// does not. Every roundtrip through rhwp.exportHwp() — including create.js
// loading an existing file just to write one cell — picks up that
// fingerprint and breaks the file for the cloud.
//
// Two-path strategy:
//
//   (1) In-place sector patch (default). Parse just enough header + FAT to
//       find the target Section's sector chain, inflate, walk HWP records,
//       patch PARA_HEADER.text_count + replace/insert PARA_TEXT, deflate
//       at higher levels until the result fits in the existing chain,
//       write back into the same sector offsets. Only the directory
//       entry's size field is changed outside that chain. Every other
//       byte stays identical to the input — no Sh33tJ5 marker added.
//
//   (2) sheetjs CFB fallback. Used only when the patched payload grows
//       past the existing chain capacity (e.g. a one-line cell becoming
//       a paragraph). sheetjs's CFB.write auto-injects a Sh33tJ5 marker
//       stream, but that does NOT block Hancom Docs — the 1.4.0 raw-
//       patch shipped this exact code and the verified KEIT form opens
//       cleanly in the cloud editor. We just don't take this path by
//       default because (1) preserves more bytes against the original.
//
// What Hancom Docs rejects is rhwp.exportHwp()'s combination of stream
// reordering, FAT layout changes, and record-framing differences, not
// the Sh33tJ5 marker by itself. Either path here is safe; (1) is just
// byte-cleaner.
//
// rhwp is still useful for *inspecting* coordinates (which paragraph holds
// which control, which cell sits at (row, col)). We only avoid it on the
// emit side.
//
// HWP 5.0 record header (LE u32): TagID(10) | Level(10) | Size(12)
//   When Size == 0xFFF, the real size follows as a separate u32.
// Relevant tags:
//   0x42 PARA_HEADER       data[0..3] = text_count (high bit = paragraph
//                          flag; preserve it, only touch low 31 bits)
//   0x43 PARA_TEXT         body = UTF-16LE chars (HWP terminator is 0x000D)
//   0x44 PARA_CHAR_SHAPE   pairs of (charPos u32, shapeId u32)
//   0x47 CTRL_HEADER       a control inside a paragraph
//   0x48 LIST_HEADER       starts a table cell (level 2 when inside table)

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync, deflateRawSync, constants } from 'node:zlib';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const TAG_PARA_HEADER = 0x42;
const TAG_PARA_TEXT = 0x43;
const TAG_PARA_CHAR_SHAPE = 0x44;
const TAG_CTRL_HEADER = 0x47;
const TAG_LIST_HEADER = 0x48;

const PARA_TEXT_EOP = '\r'; // HWP paragraph terminator char (U+000D)

// CFB sentinel sector values
const ENDOFCHAIN = -2;   // 0xFFFFFFFE
const FREESECT = -1;     // 0xFFFFFFFF

// ── HWP record walk ───────────────────────────────────────────────────────

function* walkRecords(raw) {
  let p = 0;
  let idx = 0;
  while (p + 4 <= raw.length) {
    const headOff = p;
    const hdr = raw.readUInt32LE(p);
    p += 4;
    const tag = hdr & 0x3FF;
    const level = (hdr >> 10) & 0x3FF;
    let size = (hdr >> 20) & 0xFFF;
    let ext = false;
    if (size === 0xFFF) {
      size = raw.readUInt32LE(p);
      p += 4;
      ext = true;
    }
    const dataOff = p;
    yield { idx, tag, level, size, headOff, dataOff, ext };
    p += size;
    idx++;
  }
}

function parseRecords(raw) {
  const out = [];
  for (const r of walkRecords(raw)) out.push(r);
  return out;
}

// ── HWP cell location ─────────────────────────────────────────────────────
//
// Given (sectionParaIdx, controlIdx, cellIndex) and the record array for a
// Section stream, find the cell paragraph record cluster. Returns:
//   { listHeaderRec, paraHeaderRec, paraTextRec | null, charShapeRec | null }
//
// We use cellIndex (flat row-major index, the same value rhwp's getCellInfo
// returns) rather than (row, col) because the LIST_HEADER body layout in
// HWP 5.0 is not fully stable — different tables encode cell metadata at
// different offsets, and parsing each variant in pure JS is fragile.
// rhwp's WASM parses them correctly, so we let it tell us the index and
// then count LIST_HEADERs at the raw level.

function locateCell(records, sectionParaIdx, controlIdx, cellIndex) {
  // Find the target paragraph header (level 0)
  let para = -1;
  let paraStart = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) {
      para++;
      if (para === sectionParaIdx) { paraStart = i; break; }
    }
  }
  if (paraStart < 0) throw new Error(`paragraph ${sectionParaIdx} not found`);

  // Find the target control inside this paragraph
  let ctrl = -1;
  let tableCtrlIdx = -1;
  for (let i = paraStart + 1; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) break; // next paragraph
    if (r.tag === TAG_CTRL_HEADER && r.level === 1) {
      ctrl++;
      if (ctrl === controlIdx) { tableCtrlIdx = i; break; }
    }
  }
  if (tableCtrlIdx < 0) throw new Error(`control ${controlIdx} not found in paragraph ${sectionParaIdx}`);

  // Walk forward looking for LIST_HEADER (level 2) cell starts.
  // The table ends when we hit a level-0 PARA_HEADER (next paragraph) or a
  // level-1 CTRL_HEADER (next control on the same paragraph).
  let cellStartRec = -1;
  let listCount = 0;
  for (let i = tableCtrlIdx + 1; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) break;
    if (r.tag === TAG_CTRL_HEADER && r.level === 1) break;
    if (r.tag !== TAG_LIST_HEADER || r.level !== 2) continue;
    if (listCount === cellIndex) { cellStartRec = i; break; }
    listCount++;
  }
  if (cellStartRec < 0) throw new Error(`cell index ${cellIndex} not found in table at paragraph ${sectionParaIdx} control ${controlIdx} (only ${listCount} cells seen)`);

  // Inside this cell: first PARA_HEADER right after LIST_HEADER (level 2).
  let paraHeaderRec = -1;
  for (let i = cellStartRec + 1; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 2) { paraHeaderRec = i; break; }
    if (r.tag === TAG_LIST_HEADER && r.level === 2) break; // next cell
  }
  if (paraHeaderRec < 0) throw new Error('cell paragraph header not found');

  // Optional PARA_TEXT and PARA_CHAR_SHAPE that follow (level 3).
  let paraTextRec = null, charShapeRec = null;
  for (let i = paraHeaderRec + 1; i < records.length; i++) {
    const r = records[i];
    if (r.level <= 2) break; // back to cell-level
    if (r.tag === TAG_PARA_TEXT && paraTextRec === null) paraTextRec = i;
    else if (r.tag === TAG_PARA_CHAR_SHAPE && charShapeRec === null) charShapeRec = i;
  }
  return { listHeaderRec: cellStartRec, paraHeaderRec, paraTextRec, charShapeRec };
}

// ── HWP cell patching ─────────────────────────────────────────────────────
//
// applyCellText returns the new raw Buffer with one cell's text replaced.
// We update PARA_HEADER.text_count and replace (or insert) the PARA_TEXT
// record. text_count counts the EOP terminator, so 5 chars of text → 6.

function makeParaTextRecord(text) {
  const body = Buffer.from(text + PARA_TEXT_EOP, 'utf16le');
  const size = body.length;
  // JS bitwise ops use i32. (size << 20) goes negative for size >= 2048,
  // and (0xFFF << 20) is always negative. >>> 0 reinterprets as u32 for
  // writeUInt32LE.
  if (size > 0xFFE) {
    // Extended size encoding: header size field = 0xFFF then u32 size.
    const head = Buffer.alloc(8);
    head.writeUInt32LE(((0xFFF << 20) | (3 << 10) | TAG_PARA_TEXT) >>> 0, 0);
    head.writeUInt32LE(size, 4);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(((size << 20) | (3 << 10) | TAG_PARA_TEXT) >>> 0, 0);
  return Buffer.concat([head, body]);
}

function applyCellText(raw, records, sectionParaIdx, controlIdx, cellIndex, text) {
  const loc = locateCell(records, sectionParaIdx, controlIdx, cellIndex);
  const newTextCount = text.length + 1; // + EOP
  const paraHeader = records[loc.paraHeaderRec];
  // Update PARA_HEADER.text_count, preserving the high-bit flag.
  const oldCount = raw.readUInt32LE(paraHeader.dataOff);
  const newCount = ((oldCount & 0x80000000) >>> 0) | (newTextCount >>> 0);
  raw.writeUInt32LE(newCount >>> 0, paraHeader.dataOff);

  const newRecord = makeParaTextRecord(text);

  if (loc.paraTextRec !== null) {
    // Replace existing PARA_TEXT record.
    const old = records[loc.paraTextRec];
    const oldLen = (old.ext ? 8 : 4) + old.size;
    return Buffer.concat([
      raw.slice(0, old.headOff),
      newRecord,
      raw.slice(old.headOff + oldLen),
    ]);
  }
  // Insert PARA_TEXT between PARA_HEADER (data ends at dataOff+size) and the
  // next record (PARA_CHAR_SHAPE if present, else whatever's next).
  const insertAt = paraHeader.dataOff + paraHeader.size;
  return Buffer.concat([
    raw.slice(0, insertAt),
    newRecord,
    raw.slice(insertAt),
  ]);
}

// ── CFB layout (minimal, in-place) ────────────────────────────────────────
//
// We parse only what's needed to (a) find each Section stream's chain of
// regular-FAT sectors and (b) locate the directory entry so we can update
// its size field. We never re-emit; the original buffer is mutated.
//
// HWP 5.0 .hwp files always use the regular FAT for Section streams because
// they're far larger than the mini-stream cutoff (4096 bytes). If a future
// edge case puts one in the mini-stream we throw with a clear message.

function parseCfbHeader(buf) {
  if (buf.length < 512 || buf[0] !== 0xD0 || buf[1] !== 0xCF || buf[2] !== 0x11 || buf[3] !== 0xE0) {
    throw new Error('not a CFB (Compound File Binary) container');
  }
  const mver = buf.readUInt16LE(0x1A);
  const sectorShift = buf.readUInt16LE(0x1E);
  const ssz = 1 << sectorShift;
  if (mver !== 3 && mver !== 4) throw new Error(`unsupported CFB major version: ${mver}`);
  if ((mver === 3 && ssz !== 512) || (mver === 4 && ssz !== 4096)) {
    throw new Error(`CFB sector size ${ssz} inconsistent with version ${mver}`);
  }
  const miniSectorShift = buf.readUInt16LE(0x20);
  const mssz = 1 << miniSectorShift; // typically 64 bytes
  const dirStart = buf.readInt32LE(0x30);
  const minifatStart = buf.readInt32LE(0x3C);
  const numMinifat = buf.readInt32LE(0x40);
  const difatStart = buf.readInt32LE(0x44);
  const difatCount = buf.readInt32LE(0x48);

  // Collect FAT sector indices: first 109 are in the header, the rest live
  // in DIFAT sectors chained together.
  const fatAddrs = [];
  for (let i = 0; i < 109; i++) {
    const sec = buf.readInt32LE(0x4C + i * 4);
    if (sec === FREESECT) break;
    fatAddrs.push(sec);
  }
  let difatSec = difatStart;
  let guard = 0;
  while (difatSec >= 0 && difatSec !== ENDOFCHAIN && guard++ < difatCount + 1) {
    const off = (difatSec + 1) * ssz;
    const entriesPerSec = (ssz >>> 2) - 1; // last u32 chains to next DIFAT sec
    for (let i = 0; i < entriesPerSec; i++) {
      const sec = buf.readInt32LE(off + i * 4);
      if (sec === FREESECT) break;
      fatAddrs.push(sec);
    }
    difatSec = buf.readInt32LE(off + (ssz - 4));
  }
  return { mver, ssz, mssz, dirStart, fatAddrs, minifatStart, numMinifat };
}

// Read the entire mini-FAT as a flat array. Mini-FAT sectors themselves
// live in the regular FAT (we walk that chain from minifatStart), and each
// mini-FAT sector is the usual ssz bytes packed with i32 entries that point
// to the next mini-sector index in a mini-stream's chain.
function readMinifat(buf, fat, ssz, minifatStart) {
  if (minifatStart < 0 || minifatStart === ENDOFCHAIN) return new Int32Array(0);
  const minifatSectors = walkChain(fat, minifatStart);
  const entriesPerSec = ssz >>> 2;
  const minifat = new Int32Array(minifatSectors.length * entriesPerSec);
  for (let s = 0; s < minifatSectors.length; s++) {
    const off = (minifatSectors[s] + 1) * ssz;
    for (let i = 0; i < entriesPerSec; i++) {
      minifat[s * entriesPerSec + i] = buf.readInt32LE(off + i * 4);
    }
  }
  return minifat;
}

// Mini-stream content lives inside the root entry's regular-FAT chain.
// A mini-sector index addresses a 64-byte slot inside that chain: slot N
// is at offset (rootChain[N / slotsPerSec] + 1) * ssz + (N % slotsPerSec) * mssz.
function miniSectorFileOffset(miniIdx, rootChain, ssz, mssz) {
  const slotsPerSec = ssz / mssz;
  const regSecIdx = Math.floor(miniIdx / slotsPerSec);
  const inSec = miniIdx % slotsPerSec;
  if (regSecIdx >= rootChain.length) throw new Error(`mini-sector ${miniIdx} outside root chain (${rootChain.length} regular sectors)`);
  return (rootChain[regSecIdx] + 1) * ssz + inSec * mssz;
}

function readMiniChainBytes(buf, miniChain, rootChain, ssz, mssz, size) {
  const out = Buffer.alloc(size);
  let written = 0;
  for (const mIdx of miniChain) {
    if (written >= size) break;
    const off = miniSectorFileOffset(mIdx, rootChain, ssz, mssz);
    const take = Math.min(mssz, size - written);
    buf.copy(out, written, off, off + take);
    written += take;
  }
  return out;
}

// Mirror of writeChainBytes for mini-streams. The error message is kept
// in lock-step with the regular-chain version so patchCellsInPlace's
// fallback regex catches both overflow cases identically.
function writeMiniChainBytes(buf, miniChain, rootChain, ssz, mssz, data) {
  const capacity = miniChain.length * mssz;
  if (data.length > capacity) {
    throw new Error(`mini-stream of ${data.length} bytes does not fit in ${miniChain.length} mini-sectors (${capacity} bytes). exceeds sector chain capacity.`);
  }
  let written = 0;
  for (const mIdx of miniChain) {
    const off = miniSectorFileOffset(mIdx, rootChain, ssz, mssz);
    if (written >= data.length) {
      buf.fill(0, off, off + mssz);
      continue;
    }
    const take = Math.min(mssz, data.length - written);
    data.copy(buf, off, written, written + take);
    written += take;
    if (take < mssz) {
      buf.fill(0, off + take, off + mssz);
    }
  }
}

// Read the entire FAT as a flat array of i32 entries by concatenating every
// FAT sector in order. fat[i] = next sector after i (or ENDOFCHAIN, etc).
function readFat(buf, fatAddrs, ssz) {
  const entriesPerSec = ssz >>> 2;
  const fat = new Int32Array(fatAddrs.length * entriesPerSec);
  for (let s = 0; s < fatAddrs.length; s++) {
    const sec = fatAddrs[s];
    const off = (sec + 1) * ssz;
    for (let i = 0; i < entriesPerSec; i++) {
      fat[s * entriesPerSec + i] = buf.readInt32LE(off + i * 4);
    }
  }
  return fat;
}

// Walk a sector chain in the FAT, starting at `start`.
function walkChain(fat, start) {
  const chain = [];
  let cur = start;
  while (cur >= 0 && cur !== ENDOFCHAIN) {
    chain.push(cur);
    if (chain.length > fat.length) throw new Error('FAT chain longer than total sector count (cycle?)');
    cur = fat[cur];
  }
  return chain;
}

// Slice the file bytes that belong to a sector chain, taking `size` bytes
// from the front (the rest of the last sector is allocated slack).
function readChainBytes(buf, chain, ssz, size) {
  const out = Buffer.alloc(size);
  let written = 0;
  for (const sec of chain) {
    if (written >= size) break;
    const off = (sec + 1) * ssz;
    const take = Math.min(ssz, size - written);
    buf.copy(out, written, off, off + take);
    written += take;
  }
  return out;
}

// Write `data` into the sector chain in `buf`. Requires data.length <=
// chain.length * ssz. Pads the final sector with zeros so allocated slack
// is clean — this isn't strictly required by readers, which respect the
// size field, but matches the on-disk layout other CFB tools produce.
function writeChainBytes(buf, chain, ssz, data) {
  if (data.length > chain.length * ssz) {
    throw new Error(`stream of ${data.length} bytes does not fit in ${chain.length} sectors (${chain.length * ssz} bytes). In-place patch cannot expand sector chains.`);
  }
  let written = 0;
  for (const sec of chain) {
    const off = (sec + 1) * ssz;
    if (written >= data.length) {
      buf.fill(0, off, off + ssz);
      continue;
    }
    const take = Math.min(ssz, data.length - written);
    data.copy(buf, off, written, written + take);
    written += take;
    if (take < ssz) {
      // Last data-bearing sector: zero out the slack.
      buf.fill(0, off + take, off + ssz);
    }
  }
}

// ── Sector chain expansion (Phase 3) ─────────────────────────────────────
//
// allocateAndExtendChain grows an existing FAT sector chain by N sectors
// by appending fresh sectors at the end of the file buffer and threading
// them onto the tail of the chain via FAT updates.
//
// Returns { buf, fat, chain }:
//   - buf : new Buffer (length grew by N * ssz, plus the new FAT sector
//           if we needed to allocate one)
//   - fat : same Int32Array reference, mutated entries written; may be a
//           new (longer) Int32Array if a new FAT sector was required
//   - chain : the original chain with the new sector indices appended
//
// The original buf/fat are NOT mutated — caller must take the return
// values. (We can't grow Buffer in place; Int32Array we could mutate but
// the symmetric API is simpler.)
//
// FAT capacity: each FAT sector holds ssz/4 entries (128 for v3). If the
// chain extension needs sector indices past the current FAT capacity, we
// allocate a new FAT sector. That itself is a new sector in the file;
// the DIFAT (header slots 0x4C..0xFF, 109 entries) registers it. Going
// past 109 FAT sectors requires DIFAT chain extension — we don't
// implement that yet and throw with a clear message. HWP forms are tiny
// enough that 109 FAT sectors (= 55MB of streams at ssz=512) is well
// beyond any real document.
function writeFatEntry(buf, ssz, fatAddrs, secIdx, value) {
  const entriesPerSec = ssz >>> 2;
  const fatSecIdx = Math.floor(secIdx / entriesPerSec);
  const offsetInSec = secIdx % entriesPerSec;
  if (fatSecIdx >= fatAddrs.length) {
    throw new Error(`writeFatEntry: sector ${secIdx} outside current FAT capacity (${fatAddrs.length} FAT sectors); call expandFatCapacity first`);
  }
  const fileOff = (fatAddrs[fatSecIdx] + 1) * ssz + offsetInSec * 4;
  buf.writeInt32LE(value, fileOff);
}

// Append a fresh empty sector to the end of buf. Returns { buf, newSecIdx }.
// The new sector's bytes are zero-initialized. FAT entry is NOT touched —
// caller is responsible for marking it (ENDOFCHAIN for a fresh tail,
// FATSECT for a new FAT sector, etc).
function appendBlankSector(buf, ssz) {
  if (buf.length % ssz !== 0) {
    throw new Error(`buf length ${buf.length} is not a multiple of sector size ${ssz}`);
  }
  const newSecIdx = (buf.length / ssz) - 1; // header sits at -1, first sector at 0
  const newBuf = Buffer.alloc(buf.length + ssz);
  buf.copy(newBuf);
  return { buf: newBuf, newSecIdx };
}

// Ensure the FAT can address at least `requiredCapacity` sectors. Grows
// the FAT by allocating additional FAT sectors at the end of the file
// when needed, registers them in the header's DIFAT slots, and extends
// the in-memory `fat` Int32Array.
function expandFatCapacity(buf, ssz, fat, fatAddrs, requiredCapacity) {
  const entriesPerSec = ssz >>> 2;
  while (fat.length < requiredCapacity) {
    if (fatAddrs.length >= 109) {
      throw new Error('FAT capacity exhausted: DIFAT chain extension beyond 109 slots not yet implemented (file is unusually large for an HWP document)');
    }
    // Allocate a new sector that will hold the next FAT page.
    let result = appendBlankSector(buf, ssz);
    buf = result.buf;
    const newFatSecIdx = result.newSecIdx;
    // Initialize all entries to FREESECT, then mark this sector's own
    // entry as FATSECT.
    const newFatSecOff = (newFatSecIdx + 1) * ssz;
    for (let i = 0; i < entriesPerSec; i++) {
      buf.writeInt32LE(FREESECT, newFatSecOff + i * 4);
    }
    // Extend the in-memory fat. Old fat[0..fat.length] preserved; new
    // entries FREESECT except newFatSecIdx which is FATSECT (-3).
    const oldLen = fat.length;
    const newFat = new Int32Array(oldLen + entriesPerSec);
    newFat.set(fat);
    for (let i = oldLen; i < newFat.length; i++) newFat[i] = FREESECT;
    newFat[newFatSecIdx] = -3; // FATSECT
    // The on-disk entry for newFatSecIdx (now FATSECT) lives in *this* new
    // FAT sector; write it accordingly.
    const idxInNewFat = newFatSecIdx - oldLen;
    buf.writeInt32LE(-3, newFatSecOff + idxInNewFat * 4);
    // Register in DIFAT slot (header 0x4C + slot*4 for slots 0..108).
    buf.writeInt32LE(newFatSecIdx, 0x4C + fatAddrs.length * 4);
    fatAddrs.push(newFatSecIdx);
    // Update the FAT-sector count field (header 0x2C, u32 little-endian).
    buf.writeUInt32LE(fatAddrs.length, 0x2C);
    fat = newFat;
  }
  return { buf, fat };
}

// Extend `chain` (a sector-index array) by `additionalSectors` new
// sectors. Returns { buf, fat, chain } as described above.
function extendFatChain(buf, ssz, fat, fatAddrs, chain, additionalSectors) {
  if (additionalSectors <= 0) return { buf, fat, chain };
  let currentBuf = buf;
  let currentFat = fat;
  let lastSec = chain[chain.length - 1];
  const newChain = [...chain];
  for (let i = 0; i < additionalSectors; i++) {
    // Make sure FAT can index one more sector beyond what we're about to
    // allocate. The new sector will sit at idx = (currentBuf.length/ssz)-1
    // AFTER appendBlankSector, so we need capacity for that idx + 1.
    const projectedNewSecIdx = currentBuf.length / ssz - 1 + 1; // +1 for the slot we'll fill
    const exp = expandFatCapacity(currentBuf, ssz, currentFat, fatAddrs, projectedNewSecIdx + 1);
    currentBuf = exp.buf;
    currentFat = exp.fat;
    // Now actually allocate the new sector.
    const alloc = appendBlankSector(currentBuf, ssz);
    currentBuf = alloc.buf;
    const newSecIdx = alloc.newSecIdx;
    // FAT updates: link the chain tail to the new sector, mark new sector
    // as ENDOFCHAIN.
    writeFatEntry(currentBuf, ssz, fatAddrs, lastSec, newSecIdx);
    writeFatEntry(currentBuf, ssz, fatAddrs, newSecIdx, ENDOFCHAIN);
    currentFat[lastSec] = newSecIdx;
    currentFat[newSecIdx] = ENDOFCHAIN;
    newChain.push(newSecIdx);
    lastSec = newSecIdx;
  }
  return { buf: currentBuf, fat: currentFat, chain: newChain };
}

// ── Mini-FAT / mini-stream expansion (Phase 3b) ───────────────────────────
//
// Mini-streams in CFB sit inside the root entry's regular-FAT chain, cut
// into mini-sectors (typically 64 bytes). The mini-FAT (a regular stream
// whose FAT chain starts at header offset 0x3C) holds next-pointers for
// each mini-sector — same shape as the FAT, just for the 64-byte slots.
//
// Extending a mini-stream means:
//   (1) make sure the mini-FAT can index one more mini-sector
//   (2) make sure the root chain can hold one more mini-sector worth of
//       bytes (if not, extend the root chain via extendFatChain — that's
//       a regular-FAT chain underneath)
//   (3) write the new mini-FAT entry (chain tail → new idx, new idx →
//       ENDOFCHAIN)
//   (4) bump the root entry's size field (number of allocated mini bytes)
//   (5) bump the mini-FAT sector count at header 0x40
//
// We don't yet promote a mini-stream to the regular FAT — that's a
// separate Phase 3b-2. For now mini-stream extension is the natural
// path when the patched Section stays under the 4096-byte mini-stream
// cutoff but the existing chain ran out of room.

function writeMinifatEntry(buf, ssz, mssz, fat, minifatStart, miniIdx, value) {
  // Mini-FAT sectors are regular sectors strung together via a regular-
  // FAT chain starting at minifatStart. miniIdx addresses entries
  // across that concatenation: each regular sector holds ssz/4 entries
  // (128 for v3). We walk the chain to find which sector and offset
  // within it.
  const entriesPerSec = ssz >>> 2;
  const sectorIdxInChain = Math.floor(miniIdx / entriesPerSec);
  const offsetInSector = miniIdx % entriesPerSec;
  const minifatChain = walkChain(fat, minifatStart);
  if (sectorIdxInChain >= minifatChain.length) {
    throw new Error(`writeMinifatEntry: idx ${miniIdx} outside mini-FAT (${minifatChain.length} sectors); call expandMinifatCapacity first`);
  }
  const fatSec = minifatChain[sectorIdxInChain];
  const fileOff = (fatSec + 1) * ssz + offsetInSector * 4;
  buf.writeInt32LE(value, fileOff);
}

// Make sure the mini-FAT has enough capacity to address `requiredCapacity`
// mini-sectors. Allocates new regular sectors and links them into the
// mini-FAT chain (header 0x3C onwards). Each added mini-FAT sector adds
// ssz/4 = 128 entries (v3).
function expandMinifatCapacity(buf, ssz, fat, fatAddrs, minifat, minifatStart, requiredCapacity) {
  const entriesPerSec = ssz >>> 2;
  let currentBuf = buf;
  let currentFat = fat;
  let currentMinifat = minifat;
  let currentMinifatStart = minifatStart;
  while (currentMinifat.length < requiredCapacity) {
    // Allocate a fresh regular sector for the mini-FAT page. Make sure
    // the regular FAT can index it first.
    const projectedSecIdx = currentBuf.length / ssz - 1 + 1;
    const exp = expandFatCapacity(currentBuf, ssz, currentFat, fatAddrs, projectedSecIdx + 1);
    currentBuf = exp.buf;
    currentFat = exp.fat;
    const alloc = appendBlankSector(currentBuf, ssz);
    currentBuf = alloc.buf;
    const newSec = alloc.newSecIdx;
    // Initialize all entries in the new mini-FAT sector to FREESECT.
    const newSecOff = (newSec + 1) * ssz;
    for (let i = 0; i < entriesPerSec; i++) {
      currentBuf.writeInt32LE(FREESECT, newSecOff + i * 4);
    }
    // Mark the new mini-FAT sector as ENDOFCHAIN in regular FAT, then
    // link it onto the mini-FAT regular-FAT chain.
    writeFatEntry(currentBuf, ssz, fatAddrs, newSec, ENDOFCHAIN);
    currentFat[newSec] = ENDOFCHAIN;
    if (currentMinifatStart < 0 || currentMinifatStart === ENDOFCHAIN) {
      // No mini-FAT existed yet — point the header at this new sector.
      currentMinifatStart = newSec;
      currentBuf.writeInt32LE(newSec, 0x3C);
    } else {
      // Walk to the tail of the mini-FAT chain and link.
      const minifatChain = walkChain(currentFat, currentMinifatStart);
      const tail = minifatChain[minifatChain.length - 1];
      writeFatEntry(currentBuf, ssz, fatAddrs, tail, newSec);
      currentFat[tail] = newSec;
    }
    // Bump mini-FAT sector count at header 0x40.
    const newMinifatSecCount = walkChain(currentFat, currentMinifatStart).length;
    currentBuf.writeUInt32LE(newMinifatSecCount, 0x40);
    // Grow in-memory minifat array.
    const newMinifat = new Int32Array(currentMinifat.length + entriesPerSec);
    newMinifat.set(currentMinifat);
    for (let i = currentMinifat.length; i < newMinifat.length; i++) newMinifat[i] = FREESECT;
    currentMinifat = newMinifat;
  }
  return { buf: currentBuf, fat: currentFat, minifat: currentMinifat, minifatStart: currentMinifatStart };
}

// Make sure the root mini-stream chain has room for `requiredMiniSectors`
// mini-sectors (i.e. `requiredMiniSectors * mssz` bytes). Each regular
// sector in the root chain holds ssz/mssz mini-sector slots; if the
// existing root chain is too short, extend it via extendFatChain.
// Returns { buf, fat, rootChain, rootEntrySize }.
function ensureRootChainForMiniSectors(buf, ssz, mssz, fat, fatAddrs, rootChain, requiredMiniSectors) {
  const slotsPerSec = ssz / mssz;
  const currentSlots = rootChain.length * slotsPerSec;
  if (requiredMiniSectors <= currentSlots) {
    return { buf, fat, rootChain, addedRegularSectors: 0 };
  }
  const additionalRegularSectors = Math.ceil((requiredMiniSectors - currentSlots) / slotsPerSec);
  const ext = extendFatChain(buf, ssz, fat, fatAddrs, rootChain, additionalRegularSectors);
  return { buf: ext.buf, fat: ext.fat, rootChain: ext.chain, addedRegularSectors: additionalRegularSectors };
}

// Extend a mini-stream's mini-FAT chain by `additionalMiniSectors`.
// Handles all four steps: mini-FAT capacity, root chain capacity,
// mini-FAT entry writes, and the root entry's mini-stream-size field.
// Returns { buf, fat, minifat, minifatStart, rootChain, miniChain }.
function extendMinifatChain(ctx, miniChain, additionalMiniSectors) {
  if (additionalMiniSectors <= 0) return { ...ctx, miniChain };
  let { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain, rootEntry } = ctx;
  const slotsPerSec = ssz / mssz;
  // Figure out the highest mini-sector index we'll need to address.
  // We pick free entries from the mini-FAT (FREESECT == -1); if there
  // aren't enough, we append to the tail by indexing past the current
  // mini-FAT length (after expanding capacity).
  let lastMini = miniChain[miniChain.length - 1];
  const newChain = [...miniChain];
  for (let i = 0; i < additionalMiniSectors; i++) {
    // Look for an existing FREESECT slot in the mini-FAT first.
    let newMini = -1;
    for (let m = 0; m < minifat.length; m++) {
      if (minifat[m] === FREESECT) { newMini = m; break; }
    }
    if (newMini === -1) {
      // No free slot; the next idx past the current capacity.
      newMini = minifat.length;
    }
    // Make sure mini-FAT can index newMini.
    const mfExp = expandMinifatCapacity(buf, ssz, fat, fatAddrs, minifat, minifatStart, newMini + 1);
    buf = mfExp.buf;
    fat = mfExp.fat;
    minifat = mfExp.minifat;
    minifatStart = mfExp.minifatStart;
    // Make sure the root chain has bytes for mini-sector newMini.
    const rcExp = ensureRootChainForMiniSectors(buf, ssz, mssz, fat, fatAddrs, rootChain, newMini + 1);
    buf = rcExp.buf;
    fat = rcExp.fat;
    rootChain = rcExp.rootChain;
    // Zero out the new mini-sector bytes (only on first-time use; if
    // we're reusing a FREESECT slot, the underlying bytes might be old
    // tombstones, which is fine for a stream that will get overwritten
    // by writeMiniChainBytes anyway).
    const miniOff = miniSectorFileOffset(newMini, rootChain, ssz, mssz);
    buf.fill(0, miniOff, miniOff + mssz);
    // Link in the mini-FAT: prev tail → newMini, newMini → ENDOFCHAIN.
    writeMinifatEntry(buf, ssz, mssz, fat, minifatStart, lastMini, newMini);
    writeMinifatEntry(buf, ssz, mssz, fat, minifatStart, newMini, ENDOFCHAIN);
    minifat[lastMini] = newMini;
    minifat[newMini] = ENDOFCHAIN;
    newChain.push(newMini);
    lastMini = newMini;
  }
  // Bump the root entry's size field if our highest used mini-sector
  // goes past what the root chain previously advertised. Root.size in
  // CFB v3 holds the mini-stream's total byte length.
  const highestMini = Math.max(...newChain);
  const minBytesNeeded = (highestMini + 1) * mssz;
  const oldRootSize = buf.readUInt32LE(rootEntry.entryFileOffset + 0x78);
  if (minBytesNeeded > oldRootSize) {
    buf.writeUInt32LE(minBytesNeeded, rootEntry.entryFileOffset + 0x78);
    buf.writeUInt32LE(0, rootEntry.entryFileOffset + 0x7C);
  }
  return { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain, rootEntry, miniChain: newChain };
}

// Parse the directory entry chain into a list of records. For each entry
// we record the *file offset* of its 128-byte slot so we can mutate the
// size field later without re-emitting anything. Returns:
//   { entries: [{name, type, child, leftSibling, rightSibling, start, size,
//                 entryFileOffset}], dirChain }
function readDirectory(buf, fat, ssz, dirStart) {
  const dirChain = walkChain(fat, dirStart);
  const slotsPerSector = ssz >>> 7; // 128 bytes per entry
  const entries = [];
  for (let s = 0; s < dirChain.length; s++) {
    const sectorFileOff = (dirChain[s] + 1) * ssz;
    for (let i = 0; i < slotsPerSector; i++) {
      const entryFileOffset = sectorFileOff + i * 128;
      const namelen = buf.readUInt16LE(entryFileOffset + 0x40);
      const type = buf.readUInt8(entryFileOffset + 0x42);
      // Skip unused entries (type 0) but keep their slot index for indexing.
      let name = '';
      if (namelen > 0) {
        const nameBytes = buf.slice(entryFileOffset, entryFileOffset + Math.max(0, namelen - 2));
        name = nameBytes.toString('utf16le');
      }
      const leftSibling = buf.readInt32LE(entryFileOffset + 0x44);
      const rightSibling = buf.readInt32LE(entryFileOffset + 0x48);
      const child = buf.readInt32LE(entryFileOffset + 0x4C);
      const start = buf.readInt32LE(entryFileOffset + 0x74);
      const size = buf.readUInt32LE(entryFileOffset + 0x78);
      entries.push({
        name, type, leftSibling, rightSibling, child, start, size,
        entryFileOffset,
      });
    }
  }
  return { entries, dirChain };
}

// Find a stream by hierarchical path like "BodyText/Section0". We walk the
// red-black tree rooted at each storage's child to find the entry by name.
function findStreamEntry(entries, pathParts) {
  // Root entry is always at index 0 with type 5.
  let cur = entries[0];
  for (const part of pathParts) {
    // Children of `cur` are reachable via cur.child as a binary tree root.
    // Each tree node has leftSibling / rightSibling pointers to other
    // entries at the same level. Names are compared case-insensitively per
    // CFB rules, but for our use everything is ASCII so we can use exact
    // match.
    let node = cur.child >= 0 ? entries[cur.child] : null;
    let found = null;
    const queue = node ? [node] : [];
    const visited = new Set();
    while (queue.length && !found) {
      const n = queue.shift();
      if (visited.has(n.entryFileOffset)) continue;
      visited.add(n.entryFileOffset);
      if (n.name === part) { found = n; break; }
      if (n.leftSibling >= 0) queue.push(entries[n.leftSibling]);
      if (n.rightSibling >= 0) queue.push(entries[n.rightSibling]);
    }
    if (!found) throw new Error(`CFB directory entry not found: ${pathParts.join('/')} (looking for "${part}" inside "${cur.name}")`);
    cur = found;
  }
  return cur;
}

// ── Public entry ──────────────────────────────────────────────────────────
//
// patchCellsInPlace(filePath, edits) edits = [{ section, para, control, row, col, text }, ...]
// Mutates the file at filePath. Returns a summary array.

// Resolve (section, para, control, row, col) → cellIndex via rhwp inspect.
// We open the doc, walk getCellInfo until we find the matching (row, col),
// then immediately discard the doc — rhwp is never used to write bytes.
async function resolveCellIndexes(filePath, edits) {
  const rhwp = await import(`${__dirname}/vendor/rhwp/rhwp.js`);
  await rhwp.default({
    module_or_path: readFileSync(`${__dirname}/vendor/rhwp/rhwp_bg.wasm`),
  });
  // rhwp's text-layout pass calls globalThis.measureTextWidth; supply a
  // cheap stub so we can construct the document for inspection only.
  if (typeof globalThis.measureTextWidth !== 'function') {
    globalThis.measureTextWidth = (font, text) =>
      text.length * (parseFloat(font) || 10) * 0.55;
  }
  const doc = new rhwp.HwpDocument(new Uint8Array(readFileSync(filePath)));
  try {
    return edits.map((e) => {
      // If the caller already passed a cellIndex, trust it.
      if (Number.isInteger(e.cellIndex)) {
        return { ...e, cellIndex: e.cellIndex };
      }
      const sec = e.section ?? 0;
      const para = e.para ?? 0;
      const ctrl = e.control ?? 0;
      // Walk cells until we find (row, col). Tables are bounded; 10k is a
      // safe ceiling well above any real form.
      for (let i = 0; i < 10000; i++) {
        let info;
        try { info = JSON.parse(doc.getCellInfo(sec, para, ctrl, i)); }
        catch { break; }
        if (!info || typeof info.row !== 'number') break;
        if (info.row === e.row && info.col === e.col) {
          return { ...e, cellIndex: i };
        }
      }
      throw new Error(`cell (row=${e.row}, col=${e.col}) not found via rhwp at sec=${sec} para=${para} ctrl=${ctrl}`);
    });
  } finally {
    try { doc.free(); } catch { /* ignore */ }
  }
}

// Try deflating at successively higher levels to find one that fits within
// `capacity` bytes. We start at the default (6) because for typical HWP
// content it matches the original size well; if the patched content grew,
// stronger compression usually claws back the difference.
function deflateToFit(data, capacity) {
  const levels = [
    constants.Z_DEFAULT_COMPRESSION,
    7, 8, 9,
  ];
  let best = null;
  for (const level of levels) {
    const out = deflateRawSync(data, { level });
    if (out.length <= capacity) return out;
    if (!best || out.length < best.length) best = out;
  }
  throw new Error(`deflated payload (${best.length} bytes, best of attempted levels) exceeds sector chain capacity (${capacity} bytes). Patch cannot expand sectors in-place; refusing to overflow.`);
}

// Allocate a fresh regular-FAT chain of N sectors at the end of the file.
// Threads them together in the FAT, returns { buf, fat, chain }.
function allocateRegularChain(buf, ssz, fat, fatAddrs, sectorCount) {
  let workBuf = buf;
  let workFat = fat;
  const chain = [];
  for (let i = 0; i < sectorCount; i++) {
    const projectedIdx = workBuf.length / ssz - 1 + 1;
    const exp = expandFatCapacity(workBuf, ssz, workFat, fatAddrs, projectedIdx + 1);
    workBuf = exp.buf;
    workFat = exp.fat;
    const alloc = appendBlankSector(workBuf, ssz);
    workBuf = alloc.buf;
    const newSec = alloc.newSecIdx;
    if (chain.length === 0) {
      writeFatEntry(workBuf, ssz, fatAddrs, newSec, ENDOFCHAIN);
      workFat[newSec] = ENDOFCHAIN;
    } else {
      const prev = chain[chain.length - 1];
      writeFatEntry(workBuf, ssz, fatAddrs, prev, newSec);
      writeFatEntry(workBuf, ssz, fatAddrs, newSec, ENDOFCHAIN);
      workFat[prev] = newSec;
      workFat[newSec] = ENDOFCHAIN;
    }
    chain.push(newSec);
  }
  return { buf: workBuf, fat: workFat, chain };
}

// Phase 3b helper for mini-stream Sections. Mirrors
// deflateAndFitWithExpansion but works through mini-FAT / root-chain
// machinery. Two outcomes for an overflow:
//   - patched payload still fits under 4096 bytes (the mini-stream
//     cutoff) → extend the mini-FAT chain via extendMinifatChain
//   - patched payload would be >= 4096 bytes → promote to the regular
//     FAT (allocate a new chain, free the old mini-sectors, signal the
//     caller via `promoted: true` so it updates dir entry start/size)
function deflateMiniChainWithExpansion(ctx, raw, miniChain) {
  const { ssz, mssz, minifatStart, fatAddrs, rootChain, rootEntry } = ctx;
  let { buf, fat, minifat } = ctx;
  const capacity = miniChain.length * mssz;
  try {
    const compressed = deflateToFit(raw, capacity);
    return { ...ctx, miniChain, compressed, promoted: false };
  } catch (err) {
    if (!/exceeds sector chain capacity/.test(err.message)) throw err;
    const minimal = deflateRawSync(raw, { level: 9 });

    if (minimal.length >= 4096) {
      // ── Promotion: mini-stream → regular FAT ────────────────────────
      const neededSectors = Math.ceil(minimal.length / ssz);
      const alloc = allocateRegularChain(buf, ssz, fat, fatAddrs, neededSectors);
      buf = alloc.buf;
      fat = alloc.fat;
      const newChain = alloc.chain;
      // Release the old mini-sector chain (each entry → FREESECT).
      for (const miniIdx of miniChain) {
        writeMinifatEntry(buf, ssz, mssz, fat, minifatStart, miniIdx, FREESECT);
        minifat[miniIdx] = FREESECT;
      }
      const compressed = deflateToFit(raw, newChain.length * ssz);
      return {
        buf, fat, fatAddrs, minifat, minifatStart, ssz, mssz, rootChain, rootEntry,
        newRegularChain: newChain, compressed, promoted: true,
      };
    }

    // ── Mini-FAT chain extension (stays in mini-stream) ──────────────
    const neededMiniSectors = Math.ceil(minimal.length / mssz);
    const additionalMiniSectors = neededMiniSectors - miniChain.length;
    const ext = extendMinifatChain(ctx, miniChain, additionalMiniSectors);
    const newCapacity = ext.miniChain.length * mssz;
    const compressed = deflateToFit(raw, newCapacity);
    return { ...ext, compressed, promoted: false };
  }
}

// Phase 3 helper: try deflateToFit; if it overflows, extend the FAT chain
// (regular FAT only) and retry. Returns { buf, fat, chain, compressed }.
// For mini-stream chains, use deflateMiniChainWithExpansion above.
function deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, inMiniStream) {
  try {
    const compressed = deflateToFit(raw, capacity);
    return { buf, fat, chain, capacity, compressed };
  } catch (err) {
    if (!/exceeds sector chain capacity/.test(err.message)) throw err;
    if (inMiniStream) throw err;
    // Estimate worst-case deflated size at max level and allocate enough
    // extra sectors to hold it. deflateRawSync at level 9 is the best
    // case we can produce; if even that exceeds chain*ssz we know how
    // many sectors short we are.
    const minimal = deflateRawSync(raw, { level: 9 });
    const neededSectors = Math.ceil(minimal.length / ssz);
    const additionalSectors = neededSectors - chain.length;
    if (additionalSectors <= 0) throw err;
    const ext = extendFatChain(buf, ssz, fat, fatAddrs, chain, additionalSectors);
    const newCapacity = ext.chain.length * ssz;
    const compressed = deflateToFit(raw, newCapacity);
    return { buf: ext.buf, fat: ext.fat, chain: ext.chain, capacity: newCapacity, compressed };
  }
}

// In-place sector patch. Throws when the patched payload doesn't fit in the
// existing sector chain (the caller falls back to patchViaSheetjs). The file
// on disk is only touched at the very end via writeFileSync, so a mid-edit
// overflow leaves the file untouched and a fallback can start clean.
function patchInPlaceSectors(filePath, resolved) {
  // buf/fat/minifat/minifatStart/rootChain are all `let` because Phase 3's
  // regular-FAT expansion and Phase 3b's mini-FAT expansion can each
  // produce longer buffers / new in-memory structures.
  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  // The mini-stream content lives in the root storage entry's regular-FAT
  // chain. We lazily walk it when (and only when) at least one Section to
  // patch is in the mini-stream.
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  // Group edits by section to amortise inflate/deflate per stream.
  const bySection = new Map();
  for (const e of resolved) {
    const sec = e.section ?? 0;
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push(e);
  }

  const summary = [];
  for (const [secIdx, secEdits] of bySection) {
    const dirEntry = findStreamEntry(entries, ['BodyText', `Section${secIdx}`]);

    // Mini-stream vs regular FAT routing. CFB uses size < 4096 (the mini
    // stream cutoff in the header) to mean "this stream lives in the mini-
    // stream addressed by mini-FAT mini-sector indices". Tiny report
    // templates (h22_work_report-style) hit this; larger forms don't.
    const inMiniStream = dirEntry.size < 4096;
    let chain, capacity, compressed;
    if (inMiniStream) {
      const rc = ensureRootChain();
      chain = walkChain(minifat, dirEntry.start);
      capacity = chain.length * mssz;
      compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
    } else {
      chain = walkChain(fat, dirEntry.start);
      capacity = chain.length * ssz;
      compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
    }
    let raw = Buffer.from(inflateRawSync(compressed));

    // Apply edits back-to-front in record order so byte offsets stay valid.
    const editsSorted = [...secEdits].sort((a, b) =>
      (b.para - a.para) || (b.control - a.control) || (b.cellIndex - a.cellIndex)
    );
    for (const e of editsSorted) {
      const records = parseRecords(raw);
      raw = applyCellText(raw, records, e.para ?? 0, e.control ?? 0, e.cellIndex, e.text ?? '');
      summary.push({
        section: secIdx, para: e.para, control: e.control,
        row: e.row, col: e.col, cellIndex: e.cellIndex, text: e.text ?? '',
      });
    }

    // Deflate + fit. Regular-FAT chains auto-expand if the patched payload
    // grew past capacity (Phase 3); mini-stream chains do the same via
    // mini-FAT expansion, and promote to regular FAT when the payload
    // crosses the 4096-byte mini-stream cutoff (Phase 3b).
    let newCompressed;
    if (inMiniStream) {
      const rc = ensureRootChain();
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
        raw, chain
      );
      buf = ext.buf;
      fat = ext.fat;
      minifat = ext.minifat;
      minifatStart = ext.minifatStart;
      newCompressed = ext.compressed;
      if (ext.promoted) {
        // Stream just moved from mini → regular FAT. Update dir entry's
        // start field; CFB readers infer storage from size (>= 4096 →
        // regular FAT, < 4096 → mini-stream), so updating size below
        // also flips the interpretation.
        chain = ext.newRegularChain;
        writeChainBytes(buf, chain, ssz, newCompressed);
        buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        chain = ext.miniChain;
        writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
      }
    } else {
      const r = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
      buf = r.buf;
      fat = r.fat;
      chain = r.chain;
      newCompressed = r.compressed;
      writeChainBytes(buf, chain, ssz, newCompressed);
    }

    // Update the size field in the directory entry. CFB v3 stores u64 but
    // only the low 32 bits are meaningful (file sizes are bounded by u32).
    buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
    buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);
  }

  writeFileSync(filePath, buf);
  return summary;
}

// sheetjs CFB fallback. Used when an edit grows beyond the original
// sector-chain capacity (e.g. replacing a short cell with a paragraph of
// text). sheetjs's CFB.write auto-injects a "Sh33tJ5" marker stream
// — that does NOT block Hancom Docs (the 1.4.0 raw-patch shipped this
// exact code and the verified KEIT form opens cleanly in Hancom Docs), but
// it does mean output here is not byte-clean against the input. We only
// take this path when the in-place patch can't fit, never by default.
async function patchViaSheetjs(filePath, resolved) {
  const CFB = await import(`${__dirname}/vendor/cfb/cfb.js`);
  const cfb = CFB.parse(readFileSync(filePath));

  const bySection = new Map();
  for (const e of resolved) {
    const sec = e.section ?? 0;
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push(e);
  }

  const summary = [];
  for (const [secIdx, secEdits] of bySection) {
    const streamPath = `Root Entry/BodyText/Section${secIdx}`;
    const fileIdx = cfb.FullPaths.indexOf(streamPath);
    if (fileIdx < 0) throw new Error(`stream not found: ${streamPath}`);
    let raw = Buffer.from(inflateRawSync(Buffer.from(cfb.FileIndex[fileIdx].content)));

    const editsSorted = [...secEdits].sort((a, b) =>
      (b.para - a.para) || (b.control - a.control) || (b.cellIndex - a.cellIndex)
    );
    for (const e of editsSorted) {
      const records = parseRecords(raw);
      raw = applyCellText(raw, records, e.para ?? 0, e.control ?? 0, e.cellIndex, e.text ?? '');
      summary.push({
        section: secIdx, para: e.para, control: e.control,
        row: e.row, col: e.col, cellIndex: e.cellIndex, text: e.text ?? '',
      });
    }

    const compressed = deflateRawSync(raw, { level: constants.Z_DEFAULT_COMPRESSION });
    cfb.FileIndex[fileIdx].content = compressed;
    cfb.FileIndex[fileIdx].size = compressed.length;
  }

  writeFileSync(filePath, CFB.write(cfb, { type: 'buffer' }));
  return summary;
}

export async function patchCellsInPlace(filePath, edits) {
  // Step 1: resolve cell coordinates to flat cell indices via rhwp.
  const resolved = await resolveCellIndexes(filePath, edits);

  // Step 2: try in-place sector-chain patch first. This preserves every
  // byte outside the patched section (no Sh33tJ5 marker, no re-emit).
  try {
    const summary = patchInPlaceSectors(filePath, resolved);
    summary.mode = 'in-place';
    return summary;
  } catch (err) {
    // Fall back to sheetjs for any limitation the in-place patcher can't
    // handle:
    //   - sector-chain overflow: patched payload grew past the existing
    //     chain (e.g. a short cell turning into a paragraph)
    //   - mini-stream Section: tiny forms keep Section0 inside the CFB
    //     mini-stream, which the in-place patcher doesn't navigate
    //     (h22_work_report-style 27KB report templates hit this)
    // Other errors (corrupt CFB, bad cell coordinates, etc.) surface
    // unchanged so the caller sees them.
    const fallbackTriggers = /exceeds sector chain capacity|mini-stream patch path not implemented/;
    if (!fallbackTriggers.test(err.message)) throw err;

    const summary = await patchViaSheetjs(filePath, resolved);
    summary.mode = 'sheetjs-fallback';
    return summary;
  }
}

// ── replace_text raw-patch (Phase 1: equal-length only) ───────────────────
//
// Finds `query` inside any body PARA_TEXT record (level-1) and rewrites
// those bytes to `replacement` directly. PARA_TEXT body is UTF-16LE so the
// search is byte-level on the encoded form, which keeps surrogate pairs
// and HWP inline-control codes intact.
//
// This first cut only handles `Buffer.byteLength(query, 'utf16le') ===
// Buffer.byteLength(replacement, 'utf16le')` — same encoded length. Under
// that constraint:
//   - PARA_TEXT record header (size field) is unchanged
//   - PARA_HEADER text_count is unchanged
//   - PARA_CHAR_SHAPE charPos entries stay valid (no position shift)
// so the only mutation is the bytes inside the existing PARA_TEXT body.
//
// Different-length replacements need char_shape shifting + PARA_TEXT
// header rewriting (extended size encoding crossover) + PARA_HEADER
// text_count update. That comes in the next phase.
//
// Only body paragraphs (PARA_HEADER level 0, PARA_TEXT level 1) are
// searched. Table cell text is invisible to this op — same as rhwp's
// replaceOne and SKILL.md docs the constraint. Use set_cell_text* for
// cells.

function findReplaceTextTarget(records, raw, query, caseSensitive) {
  const queryBuf = Buffer.from(query, 'utf16le');
  const queryLower = query.toLowerCase();
  // Track the most recent level-0 PARA_HEADER as we walk — that's the
  // paragraph whose text_count we update when the replacement changes
  // length, and whose level-1 PARA_CHAR_SHAPE we shift.
  let paraHeaderIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) paraHeaderIdx = i;
    if (r.tag !== TAG_PARA_TEXT || r.level !== 1) continue;
    const body = raw.slice(r.dataOff, r.dataOff + r.size);
    let byteOffset;
    if (caseSensitive) {
      byteOffset = body.indexOf(queryBuf);
    } else {
      const bodyStr = body.toString('utf16le').toLowerCase();
      const charIdx = bodyStr.indexOf(queryLower);
      byteOffset = charIdx >= 0 ? charIdx * 2 : -1;
    }
    if (byteOffset >= 0 && paraHeaderIdx >= 0) {
      // Walk forward looking for the level-1 PARA_CHAR_SHAPE that belongs
      // to this paragraph. Stop at the next level-0 PARA_HEADER.
      let charShape = null;
      for (let j = i + 1; j < records.length; j++) {
        const r2 = records[j];
        if (r2.tag === TAG_PARA_HEADER && r2.level === 0) break;
        if (r2.tag === TAG_PARA_CHAR_SHAPE && r2.level === 1) { charShape = r2; break; }
      }
      return {
        paraHeaderRec: records[paraHeaderIdx],
        paraTextRec: r,
        charShapeRec: charShape,
        byteOffset,
      };
    }
  }
  return null;
}

// Builds a raw PARA_TEXT record (header + body) for the given level. The
// header uses inline 12-bit size when body fits in 0xFFE bytes, otherwise
// extended encoding (12-bit field set to 0xFFF followed by a u32 real
// size). JS bitwise is i32, so we coerce to u32 with `>>> 0`.
function buildParaTextRecord(body, level) {
  const size = body.length;
  if (size > 0xFFE) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(((0xFFF << 20) | (level << 10) | TAG_PARA_TEXT) >>> 0, 0);
    head.writeUInt32LE(size, 4);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(((size << 20) | (level << 10) | TAG_PARA_TEXT) >>> 0, 0);
  return Buffer.concat([head, body]);
}

// Equal-length replace: bytes-in-place. Returns { raw, replaced }. raw is
// the same buffer object (mutated). No record-size or text_count changes.
function applyReplaceTextEqualLength(raw, op) {
  const queryBuf = Buffer.from(op.query, 'utf16le');
  const replBuf = Buffer.from(op.replacement ?? '', 'utf16le');
  const records = parseRecords(raw);
  const caseSensitive = op.case_sensitive !== false;
  const target = findReplaceTextTarget(records, raw, op.query, caseSensitive);
  if (!target) return { raw, replaced: false };
  replBuf.copy(raw, target.paraTextRec.dataOff + target.byteOffset);
  return { raw, replaced: true };
}

// Different-length replace: rebuild the PARA_TEXT record, shift the
// paragraph's PARA_CHAR_SHAPE charPos entries past the match, and update
// PARA_HEADER text_count. Returns { raw, replaced } where raw is a NEW
// buffer (length changes because the record header and/or body grew or
// shrank).
//
// The three coordinated edits, in order:
//   (1) char_shape charPos shift — must happen on the old buffer so the
//       paraTextRec.dataOff offsets we read are still valid
//   (2) PARA_HEADER text_count update — same reason
//   (3) PARA_TEXT record swap — last, builds the new buffer
function applyReplaceTextDifferentLength(raw, op) {
  const queryBuf = Buffer.from(op.query, 'utf16le');
  const replBuf = Buffer.from(op.replacement ?? '', 'utf16le');
  const records = parseRecords(raw);
  const caseSensitive = op.case_sensitive !== false;
  const target = findReplaceTextTarget(records, raw, op.query, caseSensitive);
  if (!target) return { raw, replaced: false };

  const { paraHeaderRec, paraTextRec, charShapeRec, byteOffset } = target;
  const queryChars = queryBuf.length / 2;
  const replChars = replBuf.length / 2;
  const deltaChars = replChars - queryChars;
  const matchCharPos = byteOffset / 2;

  // (1) PARA_CHAR_SHAPE entries shift. Each entry is 8 bytes:
  //     [u32 charPos, u32 shapeId]. We touch only charPos.
  if (charShapeRec) {
    const csOff = charShapeRec.dataOff;
    const entryCount = Math.floor(charShapeRec.size / 8);
    for (let i = 0; i < entryCount; i++) {
      const entryOff = csOff + i * 8;
      const pos = raw.readUInt32LE(entryOff);
      let newPos;
      if (pos <= matchCharPos) {
        newPos = pos;
      } else if (pos >= matchCharPos + queryChars) {
        newPos = pos + deltaChars;
      } else {
        // Entry sits *inside* the replaced span. Clamp to match start so
        // the entry still references a valid character position.
        newPos = matchCharPos;
      }
      raw.writeUInt32LE((newPos >>> 0) >>> 0, entryOff);
    }
  }

  // (2) PARA_HEADER.text_count update. The high bit is a paragraph flag we
  // must preserve; only the low 31 bits hold the char count.
  const oldCount = raw.readUInt32LE(paraHeaderRec.dataOff);
  const high = (oldCount & 0x80000000) >>> 0;
  const low = oldCount & 0x7FFFFFFF;
  const newLow = (low + deltaChars) >>> 0;
  raw.writeUInt32LE((high | newLow) >>> 0, paraHeaderRec.dataOff);

  // (3) PARA_TEXT swap. Build the new body, then a fresh record, then
  // splice it into raw.
  const oldBody = raw.slice(paraTextRec.dataOff, paraTextRec.dataOff + paraTextRec.size);
  const newBody = Buffer.concat([
    oldBody.slice(0, byteOffset),
    replBuf,
    oldBody.slice(byteOffset + queryBuf.length),
  ]);
  const newRecord = buildParaTextRecord(newBody, 1);
  const oldRecordLen = (paraTextRec.ext ? 8 : 4) + paraTextRec.size;
  const newRaw = Buffer.concat([
    raw.slice(0, paraTextRec.headOff),
    newRecord,
    raw.slice(paraTextRec.headOff + oldRecordLen),
  ]);
  return { raw: newRaw, replaced: true };
}

function applyReplaceText(raw, op) {
  const qLen = Buffer.byteLength(op.query, 'utf16le');
  const rLen = Buffer.byteLength(op.replacement ?? '', 'utf16le');
  if (qLen === rLen) return applyReplaceTextEqualLength(raw, op);
  return applyReplaceTextDifferentLength(raw, op);
}

export async function replaceTextInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', replaced_count: 0 });
  }
  // Validate ops up front — surface "different length" before we touch the
  // file, so a partial run can't leave the file partially patched.
  for (const op of ops) {
    if (typeof op.query !== 'string' || op.query.length === 0) {
      throw new Error("replace_text: 'query' is required");
    }
    const replacement = op.replacement ?? '';
    if (/[\n\r]/.test(replacement) || replacement.indexOf('\u2028') !== -1 || replacement.indexOf('\u2029') !== -1) {
      throw new Error("replace_text: replacement cannot contain paragraph-break characters");
    }
  }

  // buf/fat/minifat/minifatStart/rootChain are all `let` so Phase 3 /
  // Phase 3b expansion paths can replace them.
  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  // Walk every BodyText/SectionN stream once, applying every op to it (an
  // op might match in any section). We bail with a clear error when a
  // section can't be located — that means a malformed input file, not a
  // user-correctable condition.
  const summary = [];
  let totalReplaced = 0;

  for (let secIdx = 0; ; secIdx++) {
    let dirEntry;
    try {
      dirEntry = findStreamEntry(entries, ['BodyText', `Section${secIdx}`]);
    } catch {
      break; // no more sections
    }

    const inMiniStream = dirEntry.size < 4096;
    let chain, capacity, compressed;
    if (inMiniStream) {
      const rc = ensureRootChain();
      chain = walkChain(minifat, dirEntry.start);
      capacity = chain.length * mssz;
      compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
    } else {
      chain = walkChain(fat, dirEntry.start);
      capacity = chain.length * ssz;
      compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
    }
    let raw = Buffer.from(inflateRawSync(compressed));
    let dirty = false;
    const sectionReplacements = [];

    for (const op of ops) {
      const r = applyReplaceText(raw, op);
      // Different-length replacements return a freshly-allocated buffer;
      // equal-length returns the same buffer mutated. Either way, reassign
      // so the next op (and the deflate below) sees the latest state.
      if (r.replaced) {
        raw = r.raw;
        dirty = true;
        totalReplaced++;
        sectionReplacements.push({ section: secIdx, query: op.query, replacement: op.replacement ?? '' });
      }
    }
    if (!dirty) continue;

    // Deflate + fit. Both regular-FAT and mini-stream chains auto-expand,
    // and mini-stream Sections promote to regular FAT when the patched
    // payload exceeds the 4096-byte mini-stream cutoff (Phase 3 / 3b).
    let newCompressed;
    if (inMiniStream) {
      const rc = ensureRootChain();
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
        raw, chain
      );
      buf = ext.buf;
      fat = ext.fat;
      minifat = ext.minifat;
      minifatStart = ext.minifatStart;
      newCompressed = ext.compressed;
      if (ext.promoted) {
        chain = ext.newRegularChain;
        writeChainBytes(buf, chain, ssz, newCompressed);
        buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        chain = ext.miniChain;
        writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
      }
    } else {
      const r = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
      buf = r.buf;
      fat = r.fat;
      chain = r.chain;
      newCompressed = r.compressed;
      writeChainBytes(buf, chain, ssz, newCompressed);
    }
    buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
    buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

    summary.push(...sectionReplacements);
  }

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.replaced_count = totalReplaced;
  return result;
}

// ── append_paragraph raw-patch (Phase 4-1) ────────────────────────────────
//
// Strategy: clone the last body-level paragraph cluster (PARA_HEADER +
// PARA_TEXT + PARA_CHAR_SHAPE + ...) and append it right after the
// original. text_count and the PARA_TEXT body are swapped for the new
// text; everything else — paraShape ref, charShape pairs, styleRef,
// control_mask — comes from the cloned paragraph and inherits the
// existing form's styling. The high-bit "this is the last paragraph"
// flag is moved from the original onto the clone so the cursor still
// terminates at the end.
//
// Why clone the last paragraph specifically: it's the only one that
// definitely exists in every document and is guaranteed to be a regular
// body paragraph (not a heading, list, table, etc.). For
// append_heading and friends in later phases we'll let the caller pick
// a template.

function findLastBodyParagraphCluster(records) {
  // Walk forward to find the last level-0 PARA_HEADER. Then determine
  // which records belong to it: every record after it whose level > 0
  // (or whose level === 0 but isn't a PARA_HEADER — there's no such
  // thing in normal docs, but stay safe).
  let lastIdx = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].tag === TAG_PARA_HEADER && records[i].level === 0) lastIdx = i;
  }
  if (lastIdx < 0) throw new Error('append_paragraph: no level-0 PARA_HEADER found in section');
  // Cluster end = first record after lastIdx that is itself a level-0
  // record (next paragraph) OR end of stream.
  let clusterEnd = records.length;
  for (let i = lastIdx + 1; i < records.length; i++) {
    if (records[i].tag === TAG_PARA_HEADER && records[i].level === 0) {
      clusterEnd = i;
      break;
    }
  }
  return { paraHeaderIdx: lastIdx, clusterEndIdx: clusterEnd };
}

// Build a fresh PARA_HEADER record (header + body) by cloning the given
// source paragraph's PARA_HEADER body bytes and overwriting the
// text_count field with `newCharCount` (paragraph flag bit preserved
// from the source).
function buildClonedParaHeader(srcParaHeaderRec, raw, newCharCount, paragraphFlag) {
  const bodySize = srcParaHeaderRec.size;
  if (bodySize < 4) throw new Error(`PARA_HEADER body too short to clone: ${bodySize}`);
  const body = Buffer.alloc(bodySize);
  raw.copy(body, 0, srcParaHeaderRec.dataOff, srcParaHeaderRec.dataOff + bodySize);
  // text_count: low 31 bits = char count (incl EOP), high bit = last-
  // paragraph flag.
  const flag = paragraphFlag ? 0x80000000 : 0;
  body.writeUInt32LE(((flag | (newCharCount & 0x7FFFFFFF)) >>> 0), 0);
  // Header: same level (0), same tag (PARA_HEADER), size field
  // matches body.
  if (bodySize > 0xFFE) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(((0xFFF << 20) | (0 << 10) | TAG_PARA_HEADER) >>> 0, 0);
    head.writeUInt32LE(bodySize, 4);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(((bodySize << 20) | (0 << 10) | TAG_PARA_HEADER) >>> 0, 0);
  return Buffer.concat([head, body]);
}

// Build a level-1 PARA_TEXT record for new body text. EOP appended.
function buildBodyParaTextRecord(text) {
  const body = Buffer.from(text + PARA_TEXT_EOP, 'utf16le');
  return buildParaTextRecord(body, 1);
}

// Clone all records that belong to the source cluster except the
// PARA_HEADER itself (we built a fresh one) and the PARA_TEXT (we
// supply a new one). Returns the raw byte concatenation of the
// remaining records (PARA_CHAR_SHAPE, PARA_LINE_SEG, controls, etc.)
// taken from `raw` as-is. PARA_LINE_SEG entries from the source would
// describe a stale line layout for the cloned text; we drop them so
// Hancom recomputes on open.
function cloneClusterTrailer(records, raw, clusterStartIdx, clusterEndIdx) {
  const TAG_PARA_LINE_SEG = 0x45;
  const parts = [];
  // Start at clusterStartIdx + 1 (skip the source PARA_HEADER).
  for (let i = clusterStartIdx + 1; i < clusterEndIdx; i++) {
    const r = records[i];
    // Skip the source PARA_TEXT — caller emits a fresh one.
    if (r.tag === TAG_PARA_TEXT && r.level === 1) continue;
    // Drop PARA_LINE_SEG; Hancom regenerates from text + paraShape.
    if (r.tag === TAG_PARA_LINE_SEG) continue;
    // Copy the full record bytes (header + body).
    const headLen = r.ext ? 8 : 4;
    parts.push(raw.slice(r.headOff, r.dataOff + r.size));
  }
  return Buffer.concat(parts);
}

export async function appendParagraphInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', appended_count: 0 });
  }
  for (const op of ops) {
    if (typeof op.text !== 'string') {
      throw new Error("append_paragraph: 'text' is required");
    }
    if (/[\n\r]/.test(op.text) || op.text.indexOf(' ') !== -1 || op.text.indexOf(' ') !== -1) {
      throw new Error("append_paragraph: 'text' cannot contain paragraph-break characters (one op = one paragraph; use multiple ops)");
    }
  }

  // Load the file and the CFB structures we need.
  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  // Target stream: BodyText/Section0 by default (we don't yet support
  // multi-section append; SKILL.md gates that for callers).
  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  // Append each paragraph onto raw.
  const summary = [];
  for (const op of ops) {
    const records = parseRecords(raw);
    const { paraHeaderIdx, clusterEndIdx } = findLastBodyParagraphCluster(records);
    const srcHeader = records[paraHeaderIdx];
    // The source paragraph carries the "is-last" flag we need to move.
    const srcText_count_word = raw.readUInt32LE(srcHeader.dataOff);
    const srcWasLast = (srcText_count_word & 0x80000000) >>> 0 ? true : false;
    // Strip the flag on the source if it had one (the clone takes over
    // the last-paragraph role).
    if (srcWasLast) {
      const stripped = srcText_count_word & 0x7FFFFFFF;
      raw.writeUInt32LE(stripped >>> 0, srcHeader.dataOff);
    }

    const newCharCount = op.text.length + 1; // + EOP
    const newHeader = buildClonedParaHeader(srcHeader, raw, newCharCount, srcWasLast);
    const newText = buildBodyParaTextRecord(op.text);
    const trailer = cloneClusterTrailer(records, raw, paraHeaderIdx, clusterEndIdx);
    const newCluster = Buffer.concat([newHeader, newText, trailer]);

    // Insertion point: end of the source cluster (i.e. right before the
    // next paragraph, or end of stream).
    const insertAt = clusterEndIdx < records.length
      ? records[clusterEndIdx].headOff
      : raw.length;
    raw = Buffer.concat([raw.slice(0, insertAt), newCluster, raw.slice(insertAt)]);
    summary.push({ section: 0, text: op.text });
  }

  // Deflate + write back (Phase 3/3b infrastructure).
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.appended_count = summary.length;
  return result;
}

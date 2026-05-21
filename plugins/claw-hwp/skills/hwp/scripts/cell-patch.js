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

// In-place sector patch. Throws when the patched payload doesn't fit in the
// existing sector chain (the caller falls back to patchViaSheetjs). The file
// on disk is only touched at the very end via writeFileSync, so a mid-edit
// overflow leaves the file untouched and a fallback can start clean.
function patchInPlaceSectors(filePath, resolved) {
  const buf = readFileSync(filePath);
  const { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  const fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  const minifat = readMinifat(buf, fat, ssz, minifatStart);
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
    let chain, capacity;
    let readBytes, writeBytes;
    if (inMiniStream) {
      const rc = ensureRootChain();
      chain = walkChain(minifat, dirEntry.start);
      capacity = chain.length * mssz;
      readBytes = (size) => readMiniChainBytes(buf, chain, rc, ssz, mssz, size);
      writeBytes = (data) => writeMiniChainBytes(buf, chain, rc, ssz, mssz, data);
    } else {
      chain = walkChain(fat, dirEntry.start);
      capacity = chain.length * ssz;
      readBytes = (size) => readChainBytes(buf, chain, ssz, size);
      writeBytes = (data) => writeChainBytes(buf, chain, ssz, data);
    }

    const compressed = readBytes(dirEntry.size);
    let raw = Buffer.from(inflateRawSync(compressed));

    // Apply edits back-to-front in record order so byte offsets stay valid.
    // We re-parse records before each apply because record offsets shift
    // when bytes get inserted/replaced. The walk is cheap (~1ms).
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

    // deflateToFit throws "exceeds sector chain capacity" when the patched
    // payload doesn't fit. writeMiniChainBytes also throws with the same
    // substring when a mini-chain overflows, so the caller's fallback
    // regex catches both cases.
    const newCompressed = deflateToFit(raw, capacity);
    writeBytes(newCompressed);

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

#!/usr/bin/env node
// hwpx-edit.js — Deterministic, function-level editing of .hwpx documents.
//
// HWPX ONLY. This script never touches HWP 5.0 binary (.hwp / CFB) files —
// that path lives in cell-patch.js. Input must be a ZIP-based .hwpx.
//
// Reads a JSON payload from stdin and applies a list of operations against the
// OWPML XML inside the .hwpx ZIP, then repackages. One ZIP load, N operations
// applied in order, one save — so a multi-step edit costs a single round-trip.
//
//   stdin → {
//     "path":   "in.hwpx",                 // required, must be .hwpx
//     "output": "out.hwpx",                // optional; default <in>_edited.hwpx
//     "operations": [ { "type": "...", ... }, ... ]
//   }
//
// Supported operation types (all .hwpx):
//   replace_text          { find, replace }
//   fill_template         { values: { "{{k}}": "v", ... } }
//   set_paragraph_text    { index, text }
//   append_paragraph      { text }
//   delete_paragraph      { index }
//   set_cell_text         { table, row, col, text }
//   append_table_row      { table, cells: [..] }
//   delete_table_row      { table, row }
//   append_table_column   { table, cells: [..] }   // cells top-to-bottom
//   delete_table_column   { table, col }
//   merge_cells           { table, mode: "horizontal"|"vertical", row|col, start, count }
//   insert_table          { index, rows, cols, cells? }  // appends a new table paragraph after paragraph `index` (use -1 to prepend)
//   apply_text_style      { target, color?, bold?, italic?, underline?, size?, highlight?, strikethrough? }
//   apply_paragraph_style { index, align?, indent?, lineSpacing? }
//   insert_image          { source, ext?, width?, height? }
//   replace_image         { target, source }
//   delete_image          { target }
//   set_field_value       { name, value }
//   set_header            { text, applyPageType? }   // BOTH | EVEN | ODD, default BOTH
//   set_footer            { text, applyPageType? }
//   remove_header         { }
//   remove_footer         { }
//   insert_footnote       { index, text }    // appends a footnote at end of paragraph `index`
//   insert_endnote        { index, text }    // same shape, endnote
//   insert_hyperlink      { index, url, text } // appends a clickable URL link to paragraph `index`
//
// Output: JSON to stdout — { ok, output, results: [ { type, ...stats } ] }.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { unzipSync, zipSync, strFromU8, strToU8 } from './vendor/fflate/index.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ── small utils ─────────────────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
let _idCounter = Math.floor(Math.random() * 1_000_000);
function freshId() {
  // OWPML ids are 32-bit-ish integers; uniqueness within the doc is what matters.
  _idCounter = (_idCounter + 1 + Math.floor(Math.random() * 97)) % 2_000_000_000;
  return String(_idCounter);
}

// Depth-aware scan of `tag` elements at the OUTERMOST level of `xml`.
// Correctly skips nested same-name tags (e.g. a <hp:tbl> inside a cell of
// another <hp:tbl>), where treesoop's non-greedy /<hp:tbl>[\s\S]*?<\/hp:tbl>/
// closes early on the inner table. Returns [{ start, end, openEnd, attrs, inner }].
function scanTopLevel(xml, tag) {
  const t = tag.replace(/:/g, '\\:');
  const re = new RegExp(`<${t}((?:\\s[^>]*?)?)(/?)>|</${t}\\s*>`, 'g');
  const out = [];
  let depth = 0, start = -1, openEnd = -1, attrs = '';
  let m;
  while ((m = re.exec(xml)) !== null) {
    const isClose = m[0].startsWith('</');
    if (!isClose && m[2] === '/') {
      // self-closing <tag .../>
      if (depth === 0) out.push({ start: m.index, end: re.lastIndex, openEnd: re.lastIndex, attrs: m[1] || '', inner: '', selfClosing: true });
      continue;
    }
    if (!isClose) {
      if (depth === 0) { start = m.index; openEnd = re.lastIndex; attrs = m[1] || ''; }
      depth++;
    } else {
      if (depth > 0) {
        depth--;
        if (depth === 0) out.push({ start, end: re.lastIndex, openEnd, attrs, inner: xml.slice(openEnd, m.index) });
      }
    }
  }
  return out;
}

// Replace the byte range [el.start, el.end) of `xml` with `replacement`.
function spliceEl(xml, el, replacement) {
  return xml.slice(0, el.start) + replacement + xml.slice(el.end);
}

function getAttr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

// ── document model over the loaded ZIP ───────────────────────────────────────

class Hwpx {
  constructor(files) {
    this.files = files; // { name: Uint8Array }
    this.text = {};     // name -> decoded string (lazy write-back on save)
    this.dirty = new Set();
  }
  sectionNames() {
    return Object.keys(this.files)
      .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
      .sort((a, b) => secIdx(a) - secIdx(b));
  }
  headerName() {
    return Object.keys(this.files).find((n) => /^Contents\/header\.xml$/i.test(n)) || null;
  }
  hpfName() {
    return Object.keys(this.files).find((n) => /^Contents\/content\.hpf$/i.test(n)) || null;
  }
  read(name) {
    if (!(name in this.text)) this.text[name] = strFromU8(this.files[name]);
    return this.text[name];
  }
  write(name, str) {
    this.text[name] = str;
    this.dirty.add(name);
  }
  // Flatten top-level <hp:p> across all sections into a global ordered list.
  paragraphs() {
    const list = [];
    for (const name of this.sectionNames()) {
      const xml = this.read(name);
      for (const el of scanTopLevel(xml, 'hp:p')) list.push({ section: name, el });
    }
    return list;
  }
  // All top-level <hp:tbl> across sections, in document order.
  tables() {
    const list = [];
    for (const name of this.sectionNames()) {
      const xml = this.read(name);
      for (const el of scanTopLevel(xml, 'hp:tbl')) list.push({ section: name, el });
    }
    return list;
  }
}

function secIdx(name) {
  const m = name.match(/section(\d+)\.xml/i);
  return m ? parseInt(m[1], 10) : 0;
}

// Strip <hp:linesegarray> blocks. Linesegs are a precomputed line-break cache;
// after editing text / styles / table structure they're stale and on some
// strict readers (notably Hancom Docs) the result shows overlapping or
// mispositioned characters until the cache is recomputed. Dropping the cache
// forces a full relayout on open — cheap, and the safer default.
function dropLinesegs(s) {
  return s.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, '');
}

// ── text operations ──────────────────────────────────────────────────────────

// Replace `find` with `replace` inside <hp:t>…</hp:t> nodes only (never touches
// tag names / attributes). Note: a match must sit within ONE <hp:t> node;
// targets split across runs are not joined (same as Hancom's text replace).
// Uses split/join per text node (not a re-scanning loop) so a replacement that
// itself contains `find` — e.g. '홍길동' → '홍길동(수정)' — can't loop forever.
function opReplaceText(doc, find, replace) {
  if (!find) throw new Error('replace_text: "find" is required and non-empty');
  const nodeRe = /(<hp:t(?:\s[^>]*)?>)([^<]*)(<\/hp:t>)/g;
  let total = 0;
  for (const name of doc.sectionNames()) {
    let changed = false;
    const xml = doc.read(name).replace(nodeRe, (m, open, text, close) => {
      if (!text.includes(find)) return m;
      const parts = text.split(find);
      total += parts.length - 1;
      changed = true;
      return open + parts.join(xmlEscape(replace)) + close;
    });
    if (changed) doc.write(name, dropLinesegs(xml));
  }
  return { replaced: total };
}

function opFillTemplate(doc, values) {
  if (!values || typeof values !== 'object') throw new Error('fill_template: "values" object required');
  const perKey = {};
  let total = 0;
  for (const [k, v] of Object.entries(values)) {
    const r = opReplaceText(doc, k, v);
    perKey[k] = r.replaced;
    total += r.replaced;
  }
  return { total, perKey };
}

// Build a minimal run that carries `text` with the given charPrIDRef.
function runWithText(charPrId, text) {
  return `<hp:run charPrIDRef="${charPrId}"><hp:t>${xmlEscape(text)}</hp:t></hp:run>`;
}

function opSetParagraphText(doc, index, text) {
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`set_paragraph_text: index ${index} out of range (0..${paras.length - 1})`);
  const { section, el } = paras[index];
  const open = el.attrs;
  const charPrId = (el.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const rebuilt = `<hp:p${open}>${runWithText(charPrId, text)}</hp:p>`;
  doc.write(section, spliceEl(doc.read(section), el, rebuilt));
  return { index, set: true };
}

function opAppendParagraph(doc, text) {
  const names = doc.sectionNames();
  const last = names[names.length - 1];
  let xml = doc.read(last);
  const paras = scanTopLevel(xml, 'hp:p');
  // Clone attributes of the last body paragraph for sane paraPr/style refs.
  let attrs = ' id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"';
  let charPrId = '0';
  if (paras.length) {
    attrs = paras[paras.length - 1].attrs.replace(/\s*id="\d+"/, ` id="${freshId()}"`);
    charPrId = (paras[paras.length - 1].inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  } else {
    attrs = attrs.replace(/id="0"/, `id="${freshId()}"`);
  }
  const para = `<hp:p${attrs}>${runWithText(charPrId, text)}</hp:p>`;
  if (/<\/hs:sec>\s*$/.test(xml)) xml = xml.replace(/<\/hs:sec>\s*$/, para + '</hs:sec>');
  else xml += para;
  doc.write(last, xml);
  return { appended: true };
}

function opDeleteParagraph(doc, index) {
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`delete_paragraph: index ${index} out of range (0..${paras.length - 1})`);
  const { section, el } = paras[index];
  doc.write(section, spliceEl(doc.read(section), el, ''));
  return { index, deleted: true };
}

// ── table helpers ──────────────────────────────────────────────────────────

function getTable(doc, tableIndex) {
  const tables = doc.tables();
  if (tableIndex < 0 || tableIndex >= tables.length) throw new Error(`table index ${tableIndex} out of range (found ${tables.length})`);
  return tables[tableIndex];
}

// Set the inner text of one <hp:tc>, collapsing its first paragraph to a single
// run. Preserves the <hp:subList> wrapper and trailing cell metadata.
function setCellInner(tcInner, text) {
  // The first <hp:p> inside the subList holds the cell content.
  const subs = scanTopLevel(tcInner, 'hp:subList');
  if (!subs.length) return tcInner;
  const sub = subs[0];
  const ps = scanTopLevel(sub.inner, 'hp:p');
  if (!ps.length) return tcInner;
  const p = ps[0];
  const charPrId = (p.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const newP = `<hp:p${p.attrs}>${runWithText(charPrId, text)}</hp:p>`;
  const newSubInner = spliceEl(sub.inner, p, newP);
  const newSub = `<hp:subList${sub.attrs}>${newSubInner}</hp:subList>`;
  return spliceEl(tcInner, sub, newSub);
}

function opSetCellText(doc, tableIndex, row, col, text) {
  const { section, el } = getTable(doc, tableIndex);
  const tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  if (row < 0 || row >= rows.length) throw new Error(`set_cell_text: row ${row} out of range (0..${rows.length - 1})`);
  const tcs = scanTopLevel(rows[row].inner, 'hp:tc');
  // Prefer addressing by <hp:cellAddr>, which is correct even with merges.
  let targetIdx = tcs.findIndex((tc) => {
    const a = tc.inner.match(/<hp:cellAddr [^>]*colAddr="(\d+)"[^>]*rowAddr="(\d+)"|<hp:cellAddr [^>]*rowAddr="(\d+)"[^>]*colAddr="(\d+)"/);
    if (!a) return false;
    const c = a[1] !== undefined ? Number(a[1]) : Number(a[4]);
    return c === col;
  });
  if (targetIdx === -1) {
    if (col < 0 || col >= tcs.length) throw new Error(`set_cell_text: col ${col} out of range (0..${tcs.length - 1})`);
    targetIdx = col; // fall back to positional
  }
  const tc = tcs[targetIdx];
  const newTcInner = setCellInner(tc.inner, text);
  const newTc = `<hp:tc${tc.attrs}>${newTcInner}</hp:tc>`;
  const newRowInner = spliceEl(rows[row].inner, tc, newTc);
  const newRow = `<hp:tr${rows[row].attrs}>${newRowInner}</hp:tr>`;
  const newTblInner = spliceEl(tbl, rows[row], newRow);
  const newTbl = `<hp:tbl${el.attrs}>${newTblInner}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, row, col, set: true };
}

function bumpRowCnt(tblAttrs, delta) {
  const m = tblAttrs.match(/rowCnt="(\d+)"/);
  if (!m) return tblAttrs;
  return tblAttrs.replace(/rowCnt="\d+"/, `rowCnt="${Math.max(0, Number(m[1]) + delta)}"`);
}
function bumpColCnt(tblAttrs, delta) {
  const m = tblAttrs.match(/colCnt="(\d+)"/);
  if (!m) return tblAttrs;
  return tblAttrs.replace(/colCnt="\d+"/, `colCnt="${Math.max(0, Number(m[1]) + delta)}"`);
}

function freshenIds(s) {
  return s.replace(/\bid="\d+"/g, () => `id="${freshId()}"`)
          .replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, '');
}

function opAppendTableRow(doc, tableIndex, cells) {
  const { section, el } = getTable(doc, tableIndex);
  const tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  if (!rows.length) throw new Error('append_table_row: table has no rows to clone');
  const last = rows[rows.length - 1];
  const newRowAddr = (() => {
    const a = last.inner.match(/rowAddr="(\d+)"/);
    return a ? Number(a[1]) + 1 : rows.length;
  })();
  let tcs = scanTopLevel(last.inner, 'hp:tc');
  let ci = 0;
  let newInner = last.inner;
  // Rebuild each cell with the supplied text and a bumped rowAddr.
  let acc = '';
  for (const tc of tcs) {
    const txt = (cells && cells[ci] !== undefined) ? cells[ci] : '';
    ci++;
    let cellInner = setCellInner(tc.inner, txt);
    let newTc = `<hp:tc${tc.attrs}>${cellInner}</hp:tc>`;
    newTc = newTc.replace(/(<hp:cellAddr [^>]*rowAddr=")\d+(")/,(m,a,b)=>a+newRowAddr+b);
    newTc = freshenIds(newTc);
    acc += newTc;
  }
  const newRow = `<hp:tr${last.attrs}>${acc}</hp:tr>`;
  const newTblInner = tbl + newRow; // append after last row (rows are last children before metadata? tbl puts trs at end)
  // Safer: insert right after the last </hp:tr>.
  const insertAt = tbl.lastIndexOf('</hp:tr>') + '</hp:tr>'.length;
  const finalInner = tbl.slice(0, insertAt) + newRow + tbl.slice(insertAt);
  const newTbl = `<hp:tbl${bumpRowCnt(el.attrs, +1)}>${finalInner}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, appendedCols: tcs.length };
}

function opDeleteTableRow(doc, tableIndex, row) {
  const { section, el } = getTable(doc, tableIndex);
  const tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  if (row < 0 || row >= rows.length) throw new Error(`delete_table_row: row ${row} out of range (0..${rows.length - 1})`);
  const newInner = spliceEl(tbl, rows[row], '');
  const newTbl = `<hp:tbl${bumpRowCnt(el.attrs, -1)}>${newInner}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, row, deleted: true, remaining: rows.length - 1 };
}

function opAppendTableColumn(doc, tableIndex, cells) {
  const { section, el } = getTable(doc, tableIndex);
  let tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  // Rebuild from the end so earlier ranges stay valid.
  for (let r = rows.length - 1; r >= 0; r--) {
    const rowEl = rows[r];
    const tcs = scanTopLevel(rowEl.inner, 'hp:tc');
    if (!tcs.length) continue;
    const lastTc = tcs[tcs.length - 1];
    const newColAddr = (() => {
      const a = lastTc.inner.match(/colAddr="(\d+)"/);
      return a ? Number(a[1]) + 1 : tcs.length;
    })();
    let cellInner = setCellInner(lastTc.inner, (cells && cells[r] !== undefined) ? cells[r] : '');
    let newTc = `<hp:tc${lastTc.attrs}>${cellInner}</hp:tc>`;
    newTc = newTc.replace(/(<hp:cellAddr [^>]*colAddr=")\d+(")/,(m,a,b)=>a+newColAddr+b);
    newTc = freshenIds(newTc);
    const insertAt = rowEl.inner.lastIndexOf('</hp:tc>') + '</hp:tc>'.length;
    const newRowInner = rowEl.inner.slice(0, insertAt) + newTc + rowEl.inner.slice(insertAt);
    const newRow = `<hp:tr${rowEl.attrs}>${newRowInner}</hp:tr>`;
    tbl = spliceEl(tbl, rowEl, newRow);
  }
  const newTbl = `<hp:tbl${bumpColCnt(el.attrs, +1)}>${tbl}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, rows: rows.length };
}

function opDeleteTableColumn(doc, tableIndex, col) {
  const { section, el } = getTable(doc, tableIndex);
  let tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  let affected = 0;
  for (let r = rows.length - 1; r >= 0; r--) {
    const rowEl = rows[r];
    const tcs = scanTopLevel(rowEl.inner, 'hp:tc');
    if (col < 0 || col >= tcs.length) continue;
    const newRowInner = spliceEl(rowEl.inner, tcs[col], '');
    const newRow = `<hp:tr${rowEl.attrs}>${newRowInner}</hp:tr>`;
    tbl = spliceEl(tbl, rowEl, newRow);
    affected++;
  }
  const newTbl = `<hp:tbl${bumpColCnt(el.attrs, -1)}>${tbl}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, col, rowsAffected: affected };
}

function opMergeCells(doc, tableIndex, mode, opts) {
  const { section, el } = getTable(doc, tableIndex);
  let tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  const setSpan = (tcAttrsAndInner, spanAttr, n) => {
    // cellSpan lives as <hp:cellSpan colSpan=".." rowSpan=".."/> inside the tc.
    if (new RegExp(`${spanAttr}="\\d+"`).test(tcAttrsAndInner)) {
      return tcAttrsAndInner.replace(new RegExp(`${spanAttr}="\\d+"`), `${spanAttr}="${n}"`);
    }
    return tcAttrsAndInner.replace(/<hp:cellSpan /, `<hp:cellSpan ${spanAttr}="${n}" `);
  };
  if (mode === 'horizontal') {
    const { row, start, count } = opts;
    if (count < 2) throw new Error('merge_cells horizontal: count must be >= 2');
    const rowEl = rows[row];
    if (!rowEl) throw new Error(`merge_cells: row ${row} out of range`);
    const tcs = scanTopLevel(rowEl.inner, 'hp:tc');
    if (start < 0 || start + count > tcs.length) throw new Error('merge_cells horizontal: range out of bounds');
    let inner = rowEl.inner;
    // Remove absorbed cells from the end first.
    for (let i = count - 1; i >= 1; i--) inner = spliceEl(inner, scanTopLevel(inner, 'hp:tc')[start + i], '');
    const firstTcs = scanTopLevel(inner, 'hp:tc');
    const merged = setSpan(`<hp:tc${firstTcs[start].attrs}>${firstTcs[start].inner}</hp:tc>`, 'colSpan', count);
    inner = spliceEl(inner, firstTcs[start], merged);
    const newRow = `<hp:tr${rowEl.attrs}>${inner}</hp:tr>`;
    tbl = spliceEl(tbl, rowEl, newRow);
  } else if (mode === 'vertical') {
    const { col, start, count } = opts;
    if (count < 2) throw new Error('merge_cells vertical: count must be >= 2');
    if (start < 0 || start + count > rows.length) throw new Error('merge_cells vertical: range out of bounds');
    // Remove the cell at `col` from rows start+1..start+count-1 (bottom-up).
    for (let i = count - 1; i >= 1; i--) {
      const rEl = scanTopLevel(tbl, 'hp:tr')[start + i];
      const tcs = scanTopLevel(rEl.inner, 'hp:tc');
      if (col < tcs.length) {
        const newRow = `<hp:tr${rEl.attrs}>${spliceEl(rEl.inner, tcs[col], '')}</hp:tr>`;
        tbl = spliceEl(tbl, rEl, newRow);
      }
    }
    const firstREl = scanTopLevel(tbl, 'hp:tr')[start];
    const tcs = scanTopLevel(firstREl.inner, 'hp:tc');
    if (!tcs[col]) throw new Error(`merge_cells vertical: col ${col} out of range`);
    const merged = setSpan(`<hp:tc${tcs[col].attrs}>${tcs[col].inner}</hp:tc>`, 'rowSpan', count);
    const newRow = `<hp:tr${firstREl.attrs}>${spliceEl(firstREl.inner, tcs[col], merged)}</hp:tr>`;
    tbl = spliceEl(tbl, firstREl, newRow);
  } else {
    throw new Error(`merge_cells: unknown mode "${mode}" (use "horizontal" or "vertical")`);
  }
  const newTbl = `<hp:tbl${el.attrs}>${dropLinesegs(tbl)}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, mode, merged: opts.count };
}

// Insert a brand-new table (rows × cols) as a fresh paragraph at `index`.
// Hancom Docs is strict about table validity — every required inner element
// (cellAddr, cellSpan, cellSz, cellMargin, subList, etc.) must be present in
// the exact shape it expects. Hand-rolling that envelope from scratch tends to
// produce docs that the lenient renderer opens and Hancom Docs rejects, so we
// clone the first existing tbl in the document as the template and rebuild it
// at the requested size — same trick used by `buildPic` for images.
//
// Requires the source doc to already contain at least one table; throws a
// clear error otherwise (in that case open a doc with any table, copy it in,
// or use the bundled template doc).
function opInsertTable(doc, index, rows, cols, cells) {
  if (!Number.isInteger(rows) || rows < 1) throw new Error('insert_table: rows must be a positive integer');
  if (!Number.isInteger(cols) || cols < 1) throw new Error('insert_table: cols must be a positive integer');

  const tables = doc.tables();
  if (!tables.length) throw new Error('insert_table: no table to clone as a template — base doc must contain at least one existing table');

  const srcTbl = tables[0];
  const srcSection = srcTbl.section;
  const srcXml = doc.read(srcSection);

  // Find the enclosing top-level paragraph of the source table.
  const paras = scanTopLevel(srcXml, 'hp:p');
  const srcPara = paras.find((p) => p.start <= srcTbl.el.start && p.end >= srcTbl.el.end);
  if (!srcPara) throw new Error('insert_table: source table is not inside a top-level paragraph (unexpected)');

  // Pick a body cell as the template. Row 0 is usually a styled header
  // (grey fill in most government / report templates), so prefer row 1's
  // first cell when the source has more than one row — gives a clean
  // white-background body cell by default. Fall back to row 0 for
  // single-row source tables.
  const srcRows = scanTopLevel(srcTbl.el.inner, 'hp:tr');
  if (!srcRows.length) throw new Error('insert_table: source table has no rows');
  const templateRow = srcRows.length >= 2 ? srcRows[1] : srcRows[0];
  const srcTcs = scanTopLevel(templateRow.inner, 'hp:tc');
  if (!srcTcs.length) throw new Error('insert_table: source row has no cells');
  const cellTemplate = srcTcs[0];

  // Build cells row-by-row.
  const builtRows = [];
  for (let r = 0; r < rows; r++) {
    const cellStrs = [];
    for (let c = 0; c < cols; c++) {
      const text = (cells && cells[r] && cells[r][c] !== undefined) ? cells[r][c] : '';
      let cellInner = setCellInner(cellTemplate.inner, text);
      // cellAddr → (r, c)
      if (/<hp:cellAddr\b/.test(cellInner)) {
        cellInner = cellInner.replace(/<hp:cellAddr\s+[^>]*\/?>/, `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/>`);
      } else {
        cellInner = cellInner.replace(/<\/hp:subList>/, `</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/>`);
      }
      // cellSpan → 1×1 (drop any inherited merge)
      if (/<hp:cellSpan\b/.test(cellInner)) {
        cellInner = cellInner.replace(/<hp:cellSpan\s+[^>]*\/?>/, '<hp:cellSpan colSpan="1" rowSpan="1"/>');
      }
      let tc = `<hp:tc${cellTemplate.attrs}>${cellInner}</hp:tc>`;
      tc = freshenIds(tc);
      cellStrs.push(tc);
    }
    builtRows.push(`<hp:tr${templateRow.attrs}>${cellStrs.join('')}</hp:tr>`);
  }

  // Keep the source tbl's pre-row metadata (hp:sz, hp:pos, hp:outMargin,
  // hp:inMargin) — these sit before the first <hp:tr>.
  const firstTrIdx = srcTbl.el.inner.indexOf('<hp:tr');
  const tblMeta = firstTrIdx >= 0 ? srcTbl.el.inner.slice(0, firstTrIdx) : '';

  let newTblAttrs = srcTbl.el.attrs;
  if (/rowCnt="\d+"/.test(newTblAttrs)) newTblAttrs = newTblAttrs.replace(/rowCnt="\d+"/, `rowCnt="${rows}"`);
  else newTblAttrs = ` rowCnt="${rows}"` + newTblAttrs;
  if (/colCnt="\d+"/.test(newTblAttrs)) newTblAttrs = newTblAttrs.replace(/colCnt="\d+"/, `colCnt="${cols}"`);
  else newTblAttrs = ` colCnt="${cols}"` + newTblAttrs;

  const newTbl = `<hp:tbl${newTblAttrs}>${tblMeta}${builtRows.join('')}</hp:tbl>`;

  // Splice newTbl into a clone of the source paragraph (preserve its run /
  // ctrl wrapping, which Hancom requires for body tables).
  const tblOffsetInPara = srcTbl.el.start - srcPara.openEnd;
  const tblLen = srcTbl.el.end - srcTbl.el.start;
  const paraInnerWithNewTbl =
    srcPara.inner.slice(0, tblOffsetInPara) + newTbl + srcPara.inner.slice(tblOffsetInPara + tblLen);
  let newParaAttrs = srcPara.attrs.replace(/\sid="\d+"/, ` id="${freshId()}"`);
  const newPara = `<hp:p${newParaAttrs}>${dropLinesegs(paraInnerWithNewTbl)}</hp:p>`;

  // Inject at the target paragraph index (global, ordered across sections).
  // index === -1 prepends at the start of the first section's body.
  const allParas = doc.paragraphs();
  if (!Number.isInteger(index) || index < -1 || index >= allParas.length) {
    throw new Error(`insert_table: index ${index} out of range (-1..${allParas.length - 1}; -1 to prepend)`);
  }
  if (index === -1) {
    const firstSec = doc.sectionNames()[0];
    let xml = doc.read(firstSec);
    const firstP = xml.match(/<hp:p(\s|>)/);
    if (firstP) xml = xml.slice(0, firstP.index) + newPara + xml.slice(firstP.index);
    else xml = xml.replace(/<\/hs:sec>/, newPara + '</hs:sec>');
    doc.write(firstSec, xml);
  } else {
    const target = allParas[index];
    const xml = doc.read(target.section);
    doc.write(target.section, xml.slice(0, target.el.end) + newPara + xml.slice(target.el.end));
  }
  return { inserted: true, rows, cols, afterIndex: index };
}

// ── style operations (clone-mutate-retarget in header.xml) ───────────────────

// Point the <hp:run> that actually CONTAINS the first <hp:t> holding `target`
// at a new charPrIDRef. Returns the rewritten xml, or null if not found.
// Uses a balanced run scan (not lastIndexOf) so an empty self-closing
// <hp:run/> sitting just before the text node isn't mistaken for its parent —
// the bug that styled an empty run and left the visible text unchanged.
function retargetRunForText(xml, target, newId) {
  const tRe = new RegExp(`<hp:t(?:\\s[^>]*)?>[^<]*${escapeRegex(target)}`);
  for (const r of scanTopLevel(xml, 'hp:run')) {
    if (r.selfClosing) continue;          // empty run, not a text container
    if (r.inner.includes('<hp:tbl')) continue; // a table-wrapping run, not a leaf text run
    if (!tRe.test(r.inner)) continue;
    const newOpen = /charPrIDRef="\d+"/.test(r.attrs)
      ? r.attrs.replace(/charPrIDRef="\d+"/, `charPrIDRef="${newId}"`)
      : ` charPrIDRef="${newId}"${r.attrs}`;
    return xml.slice(0, r.start) + `<hp:run${newOpen}>` + r.inner + '</hp:run>' + xml.slice(r.end);
  }
  return null;
}

function opApplyTextStyle(doc, target, style) {
  const headerName = doc.headerName();
  if (!headerName) throw new Error('apply_text_style: Contents/header.xml missing');
  const header = doc.read(headerName);
  const charPrs = scanTopLevel(header, 'hh:charPr');
  if (!charPrs.length) throw new Error('apply_text_style: no <hh:charPr> in header.xml');
  const newId = String(Math.max(...charPrs.map((c) => Number(getAttr(c.attrs, 'id') || 0))) + 1);

  // Retarget first — if the text isn't present, don't pollute header.xml.
  let hitSection = null, hitXml = null;
  for (const name of doc.sectionNames()) {
    const next = retargetRunForText(doc.read(name), target, newId);
    if (next) { hitSection = name; hitXml = next; break; }
  }
  if (!hitSection) return { target, retargeted: 0 };

  // Clone charPr[0] → mutate → append to header.
  const base = charPrs[0];
  let attrs = base.attrs.replace(/\s*id="\d+"/, ` id="${newId}"`);
  let inner = base.inner;
  if (style.size) attrs = setOrAddAttr(attrs, 'height', String(style.size));
  if (style.color) attrs = setOrAddAttr(attrs, 'textColor', `#${String(style.color).replace(/^#/, '')}`);
  if (style.bold !== undefined) inner = toggleChild(inner, 'hh:bold', style.bold);
  if (style.italic !== undefined) inner = toggleChild(inner, 'hh:italic', style.italic);
  if (style.underline !== undefined) {
    inner = style.underline
      ? ensureChild(inner, '<hh:underline type="BOTTOM" shape="SOLID" color="#000000"/>', 'hh:underline')
      : inner.replace(/<hh:underline[^>]*\/>/g, '');
  }
  if (style.highlight !== undefined) {
    // true → yellow (#FFFF00); false / null → 'none'; hex string → that color.
    const c = style.highlight === true ? '#FFFF00'
            : (style.highlight === false || style.highlight === null) ? 'none'
            : `#${String(style.highlight).replace(/^#/, '')}`;
    attrs = setOrAddAttr(attrs, 'shadeColor', c);
  }
  if (style.strikethrough !== undefined) {
    const shape = style.strikethrough ? 'SOLID' : 'NONE';
    const so = `<hh:strikeout shape="${shape}" color="#000000"/>`;
    inner = /<hh:strikeout\b[^>]*\/>/.test(inner)
      ? inner.replace(/<hh:strikeout\b[^>]*\/>/, so)
      : inner + so;
  }
  const newCharPr = `<hh:charPr${attrs}>${inner}</hh:charPr>`;
  let h2 = spliceEl(header, base, `<hh:charPr${base.attrs}>${base.inner}</hh:charPr>` + newCharPr);
  h2 = bumpListCount(h2, 'hh:charProperties', +1);
  doc.write(headerName, h2);
  doc.write(hitSection, dropLinesegs(hitXml));
  return { target, charPrId: newId, retargeted: 1 };
}

function opApplyParagraphStyle(doc, index, style) {
  const headerName = doc.headerName();
  if (!headerName) throw new Error('apply_paragraph_style: Contents/header.xml missing');
  let header = doc.read(headerName);
  const paraPrs = scanTopLevel(header, 'hh:paraPr');
  if (!paraPrs.length) throw new Error('apply_paragraph_style: no <hh:paraPr> in header.xml');
  const maxId = Math.max(...paraPrs.map((c) => Number(getAttr(c.attrs, 'id') || 0)));
  const newId = String(maxId + 1);
  const base = paraPrs[0];
  let mutAttrs = base.attrs.replace(/\s*id="\d+"/, ` id="${newId}"`);
  let mutInner = base.inner;
  if (style.align) {
    if (/<hh:align [^>]*\/>/.test(mutInner)) mutInner = mutInner.replace(/<hh:align [^>]*\/>/, `<hh:align horizontal="${style.align}" vertical="BASELINE"/>`);
    else mutInner = `<hh:align horizontal="${style.align}" vertical="BASELINE"/>` + mutInner;
  }
  if (style.lineSpacing !== undefined) {
    const ls = `<hh:lineSpacing type="PERCENT" value="${style.lineSpacing}" unit="HWPUNIT"/>`;
    mutInner = /<hh:lineSpacing[^>]*\/>/.test(mutInner) ? mutInner.replace(/<hh:lineSpacing[^>]*\/>/, ls) : ls + mutInner;
  }
  if (style.indent !== undefined) {
    mutInner = mutInner.replace(/(<hh:intent unit="[^"]*" value=")[-\d]+(")/, (m, a, b) => a + style.indent + b);
  }
  const newParaPr = `<hh:paraPr${mutAttrs}>${mutInner}</hh:paraPr>`;
  header = spliceEl(header, base, `<hh:paraPr${base.attrs}>${base.inner}</hh:paraPr>` + newParaPr);
  header = bumpListCount(header, 'hh:paraProperties', +1);
  doc.write(headerName, header);
  // Retarget the Nth body paragraph.
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`apply_paragraph_style: index ${index} out of range`);
  const { section, el } = paras[index];
  const newOpen = el.attrs.replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${newId}"`);
  const rebuilt = `<hp:p${newOpen}>${dropLinesegs(el.inner)}</hp:p>`;
  doc.write(section, spliceEl(doc.read(section), el, rebuilt));
  return { index, paraPrId: newId };
}

// Increment itemCnt="N" on the named OWPML list wrapper (e.g. hh:charPrList),
// so Hancom's strict reader doesn't ignore an appended definition.
function bumpListCount(header, listTag, delta) {
  const re = new RegExp(`(<${listTag.replace(/:/g, '\\:')}\\b[^>]*itemCnt=")(\\d+)(")`);
  return header.replace(re, (m, a, n, b) => a + (Number(n) + delta) + b);
}

function setOrAddAttr(attrs, name, value) {
  if (new RegExp(`${name}="[^"]*"`).test(attrs)) return attrs.replace(new RegExp(`${name}="[^"]*"`), `${name}="${value}"`);
  return ` ${name}="${value}"` + attrs.replace(/^\s*/, ' ');
}
function toggleChild(inner, tag, on) {
  const has = new RegExp(`<${tag.replace(/:/g, '\\:')}\\b[^>]*/?>`).test(inner);
  if (on && !has) return `<${tag}/>` + inner;
  if (!on && has) return inner.replace(new RegExp(`<${tag.replace(/:/g, '\\:')}\\b[^>]*/?>`, 'g'), '');
  return inner;
}
function ensureChild(inner, snippet, tag) {
  const has = new RegExp(`<${tag.replace(/:/g, '\\:')}\\b`).test(inner);
  return has ? inner : snippet + inner;
}

// ── image operations ─────────────────────────────────────────────────────────

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', gif: 'image/gif' };

function findBinEntry(doc, target) {
  const full = target.includes('/') ? target : `BinData/${target}`;
  const names = Object.keys(doc.files).filter((n) => /^BinData\//i.test(n));
  return names.find((n) => n === full || n.endsWith('/' + target) || n === target) || null;
}

function opReplaceImage(doc, target, sourcePath) {
  const entry = findBinEntry(doc, target);
  if (!entry) throw new Error(`replace_image: target not found in BinData/: ${target}`);
  doc.files[entry] = new Uint8Array(fs.readFileSync(sourcePath));
  return { entry, bytes: doc.files[entry].byteLength };
}

function opDeleteImage(doc, target) {
  const entry = findBinEntry(doc, target);
  if (!entry) throw new Error(`delete_image: target not found in BinData/: ${target}`);
  // Resolve the manifest item id bound to this entry so we can also remove the
  // inline <hp:pic> that references it — otherwise the doc keeps a dangling
  // image reference (the bug in treesoop's delete: bytes gone, ref left).
  let itemId = null;
  const hpf = doc.hpfName();
  if (hpf) {
    let s = doc.read(hpf);
    const im = s.match(new RegExp(`<opf:item [^>]*id="([^"]+)"[^>]*href="${escapeRegex(entry)}"[^>]*/>|<opf:item [^>]*href="${escapeRegex(entry)}"[^>]*id="([^"]+)"[^>]*/>`));
    if (im) itemId = im[1] || im[2];
    s = s.replace(new RegExp(`<opf:item [^>]*href="${escapeRegex(entry)}"[^>]*/>`), '');
    doc.write(hpf, s);
  }
  let picsRemoved = 0;
  if (itemId) {
    for (const name of doc.sectionNames()) {
      let xml = doc.read(name);
      const pics = scanTopLevel(xml, 'hp:pic');
      let touched = false;
      // Splice from the end so earlier ranges stay valid.
      for (let i = pics.length - 1; i >= 0; i--) {
        if (new RegExp(`binaryItemIDRef="${escapeRegex(itemId)}"`).test(pics[i].inner)) {
          xml = spliceEl(xml, pics[i], '');
          picsRemoved++;
          touched = true;
        }
      }
      if (touched) doc.write(name, dropLinesegs(xml));
    }
  }
  delete doc.files[entry];
  return { entry, itemId, picsRemoved, deleted: true };
}

function opInsertImage(doc, sourcePath, ext, width, height) {
  ext = (ext || path.extname(sourcePath).slice(1) || 'png').toLowerCase();
  if (!MIME[ext]) throw new Error(`insert_image: unsupported ext .${ext} (png/jpg/bmp/gif)`);
  const existing = Object.keys(doc.files).filter((n) => /^BinData\//i.test(n));
  // itemId must be unique against existing manifest ids, not just filenames.
  const usedIds = new Set();
  const hpfPeek = doc.hpfName();
  if (hpfPeek) for (const m of doc.read(hpfPeek).matchAll(/<opf:item [^>]*id="([^"]+)"/g)) usedIds.add(m[1]);
  let n = 1;
  while (existing.some((p) => p.endsWith(`/image${n}.${ext}`) || p.endsWith(`/img${n}.${ext}`)) || usedIds.has(`image${n}`)) n++;
  const entry = `BinData/image${n}.${ext}`;
  const itemId = `image${n}`;
  doc.files[entry] = new Uint8Array(fs.readFileSync(sourcePath));
  // manifest
  const hpf = doc.hpfName();
  if (hpf) {
    let s = doc.read(hpf);
    if (!s.includes(`href="${entry}"`)) {
      s = s.replace(/<\/opf:manifest>/, `<opf:item id="${itemId}" href="${entry}" media-type="${MIME[ext]}" isEmbeded="1"/></opf:manifest>`);
      doc.write(hpf, s);
    }
  }
  const names = doc.sectionNames();
  const last = names[names.length - 1];
  let xml = doc.read(last);
  const paras = scanTopLevel(xml, 'hp:p');
  const charPrId = paras.length ? (paras[paras.length - 1].inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1] : '0';
  const attrs = paras.length ? paras[paras.length - 1].attrs.replace(/\s*id="\d+"/, ` id="${freshId()}"`) : ` id="${freshId()}" paraPrIDRef="0" styleIDRef="0"`;
  const pic = buildPic(doc, itemId, width, height);
  const para = `<hp:p${attrs}><hp:run charPrIDRef="${charPrId}">${pic}</hp:run></hp:p>`;
  xml = /<\/hs:sec>\s*$/.test(xml) ? xml.replace(/<\/hs:sec>\s*$/, para + '</hs:sec>') : xml + para;
  doc.write(last, xml);
  return { entry, itemId, inserted: true };
}

// Build an inline <hp:pic> for a freshly-added image. Hancom Docs validates the
// shape schema strictly (requires hp:renderingInfo, hp:shapeComment; rejects a
// stray hp:caption), so we CLONE an existing pic from the document when one is
// present — guaranteed-valid structure — and only repoint its binary ref + ids.
// Falls back to a schema-complete template when the doc has no images yet.
function buildPic(doc, itemId, width, height) {
  for (const name of doc.sectionNames()) {
    const pics = scanTopLevel(doc.read(name), 'hp:pic');
    if (pics.length) {
      const xml = doc.read(name);
      let pic = xml.slice(pics[0].start, pics[0].end);
      pic = pic
        .replace(/binaryItemIDRef="[^"]*"/, `binaryItemIDRef="${itemId}"`)
        .replace(/\bid="\d+"/, `id="${freshId()}"`)
        .replace(/\binstid="\d+"/, `instid="${freshId()}"`);
      return pic;
    }
  }
  const w = width || 28350, h = height || 28350; // ~100mm fallback
  return `<hp:pic id="${freshId()}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${freshId()}" reverse="0">`
    + `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/>`
    + `<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="0" centerY="0" rotateimage="1"/>`
    + `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>`
    + `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>`
    + `<hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:imgDim dimwidth="${w}" dimheight="${h}"/>`
    + `<hc:img binaryItemIDRef="${itemId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>`
    + `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>inserted image</hp:shapeComment>`
    + `</hp:pic>`;
}

// ── header / footer operations ───────────────────────────────────────────────

// HWPX models headers and footers as control elements embedded in body XML:
// <hp:p><hp:run charPrIDRef="..."><hp:ctrl>
//   <hp:header id="0" applyPageType="BOTH"> | <hp:footer ...>
//     <hp:subList ...><hp:p ...><hp:run ...><hp:t>대외주의</hp:t></hp:run></hp:p></hp:subList>
//   </hp:header>
// </hp:ctrl></hp:run></hp:p>
//
// set: update existing one's text + applyPageType, or insert a new wrapper
//      paragraph right after the section's first <hp:p> (which holds <hp:secPr>).
// remove: drop the <hp:run> hosting the <hp:ctrl><hp:header/footer>; leave the
//         enclosing paragraph in place (it may have other content).

const VALID_APPLY = new Set(['BOTH', 'EVEN', 'ODD']);

function opSetHeaderFooter(doc, kind, text, applyPageType) {
  const tag = `hp:${kind}`;
  const apply = String(applyPageType || 'BOTH').toUpperCase();
  if (!VALID_APPLY.has(apply)) throw new Error(`set_${kind}: applyPageType must be one of BOTH/EVEN/ODD`);

  // Update first existing instance anywhere across sections.
  for (const name of doc.sectionNames()) {
    const xml = doc.read(name);
    const els = scanTopLevel(xml, tag);
    if (!els.length) continue;
    const el = els[0];
    const newInner = setCellInner(el.inner, text); // header/footer share subList>p>run>t shape with cells
    let attrs = el.attrs;
    attrs = /applyPageType="[^"]*"/.test(attrs)
      ? attrs.replace(/applyPageType="[^"]*"/, `applyPageType="${apply}"`)
      : `${attrs} applyPageType="${apply}"`;
    const replacement = `<${tag}${attrs}>${newInner}</${tag}>`;
    doc.write(name, dropLinesegs(spliceEl(xml, el, replacement)));
    return { kind, applyPageType: apply, updated: true };
  }

  // None present — insert into the first section after its first body paragraph.
  const firstSec = doc.sectionNames()[0];
  if (!firstSec) throw new Error(`set_${kind}: no Contents/section*.xml found`);
  let xml = doc.read(firstSec);
  const paras = scanTopLevel(xml, 'hp:p');
  if (!paras.length) throw new Error(`set_${kind}: no <hp:p> in first section to anchor insertion`);
  const wrapper =
    `<hp:p id="${freshId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
      `<hp:run charPrIDRef="0">` +
        `<hp:ctrl>` +
          `<${tag} id="0" applyPageType="${apply}">` +
            `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
              `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
                `<hp:run charPrIDRef="0"><hp:t>${xmlEscape(text)}</hp:t></hp:run>` +
              `</hp:p>` +
            `</hp:subList>` +
          `</${tag}>` +
        `</hp:ctrl>` +
      `</hp:run>` +
    `</hp:p>`;
  const insertAt = paras[0].end;
  doc.write(firstSec, dropLinesegs(xml.slice(0, insertAt) + wrapper + xml.slice(insertAt)));
  return { kind, applyPageType: apply, inserted: true };
}

function opRemoveHeaderFooter(doc, kind) {
  const tag = `hp:${kind}`;
  let removed = 0;
  for (const name of doc.sectionNames()) {
    let xml = doc.read(name);
    if (!xml.includes(`<${tag}`)) continue;
    const runs = scanTopLevel(xml, 'hp:run');
    let changed = false;
    // Splice from the end so earlier offsets remain valid.
    for (let i = runs.length - 1; i >= 0; i--) {
      if (!runs[i].self && runs[i].inner.includes(`<${tag}`)) {
        xml = spliceEl(xml, runs[i], '');
        removed++;
        changed = true;
      }
    }
    if (changed) doc.write(name, dropLinesegs(xml));
  }
  return { kind, removed };
}

// ── footnote / endnote operations ────────────────────────────────────────────

// Footnotes (각주) and endnotes (미주) are ctrl-embedded notes — same envelope
// shape as headers/footers (<hp:run><hp:ctrl><hp:footNote|endNote ...>subList>
// p>run>t). The reference marker (¹ ²) and bottom-of-page placement are
// rendered by Hancom from the control's position; we only place the control
// at the end of the target body paragraph.
//
// Note: rhwp's .hwp→.hwpx conversion drops actual notes (only emits the
// <hp:footNotePr> style declaration), so we can't clone a known-good real
// example — the template below follows the OWPML envelope used by the other
// ctrl elements in this skill and reuses safe default refs (id=0).

function opInsertNote(doc, kind, paragraphIndex, text) {
  const tag = `hp:${kind}`; // "footNote" or "endNote"
  const paras = doc.paragraphs();
  if (paragraphIndex < 0 || paragraphIndex >= paras.length) {
    throw new Error(`insert_${kind === 'footNote' ? 'footnote' : 'endnote'}: paragraph index ${paragraphIndex} out of range (0..${paras.length - 1})`);
  }
  const { section, el } = paras[paragraphIndex];
  const charPrId = (el.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const noteRun =
    `<hp:run charPrIDRef="${charPrId}">` +
      `<hp:ctrl>` +
        `<${tag} id="0">` +
          `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
            `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
              `<hp:run charPrIDRef="0"><hp:t>${xmlEscape(text)}</hp:t></hp:run>` +
            `</hp:p>` +
          `</hp:subList>` +
        `</${tag}>` +
      `</hp:ctrl>` +
    `</hp:run>`;
  const rebuilt = `<hp:p${el.attrs}>${el.inner + noteRun}</hp:p>`;
  doc.write(section, dropLinesegs(spliceEl(doc.read(section), el, rebuilt)));
  return { kind: kind === 'footNote' ? 'footnote' : 'endnote', index: paragraphIndex, inserted: true };
}

// ── hyperlink ────────────────────────────────────────────────────────────────

// HWPX models a hyperlink as a paired Hancom *field* embedded in a run:
// <hp:run>
//   <hp:ctrl><hp:fieldBegin id=B type="HYPERLINK" fieldid=F>
//              <hp:parameters cnt=6>… Path/Command/Category/TargetType/DocOpenType …</hp:parameters>
//            </hp:fieldBegin></hp:ctrl>
//   <hp:t>표시 텍스트</hp:t>
//   <hp:ctrl><hp:fieldEnd beginIDRef=B fieldid=F/></hp:ctrl>
// </hp:run>
// Template here mirrors a real government-doc instance verbatim (only the URL,
// display text, and id pair vary). Hancom renders the run's <hp:t> as a
// clickable link.
function opInsertHyperlink(doc, paragraphIndex, url, text) {
  if (!url) throw new Error('insert_hyperlink: "url" is required');
  if (!text) throw new Error('insert_hyperlink: "text" (display label) is required');
  const paras = doc.paragraphs();
  if (paragraphIndex < 0 || paragraphIndex >= paras.length) {
    throw new Error(`insert_hyperlink: paragraph index ${paragraphIndex} out of range (0..${paras.length - 1})`);
  }
  const { section, el } = paras[paragraphIndex];
  const charPrId = (el.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const beginId = freshId();
  const fieldid = freshId();
  const u = xmlEscape(url);
  const run =
    `<hp:run charPrIDRef="${charPrId}">` +
      `<hp:ctrl>` +
        `<hp:fieldBegin id="${beginId}" type="HYPERLINK" name="" editable="0" dirty="1" zorder="-1" fieldid="${fieldid}">` +
          `<hp:parameters cnt="6" name="">` +
            `<hp:integerParam name="Prop">0</hp:integerParam>` +
            `<hp:stringParam name="Command">${u};1;0;0;</hp:stringParam>` +
            `<hp:stringParam name="Path">${u}</hp:stringParam>` +
            `<hp:stringParam name="Category">HWPHYPERLINK_TYPE_URL</hp:stringParam>` +
            `<hp:stringParam name="TargetType">HWPHYPERLINK_TARGET_BOOKMARK</hp:stringParam>` +
            `<hp:stringParam name="DocOpenType">HWPHYPERLINK_JUMP_CURRENTTAB</hp:stringParam>` +
          `</hp:parameters>` +
        `</hp:fieldBegin>` +
      `</hp:ctrl>` +
      `<hp:t>${xmlEscape(text)}</hp:t>` +
      `<hp:ctrl><hp:fieldEnd beginIDRef="${beginId}" fieldid="${fieldid}"/></hp:ctrl>` +
    `</hp:run>`;
  const rebuilt = `<hp:p${el.attrs}>${el.inner + run}</hp:p>`;
  doc.write(section, dropLinesegs(spliceEl(doc.read(section), el, rebuilt)));
  return { index: paragraphIndex, url, text, beginId, fieldid, inserted: true };
}

// ── field operation ──────────────────────────────────────────────────────────

function opSetFieldValue(doc, name, value) {
  let done = 0;
  for (const sec of doc.sectionNames()) {
    if (done) break;
    let xml = doc.read(sec);
    const beginRe = new RegExp(`<hp:fldBegin[^>]*name="${escapeRegex(name)}"[^>]*/?>`);
    const bm = beginRe.exec(xml);
    if (!bm) continue;
    const after = bm.index + bm[0].length;
    const endRe = /<hp:fldEnd[^>]*\/?>/g; endRe.lastIndex = after;
    const em = endRe.exec(xml);
    if (!em) continue;
    const between = xml.slice(after, em.index).replace(/<hp:t>[^<]*<\/hp:t>/, `<hp:t>${xmlEscape(value)}</hp:t>`);
    doc.write(sec, xml.slice(0, after) + between + xml.slice(em.index));
    done = 1;
  }
  return { name, value, set: done };
}

// ── dispatch ─────────────────────────────────────────────────────────────────

function applyOp(doc, op) {
  switch (op.type) {
    case 'replace_text': return opReplaceText(doc, op.find, op.replace);
    case 'fill_template': return opFillTemplate(doc, op.values);
    case 'set_paragraph_text': return opSetParagraphText(doc, op.index, op.text);
    case 'append_paragraph': return opAppendParagraph(doc, op.text);
    case 'delete_paragraph': return opDeleteParagraph(doc, op.index);
    case 'set_cell_text': return opSetCellText(doc, op.table, op.row, op.col, op.text);
    case 'append_table_row': return opAppendTableRow(doc, op.table, op.cells);
    case 'delete_table_row': return opDeleteTableRow(doc, op.table, op.row);
    case 'append_table_column': return opAppendTableColumn(doc, op.table, op.cells);
    case 'delete_table_column': return opDeleteTableColumn(doc, op.table, op.col);
    case 'merge_cells': return opMergeCells(doc, op.table, op.mode, op);
    case 'insert_table': return opInsertTable(doc, op.index, op.rows, op.cols, op.cells);
    case 'apply_text_style': return opApplyTextStyle(doc, op.target, op);
    case 'apply_paragraph_style': return opApplyParagraphStyle(doc, op.index, op);
    case 'insert_image': return opInsertImage(doc, op.source, op.ext, op.width, op.height);
    case 'replace_image': return opReplaceImage(doc, op.target, op.source);
    case 'delete_image': return opDeleteImage(doc, op.target);
    case 'set_field_value': return opSetFieldValue(doc, op.name, op.value);
    case 'set_header': return opSetHeaderFooter(doc, 'header', op.text, op.applyPageType);
    case 'set_footer': return opSetHeaderFooter(doc, 'footer', op.text, op.applyPageType);
    case 'remove_header': return opRemoveHeaderFooter(doc, 'header');
    case 'remove_footer': return opRemoveHeaderFooter(doc, 'footer');
    case 'insert_footnote': return opInsertNote(doc, 'footNote', op.index, op.text);
    case 'insert_endnote': return opInsertNote(doc, 'endNote', op.index, op.text);
    case 'insert_hyperlink': return opInsertHyperlink(doc, op.index, op.url, op.text);
    default: throw new Error(`unknown operation type: ${op.type}`);
  }
}

function save(doc, outputPath) {
  // Write dirty text files back into the byte map, then zip.
  for (const name of doc.dirty) doc.files[name] = strToU8(doc.text[name]);
  // mimetype must be the first entry and STORED (uncompressed) per HWPX spec.
  const zippable = {};
  if (doc.files['mimetype']) zippable['mimetype'] = [doc.files['mimetype'], { level: 0 }];
  for (const [name, bytes] of Object.entries(doc.files)) {
    if (name === 'mimetype') continue;
    zippable[name] = bytes;
  }
  const out = zipSync(zippable, { level: 6 });
  fs.writeFileSync(outputPath, out);
}

async function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { fail(`invalid JSON on stdin: ${e.message}`); }
  const inputPath = payload.path;
  if (!inputPath) fail('payload.path is required');
  if (!/\.hwpx$/i.test(inputPath)) fail(`hwpx-edit.js is .hwpx only — got ${path.extname(inputPath)} (use cell-patch.js / convert.js for .hwp)`);
  if (!fs.existsSync(inputPath)) fail(`file not found: ${inputPath}`);
  const bytes = fs.readFileSync(inputPath);
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) fail('not a ZIP-based .hwpx (first bytes are not "PK")');

  const outputPath = payload.output && payload.output.length
    ? payload.output
    : inputPath.replace(/\.hwpx$/i, '_edited.hwpx');

  const doc = new Hwpx(unzipSync(bytes));
  const ops = Array.isArray(payload.operations) ? payload.operations : [];
  const results = [];
  for (let i = 0; i < ops.length; i++) {
    try {
      results.push({ type: ops[i].type, ...applyOp(doc, ops[i]) });
    } catch (e) {
      fail(`operation ${i} (${ops[i] && ops[i].type}) failed: ${e && e.message ? e.message : String(e)}`, { results });
    }
  }
  save(doc, outputPath);
  process.stdout.write(JSON.stringify({ ok: true, output: outputPath, results }, null, 2) + '\n');
}

function fail(message, extra) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...(extra || {}) }, null, 2) + '\n');
  process.exit(1);
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));

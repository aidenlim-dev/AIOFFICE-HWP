# `hwpx-edit.js` operation vocabulary

`scripts/hwpx-edit.js` edits an existing **`.hwpx`** by applying named operations
directly to its OWPML XML (via the vendored `fflate` zip), then repackaging. It
never touches HWP 5.0 binary (`.hwp`) — that path is `cell-patch.js` / Path B.

## Invocation

```bash
echo '{ "path": "in.hwpx", "output": "out.hwpx", "operations": [ ... ] }' \
  | node scripts/hwpx-edit.js
```

- **`path`** (required) — input `.hwpx`. Rejected with a clear error if it isn't a ZIP-based `.hwpx`.
- **`output`** (optional) — defaults to `<input>_edited.hwpx`. Set it equal to `path` to overwrite in place.
- **`operations`** — array applied **in order** in a single load→save.

Returns JSON: `{ "ok": true, "output": "...", "results": [ { "type": ..., ...stats } ] }`.

**Atomic:** if any op throws, **nothing is saved** and the response is
`{ "ok": false, "error": "operation <i> (<type>) failed: ..." }`. Fix the args and re-run the whole batch.

## Indexing model

- **Paragraph index** — 0-based, document order, counting **top-level `<hp:p>`** across all `Contents/section*.xml` (a table-bearing paragraph counts as one). Paragraphs inside table cells are not in this index.
- **Table index** — 0-based, document order, **top-level `<hp:tbl>`** only (a table nested inside a cell is not separately indexed). This differs from a naive "all `<hp:tbl>`" count.
- **row / col** — 0-based within a table. `set_cell_text` targets by `<hp:cellAddr>` (merge-aware) and falls back to positional.

Discover indices with `node scripts/extract_text.js --inspect file.hwpx` (counts) and
`--format markdown` (table contents in order). **Note:** `extract_text.js`'s plain-text
output skips cell content — to locate a specific cell, use `--format markdown` (renders
each table) or rely on `--inspect`'s `cellCount` and open the doc to confirm.

## Operations

### Text

| `type` | Args | Notes |
|--------|------|-------|
| `replace_text` | `find`, `replace` | Replaces inside `<hp:t>` nodes only. A match must sit within one text node — targets split across runs (e.g. "산업"+"AI") are not joined. |
| `fill_template` | `values` (object `{ "{{k}}": "v" }`) | Multiple `replace_text` in one pass. Returns `total` + `perKey`. |
| `set_paragraph_text` | `index`, `text` | Replaces the whole paragraph body with one run (keeps its first `charPrIDRef`). |
| `set_field_value` | `name`, `value` | Sets text inside the first `<hp:fldBegin name=...>`…`<hp:fldEnd>` pair. `set: 0` if no such field. |

### Paragraphs

| `type` | Args | Notes |
|--------|------|-------|
| `append_paragraph` | `text` | Appends to the last section, cloning the last paragraph's para/char refs. |
| `delete_paragraph` | `index` | Removes the Nth top-level paragraph. |

### Tables

| `type` | Args | Notes |
|--------|------|-------|
| `set_cell_text` | `table`, `row`, `col`, `text` | Sets one cell's text. |
| `append_table_row` | `table`, `cells` (string[]) | Clones the last row; fills cells left-to-right; updates `rowCnt`. Inherits the last row's column count. |
| `delete_table_row` | `table`, `row` | Removes a row; updates `rowCnt`. |
| `append_table_column` | `table`, `cells` (string[], top→bottom) | Adds a cell to every row's end; updates `colCnt`. |
| `delete_table_column` | `table`, `col` | Removes the cell at `col` in every row; updates `colCnt`. |
| `merge_cells` | `table`, `mode`, + range | `mode:"horizontal"` → `row`, `start`, `count` (sets `colSpan`); `mode:"vertical"` → `col`, `start`, `count` (sets `rowSpan`). `count >= 2`. Absorbed cells removed. Assumes no prior merge in the range. |

### Styling (clone-mutate-retarget in `header.xml`)

| `type` | Args | Notes |
|--------|------|-------|
| `apply_text_style` | `target`, + any of `color` (hex "FF0000"), `bold`, `italic`, `underline`, `size` (HWP units, 1000≈10pt) | Clones `charPr[0]`, mutates, retargets **only the first run** whose text contains `target`. `retargeted: 1` = styled that one run; `retargeted: 0` = `target` not found (header left untouched). **Restyling every occurrence is not supported** — calling twice re-styles the same first run. To restyle a specific later occurrence, use a longer unique substring as `target`. Bumps `hh:charProperties@itemCnt`. |
| `apply_paragraph_style` | `index`, + any of `align` ("LEFT"/"CENTER"/"RIGHT"/"JUSTIFY"/"DISTRIBUTE"), `indent` (HWP units), `lineSpacing` (percent, e.g. 160) | Clones `paraPr[0]`, mutates, retargets paragraph `index`. Bumps `hh:paraProperties@itemCnt`. |

### Images

| `type` | Args | Notes |
|--------|------|-------|
| `insert_image` | `source` (disk path), `ext?` (png/jpg/bmp/gif), `width?`, `height?` (HWP units, default ~100mm) | Adds bytes to `BinData/`, registers a unique `<opf:item>` in the manifest (id avoids existing ids), appends a paragraph with an inline `<hp:pic>`. |
| `replace_image` | `target` (basename or `BinData/...`), `source` | Swaps the bytes of an existing `BinData/` entry. |
| `delete_image` | `target` | Removes the `BinData/` entry **and** its manifest item **and** every `<hp:pic>` that referenced it (no dangling reference). |

## Examples

Template fill + a cell edit + a styled run, saved in place:
```bash
echo '{
  "path": "form.hwpx", "output": "form.hwpx",
  "operations": [
    {"type": "fill_template", "values": {"{{이름}}": "남대현", "{{날짜}}": "2026-05-21"}},
    {"type": "set_cell_text", "table": 0, "row": 2, "col": 1, "text": "100만원"},
    {"type": "apply_text_style", "target": "합계", "bold": true, "color": "FF0000"}
  ]
}' | node scripts/hwpx-edit.js
```

Grow a table and merge a header row:
```bash
echo '{
  "path": "report.hwpx",
  "operations": [
    {"type": "append_table_row", "table": 1, "cells": ["4분기", "120", "98%"]},
    {"type": "merge_cells", "table": 1, "mode": "horizontal", "row": 0, "start": 0, "count": 3}
  ]
}' | node scripts/hwpx-edit.js
```

## Known limits

- **Cross-run text** — a find target split across two `<hp:t>` nodes won't match (same as Hancom's text replace).
- **`append_table_row` column count** — clones the *last* row; if that row is merged to fewer cells, the new row inherits that shape.
- **`merge_cells`** assumes the target range has no prior merge.
- For OWPML the op set doesn't reach, fall back to manual unpack/edit/pack (see SKILL.md Path A fallback).

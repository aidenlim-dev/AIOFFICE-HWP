# references/

Reference docs that Claude consults when reasoning about HWPX format edits or `@rhwp/core` API usage. These are loaded on-demand (not always in context).

## Status

| File | Status | Purpose |
|------|--------|---------|
| `hwpx-format.md` | ✅ done | HWPX file structure, key XML elements (`<hp:p>`, `<hp:run>`, `<hp:tbl>`, etc.), namespaces, common edit patterns. Mirrors `anthropics/skills/docx/ooxml.md` |
| `hwpx-edit-ops.md` | ✅ done | Full op vocabulary for `hwpx-edit.js` — the `.hwpx` in-place editing reference |
| `hwpx-object-placement.md` | ✅ done | Anchoring/positioning objects (images, shapes, textboxes) in `.hwpx` XML |
| `hwpx-style-spacing.md` | ✅ done | Paragraph/char style and spacing model for `.hwpx` (paraPr / charPr, hp:switch) |
| `hwp-internals.md` | ✅ done | HWP 5.0 binary format internals (CFB streams, record structure) for raw-patch editing |
| `hwp-object-placement.md` | ✅ done | Anchoring/positioning objects in the `.hwp` binary path |
| `rhwp-api.md` | ✅ done | Curated `@rhwp/core` API surface: how to load bytes, extract text, create paragraphs/tables, export. Filtered from the full 1300-line `rhwp.d.ts` |
| `equation-syntax.md` | ✅ done | Hangul equation script tokens (structures + symbols) for the `append_equation` op — only needed for Hancom-specific tokens; common LaTeX-like syntax is guessable |

# scripts/

Bundled scripts referenced by `SKILL.md`. Each script is intentionally low-level — Claude does the high-level reasoning and invokes these only for operations it can't do natively (zip handling, WASM calls).

## Status

🚧 v0 in progress. Scripts not yet implemented.

| Script | Status | Notes |
|--------|--------|-------|
| `extract_text.js` | ✅ v0 | Default plaintext, `--format markdown` (skips empty layout tables), `--inspect` for JSON metadata. Handles both `.hwp` and `.hwpx` (in-memory rhwp conversion for binary) |
| `create.js` | not started | Template script. Claude edits content blocks before running. Uses `HwpDocument.createEmpty()` + body-building API + `exportHwpx()` |
| `convert.js` | not started | `.hwp ↔ .hwpx` conversion via rhwp WASM. Loads bytes → `exportHwp()` or `exportHwpx()` → write |
| `unpack.py` | not started | `zipfile` + `xml.etree` for pretty-print. Mirrors `anthropics/skills/docx/scripts/office/unpack.py` |
| `pack.py` | not started | Inverse of unpack. Auto-repair common HWPX issues, regenerate `content.hpf` manifest |
| `validate.py` | not started | Structural checks (manifest matches files, XML well-formedness, root elements present) |
| `vendor/` | not needed (yet) | Currently using `npm install`. May bundle `@rhwp/core` files directly later for offline / sandbox use |

## One-time setup

```bash
cd skills/hwp/scripts
npm install
```

Installs `@rhwp/core` (~5MB WASM) and `fflate` (~45KB zip lib) into `node_modules/`. Required before any `*.js` script runs.

## Out of v0 scope

- PDF / DOCX conversion (would require LibreOffice headless, deferred to a later release)
- Tracked changes / comments (HWP doesn't share docx's tracking model)
- Image extraction (deferred)

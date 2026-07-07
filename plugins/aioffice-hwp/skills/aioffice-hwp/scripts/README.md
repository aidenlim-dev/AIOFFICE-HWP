# scripts/

Bundled scripts referenced by `SKILL.md`. Each script is intentionally low-level — Claude does the high-level reasoning and invokes these only for operations it can't do natively (zip handling, WASM calls).

## Status

End-to-end create + edit pipeline working, **zero-config** (deps vendored).

| Script | Status | Notes |
|--------|--------|-------|
| `extract_text.js` | ✅ | Default plaintext, `--format markdown` (skips empty layout tables), `--inspect` for JSON metadata. Handles both `.hwp` and `.hwpx` (in-memory rhwp conversion for binary) |
| `unpack.py` | ✅ | `zipfile` + `xml.dom.minidom` pretty-print. `--no-pretty` flag for raw mode. Zip-Slip guarded |
| `pack.py` | ✅ | mimetype-first uncompressed entry per OPF spec. Sorted file order for reproducibility |
| `validate.py` | ✅ | Zip integrity + mimetype + required files + XML well-formedness |
| `create.js` | ✅ | stdin-JSON op runner for `.hwp` create/edit (raw-patch in place via `cell-patch.js`). Op vocabulary in `SKILL.md` |
| `hwpx-edit.js` | ✅ | stdin-JSON op runner for `.hwpx` in-place XML editing — the `.hwpx` counterpart of `create.js` |
| `cell-patch.js` | ✅ | Byte-level `.hwp` record patcher (tables, cells, objects). Library used by `create.js`; not invoked directly |
| `cell-inspect.js` | ✅ | Per-table cell layout / cell text dump for `.hwp` — used to target cells before `set_cell_text` |
| `secure-fill.mjs` | ✅ | PII-safe form filling: profile values are read in-process and never printed. Subcommands: detect / keys / template / fill / verify / stash / shred / handoff |
| `make_seal.py` | ✅ | 4-char square seal (날인) PNG generator, transparent background. Requires Pillow |
| `preview-server.js` | ✅ | Loopback-only static + `/file` passthrough server backing the preview pane (port 3737). Host-header validated, idle auto-shutdown |
| `preview-viewer.js` / `preview-viewer.html` | ✅ | Browser viewer (rhwp WASM rendering). Also published to GitHub Pages via `scripts/build-viewer.mjs` at the repo root |
| `launcher/` | ✅ | Double-clickable preview launchers for macOS / Linux / Windows |
| `vendor/` | ✅ | `@rhwp/core` (rhwp.js + rhwp_bg.wasm, ~5 MB), `fflate` (index.mjs, ~80 KB), and `cfb` (cfb.js, ~62 KB) bundled. Each subdir keeps the upstream LICENSE |

## Verified pipeline

End-to-end round-trip tested against rhwp's `samples/`:

1. `validate.py report.hwpx` — sanity check
2. `unpack.py report.hwpx /tmp/u/` — extract pretty-printed XML
3. *Edit XML files in `/tmp/u/Contents/section*.xml` using your `Edit` tool*
4. `pack.py /tmp/u/ output.hwpx` — repackage
5. `validate.py output.hwpx` — confirm structural integrity
6. `extract_text.js output.hwpx` — verify edits propagate

437-paragraph document survives round-trip with edit applied; structural counts preserved.

## End-user setup

**No setup needed.** The Node deps are vendored — scripts run on any machine with Node 18+ and Python 3.9+.

## Maintainer: refreshing vendored deps

`package.json` and `package-lock.json` are kept for maintainers who want to update bundled libraries:

```bash
cd skills/aioffice-hwp/scripts
npm install                      # repopulate node_modules with latest matching versions
cp node_modules/@rhwp/core/{rhwp.js,rhwp_bg.wasm,LICENSE} vendor/rhwp/
cp node_modules/fflate/esm/index.mjs vendor/fflate/
cp node_modules/fflate/LICENSE vendor/fflate/
cp node_modules/cfb/{cfb.js,LICENSE} vendor/cfb/
```

After refreshing, smoke-test by moving `node_modules/` aside and running each script — they should still work because they import only from `vendor/`.

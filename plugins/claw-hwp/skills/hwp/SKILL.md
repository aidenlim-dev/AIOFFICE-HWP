---
name: hwp
description: Use this skill whenever the user wants to read, create, or edit Korean Hangul Word Processor documents (.hwp or .hwpx files). Triggers include any mention of 'hwp', 'hwpx', '한글 문서', '아래한글', '한컴오피스', or uploading/attaching .hwp/.hwpx files. Also use when extracting text from Korean reports or producing Korean-formatted official documents (공문, 보고서, 계약서, 사업계획서). Do NOT use for Word .docx files (use the docx skill instead) or general Korean text without Hangul Word Processor format.
license: MIT
---

# HWP / HWPX Skill

This skill helps Claude work with Korean Hangul Word Processor documents — reading, creating, and editing both the binary `.hwp` (HWP 5.0) and the ZIP-based `.hwpx` formats.

## Quick reference

| Task | Approach |
|------|----------|
| Read text content | `node scripts/extract_text.js <file>` — works for both .hwp and .hwpx |
| Read as markdown (preserves headings/tables) | `node scripts/extract_text.js --format markdown <file>` |
| Inspect structure (pages, sections, tables) | `node scripts/extract_text.js --inspect <file>` |
| Create new document from scratch | `echo '{"path":"out.hwp","operations":[...]}' \| node scripts/create.js` |
| Edit existing `.hwpx` | unpack → edit XML directly with `Edit` tool → pack |
| Edit existing `.hwp` (HWP 5.0 binary) | convert to `.hwpx` via `convert.js` first, then edit-as-hwpx |
| Convert `.hwp` ↔ `.hwpx` | `node scripts/convert.js <input> <output>` |
| Validate output | `python scripts/validate.py <file.hwpx>` |
| Preview file (Desktop = inline pane, CLI = browser link, cowork = launcher script) | See Preview section for the surface decision rule |

> Conversion to PDF / DOCX is **out of scope for v0**. Will be added in a later release via LibreOffice headless.

## Format primer

- **`.hwpx`** — ZIP container holding XML. Same archetype as `.docx`. Use the unpack/edit/pack workflow. Internal layout includes `Contents/section0.xml` (body), `Contents/header.xml` (styles, fonts), `Contents/content.hpf` (manifest). See `references/hwpx-format.md`.
- **`.hwp`** — HWP 5.0 binary (CFB/OLE container). NOT a ZIP. Direct XML editing is impossible. For edits, convert to `.hwpx` via `convert.js`. For read-only operations, `extract_text.js` handles binary `.hwp` transparently via the rhwp WASM library.

When in doubt about format, read the first two bytes — `PK` indicates ZIP (treat as HWPX even if extension is `.hwp`).

## Decision tree

### "Read this file" / "Summarize" / "Translate the content"

```bash
node scripts/extract_text.js path/to/file.hwp > /tmp/text.txt
# Then read /tmp/text.txt and respond
```

`extract_text.js` handles both `.hwp` and `.hwpx` via rhwp WASM. Default output is plaintext (one paragraph per line).

For structured content (headings, tables, lists preserved):
```bash
node scripts/extract_text.js --format markdown path/to/file.hwp > /tmp/text.md
```

For metadata only:
```bash
node scripts/extract_text.js --inspect path/to/file.hwp
# Returns JSON: { pageCount, sectionCount, paragraphCount, tableCount, hasImages, ... }
```

### "Create a new document" / "Write this as a hwp file"

`create.js` reads a JSON payload from stdin and writes the file to the path you supply. Output format is decided by the path extension (`.hwp` = HWP 5.0 binary, `.hwpx` = OOXML).

```bash
echo '{
  "path": "report.hwp",
  "operations": [
    {"type": "setup_document", "page_size": "a4", "margin_mm": 25},
    {"type": "append_heading", "level": 1, "text": "월간 보고서"},
    {"type": "append_paragraph", "text": "이번 달 핵심 지표 요약입니다. 주요 변화는 **매출 증가**와 *비용 절감*입니다."},
    {"type": "append_table",
      "headers": ["항목", "지난달", "이번달"],
      "rows": [["매출", "100억", "120억"], ["비용", "80억", "75억"]]
    },
    {"type": "append_image", "path": "/abs/path/chart.png", "width_cm": 12, "height_cm": 6.6}
  ]
}' | node scripts/create.js
```

`stdout` returns one JSON line:

```json
{ "status": "success", "path": "report.hwp", "bytes_written": 14336, "ops_applied": 5,
  "verify": { "pageCountAfter": 1, "recovered": true },
  "log": ["…", "stripped 4 PARA_LINESEG record(s)"] }
```

Errors come back as `{"status": "error", "message": "...", "op_index": N}`. Always read the JSON to confirm — exit code 0 even on op-level failures isn't guaranteed.

**Op vocabulary** (in the order you'd typically use them):

| Op | Required | Optional |
|----|----------|----------|
| `setup_document` | `page_size` (`a4`/`b5`/...), `orientation` (`portrait`/`landscape`) | `margin_mm`, `base_font` |
| `append_heading` | `level` (1–6), `text` | `align`, `runs` |
| `append_paragraph` | `text` | `align`, `line_spacing`, `spacing_before`, `spacing_after`, `runs` |
| `append_table` | `headers`, `rows` | `col_widths_cm`, `merges`, `cell_props` |
| `append_image` | `path` | `width_cm`, `height_cm`, `alt` |
| `append_bullet_list`, `append_numbered_list` | `items[]` | — |
| `append_page_break` | — | — |
| `replace_text` | `query`, `replacement` | `case_sensitive` |

Inline `**bold**` and `*italic*` are parsed automatically inside `text` and table cell strings. `runs:[{text, bold?, italic?, fontSize?, color?}]` overrides the parser when you need finer control.

**Known limitations** (rhwp serializer constraints — applies to anything emitted via this skill):

- **HWPX tables are dropped by rhwp's `exportHwpx()`**. If a doc has tables, write `.hwp` and (if HWPX is required) round-trip through Hancom Office or 한컴독스 to re-emit the table XML. `convert.js` won't help — it goes through the same rhwp serializer.
- **HWP→HWPX downconversion is lossy** (tables, images, complex shapes). Default to `.hwp` for tables; default to `.hwpx` only when the document is text-heavy.

### "Edit this document" / "Replace X with Y" / "Add a new paragraph"

**For `.hwpx` files (recommended path):**

1. Unpack:
   ```bash
   python scripts/unpack.py path/to/file.hwpx /tmp/unpacked/
   ```
2. Edit XML files directly using your `Edit` tool. Key files:
   - `/tmp/unpacked/Contents/section0.xml` — main body content
   - `/tmp/unpacked/Contents/header.xml` — document-level styles, fonts, page settings
   - `/tmp/unpacked/Contents/content.hpf` — manifest
   See `references/hwpx-format.md` for element references and common edit patterns.
3. Repack:
   ```bash
   python scripts/pack.py /tmp/unpacked/ output.hwpx --original path/to/file.hwpx
   ```
4. Validate:
   ```bash
   python scripts/validate.py output.hwpx
   ```

**For `.hwp` (HWP 5.0 binary) files:**

```bash
# 1. Convert to .hwpx via rhwp WASM
node scripts/convert.js input.hwp /tmp/converted.hwpx
# 2. Then proceed with the .hwpx workflow above
```

**Output format default**: save edits as `.hwpx`. The HWPX format is the modern Hangul Office standard and avoids the lossy round-trip back to HWP 5.0 binary. Only convert back to `.hwp` if the user explicitly requires HWP 5.0 output (use `node scripts/convert.js output.hwpx final.hwp` and warn that some formatting may be lost).

### "Show me what this looks like" / "Preview this HWP file"

The skill ships a tiny Node HTTP server (`scripts/preview-server.js`) that serves a vanilla-JS canvas-based viewer; rhwp WASM does the actual rendering in the browser, so the result matches Hancom Office closely. No LibreOffice, no external browser plugin.

**The preview path depends on which Claude surface you're running in.** The decision rule, applied first thing every time the user wants to view a file:

| Surface | Detection | What you do |
|---|---|---|
| **Claude Code Desktop** (Code mode in the desktop app) | `preview_start` / `preview_eval` / `preview_stop` tools are present | Use the host-managed inline pane. See "Inline pane path" below. |
| **Claude Code CLI** (and any other surface where Bash runs on the user's machine but no `preview_*` tools exist) | `uname -s` returns `Darwin` / `Linux` / `MINGW*` *and* no `preview_*` tools | Self-host: bash launches `preview-server.js`, then hand the user a markdown link. See "Self-host link path" below. |
| **Cowork** (claude.ai web cowork, Claude Desktop's cowork mode) | No `preview_*` tools, and you're inside a remote Linux sandbox (Bash can't reach the user's `localhost`) | Emit the file plus an OS-launcher block. The user runs the launcher locally, which spins up `preview-server.js` on **their** machine and opens the browser. See "Cowork launcher path" below. Do not run `preview-server.js` inside the sandbox — its `localhost` is unreachable from the user's browser. |
| **Claude API direct** (developer's app embedding the SDK) | Depends on developer's deployment | If their Bash is on the user's machine, treat as CLI. If it's on a remote server, treat as cowork. |

#### Inline pane path (Claude Code Desktop only)

This is the only surface that exposes `preview_start` / `preview_eval` / `preview_stop`. Setup once per workspace via `.claude/launch.json`:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "claw-hwp-preview",
      "runtimeExecutable": "node",
      "runtimeArgs": ["${CLAUDE_PLUGIN_ROOT}/skills/hwp/scripts/preview-server.js"],
      "port": 3737
    }
  ]
}
```

If missing, create or merge before calling `preview_start`. Code substitutes `CLAUDE_PLUGIN_ROOT` at load time. (When typing the path manually for debugging, an installed plugin lives at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.) Port `3737` is the default; override via `CLAW_HWP_PREVIEW_PORT`.

Lifecycle — the viewer is a long-lived page in a long-lived pane. You do NOT spawn a fresh server per file.

1. **`preview_start`** with `name: "claw-hwp-preview"`. Returns either a fresh pane or `reused: true` if one is already open.
2. **`preview_eval`** to set `window.location.href = "http://localhost:3737/?path=<absolute path>"`. Use this both for the first navigation and for swapping files. Do not start a second server.
3. **`preview_stop`** when you need to recover a stuck pane (below).

Stuck pane recovery — when `preview_start` returns `reused: true` but nothing is visible (the prior pane was closed/hidden), hard-reset: `preview_stop` → `preview_start` → `preview_eval`. Don't ask the user, just do it.

#### Self-host link path (Claude Code CLI, local-bash API setups)

No host-managed pane available, but Bash can reach the user's localhost. Health-check first; if dead, start it yourself — never ask the user to run anything.

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-}/skills/hwp/scripts/preview-server.js"
[ -f "$SCRIPT" ] || SCRIPT=$(find "$HOME/.claude/plugins/cache/claw-hwp" \
  -path '*/skills/hwp/scripts/preview-server.js' 2>/dev/null | sort -V | tail -1)
curl -fsS -o /dev/null http://localhost:3737/__heartbeat || \
  node "$SCRIPT" >/tmp/claw-hwp-preview.log 2>&1 &
disown 2>/dev/null || true
sleep 0.5
```

Then emit a markdown link the user clicks to open in their default browser:

```
[열기 — <filename>](http://localhost:3737/?path=<absolute path>)
```

`preview-server.js` self-exits ~2 minutes after the last viewer tab closes (heartbeat-based), so on a return visit you may need to repeat the health-check + relaunch. The script handles that — just always run the snippet above before emitting a link.

#### Cowork launcher path (cowork = remote sandbox, no local Bash)

The sandbox's `localhost:3737` is unreachable from the user's browser, so the preview server has to run on the **user's** machine. The skill ships three OS launchers that handle this end-to-end. After writing the HWP file, append a launcher block to your reply so the user can download the launcher matching their OS, drop it next to the file, and double-click.

```
**미리보기:** OS 별 launcher 하나만 받아서 위 파일과 같은 폴더에 두고 더블클릭:

- macOS: <https://raw.githubusercontent.com/DoHyun468/claw-hwp/main/plugins/claw-hwp/skills/hwp/scripts/launcher/preview-mac.command>
- Windows: <https://raw.githubusercontent.com/DoHyun468/claw-hwp/main/plugins/claw-hwp/skills/hwp/scripts/launcher/preview-windows.bat>
- Linux: <https://raw.githubusercontent.com/DoHyun468/claw-hwp/main/plugins/claw-hwp/skills/hwp/scripts/launcher/preview-linux.sh>

(Node.js 18+ 필요. 첫 실행 시 ~5MB 뷰어 자산 다운로드. macOS는 우클릭 → 열기로 한 번만 Gatekeeper 통과.)
```

What the launcher does on the user's machine:
1. Looks for `preview-server.js` in the local Claude plugin cache (`~/.claude/plugins/cache/claw-hwp/...`). If found, uses it.
2. Otherwise downloads `scripts/` from the GitHub `main` tarball into `~/.claw-hwp-launcher/` (~5 MB, one-time).
3. Boots `preview-server.js` on `localhost:3737` if not already up (idempotent — health-checks first).
4. Opens the user's default browser at `http://localhost:3737/?path=<absolute path of the .hwp/.hwpx>`.

Auto-detection: if no file argument is passed, the launcher picks the most recent `.hwp`/`.hwpx` in its own directory. So "drop launcher next to file → double-click" is the happy path; "pass file path as argument" is the fallback.

Server lifetime: same as CLI path — `preview-server.js` self-exits ~2 minutes after the last viewer tab closes. Re-running the launcher restarts it.

#### When to fire preview (all paths)

Don't ask, just do it. Visual verification is your job.

1. Right after `create.js` / `convert.js` writes a new file or finishes a format conversion.
2. Right after the user uploads a `.hwp` / `.hwpx` or mentions one by path.
3. Right after edits (`replace_text`, unpack-edit-pack round-trip).

In Desktop and CLI paths, "fire preview" means open the viewer / link directly. In cowork, "fire preview" means emit the launcher block alongside the file. Never write "please check if the file looks right" — give the user a working preview path.

## Common pitfalls

- **HWP 5.0 lossy round-trip**: `.hwp` → `.hwpx` → `.hwp` may drop formatting. Default to `.hwpx` output. Only round-trip back to `.hwp` on explicit user request, and warn first.
- **Misnamed extensions**: a `.hwp` file may actually be HWPX (starts with `PK`). Detect by reading the magic bytes before deciding on workflow.
- **Encoding**: all HWPX XML is UTF-8. Never transcode. Don't escape Korean characters as XML entities — write them as-is.
- **Whitespace preservation**: HWPX uses `xml:space="preserve"` on text runs. When inserting new text via `Edit`, keep the attribute on the parent element or wrapping `<hp:t>` so leading/trailing spaces survive.
- **`.hpf` manifest sync**: when adding/removing files in the unpacked dir, `pack.py` regenerates the manifest. Do not hand-edit `Contents/content.hpf` unless you know the schema.

## Bundled scripts

| Script | Runtime | Purpose |
|--------|---------|---------|
| `scripts/extract_text.js` | Node | Read text, markdown, or metadata from .hwp/.hwpx via rhwp WASM |
| `scripts/create.js` | Node | Generate a new .hwp / .hwpx from a stdin JSON op script via rhwp |
| `scripts/convert.js` | Node | Convert `.hwp ↔ .hwpx` via rhwp WASM (no LibreOffice required) |
| `scripts/unpack.py` | Python | Unzip .hwpx → directory of pretty-printed XML |
| `scripts/pack.py` | Python | Repack directory → .hwpx with auto-repair |
| `scripts/validate.py` | Python | HWPX schema and structural validation |
| `scripts/preview-server.js` | Node | Static HTTP server backing the Claude Code preview pane viewer |
| `scripts/preview-viewer.html` + `scripts/preview-viewer.js` | static | Canvas-based vanilla-JS HWP viewer (vendored rhwp WASM, no React) |

## Dependencies

- **Python 3.9+** — `unpack.py`, `pack.py`, `validate.py` (standard library only)
- **Node.js 18+** — `extract_text.js`, `create.js`, `convert.js`. `@rhwp/core` (WASM parser, ~5 MB), `fflate` (zip, ~80 KB), and `cfb` (Compound File Binary, ~62 KB) are bundled in `scripts/vendor/` — **no `npm install` step required**.

## References

- `references/hwpx-format.md` — HWPX file structure, XML schema cheatsheet, common edit patterns
- `references/rhwp-api.md` — `@rhwp/core` API surface for create/convert operations

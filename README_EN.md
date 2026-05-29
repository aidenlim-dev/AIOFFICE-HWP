<h1 align="center">claw-hwp</h1>

<p align="center">
  <a href="https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview">Agent Skill</a> for Claude to read, create, and edit Korean Hangul documents (.hwp / .hwpx) — with Hancom Office / Hancom Docs–compatible save guaranteed.<br/>
  Works in Claude Code · Desktop · web. <a href="https://github.com/edwardkim/rhwp">rhwp</a> parser engine + our own edit infrastructure.
</p>

<p align="center">
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/DoHyun468/claw-hwp/main/.github/traffic-summary.json" alt="Clones (14-day)" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/status-WIP-orange" alt="WIP" />
</p>

<p align="center">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

---

## What is this?

`claw-hwp` is an [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) that lets Claude work directly with Korean Hangul documents (`.hwp` / `.hwpx`). The Korean office ecosystem is effectively standardized on Hancom's `.hwp` / `.hwpx` formats, and Claude can't read or edit them out of the box. Install this skill and Claude can:

- **read** — extract text, tables, and metadata from `.hwp` / `.hwpx`
- **create** — write new documents (headings, paragraphs, tables, images, page breaks + character formatting (bold·italic·underline·strikethrough·highlight·color·size·font) and paragraph formatting (alignment·line spacing·indent·margins·background)). Tables are supported in both `.hwp` and `.hwpx` output.
- **edit** — edit existing documents in their **original format** (no `.hwp` ↔ `.hwpx` conversion). `.hwp` via byte-level raw-patch (cell content·text replace·paragraph/table insert·page setup·character/paragraph formatting); `.hwpx` via direct XML edit (cells·headers/footers·bullet/numbered lists·footnotes·hyperlinks·insert_table·etc.). Both paths preserve existing tables.
- **convert** — `.hwp ↔ .hwpx` both directions via rhwp WASM. Not lossless — round-tripping can damage tables and images
- **preview** — view rhwp-rendered pages inline or in a browser (the path differs by surface — see [Usage by surface](#usage-by-surface))

Read / create / edit / convert work in desktop-app surfaces where Claude has Bash and filesystem access — Claude Code CLI, Claude Code Desktop (Code mode), and Claude Desktop cowork mode. (claude.ai web doesn't support plugin install in v1.)

The preview surface coverage:

| Surface | Preview |
|---|---|
| Claude Code Desktop (Code mode) | Inline pane next to the chat |
| Claude Code CLI | Browser link to local `localhost:3737` (agent self-launches the server) |
| Claude Desktop cowork mode | Drag-drop the file onto <https://dohyun468.github.io/claw-hwp/> (no Node install) |

No Hancom Office, no LibreOffice, no Windows COM required.

## Known limitations

These come from the HWP 5.0 format itself and a few v1-scope edges. Worth knowing before you start.

- **Tables are preserved when editing `.hwp` or `.hwpx`.** Conversion (`.hwp ↔ .hwpx`) can damage tables (rhwp serializer limitation) — prefer staying in the input's original format. Editing existing files keeps tables intact in either format: `.hwp` via byte-level raw-patch (cell content·text replace·paragraph/table insert·page setup·formatting), `.hwpx` via direct XML edit (cells·alignment·background·borders·rows/columns·insert_table·headers/footers·lists·footnotes·hyperlinks). Tables are also supported when creating new documents in either `.hwp` or `.hwpx`.
- **`.hwp ↔ .hwpx` conversion is lossy.** Tables / images / complex shapes can break — **edit in the input's original format** (`.hwp` stays `.hwp`, `.hwpx` stays `.hwpx`). Only run `convert.js` when the user explicitly requests a format change.
- **In-place character/paragraph formatting on large existing `.hwp` files (50+ pages)** is supported via raw-patch — both `apply_text_style` (bold·italic·underline·strikethrough·highlight·color·size·super/subscript·etc., via CharShape) and `apply_paragraph_style` (alignment·line spacing·indent·margins·spacing before/after·background via ParaShape + BorderFill) round-trip through Hancom Office and Hancom Docs cleanly.
- **In-place image insertion on existing `.hwp` files** (`append_image`) is not yet Hancom-Docs compatible in v1 — debugging the raw-patch mini-stream chain. Creating a new `.hwp` from scratch with images works.
- **PDF / DOCX conversion is not yet supported.** Planned for a later release via LibreOffice headless.

## Built on

- **[edwardkim/rhwp](https://github.com/edwardkim/rhwp)** — Rust + WebAssembly core for HWP parsing, rendering, and `.hwp` ↔ `.hwpx` conversion. claw-hwp uses it as the parser engine.
- **[golbin/hop](https://github.com/golbin/hop)** — open-source HWP desktop viewer/editor built on the same rhwp core. Reference for editor UX patterns.
- **[anthropics/skills](https://github.com/anthropics/skills)** — Anthropic's official skill repository. The `docx`, `pptx`, `xlsx` skills are the structural blueprint we mirror.

## Korean HWP open-source ecosystem

claw-hwp is part of a broader open-source movement around Korea's HWP formats. Each project occupies a different niche, complementing the others:

| Project | Role | When to use |
|---|---|---|
| **[rhwp](https://github.com/edwardkim/rhwp)** | HWP parser/renderer core (Rust + WASM) | foundation that everything else builds on |
| **[hop](https://github.com/golbin/hop)** | HWP desktop viewer (Tauri) | opening .hwp files on macOS / Linux |
| **claw-hwp** | HWP skill for Claude/AI workflows | working on .hwp with AI — generate, summarize, edit |

Pick `hop` for desktop GUI, `claw-hwp` for AI-driven workflows.

## Status

🚧 v1.0 submitted to Anthropic's official marketplace on 2026-05-14, pending review. v1.1 edit feature expansion (character/paragraph/cell formatting, headers/footers, lists, footnotes, hyperlinks, insert_table) shipped. Read / create / edit / convert / preview pipeline verified across all four surfaces.

## Roadmap

- [x] v0 — `SKILL.md` decision tree
- [x] v0.1 — `references/hwpx-format.md` (XML schema cheatsheet for Claude to edit by hand)
- [x] v0.2 — Node scripts (`extract_text.js`, `convert.js`)
- [x] v0.3 — Python scripts (`unpack.py`, `pack.py`, `validate.py`)
- [x] v0.4 — End-to-end smoke tests against rhwp `samples/` fixtures (round-trip verified)
- [x] v0.5 — Claude Code plugin manifest + single-plugin marketplace
- [x] v0.6 — `references/rhwp-api.md` (curated `@rhwp/core` API reference)
- [x] v0.7 — `create.js` core ops (setup_document, append_{heading,paragraph,table,list,image}, replace_text, page/column breaks, load-then-append, extension-based `.hwp`/`.hwpx` dispatch)
- [x] v0.8 — Vendored Node deps — zero-config install across Code / Desktop / web
- [x] v0.9 — Plugin icon
- [x] v1.0 — Submitted to Anthropic's official marketplace (pending review)
- [x] v1.1 — Edit feature expansion (character/paragraph/cell formatting, headers/footers, bullet/numbered lists, footnotes, hyperlinks, insert_table, Markdown→HWP citation styles)
- [x] v1.2 — Character-level formatting on large existing files (50+ pages) via raw-patch CharShape — `apply_text_style` is Hancom-Docs–compatible ✓
- [x] v1.3 — Paragraph-level formatting on large files via raw-patch ParaShape + BorderFill — `apply_paragraph_style` is Hancom-Docs–compatible ✓
- [ ] v1.2+ — PDF / DOCX conversion, image extraction, viewer/editor React packages

## Install

> **Claude Desktop app (Mac / Windows)** only. claude.ai web doesn't yet support plugin installation, so v1 of claw-hwp runs in the desktop app — web users, please grab [Claude Desktop](https://claude.com/download) to proceed.

### Regular users — add via the Customize menu (3 steps)

1. In the Claude Desktop **Code** tab, click **Customize** in the left sidebar *(the label stays "Customize" in both English and Korean UI)*.
2. Next to **Personal plugins** *(개인 플러그인 in Korean UI)*, click **`+`** → **Create plugin** *(플러그인 생성)* → **Add marketplace** *(마켓플레이스 추가)*.
3. Paste this URL into the field and click **Sync** *(동기화)*:

   ```
   https://github.com/DoHyun468/claw-hwp
   ```

**Sync finishes the install.** `claw-hwp` shows up in your Personal plugins list and is enabled right away. From there, drop a `.hwp` / `.hwpx` file into chat (or just mention one by name) and the skill kicks in automatically.

<!-- TODO(media): Customize → Personal plugins → Add marketplace → Sync screenshot -->

### First time — talk to Claude this way

Once installed, Claude automatically invokes this skill when a `.hwp` / `.hwpx` shows up in context. Abstract "set up" / "build me one" requests can confuse Claude into trying to scaffold a brand-new skill or walking through an extra install step.

| ✅ Works well | ⚠️ Confuses Claude |
|---|---|
| `Show me report.hwp` (file attached) | `Build me a claw-hwp` |
| `Open this Hangul file for me` | `Install the preview feature` |
| `Add this line to meeting-notes.hwp` | `Set up the claw-hwp skill` |
| `Replace 2026 with 2027` | `Set up the Hangul plugin` |

Rule of thumb: mention the `.hwp` file (or attach it) and the skill auto-fires. Preview comes up automatically — no separate install / setup step.

### After updates, start a fresh session

A running session keeps the skill snapshot it loaded at the start. Even after `claude plugin marketplace update claw-hwp` or Customize → Sync pulls a newer version into cache, **the already-open session keeps using the old SKILL.md and old scripts**. To pick up new behavior (e.g. the Hancom-Docs-compatible raw-patch path for cell edits), close the session and open a new one.

### Developers — Claude Code CLI (one command)

```bash
# 1. Add the marketplace (one-time)
claude plugin marketplace add https://github.com/DoHyun468/claw-hwp

# 2. Install the plugin
claude plugin install claw-hwp@claw-hwp
```

That's it. Claude Code auto-loads the skill when you mention `.hwp` / `.hwpx` files. Updates land via `claude plugin marketplace update claw-hwp`.

> **Zero-config**. Node dependencies (`@rhwp/core` WASM ~5 MB, `fflate` ~80 KB) are vendored into `scripts/vendor/` so the plugin works on any machine with Node 18+ and Python 3.9+ — no `npm install` step.

See `plugins/claw-hwp/skills/hwp/SKILL.md` for the full decision tree (read / create / edit / convert / validate).

## Usage by surface

> This section covers only desktop-app surfaces with Bash + filesystem access (Claude Code Desktop's Code mode and cowork mode) plus the Claude Code CLI. Claude Desktop's plain chat mode and claude.ai web (no plugin install in v1) can't run this skill — but the viewer page <https://dohyun468.github.io/claw-hwp/> itself works for anyone with a `.hwp` / `.hwpx` file (no install required).

Only the preview path differs by surface — the read/create/edit flow itself works the same everywhere. Find the row that matches your setup.

### Claude Code Desktop (Code mode)

Drop a `.hwp`/`.hwpx` into chat (or just mention it by name). The rendered document opens **inline, in a pane next to your conversation** — the pane is the default and handles most of the flow. For a bigger view, side-by-side comparison, or sharing, Claude also emits an auxiliary link to the hosted viewer (<https://dohyun468.github.io/claw-hwp/>) — open it in your browser and drag the file in.

<!-- TODO(media): Desktop Code mode — inline preview pane screenshot/video -->

### Claude Code CLI

Drop a `.hwp`/`.hwpx` into chat. Claude prints a clickable link → click it → the document opens in your default browser. The tiny local server quietly turns itself off about 2 minutes after you close the tab — nothing to clean up.

<!-- TODO(media): CLI — markdown link emission + browser preview screenshot/video -->

### Claude Desktop — Cowork mode

Cowork runs Claude in a remote sandbox, so it can't reach a preview server on your machine. Instead, the same viewer is hosted as a **static page on GitHub Pages**:

1. Claude gives you the `.hwp` / `.hwpx` file plus the viewer link — <https://dohyun468.github.io/claw-hwp/>
2. Download the file, then drop it onto that page (or pick it via the folder icon in the toolbar)
3. It renders right there in the browser. The file is not uploaded anywhere — rhwp WASM parses it locally in your tab.

No install, no Node, no permissions. Zoom (Ctrl+wheel or slider), page navigation, and the auto-correction toggle all work.

If you're offline or GitHub Pages is blocked, OS launchers (`.command` / `.bat` / `.sh`) are still available as a fallback — drop next to the file and double-click, Node.js 18+ required. Claude will offer them if needed.

<!-- TODO(media): cowork — drag-drop onto hosted viewer → rendered preview screenshot/video -->

## Requirements

- Node.js 18+
- Python 3.9+

LibreOffice / Hancom Office are **not** required. PDF/DOCX conversion (later releases) will use LibreOffice headless when available.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 RECON Labs Inc.

---

<p align="center">
  <a href="https://www.reconlabs.ai/">
    <img src="https://avatars.githubusercontent.com/u/82856082?s=160&v=4" width="72" alt="RECON Labs" />
  </a>
</p>

<p align="center">
  Generative-AI 3D content platform — <a href="https://www.reconlabs.ai/">reconlabs.ai</a> · <a href="https://github.com/RECON-Labs-Inc">@RECON-Labs-Inc</a>
</p>

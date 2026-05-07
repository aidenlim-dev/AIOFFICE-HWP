<p align="center">
  <a href="https://www.reconlabs.ai/">
    <img src="https://avatars.githubusercontent.com/u/82856082?s=200&v=4" width="96" alt="RECON Labs" />
  </a>
</p>

<h1 align="center">claw-hwp</h1>

<p align="center">
  HWP/HWPX viewer + editor for Claude — built on <a href="https://github.com/edwardkim/rhwp">rhwp</a> (Rust + WASM), exposed via MCP.<br/>
  한글 문서를 Claude Code · Desktop · Web 어디서든.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
  <a href="https://www.reconlabs.ai/"><img src="https://img.shields.io/badge/built%20at-RECON%20Labs-0f172a" alt="Built at RECON Labs" /></a>
  <img src="https://img.shields.io/badge/status-WIP-orange" alt="WIP" />
</p>

---

## What is this?

`claw-hwp` brings native HWP / HWPX support to Claude. Most of the Korean office document ecosystem is locked into Hancom's binary format, and Claude can't read or edit them out of the box. This project closes that gap by packaging [rhwp](https://github.com/edwardkim/rhwp)'s WebAssembly viewer + editor as a Claude plugin and MCP server, so Claude can:

- **read** HWP/HWPX text, tables, and metadata
- **render** pages to SVG / PDF for preview
- **edit** documents (text, tables, formatting) via hwpctl-compatible API

It runs anywhere MCP is supported — Claude Code (terminal), Claude Desktop, and the web — without requiring Hancom Office or Windows COM.

## Status

🚧 Early development. Not yet released to npm / mcp registries. See [Roadmap](#roadmap) below.

## Roadmap

- [ ] v0 — `hwp_extract_text` MCP tool (Node + `@rhwp/core`)
- [ ] v0.1 — `hwp_to_svg` page render, `hwp_inspect` metadata
- [ ] v0.2 — `hwp_to_pdf` (SVG → PDF, LibreOffice fallback)
- [ ] v0.3 — Claude Code plugin manifest, slash commands
- [ ] v0.4 — Editor surface (`@rhwp/editor` embed)
- [ ] v1.0 — npm release, mcp registry submission

## Acknowledgements

- [edwardkim/rhwp](https://github.com/edwardkim/rhwp) — the Rust + WASM core that makes this possible
- [golbin/hop](https://github.com/golbin/hop) — desktop app reference

## License

MIT — see [LICENSE](LICENSE).

---

Built and maintained at [**RECON Labs**](https://www.reconlabs.ai/) · [@RECON-Labs-Inc](https://github.com/RECON-Labs-Inc)

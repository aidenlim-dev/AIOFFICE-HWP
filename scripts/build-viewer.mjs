#!/usr/bin/env node
// Build the static GitHub Pages viewer into /docs/.
//
// The plugin's `scripts/preview-viewer.{html,js}` are the canonical source —
// this script copies them plus the WASM/JS vendor assets into `/docs/`, which
// GitHub Pages serves as a static site at https://aidenlim-dev.github.io/AIOFFICE-HWP/.
// Run after viewer changes:  node scripts/build-viewer.mjs
//
// Why a copy and not a symlink: GitHub Pages serves the working tree from
// /docs/, and symlinks aren't honored on Pages — actual files only.

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const src = resolve(repoRoot, "plugins/aioffice-hwp/skills/hwp/scripts");
const dst = resolve(repoRoot, "docs");

await rm(dst, { recursive: true, force: true });
await mkdir(resolve(dst, "vendor/rhwp"), { recursive: true });

await cp(resolve(src, "preview-viewer.html"), resolve(dst, "index.html"));
await cp(resolve(src, "preview-viewer.js"), resolve(dst, "preview-viewer.js"));
await cp(resolve(src, "vendor/rhwp/rhwp.js"), resolve(dst, "vendor/rhwp/rhwp.js"));
await cp(resolve(src, "vendor/rhwp/rhwp_bg.wasm"), resolve(dst, "vendor/rhwp/rhwp_bg.wasm"));
await cp(resolve(src, "vendor/rhwp/LICENSE"), resolve(dst, "vendor/rhwp/LICENSE"));

// Tell Jekyll (GitHub Pages' default processor) to skip directory listings
// and pass our files through verbatim. Without this, files prefixed with
// underscores are dropped silently.
await writeFile(resolve(dst, ".nojekyll"), "");

console.log("viewer built →", dst);

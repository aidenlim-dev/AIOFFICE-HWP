// preview-viewer.js — Vanilla JS HWP/HWPX renderer for the Claude Code
// preview pane. Loads ?path=<abs path> from the URL, fetches the bytes
// via the local preview-server, parses with rhwp WASM, and renders each
// page to a <canvas> via doc.renderPageToCanvas().
//
// 자동 보정 (auto-fix) toggles rhwp's reflowLinesegs() — same effect as
// stripping PARA_LINESEG records server-side, but applied at read time.
//
// Intentionally minimal: no file picker, no header, no i18n. The viewer
// is opened only as a Claude Code preview-pane sub-page; entry points
// like file picking happen through the agent.

// rhwp WASM imports as default. The browser version has fetch built in,
// so init() with no args reads /vendor/rhwp/rhwp_bg.wasm relative to the
// rhwp.js URL — but our page lives at /, so we point at the explicit URL.
const rhwp = await import("/vendor/rhwp/rhwp.js");
await rhwp.default({ module_or_path: "/vendor/rhwp/rhwp_bg.wasm" });

const els = {
  filename: document.getElementById("filename"),
  autofix: document.getElementById("autofix"),
  download: document.getElementById("download"),
  pagenav: document.getElementById("pagenav"),
  pagePrev: document.getElementById("page-prev"),
  pageNext: document.getElementById("page-next"),
  pageInput: document.getElementById("page-input"),
  pageTotal: document.getElementById("page-total"),
  container: document.getElementById("pages-container"),
  status: document.getElementById("status"),
  modal: document.getElementById("autofix-modal"),
  modalAccept: document.getElementById("autofix-accept"),
  modalDecline: document.getElementById("autofix-decline"),
};

// autoFix === null means we haven't asked the user yet for this file.
// First successful load flips the value to true / false via the modal,
// after which the toolbar button toggles freely without re-prompting.
const state = {
  fileBytes: null,
  filename: "",
  filePath: "",
  autoFix: null,
  asked: false,
  pageCount: 0,
  currentPage: 1,
  // Cached canvas-pixel-buffer dimensions per page. We render once at
  // baseline DPR, then on resize just update CSS width/height. No re-render.
  pageDims: [],
};

function syncAutofixButton() {
  const on = state.autoFix === true;
  els.autofix.textContent = `자동 보정 ${on ? "ON" : "OFF"}`;
  els.autofix.classList.toggle("on", on);
}
syncAutofixButton();

function showModal() { els.modal.hidden = false; }
function hideModal() { els.modal.hidden = true; }
hideModal();

function setStatus(text, kind = "info") {
  els.status.textContent = text;
  els.status.className = `status${kind === "error" ? " error" : ""}`;
  els.status.style.display = "block";
}
function clearStatus() { els.status.style.display = "none"; }

function syncPageNav() {
  if (state.pageCount <= 0) {
    els.pagenav.hidden = true;
    return;
  }
  els.pagenav.hidden = false;
  els.pageInput.max = String(state.pageCount);
  els.pageInput.value = String(state.currentPage);
  els.pageTotal.textContent = String(state.pageCount);
  els.pagePrev.disabled = state.currentPage <= 1;
  els.pageNext.disabled = state.currentPage >= state.pageCount;
}

function scrollToPage(n) {
  const idx = Math.max(1, Math.min(state.pageCount, n));
  const wrap = els.container.querySelectorAll(".page-wrap")[idx - 1];
  if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  state.currentPage = idx;
  syncPageNav();
}

// Recompute CSS sizes on container resize so canvases re-fit width-wise.
// We don't re-rasterise — the canvas pixel buffer stays at its render-time
// resolution and CSS scales it; visually equivalent to MyAgent's HwpViewer
// resize behaviour without the cost of re-running renderPageToCanvas.
function applyFit() {
  const wraps = els.container.querySelectorAll(".page-wrap");
  if (wraps.length === 0) return;
  const containerWidth = els.container.clientWidth - 48; // padding both sides
  const targetCssWidth = Math.min(1100, containerWidth);
  wraps.forEach((wrap, i) => {
    const canvas = wrap.querySelector("canvas");
    if (!canvas) return;
    const dim = state.pageDims[i];
    if (!dim) return;
    const cssW = targetCssWidth;
    const cssH = (dim.h / dim.w) * cssW;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  });
}
const ro = new ResizeObserver(() => applyFit());
ro.observe(els.container);

// Track which page is currently most-visible in the scroll container so
// the page-nav input reflects the user's manual scrolling.
const pageObserver = new IntersectionObserver(
  (entries) => {
    let bestIdx = state.currentPage;
    let bestRatio = 0;
    entries.forEach((e) => {
      if (e.intersectionRatio > bestRatio) {
        bestRatio = e.intersectionRatio;
        const idx = Number(e.target.dataset.pageIdx) + 1;
        if (Number.isFinite(idx)) bestIdx = idx;
      }
    });
    if (bestRatio > 0 && bestIdx !== state.currentPage) {
      state.currentPage = bestIdx;
      syncPageNav();
    }
  },
  { root: els.container, threshold: [0.1, 0.5, 0.9] },
);

async function loadFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const p = params.get("path");
  if (!p) {
    setStatus("미리보기할 파일 경로가 지정되지 않았습니다 (?path=).", "error");
    return;
  }
  setStatus("파일 불러오는 중…");
  try {
    const res = await fetch(`/file?path=${encodeURIComponent(p)}`);
    if (!res.ok) throw new Error(`서버 응답 ${res.status}: ${await res.text()}`);
    state.fileBytes = new Uint8Array(await res.arrayBuffer());
    state.filePath = p;
    const headerName = res.headers.get("x-filename");
    state.filename = headerName
      ? (() => { try { return decodeURIComponent(headerName); } catch { return headerName; } })()
      : (p.split("/").pop() || "untitled");
    els.filename.textContent = state.filename;
    els.download.href = `/file?path=${encodeURIComponent(p)}`;
    els.download.setAttribute("download", state.filename);
    await render();
  } catch (err) {
    setStatus(`불러오기 실패: ${err.message}`, "error");
  }
}

async function render() {
  if (!state.fileBytes) return;
  setStatus("렌더링 중…");

  // Tear down previous canvases + observer attachments.
  els.container.querySelectorAll(".page-wrap").forEach((n) => {
    pageObserver.unobserve(n);
    n.remove();
  });
  state.pageDims = [];

  let doc;
  try {
    doc = new rhwp.HwpDocument(state.fileBytes);
  } catch (err) {
    setStatus(`문서 파싱 실패: ${err.message}`, "error");
    return;
  }

  try {
    if (state.autoFix === true) {
      try { doc.reflowLinesegs(); }
      catch (err) { console.warn("[claw-hwp] reflowLinesegs failed:", err); }
    }

    state.pageCount = doc.pageCount();
    state.currentPage = Math.min(state.currentPage || 1, state.pageCount);
    syncPageNav();

    // First load — we have a parsed doc, ask the user once whether to apply.
    if (!state.asked && state.autoFix === null) {
      state.asked = true;
      showModal();
    }

    const dpr = window.devicePixelRatio || 1;

    for (let i = 0; i < state.pageCount; i++) {
      const wrap = document.createElement("div");
      wrap.className = "page-wrap";
      wrap.dataset.pageIdx = String(i);
      const canvas = document.createElement("canvas");
      wrap.appendChild(canvas);
      els.container.appendChild(wrap);
      pageObserver.observe(wrap);

      // Render at native dimensions × dpr; CSS sizing in applyFit() handles
      // the visible width. Caching canvas.width/.height lets resize stay
      // cheap (CSS-only).
      doc.renderPageToCanvas(i, canvas, dpr);
      state.pageDims.push({ w: canvas.width, h: canvas.height });
    }
    applyFit();
    clearStatus();
  } finally {
    if (typeof doc.free === "function") doc.free();
  }
}

els.autofix.addEventListener("click", () => {
  state.autoFix = state.autoFix === true ? false : true;
  state.asked = true;
  syncAutofixButton();
  render();
});

els.modalAccept.addEventListener("click", () => {
  state.autoFix = true;
  hideModal();
  syncAutofixButton();
  render();
});
els.modalDecline.addEventListener("click", () => {
  state.autoFix = false;
  hideModal();
  syncAutofixButton();
});

els.pagePrev.addEventListener("click", () => scrollToPage(state.currentPage - 1));
els.pageNext.addEventListener("click", () => scrollToPage(state.currentPage + 1));
els.pageInput.addEventListener("change", () => {
  const v = Number(els.pageInput.value);
  if (Number.isFinite(v)) scrollToPage(v);
});
els.pageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const v = Number(els.pageInput.value);
    if (Number.isFinite(v)) scrollToPage(v);
  }
});

loadFromUrl();

// 한컴독스 캡처 도구 — 에이전트 주문용 CLI.
//   node hancom.js capture --file <경로> [--page N] [--grid] [--scale N] [--out <png>]
//   node hancom.js zoom    --name <문서이름> --clip "x,y,w,h" [--page N] [--scale N] [--out <png>]
//
// 좌표계: 캡처는 'A4 페이지 영역만' 깔끔히 잘라낸다(툴바·여백 제외).
//         clip 좌표는 그 페이지의 왼쪽 위(0,0) 기준 CSS px. --grid 가 100px 격자+라벨을 얹어줌.
// 결과 마지막 줄: RESULT_JSON=<...>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const AUTH = path.join(DIR, 'auth.json');
const CAPDIR = path.join(DIR, 'captures');
const HOME = 'https://www.hancomdocs.com/ko/home';
const MYDRIVE = 'https://www.hancomdocs.com/ko/mydrive';
// 세로로 긴 뷰포트: A4 한 장이 통째로 들어가게
const VIEW = { width: 1280, height: 1500 };
const PAGE_H = 1143; // 100% 줌·A4 기준 페이지당 스크롤 높이(px), 문서 무관 일정
// 브라우저 표시 모드 — 기본은 headless(창 없음). --headed면 창을 띄워 동작을 눈으로 볼 수 있다(디버그용).
// (OS 분기 아님 — 런타임 옵션. headed일 때만 slowMo로 동작을 천천히 보여줌.)
let HEADED = false, SLOWMO = 0;

function parseArgs(argv) {
  const a = { _: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      a[k] = v;
    }
  }
  return a;
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const log = (...x) => console.log(...x);
// RESULT_JSON은 기계 판독용 — 비ASCII를 \uXXXX로 이스케이프해 어떤 콘솔 코드페이지(Win CP949 등)서도
// 깨지지 않게 한다. 여전히 유효한 JSON이라 파싱하면 한글이 그대로 복원됨. (OS 무관)
const asciiSafe = (s) => Array.from(s).map((c) => c.charCodeAt(0) > 126 ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c).join('');
const out = (o) => log('RESULT_JSON=' + asciiSafe(JSON.stringify(o)));

async function ensureLoggedIn(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // 리다이렉트가 마무리될 짧은 여유만 (networkidle 대신 domcontentloaded + 0.8s)
  await page.waitForTimeout(800);
  if (page.url().includes('accounts.hancom.com') || page.url().includes('/login')) {
    throw new Error('AUTH_EXPIRED — node login.js 로 재로그인 필요');
  }
}

async function setScroll(ed, top) {
  return await ed.evaluate((t) => {
    const el = document.getElementById('hcwoViewScroll');
    if (!el) return null;
    el.scrollTop = t; el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientH: el.clientHeight };
  }, top);
}

// N페이지로 비례 점프 (총페이지 불필요)
async function gotoPage(ed, n, pageH = PAGE_H) {
  // page 1은 이미 맨 위 → 페이지네이션 강제(끝까지 스크롤) 생략해서 비용 절감
  if (n <= 1) { await setScroll(ed, 0); await ed.waitForTimeout(500); return { estTotal: null, pageH, scrollTop: 0 }; }
  await setScroll(ed, 9_999_999); await ed.waitForTimeout(2000);
  const s = await setScroll(ed, 9_999_999); await ed.waitForTimeout(800);
  const maxTop = s ? s.scrollHeight : n * pageH;
  const target = Math.min(Math.max(0, Math.round((n - 1) * pageH)), maxTop);
  await setScroll(ed, target); await ed.waitForTimeout(1600);
  return { estTotal: Math.max(1, Math.round(maxTop / pageH)), pageH, scrollTop: target, scrollHeight: maxTop };
}

// webhwp 상태바의 '현재 / 총' 쪽수 표시를 읽는다 → 추정(scrollHeight/PAGE_H) 대신 정확값.
// 페이지1에서도 읽히고 off-by-one이 없다. 표시가 없으면(UI 변경 등) null → 호출부가 추정으로 폴백.
async function readPageCount(ed) {
  try {
    return await ed.evaluate(() => {
      const el = document.querySelector('.status_page .section.text_wrap.fit_size')
              || document.querySelector('#status_bar .section.text_wrap.fit_size');
      const m = el && (el.textContent || '').match(/(\d{1,5})\s*\/\s*(\d{1,5})/);
      return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
    });
  } catch { return null; }
}

// 캔버스 픽셀 스캔으로 흰 A4 페이지 사각형(뷰포트 CSS px) 검출
async function detectPageRect(ed) {
  return await ed.evaluate(() => {
    const cvs = Array.from(document.querySelectorAll('canvas'));
    if (!cvs.length) return null;
    let canvas = cvs[0];
    for (const c of cvs) if (c.width * c.height > canvas.width * canvas.height) canvas = c;
    const r = canvas.getBoundingClientRect();
    const W = canvas.width, H = canvas.height;
    const sx = W / r.width, sy = H / r.height;
    const img = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const white = (px, py) => { const i = (py * W + px) * 4; return img[i] > 245 && img[i + 1] > 245 && img[i + 2] > 245; };
    const lefts = [], rights = [];
    for (let ratio = 0.2; ratio <= 0.8; ratio += 0.1) {
      const py = Math.floor(H * ratio); let l = -1, rt = -1;
      for (let px = 0; px < W; px++) if (white(px, py)) { l = px; break; }
      for (let px = W - 1; px >= 0; px--) if (white(px, py)) { rt = px; break; }
      if (l >= 0 && rt > l) { lefts.push(l); rights.push(rt); }
    }
    if (!lefts.length) return null;
    const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const pl = med(lefts), pr = med(rights);
    const colX = Math.min(W - 1, pl + Math.floor((pr - pl) * 0.04) + 3);
    let top = -1, bot = -1, runStart = -1, bestLen = 0;
    for (let py = 0; py < H; py++) {
      if (white(colX, py)) { if (runStart < 0) runStart = py; }
      else if (runStart >= 0) { const len = py - runStart; if (len > bestLen) { bestLen = len; top = runStart; bot = py - 1; } runStart = -1; }
    }
    if (runStart >= 0 && H - runStart > bestLen) { top = runStart; bot = H - 1; }
    return {
      x: Math.round(r.left + pl / sx), y: Math.round(r.top + top / sy),
      width: Math.round((pr - pl) / sx), height: Math.round((bot - top) / sy),
    };
  });
}

// 페이지 영역에 100px 격자+라벨(페이지 로컬 좌표) 오버레이
async function injectGrid(ed, rect) {
  await ed.evaluate((R) => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    Object.assign(svg.style, { position: 'fixed', left: 0, top: 0, width: '100vw', height: '100vh', zIndex: 2147483647, pointerEvents: 'none' });
    svg.setAttribute('width', window.innerWidth); svg.setAttribute('height', window.innerHeight);
    const mk = (t, a) => { const e = document.createElementNS(ns, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
    for (let lx = 0; lx <= R.width; lx += 100) {
      const x = R.x + lx;
      svg.appendChild(mk('line', { x1: x, y1: R.y, x2: x, y2: R.y + R.height, stroke: 'rgba(255,0,0,0.5)', 'stroke-width': lx % 500 === 0 ? 1.5 : 0.6 }));
      const t = mk('text', { x: x + 2, y: R.y + 14, fill: 'red', 'font-size': 12, 'font-family': 'monospace' }); t.textContent = lx; svg.appendChild(t);
    }
    for (let ly = 0; ly <= R.height; ly += 100) {
      const y = R.y + ly;
      svg.appendChild(mk('line', { x1: R.x, y1: y, x2: R.x + R.width, y2: y, stroke: 'rgba(0,90,255,0.5)', 'stroke-width': ly % 500 === 0 ? 1.5 : 0.6 }));
      const t = mk('text', { x: R.x + 2, y: y - 2, fill: 'blue', 'font-size': 12, 'font-family': 'monospace' }); t.textContent = ly; svg.appendChild(t);
    }
    svg.appendChild(mk('rect', { x: R.x, y: R.y, width: R.width, height: R.height, fill: 'none', stroke: 'rgba(0,160,0,0.7)', 'stroke-width': 1.5 }));
    document.body.appendChild(svg);
  }, rect);
}

// webhwp 에디터에서 "문서를 열 수 없습니다" 오류 다이얼로그 감지 (hwp/hwpx 무관 동일)
async function detectOpenError(editor) {
  try {
    return await editor.evaluate(() => {
      const t = (document.body && document.body.innerText) || '';
      return /문서를\s*열\s*수\s*없습니다|파일을\s*여는\s*동안\s*오류/.test(t);
    });
  } catch { return false; }
}

class CannotOpenError extends Error { constructor(name) { super('CANNOT_OPEN'); this.docName = name; } }
// 요청한 파일이 아닌 다른 문서가 열렸을 때(동시 업로드 race·동명 파일 등). 엉뚱한 문서를 캡처/검증하는 사고 차단.
class WrongDocError extends Error { constructor(name, title, docId) { super('WRONG_DOC'); this.docName = name; this.openedTitle = title; this.docId = docId; } }

// 협업/오버레이 흔적 숨기기 (캡처 혼동 방지).
//   DOM 흔적: 협업 커서 이름표·협업자 패널·채팅 위젯 → CSS로 가림.
//   캔버스 흔적: webhwp 는 캔버스를 2층으로 쌓는다 — '문서' 캔버스(흰 배경=불투명 픽셀 다수)와
//     '오버레이' 캔버스(거의 투명; 진입 presence '파란 물방울'·캐럿·원격커서가 여기 그려짐).
//     오버레이 캔버스만 visibility:hidden 하면 본문은 그대로 두고 물방울/커서를 즉시 제거(대기 0초).
//     (과거엔 '캔버스라 못 가림 → 단일 세션 보장만이 해결'로 오진했으나, 층을 나눠 가리면 됨.)
async function hideOverlays(ed) {
  await ed.addStyleTag({ content: `
    .user_cursor_container, .collaborationusers, .user_list, .collabo_user_list,
    .aori_widget, .aori_temp_widget, .aori_main_btn, .aori_main_area
    { display: none !important; visibility: hidden !important; }
  ` }).catch(() => {});
  await hideOverlayCanvases(ed);
}

// 오버레이 캔버스(거의 투명) 숨김. 문서/타일 캔버스(불투명 픽셀 다수)는 보존.
// 불투명 픽셀이 가장 많은 캔버스의 5% 미만인 캔버스만 오버레이로 보고 숨긴다(문서 타일 보호).
async function hideOverlayCanvases(ed) {
  await ed.evaluate(() => {
    const cvs = [...document.querySelectorAll('canvas')];
    if (cvs.length < 2) return; // 캔버스 1장이면 가릴 오버레이 없음
    const stats = cvs.map((c) => {
      let opaque = -1; // -1 = tainted/판독불가 → 건드리지 않음
      try {
        const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 1200)).data;
        opaque = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 10) opaque++;
      } catch { opaque = -1; }
      return { c, opaque };
    });
    const maxOpaque = Math.max(...stats.map((s) => s.opaque));
    if (maxOpaque <= 0) return;
    for (const s of stats) {
      if (s.opaque >= 0 && s.opaque < maxOpaque * 0.05) {
        s.c.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }).catch(() => {});
}

async function openDoc(ctx, page, name) {
  // 파일명을 NFC로 정규화 — NFD(분해형 자모) 파일명(Mac 생성/다운로드 흔함)은 한컴독스가
  // NFC로 표시해 getByText 매칭이 깨진다. NFC면 양쪽이 일치(OS 분기 아님, 유니코드 정규화).
  name = String(name).normalize('NFC');
  await ensureLoggedIn(page, MYDRIVE);
  const row = page.getByText(name, { exact: false }).first();
  // 고정 대기 대신 행이 뜰 때까지만 (없으면 null → 업로드 경로)
  try { await row.waitFor({ timeout: 6000 }); } catch { return null; }
  // 드라이브는 '한 번 클릭 = 열기'. dblclick 은 열기를 2번 트리거해 편집기 탭이 2개 뜨고
  // 둘째(방치) 탭이 같은 계정 협업자로 잡힐 수 있어 단일 click 으로 연다(중복 세션 예방).
  const [editor] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 12000 }),
    row.click(),
  ]);
  await editor.waitForLoadState('networkidle').catch(() => {});
  // 고정 대기 대신 "준비되면 진행"(내용 렌더 or 에러 다이얼로그 즉시 감지) — 매 호출 ~5초 절약
  const st = await waitForReady(editor);
  if (st === 'error') throw new CannotOpenError(name);
  // 엉뚱한 문서 차단: 편집기는 docId 로 신원이 정해진다.
  //   URL  = https://webhwp.hancomdocs.com/webhwp/?mode=HWP_EDITOR&docId=<id>&lang=ko_KR
  //   제목 = "<파일명> - 한컴오피스 Web v2 한글"
  // 이름으로 행을 클릭해 열기 때문에, 다중 세션 파이프라인에서 동시 업로드가 끝나며 다른 행이
  // 열리는 race / 동명 파일 등으로 "요청한 그 파일이 아닌" 문서가 열릴 수 있다. docId 를 1차 신원으로
  // 붙여두고(__docId), 제목으로 교차 확인해 불일치면 즉시 중단한다(잘못된 문서를 캡처/검증하는 사고 차단).
  const ident = await editor.evaluate(() => ({ url: location.href, title: document.title || '' }));
  const docId = (String(ident.url).match(/[?&]docId=([^&#]+)/) || [])[1] || null;
  const title = String(ident.title).normalize('NFC');
  const stem = name.replace(/\.[^.]+$/, '');
  if (title && stem && !title.includes(stem)) throw new WrongDocError(name, title, docId);
  editor.__docId = docId; // 호출부가 결과(out)에 실어 보내 검증·로깅에 쓴다
  // 진입 presence(파란 물방울)는 대기로 빼지 않고, 스크린샷 직전 hideOverlays 에서
  // '오버레이 캔버스 숨김'으로 즉시 제거한다(대기 0초).
  return editor; // 'timeout'이어도 진행(렌더 매우 느린 예외 케이스)
}

// 고정 대기 대신 "준비되면 진행": 캔버스 내용(어두운 픽셀) or 에러 다이얼로그 뜨면 즉시 반환.
async function waitForReady(ed, maxMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const s = await ed.evaluate(() => {
      const t = (document.body && document.body.innerText) || '';
      if (/문서를\s*열\s*수\s*없습니다|파일을\s*여는\s*동안\s*오류/.test(t)) return { error: true };
      const el = document.getElementById('hcwoViewScroll'); if (!el) return {};
      const cvs = [...document.querySelectorAll('canvas')]; if (!cvs.length) return {};
      let c = cvs[0]; for (const x of cvs) if (x.width * x.height > c.width * c.height) c = x;
      let dark = 0;
      try { const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 600)).data; for (let k = 0; k < d.length; k += 4) if (d[k] < 200) { if (++dark > 50) break; } } catch (e) {}
      return { ready: dark > 50 };
    }).catch(() => ({}));
    if (s.error) return 'error';
    if (s.ready) { await ed.waitForTimeout(700); return 'ready'; }
    await ed.waitForTimeout(350);
  }
  return (await detectOpenError(ed)) ? 'error' : 'timeout';
}

async function uploadFile(page, filePath) {
  await ensureLoggedIn(page, HOME);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    page.getByText('문서 업로드').first().click(),
  ]);
  await chooser.setFiles(filePath);
  // '완료'가 뜨면 즉시 다음으로(조기 종료) — 대기는 대용량/느린 업로드를 위한 상한일 뿐이라
  // 작은 파일은 안 느려진다. 25s는 큰 파일에서 짧아 업로드 미완→열기 실패가 났어서 상한을 늘림.
  try { await page.getByText('완료', { exact: false }).first().waitFor({ timeout: 90000 }); } catch {}
  await page.waitForTimeout(2500);
}

async function withEditor(scale, fn) {
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO });
  const ctx = await browser.newContext({ storageState: AUTH, viewport: VIEW, deviceScaleFactor: scale, acceptDownloads: true });
  try { return await fn(ctx, await ctx.newPage()); }
  finally { await browser.close(); }
}

async function cmdCapture(args) {
  if (!args.file) throw new Error('--file 필요');
  const scale = Number(args.scale) || 1.5;
  const name = path.basename(args.file).normalize('NFC'); // 출력 docName도 NFC로(후속 --name 일치)
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    let editor = await openDoc(ctx, page, name);
    if (!editor) {
      log('드라이브에 없음 → 업로드:', name);
      await uploadFile(page, args.file);
      editor = await openDoc(ctx, page, name);
      if (!editor) throw new Error('업로드 후에도 문서를 못 찾음: ' + name);
    } else log('이미 드라이브에 있음 → 열기:', name);

    let pageInfo = null;
    const n = args.page ? Number(args.page) : 1;
    pageInfo = await gotoPage(editor, n, Number(args['page-height']) || PAGE_H);

    const rect = await detectPageRect(editor);
    if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
    await hideOverlays(editor);
    if (args.grid) await injectGrid(editor, rect);

    const pTag = `p${n}_`;
    const suffix = args.grid ? 'grid' : 'full';
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_${pTag}${suffix}_${stamp()}.png`);
    await editor.screenshot({ path: shot, clip: rect });
    // 총 쪽수는 상태바 표시(정확) 우선, 없으면 스크롤 추정 폴백.
    // (상태바의 '현재 쪽'은 캐럿 기준이라 — 스크롤만 하면 page1 고정 — 캡처한 쪽과 무관해서 노출하지 않음.
    //  페이지 점프는 페이지 높이 균일(A4 100%) 가정. 비표준 문서는 --page-height로 보정.)
    const pc = await readPageCount(editor);
    out({ cmd: 'capture', shot, docName: name, docId: editor.__docId || null, page: n,
          totalPages: pc ? pc.total : null,
          estTotalPages: pc ? pc.total : pageInfo.estTotal,
          pageWidth: rect.width, pageHeight: rect.height, scale, grid: !!args.grid });
  });
}

async function cmdZoom(args) {
  if (!args.name || !args.clip) throw new Error('--name 과 --clip 필요');
  const [lx, ly, w, h] = String(args.clip).split(',').map(Number);
  if ([lx, ly, w, h].some(Number.isNaN)) throw new Error('--clip 형식: "x,y,w,h" (페이지 왼쪽위=0,0 기준)');
  const scale = Number(args.scale) || 3;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const editor = await openDoc(ctx, page, args.name);
    if (!editor) throw new Error('문서를 못 찾음: ' + args.name);
    const n = args.page ? Number(args.page) : 1;
    await gotoPage(editor, n, Number(args['page-height']) || PAGE_H);
    const rect = await detectPageRect(editor);
    if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
    await hideOverlays(editor);
    // 페이지 로컬 → 뷰포트 좌표(오프셋), 페이지 경계로 클램프
    const clip = {
      x: rect.x + Math.max(0, lx),
      y: rect.y + Math.max(0, ly),
      width: Math.min(w, rect.width - Math.max(0, lx)),
      height: Math.min(h, rect.height - Math.max(0, ly)),
    };
    const shot = args.out || path.join(CAPDIR, `${String(args.name).replace(/\.[^.]+$/, '')}_p${n}_zoom_${stamp()}.png`);
    await editor.screenshot({ path: shot, clip });
    out({ cmd: 'zoom', shot, docName: args.name, docId: editor.__docId || null, page: n, clipLocal: { x: lx, y: ly, width: w, height: h }, scale });
  });
}

// 찾기 다이얼로그 열기 — 툴바 '찾기' 버튼을 DOM 셀렉터(title)로, 드롭다운의 '찾기...' 항목은
// 실제 위치를 DOM에서 읽어 클릭. (기존 하드코딩 좌표 click(309,95)/(335,167)는 창크기·UI버전·
// 배율에 따라 어긋나 다이얼로그가 안 열려 실패 → 셀렉터/DOM-위치로 견고화. OS 무관.)
async function openFindDialog(ed) {
  await ed.locator('a[title="찾기"]').first().click(); // 메인 찾기 버튼(title 고정 = 좌표 무관)
  await ed.waitForTimeout(900);
  // 드롭다운에서 '보이는' 찾기... 메뉴 항목의 실제 중심좌표를 읽어 클릭(좌표 드리프트 무관).
  // 숨은 동음 항목(툴바 버튼 라벨)을 피하려 offsetParent!=null 로 가시성 필터.
  const item = await ed.evaluate(() => {
    for (const el of document.querySelectorAll('a, div, span')) {
      const t = (el.textContent || '').trim();
      if (/^찾기\.\.\./.test(t) && t.length < 16) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 8 && el.offsetParent !== null)
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  });
  if (!item) throw new Error('찾기 메뉴 항목(찾기...) 탐색 실패');
  await ed.mouse.click(item.x, item.y);
  await ed.waitForTimeout(1200);
}

// 찾기 다이얼로그를 열고 text를 검색해 매치로 점프. 검색칸에만 입력(편집 사고 방지).
// 반환: {found, scrollTop, page} | null
async function findText(ed, text) {
  await openFindDialog(ed);
  // 새로 뜬 보이는 input = 검색칸
  const box = await ed.evaluate(() => {
    const ins = Array.from(document.querySelectorAll('input')).map(el => { const r = el.getBoundingClientRect(); return { el, x: r.x, y: r.y, w: r.width, h: r.height, vis: r.width > 60 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden' && el.getAttribute('aria-label') !== '문서 편집 영역' }; });
    // 다이얼로그 중앙쯤(세로 1/3~2/3)에 있는 가장 넓은 입력
    const cand = ins.filter(i => i.vis && i.y > 300).sort((a, b) => b.w - a.w)[0];
    return cand ? { x: Math.round(cand.x), y: Math.round(cand.y), w: Math.round(cand.w), h: Math.round(cand.h) } : null;
  });
  if (!box) throw new Error('검색칸 탐색 실패');
  await ed.mouse.click(box.x + Math.min(box.w / 2, 40), box.y + box.h / 2);
  await ed.keyboard.press('ControlOrMeta+A'); // 전체선택: Win/Linux→Ctrl+A, Mac→Cmd+A 자동 매핑(OS 무관)
  await ed.keyboard.type(text, { delay: 25 });
  // "다음 찾기" 버튼 ≈ 검색칸 오른쪽(+70, 같은 행)
  const nextBtn = { x: box.x + box.w + 70, y: box.y - 1 };
  await ed.mouse.click(nextBtn.x, nextBtn.y); await ed.waitForTimeout(1600);
  // 찾기 직후 캐럿이 매치로 이동 → 상태바 '현재 쪽'이 매치의 실제 페이지(정확)
  const page = await readCurrentPage(ed);
  // 캐럿(매치) 뷰포트 픽셀 위치 = '텍스트 위치로 바로 확대'의 앵커. 닫기 전에 읽어둔다.
  const caret = await readCaretRect(ed);
  await ed.mouse.click(nextBtn.x, nextBtn.y + 53); await ed.waitForTimeout(700); // 닫기
  await ed.keyboard.press('Escape'); await ed.waitForTimeout(400); // 검색 하이라이트 제거(혼동 방지)
  // 새 세션이라 캐럿이 1쪽에서 시작 → 매치가 2쪽 이상이면 page>1. (1쪽 매치/미발견 구분은 한계)
  return page && page > 0 ? { found: true, page, caret } : { found: false };
}

// 찾기 직후 캐럿(매치 위치) 요소의 뷰포트 사각형. webhwp 는 캐럿을 DOM 요소로 그린다.
async function readCaretRect(ed) {
  return await ed.evaluate(() => {
    const el = document.querySelector('#HWP_CURSOR_VIEW, .BLINK_CURSOR');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }).catch(() => null);
}

// 상태바 "현재 쪽 / 전체쪽" 에서 현재 쪽(캐럿 기준) 읽기
async function readCurrentPage(ed) {
  return await ed.evaluate(() => {
    for (const e of document.querySelectorAll('*')) {
      const t = (e.textContent || '').trim();
      const m = t.match(/(\d+)\s*\/\s*[\d?]+\s*쪽/);
      if (m && t.length < 60) return Number(m[1]);
    }
    return null;
  });
}

async function cmdAround(args) {
  if (!args.name || !args.text) throw new Error('--name 과 --text 필요');
  // --zoom: 매치 줄을 확대(고배율 기본). 일반 around 는 페이지 전체(1.5).
  const scale = Number(args.scale) || (args.zoom ? 2.5 : 1.5);
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const editor = await openDoc(ctx, page, args.name);
    if (!editor) throw new Error('문서를 못 찾음: ' + args.name);
    const r = await findText(editor, String(args.text));
    if (!r.found) { out({ cmd: 'around', found: false, text: args.text }); return; }

    // --zoom: 격자 읽기 없이 '텍스트 위치로 바로 확대'. 찾기가 이미 매치로 스크롤했으므로
    //   gotoPage 생략하고, 그 스크롤 상태에서 캐럿 줄을 가로 밴드로 잘라낸다.
    if (args.zoom && r.caret) {
      const rect = await detectPageRect(editor);
      if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
      await hideOverlays(editor);
      const band = Number(args.band) || 180;               // 매치 줄 위아래 포함 높이(페이지 px)
      // 세로 경계는 '문서 캔버스'(캐럿을 항상 포함)로 클램프하고, detectPageRect 는 가로(x/width)에만 쓴다.
      // 찾기가 매치를 뷰포트 하단으로 스크롤하면 뷰포트가 두 페이지에 걸쳐, detectPageRect 가 캐럿이 없는
      // 옆 페이지의 흰 영역(더 큰 쪽)을 잡는다 → 그 rect 바닥이 캐럿보다 위라 height 가 음수로 붕괴(40px)하고
      // 밴드가 매치 위(이전 줄/제목)로 어긋나던 버그. 캐럿은 항상 보이므로 캔버스 세로범위로 클램프하면 안전. (OS 무관)
      const view = await editor.evaluate(() => {
        const cvs = [...document.querySelectorAll('canvas')]; if (!cvs.length) return null;
        let c = cvs[0]; for (const x of cvs) if (x.width * x.height > c.width * c.height) c = x;
        const b = c.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.top + b.height) };
      });
      const vTop = view ? view.top : rect.y;
      const vBot = view ? view.bottom : rect.y + rect.height;
      const top = Math.max(vTop, r.caret.y - Math.round(band / 2));
      const clip = {
        x: rect.x, y: top, width: rect.width,
        height: Math.max(40, Math.min(band, vBot - top)),
      };
      const shot = args.out || path.join(CAPDIR, `${String(args.name).replace(/\.[^.]+$/, '')}_findzoom_${stamp()}.png`);
      await editor.screenshot({ path: shot, clip });
      out({ cmd: 'around', found: true, zoom: true, text: args.text, docId: editor.__docId || null, page: r.page, shot, pageWidth: rect.width, band, scale });
      return;
    }

    // 기본: 매치 페이지를 깔끔히 정렬 후 페이지 전체 클린 캡처
    await gotoPage(editor, r.page);
    const rect = await detectPageRect(editor);
    if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
    await hideOverlays(editor);
    if (args.grid) await injectGrid(editor, rect);
    const shot = args.out || path.join(CAPDIR, `${String(args.name).replace(/\.[^.]+$/, '')}_find_${stamp()}.png`);
    await editor.screenshot({ path: shot, clip: rect });
    out({ cmd: 'around', found: true, text: args.text, docId: editor.__docId || null, page: r.page, shot, pageWidth: rect.width, pageHeight: rect.height, scale, grid: !!args.grid });
  });
}

// 여러 단서를 각각 검색해 가장 많이 수렴하는 페이지를 찾아 캡처 (반복/모호한 단어 보완).
async function cmdLocate(args) {
  if (!args.name || !args.clues) throw new Error('--name 과 --clues "a,b,c" 필요');
  const clues = String(args.clues).split(',').map((s) => s.trim()).filter(Boolean);
  if (!clues.length) throw new Error('--clues 가 비어있음');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO });
  try {
    const results = [];
    for (const clue of clues) {
      const ctx = await browser.newContext({ storageState: AUTH, viewport: VIEW, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      try {
        const ed = await openDoc(ctx, page, args.name);
        if (!ed) throw new Error('문서를 못 찾음: ' + args.name);
        const r = await findText(ed, clue);
        results.push({ clue, page: r.found ? r.page : null });
        log(`  '${clue}' → ${r.found ? r.page + '쪽' : '없음'}`);
      } finally { await ctx.close(); }
    }
    // 최빈 페이지 = 수렴 지점
    const votes = {};
    results.forEach((r) => { if (r.page) votes[r.page] = (votes[r.page] || 0) + 1; });
    const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
    const converged = ranked.length ? Number(ranked[0][0]) : null;
    let shot = null, docId = null;
    if (converged) {
      const ctx = await browser.newContext({ storageState: AUTH, viewport: VIEW, deviceScaleFactor: scale });
      const page = await ctx.newPage();
      try {
        const ed = await openDoc(ctx, page, args.name);
        docId = ed.__docId || null;
        await gotoPage(ed, converged);
        const rect = await detectPageRect(ed);
        if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
        await hideOverlays(ed);
        if (args.grid) await injectGrid(ed, rect);
        shot = args.out || path.join(CAPDIR, `${String(args.name).replace(/\.[^.]+$/, '')}_locate_p${converged}_${stamp()}.png`);
        await ed.screenshot({ path: shot, clip: rect });
      } finally { await ctx.close(); }
    }
    out({ cmd: 'locate', clues: results, votes, converged, docId, shot });
  } finally { await browser.close(); }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  HEADED = !!args.headed;                                    // --headed: 창 띄워 보기(디버그)
  SLOWMO = args.slowmo ? Number(args.slowmo) : (HEADED ? 400 : 0); // headed면 동작을 천천히
  try {
    if (args._ === 'capture') await cmdCapture(args);
    else if (args._ === 'zoom') await cmdZoom(args);
    else if (args._ === 'around') await cmdAround(args);
    else if (args._ === 'locate') await cmdLocate(args);
    else { log('사용법: capture --file <경로> [--page N] [--grid] | zoom --name <이름> --clip "x,y,w,h" [--page N] | around --name <이름> --text "<검색어>" [--grid] | locate --name <이름> --clues "a,b,c" [--grid]'); process.exit(2); }
    process.exit(0);
  } catch (e) {
    if (e instanceof CannotOpenError || e.message === 'CANNOT_OPEN') {
      out({ status: 'cannot_open', docName: e.docName, reason: 'webhwp가 파일을 열 수 없습니다(손상/형식 오류). hwp·hwpx 무관 동일 에러.' });
      process.exit(5);
    }
    if (e instanceof WrongDocError || e.message === 'WRONG_DOC') {
      out({ status: 'wrong_doc', docName: e.docName, openedTitle: e.openedTitle, docId: e.docId,
            reason: '요청한 파일과 다른 문서가 열렸습니다(동시 업로드 race·동명 파일 등). 재시도 전 드라이브 상태 확인 필요.' });
      process.exit(6);
    }
    console.error('ERR', e.message);
    out({ error: e.message });
    process.exit(e.message.startsWith('AUTH_EXPIRED') ? 4 : 1);
  }
})();

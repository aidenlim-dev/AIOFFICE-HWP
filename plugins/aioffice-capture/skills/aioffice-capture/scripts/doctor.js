// 실행 전 자가진단(preflight) — 캡처를 돌리기 전에 "이 환경에서 돌아갈 수 있는 상태인가"를 점검하고
// 다음에 실행할 명령 한 줄을 찍어준다. 콜드 스타트 Claude는 이걸 한 번 돌리고 시키는 대로만 하면 된다.
//
//   node doctor.js           빠른 점검(파일/설치 존재만)
//   node doctor.js --deep    + 실제 한컴독스에 접속해 로그인 세션이 살아있는지까지 검증(약 2초 추가)
//
// 점검: node(풀경로) / playwright / chromium / auth.json(로그인 세션) / pw-profile 잠금 / (--deep)세션유효
// 출력: 사람용 줄들 + 마지막 줄 RESULT_JSON={...} (기계 판독용, ASCII-safe)
// 종료코드: 0=READY, 4=AUTH_EXPIRED(--deep 한정), 10=DEPS_MISSING, 11=CHROMIUM_MISSING, 12=AUTH_MISSING
// 읽기 전용 — 위험한 동작(프로세스 종료·파일 삭제) 안 함. 진단만 하고 "이렇게 하라"고 알려준다.
// (OS 무관 — process.platform 분기 없음. 모든 점검은 node API로만.)
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const AUTH = path.join(DIR, 'auth.json');
const PROFILE = path.join(DIR, 'pw-profile');
const MYDRIVE = 'https://www.hancomdocs.com/ko/mydrive'; // 세션 유효성 확인용(hancom.js와 동일 경로)
const DEEP = process.argv.slice(2).includes('--deep');

const log = (...x) => console.log(...x);
// RESULT_JSON은 기계 판독용 — 비ASCII를 \uXXXX로 이스케이프해 어떤 콘솔 코드페이지(Win CP949 등)서도
// 안 깨지게. 유효한 JSON이라 파싱하면 한글 그대로 복원. (hancom.js와 동일 패턴)
const asciiSafe = (s) => Array.from(s).map((c) => c.charCodeAt(0) > 126 ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c).join('');
const out = (o) => log('RESULT_JSON=' + asciiSafe(JSON.stringify(o)));

// ── 기본 점검(동기, 빠름) ──────────────────────────────────────────────────
// node: 지금 이 스크립트가 node로 돌고 있으니 항상 OK. 풀경로를 노출해 "node가 PATH에 없는"
//       Windows 환경에서도 이후 명령을 절대경로로 실행할 수 있게 한다.
const node = { version: process.version, path: process.execPath };

// playwright: 설치 여부 (node_modules/playwright)
let playwrightOk = false, pw = null;
try { pw = require('playwright'); playwrightOk = true; } catch (e) { playwrightOk = false; }

// chromium: playwright가 받아둔 브라우저 실행파일이 실제로 존재하는지
let chromiumOk = false, chromiumPath = null;
if (playwrightOk) {
  try { chromiumPath = pw.chromium.executablePath(); } catch (e) { chromiumPath = null; }
  chromiumOk = !!(chromiumPath && fs.existsSync(chromiumPath));
}

// auth.json: 로그인 세션 파일 존재 여부 (※파일 존재 ≠ 세션 유효. 유효성은 --deep 또는 캡처 시 확인)
const authOk = fs.existsSync(AUTH);

// pw-profile 잠금: 이전 크롬이 안 죽어서 남긴 락 흔적(best-effort 힌트). 캡처는 launch()라 영향 없고,
// 주로 login.js(영속 컨텍스트)에서 발생. login.js가 자동 정리·재시도하므로 게이트가 아니라 경고로만.
let profileLock = false;
if (fs.existsSync(PROFILE)) {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    if (fs.existsSync(path.join(PROFILE, f))) { profileLock = true; break; }
  }
}

// ── 세션 유효성 라이브 확인(--deep, 비동기) ────────────────────────────────
// 실제로 헤드리스 브라우저에 저장된 세션을 싣고 마이드라이브에 접속 → 로그인 화면으로 튕기면 만료.
// 반환: true=유효, false=만료, null=확인 불가(네트워크 오류 등). (hancom.js ensureLoggedIn과 같은 판정)
async function checkAuthLive() {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ storageState: AUTH });
    const page = await ctx.newPage();
    await page.goto(MYDRIVE, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(800);
    const u = page.url();
    return !(u.includes('accounts.hancom.com') || u.includes('/login'));
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  // --deep 은 기본 점검이 모두 통과(설치·파일 존재)했을 때만 의미가 있다.
  let authLive = null; // true/false/null(미확인)
  if (DEEP && playwrightOk && chromiumOk && authOk) {
    try { authLive = await checkAuthLive(); }
    catch (e) { authLive = null; log('[WARN] --deep 라이브 확인 실패(네트워크?) :', e.message); }
  }

  const checks = { node: true, playwright: playwrightOk, chromium: chromiumOk, auth: authOk, authLive, profileLock };

  // ── 다음에 할 일 결정 (우선순위: deps → chromium → auth파일 → (deep)세션만료 → ready) ──
  let status, code, next;
  if (!playwrightOk) {
    status = 'DEPS_MISSING'; code = 10;
    next = { who: 'agent', commands: ['npm install', 'npx playwright install chromium'],
             note: '의존성 설치(에이전트가 바로 실행). Chromium 수백 MB 다운로드, 1~2분. 사용자에게 "최초 1회 설치 중"이라고 알려라.' };
  } else if (!chromiumOk) {
    status = 'CHROMIUM_MISSING'; code = 11;
    next = { who: 'agent', commands: ['npx playwright install chromium'],
             note: 'Chromium만 누락(에이전트가 바로 실행). 수백 MB 다운로드, 1~2분.' };
  } else if (!authOk) {
    status = 'AUTH_MISSING'; code = 12;
    next = { who: 'agent', commands: ['node login.js'],
             note: '로그인 세션이 없다. 기본은 에이전트가 직접 `node login.js`로 로그인 창을 띄우는 것 — 뜬 창에서 사용자가 한컴독스에 로그인(평소 쓰는 방식대로)하면 자동 저장된다(창 닫을 필요 없음). 예외: 네가 SSH/원격 비대화형 셸이라(대표적으로 Windows OpenSSH = Session 0) 띄운 창이 사용자 화면에 안 보이는 상황이면, 직접 실행하지 말고 사용자에게 "당신 세션에서 `! node login.js` 를 실행하세요"라고 부탁하라. (SSH 여부 힌트: 환경변수 SSH_CONNECTION 존재)' };
  } else if (authLive === false) {
    status = 'AUTH_EXPIRED'; code = 4;
    next = { who: 'agent', commands: ['node login.js'],
             note: '세션이 만료됐다(라이브 확인). AUTH_MISSING과 동일 — 기본은 에이전트가 직접 `node login.js`로 재로그인 창을 띄운다. 창이 안 보이는 원격/SSH 상황이면 사용자에게 `! node login.js` 실행을 부탁하라.' };
  } else {
    status = 'READY'; code = 0;
    const caveat = authLive === true ? ' (세션 라이브 확인됨)'
                 : ' (세션 만료 여부는 미검증 — 의심되면 `node doctor.js --deep`, 아니면 캡처가 만료 시 exit 4로 알려준다)';
    next = { who: 'agent', commands: ['node hancom.js capture --file <절대경로> --page 1'],
             note: '준비 완료. 캡처/줌/검색을 바로 실행해도 된다.' + caveat };
  }

  // ── 사람용 출력 ──────────────────────────────────────────────────────────
  const mark = (b) => (b ? 'OK  ' : 'MISS');
  const authLine = !authOk ? '없음 → node login.js 로 로그인(기본 에이전트, SSH면 사용자)'
                 : authLive === true ? '세션 유효 (라이브 확인됨)'
                 : authLive === false ? '세션 만료 (라이브 확인) → 사용자 재로그인'
                 : authLive === null && DEEP ? '세션 파일 있음 (라이브 확인 실패 — 네트워크?)'
                 : '세션 파일 있음 (만료 여부는 --deep 또는 캡처 시 확인)';
  log('=== aioffice-capture 자가진단' + (DEEP ? ' --deep' : '') + ' ===');
  log(`[${mark(true)}] node        ${node.version}  (${node.path})`);
  log(`[${mark(playwrightOk)}] playwright  ${playwrightOk ? '설치됨' : '없음 → npm install'}`);
  log(`[${mark(chromiumOk)}] chromium    ${chromiumOk ? chromiumPath : '없음 → npx playwright install chromium'}`);
  log(`[${mark(authOk && authLive !== false)}] auth.json   ${authLine}`);
  if (profileLock) log('[WARN] pw-profile 에 락 흔적 — login.js 가 스테일 락이면 자동 정리·재시도한다. 그래도 PROFILE_LOCKED(exit 6)면 열린 Chrome 창을 모두 닫고 재실행.');
  log('');
  log(`상태: ${status}`);
  log(`다음(${next.who === 'agent' ? '에이전트 실행' : '사용자 실행'}):`);
  next.commands.forEach((c) => log(`  ${c}`));
  log(`  → ${next.note}`);
  log('');

  out({ ok: status === 'READY', status, checks, node, chromiumPath, next });
  process.exit(code);
})().catch((e) => { console.error('ERR', e.message); out({ ok: false, status: 'DOCTOR_ERROR', error: e.message }); process.exit(1); });

// 로그인 완료를 자동 감지해 storageState(세션 쿠키+localStorage)를 auth.json으로 저장.
// 사용자는 열린 창에서 한컴독스 로그인만 하면 된다. 창을 닫을 필요 없음.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILE = path.join(__dirname, 'pw-profile');
const AUTH = path.join(__dirname, 'auth.json');

const LAUNCH_OPTS = {
  headless: false,
  viewport: { width: 1280, height: 900 },
  // OAuth 제공자(특히 Google)가 자동화 제어 브라우저를 차단("이 브라우저는 안전하지 않을 수 있음")하는 것을
  // 회피: --enable-automation 기본 플래그를 빼고 navigator.webdriver 표식을 끈다. (OS 무관 런치 옵션)
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
};

// 이전 크롬이 깔끔히 안 닫혀 남긴 스테일 락("profile in use" / Windows code 32 = 공유위반)을 자가치유.
// 프로세스 강제 종료는 OS 분기가 필요하므로 쓰지 않는다(단일 코드베이스 원칙). 대신:
//   ① 스테일 락 파일 best-effort 제거(fs만, OS 무관) → ② 잠깐 대기 후 1회 재시도.
// 죽은 프로세스의 락은 이걸로 풀리고, 살아있는 프로세스가 잡고 있으면 어차피 무엇으로도 못 푸니
// 명확한 조치(모든 Chrome 닫기 / pw-profile 삭제)를 사용자에게 안내한다.
function looksLikeLock(msg) {
  return /ProcessSingleton|SingletonLock|profile.*in use|being used by another process|EBUSY|EPERM|code:\s*32|cannot access the file/i.test(msg || '');
}
function clearStaleLocks() {
  if (!fs.existsSync(PROFILE)) return;
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.rmSync(path.join(PROFILE, f), { force: true }); } catch (e) {}
  }
}
async function launchPersistent() {
  try {
    return await chromium.launchPersistentContext(PROFILE, LAUNCH_OPTS);
  } catch (e) {
    if (!looksLikeLock(e.message)) throw e;
    console.log('PROFILE_LOCK 감지 — 스테일 락 정리 후 1회 재시도합니다...');
    clearStaleLocks();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await chromium.launchPersistentContext(PROFILE, LAUNCH_OPTS);
    } catch (e2) {
      throw new Error(
        'PROFILE_LOCKED — 이전 한컴독스 브라우저가 아직 떠 있어 프로파일이 잠겨 있습니다. '
        + '열려 있는 Chrome/Chromium 창을 모두 닫고 다시 `node login.js` 를 실행하세요. '
        + `그래도 안 되면 프로파일 폴더를 삭제 후 재시도: ${PROFILE}`
      );
    }
  }
}

(async () => {
  const ctx = await launchPersistent();
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.hancomdocs.com/home', { waitUntil: 'domcontentloaded' });
  console.log('LOGIN_OPEN — 창에서 한컴독스에 로그인하세요. 자동으로 감지합니다.');

  const deadline = Date.now() + 5 * 60 * 1000; // 5분
  let saved = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    let url = '';
    try { url = page.url(); } catch (e) {}
    // 로그인 표지: 한컴독스 도메인 + 업로드/문서 UI 존재, 그리고 accounts.hancom.com 아님
    if (url.includes('hancomdocs.com') && !url.includes('accounts.hancom.com') && !url.includes('/login')) {
      let marker = 0;
      try {
        marker = (await page.getByText('문서 업로드').count())
               + (await page.getByText('Upload', { exact: false }).count())
               + (await page.locator('input[type=file]').count());
      } catch (e) {}
      console.log('poll url=', url, 'marker=', marker);
      if (marker > 0) {
        await ctx.storageState({ path: AUTH });
        console.log('AUTH_SAVED ->', AUTH);
        saved = true;
        break;
      }
    } else {
      console.log('poll url=', url, '(아직 로그인 전)');
    }
  }
  await ctx.close().catch(() => {});
  if (!saved) { console.log('TIMEOUT — 로그인 감지 실패'); process.exit(3); }
  console.log('DONE');
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  // 종료코드: 6=PROFILE_LOCKED(프로파일 잠김, 사용자 조치 필요), 1=기타
  process.exit(/^PROFILE_LOCKED/.test(e.message) ? 6 : 1);
});

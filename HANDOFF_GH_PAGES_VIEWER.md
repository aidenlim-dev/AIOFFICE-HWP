# 핸드오프: GitHub Pages 정적 뷰어 배포

이 문서는 새 Claude Code 세션이 본 작업을 이어받기 위한 컨텍스트입니다.

## 한 줄 요약

claw-hwp 의 HWP/HWPX 뷰어를 **GitHub Pages 정적 사이트로 호스팅** 해서, cowork 사용자가 launcher / Node 설치 없이 브라우저 URL 한 번에 .hwp 미리보기 가능하게 만든다.

## 배경 — 왜 하나

현재 cowork (claude.ai 웹 cowork, Claude Desktop cowork 모드) 의 미리보기 흐름:

1. 에이전트가 .hwp 파일 + 3개 OS launcher 다운로드 링크 (`preview-mac.command` / `preview-windows.bat` / `preview-linux.sh`) emit
2. 사용자가 OS 맞는 launcher 받아서 .hwp 옆에 두고 더블클릭
3. launcher 가 로컬 `preview-server.js` 띄우고 브라우저에서 미리보기 열어줌

**문제**: launcher 가 사용자 PC 의 **Node.js 18+** 를 요구함. 한국 사무실 PC (대부분 Windows) 에 Node 안 깔린 상태가 보통이라 friction 큼.

**해결안**: 뷰어 자체 (`preview-viewer.html` + `preview-viewer.js` + rhwp WASM) 를 **GitHub Pages 정적 사이트** 로 배포. 사용자는 URL 만 클릭하면 브라우저에서 바로 뷰어 뜨고, 자기 .hwp 파일을 drag-drop / 파일 선택으로 넣으면 렌더됨. **Node / Python / 설치 / launcher 모두 불필요.**

비교한 4가지 옵션:

| 옵션 | UX | 엔지니어링 | 결정 |
|---|---|---|---|
| (A) 현재 launcher 유지, Node 요구 | ✗ "Node 깔아라" | 0 | 유지 (대안과 병존) |
| (B) launcher 가 Node 자동 다운로드 | △ 첫 실행 ~30MB | 중 | 미선택 |
| (C) **GH Pages 정적 뷰어 + drag-drop** | ✓ URL 클릭만 | 중 | **선택** |
| (D) launcher 를 native binary 로 컴파일 (deno/bun) | ✓ | 큰 (3 OS 빌드 + 코드 사이닝) | 미선택 |

옵션 (C) 가 launcher / 설치 / 권한 모두 없애는 가장 깔끔한 경로.

> 참고: hop (golbin/hop) 은 Tauri (Rust + 시스템 WebView) 로 native installer 배포해서 Node 의존성 없앰. 동일 효과지만 우리는 이미 브라우저 viewer 가 있으니 GH Pages 가 더 빠른 경로.

## 현재 상태 (2026-05-14 기준)

### 이미 동작하는 부분

- **`preview-server.js` (3737)** — Node 기반 로컬 서버. `?path=<abs path>` 쿼리로 호출하면 disk 에서 파일 읽어서 viewer 한테 넘김. Code Desktop / CLI 에서 사용. 잘 작동.
- **`preview-viewer.html` + `preview-viewer.js` + `vendor/rhwp/`** — 브라우저에서 도는 vanilla JS canvas 뷰어. rhwp WASM 으로 .hwp / .hwpx 둘 다 렌더 (rhwp 가 매직바이트로 알아서 분기).
- **방금 추가한 file picker 버튼** — 우측 상단 📁 아이콘. `?path=` 없이 3737 root 접근하면 picker 만 보이고, 클릭 → 시스템 file picker → 선택 → 같은 `state.fileBytes → render()` 흐름으로 진입. **이 picker 동작 검증은 이 세션에서 시작했지만 사용자가 새 세션 열기 직전에 끝남 — 새 세션에서 한 번 더 확인 권유.**

### 안 한 것 (이 세션에서 결정만)

- **GH Pages 배포** — 아직 없음
- **drag-drop UI** — 이 세션에서 시도했다가 standalone 모드 / 별도 dropzone overlay 추가했는데 잘 안 잡혀서 사용자 요청으로 모두 revert. 현재는 file picker 만 있음.
- **viewer 의 sub-path 호스팅 대응** — `preview-viewer.html` 의 `<script src="/preview-viewer.js">` 와 `viewer.js` 의 `import("/vendor/rhwp/rhwp.js")`, `module_or_path: "/vendor/rhwp/rhwp_bg.wasm"` 모두 leading `/` (사이트 root 기준 절대경로). GH Pages 가 `/<repo>/` sub-path 로 호스팅하면 이 경로들이 깨짐. **수정 필요**.

## 작업 분류

### 1. viewer 의 GH Pages 호환

**파일**: `plugins/claw-hwp/skills/hwp/scripts/preview-viewer.html`, `preview-viewer.js`

leading `/` 절대경로를 모듈 상대경로로 바꿔야 함. 안 그러면 GH Pages 의 `/claw-hwp/` 같은 sub-path 에서 자산 못 찾음. 단 **3737 preview-server 호환성도 깨지면 안 됨** — 두 호스트 다 작동해야 함.

수정 대상:
- `preview-viewer.html` line 247: `<script type="module" src="/preview-viewer.js">` → `src="preview-viewer.js"` (leading `/` 제거)
- `preview-viewer.js` line ~36-37:
  ```js
  const rhwp = await import("/vendor/rhwp/rhwp.js");
  await rhwp.default({ module_or_path: "/vendor/rhwp/rhwp_bg.wasm" });
  ```
  → `import.meta.url` 기준 상대 URL 로:
  ```js
  const rhwpJsUrl = new URL("vendor/rhwp/rhwp.js", import.meta.url);
  const rhwpWasmUrl = new URL("vendor/rhwp/rhwp_bg.wasm", import.meta.url);
  const rhwp = await import(rhwpJsUrl.href);
  await rhwp.default({ module_or_path: rhwpWasmUrl.href });
  ```
  이렇게 해도 3737 (root 호스트) 에서는 동일하게 `/vendor/...` 로 resolve 됨 (이전 세션에서 검증 완료).

- `viewer.js` 의 `fetch("/__heartbeat", ...)` (line 301) — 3737 일 때만 의미 있음. GH Pages 에서는 404 뜸. **catch 로 silent 실패 처리** 되어 있어서 깨지진 않지만, sub-path 라면 그냥 안 보내는 게 깔끔. `if (location.port === "3737") setInterval(...)` 같이 가드.
- `viewer.js` 의 `fetch("/file?path=...")` (loadFromUrl 안) — `?path=` 가 있을 때만 도는 코드라 GH Pages 에서는 기본 안 탐. picker 흐름만 도는 게 정상. 그래서 그대로 둬도 OK.

### 2. drag-drop 추가 (필수)

picker 만 있으면 데스크탑 사용자한테 부족함. **drag-drop 도 반드시 같이 작동해야 함**. 이 세션에서 시도했다가 잘 안 잡혀서 revert 한 이유는 너무 많은 걸 동시에 바꿨기 때문 — 새 세션에서는 picker 가 작동하는 걸 baseline 으로 확정한 후, drag-drop 만 별도로 작은 incremental 변경으로 추가.

drag-drop 추가 시 핵심:
- `window` 레벨에 `dragover` 리스너 + `e.preventDefault()` (이거 없으면 drop 안 일어남, 브라우저 기본 동작)
- `drop` 리스너에서 `e.dataTransfer.files[0]` 받아서 `loadFromFile(file)` 호출 (이 세션에서 만든 함수)
- 시각 피드백 (drag enter 시 윤곽선 / 안내 메시지) 은 사용자가 "여기에 떨어뜨리면 되는구나" 알게 해주는 데 중요. nice-to-have 아니라 UX 핵심.
- 첫 파일 로드 후에도 drag-drop 가능해야 함 (다른 파일로 교체 시나리오) — 첫 drop 후 listener 가 죽으면 안 됨.

이전 세션 시도 코드는 git history 에 안 남아있음 (커밋 안 했음). 새로 짜는 게 빠름.

drag-drop 검증 체크리스트:
- [ ] 첫 진입 시 drag-drop 으로 파일 떨어뜨리면 렌더됨
- [ ] 첫 파일 렌더 후 두 번째 파일 drag-drop 하면 교체되어 렌더됨
- [ ] picker 와 drag-drop 둘 다 동일하게 작동
- [ ] 잘못된 파일 (예: .pdf) drag-drop 시 에러 메시지 명확

### 3. 새 repo 또는 같은 repo 에서 GH Pages 활성화

옵션:
- **(a) 같은 repo 에 `/docs` 폴더 만들어 GH Pages 활성화** — Settings → Pages → Source: `main` branch, `/docs` folder. 그러면 `https://dohyun468.github.io/claw-hwp/` 에 호스팅됨. **plugin repo 와 viewer repo 가 한 곳에 있어 유지보수 단순.**
- **(b) 별도 repo 만들기 (예: `claw-hwp-viewer`)** — `https://dohyun468.github.io/claw-hwp-viewer/`. 깔끔한 분리지만 동기화 필요 (viewer 코드 변경 시 두 곳 push).

추천: **(a) `/docs` 폴더**. plugin 의 `scripts/` 변경이 viewer 에도 그대로 전파되도록 빌드 스크립트 하나 두면 됨 (예: `npm run build:viewer` 가 `scripts/preview-viewer.{html,js}` + `vendor/` 를 `/docs/` 로 복사).

### 4. 빌드 & 배포 흐름

`/docs/` 가 viewer 의 정적 자산을 담아야 함. 필요한 파일:
- `index.html` (= `preview-viewer.html` 복사. 단 `?path=` 없이 들어왔을 때 picker 만 보이는 게 default 가 되도록)
- `preview-viewer.js` 복사
- `vendor/rhwp/rhwp.js` 복사
- `vendor/rhwp/rhwp_bg.wasm` 복사
- `vendor/fflate/index.mjs` 복사 (preview-viewer 가 필요로 함)

**`vendor/cfb` 는 불필요** — node 측 .hwp 파싱용이라 브라우저 viewer 에서는 안 씀.

빌드 스크립트 예 (Node):
```js
// scripts/build-viewer.js
import { cp, mkdir } from "fs/promises";
const src = "plugins/claw-hwp/skills/hwp/scripts";
const dst = "docs";
await mkdir(`${dst}/vendor/rhwp`, { recursive: true });
await mkdir(`${dst}/vendor/fflate`, { recursive: true });
await cp(`${src}/preview-viewer.html`, `${dst}/index.html`);
await cp(`${src}/preview-viewer.js`, `${dst}/preview-viewer.js`);
await cp(`${src}/vendor/rhwp/rhwp.js`, `${dst}/vendor/rhwp/rhwp.js`);
await cp(`${src}/vendor/rhwp/rhwp_bg.wasm`, `${dst}/vendor/rhwp/rhwp_bg.wasm`);
await cp(`${src}/vendor/fflate/index.mjs`, `${dst}/vendor/fflate/index.mjs`);
console.log("viewer built to /docs/");
```

CI 옵션 (선택): GitHub Actions 로 main push 시 자동 빌드 + commit. 단순화하려면 일단 수동.

### 5. SKILL.md / README 업데이트

뷰어 호스팅되면:
- **SKILL.md** 의 cowork 분기 (현재 launcher 링크 emit) 를 GH Pages URL 로 교체. 단 **launcher 는 deprecate 하지 말고 fallback 으로 유지** — 인터넷 끊긴 환경 등에서 유용.
  - 새 1순위: "여기에 .hwp 끌어넣으세요: `https://dohyun468.github.io/claw-hwp/`"
  - 2순위 (인터넷 안 되거나 용량 큰 파일 등): launcher 다운로드 링크
- **README.md** 의 "환경별 사용법 → Cowork" 섹션도 같이 업데이트. launcher 단계 → URL 클릭 으로 단순화.

### 6. 검증

- [ ] `/docs/` 빌드 후 로컬에서 `python3 -m http.server 8000 -d docs` 띄워서 `http://127.0.0.1:8000/` 접속 → picker 작동 확인
- [ ] `/docs/` 를 sub-path 시뮬레이션: `python3 -m http.server 8000` 띄우고 `http://127.0.0.1:8000/docs/` 접속 → 모든 자산이 sub-path 에서도 로드되는지 확인 (relative URL 이 잘 풀리는지)
- [ ] GH Pages 배포 후 `https://dohyun468.github.io/claw-hwp/` 에서 직접 ktx.hwp drag-drop 또는 picker 로 렌더되는지 확인
- [ ] Chrome / Safari 둘 다에서 작동 확인 (Safari 의 localhost vs 127.0.0.1 quirk 주의)

## 새 세션 시작 권장 흐름

1. 이 MD 읽고 컨텍스트 파악
2. 현재 `preview-viewer.{html,js}` 가 file picker 까지 포함된 상태인지 git diff / 커밋 로그 확인 (이 세션 변경분은 아직 커밋 안 됨)
3. picker 가 3737 에서 진짜로 작동하는지 baseline 검증 (이게 안 되면 GH Pages 도 안 됨)
4. 위 1-6 순서대로 진행
5. 마지막으로 plugin version bump + commit + push + 마켓플레이스 cache refresh (이 세션에서 1.0.8 까지 push 됨, 다음은 1.0.9 또는 의미 변화 크면 1.1.0)

## 관련 메모리

- `[[feedback_surface_precision]]` — surface 별 정확히 분리. cowork / Code CLI / Code Desktop 묶지 말 것.
- `[[project_marketplace_submission]]` — 1.0.6 이미 검토 대기 중 (2026-05-14 제출). 이 viewer 작업은 검토 결과와 별개로 진행 가능 — repo 갱신만 되면 마켓플레이스도 따라옴 (정확한 update propagation 정책은 미검증).

## 본 세션이 시도했다가 revert 한 것 (반복 방지)

- standalone 모드 (`?path=` 없으면 다른 동작) 분기 추가 — 너무 복잡해짐
- 별도 `#dropzone` overlay (full-screen drop 영역) — 이벤트 잡힘은 됐는데 UX 불안정
- WASM URL 을 `import.meta.url` 기준으로 변경 — **GH Pages 호환 위해서는 결국 해야 함**, 새 세션에서 다시 적용
- 에러 메시지 직렬화 헬퍼 추가 — 좋은 변경이지만 picker 가 baseline 잡힌 후에 별도로

새 세션에서는 **하나씩 incremental 하게** 가기. picker 작동 → wasm URL 상대화 → /docs 빌드 → GH Pages 활성화 → SKILL/README 업데이트, 각 단계 끝에 잠깐 멈춰서 baseline 깨졌는지 확인.

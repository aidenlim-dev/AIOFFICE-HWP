<h1 align="center">claw-hwp</h1>

<p align="center">
  Claude 에서 한글 문서 (.hwp / .hwpx) 를 다룰 수 있게 해주는 스킬입니다. 읽기 · 만들기 · 편집을 Claude Code · Desktop · 웹 어디서든.<br/>
  <a href="https://github.com/edwardkim/rhwp">rhwp</a> WASM 기반.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/status-WIP-orange" alt="WIP" />
</p>

<p align="center">
  <strong>한국어</strong> · <a href="README_EN.md">English</a>
</p>

---

## 소개

`claw-hwp` 는 Claude 가 한글 문서 (.hwp / .hwpx) 를 직접 다룰 수 있도록 해주는 [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) 입니다. 한국 사무 환경에서는 한컴오피스 형식이 사실상 표준인데, Claude 는 기본적으로 이 형식을 읽거나 편집하지 못합니다. 이 스킬을 설치하면 Claude 가 다음 작업을 할 수 있습니다:

- **읽기** — .hwp / .hwpx 의 본문, 표, 메타데이터 추출
- **만들기** — 새 문서 작성 (제목·문단·표·이미지·페이지 나누기 포함). 단, 표가 들어가야 하면 `.hwp` 로 출력해야 합니다 — 아래 [현재 제한사항](#현재-제한사항) 참조
- **편집** — 기존 문서의 텍스트 치환, 문단 추가, 서식 변경 등 — XML 을 풀어서 Claude 의 `Edit` 툴로 직접 수정
- **변환** — `.hwp ↔ .hwpx` 양방향 변환 (rhwp WASM). 무손실은 아닙니다 — 라운드트립 시 표·이미지가 손상될 수 있습니다
- **미리보기** — rhwp 가 렌더한 페이지를 인라인 또는 브라우저에서 확인 (환경별로 방식이 다름 — 아래 [환경별 사용법](#환경별-사용법) 참조)

읽기 / 만들기 / 편집 / 변환은 Bash 와 파일 시스템을 쓸 수 있는 데스크탑 앱 환경에서 작동합니다 — Claude Code CLI, Claude Code Desktop (Code 모드), Claude Desktop cowork 모드. (claude.ai 웹은 v1 에서 플러그인 설치 미지원)

미리보기는 환경마다 방식이 다릅니다:

| 환경 | 미리보기 |
|---|---|
| Claude Code Desktop (Code 모드) | 대화 옆 인라인 패널 |
| Claude Code CLI | 로컬 `localhost:3737` 브라우저 링크 (에이전트가 서버 자동 기동) |
| Claude Desktop cowork 모드 | <https://dohyun468.github.io/claw-hwp/> 페이지에 파일 끌어 놓기 (Node 설치 불필요) |

한컴오피스 / LibreOffice / Windows COM 모두 **필요 없습니다**.

## 왜 raw-patch 가 필요한가 — 한컴독스 호환 in-place edit

rhwp 의 `exportHwp()` (Hop 앱이 쓰는 그 함수) 가 **기존 큰 폼 round-trip 시 한컴독스 reject**. 검증된 사실:

- ✓ Hop 에서 새 문서 → 저장 → 한컴독스 열림 (from-scratch)
- ✗ **Hop 에서 ktx 같은 큰 폼 open → cell 수정 ("엣지형" → "테스트") → 저장 → 한컴독스 reject** (2026-05-22 직접 검증)
- ✗ 우리 plugin 의 rhwp-emit fallback (최신 v0.7.12 vendor + 모든 post-process 제거) → 같은 결과

즉 rhwp 자체의 한계 — Hop 도 같은 문제 가짐. **우리 raw-patch (`cell-patch.js`) 는 이 문제를 회피하기 위한 별도 경로**: 기존 `.hwp` 의 모든 bytes 를 통째 유지하고 변경 부분만 byte-level 로 patch. CFB 컨테이너 자체 재구성 안 함 (sheetjs `CFB.write` 도 회피 — `Sh33tJ5` directory entry 박혀서 한컴독스 reject).

즉, 표 셀 수정 / 텍스트 치환 / paragraph 추가 / 표 추가 / 페이지 설정 등 **기존 파일 in-place edit** 은 raw-patch 경로가 유일하게 한컴독스 호환. 새 문서 생성 (`setup_document` 부터 시작) 은 rhwp emit 경로 그대로 OK.

## 현재 제한사항

rhwp 직렬화 한계에서 오는 제약입니다. 사용 전에 아시면 좋습니다.

- **`.hwpx` 로 출력할 때 표가 사라집니다.** `create.js` 로 새 `.hwpx` 를 만들거나 `.hwp → .hwpx` 변환을 하면 rhwp 의 `exportHwpx()` 가 표를 드롭합니다. **표가 들어가야 하면 `.hwp` 로 출력하세요.** 정 `.hwpx` 가 필요하면 한컴오피스나 한컴독스에서 한 번 열었다 저장하면 표 XML 이 다시 만들어집니다.
- **기존 `.hwp` 파일을 편집하면 그 안의 표가 사라질 수 있습니다.** `.hwp` 편집 경로는 내부적으로 `.hwpx` 변환을 한 번 거치는데, 그 단계에서 표가 드롭됩니다. **기존 표를 보존하면서 편집해야 한다면 `.hwpx` 원본으로 시작하세요** — 이 경로는 XML 을 직접 편집하므로 표가 그대로 유지됩니다.
- **`.hwp ↔ .hwpx` 라운드트립은 손실이 있습니다.** 표 / 이미지 / 복잡한 도형이 손상될 수 있으니, 가능하면 `.hwpx` 를 원본 형식으로 두고 `.hwp` 출력은 명시적으로 필요한 경우에만 사용하세요.
- **기존 `.hwp` 에 이미지 추가 (`append_image` in-place)** 는 v1 에서 아직 한컴독스 호환 안 됨. raw-patch 의 mini-stream chain 처리 정밀 디버그 중. 새 `.hwp` 를 처음부터 만들면서 이미지 포함하는 경우는 rhwp emit 으로 OK (Hop 동작과 동일).
- **PDF / DOCX 변환은 아직 지원하지 않습니다.** 추후 LibreOffice headless 연동으로 추가할 예정입니다.

## 의존하는 프로젝트

- **[edwardkim/rhwp](https://github.com/edwardkim/rhwp)** — HWP 파싱·렌더·`.hwp` ↔ `.hwpx` 변환을 담당하는 Rust + WebAssembly 코어. 이 스킬은 rhwp 기반입니다.
- **[golbin/hop](https://github.com/golbin/hop)** — rhwp 를 감싼 오픈소스 HWP 데스크탑 앱. 에디터 UX 패턴을 참고했습니다.
- **[anthropics/skills](https://github.com/anthropics/skills)** — Anthropic 공식 스킬 저장소. `docx`, `pptx`, `xlsx` 스킬의 구조를 본떠서 만들었습니다.

## 한국 HWP 오픈소스 생태계

claw-hwp 는 한국 HWP 형식을 오픈소스로 다루려는 더 큰 흐름의 일부입니다. 각 프로젝트가 다른 자리에서 보완 관계로 작동합니다:

| 프로젝트 | 역할 | 언제 쓰나 |
|---|---|---|
| **[rhwp](https://github.com/edwardkim/rhwp)** | HWP 파싱/렌더 코어 (Rust + WASM) | 다른 프로젝트들의 기반 |
| **[hop](https://github.com/golbin/hop)** | HWP 데스크탑 뷰어 (Tauri) | macOS / Linux 에서 .hwp 열어보기 |
| **claw-hwp** | Claude/AI 워크플로우용 HWP 스킬 | AI 와 함께 한글 문서 생성·요약·편집 |

데스크탑 GUI 가 필요하면 `hop`, AI 워크플로우가 필요하면 `claw-hwp` 를 보세요.

## 상태

🚧 v1.0 공식 마켓플레이스 검토 대기 중 (2026-05-14 제출). 읽기 / 만들기 / 편집 / 변환 / 미리보기 파이프라인은 네 가지 환경에서 모두 동작 확인.

## 로드맵

- [x] v0 — `SKILL.md` 결정 트리
- [x] v0.1 — `references/hwpx-format.md` (Claude 가 직접 편집할 때 참조하는 XML 스키마)
- [x] v0.2 — Node 스크립트 (`extract_text.js`, `convert.js`)
- [x] v0.3 — Python 스크립트 (`unpack.py`, `pack.py`, `validate.py`)
- [x] v0.4 — rhwp `samples/` fixture 대상 end-to-end 스모크 테스트 (round-trip 검증)
- [x] v0.5 — Claude Code 플러그인 manifest + 마켓플레이스 정의
- [x] v0.6 — `references/rhwp-api.md` (`@rhwp/core` API 레퍼런스)
- [x] v0.7 — `create.js` 핵심 op (setup_document, append_{heading,paragraph,table,list,image}, replace_text, page/column break, load-then-append, 확장자 기반 `.hwp`/`.hwpx` 디스패치)
- [x] v0.8 — Node 의존성 vendoring — Code / Desktop / 웹 어디서든 zero-config 설치
- [x] v0.9 — 플러그인 아이콘
- [x] v1.0 — 공식 마켓플레이스 제출 (검토 대기)
- [ ] v1.1 — 각주 (`append_paragraph_with_footnotes`) + Markdown→HWP 인용 스타일 (numeric_inline / footnote / footnote_with_bibliography)
- [ ] v1.2+ — PDF / DOCX 변환, 이미지 추출, 뷰어/에디터 React 패키지

## 설치

> **Claude Desktop 앱 (Mac / Windows)** 기준입니다. claude.ai 웹은 현재 플러그인 설치를 지원하지 않아 v1 에서는 데스크탑 앱에서만 동작합니다 — 웹 사용자는 [Claude Desktop](https://claude.com/download) 을 받아서 진행해 주세요.

### 일반 사용자 — Customize 메뉴에서 추가 (3 단계)

1. Claude Desktop 의 **Code** 탭에서 왼쪽 사이드바 **Customize** 클릭 *(한글/영문 UI 모두 "Customize" 그대로 표시됩니다)*.
2. **개인 플러그인** *(Personal plugins)* 옆 **`+`** → **플러그인 생성** *(Create plugin)* → **마켓플레이스 추가** *(Add marketplace)* 선택.
3. URL 칸에 아래 한 줄 붙여넣고 **동기화** *(Sync)* 클릭:

   ```
   https://github.com/DoHyun468/claw-hwp
   ```

**동기화 누르면 설치 끝.** 개인 플러그인 목록에 `claw-hwp` 가 자동으로 추가되고 바로 활성화됩니다. 이후 `.hwp` / `.hwpx` 파일을 채팅에 드롭하거나 파일명을 언급하면 자동으로 스킬이 작동합니다.

<!-- TODO(media): Customize → Personal plugins → Add marketplace → Sync 클릭 흐름 스크린샷 -->

### 첫 사용 — Claude 에게 이렇게 말하세요

설치 끝났으면 Claude 는 `.hwp` / `.hwpx` 가 컨텍스트에 있을 때 자동으로 이 스킬을 부릅니다. 추상적인 "설정해줘" / "만들어줘" 요청은 Claude 가 새 스킬을 처음부터 만들려 하거나 별도 install 단계를 안내할 수 있어서 헷갈리는 결과로 이어집니다.

| ✅ 잘 통하는 요청 | ⚠️ Claude 가 헷갈리는 요청 |
|---|---|
| `report.hwp 보여줘` (파일 첨부) | `claw-hwp 따라서 만들어줘` |
| `이 한글 파일 열어줘` | `preview 기능 설치해줘` |
| `회의록.hwp 에 다음 줄 추가해줘` | `claw-hwp 스킬 설정해줘` |
| `2026 → 2027 로 바꿔줘` | `한글 플러그인 셋업해줘` |

요지: `.hwp` 파일이나 파일명을 함께 언급하면 자동 호출됩니다. preview 도 자동으로 떠요 — 별도 설치/설정 단계 없습니다.

### 업데이트 후엔 새 세션을 띄워 주세요

진행 중인 세션은 시작 시점의 스킬 스냅샷을 끝까지 들고 갑니다 — `claude plugin marketplace update claw-hwp` 또는 Customize → Sync 로 cache 가 새 버전으로 올라가도, **이미 열려 있던 세션은 옛 SKILL.md / 옛 스크립트로 계속 동작합니다**. 새 버전 동작 (예: 표 셀 채우기의 한컴독스-호환 raw-patch 경로) 을 보려면 기존 세션을 종료하고 새 세션을 여세요.

### 개발자 — Claude Code CLI (명령어 한 줄)

```bash
# 1. 마켓플레이스 등록 (한 번만)
claude plugin marketplace add https://github.com/DoHyun468/claw-hwp

# 2. 플러그인 설치
claude plugin install claw-hwp@claw-hwp
```

설치 후 `.hwp` / `.hwpx` 파일을 언급하면 Claude Code 가 자동으로 스킬을 불러옵니다. 업데이트는 `claude plugin marketplace update claw-hwp`.

> **별도 의존성 설치 불필요**. Node 의존성 (`@rhwp/core` WASM 약 5 MB, `fflate` 약 80 KB) 이 `scripts/vendor/` 에 vendoring 돼 있어, Node 18+ / Python 3.9+ 만 있으면 바로 작동합니다 — `npm install` 단계 없습니다.

전체 결정 트리 (read / create / edit / convert / validate) 는 `plugins/claw-hwp/skills/hwp/SKILL.md` 를 참조하세요.

## 환경별 사용법

미리보기 동작 방식만 환경마다 조금씩 다릅니다 (읽기/만들기/편집 흐름 자체는 어디서든 같음). 본인 환경에 맞는 항목을 보세요.

> 이 섹션은 Bash + 파일시스템 접근이 있는 데스크탑 앱 환경 (Code 모드 / cowork 모드) 과 Claude Code CLI 만 다룹니다. Claude Desktop 의 일반 chat 모드 와 claude.ai 웹 (v1 플러그인 미지원) 에서는 이 스킬이 동작하지 않습니다 — 단, 미리보기 페이지 <https://dohyun468.github.io/claw-hwp/> 자체는 누구나 `.hwp` / `.hwpx` 파일만 있으면 브라우저에서 바로 쓸 수 있습니다 (설치 불필요).

### Claude Code Desktop (Code 모드)

`.hwp`/`.hwpx` 파일을 채팅에 드롭하거나 파일 이름을 언급하면 됩니다. 렌더된 문서가 **대화 옆 패널에 인라인으로** 열립니다 — 기본은 패널 안에서 끝납니다. 큰 화면 / 사이드-바이-사이드 비교 / 다른 사람한테 공유가 필요하면 같이 emit 되는 웹 뷰어 링크 (<https://dohyun468.github.io/claw-hwp/>) 로 브라우저에서 열어 드래그 드롭하면 됩니다. 대화하면서 문서를 빠르게 넘겨볼 때 편리합니다.

<!-- TODO(media): Desktop Code 모드 — 인라인 미리보기 패널 스크린샷/영상 -->

### Claude Code CLI

`.hwp`/`.hwpx` 파일을 채팅에 드롭하면 Claude 가 클릭할 수 있는 링크를 출력합니다. 클릭하면 기본 브라우저에서 문서가 열립니다. 작은 로컬 서버는 탭을 닫고 약 2 분 후 알아서 종료되므로 따로 정리할 게 없습니다.

<!-- TODO(media): CLI — 마크다운 링크 + 브라우저 미리보기 스크린샷/영상 -->

### Claude Desktop — Cowork 모드

Cowork 는 Claude 가 원격 샌드박스에서 돌기 때문에 미리보기 서버에 직접 접근할 수 없습니다. 대신 같은 뷰어를 **GitHub Pages 정적 페이지** 로 호스팅해 둡니다:

1. Claude 가 `.hwp` / `.hwpx` 파일과 함께 뷰어 링크를 줍니다 — <https://dohyun468.github.io/claw-hwp/>
2. 파일을 내려받아서 그 페이지에 끌어 놓거나 우측 상단 폴더 아이콘으로 선택합니다.
3. 브라우저 안에서 바로 렌더됩니다. 파일은 외부로 업로드되지 않습니다 — rhwp WASM 이 사용자 브라우저 안에서 직접 파싱합니다.

설치 / Node / 권한 모두 불필요합니다. 줌 (Ctrl+휠 또는 슬라이더), 페이지 이동, 자동 보정 토글 모두 작동합니다.

오프라인 환경이거나 GitHub Pages 가 막혀 있는 경우의 대안으로 OS 별 launcher 도 있습니다 (`.command` / `.bat` / `.sh` — 파일 옆에 두고 더블클릭, Node.js 18+ 필요). Claude 가 필요할 때 알려줍니다.

<!-- TODO(media): cowork — 호스팅 뷰어에 드래그 드롭 → 렌더 스크린샷/영상 -->

## 요구사항

- Node.js 18+
- Python 3.9+

LibreOffice / 한컴오피스는 **필요 없습니다**. 단 추후 PDF / DOCX 변환을 추가할 때는 LibreOffice headless 가 있으면 사용할 예정입니다.

## 라이선스

MIT — [LICENSE](LICENSE) 참조. Copyright © 2026 RECON Labs Inc.

---

<p align="center">
  <a href="https://www.reconlabs.ai/">
    <img src="https://avatars.githubusercontent.com/u/82856082?s=160&v=4" width="72" alt="RECON Labs" />
  </a>
</p>

<p align="center">
  Generative-AI 3D 콘텐츠 플랫폼 — <a href="https://www.reconlabs.ai/">reconlabs.ai</a> · <a href="https://github.com/RECON-Labs-Inc">@RECON-Labs-Inc</a>
</p>

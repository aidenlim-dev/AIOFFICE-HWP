<h1 align="center">claw-hwp</h1>

<p align="center">
  Claude 어디서든 한글 문서. .hwp / .hwpx 읽기 · 만들기 · 편집을 Claude Code · Desktop · 웹 모두에서.<br/>
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

## 이게 뭐야?

`claw-hwp` 는 Claude 가 한글 문서 (.hwp / .hwpx) 를 직접 다룰 수 있게 해주는 [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) 입니다. 한국 오피스 환경 대부분이 한컴오피스의 .hwp / .hwpx 형식에 묶여있는데, Claude 는 기본적으로 이 형식을 읽거나 편집하지 못합니다. 이 스킬이 그 갭을 메워서 다음 작업이 가능합니다:

- **읽기** — HWP/HWPX 텍스트, 표, 메타데이터
- **생성** — 새 .hwpx 문서를 처음부터 작성
- **편집** — 기존 문서 (텍스트 치환, 표 채우기, 서식 변경) — XML 을 풀어서 Claude 의 `Edit` 툴로 직접 편집
- **변환** — `.hwp ↔ .hwpx` 무손실 변환 (rhwp WASM)
- **미리보기** — 한컴오피스 수준 fidelity 로 페이지 렌더 (사용 환경 별로 다름 — 아래 참조)

읽기 / 생성 / 편집 / 변환은 Claude 가 Bash 와 파일 시스템에 접근할 수 있는 모든 환경에서 작동합니다 — Claude Code CLI, Claude Code Desktop (Code 모드), Claude Desktop cowork 모드, claude.ai cowork.

미리보기 환경 별 지원:

| 환경 | 뷰어 |
|---|---|
| Claude Code Desktop (Code 모드) | 인라인 미리보기 패널 |
| Claude Code CLI | 로컬 `localhost:3737` 브라우저 링크 (에이전트가 서버 자동 기동) |
| Claude Desktop cowork 모드 | OS 별 launcher (`.command` / `.bat` / `.sh`) — 파일 옆에 두고 더블클릭, 브라우저 열림 |
| claude.ai cowork (웹) | OS 별 launcher (`.command` / `.bat` / `.sh`) — 파일 옆에 두고 더블클릭, 브라우저 열림 |

한컴오피스 / LibreOffice / Windows COM **모두 불필요**.

## 기반

- **[edwardkim/rhwp](https://github.com/edwardkim/rhwp)** — Rust + WebAssembly 뷰어/에디터 코어. 모든 파싱·렌더링·`.hwp` ↔ `.hwpx` 변환을 담당. rhwp 없으면 이 프로젝트 자체가 성립 안 됨.
- **[golbin/hop](https://github.com/golbin/hop)** — rhwp 를 감싼 오픈소스 HWP 데스크탑 앱. 에디터 UX 패턴 참조.
- **[anthropics/skills](https://github.com/anthropics/skills)** — Anthropic 공식 스킬 저장소. `docx`, `pptx`, `xlsx` 스킬을 구조 청사진으로 사용.

## 상태

🚧 초기 개발. 읽기 / 편집 / 변환 end-to-end 파이프라인 동작 중. `create.js` 와 공식 마켓플레이스 제출이 다음 마일스톤.

## 로드맵

- [x] v0 — `SKILL.md` 결정 트리
- [x] v0.1 — `references/hwpx-format.md` (Claude 가 직접 편집할 수 있게 만든 XML 스키마 치트시트)
- [x] v0.2 — Node 스크립트 (`extract_text.js`, `convert.js`)
- [x] v0.3 — Python 스크립트 (`unpack.py`, `pack.py`, `validate.py`)
- [x] v0.4 — rhwp `samples/` fixture 대상 end-to-end smoke 테스트 (round-trip 검증)
- [x] v0.5 — Claude Code 플러그인 manifest + 단일 플러그인 마켓플레이스
- [x] v0.6 — `references/rhwp-api.md` (큐레이션된 `@rhwp/core` API 레퍼런스)
- [x] v0.7 — `create.js` 코어 op (setup_document, append_{heading,paragraph,table,list,image}, replace_text, page/column break, load-then-append, 확장자 기반 `.hwp`/`.hwpx` 디스패치)
- [x] v0.8 — Vendored Node 의존성 — Code / Desktop / 웹 어디서든 zero-config 설치
- [x] v0.9 — 플러그인 아이콘
- [ ] v1.0 — 공식 릴리스, Anthropic 공식 마켓플레이스 제출
- [ ] v1.1 — 각주 (`append_paragraph_with_footnotes`) + Markdown→HWP 인용 스타일 (numeric_inline / footnote / footnote_with_bibliography) — MyAgent 패리티 차별화
- [ ] v1.2+ — PDF / DOCX 변환, 이미지 추출, 뷰어/에디터 React 패키지

## 설치

같은 스킬 폴더가 모든 Claude 환경에서 작동합니다. 본인이 사용하는 환경 하나만 따라하세요.

### Claude Code (CLI) — 권장

```bash
# 1. 마켓플레이스 추가 (한 번만)
claude plugin marketplace add https://github.com/DoHyun468/claw-hwp

# 2. 플러그인 설치
claude plugin install claw-hwp@claw-hwp
```

이게 끝. Claude Code 가 `.hwp`/`.hwpx` 파일 언급 시 자동으로 스킬을 로드합니다. 업데이트는 `claude plugin marketplace update claw-hwp` 로.

### Claude Desktop (macOS / Windows 앱)

1. 이 repo 를 clone 또는 다운로드.
2. Claude Desktop → **설정 → Skills** → *Upload skill* → `plugins/claw-hwp/skills/hwp/` 폴더 선택 (또는 zip 으로 압축 후 업로드).
3. `.hwp`/`.hwpx` 파일 첨부하거나 한글 문서 작업 언급 시 자동 로드.

### claude.ai (웹, Pro / Max / Team / Enterprise)

1. 이 repo 를 clone 또는 다운로드.
2. claude.ai → **Settings → Capabilities → Skills** → *Add skill*.
3. `plugins/claw-hwp/skills/hwp/` 폴더를 zip 으로 압축 후 업로드.

> **Zero-config**. Node 의존성 (`@rhwp/core` WASM ~5 MB, `fflate` ~80 KB) 이 `scripts/vendor/` 에 vendored 돼 있어 Node 18+ / Python 3.9+ 만 있으면 바로 작동 — `npm install` 단계 없음.

전체 결정 트리 (read / create / edit / convert / validate) 는 `plugins/claw-hwp/skills/hwp/SKILL.md` 참조.

## 환경별 사용법

미리보기는 Claude 를 어디서 쓰느냐에 따라 다릅니다. 본인 환경에 맞는 줄을 찾으세요 — 읽기/생성/편집 흐름 자체는 어디서든 동일하게 작동합니다.

### Claude Code Desktop (Code 모드) — 가장 매끄러운 경로

`.hwp`/`.hwpx` 를 채팅에 드롭하거나 (또는 그냥 파일 이름 언급). 렌더된 문서가 **인라인으로, 대화 옆 패널에** 열림 — 브라우저 탭 없음, 클릭할 링크 없음. Claude 와 대화하면서 빠르게 문서 넘겨보기에 최적.

<!-- TODO(media): Desktop Code 모드 — 인라인 미리보기 패널 스크린샷/영상 -->

### Claude Code CLI

`.hwp`/`.hwpx` 를 채팅에 드롭. Claude 가 클릭 가능한 링크를 출력 → 클릭 → 기본 브라우저에서 문서 열림. 작은 로컬 서버는 탭 닫고 약 2 분 후 알아서 종료 — 청소할 거 없음.

<!-- TODO(media): CLI — 마크다운 링크 + 브라우저 미리보기 스크린샷/영상 -->

### Cowork (claude.ai 웹 cowork, Claude Desktop 의 cowork 모드)

Cowork 는 Claude 를 원격 샌드박스에서 돌리기 때문에, 미리보기는 **본인 컴퓨터** 에서 돌아야 합니다. Claude 가 작은 launcher 로 이걸 처리:

1. Claude 가 `.hwp` 파일과 함께 OS 별 launcher 다운로드 링크 3개를 줌 — 본인 OS 에 맞는 거 하나 선택 (`.command` = Mac, `.bat` = Windows, `.sh` = Linux)
2. launcher 를 `.hwp` 파일과 같은 폴더에 저장
3. launcher 더블클릭 → 브라우저에서 미리보기 열림

이게 끝. launcher 는 **Node.js 18+** 가 설치돼 있어야 함. 첫 실행 시 작은 뷰어 번들 (~5 MB) 을 다운로드해서 로컬 캐시. macOS 는 첫 실행 시 Gatekeeper 경고 — 우클릭 → **열기** 한 번이면, 그 다음부터는 그냥 작동.

<!-- TODO(media): cowork — launcher 링크 + 더블클릭 → 브라우저 미리보기 스크린샷/영상 -->

## 의존성

- Node.js 18+
- Python 3.9+

LibreOffice / 한컴오피스는 **불필요**. PDF/DOCX 변환 (이후 릴리스) 은 LibreOffice headless 가 있으면 사용 예정.

## 라이선스

MIT — [LICENSE](LICENSE) 참조. Copyright © 2026 RECON Labs Inc.

---

<p align="center">
  <a href="https://www.reconlabs.ai/">
    <img src="https://avatars.githubusercontent.com/u/82856082?s=160&v=4" width="72" alt="RECON Labs" />
  </a>
</p>

<h3 align="center"><a href="https://www.reconlabs.ai/">RECON Labs</a> 에서 만들고 유지보수합니다</h3>

<p align="center">
  Generative-AI 3D 콘텐츠 플랫폼 — <a href="https://www.reconlabs.ai/">reconlabs.ai</a> · <a href="https://github.com/RECON-Labs-Inc">@RECON-Labs-Inc</a>
</p>

# MyAgent의 HWP 처리 — 스냅샷 (2026-05-09)

claw-hwp 개발 컨텍스트로, 같은 시점의 MyAgent(코어 + backend + frontend)가 `.hwp`/`.hwpx` 를 어떻게 다루는지 기록. 또 바뀔 수 있는 영역이라 **로그 목적**. 추측 배제, 코드 인용 위주.

조사 범위: `MyAgent/`, `MyAgent-backend/`, `MyAgent-frontend/`. 인용은 `repo/path:line` 표기.

## 0. 한 줄 요약

업로드 제약 없이 받음 → 백엔드는 LibreOffice(+python-hwpx 미들웨어)로 PDF 프리뷰 만듦 → LLM 도구는 **rhwp WASM** 기반 `read_hwp` / `create_hwp_pro` / `convert_md_to_hwp`로 읽기·생성·MD 변환 모두 자체 구현. **claw-hwp 플러그인과는 완전 무관 (참조 0건)** — 둘 다 rhwp를 기반으로 하지만 래퍼는 별개.

## 1. 엔드-투-엔드 흐름

```
업로드  ──►  /files/upload (확장자 검증 X)
         MyAgent-backend/main.py:780-796

저장   ──►  워크스페이스 디렉토리

프리뷰 ──►  /preview/as-pdf?path=...
         MyAgent-backend/main.py:1685, 1716-1756
         · .hwp  → soffice --convert-to pdf 직접
         · .hwpx → python-hwpx로 HTML 추출 → soffice → PDF
                   (LibreOffice가 hwpx 직접 수용 불가)

프론트 ──►  PDFViewer (highlight + drag-select)
         MyAgent-frontend/app/types.ts (kind: 'hwp')
         MyAgent-frontend/app/lib/formatters.ts (.hwp/.hwpx → 'hwp')
         MyAgent-frontend/CLAUDE.md (preview-as-pdf 라우팅 결정 2026-04-28)

LLM 도구 ─►  read_hwp / create_hwp_pro / convert_md_to_hwp
         MyAgent/myagent/agent/tools/hwp.py
         MyAgent/myagent/agent/tools/hwp_pro.py
         → run_worker("read_hwp.mjs" / "create_hwp.mjs")
         → @rhwp/core (WASM)
```

## 2. 코어 도구 인벤토리

| 도구 | 파일 | 역할 | 비고 |
|---|---|---|---|
| `read_hwp` | `MyAgent/myagent/agent/tools/hwp.py:1-121` | `.hwp`(바이너리) + `.hwpx`(XML) 모두 처리, md/text/json 출력 | 레거시 `pyhwp` + `python-hwpx` 스택 **완전 대체**. 현재 메인 reader. |
| `create_hwp_pro` | `MyAgent/myagent/agent/tools/hwp_pro.py:1-150+` | Op 기반 편집 API | `setup_document` / `append_heading` / `append_paragraph_with_footnotes` / `append_table` / `append_bullet_list` / `append_page_break` / `append_image` / `replace_text`. 출력 확장자(`.hwp`/`.hwpx`)로 포맷 자동 결정. |
| `convert_md_to_hwp` | `MyAgent/myagent/agent/tools/` (CLAUDE.md:61) | Markdown → `.hwp`/`.hwpx` | 인용 렌더링 모드 3종: `numeric_inline`(기본), `footnote`, `footnote_with_bibliography`. **2026-05-08 기본값을 `footnote_with_bibliography` → `numeric_inline`로 변경** (rhwp 각주 pagination 한계 회피). |
| `read_hwpx` / `edit_hwpx` (레거시) | `MyAgent/README.md:123` | python-hwpx 기반 | "식약처 문서 전용"으로 명시 제한. `.hwp`는 `hwp5txt` CLI로 텍스트만. |

각주 구현 주의:
- `append_paragraph_with_footnotes` 전용. 기존 `append_paragraph`는 각주 미지원.
- rhwp 렌더는 페이지 하단 각주 영역을 **칠하지 않음** — 데이터는 저장됨. 한컴 Office/LibreOffice는 정상 렌더 → PDF 변환 시에는 각주 보임.

## 3. 문서 스타일 디폴트

`MyAgent/myagent/skills/document-formatting/SKILL.md:91-150`

- 한국 정부 공문서 관례를 디폴트로: `함초롬바탕` 10pt, 줄간 30%, justify, A4 25mm 마진
- 헤딩 크기 레벨별 정의 (`#` 18pt, `##` 14pt, ...)
- 같은 Markdown 소스로 `convert_md_to_docx`와 `convert_md_to_hwp`를 **쌍으로 출력**하라는 가이드 (Word/HWP 이중 산출물)

## 4. 프론트엔드 분기 지점

| 위치 | 동작 |
|---|---|
| `MyAgent-frontend/app/types.ts` | `kind: 'pdf' \| 'hwp' \| 'docx' \| ...` — hwp 독립 타입 |
| `MyAgent-frontend/app/constants.ts` | `hwp: '/icons/file-types/hwp.svg'` 아이콘 매핑 |
| `MyAgent-frontend/app/lib/formatters.ts` | `.hwp` / `.hwpx` 둘 다 `'hwp'` 로 정규화 |
| `MyAgent-frontend/app/hooks/useSourcesPanel.ts` | `if (fileKind === 'hwp' && isWorkspace)` 출처 패널 분기 |
| `MyAgent-frontend/CLAUDE.md` (2026-04-28) | hwp/docx 프리뷰는 `/preview/as-pdf` 경유. 사유: docx-preview의 `w:lastRenderedPageBreak` 의존, **rhwp/editor iframe이 agent-generated hwpx에서 panic**, LibreOffice 헤드리스가 더 안정적. |

## 5. 끊기는 지점

- **pharma_dossier 검색 파이프라인** (`search_*` 도구군) 은 hwp를 직접 지원하지 않음. 사용자가 수동 업로드한 hwp만 `read_hwp`로 텍스트 추출 가능.
- **HWPX의 LibreOffice 직결 불가**는 python-hwpx 미들웨어로 우회 — 근본 해결 아님 (LibreOffice 자체가 hwpx 미지원).
- **명시 미지원 분기/예외 처리 코드 없음**. "TODO/FIXME/지원 예정" 주석 grep 0건 (`hwp.py`, `hwp_pro.py` 전수 스캔).

## 6. claw-hwp 플러그인과의 관계

| 항목 | MyAgent | claw-hwp |
|---|---|---|
| 위치 | 모놀리스 내부 tool | 독립 Claude 플러그인 (마켓플레이스 배포) |
| 파서 | `@rhwp/core` (Node worker) | rhwp WASM (skill scripts) |
| 진입점 | LLM tool call (`read_hwp` 등) | SKILL.md 트리거 ("hwp", "한글 문서" 등) |
| 의존 방향 | claw-hwp 참조 **0건** (grep) | MyAgent 참조 **0건** |
| 디플로이 | MyAgent backend에 같이 떠 있음 | `git-subdir` 마켓플레이스에서 설치 |

→ **현재로선 두 구현이 평행선**. 공유점은 "rhwp WASM을 쓴다"는 결정 한 줄뿐. 

## 7. 향후 결정 필요 (이 문서에선 결론 X, 옵션만)

- 두 구현을 합칠지 (`MyAgent`가 claw-hwp 스킬을 의존), 분리 유지할지
- claw-hwp가 `convert_md_to_hwp`의 cite-rendering 3-mode 같은 기능 정합성을 추격해야 하는지
- 식약처 전용 레거시 `read_hwpx` / `edit_hwpx`(python-hwpx) 의 잔존 이유 확인 — 신 rhwp 스택으로 마이그레이션 가능한지

---

**조사 출처 정리** (재확인용):
- `MyAgent/CLAUDE.md:59-61`
- `MyAgent/README.md:123`
- `MyAgent/myagent/agent/tools/hwp.py:1-121`
- `MyAgent/myagent/agent/tools/hwp_pro.py:1-150+`
- `MyAgent/myagent/skills/document-formatting/SKILL.md:91-150`
- `MyAgent-backend/main.py:780-796, 1685, 1716-1756`
- `MyAgent-frontend/app/{types,constants,lib/formatters}.ts`
- `MyAgent-frontend/app/hooks/useSourcesPanel.ts`
- `MyAgent-frontend/CLAUDE.md`

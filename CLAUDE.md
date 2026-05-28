# claw-hwp 작업 원칙

## 무조건 Hop 동작을 먼저 확인하고 그대로 구현한다

HWP/HWPX 의 한컴독스 호환성 / 동작 spec 은 우리가 자의적으로 추측하지 않는다. **모든 새 기능의 첫 step:**

1. **Hop 앱** (`HOP.app`, `net.golbin.hop`, `golbin/hop` GitHub repo) 에서 같은 작업을 직접 수행 — 새 문서 만들기 / 기존 파일 열기 → 변경 → 저장 / 이미지 추가 / 표 삽입 / 페이지 설정 등.
2. **결과 `.hwp` 파일 한컴독스 업로드** 해서 열림/안열림 확인.
3. **그 결과를 그대로 우리 툴에서 재현** — Hop 의 source code 가 다 오픈 (`golbin/hop`, `edwardkim/rhwp`) 이라 어떤 path 거치는지 직접 확인 가능.

이 단계를 건너뛰면 우리는 잘못된 가설 위에 인프라를 쌓는다 (실제 사례: Phase 6 image 작업 6+시간 + 검증 5회 사이클이, "rhwp emit = 한컴독스 X" 라는 잘못된 가설 위에 만든 raw-patch 시도였음. 사실은 `stripParaLineSegRecords` 의 sheetjs `CFB.write` 만이 reject 원인이었고 rhwp `exportHwp()` 자체는 정상).

## Hop 의 핵심 save flow (참고)

- `apps/studio-host/src/core/tauri-bridge.ts:writeCurrentHwpToPath()` →
  ```typescript
  await writeFileInChunks(path, super.exportHwp());
  ```
- 즉 **`doc.exportHwp()` 결과를 그대로 file 에 write**. 별도 post-process / strip 없음.
- 우리 plugin 도 같은 path. 추가 post-process 가 있으면 그게 한컴독스 reject 원인.

## 알려진 사실 (Hop 직접 검증)

- **rhwp `exportHwp()` from-scratch** (createBlankDocument → append → exportHwp):
  - Hop 에서 새 문서 생성 + 저장 → 한컴독스 ✓
  - 우리 plugin baseline (`baseline_no_strip_skip_cfbwrite.hwp`) → 한컴독스 ✓
- **rhwp `exportHwp()` round-trip** (load existing big form → modify → exportHwp):
  - **큰 폼 (ktx, 50+ pages)**:
    - Hop 에서 cell 수정 + 저장 → 한컴독스 ✗ (2026-05-22 검증)
    - Hop 에서 image 추가 + 저장 → 한컴독스 ✗ (2026-05-22 검증)
    - 우리 plugin rhwp emit (`ktx_inplace_image_v11_rhwp_emit.hwp`) → 한컴독스 ✗ (동일)
  - **작은 폼 (fresh_image_100px, mini-stream Section0)**:
    - Hop 에서 image 추가 + 저장 → 한컴독스 ✅ (2026-05-22 검증, fresh_image_100px_v3.hwp)
    - 우리 plugin rhwp emit (`small_inplace_image_v7_rhwp_emit.hwp`) → 한컴독스 ✅
  - **h22 (14KB, 7 paragraphs, mini-stream Section0)**:
    - 우리 plugin rhwp emit (`h22_cold6_real_png.hwp`, 2026-05-28 검증): real PNG 100×100 추가 → 한컴독스 ✅ (이미지 정상 렌더링). 이전 단계는 dummy 65-byte PNG 였고 그건 broken-image icon — PNG 자체가 invalid 였던 게 원인. **rhwp round-trip 자체는 h22 OK.**
  - 즉 rhwp round-trip 의 한컴독스 호환은 **폼 크기/구조에 따라 다름**. 큰 폼 reject 는 우리/Hop 공통 한계. 작은 폼 (h22, fresh_image_100px) 은 OK.
- **이게 우리 raw-patch (cell-patch.js — 기존 bytes 통째 유지 + 변경 부분만 byte-level patch) 가 in-place edit 의 유일한 한컴독스 호환 path 인 이유.** Hop 도 못 푸는 문제를 우리가 회피해서 풀어둔 것.
- **sheetjs `CFB.write` (vendor/cfb/cfb.js)**: directory entry [Sh33tJ5] 빈 stream 박음 → 한컴독스 ✗. **써서는 안 됨.** in-place edit 은 우리 raw-patch 인프라 사용.

## 진행 중 / 결정 사항

- `stripParaLineSegRecords` 의 sheetjs CFB.write — **제거 완료** (Hop 도 strip 안 함). PARA_LINESEG placeholder 가 우리 local renderer 에서 layout 약간 잘못 표시하지만 그건 별도 issue (Hop 도 같은 상태).
- Phase 1-5 raw-patch — **유지** (검증된 한컴독스 호환 유일 path).
- Phase 6 image in-place add — 우리 raw-patch 시도 누적 fail.
  - v1: orphan BinData (Step 1 only) → reject (orphan 자체가 reject)
  - v2/v3: PARA_TEXT drop/keep variations → reject
  - v4: fresh-template generator + paraShape/charShape rewrite → 열림은 OK 다만 image 안 보임
  - v5: ktx 자체 image cluster clone → reject (ktx 의 image 가 page header + table nested 안 → 본문 위치 에 통째 inject 불가)
  - 진짜 한계 = **DocInfo cross-reference 깊이**. 우리 cluster 의 paraShape/charShape/BorderFill/etc 가 사용자 DocInfo 의 ID 와 매핑 안 됨. ktx 의 모든 image-containing paragraph 가 nested (page header/footer/table) — simple image-only cluster 없음.
  - Hop 도 in-place image round-trip ✗ (검증 완료). raw-patch 가 유일한 길이지만 우리 sweet spot 벗어남.
  - **다음 step (새 session 에서):** B 또는 C path 시도
    - B: fresh template generator + DocInfo records (paraShape/charShape/BorderFill 새 entries 추가) inject — 작업 매우 큼 (~500줄)
    - C: ktx 의 image cluster 의 lvl 3 nested image 부분 추출 + lvl 변환 + 새 simple paragraph 합성 — 작업 큼 (~300줄)
  - 현 상태에서 SKILL.md 에 "v1 미지원, workaround = from-scratch path" 명시 + 모든 시도 commit.
- worktree 분리 — `~/claw-hwp-raw-patch` (hwp 트랙) + `~/claw-hwp-hwpx-edit` (hwpx 트랙, 다른 세션). 메인 폴더는 main checkout.

## 작업 원칙 재확인

이전에 두 차례 잘못된 결론에 빠졌음:
1. "rhwp emit = 한컴독스 X" → 사실은 sheetjs CFB.write 만 X
2. "rhwp round-trip = 한컴독스 OK (Hop 검증)" → 사실은 from-scratch 만 OK, round-trip 은 Hop 도 X

두 번째 잘못의 원인: Hop 검증 시 사용자가 "잘 열린다" 한 file 이 from-scratch 였는데 우리가 round-trip 결과로 단정. **검증 결과를 받으면 "정확히 어떤 시나리오"인지 확인하고 추측 금지.**

## 일반화 금지 (보고 / 문서 / 결론 작성 시)

**원칙**: 사실을 적을 때 **일반화하지 말고 구체적 케이스 그대로 적기.** "전부 / 모두 / 항상 / 절대 안 됨" 같은 표현은 한 케이스만 본 결과를 다른 케이스로 확장하는 거. 본 만큼만 적어.

이 원칙을 어겨서 같은 세션 내에 세 차례 헛고생함:

1. **Sh33tJ5 grep methodology 오류** — ASCII grep `'Sh33tJ5'` 로 raw-patch 출력 12개 다 "no Sh33tJ5" 라 보고. 사실은 h22 원본 자체가 UTF-16 `S\0h\03\03\0t\0J\05\0` 로 Sh33tJ5 박혀있음. "Sh33tJ5 = 한컴독스 reject" 라는 일반화도 wrong — h22 자체가 한컴독스 열림.
2. **Session 2 실패 misdiagnosis** — cold-start session 2 가 v1.4.8 cache (appendParagraphInPlace 없음) 에서 rhwp emit fallback 으로 corrupted 된 건데, 같은 시간에 직접 dispatch test 가 dev tree 의 "PARA_HEADER body too short (22 need >= 24)" throw 했음. 두 다른 실패를 같은 원인으로 묶어서 "22-byte fix = session 2 해결책" 으로 단정. 사실은 cache 버전 차이가 진짜 원인이었고 22-byte fix 는 다른 (실재하는) dev tree 버그를 fix.
3. **"raw-patch 모든 op audit 통과" 일반화** — 코드 grep 으로 "24-byte 가정 다른 곳에 없음" 확인하고 "fix 가 다른 op 들 안 깨뜨림" 단정. 실측 실행해보니 4개 op 에서 사전 버그 표면화 (bullet/numbered list dispatch items[] 무시, append_table clone artifact, replace_text level-1 only, apply_paragraph_style 46-byte ParaShape).

**구체적으로 적기 예시**:
- ✗ "raw-patch 출력 다 Sh33tJ5 없음, Hancom Docs 호환"
- ✓ "raw-patch 출력 12개 중 grep `'Sh33tJ5'` (ASCII) 매치 없음. 단 이 grep 은 UTF-16 인코딩 못 잡음 — UTF-16 LE 매치 다시 확인 필요. h22 원본 자체 포함 여부 미확인."

- ✗ "이 fix 가 다른 op 들 안 깨뜨림"
- ✓ "코드 정적 audit 으로 24-byte 강제 가정 다른 함수 (apply_paragraph_style line 3918 `< 10`, pickFreshInstanceId line 1949 `< 22` 등) 에 없음 확인. 실측 검증은 op 별 실행 후 별도 필요."

**검증 결과 받으면**: 정확히 어떤 시나리오 / 어떤 코드 path / 어떤 버전 / 어떤 입력 — 자세히 적어. 추론으로 다른 케이스에 확장 금지.

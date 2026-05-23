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

## 알려진 사실

- **rhwp `exportHwp()` from-scratch** (createBlankDocument → append → exportHwp): 한컴독스 OK.
- **rhwp `exportHwp()` round-trip** (load existing big form → modify → export): 한컴독스 X (큰 폼에서 record 손상). 이게 raw-patch (cell-patch.js, bytes 통째 유지 + byte-level patch) 가 in-place edit 의 유일한 한컴독스 호환 path 인 이유.
- **sheetjs `CFB.write` (vendor/cfb/cfb.js)**: directory entry [Sh33tJ5] 빈 stream 박음 → 한컴독스 X. **써서는 안 됨.** in-place edit 은 우리 raw-patch 인프라 사용.

## 진행 중 / 결정 사항

- `stripParaLineSegRecords` 의 sheetjs CFB.write — **제거** (Hop 은 strip 안 함). PARA_LINESEG placeholder 가 우리 local renderer 에서 layout 약간 잘못 표시하지만 그건 별도 issue (Hop 도 같은 상태).
- Phase 6 image in-place add — 우리 raw-patch 시도 mini-stream truncation 등 한계. Hop 이 어떻게 처리하는지 (큰 폼에 이미지 추가) 직접 확인 후 결정. 그 전에는 SKILL.md 에 "v1 미지원" 명시.
- worktree 분리 — `~/claw-hwp-raw-patch` (hwp 트랙) + `~/claw-hwp-hwpx-edit` (hwpx 트랙, 다른 세션). 메인 폴더는 main checkout.

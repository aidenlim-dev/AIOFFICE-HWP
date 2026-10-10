# 변경 내역

## 1.4.1 - 2026-10-10

- 내장 ZIP 라이브러리 fflate를 0.8.3으로 갱신해 손상된 ZIP64 파일을 읽을 때 무한 반복하는 CVE-2026-45820을 수정했다. 문서 생성, 본문 추출, HWPX 편집, 글꼴 검사에 쓰이는 실제 vendor 파일과 잠금 파일을 함께 갱신했다.
- 동일한 손상 파일이 구버전에서 시간 초과를 일으키고 새 버전에서 오류로 종료됨을 확인했다. 실제 `extract_text.js` 진입점의 회귀 검증을 Linux, Windows, macOS CI에 추가했다.
- Claude Code와 Codex 플러그인 버전을 1.4.1로 맞췄다. 원본 저장소의 신규 19건은 방문 통계 갱신뿐이라 반영하지 않았다.

보안 근거: [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98).

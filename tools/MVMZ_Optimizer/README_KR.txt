MVMZ Optimizer v0.1
===================

[상태 - 2026-09-28]
이 raw RGBA `.mvmz_opt` 방식은 V050 실기 시험에서 체감 개선이 거의 없고
native memory 사용량을 크게 늘리는 회귀가 확인되어 FAILED / SHELVED 상태입니다.
NX-MVMZPLAYER V051 이상에서는 `.mvmz_opt` raw cache를 의도적으로 무시합니다.
이 도구와 포맷은 실험 재현/분석용으로만 보존하며 일반 사용을 권장하지 않습니다.

목적
----
RPG Maker MV/MZ 게임에서 첫 사용 시 버벅임이 큰 Pictures / Faces / 전투 애니메이션 이미지를
PC에서 미리 RGBA로 변환해 NX-MVMZPLAYER가 PNG decode를 건너뛸 수 있게 합니다.

사용법
------
1. MVMZ_Optimizer.exe 실행
2. RPG Maker MV/MZ 게임 폴더 선택 (root / www / game 모두 가능)
3. 캐시 최대 용량 선택 (기본 512 MiB 권장)
4. [최적화 캐시 생성]
5. 게임 루트에 생성된 .mvmz_opt 폴더를 게임과 함께 Switch SD에 복사

중요
----
- 게임 원본 파일은 수정하지 않습니다.
- 캐시에 없는 자산은 NX-MVMZPLAYER가 기존 원본 방식으로 자동 fallback합니다.
- .mvmz_warm / .mvmz_cache와 다른 새 포맷입니다.
- 현재 v0.1의 실제 가속 대상은 Pictures / Faces / MV Animation 이미지입니다.
- MZ Effekseer effect / SE와 대사 glyph는 manifest에 분석 정보로 저장되며 후속 가속용입니다.
- 전체 게임 raw cache를 만들지 않고, 분석 점수 + 큰 자산 우선으로 지정한 용량 안에서만 생성합니다.

생성 파일
---------
<게임루트>/.mvmz_opt/manifest.json
<게임루트>/.mvmz_opt/glyphs.txt
<게임루트>/.mvmz_opt/report.txt
<게임루트>/.mvmz_opt/rgba/.../*.mrgba


# Changelog / 변경 사항

## Unreleased

### English

- MV 0.47.0: disables the remaining manual `.mvmz_warm` map-start gate entirely. Existing warm manifests are no longer used to preload pictures/faces or block Scene_Map; MV now returns to natural on-demand image loading to address GAME1 slowdown and illustration-loading crashes.
- MV/MZ 0.47.0: adds an on-screen startup progress UI with the current phase, percentage bar, game name and engine. Script loading progress uses actual loaded-script counts; failure state is shown on screen instead of a silent black wait.
- Future MV/MZ warm compilers now report real `map n/total` percentages to the same progress UI when those compiler paths are explicitly enabled again. Current V047 does not activate the warm compilers.

- Launcher 0.6.0: prevents nx.js' built-in Plus-only exit behavior through the cancelable `beforeunload` path. Plus/Start alone is reserved and no longer intended to exit MVMZPLAYER; the custom Start+Select confirmation remains the only exit gesture.
- MV 0.46.0: removes the V044 first-run automatic warm-manifest compiler and runtime self-learning layer, restoring the V043-compatible MV warm path after device testing showed startup/map-transition regressions and compatibility loss in some previously working MV titles.
- MZ 0.46.0: removes the V044 synchronous all-map manifest compiler and blocking Scene_Map manifest gate, restoring the V041 nonblocking event/battle prewarm path while retaining the established save, SE-cache and damage-bitmap stability work.
- Split runtime startup now writes additional flushed checkpoints around image bridge, location setup, script-loader creation and engine boot entry/return so very-early startup failures can be isolated from the next device log.
- Launcher game-name mapping, thumbnail view, 5x2 grid and Start+Select Yes/No UI from 0.5.0 are retained.

### 한국어

- MV 0.47.0: 남아 있던 수동 `.mvmz_warm` 맵 시작 gate도 완전히 비활성화했습니다. 기존 manifest를 읽어 picture/face를 미리 몰아서 로드하거나 Scene_Map을 막지 않으며, GAME1의 느려짐과 일러스트 로딩 중 튕김을 줄이기 위해 자연 on-demand 이미지 로딩으로 복귀했습니다.
- MV/MZ 0.47.0: 게임 시작 시 현재 단계, 퍼센트 게이지, 게임명, 엔진을 화면에 표시하는 진행 UI를 추가했습니다. 스크립트 로딩은 실제 로드 개수 기준으로 진행률을 표시하고, 시작 실패 시에도 블랙 화면 대신 실패 상태를 보여줍니다.
- 향후 MV/MZ warm compiler를 명시적으로 다시 켤 경우 실제 `map n/total` 퍼센트를 같은 진행 UI에 전달하도록 준비했습니다. 현재 V047에서는 warm compiler 자체를 활성화하지 않습니다.

- Launcher 0.6.0: nx.js 자체의 기본 동작인 `Plus(Start) 단독 = 종료`를 cancel 가능한 `beforeunload` 경로에서 차단했습니다. 이제 Start 단독은 MVMZPLAYER 종료 용도로 사용하지 않으며, 종료는 기존의 Start+Select 확인 팝업만 담당합니다.
- MV 0.46.0: 실기에서 시작/맵 전환 지연과 기존 정상 게임 일부의 호환성 회귀가 확인되어 V044에서 추가한 첫 실행 자동 warm-manifest 컴파일러와 runtime self-learning을 제거하고 V043 호환 MV warm 경로로 복귀했습니다.
- MZ 0.46.0: V044의 부팅 중 전체 맵 동기 manifest 컴파일과 Scene_Map blocking gate를 제거하고 V041의 비차단 이벤트/전투 프리웜 경로로 복귀했습니다. 기존 저장 안정화, SE 캐시, 데미지 비트맵 캐시는 유지합니다.
- 아주 이른 부팅 실패를 다음 실기 로그에서 정확히 좁힐 수 있도록 image bridge, location, script loader, engine boot 진입/복귀 지점에 즉시 flush되는 체크포인트 로그를 추가했습니다.
- Launcher 0.5.0의 게임명 매핑, 썸네일, 5x2 그리드, Start+Select 예/아니오 UI는 그대로 유지합니다.

## Public Beta 0.1

### English

- First public beta release of **NX-MVMZPLAYER**.
- Includes the launcher with separate RPG Maker **MV** and **MZ** player runtimes.
- Automatically detects common RPG Maker game-folder layouts.
- Keeps save data and runtime logs separated for each game.
- Generates and reuses per-game startup preparation data automatically.
- Refreshes preparation data automatically when game data changes.
- The current public runtime is based on the **V044 development baseline**.

### 한국어

- **NX-MVMZPLAYER**의 첫 번째 공개 베타 버전입니다.
- 런처와 RPG Maker **MV / MZ 전용 플레이어 런타임**을 포함합니다.
- 일반적인 RPG Maker 게임 폴더 구조를 자동으로 감지합니다.
- 세이브 데이터와 실행 로그를 게임별로 분리하여 관리합니다.
- 게임별 실행 준비 데이터를 자동으로 생성하고 이후 실행에서 재사용합니다.
- 게임 데이터가 변경되면 필요한 준비 데이터를 자동으로 다시 갱신합니다.
- 현재 공개 런타임은 **V044 개발 기준**을 기반으로 합니다.

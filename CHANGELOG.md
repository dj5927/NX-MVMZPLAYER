# Changelog / 변경 사항

## Unreleased

- V057 starts the external compatibility-pack architecture. The common runtime now scans the selected game, matches external `_compat` rules, supports phased compatibility scripts, and logs richer native allocator/V8 memory telemetry.
- The first game-specific rule targets garun_windows only (MZ + expected plugin set): light transition reclaim begins at 1024 MiB for Battle->Map and Map->Map without ImageManager eviction; the existing 1280 MiB full scene-safe LRU reclaim remains intact.
- Unmatched games keep the V052 memory policy. Battle-BGM lifecycle work remains separate.

- V056 isolated candidate: V055 ResourceFS resolved-path caching is rejected after garun_windows booted but terminated without JS FATAL on a dungeon Scene_Map -> Scene_Map transfer. V056 restores ResourceFS exactly to V052 and changes only GL diagnostic trace budgeting.
- V056 GL tracing now consumes its budget on every traced GL call, not only calls that report an error, so error-free traces stop after the configured call budget instead of paying indefinite gl.getError() overhead.

- V055 isolated candidate: V052 is re-established as the locked stable baseline after V053/V054 device rejection. V055 reintroduces only successful ResourceFS path-resolution caching while preserving synchronous Switch.readFileSync I/O and all V052 bootstrap/image semantics.
- V055 intentionally excludes the V053 async local XHR/fetch/Image path, MZ lazy Canvas/TextureGC changes, and cache-eviction rewrite. Future optimizations remain one functional change per device-tested build.

### English

- V054 rollback recovery: V053 was rejected by device testing because MZ no longer booted and MV crashed near startup. All V053 runtime changes were reverted byte-for-byte to the V052 source baseline; only the MV/MZ version identifiers were advanced to 0.54.0 for log/build identification.
- The reverted V053 experiment included the combined async local file/fetch/Image path work and MZ texture-lifetime/diagnostic changes. Future optimization work will be reintroduced one isolated change per build instead of as a combined set.

- V053 Switch optimization pass: local game assets now use bounded asynchronous SD reads instead of microtask-wrapped synchronous reads. ResourceFS caches resolved paths, Image.src resolves directly to local sdmc paths, and MV regular/encrypted image reads use the async path under the existing decode gate.
- MZ 0.53.0 restores lazy Image/Canvas behavior while preserving BaseTexture identity when Canvas is materialized, restores Pixi texture-GC aging under the logical RenderTexture presenter, and changes high-water optional-cache eviction from destructive Bitmap destroy to GPU dispose + reload-safe cache removal.
- Runtime overhead and safety: GL trace now has a real call budget, periodic framebuffer readPixels diagnostics are opt-in, pointer overlays recreate after scene destruction, live damage-number bitmaps are protected from LRU destruction, MV temporary ImageBitmap cleanup is finally-safe, and logger SD metadata/backpressure is bounded.

- V052 transition high-water stabilization: after V051 device testing showed native memory staying around 1.35-1.45 GiB and the process terminating on a later Scene_Map -> Scene_Map transition without a JS fatal, MZ now performs a one-shot reclaim only for heavy Map/Battle scene replacements when native usage is at least 1280 MiB.
- Under that high-water condition, MZ destroys the finished previous scene before creating the replacement scene, skips the unnecessary stock background snapshot for Map -> Map transfers, and trims only non-system ImageManager cache bitmaps that are not referenced by the current/next scene graph. The cache trim is LRU and keeps 24 MP optional cache normally, 14 MP above 1400 MiB, and 8 MP above 1500 MiB.
- MZ heartbeat now reports the real MZ ImageManager cache count/pixels instead of the MV-only cache path. Warm/compiler/raw .mvmz_opt remain disabled.

- V051 baseline recovery: disables the V050 raw RGBA `.mvmz_opt` runtime path after device testing showed negligible hitch improvement and substantially higher native-memory pressure. Existing `.mvmz_opt` folders are ignored; normal on-demand game asset loading is restored.
- MZ 0.51.0 adds non-preloading Effekseer first-use timing diagnostics (`START / READY / CACHE HIT`) with memory snapshots so effect loading can be measured without reintroducing proactive warm gates.
- The V050 optimizer source/format is retained only for reproducibility and is now marked FAILED / SHELVED; Public Beta Release remains unchanged.

- V050 experimental optimizer path: adds PC-side MVMZ Optimizer v0.1 and a new `.mvmz_opt` format, separate from the failed/shelved `.mvmz_warm` and legacy `.mvmz_cache` experiments.
- The optimizer auto-detects MV/MZ, analyzes event Show Picture / Show Text Face / animation references, plugin-command and plugin literal strings, Skill/Item animation IDs, MZ effect names, SE references and dialogue/database glyphs.
- The optimizer writes only selected hot `pictures / faces / animations` as validated MVMZRGBA v1 files under a user-selected raw-cache budget (default 512 MiB). Missing cache entries always fall back to the original game asset path.
- MV/MZ 0.50.0 validate the `.mvmz_opt/manifest.json` engine + System.json fingerprint before using any optimized file. MV checks the new cache before the legacy raw cache/source decoder; MZ hooks Bitmap._startLoading so a cache HIT bypasses native Image/PNG decode entirely.
- Optimizer GUI is packaged locally as a one-file Windows EXE. The public repository contains reproducible Python/PowerShell source but no binary Release asset yet.
- V049: adds a fixed MV/MZ boot loading bar that is drawn once before game scripts and presented with only a single initial frame handoff. It does not insert per-script progress yields or fake percentages, so engine initialization order/timing remains unchanged after that one frame.
- MV 0.49.0: adds pressure-aware picture cache/native-resource reclamation. When native heap exceeds 900 MiB, old `img/pictures` cache entries are trimmed toward a 10 MP picture budget (6 MP above 1050 MiB). A retired bitmap is only destroyed after a grace period and only when it is no longer in ImageCache and no current/next/previous scene graph node references its Bitmap/BaseTexture.
- MV 0.49.0: retired picture cleanup explicitly destroys BaseTexture and releases Canvas/Image/native references instead of relying on repeated global V8/texture GC. Current on-screen pictures, reservations and in-flight decodes are protected.
- Warm/compiler status remains unchanged: MV/MZ active warm compilers and proactive warm gates stay disabled. The previous on-device warm-manifest approach is considered shelved after device testing showed startup/map latency and compatibility regressions.
- V048 baseline recovery: removes V047's general startup progress renderer and script-load RAF yields from the active player path, restoring synchronous engine bootstrap timing. Progress callbacks remain only as dormant compiler plumbing for a future explicitly enabled compiler.
- MV 0.48.0: keeps all warm manifest/map gates disabled, changes exact software PNG decoding from every semi-transparent PNG to indexed-color PNGs with semi-transparent tRNS entries only, preserving the proven Ghosthospital corruption fix while returning large GAME1 illustrations to the native decoder.
- MV 0.48.0: releases the retained-scene presentation hold as soon as the new scene starts instead of waiting up to four seconds for global image readiness, and keeps the improved pressure policy that performs one hard-pressure GC episode while retaining the normal image-cache limit, with sparse emergency cleanup only at much higher growth.
- MZ 0.48.0: disables both proactive event/map asset warm and battle effect/SE warm paths. MZ returns to on-demand loading while retaining save stability, decoded SE cache, font compatibility, damage bitmap cache and renderer fixes.
- Pointer bridge: creates the offscreen PIXI cursor overlay before first pointer activity and moves right-stick/ZL/ZR gamepad polling to an independent 16 ms timer, leaving RAF responsible only for cursor overlay placement. This avoids first-frame render wake dependence and decouples MZ mouse input from engine/PIXI RAF scheduling.
- MV 0.47.0: disables the remaining manual `.mvmz_warm` map-start gate entirely. Existing warm manifests are no longer used to preload pictures/faces or block Scene_Map; MV now returns to natural on-demand image loading to address GAME1 slowdown and illustration-loading crashes.
- MV/MZ 0.47.0: adds an on-screen startup progress UI with the current phase, percentage bar, game name and engine. Script loading progress uses actual loaded-script counts; failure state is shown on screen instead of a silent black wait.
- Future MV/MZ warm compilers now report real `map n/total` percentages to the same progress UI when those compiler paths are explicitly enabled again. Current V047 does not activate the warm compilers.

- Launcher 0.6.0: prevents nx.js' built-in Plus-only exit behavior through the cancelable `beforeunload` path. Plus/Start alone is reserved and no longer intended to exit MVMZPLAYER; the custom Start+Select confirmation remains the only exit gesture.
- MV 0.46.0: removes the V044 first-run automatic warm-manifest compiler and runtime self-learning layer, restoring the V043-compatible MV warm path after device testing showed startup/map-transition regressions and compatibility loss in some previously working MV titles.
- MZ 0.46.0: removes the V044 synchronous all-map manifest compiler and blocking Scene_Map manifest gate, restoring the V041 nonblocking event/battle prewarm path while retaining the established save, SE-cache and damage-bitmap stability work.
- Split runtime startup now writes additional flushed checkpoints around image bridge, location setup, script-loader creation and engine boot entry/return so very-early startup failures can be isolated from the next device log.
- Launcher game-name mapping, thumbnail view, 5x2 grid and Start+Select Yes/No UI from 0.5.0 are retained.

### 한국어

- V054 롤백 복구: V053은 실기에서 MZ가 실행되지 않고 MV가 시작 직후 튕겨 폐기했습니다. V053에서 변경한 runtime 파일을 V052 소스 기준으로 바이트 단위 복구했고, 로그/빌드 식별을 위해 MV/MZ 버전만 0.54.0으로 올렸습니다.
- V053에서 함께 넣었던 async local file/fetch/Image 경로와 MZ texture lifetime/진단 변경은 모두 되돌렸습니다. 이후 최적화는 여러 기능을 한 번에 넣지 않고 빌드별로 한 가지씩만 분리 적용합니다.

- V053 Switch 최적화: 로컬 게임 자산을 microtask 안의 동기 read가 아니라 제한된 비동기 SD read로 읽습니다. ResourceFS 경로 캐시, Image.src의 direct sdmc 경로, MV 일반/암호화 이미지 async read를 적용했습니다.
- MZ 0.53.0은 Image/Canvas lazy 동작을 복구하면서 Canvas가 실제 필요해질 때 기존 BaseTexture 정체성을 유지합니다. logical RenderTexture presenter 때문에 멈춰 있던 Pixi texture-GC aging도 외부 프레임 기준으로 복구하고, high-water optional cache 정리는 Bitmap 파괴 대신 GPU dispose + reload-safe cache 제거 방식으로 바꿨습니다.
- 상시 오버헤드/안전성: GL trace 호출 예산 제한, framebuffer readPixels 기본 비활성, Scene 파괴 후 pointer overlay 재생성, 사용 중 damage bitmap 보호, MV ImageBitmap finally 정리, logger SD metadata/실패 버퍼 제한을 추가했습니다.

- V052 전환 high-water 안정화: V051 실기에서 native memory가 약 1.35~1.45GiB에 장시간 머물고 이후 Scene_Map -> Scene_Map 전환 시작 직후 JS FATAL 없이 종료된 것을 확인해, MZ는 native 사용량이 1280MiB 이상일 때 Map/Battle 대형 Scene 교체에 한해 1회 메모리 회수를 수행합니다.
- high-water 전환에서는 종료된 이전 Scene을 새 Scene 생성 전에 조기 파괴하고, Map -> Map 전환에서 불필요한 stock background snapshot을 생략합니다. 또한 시스템 이미지는 건드리지 않고 현재/다음 Scene graph에서 참조되지 않는 ImageManager cache Bitmap만 LRU로 정리합니다. optional cache 예산은 기본 24MP, 1400MiB 이상 14MP, 1500MiB 이상 8MP입니다.
- MZ heartbeat가 이제 MV 전용 cache=0 대신 실제 MZ ImageManager cache 개수/픽셀을 표시합니다. warm/compiler/raw .mvmz_opt는 계속 비활성입니다.

- V051 기준선 복구: V050 raw RGBA `.mvmz_opt`가 실기에서 체감 개선이 거의 없고 native memory 압박을 크게 높인 것이 확인되어 runtime 사용을 비활성화했습니다. SD에 기존 `.mvmz_opt`가 남아 있어도 무시하고 원래의 on-demand 자산 로딩으로 복귀합니다.
- MZ 0.51.0은 preload 없이 Effekseer 첫 사용 시간을 `START / READY / CACHE HIT`와 메모리 snapshot으로 기록해 proactive warm을 다시 켜지 않고 실제 effect 병목을 측정합니다.
- V050 Optimizer 소스/포맷은 재현용으로만 보존하며 FAILED / SHELVED 상태로 표시합니다. Public Beta Release는 변경하지 않습니다.

- V050 실험 Optimizer 경로: 실패/보류한 `.mvmz_warm`, 기존 `.mvmz_cache`와 완전히 분리된 새 `.mvmz_opt` 포맷과 PC용 MVMZ Optimizer v0.1을 추가했습니다.
- Optimizer는 MV/MZ 자동 판별, 이벤트 Show Picture / Show Text Face / 애니메이션 참조, 플러그인 명령·literal 문자열, Skill/Item animationId, MZ effectName, SE 참조, 대사/DB glyph를 분석합니다.
- 실제 raw cache는 기본 512MiB 예산 안에서 hot `pictures / faces / animations`만 MVMZRGBA v1로 생성합니다. 캐시에 없는 자산은 항상 게임 원본 로딩으로 fallback합니다.
- MV/MZ 0.50.0은 `.mvmz_opt/manifest.json`의 엔진과 System.json fingerprint를 먼저 검증합니다. MV는 기존 raw cache/원본 decode보다 새 cache를 우선하고, MZ는 Bitmap._startLoading 앞에서 HIT를 처리해 native Image/PNG decode 자체를 건너뜁니다.
- Optimizer GUI는 로컬에서 단일 Windows EXE로 패키징했습니다. 공개 저장소에는 재현 가능한 Python/PowerShell 소스만 올리고 Release 바이너리는 아직 배포하지 않습니다.
- V049: MV/MZ 공통 고정 부팅 로딩바를 추가했습니다. 게임 스크립트 실행 전에 한 번만 그린 뒤 최초 프레임 1회만 표시하고, 스크립트마다 RAF/yield를 끼우거나 가짜 퍼센트를 올리지 않습니다. 이후 엔진 초기화 순서/타이밍에는 개입하지 않습니다.
- MV 0.49.0: native heap 압박 시 그림 전용 cache/native 자원 회수를 추가했습니다. 900MiB 이상에서 오래된 `img/pictures` 캐시를 10MP 그림 예산으로 줄이고, 1050MiB 이상에서는 6MP까지 줄입니다. 캐시에서 빠진 Bitmap은 grace period 뒤에도 ImageCache에 없고 현재/다음/이전 scene graph에서 Bitmap/BaseTexture 참조가 없을 때만 실제 native 자원을 해제합니다.
- MV 0.49.0: 오래된 그림은 반복적인 전역 V8/texture GC에 의존하지 않고 BaseTexture destroy와 Canvas/Image/native 참조 해제를 직접 수행합니다. 현재 화면에 보이는 그림, reservation, decode 진행 중 자산은 보호합니다.
- warm/compiler 상태는 그대로입니다. MV/MZ active warm compiler와 proactive warm gate는 계속 비활성화합니다. 기존 on-device warm-manifest 방식은 실기에서 시작/맵 지연과 호환성 회귀가 확인되어 일단 보류합니다.
- V048 기준선 복구: V047에서 추가했던 일반 부팅 진행 렌더러와 스크립트 로딩 중 RAF yield를 active player 경로에서 제거해 엔진 부팅 타이밍을 다시 동기 방식으로 복구했습니다. 진행률 callback은 향후 compiler를 명시적으로 다시 켤 때 사용할 비활성 연결부만 남깁니다.
- MV 0.48.0: 모든 warm manifest/map gate 비활성 상태를 유지합니다. exact software PNG decode는 모든 반투명 PNG가 아니라 semi-transparent tRNS를 가진 indexed-color PNG에만 적용해 Ghosthospital에서 검증된 색상 복구는 유지하면서 GAME1의 대형 일러스트는 native decoder로 되돌렸습니다.
- MV 0.48.0: retained scene hold를 전역 이미지 준비 완료까지 최대 4초 기다리지 않고 새 scene start 시점에 해제합니다. 메모리 압박도 정상 ImageCache 용량을 유지한 채 hard-pressure 진입 시 1회 정리하고, 훨씬 높은 메모리 증가에서만 드문 emergency 정리를 수행하는 정책을 유지합니다.
- MZ 0.48.0: 이벤트/맵 proactive asset warm과 전투 effect/SE warm을 모두 active 경로에서 제거했습니다. 저장 안정화, decoded SE cache, 폰트 호환, damage bitmap cache, 렌더 수정은 유지하면서 이미지/효과는 on-demand 로딩으로 복귀합니다.
- 포인터: 첫 입력 전부터 PIXI 커서 오버레이를 화면 밖에 생성하고, 우측 스틱/ZL/ZR gamepad polling을 독립 16ms timer로 분리했습니다. RAF는 커서 위치 갱신만 담당하므로 첫 화면이 포인터 생성에 의존하는 문제와 MZ의 RAF 상태에 따라 우스틱 마우스가 끊기는 문제를 분리합니다.
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

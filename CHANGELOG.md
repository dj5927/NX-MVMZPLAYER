# Changelog / 변경 사항

## Unreleased

### English

- Launcher 0.5.0: Start+Select now opens an exit confirmation dialog instead of exiting immediately.
- Launcher 0.5.0: first launch creates `/mvmz/gamelist.json`; folder names are used as defaults and can be mapped to custom display names such as Korean titles.
- Launcher 0.5.0: Select toggles between the existing text list and a 5-column x 2-row thumbnail grid.
- Launcher 0.5.0: thumbnails are loaded from `/mvmz/_image/<folder-name>.png` and center-cropped/resized to portrait cards automatically.
- MV/MZ 0.45.0: Start+Select in-game now opens a Yes/No exit-to-launcher overlay, with RPG Maker gamepad input suppressed until confirmation controls are released.

### 한국어

- Launcher 0.5.0: Start+Select를 눌러도 즉시 종료하지 않고 종료 확인 팝업을 표시하도록 변경했습니다.
- Launcher 0.5.0: 최초 실행 시 `/mvmz/gamelist.json`을 자동 생성합니다. 기본 표시명은 폴더명이며 JSON에서 한글 등 원하는 게임명으로 바꿀 수 있습니다.
- Launcher 0.5.0: Select 버튼으로 기존 텍스트 목록과 가로 5개 x 세로 2줄 썸네일 목록을 전환할 수 있습니다.
- Launcher 0.5.0: `/mvmz/_image/<폴더명>.png` 이미지를 읽어 세로형 카드에 맞게 자동 중앙 크롭/리사이즈합니다.
- MV/MZ 0.45.0: 게임 중 Start+Select를 누르면 예/아니오 종료 확인 팝업이 뜨며, 확인 입력이 게임에 같이 전달되지 않도록 버튼을 모두 놓을 때까지 RPG Maker 게임패드 입력을 차단합니다.

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

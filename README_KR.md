# NX-MVMZPLAYER — 공개 베타 0.1

NX-MVMZPLAYER는 RPG Maker MV/MZ 게임 폴더를 감지하고 실행할 수 있도록 만든 플레이어 프로젝트입니다.

현재 버전은 **Public Beta 0.1**입니다. 게임별 플러그인 구성에 따라 호환성 차이가 있을 수 있습니다.

## 사용법

1. Releases에서 `NX-MVMZPLAYER_Public_Beta_0.1.zip`을 받습니다.
2. 압축 안의 `MVMZ_Launcher.nro`와 `runtime` 폴더를 폴더 구조 그대로 NX-MVMZPLAYER 앱 폴더에 복사합니다.
3. 저장장치 루트에 아래처럼 게임 폴더를 준비합니다.

```text
/mvmz/
  게임폴더1/
  게임폴더2/
```

4. 각 게임 폴더에는 본인이 정상적으로 보유한 RPG Maker MV 또는 MZ 게임 데이터를 복사합니다. `root`, `www`, `game`, `data/www` 형태의 일반적인 배포 구조는 자동으로 감지합니다.
5. NX-MVMZPLAYER를 실행한 뒤 목록에서 게임을 선택합니다.
6. 첫 실행에서는 게임별 준비 데이터가 자동 생성되어 시작이 조금 더 오래 걸릴 수 있습니다. 이후 실행에서는 기존 준비 데이터를 재사용하며, 게임 데이터가 바뀌면 자동으로 다시 갱신합니다.
7. 세이브 데이터와 실행 로그는 게임별로 분리해서 관리됩니다.

> 게임 데이터는 배포 파일에 포함되어 있지 않습니다. 반드시 본인이 이용 권한을 가진 게임만 사용하세요.

---

## Thanks / 감사

이 프로젝트는 아래 오픈소스 프로젝트와 개발자들의 작업에 큰 도움을 받았습니다. 진심으로 감사드립니다.

- **nx.js** — https://github.com/TooTallNate/nx.js
- **PixiJS** — https://github.com/pixijs/pixijs
- **pako** — https://github.com/nodeca/pako
- **pngjs** — https://github.com/pngjs/pngjs
- **Noto CJK** — https://github.com/notofonts/noto-cjk
- **esbuild** — https://github.com/evanw/esbuild
- **TypeScript** — https://github.com/microsoft/TypeScript

---

## 후원하기 / Support

<a href="https://litt.ly/sjh5927"><img src="assets/support.png" style="width:100%;max-width:100%;height:auto;display:block;" alt="후원하기"></a>

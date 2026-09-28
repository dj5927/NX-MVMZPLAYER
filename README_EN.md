# NX-MVMZPLAYER — Public Beta 0.1

NX-MVMZPLAYER is a player project designed to detect and run RPG Maker MV/MZ game folders.

The current release is **Public Beta 0.1**. Compatibility may vary depending on each game's plugins and project configuration.

## Usage

1. Download `NX-MVMZPLAYER_Public_Beta_0.1.zip` from Releases.
2. Copy `MVMZ_Launcher.nro` and the `runtime` folder to your NX-MVMZPLAYER application folder without changing the included directory structure.
3. Create game folders at the root of your storage as shown below.

```text
/mvmz/
  GameFolder1/
  GameFolder2/
```

4. Copy RPG Maker MV or MZ game data that you legally own into each game folder. Common layouts such as `root`, `www`, `game`, and `data/www` are detected automatically.
5. Start NX-MVMZPLAYER and select a game from the list.
6. The first launch of a game may take a little longer while per-game preparation data is generated. Later launches reuse it, and it is refreshed automatically when the game data changes.
7. Save data and runtime logs are kept separately for each game.

> Game data is not included with this project. Use only game files that you are legally entitled to use.

---

## Thanks

This project benefited greatly from the work of the following open-source projects and their contributors. Thank you.

- **nx.js** — https://github.com/TooTallNate/nx.js
- **PixiJS** — https://github.com/pixijs/pixijs
- **pako** — https://github.com/nodeca/pako
- **pngjs** — https://github.com/pngjs/pngjs
- **Noto CJK** — https://github.com/notofonts/noto-cjk
- **esbuild** — https://github.com/evanw/esbuild
- **TypeScript** — https://github.com/microsoft/TypeScript

---

## Support / 후원하기

<a href="https://litt.ly/sjh5927"><img src="assets/support.png" style="width:100%;max-width:100%;height:auto;display:block;" alt="Support"></a>

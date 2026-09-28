# NX-MVMZPLAYER Release Policy

This file defines the mandatory release and source-synchronization rules for NX-MVMZPLAYER.

## Source synchronization

- Project source, build scripts, public helper tools, and public documentation must move together with the local working tree and the GitHub `main` branch.
- Normal development updates GitHub `main`, but **must not create or replace a GitHub Release**.
- Private game data, user test data, personal paths, internal logs, and internal handoff material are not published.

## Release authorization

- A GitHub Release is created **only when the project owner explicitly requests a release**.
- Source commits, documentation updates, CI runs, or ordinary version-development work must never publish a Release automatically.
- The release request is represented by changing `release/RELEASE_VERSION.txt` only after explicit owner authorization.

## Version progression

- Public Beta releases advance exactly **0.1 at a time**:
  - 0.1 -> 0.2 -> 0.3 -> 0.4 ...
- Tag format:
  - Public Beta 0.1 -> `v0.1.0-beta`
  - Public Beta 0.2 -> `v0.2.0-beta`
- Skipping a 0.1 step is not allowed.
- Reusing an existing release tag is not allowed.
- The matching `CHANGELOG.md` section must exist before publishing.

## Mandatory release ZIP layout

Every published release ZIP must open directly to the SD-card root layout below:

```text
mvmz/
  HERE_GAME_FOLDER.txt

switch/
  mvmzplayer/
    MVMZ_Launcher.nro
    README_KR.md
    README_EN.md
    LICENSE
    THIRD_PARTY_NOTICES.md
    SHA256SUMS.txt
    runtime/
      MVMZ_MV_Player.nro
      MVMZ_MZ_Player.nro
```

`mvmz/HERE_GAME_FOLDER.txt` must contain a simple ASCII marker telling users to place their RPG Maker MV/MZ game folders there.

## Release quality gate

Before publishing a release:

1. Install dependencies from the committed lockfile.
2. Fetch and verify the required Noto CJK font.
3. Build the Launcher.
4. Typecheck and build both MV and MZ runtimes.
5. Package the exact mandatory SD-card layout.
6. Generate `SHA256SUMS.txt`.
7. Confirm the requested version advances the latest public beta by exactly 0.1.
8. Confirm `CHANGELOG.md` contains the matching Public Beta version.
9. Publish as a GitHub **pre-release** only after all checks pass.

Normal `main` pushes perform build verification only. They do not publish releases.

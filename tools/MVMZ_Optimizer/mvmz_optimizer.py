#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import os
import re
import struct
import sys
import threading
import time
import traceback
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Callable, Iterable

from PIL import Image


APP_NAME = "MVMZ Optimizer"
APP_VERSION = "0.1.0"
OPT_DIR = ".mvmz_opt"
OPT_FORMAT = "MVMZOPT"
OPT_VERSION = 1
RGBA_MAGIC = b"MVMZRGBA"
RGBA_VERSION = 1
RGBA_HEADER = struct.Struct("<8sIIII")
RPGMV_HEADER = bytes.fromhex("5250474d560000000003010000000000")

TARGET_GROUPS = ("pictures", "faces", "animations")
IMAGE_EXTENSIONS = (".png", ".rpgmvp", ".png_")


def fnv1a32(data: bytes) -> str:
    value = 0x811C9DC5
    for byte in data:
        value ^= byte
        value = (value * 0x01000193) & 0xFFFFFFFF
    return f"{value:08x}"


def load_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def find_game_root(selected: Path) -> tuple[str, Path]:
    selected = selected.resolve()
    candidates = [selected / "game", selected / "www", selected]
    seen: set[Path] = set()
    for candidate in candidates:
        try:
            candidate = candidate.resolve()
        except Exception:
            continue
        if candidate in seen:
            continue
        seen.add(candidate)
        if not (candidate / "index.html").is_file():
            continue
        if (candidate / "js" / "rpg_core.js").is_file():
            return "MV", candidate
        if (candidate / "js" / "rmmz_core.js").is_file():
            return "MZ", candidate
    raise ValueError(f"RPG Maker MV/MZ 게임 루트를 찾을 수 없습니다: {selected}")


def load_system(root: Path) -> tuple[dict[str, Any], bytes, bytes]:
    path = root / "data" / "System.json"
    if not path.is_file():
        return {}, b"", b""
    raw = path.read_bytes()
    system = json.loads(raw.decode("utf-8-sig"))
    key_hex = str(system.get("encryptionKey") or "").strip()
    try:
        key = bytes.fromhex(key_hex) if len(key_hex) >= 32 else b""
    except ValueError:
        key = b""
    return system, key, raw


def decrypt_rpgmv(data: bytes, key: bytes) -> bytes:
    if len(data) < 16 or data[:16] != RPGMV_HEADER:
        raise ValueError("invalid RPG Maker encrypted image header")
    if len(key) < 16:
        raise ValueError("RPG Maker encryptionKey is missing or invalid")
    payload = bytearray(data[16:])
    for i in range(min(16, len(payload))):
        payload[i] ^= key[i]
    return bytes(payload)


def read_image_bytes(engine: str, source: Path, key: bytes) -> bytes:
    blob = source.read_bytes()
    ext = source.suffix.lower()
    if ext in (".rpgmvp", ".png_"):
        blob = decrypt_rpgmv(blob, key)
    return blob


def logical_image_path(root: Path, source: Path) -> str:
    rel = source.relative_to(root).as_posix()
    low = rel.lower()
    if low.endswith(".rpgmvp"):
        return rel[:-len(".rpgmvp")] + ".png"
    if low.endswith(".png_"):
        return rel[:-5] + ".png"
    return rel


def cache_relpath(logical: str) -> str:
    stem = logical.rsplit(".", 1)[0]
    return f"rgba/{stem}.mrgba"


@dataclass
class Asset:
    logical: str
    source: Path
    source_rel: str
    group: str
    name: str
    width: int
    height: int
    pixels: int
    source_size: int
    source_mtime_ns: int
    raw_bytes: int
    score: int = 0
    refs: int = 0
    reasons: Counter[str] | None = None

    def add(self, score: int, reason: str, refs: int = 1) -> None:
        self.score += int(score)
        self.refs += int(refs)
        if self.reasons is None:
            self.reasons = Counter()
        self.reasons[reason] += int(refs)


class Optimizer:
    def __init__(
        self,
        selected: Path,
        budget_mib: int = 512,
        progress: Callable[[int, str], None] | None = None,
        log: Callable[[str], None] | None = None,
    ) -> None:
        self.engine, self.root = find_game_root(selected)
        self.budget_mib = max(64, int(budget_mib))
        self.budget_bytes = self.budget_mib * 1048576
        self.progress_cb = progress or (lambda pct, text: None)
        self.log_cb = log or print
        self.system, self.key, self.system_raw = load_system(self.root)
        self.assets: dict[str, Asset] = {}
        self.by_group_name: dict[str, dict[str, Asset]] = defaultdict(dict)
        self.animation_refs: Counter[int] = Counter()
        self.effect_refs: Counter[str] = Counter()
        self.se_refs: Counter[str] = Counter()
        self.glyphs: set[str] = set()
        self.dialogue_lines = 0
        self.plugin_strings_scanned = 0

    def progress(self, pct: int, text: str) -> None:
        self.progress_cb(max(0, min(100, int(pct))), text)

    def log(self, text: str) -> None:
        self.log_cb(str(text))

    def add_glyph_text(self, value: Any) -> None:
        if not isinstance(value, str):
            return
        for ch in value:
            if ord(ch) >= 32 and ch not in "\r\n\t":
                self.glyphs.add(ch)

    def scan_assets(self) -> None:
        self.progress(3, "이미지 메타데이터 확인 중")
        sources: list[tuple[str, Path]] = []
        for group in TARGET_GROUPS:
            folder = self.root / "img" / group
            if not folder.is_dir():
                continue
            for path in folder.rglob("*"):
                if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
                    sources.append((group, path))
        sources.sort(key=lambda x: str(x[1]).lower())
        self.log(f"엔진: RPG Maker {self.engine}")
        self.log(f"게임 루트: {self.root}")
        self.log(f"대상 이미지: {len(sources)}개")

        for idx, (group, source) in enumerate(sources, 1):
            logical = logical_image_path(self.root, source).replace("\\", "/")
            try:
                blob = read_image_bytes(self.engine, source, self.key)
                with Image.open(io.BytesIO(blob)) as image:
                    image.load()
                    width, height = image.size
                stat = source.stat()
                name = Path(logical).stem
                asset = Asset(
                    logical=logical,
                    source=source,
                    source_rel=source.relative_to(self.root).as_posix(),
                    group=group,
                    name=name,
                    width=int(width),
                    height=int(height),
                    pixels=int(width * height),
                    source_size=int(stat.st_size),
                    source_mtime_ns=int(stat.st_mtime_ns),
                    raw_bytes=int(RGBA_HEADER.size + width * height * 4),
                    reasons=Counter(),
                )
                # Fallback scores intentionally stay low. Explicit event/plugin
                # references will dominate, but leftover budget still targets
                # assets most likely to hitch at first use.
                if group == "faces":
                    asset.add(4, "fallback-face", 0)
                elif group == "animations":
                    asset.add(3, "fallback-animation", 0)
                elif group == "pictures":
                    asset.add(1, "fallback-picture", 0)
                self.assets[logical.lower()] = asset
                self.by_group_name[group][name.lower()] = asset
            except Exception as exc:
                self.log(f"[경고] 이미지 분석 실패: {logical} | {exc}")
            if idx % 25 == 0 or idx == len(sources):
                pct = 3 + int(22 * idx / max(1, len(sources)))
                self.progress(pct, f"이미지 메타데이터 {idx}/{len(sources)}")

    def add_asset(self, group: str, name: Any, score: int, reason: str) -> None:
        if not isinstance(name, str) or not name:
            return
        clean = name.replace("\\", "/").split("/")[-1]
        clean = re.sub(r"\.(?:png|rpgmvp|png_)$", "", clean, flags=re.I)
        asset = self.by_group_name.get(group, {}).get(clean.lower())
        if asset:
            asset.add(score, reason)

    def inspect_string_for_asset(self, value: Any, score: int = 30, reason: str = "plugin-string") -> None:
        if not isinstance(value, str) or not value:
            return
        self.add_glyph_text(value)
        self.plugin_strings_scanned += 1
        normalized = value.replace("\\", "/").strip().strip("\"'")
        basename = normalized.split("/")[-1]
        basename = re.sub(r"\.(?:png|rpgmvp|png_)$", "", basename, flags=re.I)
        for group in TARGET_GROUPS:
            if basename.lower() in self.by_group_name.get(group, {}):
                self.add_asset(group, basename, score, reason)
        match = re.search(r"img/(pictures|faces|animations)/([^\"'\s,;)\]]+)", normalized, re.I)
        if match:
            self.add_asset(match.group(1).lower(), match.group(2), score + 15, reason + "-path")

    def inspect_nested_strings(self, value: Any, score: int = 30, reason: str = "plugin-arg") -> None:
        if isinstance(value, str):
            self.inspect_string_for_asset(value, score, reason)
        elif isinstance(value, list):
            for item in value:
                self.inspect_nested_strings(item, score, reason)
        elif isinstance(value, dict):
            for item in value.values():
                self.inspect_nested_strings(item, score, reason)

    def animation_dependency(self, animation_id: Any, weight: int = 1, reason: str = "animation-ref") -> None:
        try:
            animation_id = int(animation_id or 0)
        except Exception:
            return
        if animation_id > 0:
            self.animation_refs[animation_id] += max(1, int(weight))

    def scan_event_list(self, commands: Any, source: str) -> None:
        if not isinstance(commands, list):
            return
        for command in commands:
            if not isinstance(command, dict):
                continue
            try:
                code = int(command.get("code") or 0)
            except Exception:
                code = 0
            params = command.get("parameters") or []
            if code == 101 and params:
                self.add_asset("faces", params[0], 100, "show-text-face")
            elif code in (401, 405) and params:
                self.dialogue_lines += 1
                self.add_glyph_text(params[0])
            elif code == 212 and len(params) > 1:
                self.animation_dependency(params[1], 4, "event-animation")
            elif code == 231 and len(params) > 1:
                self.add_asset("pictures", params[1], 140, "show-picture")
            elif code == 250 and params and isinstance(params[0], dict):
                name = str(params[0].get("name") or "")
                if name:
                    self.se_refs[name] += 1
            elif code in (355, 356, 357, 655):
                self.inspect_nested_strings(params, 45, f"event-code-{code}")
            else:
                # Plugin makers often place asset names in parameters of custom
                # or script-generated commands. Exact basename matching keeps
                # this generic without guessing plugin-specific syntax.
                if code >= 350:
                    self.inspect_nested_strings(params, 25, f"event-code-{code}")

    def scan_events_and_text(self) -> None:
        self.progress(27, "이벤트/대사/그림 참조 분석 중")
        data = self.root / "data"
        common = load_json(data / "CommonEvents.json", [])
        for item in common if isinstance(common, list) else []:
            if isinstance(item, dict):
                self.scan_event_list(item.get("list"), f"common:{item.get('id', 0)}")

        maps = sorted(data.glob("Map[0-9][0-9][0-9].json"))
        for idx, path in enumerate(maps, 1):
            try:
                obj = load_json(path, {})
                for event in obj.get("events") or []:
                    if not isinstance(event, dict):
                        continue
                    for page in event.get("pages") or []:
                        if isinstance(page, dict):
                            self.scan_event_list(page.get("list"), path.stem)
            except Exception as exc:
                self.log(f"[경고] 맵 분석 실패: {path.name} | {exc}")
            if idx % 25 == 0 or idx == len(maps):
                self.progress(27 + int(13 * idx / max(1, len(maps))), f"맵 이벤트 {idx}/{len(maps)}")

        # Database text is included in the glyph set because menu/skill/item
        # text is another common first-use font hitch source.
        for name in ("Actors.json", "Classes.json", "Skills.json", "Items.json", "Weapons.json", "Armors.json", "Enemies.json", "States.json", "System.json"):
            obj = load_json(data / name, None)
            self.inspect_nested_strings(obj, 0, "database-text")

        for db_name in ("Skills.json", "Items.json"):
            obj = load_json(data / db_name, [])
            if isinstance(obj, list):
                for row in obj:
                    if isinstance(row, dict):
                        self.animation_dependency(row.get("animationId"), 2, db_name.lower())

    def scan_animation_db(self) -> None:
        self.progress(42, "전투 애니메이션/Effect/SE 분석 중")
        animations = load_json(self.root / "data" / "Animations.json", [])
        if not isinstance(animations, list):
            return
        for row in animations:
            if not isinstance(row, dict):
                continue
            try:
                anim_id = int(row.get("id") or 0)
            except Exception:
                anim_id = 0
            weight = max(1, self.animation_refs.get(anim_id, 0))
            if self.engine == "MV":
                for key in ("animation1Name", "animation2Name"):
                    name = str(row.get(key) or "")
                    if name:
                        self.add_asset("animations", name, 55 + weight * 10, "animation-db")
                for timing in row.get("timings") or []:
                    if isinstance(timing, dict):
                        se = timing.get("se") or {}
                        name = str(se.get("name") or "") if isinstance(se, dict) else ""
                        if name:
                            self.se_refs[name] += weight
            else:
                effect = str(row.get("effectName") or "")
                if effect:
                    self.effect_refs[effect] += weight
                for timing in row.get("soundTimings") or []:
                    if isinstance(timing, dict):
                        se = timing.get("se") or {}
                        name = str(se.get("name") or "") if isinstance(se, dict) else ""
                        if name:
                            self.se_refs[name] += weight

    def scan_plugin_literals(self) -> None:
        self.progress(45, "플러그인 문자열 분석 중")
        plugin_dir = self.root / "js" / "plugins"
        files = sorted(plugin_dir.glob("*.js")) if plugin_dir.is_dir() else []
        string_re = re.compile(r"(['\"])(.{1,240}?)\1")
        for idx, path in enumerate(files, 1):
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
                for match in string_re.finditer(text):
                    self.inspect_string_for_asset(match.group(2), 20, "plugin-literal")
            except Exception as exc:
                self.log(f"[경고] 플러그인 분석 실패: {path.name} | {exc}")
            if idx % 20 == 0 or idx == len(files):
                self.progress(45 + int(5 * idx / max(1, len(files))), f"플러그인 {idx}/{len(files)}")

    def plan(self) -> list[Asset]:
        self.progress(52, "Hot Asset 선정 중")
        # Large pictures are the most expensive first-use assets, so size is a
        # tiebreaker after usage score. Small faces remain cheap enough to fit
        # naturally because their raw byte cost is low.
        ranked = sorted(
            self.assets.values(),
            key=lambda a: (a.score, a.refs, a.pixels, a.source_size),
            reverse=True,
        )
        selected: list[Asset] = []
        used = 0
        for asset in ranked:
            # Tiny generic pictures/animations do not justify raw-cache disk
            # overhead unless they have an explicit reference score.
            explicit = asset.refs > 0 or asset.score >= 20
            if not explicit and asset.pixels < 32768:
                continue
            if used + asset.raw_bytes > self.budget_bytes:
                continue
            selected.append(asset)
            used += asset.raw_bytes
        self.log(f"선정: {len(selected)}개 / raw {used / 1048576:.1f} MiB / 예산 {self.budget_mib} MiB")
        return selected

    def write_rgba(self, asset: Asset, target: Path) -> None:
        blob = read_image_bytes(self.engine, asset.source, self.key)
        with Image.open(io.BytesIO(blob)) as image:
            image.load()
            rgba = image.convert("RGBA").tobytes("raw", "RGBA")
        if len(rgba) != asset.width * asset.height * 4:
            raise ValueError("RGBA payload size mismatch")
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as fp:
            fp.write(RGBA_HEADER.pack(RGBA_MAGIC, RGBA_VERSION, asset.width, asset.height, len(rgba)))
            fp.write(rgba)

    def build(self) -> Path:
        started = time.time()
        self.scan_assets()
        self.scan_events_and_text()
        self.scan_animation_db()
        self.scan_plugin_literals()
        selected = self.plan()

        opt_root = self.root / OPT_DIR
        old_manifest = load_json(opt_root / "manifest.json", {})
        old_entries = old_manifest.get("entries") if isinstance(old_manifest, dict) else {}
        if not isinstance(old_entries, dict):
            old_entries = {}

        entries: dict[str, Any] = {}
        reused = 0
        failed = 0
        built = 0
        for idx, asset in enumerate(selected, 1):
            rel_cache = cache_relpath(asset.logical)
            target = opt_root / Path(rel_cache)
            key = asset.logical.lower()
            old = old_entries.get(key) if isinstance(old_entries, dict) else None
            entry = {
                "logical": asset.logical,
                "cache": rel_cache,
                "group": asset.group,
                "width": asset.width,
                "height": asset.height,
                "pixels": asset.pixels,
                "raw_bytes": asset.raw_bytes,
                "source": asset.source_rel,
                "source_size": asset.source_size,
                "source_mtime_ns": asset.source_mtime_ns,
                "score": asset.score,
                "refs": asset.refs,
                "reasons": dict(asset.reasons or {}),
            }
            entries[key] = entry
            same = (
                isinstance(old, dict)
                and target.is_file()
                and old.get("source_size") == asset.source_size
                and old.get("source_mtime_ns") == asset.source_mtime_ns
                and old.get("raw_bytes") == asset.raw_bytes
            )
            if same:
                reused += 1
            else:
                try:
                    self.write_rgba(asset, target)
                    built += 1
                except Exception as exc:
                    failed += 1
                    entries.pop(key, None)
                    self.log(f"[경고] 캐시 생성 실패: {asset.logical} | {exc}")
            self.progress(55 + int(40 * idx / max(1, len(selected))), f"RGBA 캐시 {idx}/{len(selected)}")

        opt_root.mkdir(parents=True, exist_ok=True)
        glyph_text = "".join(sorted(self.glyphs, key=ord))
        (opt_root / "glyphs.txt").write_text(glyph_text, encoding="utf-8")

        total_raw = sum(int(e.get("raw_bytes", 0)) for e in entries.values())
        top_assets = sorted(entries.values(), key=lambda e: (e.get("score", 0), e.get("pixels", 0)), reverse=True)[:100]
        manifest = {
            "format": OPT_FORMAT,
            "version": OPT_VERSION,
            "tool_version": APP_VERSION,
            "engine": self.engine,
            "generated_unix": int(time.time()),
            "game_fingerprint": {
                "system_fnv1a32": fnv1a32(self.system_raw),
                "system_bytes": len(self.system_raw),
            },
            "options": {
                "budget_mib": self.budget_mib,
                "target_groups": list(TARGET_GROUPS),
                "cache_format": "MVMZRGBA-v1",
            },
            "analysis": {
                "asset_catalog": len(self.assets),
                "cached_assets": len(entries),
                "cache_mib": round(total_raw / 1048576, 2),
                "dialogue_lines": self.dialogue_lines,
                "glyph_count": len(self.glyphs),
                "plugin_strings_scanned": self.plugin_strings_scanned,
                "effect_refs": dict(self.effect_refs.most_common()),
                "se_refs": dict(self.se_refs.most_common()),
                "animation_refs": {str(k): v for k, v in self.animation_refs.most_common()},
                "top_assets": top_assets,
            },
            "entries": entries,
        }
        (opt_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        report = [
            f"{APP_NAME} {APP_VERSION}",
            f"Engine: RPG Maker {self.engine}",
            f"Game root: {self.root}",
            f"Cached assets: {len(entries)}",
            f"Cache size: {total_raw / 1048576:.1f} MiB / budget {self.budget_mib} MiB",
            f"Built: {built} / Reused: {reused} / Failed: {failed}",
            f"Dialogue lines: {self.dialogue_lines}",
            f"Glyphs: {len(self.glyphs)}",
            f"MZ effects referenced: {len(self.effect_refs)}",
            f"SE referenced: {len(self.se_refs)}",
            "",
            "Top cached assets:",
        ]
        for entry in top_assets[:30]:
            report.append(f"- score={entry['score']:4d} refs={entry['refs']:3d} {entry['logical']} {entry['width']}x{entry['height']}")
        (opt_root / "report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")

        elapsed = time.time() - started
        self.progress(100, "완료")
        self.log(f"완료: {opt_root}")
        self.log(f"캐시 {len(entries)}개 / {total_raw / 1048576:.1f} MiB / {elapsed:.1f}초")
        if failed:
            self.log(f"실패 {failed}개는 원본 로딩으로 자동 fallback 됩니다.")
        return opt_root


def run_cli(args: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=APP_NAME)
    parser.add_argument("--game", required=True)
    parser.add_argument("--budget-mib", type=int, default=512)
    ns = parser.parse_args(args)
    opt = Optimizer(Path(ns.game), ns.budget_mib, lambda p, t: print(f"PROGRESS={p}|{t}"), print)
    path = opt.build()
    print(f"OUTPUT={path}")
    return 0


def run_gui() -> int:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title(f"{APP_NAME} v{APP_VERSION}")
    root.geometry("820x620")
    root.minsize(720, 540)

    selected_var = tk.StringVar()
    detected_var = tk.StringVar(value="게임 폴더를 선택하세요.")
    budget_var = tk.StringVar(value="512")
    status_var = tk.StringVar(value="대기 중")
    queue: Queue[tuple[str, Any]] = Queue()
    running = {"value": False}
    last_output = {"path": None}

    outer = ttk.Frame(root, padding=14)
    outer.pack(fill="both", expand=True)
    ttk.Label(outer, text="MVMZ Optimizer", font=("Segoe UI", 18, "bold")).pack(anchor="w")
    ttk.Label(
        outer,
        text="대화 일러스트 / Face / 전투 애니메이션의 첫 사용 PNG decode 비용을 PC에서 미리 처리합니다.\n"
             "게임 원본은 수정하지 않고 게임 루트에 .mvmz_opt 폴더만 생성합니다.",
        justify="left",
    ).pack(anchor="w", pady=(4, 14))

    path_frame = ttk.Frame(outer)
    path_frame.pack(fill="x")
    ttk.Entry(path_frame, textvariable=selected_var).pack(side="left", fill="x", expand=True)

    def detect(path: str) -> None:
        if not path:
            detected_var.set("게임 폴더를 선택하세요.")
            return
        try:
            engine, game_root = find_game_root(Path(path))
            detected_var.set(f"감지: RPG Maker {engine}   |   데이터 루트: {game_root}")
        except Exception as exc:
            detected_var.set(f"감지 실패: {exc}")

    def choose_folder() -> None:
        path = filedialog.askdirectory(title="RPG Maker MV/MZ 게임 폴더 선택")
        if path:
            selected_var.set(path)
            detect(path)

    ttk.Button(path_frame, text="게임 폴더 선택", command=choose_folder).pack(side="left", padx=(8, 0))
    ttk.Label(outer, textvariable=detected_var).pack(anchor="w", pady=(8, 12))

    option = ttk.LabelFrame(outer, text="최적화 설정", padding=10)
    option.pack(fill="x")
    ttk.Label(option, text="최대 raw cache 용량").grid(row=0, column=0, sticky="w")
    combo = ttk.Combobox(option, textvariable=budget_var, values=("256", "512", "1024", "2048"), width=10, state="readonly")
    combo.grid(row=0, column=1, sticky="w", padx=(10, 0))
    ttk.Label(option, text="MiB  (권장: 512 MiB)").grid(row=0, column=2, sticky="w", padx=(8, 0))
    ttk.Label(
        option,
        text="대상: Pictures / Faces / MV Animation 이미지. MZ Effect/SE와 대사 glyph는 manifest 분석 정보로 함께 저장됩니다.",
    ).grid(row=1, column=0, columnspan=3, sticky="w", pady=(8, 0))

    progress = ttk.Progressbar(outer, maximum=100, mode="determinate")
    progress.pack(fill="x", pady=(14, 4))
    ttk.Label(outer, textvariable=status_var).pack(anchor="w")

    log_box = tk.Text(outer, height=17, wrap="word", state="disabled", font=("Consolas", 9))
    log_box.pack(fill="both", expand=True, pady=(8, 10))

    def append_log(text: str) -> None:
        log_box.configure(state="normal")
        log_box.insert("end", text + "\n")
        log_box.see("end")
        log_box.configure(state="disabled")

    def worker(game: str, budget: int) -> None:
        try:
            opt = Optimizer(
                Path(game),
                budget,
                lambda p, t: queue.put(("progress", (p, t))),
                lambda t: queue.put(("log", t)),
            )
            out = opt.build()
            queue.put(("done", str(out)))
        except Exception:
            queue.put(("error", traceback.format_exc()))

    def start_build() -> None:
        if running["value"]:
            return
        game = selected_var.get().strip()
        try:
            find_game_root(Path(game))
        except Exception as exc:
            messagebox.showerror(APP_NAME, str(exc))
            return
        running["value"] = True
        build_button.configure(state="disabled")
        open_button.configure(state="disabled")
        progress["value"] = 0
        status_var.set("시작 중...")
        append_log("=" * 72)
        append_log(f"{APP_NAME} v{APP_VERSION} 시작")
        threading.Thread(target=worker, args=(game, int(budget_var.get())), daemon=True).start()

    def open_output() -> None:
        path = last_output["path"]
        if path and Path(path).is_dir():
            os.startfile(path)

    buttons = ttk.Frame(outer)
    buttons.pack(fill="x")
    build_button = ttk.Button(buttons, text="최적화 캐시 생성", command=start_build)
    build_button.pack(side="left")
    open_button = ttk.Button(buttons, text=".mvmz_opt 열기", command=open_output, state="disabled")
    open_button.pack(side="left", padx=(8, 0))
    ttk.Button(buttons, text="종료", command=root.destroy).pack(side="right")

    def pump() -> None:
        try:
            while True:
                kind, payload = queue.get_nowait()
                if kind == "progress":
                    pct, text = payload
                    progress["value"] = pct
                    status_var.set(f"{pct}%  {text}")
                elif kind == "log":
                    append_log(str(payload))
                elif kind == "done":
                    running["value"] = False
                    last_output["path"] = payload
                    build_button.configure(state="normal")
                    open_button.configure(state="normal")
                    status_var.set("완료")
                    messagebox.showinfo(APP_NAME, f"완료되었습니다.\n\n{payload}\n\n게임 폴더와 함께 .mvmz_opt를 Switch SD에 복사하세요.")
                elif kind == "error":
                    running["value"] = False
                    build_button.configure(state="normal")
                    status_var.set("오류")
                    append_log(str(payload))
                    messagebox.showerror(APP_NAME, "최적화 중 오류가 발생했습니다. 아래 로그를 확인하세요.")
        except Empty:
            pass
        root.after(80, pump)

    selected_var.trace_add("write", lambda *_: detect(selected_var.get().strip()))
    root.after(80, pump)
    root.mainloop()
    return 0


if __name__ == "__main__":
    if "--game" in sys.argv:
        raise SystemExit(run_cli(sys.argv[1:]))
    raise SystemExit(run_gui())


#!/usr/bin/env python3
import argparse
import io
import json
import re
import time
from pathlib import Path

from PIL import Image

from build_switch_precache import (
    find_game_root,
    fnv1a32,
    load_mv_system,
    logical_path,
    read_image_bytes,
    source_candidates,
)


FOLDERS = {
    "animation": "img/animations",
    "battleback1": "img/battlebacks1",
    "battleback2": "img/battlebacks2",
    "character": "img/characters",
    "face": "img/faces",
    "parallax": "img/parallaxes",
    "picture": "img/pictures",
    "svactor": "img/sv_actors",
    "tileset": "img/tilesets",
}


def load_json(path: Path, default):
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def asset_logical(kind: str, name: str):
    folder = FOLDERS.get(kind)
    if not folder or not name:
        return ""
    return f"{folder}/{name}.png"


def build_asset_metadata(engine: str, root: Path, mv_key: bytes):
    result = {}
    sources = source_candidates(root)
    for index, source in enumerate(sources, 1):
        logical = logical_path(root, source).replace("\\", "/")
        try:
            blob = read_image_bytes(engine, source, mv_key)
            with Image.open(io.BytesIO(blob)) as im:
                im.load()
                width, height = im.size
            result[logical.lower()] = {
                "logical": logical,
                "width": width,
                "height": height,
                "pixels": width * height,
                "source_bytes": source.stat().st_size,
            }
        except Exception as exc:
            print(f"WARN_META={logical}: {exc}")
        if index % 500 == 0:
            print(f"META_SCAN={index}/{len(sources)}")
    return result


class DependencyCollector:
    def __init__(self, asset_meta, animations, common_events, tilesets):
        self.asset_meta = asset_meta
        self.animations = animations
        self.common_events = common_events
        self.tilesets = tilesets
        self.items = {}
        self.order = 0

    def add(self, kind, name, hue=0, priority=1, source=""):
        name = str(name or "")
        if not name:
            return
        logical = asset_logical(kind, name)
        if not logical:
            return
        key = f"{kind}|{name}|{int(hue or 0)}"
        meta = self.asset_meta.get(logical.lower(), {})
        item = {
            "kind": kind,
            "name": name,
            "hue": int(hue or 0),
            "priority": int(priority),
            "order": self.order,
            "logical": logical,
            "width": int(meta.get("width", 0)),
            "height": int(meta.get("height", 0)),
            "pixels": int(meta.get("pixels", 0)),
            "source_bytes": int(meta.get("source_bytes", 0)),
            "source": source,
        }
        self.order += 1
        old = self.items.get(key)
        if old is None or (item["priority"], item["order"]) < (old["priority"], old["order"]):
            self.items[key] = item

    def add_tileset(self, tileset_id, priority=0, source="map"):
        try:
            tileset = self.tilesets[int(tileset_id)]
        except Exception:
            return
        if not tileset:
            return
        for name in tileset.get("tilesetNames") or []:
            self.add("tileset", name, 0, priority, source)

    def add_animation(self, animation_id, priority=1, source="event"):
        try:
            animation = self.animations[int(animation_id)]
        except Exception:
            return
        if not animation:
            return
        self.add("animation", animation.get("animation1Name"), animation.get("animation1Hue", 0), priority, source)
        self.add("animation", animation.get("animation2Name"), animation.get("animation2Hue", 0), priority, source)

    def scan_move_route(self, route, priority=1, source="move_route"):
        if not isinstance(route, dict):
            return
        for command in route.get("list") or []:
            if int(command.get("code") or 0) == 41:
                params = command.get("parameters") or []
                if params:
                    self.add("character", params[0], 0, priority, source)

    def scan_list(self, commands, priority=1, depth=0, seen_common=None, source="event"):
        if not isinstance(commands, list):
            return
        if seen_common is None:
            seen_common = set()
        for command in commands:
            if not isinstance(command, dict):
                continue
            code = int(command.get("code") or 0)
            params = command.get("parameters") or []
            if code == 101 and params:
                self.add("face", params[0], 0, priority, source)
            elif code == 117 and params and depth < 2:
                common_id = int(params[0] or 0)
                if common_id and common_id not in seen_common:
                    seen_common.add(common_id)
                    try:
                        common = self.common_events[common_id]
                    except Exception:
                        common = None
                    if common:
                        self.scan_list(common.get("list"), priority + 1, depth + 1, seen_common, f"common:{common_id}")
            elif code == 205 and len(params) > 1:
                self.scan_move_route(params[1], priority, source)
            elif code == 212 and len(params) > 1:
                self.add_animation(params[1], priority, source)
            elif code == 231 and len(params) > 1:
                self.add("picture", params[1], 0, priority, source)
            elif code == 282 and params:
                self.add_tileset(params[0], priority, source)
            elif code == 283:
                if len(params) > 0:
                    self.add("battleback1", params[0], 0, priority, source)
                if len(params) > 1:
                    self.add("battleback2", params[1], 0, priority, source)
            elif code == 284 and params:
                self.add("parallax", params[0], 0, priority, source)
            elif code == 322:
                if len(params) > 1:
                    self.add("character", params[1], 0, priority, source)
                if len(params) > 3:
                    self.add("face", params[3], 0, priority, source)
                if len(params) > 5:
                    self.add("svactor", params[5], 0, priority, source)
            elif code == 323 and len(params) > 1:
                self.add("character", params[1], 0, priority, source)

    def sorted_items(self):
        return sorted(self.items.values(), key=lambda x: (x["priority"], x["order"], x["kind"], x["name"].lower()))


def main():
    ap = argparse.ArgumentParser(description="Build MVMZ Switch per-map warm manifest")
    ap.add_argument("--game", required=True, help="MV game folder (root/game/www accepted)")
    ap.add_argument("--output", help="output manifest path; default <game>/.mvmz_warm/manifest.json")
    args = ap.parse_args()

    engine, root = find_game_root(Path(args.game))
    if engine != "MV":
        raise SystemExit("This warm-manifest builder currently targets MV. MZ will be added with the MZ runtime path.")

    system, mv_key = load_mv_system(root)
    data_root = root / "data"
    animations = load_json(data_root / "Animations.json", [])
    common_events = load_json(data_root / "CommonEvents.json", [])
    tilesets = load_json(data_root / "Tilesets.json", [])
    system_bytes = (data_root / "System.json").read_bytes()

    print(f"ENGINE={engine}")
    print(f"GAME_ROOT={root}")
    print("Scanning image dimensions...")
    asset_meta = build_asset_metadata(engine, root, mv_key)
    print(f"ASSET_META={len(asset_meta)}")

    maps = {}
    map_files = sorted(data_root.glob("Map[0-9][0-9][0-9].json"))
    for index, map_path in enumerate(map_files, 1):
        match = re.search(r"Map(\d+)\.json$", map_path.name, re.I)
        if not match:
            continue
        map_id = int(match.group(1))
        data = load_json(map_path, {})
        collector = DependencyCollector(asset_meta, animations, common_events, tilesets)

        collector.add_tileset(data.get("tilesetId", 0), 0, "map_base")
        collector.add("parallax", data.get("parallaxName"), 0, 0, "map_base")
        if data.get("specifyBattleback"):
            collector.add("battleback1", data.get("battleback1Name"), 0, 0, "map_base")
            collector.add("battleback2", data.get("battleback2Name"), 0, 0, "map_base")

        for event in data.get("events") or []:
            if not event:
                continue
            event_id = event.get("id", 0)
            for page_index, page in enumerate(event.get("pages") or []):
                image = page.get("image") or {}
                collector.add("character", image.get("characterName"), 0, 0, f"event:{event_id}:page:{page_index}")
                collector.scan_list(page.get("list"), 1, 0, set(), f"event:{event_id}:page:{page_index}")

        items = collector.sorted_items()
        maps[str(map_id)] = items
        if index % 25 == 0:
            print(f"MAP_SCAN={index}/{len(map_files)}")

    output = Path(args.output).resolve() if args.output else root / ".mvmz_warm" / "manifest.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "format": "MVMZWARM",
        "version": 1,
        "engine": "MV",
        "generated_unix": int(time.time()),
        "game_fingerprint": {
            "system_fnv1a32": fnv1a32(system_bytes),
            "system_bytes": len(system_bytes),
        },
        "asset_meta": asset_meta,
        "maps": maps,
    }
    output.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    dep_count = sum(len(v) for v in maps.values())
    print(f"MAPS={len(maps)}")
    print(f"DEPENDENCIES={dep_count}")
    print(f"OUTPUT={output}")
    print(f"OUTPUT_BYTES={output.stat().st_size}")
    print("DONE=1")


if __name__ == "__main__":
    main()

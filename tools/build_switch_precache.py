#!/usr/bin/env python3
import argparse
import io
import json
import os
import struct
import sys
import time
from pathlib import Path

from PIL import Image


MAGIC = b"MVMZRGBA"
VERSION = 1
HEADER = struct.Struct("<8sIIII")
MV_HEADER = bytes.fromhex("5250474d560000000003010000000000")


def fnv1a32(data: bytes):
    value = 0x811C9DC5
    for byte in data:
        value ^= byte
        value = (value * 0x01000193) & 0xFFFFFFFF
    return f"{value:08x}"


def find_game_root(selected: Path):
    selected = selected.resolve()
    for candidate in (selected / "game", selected / "www", selected):
        if not (candidate / "index.html").is_file():
            continue
        if (candidate / "js" / "rpg_core.js").is_file():
            return "MV", candidate
        if (candidate / "js" / "rmmz_core.js").is_file():
            return "MZ", candidate
    raise SystemExit(f"MV/MZ game root not found: {selected}")


def load_mv_system(root: Path):
    path = root / "data" / "System.json"
    if not path.is_file():
        return {}, b""
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    key_hex = str(data.get("encryptionKey") or "").strip()
    key = bytes.fromhex(key_hex) if len(key_hex) >= 32 else b""
    return data, key


def decrypt_mv(data: bytes, key: bytes):
    if len(data) < 16 or data[:16] != MV_HEADER:
        raise ValueError("invalid RPGMV encrypted image header")
    payload = bytearray(data[16:])
    if len(key) < 16:
        raise ValueError("MV encryption key is missing or invalid")
    for i in range(min(16, len(payload))):
        payload[i] ^= key[i]
    return bytes(payload)


def logical_path(root: Path, source: Path):
    rel = source.relative_to(root).as_posix()
    low = rel.lower()
    if low.endswith(".rpgmvp"):
        return rel[:-len(".rpgmvp")] + ".png"
    return rel


def cache_path(cache_root: Path, logical: str):
    stem = logical.rsplit(".", 1)[0]
    return cache_root / "rgba" / (stem + ".mrgba")


def source_candidates(root: Path):
    img = root / "img"
    if not img.is_dir():
        return []
    out = []
    for path in img.rglob("*"):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext in (".png", ".rpgmvp"):
            out.append(path)
    out.sort(key=lambda p: str(p).lower())
    return out


def read_image_bytes(engine: str, source: Path, mv_key: bytes):
    data = source.read_bytes()
    if source.suffix.lower() == ".rpgmvp":
        if engine != "MV":
            raise ValueError(".rpgmvp found outside MV game")
        data = decrypt_mv(data, mv_key)
    return data


def write_cache_file(path: Path, width: int, height: int, rgba: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    header = HEADER.pack(MAGIC, VERSION, width, height, len(rgba))
    with path.open("wb") as f:
        f.write(header)
        f.write(rgba)


def main():
    ap = argparse.ArgumentParser(description="Build Switch MVMZ raw RGBA pre-cache")
    ap.add_argument("--game", required=True, help="MV/MZ game folder (root/game/www accepted)")
    ap.add_argument("--output", help="cache root; default: <game>/.mvmz_cache")
    ap.add_argument("--mode", choices=("smart", "large", "all"), default="smart")
    ap.add_argument("--min-pixels", type=int, default=131072,
                    help="large mode threshold; default 131072 pixels")
    ap.add_argument("--budget-mib", type=int, default=2048,
                    help="smart mode raw cache budget; default 2048 MiB")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    engine, root = find_game_root(Path(args.game))
    cache_root = Path(args.output).resolve() if args.output else root / ".mvmz_cache"
    min_pixels = 1 if args.mode == "all" else max(1, args.min_pixels)
    budget_bytes = max(128, args.budget_mib) * 1048576
    mv_system, mv_key = load_mv_system(root) if engine == "MV" else ({}, b"")
    system_path = root / "data" / "System.json"
    system_bytes = system_path.read_bytes() if system_path.is_file() else b""
    game_fingerprint = {
        "system_fnv1a32": fnv1a32(system_bytes),
        "system_bytes": len(system_bytes),
    }

    sources = source_candidates(root)
    print(f"ENGINE={engine}")
    print(f"GAME_ROOT={root}")
    print(f"CACHE_ROOT={cache_root}")
    print(f"MODE={args.mode} MIN_PIXELS={min_pixels} BUDGET_MIB={args.budget_mib}")
    print(f"SOURCE_IMAGES={len(sources)}")

    manifest_path = cache_root / "manifest.json"
    old_entries = {}
    if manifest_path.is_file():
        try:
            old = json.loads(manifest_path.read_text(encoding="utf-8"))
            old_entries = {e["logical"]: e for e in old.get("entries", [])}
        except Exception:
            old_entries = {}

    entries = []
    selected = 0
    skipped_small = 0
    reused = 0
    failed = 0
    raw_total = 0
    start = time.time()

    metadata = []
    for index, source in enumerate(sources, 1):
        logical = logical_path(root, source)
        stat = source.stat()
        try:
            blob = read_image_bytes(engine, source, mv_key)
            with Image.open(io.BytesIO(blob)) as im:
                im.load()
                width, height = im.size
            pixels = width * height
            rel = source.relative_to(root).as_posix()
            parts = logical.split('/')
            group = parts[1].lower() if len(parts) > 2 and parts[0].lower() == 'img' else ''
            metadata.append({
                "source_path": source,
                "logical": logical,
                "source": rel,
                "source_size": stat.st_size,
                "source_mtime_ns": stat.st_mtime_ns,
                "width": width,
                "height": height,
                "pixels": pixels,
                "cache_bytes": HEADER.size + pixels * 4,
                "group": group,
            })
        except Exception as exc:
            failed += 1
            print(f"WARN={logical}: {exc}", file=sys.stderr)
        if index % 500 == 0:
            print(f"SCAN={index}/{len(sources)}")

    if args.mode == "all":
        chosen = list(metadata)
    elif args.mode == "large":
        chosen = [m for m in metadata if m["pixels"] >= min_pixels]
        skipped_small = len(metadata) - len(chosen)
    else:
        essential = {
            "tilesets", "parallaxes", "fogs", "battlebacks1", "battlebacks2",
            "characters", "faces", "system", "titles1", "titles2"
        }
        mandatory = [m for m in metadata if m["group"] in essential]
        pictures = [m for m in metadata if m["group"] == "pictures" and m["pixels"] >= min_pixels]
        secondary = [m for m in metadata if m["group"] not in essential and m["group"] != "pictures" and m["pixels"] >= min_pixels]
        pictures.sort(key=lambda m: (m["source_size"], m["pixels"]), reverse=True)
        secondary.sort(key=lambda m: (m["source_size"], m["pixels"]), reverse=True)
        mandatory.sort(key=lambda m: (m["group"], -m["source_size"]))
        chosen = []
        used = 0
        for m in mandatory:
            chosen.append(m)
            used += m["cache_bytes"]
        for m in pictures + secondary:
            if used + m["cache_bytes"] > budget_bytes:
                continue
            chosen.append(m)
            used += m["cache_bytes"]
        skipped_small = len(metadata) - len(chosen)

    chosen.sort(key=lambda m: m["logical"].lower())
    selected = len(chosen)
    raw_total = sum(int(m["cache_bytes"]) for m in chosen)
    print(f"PLAN_SELECTED={selected} PLAN_CACHE_MIB={raw_total / 1048576:.1f}")

    for index, meta in enumerate(chosen, 1):
        logical = meta["logical"]
        source = meta["source_path"]
        target = cache_path(cache_root, logical)
        old = old_entries.get(logical)
        entry = {
            "logical": logical,
            "source": meta["source"],
            "source_size": meta["source_size"],
            "source_mtime_ns": meta["source_mtime_ns"],
            "width": meta["width"],
            "height": meta["height"],
            "pixels": meta["pixels"],
            "cache_bytes": meta["cache_bytes"],
            "min_pixels": min_pixels,
            "mode": args.mode,
            "budget_mib": args.budget_mib,
        }
        entries.append(entry)
        if args.dry_run:
            continue
        if old and target.is_file() and old.get("source_size") == meta["source_size"] and old.get("source_mtime_ns") == meta["source_mtime_ns"] and old.get("cache_bytes") == meta["cache_bytes"]:
            reused += 1
            continue
        try:
            blob = read_image_bytes(engine, source, mv_key)
            with Image.open(io.BytesIO(blob)) as im:
                im.load()
                rgba = im.convert("RGBA").tobytes("raw", "RGBA")
            write_cache_file(target, meta["width"], meta["height"], rgba)
        except Exception as exc:
            failed += 1
            print(f"WARN_WRITE={logical}: {exc}", file=sys.stderr)
        if index % 25 == 0:
            print(f"BUILD={index}/{selected} CACHE_MIB={raw_total / 1048576:.1f}")

    manifest = {
        "format": "MVMZRGBA",
        "version": VERSION,
        "engine": engine,
        "game_root": str(root),
        "mode": args.mode,
        "min_pixels": min_pixels,
        "budget_mib": args.budget_mib,
        "generated_unix": int(time.time()),
        "game_fingerprint": game_fingerprint,
        "has_encrypted_images": bool(mv_system.get("hasEncryptedImages")) if engine == "MV" else False,
        "entries": entries,
    }
    if not args.dry_run:
        cache_root.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    elapsed = time.time() - start
    print(f"SELECTED={selected}")
    print(f"REUSED={reused}")
    print(f"SKIPPED_SMALL={skipped_small}")
    print(f"FAILED={failed}")
    print(f"CACHE_BYTES={raw_total}")
    print(f"CACHE_MIB={raw_total / 1048576:.1f}")
    print(f"ELAPSED_SEC={elapsed:.1f}")
    print("DRY_RUN=1" if args.dry_run else "DONE=1")


if __name__ == "__main__":
    main()

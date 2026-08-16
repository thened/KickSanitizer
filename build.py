#!/usr/bin/env python3
"""Build a Chrome Web Store zip containing only what the extension needs.

    python build.py            -> dist/kicksanitizer-<version>.zip
    python build.py --bump minor

Everything shipped is listed explicitly. An allowlist rather than an ignore
list: a stray capture file or scratch script cannot end up in a public upload
because someone forgot to exclude it.
"""

import argparse
import json
import pathlib
import shutil
import zipfile

ROOT = pathlib.Path(__file__).parent
DIST = ROOT / "dist"

# Exactly what Chrome loads. Anything not here is development-only.
SHIP_FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "content.css",
    "popup.html",
    "popup.css",
    "popup.js",
    "storage.js",
    "stats.js",
    "utils/kickSelectors.js",
    "utils/messageNormalization.js",
    "filters/chatters.js",
    "filters/chatFilters.js",
    "filters/chatSocket.js",
    "filters/avatars.js",
    "filters/mirror.js",
    "filters/pageFilters.js",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
]

# Present in the repo, never in the zip. Listed so the intent is explicit.
DEV_ONLY = ["CLAUDE.md", "DEVELOPMENT.md", "STORE.md", "captures/", "tests/", "capture-server.py",
            "capture-sniffer.js", "build.py", ".claude/", "icons/*.svg"]


def bump(version: str, part: str) -> str:
    parts = [int(x) for x in version.split(".")]
    while len(parts) < 3:
        parts.append(0)
    major, minor, patch = parts[:3]
    if part == "major":
        major, minor, patch = major + 1, 0, 0
    elif part == "minor":
        minor, patch = minor + 1, 0
    else:
        patch += 1
    return f"{major}.{minor}.{patch}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bump", choices=["major", "minor", "patch"],
                    help="raise the manifest version before building")
    args = ap.parse_args()

    manifest_path = ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    if args.bump:
        old = manifest["version"]
        manifest["version"] = bump(old, args.bump)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n",
                                 encoding="utf-8")
        print(f"version {old} -> {manifest['version']}")

    version = manifest["version"]

    # Fail loudly rather than shipping a partial extension.
    missing = [f for f in SHIP_FILES if not (ROOT / f).exists()]
    if missing:
        print("ERROR missing files:")
        for f in missing:
            print("  -", f)
        return 1

    # Chrome rejects SVG icons silently — they render as a blank square. Catch
    # a regression here rather than after upload.
    for key in ("icons", "action"):
        block = manifest.get(key, {})
        block = block.get("default_icon", block) if key == "action" else block
        for size, path in (block or {}).items():
            if str(path).endswith(".svg"):
                print(f"ERROR {key}[{size}] is SVG; Chrome needs a raster icon")
                return 1

    DIST.mkdir(exist_ok=True)

    # 1. Unpacked folder — what you point "Load unpacked" at, and what you can
    #    hand to someone who does not want to install from the store.
    folder = DIST / f"kicksanitizer-{version}"
    if folder.exists():
        shutil.rmtree(folder)
    for f in SHIP_FILES:
        dest = folder / f
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / f, dest)

    # 2. Zip built FROM the folder, so the two can never disagree.
    out = DIST / f"kicksanitizer-{version}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in SHIP_FILES:
            z.write(folder / f, f)

    kb = out.stat().st_size / 1024
    print(f"{folder.relative_to(ROOT)}{chr(92)}   ({len(SHIP_FILES)} files) — Load unpacked points here")
    print(f"{out.relative_to(ROOT)}  ({kb:.1f} KB) — upload this to the Web Store")
    print("excluded:", ", ".join(DEV_ONLY))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

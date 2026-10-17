#!/usr/bin/env python3
"""Pre-sized copies of the operator portraits and product icons: python3 scripts/make_thumbs.py

The originals in eldritchtools/endfield-assets are ~0.5 MB PNGs drawn at 30-90 px, so the
site ships small WebP copies in assets/ and lists them in src/data/thumbs.json (anything not
listed still loads from the asset repo). Run it from the repo root after the operator data
changes; it needs Node (for the ids) and Pillow.
"""
import io
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

from PIL import Image

ROOT = "https://raw.githubusercontent.com/eldritchtools/endfield-assets/main/assets"
# Box per kind: 3x the largest size the CSS draws (76x90 slot portrait, 60x60 picker icon).
BOX = {"operators": (228, 282), "items": (180, 180)}
IDS_JS = """
import { OPS, ROOM_DATA } from "./src/core/index.ts";
const items = [...Object.keys(ROOM_DATA.MFG.items), ...Object.keys(ROOM_DATA.GC.items)];
console.log(JSON.stringify({ operators: Object.keys(OPS).sort(), items: items.sort() }));
"""


def thumb(kind, name):
    url = f"{ROOT}/{kind}/{urllib.parse.quote(name)}.png"
    with urllib.request.urlopen(url, timeout=30) as res:
        im = Image.open(io.BytesIO(res.read())).convert("RGBA")
    im.thumbnail(BOX[kind], Image.LANCZOS)
    os.makedirs(f"assets/{kind}", exist_ok=True)
    im.save(f"assets/{kind}/{name}.webp", "WEBP", quality=75, method=6)


def main():
    ids = json.loads(subprocess.run(["node", "--input-type=module", "-e", IDS_JS], check=True, capture_output=True, text=True).stdout)
    done = {}
    for kind, names in ids.items():
        done[kind] = []
        for name in names:
            try:
                thumb(kind, name)
                done[kind].append(name)
            except Exception as e:  # keep going: a missing thumbnail falls back to the asset repo
                print(f"skipped {kind}/{name}: {e}", file=sys.stderr)
    with open("src/data/thumbs.json", "w") as f:
        json.dump(done, f, indent=1)
        f.write("\n")
    print({k: len(v) for k, v in done.items()})


if __name__ == "__main__":
    main()

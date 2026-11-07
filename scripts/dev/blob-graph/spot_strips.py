"""Blob graph prototype (dev tool): contact strips for checking readings by eye.

    python3 -I scripts/dev/blob-graph/spot_strips.py <out dir> <sample.json> <strip dir>

sample.json: {"items": [{"blob": n, ...}]}. Each strip holds five blobs, one per row: two photo views, one clay view,
the outlined context, and the reading as a claim (the judge's answer is not shown).
"""
import json
import os
import sys
import textwrap

from PIL import Image, ImageDraw, ImageFont


def font(size):
    for f in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def main():
    out, sample_path, strip_dir = sys.argv[1:4]
    os.makedirs(strip_dir, exist_ok=True)
    graph = json.load(open(os.path.join(out, "split", "blobs.json")))
    blobs = graph["blobs"]
    items = json.load(open(sample_path))["items"]
    F = font(15)
    tile = 220
    text_w = 520
    for s in range(0, len(items), 5):
        rows = items[s:s + 5]
        W, H = 4 * tile + text_w + 50, len(rows) * (tile + 10) + 10
        img = Image.new("RGB", (W, H), (24, 24, 24))
        d = ImageDraw.Draw(img)
        for r, it in enumerate(rows):
            b = blobs[it["blob"]]
            vd = os.path.join(out, "views", str(it["blob"]))
            y = 10 + r * (tile + 10)
            for c, name in enumerate(["photo_45.png", "photo_225.png", "clay_45.png", "context.png"]):
                p = os.path.join(vd, name)
                if os.path.exists(p):
                    img.paste(Image.open(p).convert("RGB").resize((tile, tile)), (10 + c * (tile + 5), y))
            sz = b["measures"]["sizeM"]
            claim = it.get("claim", "")
            lines = [f"S{s + r + 1}  blob {b['index']}  ({b['group']})", f"{sz[0]:.1f} x {sz[2]:.1f} m plan, {sz[1]:.1f} m tall", ""]
            lines += textwrap.wrap("Claim: " + claim, 60)
            d.multiline_text((10 + 4 * (tile + 5) + 10, y + 4), "\n".join(lines), font=F, fill=(235, 235, 235), spacing=4)
        img.save(os.path.join(strip_dir, f"strip_{s // 5 + 1}.png"))
    print("strips:", (len(items) + 4) // 5)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# ********************************************************************************
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
#
# This software and associated documentation files are proprietary and confidential
# to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
# of this file, via any medium, is strictly prohibited without explicit written
# permission from Scratchbox LLC.
# ********************************************************************************
"""Crops, panel splits and labelled side-by-sides for reviewing screenshots of the work (screenshot-review skill).

    review_image.py crop <image> <x0> <y0> <x1> <y1> <out.png> [--scale 2]
    review_image.py panels <image> <n> <outdir>            # a strip of n equal-width panels, one file each
    review_image.py compose <out.png> <title> <label=path> [<label=path> ...]

Needs Pillow (the project's .venv has it): run with .venv/bin/python -I.
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont


def _font(size):
    for path in ("/System/Library/Fonts/Helvetica.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def crop(src, x0, y0, x1, y1, out, scale=2.0):
    im = Image.open(src).convert("RGB")
    # clamped to the image: a region past its edge would otherwise come back padded with black
    x0, x1 = max(0, int(x0)), min(im.width, int(x1))
    y0, y1 = max(0, int(y0)), min(im.height, int(y1))
    im = im.crop((x0, y0, x1, y1))
    if scale != 1:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    im.save(out)
    return out


def panels(src, n, outdir):
    im = Image.open(src).convert("RGB")
    os.makedirs(outdir, exist_ok=True)
    w = im.width // n
    outs = []
    for i in range(n):
        p = os.path.join(outdir, f"panel_{i + 1}.png")
        im.crop((i * w, 0, (i + 1) * w, im.height)).save(p)
        outs.append(p)
    return outs


def compose(out, title, items, height=520):
    """items: [(label, path)]; each scaled to `height`, numbered labels above, the title on top."""
    ims = []
    for _, p in items:
        im = Image.open(p).convert("RGB")
        ims.append(im.resize((max(1, int(im.width * height / im.height)), height), Image.LANCZOS))
    W = sum(i.width for i in ims) + 10 * (len(ims) - 1)
    canvas = Image.new("RGB", (W, height + 70), "white")
    d = ImageDraw.Draw(canvas)
    d.text((8, 6), title, fill="black", font=_font(19))
    x = 0
    for k, ((label, _), im) in enumerate(zip(items, ims), 1):
        d.text((x + 6, 38), f"{k}. {label}", fill="black", font=_font(15))
        canvas.paste(im, (x, 70))
        x += im.width + 10
    canvas.save(out)
    return out


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == "crop":
        scale = 2.0
        if "--scale" in argv:
            scale = float(argv[argv.index("--scale") + 1])
        print(crop(argv[2], *map(float, argv[3:7]), argv[7], scale))
    elif cmd == "panels":
        print("\n".join(panels(argv[2], int(argv[3]), argv[4])))
    elif cmd == "compose":
        items = [tuple(a.split("=", 1)) for a in argv[4:]]
        print(compose(argv[2], argv[3], items))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

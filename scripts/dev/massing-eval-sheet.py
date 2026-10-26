# ********************************************************************************
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
#
# This software and associated documentation files are proprietary and confidential
# to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
# of this file, via any medium, is strictly prohibited without explicit written
# permission from Scratchbox LLC.
# ********************************************************************************
"""Massing evaluation, step 4 (dev tool): each case's render sheet labelled with its numbers, and one summary table,
as <out>/<n>_labelled.png and <out>/summary.md.

    .venv/bin/python -I scripts/dev/massing-eval-sheet.py <out-dir>
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont


def font(size):
    for p in ("/System/Library/Fonts/Helvetica.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def main(out):
    report = json.load(open(os.path.join(out, "report.json")))
    lines = ["| # | Structure | Chosen | Coverage | Precision | Roof objects | Note |", "|---|---|---|---|---|---|---|"]
    for row in report:
        cand = {c["label"]: c for c in row.get("candidates", [])}
        ch = cand.get(row.get("chosen"), {})
        roof = row.get("roof", {})
        note = row.get("error") or ("" if row.get("explains") else "no candidate explains the scan")
        lines.append(f"| {row['n']} | {row['place']} | {row.get('chosen', '-')} | {ch.get('coverage', 0):.2f} | {ch.get('precision', 0):.2f} | "
                     f"{roof.get('objects', 0)} {roof.get('kinds', '')} | {note} |")
        sheet = os.path.join(out, f"{row['n']}_sheet.png")
        if not os.path.exists(sheet):
            continue
        im = Image.open(sheet).convert("RGB")
        canvas = Image.new("RGB", (im.width + 300, im.height + 50), "white")
        canvas.paste(im, (300, 50))
        d = ImageDraw.Draw(canvas)
        d.text((8, 8), f"{row['n']}. {row['place']}", fill="black", font=font(19))
        d.text((8, 60), "Top: the isolated scan", fill="black", font=font(15))
        d.text((8, 50 + im.height // 2 + 10), f"Bottom: chosen - {row.get('chosen')}", fill="black", font=font(15))
        y = 100
        for c in row.get("candidates", []):
            d.text((8, y), f"{c['label']}: cov {c['coverage']:.2f} prec {c['precision']:.2f}{'  <- chosen' if c['label'] == row.get('chosen') else ''}", fill="black", font=font(13))
            y += 20
        if roof:
            d.text((8, y + 10), f"roof objects: {roof.get('objects')} (tallest +{roof.get('tallest')} m)", fill="black", font=font(13))
            for k, v in roof.get("kinds", {}).items():
                y += 18
                d.text((16, y + 10), f"{v} x {k}", fill="black", font=font(13))
        canvas.save(os.path.join(out, f"{row['n']}_labelled.png"))
    open(os.path.join(out, "summary.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main(sys.argv[1])

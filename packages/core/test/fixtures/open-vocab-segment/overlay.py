#!/usr/bin/env python3
"""Mask overlays for inspection: one panel per mask, side by side.

    python overlay.py <out.png> <image> <panels.json>

panels.json: [{"mask": "m.png", "title": "...", "positive": [[x, y]], "negative": [[x, y]], "box": [x0, y0, x1, y1],
               "gt": "gt.png"}]  (points / box normalised 0..1; gt draws the true outline in yellow)
"""
import json
import sys

import cv2
import numpy as np


def panel(img, spec):
    h, w = img.shape[:2]
    out = img.copy()
    mask = cv2.imread(spec["mask"], cv2.IMREAD_GRAYSCALE)
    if mask is not None:
        tint = out.copy()
        tint[mask > 127] = (0.45 * tint[mask > 127] + 0.55 * np.array([60, 60, 255])).astype(np.uint8)
        out = tint
        cs, _ = cv2.findContours((mask > 127).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(out, cs, -1, (0, 0, 255), 2)
    if spec.get("gt"):
        gt = cv2.imread(spec["gt"], cv2.IMREAD_GRAYSCALE)
        cs, _ = cv2.findContours((gt > 127).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(out, cs, -1, (0, 255, 255), 1)
    if spec.get("box"):
        x0, y0, x1, y1 = spec["box"]
        cv2.rectangle(out, (int(x0 * w), int(y0 * h)), (int(x1 * w), int(y1 * h)), (255, 200, 0), 2)
    r = max(4, w // 120)
    for (x, y) in spec.get("positive", []):
        cv2.circle(out, (int(x * w), int(y * h)), r, (0, 255, 0), -1)
        cv2.circle(out, (int(x * w), int(y * h)), r, (0, 0, 0), 1)
    for (x, y) in spec.get("negative", []):
        cv2.circle(out, (int(x * w), int(y * h)), r, (255, 0, 255), -1)
        cv2.circle(out, (int(x * w), int(y * h)), r, (0, 0, 0), 1)
    title = spec.get("title", "")
    if title:
        scale = max(0.5, w / 1100)
        cv2.rectangle(out, (0, 0), (w, int(30 * scale) + 8), (0, 0, 0), -1)
        cv2.putText(out, title, (8, int(24 * scale)), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), max(1, int(2 * scale)))
    return out


def main():
    out_path, image_path, panels_path = sys.argv[1:4]
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    specs = json.load(open(panels_path))
    panels = [panel(img, s) for s in specs]
    sheet = np.hstack(panels)
    if sheet.shape[1] > 3200:
        f = 3200 / sheet.shape[1]
        sheet = cv2.resize(sheet, (3200, int(sheet.shape[0] * f)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(out_path, sheet)


if __name__ == "__main__":
    main()

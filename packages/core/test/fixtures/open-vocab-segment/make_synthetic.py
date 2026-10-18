#!/usr/bin/env python3
"""Deterministic synthetic scenes with known masks for the open-vocabulary segmentation tests.

    python make_synthetic.py <out_dir>

Writes statue.png (a figure on a stepped plinth in front of a textured wall and foliage) with statue_gt.png;
touching.png (a pale urn standing against a pale crate, touching) with touching_gt_urn.png / touching_gt_crate.png;
moving_00.png .. moving_15.png (a rounded body with a mast moving right over a slowly panning textured background)
with moving_gt_00.png ..; and occluded.png (a pale panel half hidden behind a dark post) with occluded_gt.png.
Same numpy and OpenCV versions give the same pixels, so recorded vision answers for these images stay valid.
"""
import os
import sys

import cv2
import numpy as np


def texture(h, w, seed, base, amp, cell):
    rng = np.random.default_rng(seed)
    small = rng.integers(0, 255, (max(2, h // cell), max(2, w // cell), 3)).astype(np.float32)
    big = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    fine = rng.normal(0, 10, (h, w, 3)).astype(np.float32)
    return np.clip(np.array(base, np.float32) + (big - 127) * amp + fine, 0, 255).astype(np.uint8)


def stone(h, w, seed, base):
    return texture(h, w, seed, base, 0.12, 6)


def statue(out):
    H, W = 480, 640
    img = texture(H, W, 1, (95, 120, 85), 0.55, 10)
    # brick-ish wall band on the right
    img[:, 430:] = texture(H, W - 430, 2, (70, 90, 150), 0.35, 14)
    gt = np.zeros((H, W), np.uint8)
    cv2.rectangle(gt, (230, 400), (410, 460), 255, -1)       # plinth
    cv2.rectangle(gt, (250, 370), (390, 402), 255, -1)       # step
    cv2.ellipse(gt, (320, 270), (48, 105), 0, 0, 360, 255, -1)  # robed body
    cv2.circle(gt, (320, 145), 28, 255, -1)                   # head
    cv2.line(gt, (352, 230), (420, 150), 255, 16)             # raised arm
    cv2.circle(gt, (424, 140), 14, 255, -1)                   # hand / held object
    cv2.line(gt, (290, 240), (262, 330), 255, 14)             # lowered arm
    s = stone(H, W, 3, (196, 198, 203))
    img[gt > 0] = s[gt > 0]
    img = cv2.GaussianBlur(img, (3, 3), 0)
    cv2.imwrite(os.path.join(out, "statue.png"), img)
    cv2.imwrite(os.path.join(out, "statue_gt.png"), gt)


def touching(out):
    H, W = 420, 560
    img = texture(H, W, 4, (120, 110, 100), 0.45, 12)
    urn = np.zeros((H, W), np.uint8)
    cv2.ellipse(urn, (200, 250), (70, 95), 0, 0, 360, 255, -1)
    cv2.rectangle(urn, (175, 120), (225, 170), 255, -1)
    cv2.ellipse(urn, (200, 118), (42, 12), 0, 0, 360, 255, -1)
    crate = np.zeros((H, W), np.uint8)
    cv2.rectangle(crate, (268, 170), (430, 345), 255, -1)
    crate[urn > 0] = 0  # the urn stands in front where they meet
    img[urn > 0] = stone(H, W, 5, (205, 200, 190))[urn > 0]
    img[crate > 0] = stone(H, W, 6, (170, 180, 195))[crate > 0]
    for x in range(268, 431, 27):  # plank lines on the crate
        cv2.line(img, (x, 170), (x, 345), (140, 150, 165), 2)
    img[urn > 0] = stone(H, W, 5, (205, 200, 190))[urn > 0]
    img = cv2.GaussianBlur(img, (3, 3), 0)
    cv2.imwrite(os.path.join(out, "touching.png"), img)
    cv2.imwrite(os.path.join(out, "touching_gt_urn.png"), urn)
    cv2.imwrite(os.path.join(out, "touching_gt_crate.png"), crate)


def moving(out, n=16):
    H, W = 320, 480
    bg = texture(H, W + 80, 7, (110, 130, 120), 0.5, 9)
    body = stone(H, W, 8, (40, 60, 200))
    for i in range(n):
        pan = int(round(i * 2.5))
        img = bg[:, pan:pan + W].copy()
        cx = 110 + i * 15
        cy = 190 + int(round(6 * np.sin(i / 3.0)))
        s = 1.0 + 0.012 * i
        gt = np.zeros((H, W), np.uint8)
        cv2.ellipse(gt, (cx, cy), (int(62 * s), int(30 * s)), 0, 0, 360, 255, -1)
        cv2.rectangle(gt, (cx - int(30 * s), cy - int(52 * s)), (cx + int(18 * s), cy - int(20 * s)), 255, -1)
        cv2.line(gt, (cx + int(10 * s), cy - int(50 * s)), (cx + int(10 * s), cy - int(95 * s)), 255, 5)
        img[gt > 0] = body[gt > 0]
        img = cv2.GaussianBlur(img, (3, 3), 0)
        cv2.imwrite(os.path.join(out, f"moving_{i:02d}.png"), img)
        cv2.imwrite(os.path.join(out, f"moving_gt_{i:02d}.png"), gt)


def occluded(out):
    H, W = 400, 600
    img = texture(H, W, 9, (100, 125, 95), 0.5, 11)
    panel = np.zeros((H, W), np.uint8)
    cv2.rectangle(panel, (170, 110), (430, 300), 255, -1)
    post = np.zeros((H, W), np.uint8)
    cv2.rectangle(post, (280, 0), (318, H), 255, -1)
    panel[post > 0] = 0
    img[panel > 0] = stone(H, W, 10, (215, 205, 175))[panel > 0]
    img[post > 0] = stone(H, W, 11, (45, 45, 50))[post > 0]
    img = cv2.GaussianBlur(img, (3, 3), 0)
    cv2.imwrite(os.path.join(out, "occluded.png"), img)
    cv2.imwrite(os.path.join(out, "occluded_gt.png"), panel)


if __name__ == "__main__":
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    statue(out)
    touching(out)
    moving(out)
    occluded(out)
    print("ok")

#!/usr/bin/env python3
"""
How closely a generated video follows the source clip's camera: at sampled frames the two are matched (LoFTR,
fundamental-matrix gating) and the median offset of matched features is reported at source resolution; frames
with too few surviving matches are reported as unmeasured. Also counts hard cuts (scene score > 0.3).
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

import cv2
import numpy as np

import register_lib as rl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True)
    ap.add_argument('--frames', required=True, help='source frames dir (0001.jpg ...)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--every', type=int, default=12)
    ap.add_argument('--min-matches', type=int, default=25)
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.video)
    video = []
    while True:
        ok, img = cap.read()
        if not ok:
            break
        video.append(img)
    src0 = cv2.imread(str(Path(args.frames) / '0001.jpg'))
    to_src = src0.shape[1] / 960.0
    samples = sorted(set(list(range(1, len(video) + 1, args.every)) + [len(video)]))
    rows = []
    for f in samples:
        src = cv2.resize(cv2.imread(str(Path(args.frames) / f'{f:04d}.jpg')), (960, 540))
        gen = cv2.resize(video[f - 1], (960, 540))
        pf, pr, _ = rl.match(cv2.cvtColor(src, cv2.COLOR_BGR2RGB), cv2.cvtColor(gen, cv2.COLOR_BGR2RGB), min_conf=0.3)
        entry = {'frame': f, 'gatedMatches': 0, 'medianOffsetPx': None}
        if len(pf) >= 8:
            _, mask = cv2.findFundamentalMat(pf, pr, cv2.USAC_MAGSAC, 2.0, 0.999, 5000)
            keep = mask.ravel().astype(bool) if mask is not None else np.zeros(len(pf), bool)
            entry['gatedMatches'] = int(keep.sum())
            if keep.sum() >= args.min_matches:
                entry['medianOffsetPx'] = float(np.median(np.linalg.norm(pf[keep] - pr[keep], axis=1)) * to_src)
        rows.append(entry)
        print(json.dumps(entry), flush=True)

    probe = subprocess.run(['ffmpeg', '-v', 'info', '-i', args.video, '-vf', "select='gt(scene,0.3)',showinfo", '-an', '-f', 'null', '-'],
                           capture_output=True, text=True)
    cuts = [float(t) for t in re.findall(r'pts_time:([0-9.]+)', probe.stderr)]
    Path(args.out).write_text(json.dumps({
        'video': args.video, 'units': f'pixels at source resolution {src0.shape[1]}x{src0.shape[0]}',
        'sceneCutsAt': cuts, 'frames': rows
    }, indent=1))
    print(f'{len(cuts)} scene cut(s); written {args.out}')


if __name__ == '__main__':
    main()

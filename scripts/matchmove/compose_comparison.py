#!/usr/bin/env python3
"""
Side-by-side comparison video from several frame-synchronised sources, each labelled.

  compose_comparison.py --out cmp.mp4 --panel "Source clip" frames/%04d.jpg --panel "Omni" omni.mp4 [--audio omni.mp4]

A panel is a video file or a printf-style frame pattern (1-based). Panels are scaled to --height and stacked
horizontally; the shortest source sets the length. Audio is copied from --audio when given.
"""
import argparse
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np


class Source:
    def __init__(self, spec):
        self.pattern = spec if '%' in spec else None
        self.cap = None if self.pattern else cv2.VideoCapture(spec)
        self.index = 0

    def read(self):
        self.index += 1
        if self.pattern:
            img = cv2.imread(self.pattern % self.index)
            return img
        ok, img = self.cap.read()
        return img if ok else None


def label(img, text):
    (tw, th), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)
    cv2.rectangle(img, (10, 10), (22 + tw, 22 + th + base), (0, 0, 0), -1)
    cv2.putText(img, text, (16, 16 + th), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--panel', nargs=2, action='append', metavar=('LABEL', 'SOURCE'), required=True)
    ap.add_argument('--height', type=int, default=360)
    ap.add_argument('--fps', type=int, default=24)
    ap.add_argument('--audio')
    args = ap.parse_args()

    sources = [(text, Source(spec)) for text, spec in args.panel]
    with tempfile.TemporaryDirectory() as tmp:
        n = 0
        while True:
            panels = []
            for text, src in sources:
                img = src.read()
                if img is None:
                    break
                img = cv2.resize(img, (int(round(img.shape[1] * args.height / img.shape[0] / 2) * 2), args.height), interpolation=cv2.INTER_AREA)
                label(img, text)
                panels.append(img)
            if len(panels) < len(sources):
                break
            n += 1
            cv2.imwrite(str(Path(tmp) / f'{n:05d}.png'), np.hstack(panels))
        cmd = ['ffmpeg', '-v', 'error', '-y', '-framerate', str(args.fps), '-i', str(Path(tmp) / '%05d.png')]
        if args.audio:
            cmd += ['-i', args.audio, '-map', '0:v', '-map', '1:a?', '-c:a', 'aac', '-shortest']
        cmd += ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', args.out]
        subprocess.run(cmd, check=True)
    print(f'{n} frames -> {args.out}')


if __name__ == '__main__':
    main()

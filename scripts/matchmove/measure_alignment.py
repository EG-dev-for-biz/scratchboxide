#!/usr/bin/env python3
"""
Measures how well a camera path reproduces the plate: at sampled frames the tiles are rendered from the
solved pose, matched against the undistorted plate (LoFTR, fundamental-matrix gating), and the remaining
matched features' image offsets are reported. Frames with too few surviving matches are reported as
unmeasured rather than scored. Exits non-zero when the gate fails.
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

import register_lib as rl
import tile_render as tr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--path', required=True, help='final camera path json')
    ap.add_argument('--frames', required=True)
    ap.add_argument('--glb', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--every', type=int, default=5)
    ap.add_argument('--work', type=int, nargs=2, default=[960, 540])
    ap.add_argument('--min-matches', type=int, default=25)
    ap.add_argument('--gate-median-px', type=float, default=8.0, help='at plate resolution')
    ap.add_argument('--gate-worst-px', type=float, default=24.0, help='at plate resolution')
    ap.add_argument('--overlays', type=int, nargs='*', default=[1, 60, 100, 120, 160, 220])
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    path = json.loads(Path(args.path).read_text())
    lens = path['plate']['lens']
    cam = {'params': [lens['focalPx'], lens['cx'], lens['cy'], lens['k1']], 'width': path['plate']['width'], 'height': path['plate']['height']}
    W, H = args.work
    K, dist = rl.intrinsics_matrix(cam, W, H)
    vfov = np.degrees(2 * np.arctan((H / 2) / K[1, 1]))
    to_plate = cam['width'] / W
    frames = {f['frame']: f for f in path['frames']}

    rows = []
    for fr in sorted(frames):
        if (fr - 1) % args.every and fr not in args.overlays:
            continue
        f = frames[fr]
        C, Rt = np.array(f['center']), np.array(f['R'])
        r = tr.render(args.glb, C, C + Rt[2] * 20.0, -Rt[1], vfov, W, H, spp=4)
        plate = cv2.undistort(cv2.resize(cv2.imread(str(Path(args.frames) / f'{fr:04d}.jpg')), (W, H)), K, dist)
        pf, pr, _ = rl.match(cv2.cvtColor(plate, cv2.COLOR_BGR2RGB), r['color'], min_conf=0.3)
        entry = {'frame': fr, 'anchor': f.get('anchor'), 'heldOut': f.get('anchor') is None, 'matches': int(len(pf))}
        if len(pf) >= 8:
            F, mask = cv2.findFundamentalMat(pf, pr, cv2.USAC_MAGSAC, 2.0, 0.999, 5000)
            keep = mask.ravel().astype(bool) if mask is not None else np.zeros(len(pf), bool)
            entry['gatedMatches'] = int(keep.sum())
            if keep.sum() >= args.min_matches:
                d = np.linalg.norm(pf[keep] - pr[keep], axis=1) * to_plate
                entry.update({'medianOffsetPx': float(np.median(d)), 'p90OffsetPx': float(np.percentile(d, 90)), 'measured': True})
        entry.setdefault('measured', False)
        rows.append(entry)
        if fr in args.overlays:
            blend = cv2.addWeighted(plate, 0.5, r['color'][:, :, ::-1], 0.5, 0)
            cv2.imwrite(str(out / f'overlay_{fr:04d}.jpg'), np.hstack([plate, r['color'][:, :, ::-1], blend]))
        print(json.dumps(entry), flush=True)

    measured = [e for e in rows if e['measured']]
    med = [e['medianOffsetPx'] for e in measured]

    def group(entries):
        m = [e['medianOffsetPx'] for e in entries if e['measured']]
        return {'framesSampled': len(entries), 'framesMeasured': len(m),
                'medianOffsetPx': float(np.median(m)) if m else None,
                'worstFrameMedianOffsetPx': float(np.max(m)) if m else None}

    summary = {
        'framesSampled': len(rows), 'framesMeasured': len(measured),
        'unmeasuredFrames': [e['frame'] for e in rows if not e['measured']],
        'medianOffsetPx': float(np.median(med)) if med else None,
        'worstFrameMedianOffsetPx': float(np.max(med)) if med else None,
        'worstFrame': int(measured[int(np.argmax(med))]['frame']) if med else None,
        'heldOut': group([e for e in rows if e['heldOut']]),
        'anchorFrames': group([e for e in rows if not e['heldOut']]),
        'units': f"pixels at plate resolution {cam['width']}x{cam['height']}",
        'gate': {'medianPx': args.gate_median_px, 'worstPx': args.gate_worst_px},
    }
    summary['gatePassed'] = bool(med) and summary['medianOffsetPx'] <= args.gate_median_px and summary['worstFrameMedianOffsetPx'] <= args.gate_worst_px
    (out / 'alignment_metrics.json').write_text(json.dumps({'summary': summary, 'frames': rows}, indent=1))
    print(json.dumps(summary, indent=1))
    sys.exit(0 if summary['gatePassed'] else 2)


if __name__ == '__main__':
    main()

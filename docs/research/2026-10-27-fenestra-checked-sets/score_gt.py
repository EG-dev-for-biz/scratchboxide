"""Score fitted window masks against the hand-checked ground truth: pixel IoU in the crop, and window recall and precision."""
import json, sys
import numpy as np
from scipy import ndimage
def boxes_iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy; u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u else 0
for tag in sys.argv[1:]:
    for fid in (4, 17, 0):
        g = json.load(open(f'gt/gt_{fid}.json')); x0, x1, y0, y1 = g['crop']
        fm = np.load(f'out/{tag}_{fid}.npy')[y0:y1, x0:x1]
        gm = np.zeros_like(fm)
        for a, b, c, e in g['windows']: gm[b:e, a:c] = True
        iou = (fm & gm).sum() / max(1, (fm | gm).sum())
        lab, n = ndimage.label(fm)
        fb = [[sl[1].start, sl[0].start, sl[1].stop, sl[0].stop] for sl in ndimage.find_objects(lab)]
        # a ground-truth window is found when a fitted opening overlaps it by IoU >= 0.3 (or covers half of it: a bay holding windows)
        cover = lambda w, f: max(boxes_iou(w, f), ((min(w[2], f[2]) - max(w[0], f[0])) * (min(w[3], f[3]) - max(w[1], f[1])) / ((w[2] - w[0]) * (w[3] - w[1]))) if min(w[2], f[2]) > max(w[0], f[0]) and min(w[3], f[3]) > max(w[1], f[1]) else 0)
        found = sum(1 for w in g['windows'] if any(cover(w, f) >= 0.5 or boxes_iou(w, f) >= 0.3 for f in fb))
        good = sum(1 for f in fb if any(boxes_iou(w, f) >= 0.3 or cover(w, f) >= 0.5 for w in g['windows']))
        print(f'{tag} facade {fid}: pixel IoU {iou:.2f}  recall {found}/{len(g["windows"])}  precision {good}/{len(fb)}')

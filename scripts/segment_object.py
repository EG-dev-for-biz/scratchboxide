#!/usr/bin/env python3
"""Prompted object segmentation for one frame — vfx_segment_subject's open-vocabulary path.

Reads one JSON request on stdin and writes a binary mask PNG (255 = the object, 0 = everything else) and a soft
matte PNG (0..255). The mask comes from the MediaPipe Interactive Segmenter (MagicTouch,
assets/models/magic_touch.tflite) run once per prompt point:

  * the masks of the positive points are united, the masks of the negative points are taken away wherever a negative
    point's mask is more confident than the positive union, and only the connected parts that hold a positive point
    are kept;
  * with a box the segmenter runs on a crop around the box (so a small object is seen at a usable resolution) and the
    mask is held to the box plus a margin;
  * with ``propagateFrom`` (the previous frame and its mask) the prompts are made here: the previous mask is carried
    into this frame by the object's matched scale and translation (masked template matching), its interior points (distance-transform maximum, then the
    points farthest from those already chosen) become the positive points, points on a ring just outside it become
    negative points, and the mask is held near the carried one;
  * with ``refine`` the mask is refined by OpenCV GrabCut seeded from it (an eroded core as definite object, the edge
    band as probable object / probable background, the prompt points as definite object / background).

The script never stands in for a prompt it could not use: a positive point whose own mask does not contain it is
dropped and reported, and when no positive point yields a mask the answer is a failure (``code: empty_mask``).
Nothing here knows what kind of thing is being cut out; the prompts carry all of that.

Request (stdin):
    {"image": "frame.png", "outMask": "mask.png", "outMatte": "matte.png",
     "positive": [[x, y], ...], "negative": [[x, y], ...], "box": [x0, y0, x1, y1],    # all normalised 0..1
     "refine": true, "propagateFrom": {"image": "prev.png", "mask": "prev_mask.png"}, "modelPath": "...",
     "compareMask": "other_mask.png"}                      # answers iouWithCompare

Answer (stdout, one JSON line):
    {"success": true, "width": W, "height": H, "areaFraction": f, "centroid": [x, y], "bbox": [x0, y0, x1, y1],
     "components": n, "positiveUsed": [...], "positiveDropped": [...], "negativeUsed": [...], "seeds": {...},
     "refinement": "grabcut" | "none", "matte": "...", "model": "...", "timingsMs": {...}}
    On error: {"success": false, "code": "...", "error": "..."} and a non-zero exit code.
"""

import json
import os
import sys
import time

_SEGMENTERS = {}

DEFAULT_MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "models", "magic_touch.tflite")
# A crop around a box keeps this much of the box's size as context on every side (and at least MIN_CROP_PAD_PX).
CROP_PAD_FRACTION = 0.35
MIN_CROP_PAD_PX = 24
# The mask is held to the box grown by this fraction of its size on every side.
BOX_HOLD_MARGIN = 0.04
# With propagation the mask is held to the carried mask grown by this fraction of its bounding-box diagonal, and
# negative points are placed on a ring this far outside it (so what touches the object is pushed back every frame).
PROPAGATION_HOLD_FRACTION = 0.04
PROPAGATION_RING_FRACTION = 0.07
PROPAGATION_RING_POINTS = 6
CONFIDENCE = 0.5
# Scales tried when matching the object between frames (approach / recede).
MOTION_SCALES = (0.95, 1.0, 1.05)


class SegmentFailure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message, exit_code=4):
    print(json.dumps({"success": False, "code": code, "error": message}))
    sys.exit(exit_code)


def main() -> None:
    try:
        import cv2  # type: ignore  # noqa: F401
        import numpy as np  # type: ignore  # noqa: F401
    except ImportError as e:
        fail("missing_dependency", f"Missing dependency: {e}. Install: pip install opencv-python-headless numpy", 1)
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        fail("bad_request", f"the request on stdin is not JSON: {e}", 1)
    try:
        answer = segment(request)
    except SegmentFailure as e:
        fail(e.code, str(e))
    print(json.dumps(answer))


def _segmenter(model_path):
    seg = _SEGMENTERS.get(model_path)
    if seg is None:
        from mediapipe.tasks import python as mp_python  # type: ignore
        from mediapipe.tasks.python import vision  # type: ignore
        opts = vision.InteractiveSegmenterLegacyOptions(
            base_options=mp_python.BaseOptions(model_asset_path=model_path),
            output_category_mask=False,
            output_confidence_masks=True,
        )
        seg = vision.InteractiveSegmenterLegacy.create_from_options(opts)
        _SEGMENTERS[model_path] = seg
    return seg


def _confidence_at(seg, rgb, x, y):
    """MagicTouch confidence map (float32 HxW) for one keypoint given in pixels of ``rgb``."""
    import mediapipe as mp  # type: ignore
    import numpy as np  # type: ignore
    from mediapipe.tasks.python import vision  # type: ignore
    from mediapipe.tasks.python.components.containers import keypoint  # type: ignore
    h, w = rgb.shape[:2]
    roi_cls = vision.InteractiveSegmenterLegacyRegionOfInterest
    roi = roi_cls(format=roi_cls.Format.KEYPOINT,
                  keypoint=keypoint.NormalizedKeypoint(float(np.clip((x + 0.5) / w, 0, 1)), float(np.clip((y + 0.5) / h, 0, 1))))
    result = seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), roi)
    if not result.confidence_masks:
        raise SegmentFailure("model_failed", "the interactive segmenter returned no confidence mask")
    conf = result.confidence_masks[0].numpy_view()
    if conf.ndim == 3:
        conf = conf[:, :, 0]
    return conf.astype(np.float32)


def _points_px(points, w, h, name):
    out = []
    for p in points or []:
        if not (isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(v, (int, float)) for v in p)):
            raise SegmentFailure("bad_request", f"{name} point {p!r} is not [x, y]")
        x, y = float(p[0]), float(p[1])
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            raise SegmentFailure("bad_request", f"{name} point {p!r} is outside the normalised 0..1 range")
        out.append((min(w - 1, int(x * w)), min(h - 1, int(y * h))))
    return out


def _box_px(box, w, h):
    if box is None:
        return None
    if not (isinstance(box, (list, tuple)) and len(box) == 4):
        raise SegmentFailure("bad_request", f"box {box!r} is not [x0, y0, x1, y1]")
    x0, y0, x1, y1 = [float(v) for v in box]
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise SegmentFailure("bad_request", f"box {box!r} is not an ordered box inside 0..1")
    return (int(x0 * w), int(y0 * h), max(int(x0 * w) + 1, int(round(x1 * w))), max(int(y0 * h) + 1, int(round(y1 * h))))


def _grow(box, frac, min_px, w, h):
    x0, y0, x1, y1 = box
    px = max(min_px, int((x1 - x0) * frac))
    py = max(min_px, int((y1 - y0) * frac))
    return (max(0, x0 - px), max(0, y0 - py), min(w, x1 + px), min(h, y1 + py))


def _spread_interior_points(mask, count):
    """Interior points of a binary mask: the distance-transform maximum, then repeatedly the deep point farthest from those chosen."""
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    dt = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
    peak = float(dt.max())
    if peak <= 0:
        return []
    ys, xs = np.nonzero(dt >= max(1.0, 0.45 * peak))
    if len(xs) == 0:
        return []
    cand = np.stack([xs, ys], axis=1).astype(np.float32)
    first = np.unravel_index(int(np.argmax(dt)), dt.shape)
    chosen = [(int(first[1]), int(first[0]))]
    dmin = np.linalg.norm(cand - np.array(chosen[0], np.float32), axis=1)
    while len(chosen) < count:
        i = int(np.argmax(dmin))
        if dmin[i] < max(4.0, 0.5 * peak):
            break
        chosen.append((int(cand[i, 0]), int(cand[i, 1])))
        dmin = np.minimum(dmin, np.linalg.norm(cand - cand[i], axis=1))
    return chosen


def _ring_points(mask, radius, count, w, h):
    """Points spread along the outline of ``mask`` grown by ``radius`` px (inside the frame)."""
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    grown = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)))
    cs, _ = cv2.findContours((grown > 0).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        return []
    c = max(cs, key=len)[:, 0, :]
    pts = []
    for k in range(count):
        x, y = c[int(k * len(c) / count)]
        if 0 < x < w - 1 and 0 < y < h - 1:
            pts.append((int(x), int(y)))
    return pts


def _object_motion(prev_bgr, prev_mask, cur_bgr):
    """The object's whole-body motion between frames as a scale about its box centre and a translation: the previous
    frame's object pixels (plus a thin band of surround, so a uniform object still has edges to match) are scaled by
    each of MOTION_SCALES and matched over a search window in the current frame; the lowest mean squared difference wins.
    Dense optical flow is not used for this: inside a weakly textured object it follows the background instead."""
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    h, w = prev_mask.shape
    ys, xs = np.nonzero(prev_mask)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    bw, bh = x1 - x0, y1 - y0
    pad = max(3, int(0.04 * max(bw, bh)))
    tx0, ty0, tx1, ty1 = max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * pad + 1, 2 * pad + 1))
    best = None
    for s in MOTION_SCALES:
        templ = cv2.resize(prev_bgr[ty0:ty1, tx0:tx1], None, fx=s, fy=s, interpolation=cv2.INTER_LINEAR)
        weight = cv2.resize(cv2.dilate(prev_mask[ty0:ty1, tx0:tx1], k), (templ.shape[1], templ.shape[0]), interpolation=cv2.INTER_NEAREST)
        th, tw = templ.shape[:2]
        # where the scaled template's corner would sit with no motion (scaled about the box centre)
        cx, cy = (tx0 + tx1) / 2.0, (ty0 + ty1) / 2.0
        ox, oy = cx - tw / 2.0, cy - th / 2.0
        search = max(8, int(0.5 * max(bw, bh)))
        sx0, sy0 = max(0, int(ox) - search), max(0, int(oy) - search)
        sx1, sy1 = min(w, int(ox) + tw + search), min(h, int(oy) + th + search)
        region = cur_bgr[sy0:sy1, sx0:sx1]
        if region.shape[0] < th or region.shape[1] < tw or not weight.any():
            continue
        score = cv2.matchTemplate(region, templ, cv2.TM_SQDIFF, mask=cv2.merge([weight] * 3))
        mn, _, loc, _ = cv2.minMaxLoc(score)
        mean = mn / float((weight > 0).sum())
        if best is None or mean < best[0]:
            best = (mean, s, sx0 + loc[0] - ox, sy0 + loc[1] - oy, cx, cy)
    if best is None:
        return 1.0, 0.0, 0.0, (0.0, 0.0)
    _, s, dx, dy, cx, cy = best
    return s, float(dx), float(dy), (cx, cy)


def _carry_mask(prev_bgr, prev_mask, cur_bgr):
    """The previous mask carried into the current frame by the object's matched scale and translation."""
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    h, w = prev_mask.shape
    s, dx, dy, (cx, cy) = _object_motion(prev_bgr, prev_mask, cur_bgr)
    m = np.float32([[s, 0, (1 - s) * cx + dx], [0, s, (1 - s) * cy + dy]])
    carried = cv2.warpAffine(prev_mask, m, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)
    return (carried > 127).astype(np.uint8) * 255, (round(dx, 1), round(dy, 1), s)


def _components_with(mask, points):
    """Keeps the connected parts of ``mask`` that hold one of ``points``; returns (mask, number of parts kept)."""
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    n, labels = cv2.connectedComponents((mask > 0).astype(np.uint8), connectivity=8)
    keep = sorted({int(labels[y, x]) for (x, y) in points if labels[y, x] > 0})
    if not keep:
        return np.zeros_like(mask), 0
    return np.isin(labels, keep).astype(np.uint8) * 255, len(keep)


def _grabcut(bgr, mask, positives, negatives):
    """GrabCut seeded from ``mask``: eroded core definite object, edge band probable, prompt points definite."""
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    h, w = mask.shape
    ys, xs = np.nonzero(mask)
    area = len(xs)
    band = int(max(2, min(25, round(0.06 * np.sqrt(area)))))
    x0, x1 = max(0, xs.min() - 3 * band), min(w, xs.max() + 3 * band + 1)
    y0, y1 = max(0, ys.min() - 3 * band), min(h, ys.max() + 3 * band + 1)
    m = mask[y0:y1, x0:x1]
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * band + 1, 2 * band + 1))
    core = cv2.erode(m, k)
    outer = cv2.dilate(m, k)
    gc = np.full(m.shape, cv2.GC_BGD, np.uint8)
    gc[outer > 0] = cv2.GC_PR_BGD
    gc[m > 0] = cv2.GC_PR_FGD
    gc[core > 0] = cv2.GC_FGD
    r = max(2, band // 2)
    for (x, y) in negatives:
        if x0 <= x < x1 and y0 <= y < y1:
            cv2.circle(gc, (x - x0, y - y0), r, int(cv2.GC_BGD), -1)
    for (x, y) in positives:
        if x0 <= x < x1 and y0 <= y < y1:
            cv2.circle(gc, (x - x0, y - y0), r, int(cv2.GC_FGD), -1)
    if not (gc == cv2.GC_BGD).any() and not (gc == cv2.GC_PR_BGD).any():
        return mask, band
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(np.ascontiguousarray(bgr[y0:y1, x0:x1]), gc, None, bgd, fgd, 4, cv2.GC_INIT_WITH_MASK)
    out = np.zeros_like(mask)
    out[y0:y1, x0:x1] = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    return out, band


def segment(request):
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    t_all = time.time()
    timings = {}
    image_path = request.get("image")
    image_b64 = request.get("imageB64")
    out_mask = request.get("outMask")
    out_matte = request.get("outMatte")
    # returnMask: the mask comes back in the answer (a PNG, base64) and nothing is written; with imageB64 the image is
    # decoded from the bytes as given, in memory (a photo that must never be written, e.g. a Street View grounding image)
    return_mask = bool(request.get("returnMask"))
    if not (image_path or image_b64) or not (out_mask or return_mask):
        raise SegmentFailure("bad_request", "the request needs image (or imageB64) and outMask (or returnMask)")
    if image_b64:
        import base64
        bgr = cv2.imdecode(np.frombuffer(base64.b64decode(image_b64), np.uint8), cv2.IMREAD_COLOR)
    else:
        bgr = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SegmentFailure("bad_input", "could not decode the image bytes" if image_b64 else f"could not read the image {image_path}")
    h, w = bgr.shape[:2]
    model_path = os.path.abspath(request.get("modelPath") or DEFAULT_MODEL)
    if not os.path.exists(model_path):
        raise SegmentFailure("missing_model", f"the interactive segmenter model {model_path} does not exist")

    positives = _points_px(request.get("positive"), w, h, "positive")
    negatives = _points_px(request.get("negative"), w, h, "negative")
    box = _box_px(request.get("box"), w, h)
    seeds = {"source": "prompt"}
    hold = None

    prop = request.get("propagateFrom")
    if prop:
        t = time.time()
        prev_bgr = cv2.imread(prop.get("image", ""), cv2.IMREAD_COLOR)
        prev_mask = cv2.imread(prop.get("mask", ""), cv2.IMREAD_GRAYSCALE)
        if prev_bgr is None or prev_mask is None or prev_bgr.shape[:2] != (h, w) or prev_mask.shape[:2] != (h, w):
            raise SegmentFailure("bad_input", "propagateFrom needs the previous frame and its mask, both the size of this frame")
        if not prev_mask.any():
            raise SegmentFailure("bad_input", "propagateFrom's mask is empty")
        carried, shift = _carry_mask(prev_bgr, prev_mask, bgr)
        timings["flow"] = round((time.time() - t) * 1000, 1)
        if not carried.any():
            raise SegmentFailure("empty_mask", "the previous mask left the frame when carried by optical flow")
        if not positives:
            positives = _spread_interior_points(carried, 5)
        ys, xs = np.nonzero(carried)
        if box is None:
            box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        diag = float(np.hypot(xs.max() - xs.min(), ys.max() - ys.min()))
        r = max(3, int(PROPAGATION_HOLD_FRACTION * diag))
        hold = cv2.dilate(carried, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
        ring = max(r + 3, int(PROPAGATION_RING_FRACTION * diag))
        if not negatives:
            negatives = _ring_points(carried, ring, PROPAGATION_RING_POINTS, w, h)
        seeds = {"source": "propagation", "method": "masked template match (scale + translation)", "shiftPx": [shift[0], shift[1]], "scale": shift[2], "carriedAreaFraction": round(float(len(xs)) / (w * h), 6),
                 "holdRadiusPx": r, "negativeRingPx": ring}
    if not positives:
        if box is None:
            raise SegmentFailure("bad_request", "nothing to segment: no positive point, no box and nothing to propagate from")
        positives = [((box[0] + box[2]) // 2, (box[1] + box[3]) // 2)]
        seeds["positiveFromBoxCentre"] = True

    # Region the segmenter sees: a crop around the box, else the whole frame.
    crop = _grow(box, CROP_PAD_FRACTION, MIN_CROP_PAD_PX, w, h) if box else (0, 0, w, h)
    cx0, cy0, cx1, cy1 = crop
    rgb = np.ascontiguousarray(bgr[cy0:cy1, cx0:cx1, ::-1])
    seg = _segmenter(model_path)

    t = time.time()
    pos_used, pos_dropped = [], []
    fg = np.zeros((cy1 - cy0, cx1 - cx0), np.float32)
    for (x, y) in positives:
        if not (cx0 <= x < cx1 and cy0 <= y < cy1):
            pos_dropped.append({"point": [x / w, y / h], "reason": "outside the box crop"})
            continue
        conf = _confidence_at(seg, rgb, x - cx0, y - cy0)
        if conf[y - cy0, x - cx0] < CONFIDENCE:
            pos_dropped.append({"point": [x / w, y / h], "reason": "its own mask does not contain it"})
            continue
        fg = np.maximum(fg, conf)
        pos_used.append((x, y))
    neg = np.zeros_like(fg)
    neg_used = []
    for (x, y) in negatives:
        if not (cx0 <= x < cx1 and cy0 <= y < cy1):
            continue
        conf = _confidence_at(seg, rgb, x - cx0, y - cy0)
        neg = np.maximum(neg, conf)
        neg_used.append((x, y))
    timings["segmenter"] = round((time.time() - t) * 1000, 1)
    timings["segmenterCalls"] = len(pos_used) + len(pos_dropped) + len(neg_used)
    if not pos_used:
        raise SegmentFailure("empty_mask", "no positive point gave a mask that contains it: " + "; ".join(f"{d['point']} {d['reason']}" for d in pos_dropped))

    crop_mask = (fg >= CONFIDENCE) & ~((neg >= CONFIDENCE) & (neg > fg))
    mask = np.zeros((h, w), np.uint8)
    mask[cy0:cy1, cx0:cx1] = crop_mask.astype(np.uint8) * 255
    soft = np.zeros((h, w), np.float32)
    soft[cy0:cy1, cx0:cx1] = np.where(neg > fg, 0.0, fg)
    if box:
        hx0, hy0, hx1, hy1 = _grow(box, BOX_HOLD_MARGIN, 2, w, h)
        keep = np.zeros_like(mask)
        keep[hy0:hy1, hx0:hx1] = 255
        mask &= keep
    if hold is not None:
        mask &= hold
    # positives in a part the negatives took away are not anchors any more
    mask, components = _components_with(mask, pos_used)
    if components == 0:
        raise SegmentFailure("empty_mask", "the negative points took away every part that held a positive point")

    refinement = "none"
    band = None
    if request.get("refine"):
        t = time.time()
        refined, band = _grabcut(bgr, mask, pos_used, neg_used)
        if box:
            refined &= keep
        refined, comps = _components_with(refined, pos_used)
        timings["grabcut"] = round((time.time() - t) * 1000, 1)
        if comps > 0:
            mask, components, refinement = refined, comps, "grabcut"
        else:
            refinement = "grabcut-rejected (it removed every positive point)"

    if refinement == "grabcut":
        # soft edge of the refined mask: a 1 px-sigma blur of the binary mask
        matte = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), 1.0)
        matte_source = "grabcut mask with a 1 px Gaussian edge"
    else:
        # the segmenter's own confidence inside the kept parts (grown 2 px so the edge ramp stays)
        grown = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
        matte = np.where(grown > 0, soft, 0.0)
        matte = np.maximum(matte, (mask > 0) * CONFIDENCE)
        matte_source = "interactive segmenter confidence"

    mask_png = None
    if return_mask:
        import base64
        ok, png = cv2.imencode(".png", mask)
        if not ok:
            raise SegmentFailure("encode_failed", "could not encode the mask")
        mask_png = base64.b64encode(png.tobytes()).decode("ascii")
    if out_mask:
        os.makedirs(os.path.dirname(os.path.abspath(out_mask)), exist_ok=True)
        if not cv2.imwrite(out_mask, mask):
            raise SegmentFailure("write_failed", f"could not write {out_mask}")
    if out_matte and not cv2.imwrite(out_matte, np.clip(matte * 255.0 + 0.5, 0, 255).astype(np.uint8)):
        raise SegmentFailure("write_failed", f"could not write {out_matte}")

    compare = None
    if request.get("compareMask"):
        other = cv2.imread(request["compareMask"], cv2.IMREAD_GRAYSCALE)
        if other is not None and other.shape == mask.shape:
            a, b = mask > 127, other > 127
            union = int((a | b).sum())
            compare = round(float((a & b).sum()) / union, 5) if union else 1.0
    ys, xs = np.nonzero(mask)
    timings["total"] = round((time.time() - t_all) * 1000, 1)
    return {
        "success": True,
        "width": w,
        "height": h,
        "areaFraction": round(float(len(xs)) / (w * h), 6),
        "centroid": [round(float(xs.mean()) / w, 5), round(float(ys.mean()) / h, 5)],
        "bbox": [round(float(xs.min()) / w, 5), round(float(ys.min()) / h, 5), round(float(xs.max() + 1) / w, 5), round(float(ys.max() + 1) / h, 5)],
        "components": components,
        "positiveUsed": [[round(x / w, 5), round(y / h, 5)] for (x, y) in pos_used],
        "positiveDropped": pos_dropped,
        "negativeUsed": [[round(x / w, 5), round(y / h, 5)] for (x, y) in neg_used],
        "crop": [cx0 / w, cy0 / h, cx1 / w, cy1 / h],
        "seeds": seeds,
        "refinement": refinement,
        **({"grabcutBandPx": band} if band is not None else {}),
        "matte": matte_source,
        "model": f"mediapipe-interactive-segmenter-legacy ({os.path.basename(model_path)})",
        "timingsMs": timings,
        **({"iouWithCompare": compare} if compare is not None else {}),
        **({"maskPng": mask_png} if mask_png is not None else {}),
    }


if __name__ == "__main__":
    main()

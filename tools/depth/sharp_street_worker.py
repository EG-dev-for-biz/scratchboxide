#!/usr/bin/env python3
"""Street-level Gaussian splats from Street View views, scaled onto the scan (SharpStreetSplatService.ts).

Served by worker_host.py: main() reads one JSON request from stdin and prints one JSON line.

  {"op": "pano", "checkpoint": path, "outPath": path, "depthPath": path, "views": [
      {"name", "kind": "level" | "floor", "jpegBase64", "size", "focalPx", "hfovDeg",
       "eye": [x, y, z], "right": [..], "up": [..], "fwd": [..], "depthOffset": floats into depthPath, "photoDepth"?}]}
      One panorama. Each view is a square photo (kept in memory, never written) and the scan's depth along the view axis
      at the same registered camera (size x size float32 at depthOffset in depthPath, >= 1e8 where the scan is empty). A
      level view may carry "photoDepth": {"offset", "width", "height"}: the photo's own depth (Depth Anything 3, at the
      model's scale, float32 in depthPath).
      SHARP predicts one Gaussian per pixel in the view's own frame at an arbitrary scale. A level view is scaled to the
      photo's depth, which one factor per view brings to metres: the median scan / photo depth where the two agree with
      the street's height under the eye (so what the scan never held has no say), else that ground-height scale. Without
      photo depth the scan's own depth is the reference, read only where it agrees with SHARP's ground height. The scale
      is one smooth curve against depth (48 depth bins by 6 across, smoothed nearly flat sideways). The floor view is
      scaled to the scan per image cell. Only splats over the scan (the sky goes) and within 30 m of the panorama's own
      eye are kept: past that the world's base layer stands. Level views keep their own quarter of the horizon and what
      the floor view does not cover, so one panorama's views do not double.
      Then the cleanup, each step counted in the view's measurements: a splat hanging between a near and a far surface
      of its own view (a streak at a depth edge) goes; a splat well behind the scan goes; a view under half of whose
      splats land within a tenth of the scan's depth keeps only those that do, and is dropped when that is under 15% of
      it; and only splats up to 7 m over the street are kept (the lowest storeys: above, the base layer's photographs on
      the scan stand, so every panorama stops at one level height). A panorama with fewer than two level views that fit
      the scan at all is left out, with the reason.

  {"op": "merge", "inputs": [{"path", "eye", "streetTopY"?}], "basePath": path | null, "outPath": path, "budget": n}
      The panoramas' splats as one world. A splat that stands in the free space another panorama saw through is dropped;
      where several panoramas cover a 1 m cell, the nearest one that covers it well keeps it; the base layer's splats
      (the survey's, from the tiles) are kept only where no street splat stands, and always above the nearest panorama's
      street top; then the street splats are thinned to the budget, the survivors widened to cover the same area.

Splat rows are 32 bytes: position 3 x f32, scale 3 x f32, RGBA u8, quaternion u8 (x, y, z, w as q * 127.5 + 127.5).
The SHARP weights are under Apple's research-only model licence; the output is generated content scaled to the scan.
"""
import base64
import io
import json
import sys
import time

import numpy as np

EMPTY = 1e8
ROW = np.dtype([("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("q", "u1", 4)])
_PREDICTOR = {}


def _predictor(checkpoint):
    """The SHARP predictor, loaded once per worker."""
    import torch
    from sharp.models import PredictorParams, create_predictor
    if checkpoint not in _PREDICTOR:
        dev = torch.device("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu")
        model = create_predictor(PredictorParams())
        model.load_state_dict(torch.load(checkpoint, weights_only=True, map_location="cpu"))
        _PREDICTOR.clear()
        _PREDICTOR[checkpoint] = (model.eval().to(dev), dev)
    return _PREDICTOR[checkpoint]


def _predict(model, dev, image, f_px):
    import torch
    import torch.nn.functional as F
    from sharp.utils.gaussians import unproject_gaussians
    side = 1536
    with torch.no_grad():
        pt = torch.from_numpy(image.copy()).float().to(dev).permute(2, 0, 1) / 255.0
        _, h, w = pt.shape
        disparity = torch.tensor([f_px / w]).float().to(dev)
        resized = F.interpolate(pt[None], size=(side, side), mode="bilinear", align_corners=True)
        ndc = model(resized, disparity)
        k = torch.tensor([[f_px, 0, w / 2, 0], [0, f_px, h / 2, 0], [0, 0, 1, 0], [0, 0, 0, 1]]).float().to(dev)
        k[0] *= side / w
        k[1] *= side / h
        g = unproject_gaussians(ndc, torch.eye(4).to(dev), k, (side, side))
        out = tuple(t[0].float().cpu().numpy() for t in (g.mean_vectors, g.singular_values, g.quaternions, g.colors, g.opacities))
    return out


def lin2srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def scale_field(a, b, log_ratio, na, nb, arange, brange, min_n=30, sigma=0.8):
    """Median of log_ratio per (a, b) cell, empty cells from the nearest, smoothed by sigma cells. Returns (lookup, share of cells filled)."""
    from scipy import ndimage
    ai = np.clip(((a - arange[0]) / (arange[1] - arange[0]) * na).astype(int), 0, na - 1)
    bi = np.clip(((b - brange[0]) / (brange[1] - brange[0]) * nb).astype(int), 0, nb - 1)
    cell = ai * nb + bi
    order = np.argsort(cell, kind="stable")
    cs, rs = cell[order], log_ratio[order]
    starts = np.flatnonzero(np.r_[True, cs[1:] != cs[:-1]]) if len(cs) else np.zeros(0, int)
    ends = np.r_[starts[1:], len(cs)]
    grid = np.zeros(na * nb, np.float32)
    valid = np.zeros(na * nb, bool)
    for s, e in zip(starts, ends):
        if e - s >= min_n:
            grid[cs[s]] = np.median(rs[s:e])
            valid[cs[s]] = True
    grid, valid = grid.reshape(na, nb), valid.reshape(na, nb)
    if not valid.any():
        return None, 0.0
    if not valid.all():
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        grid = grid[tuple(idx)]
    g = ndimage.gaussian_filter(grid, sigma, mode="nearest")

    def look(a2, b2):
        fa = np.clip((a2 - arange[0]) / (arange[1] - arange[0]) * na - 0.5, 0, na - 1)
        fb = np.clip((b2 - brange[0]) / (brange[1] - brange[0]) * nb - 0.5, 0, nb - 1)
        return ndimage.map_coordinates(g, [fa, fb], order=1, mode="nearest")
    return look, float(valid.mean())


def rotation_quaternion(r):
    """(w, x, y, z) of a rotation matrix."""
    tr = np.trace(r)
    if tr > 0:
        s = np.sqrt(tr + 1) * 2
        return np.array([s / 4, (r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s])
    i = int(np.argmax(np.diag(r)))
    j, k = (i + 1) % 3, (i + 2) % 3
    s = np.sqrt(1 + r[i, i] - r[j, j] - r[k, k]) * 2
    v = np.zeros(3)
    v[i] = s / 4
    v[j] = (r[j, i] + r[i, j]) / s
    v[k] = (r[k, i] + r[i, k]) / s
    return np.array([(r[k, j] - r[j, k]) / s, *v])


def rotate_quaternions(r, q):
    """The quaternions q (n x 4, w first) turned by the rotation matrix r."""
    w1, x1, y1, z1 = rotation_quaternion(r)
    w2, x2, y2, z2 = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    out = np.stack([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2], 1)
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)


# what a view keeps of its own frustum, degrees: a level view its quarter of the horizon (1 degree shared with the next)
# down to where the floor view takes over; the floor view a cone about straight down
LEVEL_HALF_KEEP_DEG = 46.0
LEVEL_MIN_ELEVATION_DEG = -42.0
FLOOR_HALF_KEEP_DEG = 49.0
# a panorama's splats are kept this far from its own eye, metres: past it a single photo's depth is a guess, and the
# world's base layer (from the tiles) stands instead
NEAR_RANGE_M = 30.0
# the street below a level view: looking at least this far under the horizon
GROUND_BELOW_DEG = -15.0
# scan and photo "agree" within this factor of the ground-height scale (photo depth as the reference; SHARP's own depth)
AGREE_FACTOR_PHOTO = 1.25
AGREE_FACTOR_SHARP = 1.5
MIN_AGREE = 2000
MIN_GROUND = 500
# the cleanup. A streak: per 1/768 of the view, a splat deeper than the nearest of its 3 x 3 neighbourhood and nearer
# than the farthest, each by this share (a real surface is at one end of its neighbourhood's depths, never between)
STREAK_GRID = 768
STREAK_JUMP = 0.12
# a splat this far behind the scan's surface is the photo's depth gone through a wall: 10% of the depth and half a metre
BEHIND_SHARE, BEHIND_M = 0.1, 0.5
# a view fits the scan where a splat lands within 10% of its depth (half a metre at least). Under FIT_GATE of a view
# fitting, only its fitting splats are kept; under FIT_KEEP_MIN of it surviving, the view is dropped
FIT_SHARE, FIT_FLOOR_M = 0.1, 0.5
FIT_GATE = 0.5
FIT_KEEP_MIN = 0.15
# a panorama needs this many level views fitting the scan at least this well, else it is left out
PANO_MIN_VIEWS, PANO_MIN_FIT = 2, 0.3
# SHARP's splats are kept up to this height over the street; above it the base layer stands
STREET_TOP_M = 7.0


def splat_layers(u, w):
    """
    SHARP's Gaussians come as layers over one pixel grid, in an order it does not state. Returns the index sets of the
    layers: two halves when the two halves trace the same pixels, alternate rows when neighbours do, else one set.
    """
    n = len(u)
    if n >= 4 and n % 2 == 0:
        h = n // 2
        if float(np.nanmedian(np.hypot(u[:h] - u[h:], w[:h] - w[h:]))) < 2.0:
            return [np.arange(h), np.arange(h, n)]
        if float(np.nanmedian(np.hypot(u[0::2] - u[1::2], w[0::2] - w[1::2]))) < 2.0:
            return [np.arange(0, n, 2), np.arange(1, n, 2)]
    return [np.arange(n)]


def streak_mask(u, w, zm, valid, n, grid=STREAK_GRID, jump=STREAK_JUMP):
    """
    True for a splat that hangs between a near and a far surface of its own view: deeper than the nearest splat of its
    3 x 3 neighbourhood of grid cells and nearer than the farthest, each by `jump`. u, w: image position in a view n
    pixels square; zm: depth along the view axis; valid: the splats that count as neighbours.
    """
    from scipy import ndimage
    out = np.zeros(len(zm), bool)
    for layer in splat_layers(u, w):
        idx = layer[valid[layer]]
        if not len(idx):
            continue
        cell = np.clip((w[idx] / n * grid).astype(int), 0, grid - 1) * grid + np.clip((u[idx] / n * grid).astype(int), 0, grid - 1)
        lo, hi = np.full(grid * grid, np.inf), np.zeros(grid * grid)
        np.minimum.at(lo, cell, zm[idx])
        np.maximum.at(hi, cell, zm[idx])
        near = ndimage.minimum_filter(lo.reshape(grid, grid), 3, mode="nearest").reshape(-1)[cell]
        far = ndimage.maximum_filter(hi.reshape(grid, grid), 3, mode="nearest").reshape(-1)[cell]
        out[idx] = (zm[idx] > (1 + jump) * near) & (zm[idx] < far / (1 + jump))
    return out


def ground_height(height_down, below):
    """The street's distance under the eye among samples looking down at it: the lowest surface, short of its outliers."""
    return float(np.percentile(height_down[below], 80)) if int(below.sum()) >= MIN_GROUND else None


def level_reference(zs, y, d, has, vang, photo, eye_height):
    """
    The depth a level view's splats are scaled to, per splat, and the samples the scale is fitted on.

    With the photo's own depth (`photo`, at the model's scale, 0 where it has none): that depth, brought to metres by one
    factor per view. The factor is the median scan / photo depth over the samples where the two agree with the scale the
    street's height under the eye gives (ground and walls: a car or a tree the scan never held, or holds elsewhere, does
    not agree and has no say); too few agreeing samples, and the ground-height scale itself stands.
    Without it: the scan's depth, fitted only on the samples that agree with SHARP's own ground-height scale.
    Returns (reference depth, fit mask, measurements, uniform log scale to use when the fit has too few samples).
    """
    below = vang < GROUND_BELOW_DEG
    if photo is not None:
        valid = has & np.isfinite(photo) & (photo > 1e-6)
        if not valid.any():
            return None, None, {"error": "the photo depth is empty over the scan"}, None
        q = np.where(valid, photo, 1.0)
        down = ground_height(q * y / zs, valid & below) if eye_height else None
        ground = eye_height / down if down and down > 1e-6 else None
        ratio = d[valid] / q[valid]
        centre = ground if ground else float(np.median(ratio))
        agree = np.abs(np.log(ratio / centre)) < np.log(AGREE_FACTOR_PHOTO)
        if int(agree.sum()) >= MIN_AGREE:
            k, source = float(np.median(ratio[agree])), "scan where it agrees with the photo"
        elif ground:
            k, source = ground, "ground height"
        else:
            k, source = float(np.median(ratio)), "scan median"
        info = {"reference": "photo depth", "scaleSource": source, "scanScale": round(k, 4), "agreeShare": round(float(agree.mean()), 3)}
        if ground:
            info["groundScale"] = round(ground, 4)
        return k * q, valid, info, None
    ratio = d / zs
    down = ground_height(y, has & below) if eye_height else None
    ground = eye_height / down if down and down > 1e-6 else None
    info = {"reference": "scan"}
    if not ground:
        return d, has, {**info, "scaleSource": "scan"}, None
    agree = has & (np.abs(np.log(np.maximum(ratio, 1e-9) / ground)) < np.log(AGREE_FACTOR_SHARP))
    info.update({"groundScale": round(ground, 4), "agreeShare": round(float(agree.sum() / max(1, has.sum())), 3)})
    if int(agree.sum()) >= MIN_AGREE:
        return d, agree, {**info, "scaleSource": "scan where it agrees with the ground height"}, float(np.log(ground))
    return d, np.zeros_like(has), {**info, "scaleSource": "ground height"}, float(np.log(ground))


def place_view(view, mean, sv, quat, col, op, depth, photo_depth=None, eye_height=None):
    """
    One view's SHARP Gaussians scaled and moved to the scan's frame. Returns (rows, measurements).

    depth: the scan's depth at the view's camera. photo_depth: the photo's own depth map (any size, the model's scale), for
    a level view. eye_height: the eye's height over the scan's street, metres.
    """
    n, f, half = int(view["size"]), float(view["focalPx"]), float(view["hfovDeg"]) / 2
    x, y, z = mean[:, 0], mean[:, 1], mean[:, 2]
    ok = (z > 0.2) & (op > 0.02) & np.isfinite(mean).all(1)
    zs = np.maximum(z, 1e-6)
    u, w = f * x / zs + n / 2, f * y / zs + n / 2
    ok &= (u >= 0) & (u < n) & (w >= 0) & (w < n)
    d = depth[np.clip(w.astype(int), 0, n - 1), np.clip(u.astype(int), 0, n - 1)]
    has = ok & (d < EMPTY)
    if not has.any():
        return None, {"name": view["name"], "error": "the scan is empty under this view"}
    hang = np.degrees(np.arctan2(x, z))
    vang = np.degrees(np.arctan2(-y, np.hypot(x, z)))
    info, uniform = {"reference": "scan", "scaleSource": "scan"}, None
    if view["kind"] == "level":
        photo = None
        if photo_depth is not None:
            ph, pw = photo_depth.shape
            photo = photo_depth[np.clip((w / n * ph).astype(int), 0, ph - 1), np.clip((u / n * pw).astype(int), 0, pw - 1)]
        ref, fit, info, uniform = level_reference(zs, y, d, has, vang, photo, eye_height)
        if ref is None:
            return None, {"name": view["name"], **info}
        log_ratio = np.log(np.maximum(ref, 1e-6) / zs)
        # one curve of scale against depth: 48 depth bins, 6 across the view, smoothed nearly flat sideways
        a, b = np.log(np.clip(z, 0.2, 400)), hang
        look, filled = scale_field(a[fit], b[fit], log_ratio[fit], 48, 6, (np.log(0.2), np.log(400)), (-half, half), sigma=(2.0, 1.5)) if fit.any() else (None, 0.0)
        keep = has & (np.abs(hang) <= min(half - 3, LEVEL_HALF_KEEP_DEG)) & (vang >= LEVEL_MIN_ELEVATION_DEG)
    else:
        ref, fit = d, has
        log_ratio = np.log(np.maximum(d, 1e-6) / zs)
        a, b = u, w
        look, filled = scale_field(a[fit], b[fit], log_ratio[fit], 20, 20, (0, n), (0, n))
        keep = has & (np.degrees(np.arctan2(np.hypot(x, y), z)) <= min(half - 1, FLOOR_HALF_KEEP_DEG))
    if look is None and uniform is None:
        return None, {"name": view["name"], "error": "too little of the scan under this view to set its scale"}
    s = (np.exp(look(a, b)) if look is not None else np.full(len(z), np.exp(uniform))).astype(np.float32)
    in_frustum = int(keep.sum())
    keep &= np.linalg.norm(mean, axis=1) * s <= NEAR_RANGE_M
    if not keep.any():
        return None, {"name": view["name"], "error": f"nothing of this view stands within {NEAR_RANGE_M:g} m over the scan"}
    r = np.stack([np.array(view["right"], float), -np.array(view["up"], float), np.array(view["fwd"], float)], 1)
    # the cleanup
    zm = z * s
    ranged = int(keep.sum())
    fit = float((np.abs(zm[keep] - d[keep]) < FIT_SHARE * d[keep]).mean())
    cleanup = {"fitBeforeCleanup": round(fit, 3)}
    streak = streak_mask(u, w, zm, ok, n)
    cleanup["streaks"] = int((keep & streak).sum())
    keep &= ~streak
    behind = zm > (1 + BEHIND_SHARE) * d + BEHIND_M
    cleanup["behindScan"] = int((keep & behind).sum())
    keep &= ~behind
    if fit < FIT_GATE:
        fits = np.abs(zm - d) <= np.maximum(FIT_FLOOR_M, FIT_SHARE * d)
        cleanup["gated"] = int((keep & ~fits).sum())
        keep &= fits
        if int(keep.sum()) < FIT_KEEP_MIN * ranged:
            return None, {"name": view["name"], **info, **cleanup,
                          "error": f"dropped: only {fit:.0%} of this view lands on the scan, and too little of it is left where it does"}
    if eye_height:
        top = float(view["eye"][1]) - eye_height + STREET_TOP_M
        above = (mean * s[:, None]) @ r[1] + float(view["eye"][1]) > top
        cleanup["aboveStreet"] = int((keep & above).sum())
        keep &= ~above
    else:
        cleanup["streetTop"] = "not applied: no street under the eye in the scan"
    if not keep.any():
        return None, {"name": view["name"], **info, **cleanup, "error": "nothing of this view is left after the cleanup"}
    resid = np.abs(zm[keep] - d[keep])
    rows = np.zeros(int(keep.sum()), ROW)
    rows["p"] = (mean[keep] * s[keep, None]) @ r.T + np.array(view["eye"], float)
    rows["s"] = sv[keep] * s[keep, None]
    rows["c"][:, :3] = np.clip(lin2srgb(col[keep]) * 255, 0, 255)
    rows["c"][:, 3] = np.clip(op[keep] * 255, 0, 255)
    rows["q"] = np.clip((rotate_quaternions(r, quat[keep])[:, [1, 2, 3, 0]] * 0.5 + 0.5) * 255, 0, 255)
    raw = d[has] / zs[has]
    return rows, {
        "name": view["name"], "predicted": int(len(mean)), "kept": int(keep.sum()), **info, **cleanup, "cellsFilled": round(filled, 3),
        "noScanShare": round(float((ok & ~has).sum() / max(1, ok.sum())), 3),
        "beyondRangeShare": round(1 - ranged / max(1, in_frustum), 3),
        "rawRatioP10": round(float(np.percentile(raw, 10)), 3), "rawRatioMedian": round(float(np.median(raw)), 3), "rawRatioP90": round(float(np.percentile(raw, 90)), 3),
        "residMedianM": round(float(np.median(resid)), 3), "residP90M": round(float(np.percentile(resid, 90)), 3),
        "within10pct": round(float((resid < 0.1 * d[keep]).mean()), 3),
    }


def eye_height_over_scan(job, all_depth):
    """The eye's height over the scan's street, from the middle of the floor view's scan depth; None without one."""
    for v in job["views"]:
        if v["kind"] != "floor":
            continue
        n = int(v["size"])
        depth = all_depth[int(v["depthOffset"]):int(v["depthOffset"]) + n * n].reshape(n, n)
        mid = depth[n * 2 // 5:n * 3 // 5, n * 2 // 5:n * 3 // 5]
        mid = mid[mid < EMPTY]
        return float(np.median(mid)) if len(mid) >= 100 else None
    return None


def run_pano(job):
    from PIL import Image
    t0 = time.time()
    model, dev = _predictor(job["checkpoint"])
    load_s = time.time() - t0
    all_depth = np.fromfile(job["depthPath"], np.float32)
    eye_height = eye_height_over_scan(job, all_depth)
    rows, views = [], []
    for v in job["views"]:
        t1 = time.time()
        n = int(v["size"])
        img = np.asarray(Image.open(io.BytesIO(base64.b64decode(v["jpegBase64"]))).convert("RGB"))
        mean, sv, quat, col, op = _predict(model, dev, img, float(v["focalPx"]))
        depth = all_depth[int(v["depthOffset"]):int(v["depthOffset"]) + n * n].reshape(n, n)
        photo = None
        if v.get("photoDepth"):
            p = v["photoDepth"]
            photo = all_depth[int(p["offset"]):int(p["offset"]) + int(p["width"]) * int(p["height"])].reshape(int(p["height"]), int(p["width"]))
        placed, report = place_view(v, mean, sv, quat, col, op.reshape(-1), depth, photo, eye_height)
        report["inferS"] = round(time.time() - t1, 1)
        views.append(report)
        if placed is not None:
            rows.append(placed)
    if not rows:
        print(json.dumps({"error": "no view of this panorama could be scaled onto the scan", "views": views}))
        return
    level = [r for v, r in zip(job["views"], views) if v["kind"] == "level"]
    fitting = sum(1 for r in level if r.get("fitBeforeCleanup", 0) >= PANO_MIN_FIT)
    if level and fitting < PANO_MIN_VIEWS:
        print(json.dumps({"error": f"left out: {fitting} of its {len(level)} level views land on the scan (at least {PANO_MIN_FIT:.0%} within a tenth of its depth)",
                          "leftOut": True, "views": views}))
        return
    out = np.concatenate(rows)
    out.tofile(job["outPath"])
    eye_y = float(job["views"][0]["eye"][1])
    print(json.dumps({"device": str(dev), "loadS": round(load_s, 1), "totalS": round(time.time() - t0, 1), "splats": int(len(out)),
                      **({"eyeHeightM": round(eye_height, 2), "streetTopY": round(eye_y - eye_height + STREET_TOP_M, 3)} if eye_height else {}),
                      "views": views}))


# ---- the merge ----

RANGE_BIN_DEG = 0.5
VOXEL_M = 1.0
BASE_VOXEL_M = 2.0


def range_map(points, eye):
    """What a panorama saw: per 0.5 degree direction, the near (10th percentile) range of its own splats; inf where it has none."""
    d = points - eye
    rng = np.linalg.norm(d, axis=1)
    nb_az, nb_el = int(360 / RANGE_BIN_DEG), int(180 / RANGE_BIN_DEG)
    b = direction_bins(d, rng)
    order = np.lexsort((rng, b))
    bs, rs = b[order], rng[order]
    starts = np.flatnonzero(np.r_[True, bs[1:] != bs[:-1]])
    ends = np.r_[starts[1:], len(bs)]
    grid = np.full(nb_az * nb_el, np.inf, np.float32)
    grid[bs[starts]] = rs[starts + ((ends - starts) * 0.1).astype(int)]
    grid = grid.reshape(nb_el, nb_az)
    # the nearest of each direction's neighbours: a splat is only "in free space" when it is nearer than all of them
    out = grid.copy()
    for de in (-1, 0, 1):
        shifted = grid if de == 0 else np.pad(grid, ((1, 1), (0, 0)), constant_values=np.inf)[1 + de:1 + de + nb_el]
        for da in (-1, 0, 1):
            out = np.minimum(out, np.roll(shifted, da, axis=1))
    return out


def direction_bins(d, rng):
    nb_az, nb_el = int(360 / RANGE_BIN_DEG), int(180 / RANGE_BIN_DEG)
    az = np.degrees(np.arctan2(d[:, 0], -d[:, 2])) % 360
    el = np.degrees(np.arcsin(np.clip(d[:, 1] / np.maximum(rng, 1e-9), -1, 1))) + 90
    return np.clip((el / RANGE_BIN_DEG).astype(np.int64), 0, nb_el - 1) * nb_az + np.clip((az / RANGE_BIN_DEG).astype(np.int64), 0, nb_az - 1)


def voxel_keys(points, size, origin):
    i = np.floor((points - origin) / size).astype(np.int64)
    return (i[:, 0] << 42) | (i[:, 1] << 21) | i[:, 2]


def voxel_centres(keys, size, origin):
    m = (1 << 21) - 1
    i = np.stack([keys >> 42, (keys >> 21) & m, keys & m], 1).astype(np.float64)
    return (i + 0.5) * size + origin


def free_space_keep(points, own, eyes, maps):
    """False for a splat that stands clearly in front of what another panorama saw in its direction."""
    keep = np.ones(len(points), bool)
    for j, (eye, grid) in enumerate(zip(eyes, maps)):
        other = np.flatnonzero(own != j)
        d = points[other] - eye
        rng = np.linalg.norm(d, axis=1)
        seen = grid.reshape(-1)[direction_bins(d, rng)]
        # a direction the panorama has no splat in (inf) says nothing about what stands there
        keep[other[np.isfinite(seen) & (rng < 0.8 * seen - 0.5)]] = False
    return keep


def ownership_keep(points, own, eyes, origin):
    """Per 1 m cell, the splats of the nearest panorama among those that cover the cell well (a fifth of the best count, 4 at least)."""
    n_p = len(eyes)
    pair = voxel_keys(points, VOXEL_M, origin) * n_p + own
    uq, inv, cnt = np.unique(pair, return_inverse=True, return_counts=True)
    vox, pid = uq // n_p, (uq % n_p).astype(int)
    starts = np.flatnonzero(np.r_[True, vox[1:] != vox[:-1]])
    group = np.cumsum(np.r_[True, vox[1:] != vox[:-1]]) - 1
    best = np.maximum.reduceat(cnt, starts)[group]
    dist = np.linalg.norm(voxel_centres(vox, VOXEL_M, origin) - np.array(eyes)[pid], axis=1)
    score = np.where(cnt >= np.maximum(4, 0.2 * best), dist, np.inf)
    order = np.lexsort((score, group))
    winner = np.zeros(len(uq), bool)
    winner[order[np.flatnonzero(np.r_[True, group[order][1:] != group[order][:-1]])]] = True
    return winner[inv]


def thin_to_budget(rows, budget, seed=7):
    """At most `budget` rows: the faintest go first, then an even random share, the survivors widened to cover the same area."""
    if len(rows) <= budget:
        return rows, 0
    before = len(rows)
    faint = rows["c"][:, 3] < 26
    if (~faint).sum() >= budget:
        rows = rows[~faint]
    if len(rows) > budget:
        share = budget / len(rows)
        rng = np.random.default_rng(seed)
        rows = rows[rng.random(len(rows)) < share]
        rows["s"] *= min(1.6, share ** -0.5)
    return rows, before - len(rows)


def cell_keep(points, own, eyes):
    """Hard cells: a splat stays only where its own panorama is the nearest one on the plan (x, z)."""
    flat = np.array(eyes)[:, [0, 2]]
    nearest = np.zeros(len(points), np.int64)
    best = np.full(len(points), np.inf)
    for j, e in enumerate(flat):
        d = ((points[:, [0, 2]] - e) ** 2).sum(1)
        closer = d < best
        nearest[closer], best[closer] = j, d[closer]
    return nearest == own


def merge_splats(sets, eyes, base, budget, tops=None, cells=False):
    """
    `cells`: each panorama keeps only the splats nearer to it than to any other panorama (one source per place, a clean
    cut between them), in place of the per-cell ownership.

    The merge on arrays: `sets` one row array per panorama, `base` the base layer's rows or None, `tops` each panorama's
    street top (the height its splats stop at; None where it has none). Returns (rows, counts).
    """
    own = np.concatenate([np.full(len(s), j, np.int64) for j, s in enumerate(sets)])
    rows = np.concatenate(sets)
    points = rows["p"].astype(np.float64)
    eyes = [np.array(e, float) for e in eyes]
    counts = {"predicted": int(len(rows))}
    if len(sets) > 1:
        maps = [range_map(points[own == j], eyes[j]) for j in range(len(sets))]
        keep = free_space_keep(points, own, eyes, maps)
        counts["inFreeSpace"] = int((~keep).sum())
        rows, points, own = rows[keep], points[keep], own[keep]
        origin = points.min(0) - 1.0
        keep = cell_keep(points, own, eyes) if cells else ownership_keep(points, own, eyes, origin)
        counts["outsideCell" if cells else "doubled"] = int((~keep).sum())
        counts.setdefault("doubled", 0)
        rows, points, own = rows[keep], points[keep], own[keep]
    else:
        counts["inFreeSpace"] = 0
        counts["doubled"] = 0
    rows, counts["thinned"] = thin_to_budget(rows, budget)
    counts["street"] = int(len(rows))
    counts["perPano"] = [int(c) for c in np.bincount(own, minlength=len(sets))]
    if base is not None and len(base):
        origin = np.minimum(rows["p"].min(0), base["p"].min(0)).astype(np.float64) - 1.0
        occupied, n = np.unique(voxel_keys(rows["p"].astype(np.float64), BASE_VOXEL_M, origin), return_counts=True)
        covered = np.isin(voxel_keys(base["p"].astype(np.float64), BASE_VOXEL_M, origin), occupied[n >= 20])
        if tops is not None and any(t is not None for t in tops):
            # above the nearest panorama's street top the base layer always stands: no street splat reaches there
            flat = np.array(eyes)[:, [0, 2]]
            nearest = np.argmin(((base["p"][:, None, [0, 2]].astype(np.float64) - flat[None]) ** 2).sum(2), axis=1) if len(eyes) > 1 else np.zeros(len(base), int)
            top = np.array([np.inf if t is None else float(t) for t in tops])[nearest]
            over = covered & (base["p"][:, 1] > top)
            counts["baseKeptAboveStreet"] = int(over.sum())
            covered &= ~over
        counts["baseKept"] = int((~covered).sum())
        counts["baseReplaced"] = int(covered.sum())
        rows = np.concatenate([base[~covered], rows])
    counts["splats"] = int(len(rows))
    return rows, counts


def run_merge(job):
    t0 = time.time()
    sets = [np.fromfile(i["path"], ROW) for i in job["inputs"]]
    base = np.fromfile(job["basePath"], ROW) if job.get("basePath") else None
    rows, counts = merge_splats(sets, [i["eye"] for i in job["inputs"]], base, int(job.get("budget") or 6_000_000),
                                [i.get("streetTopY") for i in job["inputs"]], bool(job.get("cells")))
    rows.tofile(job["outPath"])
    counts["totalS"] = round(time.time() - t0, 1)
    print(json.dumps(counts))


def main():
    job = json.loads(sys.stdin.read())
    if job.get("op") == "merge":
        run_merge(job)
    elif job.get("op") == "pano":
        run_pano(job)
    else:
        print(json.dumps({"error": f"unknown op {job.get('op')!r}"}))
        sys.exit(2)


if __name__ == "__main__":
    main()

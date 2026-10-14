# VFX Thinking Mode: Robust Geometric Tracking

> **When to load:** Any task involving tracking a rigid or semi-rigid object (card, product, screen, sign) through video frames for compositing — especially when the object is partially occluded, the AI-generated shape is imperfect, or standard corner-pin tracking produces jitter.

---

## The core idea

Direct corner tracking fails on AI-generated video because the rendered edges are soft, the shape varies frame-to-frame, and corners are frequently occluded. **Robust geometric tracking** treats the object as a geometric primitive (a rectangle) and derives corner positions analytically — from fitted edge lines rather than tracked corner pixels — using outlier-resistant estimation at every step.

Two-stage pipeline:
1. **RANSAC side fitting** — independently fit a line to each of the 4 object sides; corners are intersections of adjacent lines, not tracked points. Valid even when corners are under fingers or off-screen.
2. **ECC homography** against a single golden reference frame — texture-locks the track so it follows what's printed on the object, not the model's varying rendering of its silhouette.

---

## Stage 1: RANSAC side fitting

For each of the 4 sides of a rectangular object, sample sub-pixel outward crossings along normals perpendicular to the expected side orientation, then fit a line with RANSAC.

```python
import numpy as np

def ransac_line(points, n_iter=300, inlier_band=0.6, min_inliers=25):
    """Fit y = a + b*x to points via RANSAC. Returns (a, b) or None."""
    best_inliers = []
    pts = np.array(points)
    for _ in range(n_iter):
        idx = np.random.choice(len(pts), 2, replace=False)
        p1, p2 = pts[idx[0]], pts[idx[1]]
        if abs(p2[0] - p1[0]) < 1e-6:
            continue
        b = (p2[1] - p1[1]) / (p2[0] - p1[0])
        a = p1[1] - b * p1[0]
        residuals = np.abs(pts[:, 1] - (a + b * pts[:, 0]))
        inliers = np.where(residuals < inlier_band)[0]
        if len(inliers) > len(best_inliers):
            best_inliers = inliers
    if len(best_inliers) < min_inliers:
        return None
    sub = pts[best_inliers]
    b, a = np.polyfit(sub[:, 0], sub[:, 1], 1)
    return a, b

def line_intersect(a1, b1, a2, b2):
    """Intersect y = a1 + b1*x and y = a2 + b2*x."""
    if abs(b1 - b2) < 1e-9:
        return None  # parallel
    x = (a2 - a1) / (b1 - b2)
    return x, a1 + b1 * x
```

### Key parameters

| Parameter | Value | Rationale |
|---|---|---|
| RANSAC iterations | 300 | Enough for 4-inlier consensus on noisy edges |
| Inlier band | 0.6 px | Sub-pixel precision; looser causes smear |
| Min inliers | 25 | Rejects degenerate fits on occluded sides |
| Skip corners | inner 8%–92% | Avoids rounded-corner contamination |

---

## Stage 2: ECC homography against a golden reference frame

RANSAC gives you corners, but on AI-generated video the rendered silhouette drifts slightly frame-to-frame. ECC (Enhanced Correlation Coefficient) locks the track to the **texture** of the object rather than its rendered edge — the texture is stable even when the silhouette is not.

```python
import cv2

def ecc_track(frames_gray, ref_idx, initial_quads, card_mask_fn):
    """
    For each frame, find the homography H mapping it to f_ref via ECC,
    initialized from the RANSAC quad.
    Returns: per-frame homographies H[i]
    """
    ref = frames_gray[ref_idx]
    H_all = {}

    for i, frame in enumerate(frames_gray):
        src_pts = initial_quads[i].astype(np.float32)
        dst_pts = initial_quads[ref_idx].astype(np.float32)
        H0, _ = cv2.findHomography(src_pts, dst_pts)
        if H0 is None:
            H0 = np.eye(3, dtype=np.float32)

        H = H0.astype(np.float64)
        mask = card_mask_fn(frame, i)
        try:
            cc, H = cv2.findTransformECCWithMask(
                ref, frame, H.astype(np.float32), mask,
                cv2.MOTION_HOMOGRAPHY,
                (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-7),
                gaussFiltSize=3
            )
            H_all[i] = (H, cc)
        except cv2.error:
            H_all[i] = (H0.astype(np.float32), 0.0)

    return H_all
```

### Building the canonical silhouette from ECC

Once you have all homographies, map every frame's silhouette into `f_ref` space and take the median — this gives a single canonical shape free of per-frame rendering noise:

```python
def canonical_silhouette(quads, H_all, ref_idx):
    """Map all quads to ref space, take median corners."""
    mapped = []
    for i, quad in enumerate(quads):
        H, _ = H_all[i]
        q_hom = np.concatenate([quad, np.ones((4,1))], axis=1).T
        q_ref = H @ q_hom
        q_ref = (q_ref[:2] / q_ref[2]).T
        mapped.append(q_ref)
    return np.median(np.stack(mapped, axis=0), axis=0)
```

### ECC mask rules

The ECC mask should exclude:
- Skin pixels (dilated by 13 px to account for soft edges)
- The outer 3% of the card silhouette (edge pixels are rendered differently frame-to-frame)
- Any non-card foreground

### ECC quality metric

`cc` (correlation coefficient, 0–1) is the per-frame track quality score. Frames with `cc < 0.7` warrant manual inspection.

---

## When to use which stage

| Situation | Use |
|---|---|
| Object is rigid, fully visible, clean edges | RANSAC alone may be sufficient |
| Object is partially occluded (fingers over corners) | RANSAC side fitting (corners derived, not tracked) |
| AI-generated source with drifting silhouette | RANSAC → ECC (texture locks the track) |
| Spin/flip phase with non-rigid AI shape | Rigid PnP pose fitting (see `vfx-motion-decomposition`) |
| Upscaled or rerendered plates | Phase correlation QA after tracking |

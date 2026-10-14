# VFX Thinking Mode: Multi-Scale Motion Decomposition

> **When to load:** Any task where a tracked object's motion contains a mix of global rigid movement, local non-rigid shape variation, and slow low-frequency drift — and naive smoothing either over-smooths (losing real motion) or under-smooths (preserving jitter). Also load for spin/flip shots where the AI source is geometrically non-rigid.

---

## The core idea

A tracked object in video has motion at multiple scales that should be treated independently:

| Component | Time scale | What it is | How to treat it |
|---|---|---|---|
| **Similarity motion** | Every frame | Translation, rotation, uniform scale — the whole-body shake | Keep at full rate (no smoothing) |
| **Non-rigid shape** | Medium (10–30 frames) | Variation in the object's outline beyond rigid motion | Smooth with SG31–SG41 |
| **Drift** | Slow (40+ frames) | Gradual systematic creep of the AI silhouette relative to its texture | Low-pass filter at SG41 |

Smoothing everything together either removes real camera shake (makes the comp feel floaty) or preserves AI shape noise (makes the replacement jitter independently of the background).

---

## Step 1: Similarity decomposition

```python
import numpy as np

def similarity_split(quads):
    """
    Decompose a list of (4,2) quads into:
      - rigid: (N, 4) array of [tx, ty, angle_rad, log_scale]
      - shape: (N, 4, 2) residuals after removing rigid component
    """
    center = quads.mean(axis=1, keepdims=True)
    centered = quads - center
    mean_shape = centered.mean(axis=0)

    rigid = []
    shape_residuals = []

    for i in range(len(quads)):
        q = centered[i]
        H = mean_shape.T @ q
        U, S, Vt = np.linalg.svd(H)
        R = Vt.T @ U.T
        if np.linalg.det(R) < 0:
            Vt[-1, :] *= -1
            R = Vt.T @ U.T
        scale = S.sum() / (mean_shape * mean_shape).sum()
        angle = np.arctan2(R[1, 0], R[0, 0])
        tx, ty = center[i, 0]
        rigid.append([tx, ty, angle, np.log(max(scale, 1e-6))])
        reconstructed = (scale * (mean_shape @ R.T))
        shape_residuals.append(q - reconstructed)

    return np.array(rigid), np.array(shape_residuals)


def similarity_join(rigid, shape, mean_shape=None):
    """Reconstruct quads from rigid components + shape residuals."""
    quads = []
    for i in range(len(rigid)):
        tx, ty, angle, log_scale = rigid[i]
        scale = np.exp(log_scale)
        R = np.array([[np.cos(angle), -np.sin(angle)],
                      [np.sin(angle),  np.cos(angle)]])
        base = mean_shape if mean_shape is not None else np.zeros((4, 2))
        reconstructed = scale * (base @ R.T) + shape[i]
        quads.append(reconstructed + np.array([[tx, ty]]))
    return np.array(quads)
```

---

## Step 2: Smooth each component at its natural frequency

```python
from scipy.signal import savgol_filter

def smooth_track(quads, shape_win=31, drift_win=41):
    """Full pipeline: quads → decompose → smooth → reconstruct."""
    rigid, shape = similarity_split(quads)
    rigid_smooth = rigid.copy()
    shape_smooth = savgol_filter(shape, window_length=shape_win, polyorder=2, axis=0)
    raw_drift = shape - shape_smooth
    drift = savgol_filter(raw_drift, window_length=drift_win, polyorder=2, axis=0)
    final_shape = shape_smooth + drift
    return similarity_join(rigid_smooth, final_shape)
```

---

## Step 3: Rigid pose fitting for non-rigid AI sources (flip/spin)

```python
import cv2
from scipy.optimize import least_squares

def fit_rigid_pose(observed_corners, card_3d_pts, K, corner_weights=None):
    if corner_weights is None:
        corner_weights = np.ones(4)

    success, rvec, tvec = cv2.solvePnP(
        card_3d_pts.astype(np.float32),
        observed_corners.astype(np.float32),
        K, None,
        flags=cv2.SOLVEPNP_IPPE
    )

    def residuals(params):
        rv, tv = params[:3], params[3:]
        proj, _ = cv2.projectPoints(card_3d_pts, rv, tv, K, None)
        diff = (proj.reshape(-1, 2) - observed_corners) * corner_weights[:, None]
        return diff.ravel()

    result = least_squares(
        residuals,
        np.concatenate([rvec.ravel(), tvec.ravel()]),
        loss='soft_l1', f_scale=2.0
    )
    return result.x[:3].reshape(3, 1), result.x[3:].reshape(3, 1)
```

**Corner weighting strategy for hand-held card:**
- Grip end (corners under fingers): weight = 4.0
- Free end: weight = 1.0
- Hand-placed reference corners (manually marked): weight = 0.25

---

## Step 4: Catmull-Rom sub-frame interpolation for motion blur

```python
def catmull(p0, p1, p2, p3, t):
    """Catmull-Rom interpolation between p1 and p2 at parameter t."""
    return 0.5 * ((2*p1) +
                  (-p0 + p2) * t +
                  (2*p0 - 5*p1 + 4*p2 - p3) * (t**2) +
                  (-p0 + 3*p1 - 3*p2 + p3) * (t**3))
```

---

## Choosing smoothing window sizes

| Signal | Recommended window | Rationale |
|---|---|---|
| Rigid similarity motion | 1 (no smoothing) | Real camera/hand shake — the comp should follow it |
| Non-rigid shape | SG31 | Removes per-frame AI rendering wobble |
| Slow drift | SG41 | Low-passes systematic silhouette creep |
| Pose sequence (per-frame rigid) | `[1,2,1]/4` kernel | Light smoothing without losing fast motion |

**Savitzky-Golay** (`scipy.signal.savgol_filter`) is preferred over Gaussian because it preserves motion peaks better. Use `polyorder=2` for most cases.

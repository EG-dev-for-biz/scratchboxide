# VFX Thinking Mode: Surface-Aware Shading Transfer

> **When to load:** Any task involving replacing a surface in video (a card, screen, product, sign) where the replacement asset needs to inherit the lighting from the original — specifically when the lighting changes over time (finger shadows moving, hand motion creating light drift) and you need to match that changing illumination without absorbing the original asset's static exposure into your replacement.

---

## The core idea

When you composite a replacement surface into video, two kinds of "lighting" exist on the original surface:

1. **Static exposure** — the original asset's base illumination as it was photographed or rendered. You don't want to transfer this: your replacement has its own base appearance.
2. **Dynamic lighting changes** — shadow from a passing finger, ambient light drift from hand motion, specular shifts. You DO want to transfer this: your replacement should react to the same light events as the original.

**Shading transfer** isolates only the dynamic changes by:
1. Building a per-frame "what the lighting is doing" map from the original
2. Dividing out the average (baseline) illumination to get only the *changes*
3. Applying those changes to the replacement — optionally damped so you don't over-apply

---

## Step 1: Sample the original surface in UV space

```python
import numpy as np
import cv2

def sample_uv_luminance(frame_bgr, quad, grid_w=160, grid_h=101):
    """Sample luminance on a grid in the card's UV space."""
    u = np.linspace(0, 1, grid_w)
    v = np.linspace(0, 1, grid_h)
    uu, vv = np.meshgrid(u, v)
    tl, tr, br, bl = quad
    pts = ((1-vv)*(1-uu) * tl +
           (1-vv)*(  uu) * tr +
           (  vv)*(  uu) * br +
           (  vv)*(1-uu) * bl)   # (grid_h, grid_w, 2)

    pts_int = pts.reshape(-1, 2).astype(np.float32)
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    lum = cv2.remap(gray,
                    pts_int[:, 0].reshape(grid_h, grid_w),
                    pts_int[:, 1].reshape(grid_h, grid_w),
                    cv2.INTER_LINEAR,
                    borderMode=cv2.BORDER_CONSTANT, borderValue=0)

    in_bounds = ((pts[:, :, 0] >= 0) & (pts[:, :, 0] < gray.shape[1]) &
                 (pts[:, :, 1] >= 0) & (pts[:, :, 1] < gray.shape[0]))
    return lum, in_bounds
```

---

## Step 2: Build the reference (baseline) luminance

```python
from scipy.ndimage import gaussian_filter

def build_reference(lum_sequence, coverage_sequence, sigma=14.0):
    """Build a spatially smoothed reference from per-frame luminance maps."""
    stack = np.stack(lum_sequence, axis=0)
    cov   = np.stack(coverage_sequence, axis=0).astype(np.float32)
    masked = np.where(cov > 0.5, stack, np.nan)
    L_ref = np.nanmedian(masked, axis=0)
    return gaussian_filter(L_ref, sigma=sigma)
```

---

## Step 3: Compute per-frame multiplier maps

```python
def frame_multiplier(L_frame, L_ref, sigma=14.0, fallback_ratio=1.0,
                     coverage=None, damp=0.6, clamp=(0.92, 1.06)):
    """
    S[x,y] = smoothed(L_frame[x,y]) / smoothed(L_ref[x,y])
    damp: 0.5 = half transfer, 1.0 = full. Use 0.6 for hold phases; 0.85-1.0 for swing/spin.
    """
    L_f_smooth = gaussian_filter(L_frame, sigma=sigma)
    global_ratio = (np.median(L_frame[coverage > 0.5])
                    / np.median(L_ref[coverage > 0.5])
                    if coverage is not None else fallback_ratio)
    with np.errstate(divide='ignore', invalid='ignore'):
        S = np.where(L_ref > 5, L_f_smooth / np.maximum(L_ref, 5), global_ratio)
    S = np.power(np.clip(S, 0.01, 10.0), damp)
    return np.clip(S, clamp[0], clamp[1])
```

---

## Step 4: Apply the multiplier to the replacement

```python
def apply_shading(replacement_bgr, S, quad, grid_w=160, grid_h=101):
    """Warp the UV-space multiplier map S back to screen space and multiply."""
    H, W = replacement_bgr.shape[:2]
    S_full = cv2.resize(S, (W, H), interpolation=cv2.INTER_LINEAR)
    result = replacement_bgr.astype(np.float32)
    for c in range(3):
        result[:, :, c] *= S_full
    return np.clip(result, 0, 255).astype(np.uint8)
```

---

## Step 5: Temporal smoothing of the multiplier sequence

```python
from scipy.signal import savgol_filter

# S_sequence: (N, H, W)
S_sequence = np.stack([frame_multiplier(lum_i, L_ref, ...) for lum_i in lum_sequence])
S_sequence_smooth = savgol_filter(S_sequence, window_length=9, polyorder=2, axis=0)
```

Use `window_length=9` for hold phases; `window_length=3` for fast-moving spin/swing phases.

---

## Choosing parameters

| Parameter | Hold phase | Swing/spin phase |
|---|---|---|
| Damp exponent | 0.6 | 0.85–1.0 |
| Clamp range | [0.92, 1.06] | [0.85, 1.15] |
| UV map type | Full spatial (160×101) | Global gain per frame only |
| Gaussian sigma | 14 cells | 14 cells (spatial only on hold) |
| Temporal SG window | 9 | 3 |

For spin/swing phases: the AI card is bent/non-rigid, so per-cell UV sampling is unreliable. Use only a global gain (mean luminance ratio) to match the overall exposure.

---

## What you're transferring vs. what you're NOT

| You ARE transferring | You are NOT transferring |
|---|---|
| Finger shadow moving across card | The static card art's base exposure |
| Ambient light shift from hand motion | The AI card's haze/glow rendering |
| Specular highlight traveling | Card-to-card color differences |
| Overall exposure drift over time | The replacement's own texture |

The `damp` parameter is the lever. `damp=1.0` transfers everything including static differences. `damp=0.6` transfers only clear dynamic changes. Start at 0.6 and raise if the replacement looks detached from the scene.

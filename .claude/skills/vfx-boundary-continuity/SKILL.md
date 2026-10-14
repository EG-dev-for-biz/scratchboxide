# VFX Thinking Mode: Compositing Boundary Continuity

> **When to load:** Any task where a composited replacement element meets an overlapping foreground element (hand, body, environment) and there is a visible seam, gap, or pixel discontinuity at the boundary — especially when the replacement is at a different scale than the original, or when a foreground element (like fingers) partially occludes the replacement.

---

## The core idea

When you replace a surface at a slightly different scale than the original, the overlapping foreground elements (fingers gripping a card, a hand holding a product) were painted or rendered relative to the original's edge positions. If the replacement's edges are in different places, the foreground elements appear to "float" over a gap or overlap the new surface incorrectly.

**Boundary continuity** closes this gap by warping the foreground element to meet the replacement's new edges — using a smooth displacement field that eases in over time and decays spatially so only the boundary region is moved.

---

## The displacement field approach

Rather than globally warping the entire foreground layer, compute a displacement field that:
1. Has maximum displacement at the old boundary
2. Decays to zero moving away from the boundary (spatially)
3. Eases in over a few frames at the start (temporally) to avoid a pop
4. Has zero displacement anywhere except near the boundary seam

```python
import numpy as np
from scipy.ndimage import gaussian_filter
import cv2

def squeeze_field(old_quad, new_quad, frame_shape, decay_sigma=40):
    """
    Compute a 2D displacement field that warps the foreground from
    old_quad edges to new_quad edges, decaying away from the boundary.
    Returns: (H, W, 2) displacement field in pixels
    """
    H, W = frame_shape[:2]
    dx_field = np.zeros((H, W), dtype=np.float32)
    dy_field = np.zeros((H, W), dtype=np.float32)

    for edge_idx in range(4):
        old_edge = old_quad[[edge_idx, (edge_idx+1) % 4]]
        new_edge = new_quad[[edge_idx, (edge_idx+1) % 4]]
        delta = new_edge.mean(axis=0) - old_edge.mean(axis=0)
        mx, my = old_edge.mean(axis=0).astype(int)
        if 0 <= my < H and 0 <= mx < W:
            dx_field[my, mx] += delta[0]
            dy_field[my, mx] += delta[1]

    dx_smooth = gaussian_filter(dx_field, sigma=decay_sigma)
    dy_smooth = gaussian_filter(dy_field, sigma=decay_sigma)

    peak = gaussian_filter(np.ones_like(dx_field) *
                           (dx_field != 0), sigma=decay_sigma).max()
    if peak > 0:
        dx_smooth /= peak
        dy_smooth /= peak

    return np.stack([dx_smooth, dy_smooth], axis=-1)
```

---

## Temporal ramp (smoothstep ease-in)

```python
def smoothstep(x):
    """Smoothstep curve: 0 at x=0, 1 at x=1."""
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)

def ramp_factor(frame_idx, ramp_start, ramp_end):
    """Returns 0 before ramp_start, 1 after ramp_end, smoothstep between."""
    return smoothstep((frame_idx - ramp_start) / max(ramp_end - ramp_start, 1))
```

---

## Applying the displacement field

```python
def apply_displacement(image, disp_field):
    """Warp image by a displacement field. disp_field: (H, W, 2) in pixels."""
    H, W = image.shape[:2]
    y_coords, x_coords = np.mgrid[0:H, 0:W].astype(np.float32)
    map_x = x_coords - disp_field[:, :, 0]
    map_y = y_coords - disp_field[:, :, 1]
    return cv2.remap(
        image, map_x, map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE
    )
```

---

## Edge blending

```python
def edge_blend(composite, original, mask, feather_px=8):
    """Feather the boundary between composite and original."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (feather_px*2+1,)*2)
    mask_dilated = cv2.dilate(mask, kernel)
    mask_blurred = cv2.GaussianBlur(mask_dilated.astype(np.float32),
                                    (feather_px*4+1, feather_px*4+1), feather_px)
    alpha = mask_blurred[:, :, None]
    return (composite * alpha + original * (1 - alpha)).astype(np.uint8)
```

---

## Decision guide

| Boundary issue | Solution |
|---|---|
| Gap between fingers and card edge (scale change) | Displacement field with smoothstep ramp |
| Pop at the first composited frame | Smoothstep ease-in over 6–10 frames |
| Hard visible seam at card edge | Edge feathering (feather_px = 8–15) |
| Different lighting between foreground and replacement | Add shading transfer (see `vfx-shading-transfer`) |
| Foreground alpha fringing | Expand the foreground matte by 1–2px before compositing |

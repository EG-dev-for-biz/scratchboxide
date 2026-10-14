# VFX Thinking Mode: Spatial Anchor Design

> **When to load:** Any task where conditioning plates, reference frames, or keyframe panels for AI generation show the subject at different positions, scales, or orientations between panels — causing the model to introduce camera movement, arm jumps, or spatial drift in the generated video.

---

## The core idea

A generative model treats every conditioning plate as a spatial truth statement. If the subject's arm base is at x=820 in one panel and x=880 in another, the model will interpolate between those positions — introducing a camera pan or spatial drift that wasn't intended. **Spatial anchor design** ensures every conditioning plate shares identical spatial coordinates for a designated reference point, collapsing the model's spatial interpretation to a single consistent coordinate system.

The **spatial anchor** is a chosen fixed point on the subject (typically the origin of motion — the shoulder base, forearm entry point, wrist center, or product edge) that must be pixel-identical across all conditioning panels.

Use the native **`normalize_conditioning_plates`** Gemini tool to run the alpha-scan, alignment, and spread assertion automatically.

---

## Choosing your anchor

Choose an anchor point that is:
- **Stable in the intended shot** — it should not be moving in the final output
- **Reliably detectable** — a clear feature (a seam, the edge of a sleeve, the entry point of a limb)
- **Present in all conditioning panels** — visible in every stage from start to end

For hand/arm shots: the bottom-center of the forearm sleeve where it exits the frame is ideal. It's stable, clearly defined, and present in every stage.

---

## Implementing a spatial anchor with alpha scan

When working with RGBA foreground layers composited over a background:

```python
from PIL import Image

def anchor_to_x(layer_rgba, bg_w, bg_h, target_x):
    """
    Translate `layer_rgba` horizontally so its detected base
    center aligns to `target_x` pixels from the left edge.
    """
    # Scan bottom 25 rows for non-transparent pixels
    for check_y in range(bg_h - 1, bg_h - 25, -1):
        xs = [x for x in range(bg_w)
              if layer_rgba.getpixel((x, check_y))[3] > 50]
        if xs:
            current_center = (min(xs) + max(xs)) // 2
            dx = target_x - current_center
            result = Image.new('RGBA', (bg_w, bg_h), (0, 0, 0, 0))
            result.paste(layer_rgba, (dx, 0), layer_rgba)
            return result
    return layer_rgba  # fallback: no detectable base
```

---

## Vertical anchor

For shots where vertical position must be consistent (e.g., a product held at a fixed height):

```python
def anchor_to_y(layer_rgba, bg_w, bg_h, target_y):
    """Translate vertically so the detected top edge aligns to target_y."""
    for check_x in range(bg_w // 2 - 50, bg_w // 2 + 50):
        ys = [y for y in range(bg_h)
              if layer_rgba.getpixel((check_x, y))[3] > 50]
        if ys:
            top = min(ys)
            dy = target_y - top
            result = Image.new('RGBA', (bg_w, bg_h), (0, 0, 0, 0))
            result.paste(layer_rgba, (0, dy), layer_rgba)
            return result
    return layer_rgba
```

---

## Anchor for raster composites (no alpha channel)

When working with non-alpha source images, use a known visual feature (a specific color patch, a seam line, or a landmark you measured manually):

```python
import cv2
import numpy as np

def find_feature_x(frame_bgr, feature_hsv_range):
    """Find the horizontal center of a color-segmented feature."""
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, feature_hsv_range[0], feature_hsv_range[1])
    cols = np.where(mask.any(axis=0))[0]
    return int(cols.mean()) if len(cols) > 0 else None
```

---

## Verifying anchor consistency across panels

Before assembling the final contact sheet, verify the anchor coordinates are within tolerance:

```python
anchor_positions = []
for panel_path in panel_paths:
    img = Image.open(panel_path).convert('RGBA')
    for y in range(img.height - 1, img.height - 25, -1):
        xs = [x for x in range(img.width) if img.getpixel((x, y))[3] > 50]
        if xs:
            anchor_positions.append((min(xs) + max(xs)) // 2)
            break

max_drift = max(anchor_positions) - min(anchor_positions)
print(f"Anchor spread: {max_drift} px  (target: < 5 px)")
assert max_drift < 5, f"Anchor drift {max_drift}px exceeds tolerance"
```

A spread > 5px is detectable by the model and may cause spatial drift. > 20px will almost certainly cause a camera translation artifact.

---

## Anchor design checklist

Before submitting any conditioning array:
- [ ] Anchor feature is identical across all panels (within 5 px tolerance)
- [ ] Background is identical across all panels (same color, texture, void)
- [ ] Camera angle and focal length are identical across all panels
- [ ] Lighting direction and color temperature are identical across all panels
- [ ] All panels are at the same resolution and aspect ratio

---

## Diagnosis: spatial drift in output

If the generated video shows unwanted camera movement or subject translation:
1. Measure the anchor position in each conditioning panel (`find_feature_x` or alpha scan)
2. Check the spread — if > 20px, re-align the panels
3. Check if the background is consistent — a different background color between panels is read as a scene change
4. Check if the prop/reference image has different framing than the start/end plates

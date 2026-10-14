# Skill: Remotion Keyframing, SVG Vector Layers & After Effects Export

## When to load this skill

Load before any task involving:
- Adding multi-track keyframe animation with cubic-bezier easing to a Remotion composition
- Animating SVG paths with Trim Paths-style stroke draw-on effects in Remotion
- Exporting a Remotion composition to an editable Adobe After Effects `.jsx` ExtendScript package
- Debugging AE ExtendScript tangent offset errors, dimension mismatch errors, or DOM stall issues

---

## Architecture overview

Three modules, each independently usable:

| Module | File | Purpose |
|---|---|---|
| Keyframe engine | `src/lib/keyframing.ts` | Multi-track numeric keyframe interpolation with bezier presets |
| SVG vector layers | `src/lib/vector.tsx` | Resolution-independent SVG with animated Trim Paths |
| AE exporter | `scripts/export_ae_jsx.py` | Python CLI → editable `.jsx` ExtendScript package |

---

## 1 — Multi-track keyframe engine (`src/lib/keyframing.ts`)

### Named bezier presets (matches AE standard curves)

```typescript
export const BEZIER_PRESETS = {
  easyEase: [0.333, 0.0, 0.667, 1.0],  // AE Easy Ease
  snappy:   [0.16,  1.0, 0.3,   1.0],  // Fast UI pop
  dramatic: [0.85,  0.0, 0.15,  1.0],  // Tension snap
};
```

### Interpolating a numeric track

```typescript
import { interpolate, Easing } from 'remotion';

export interface Keyframe<T> {
  frame: number;
  value: T;
  ease?: EasingDef;
}

export function interpolateNumericKeyframes(
  frame: number,
  track: Keyframe<number>[]
): number {
  if (track.length === 0) return 0;
  if (frame <= track[0].frame) return track[0].value;
  if (frame >= track[track.length - 1].frame) return track[track.length - 1].value;

  for (let i = 0; i < track.length - 1; i++) {
    const startKf = track[i], endKf = track[i + 1];
    if (frame >= startKf.frame && frame <= endKf.frame) {
      const progress = (frame - startKf.frame) / (endKf.frame - startKf.frame);
      const easingFn = resolveEasing(startKf.ease);
      return startKf.value + (endKf.value - startKf.value) * easingFn(progress);
    }
  }
  return track[track.length - 1].value;
}
```

---

## 2 — SVG vector layers with Trim Paths (`src/lib/vector.tsx`)

### Stroke draw-on (emulates AE Trim Paths)

```tsx
const visibleLength = Math.max(0, (clampedEnd - clampedStart) * pathLength);
const gapLength = pathLength;
const dashOffset = (1 - clampedEnd + offset) * pathLength;

return (
  <path
    d={d}
    stroke={stroke}
    strokeWidth={strokeWidth}
    strokeDasharray={`${visibleLength} ${gapLength}`}
    strokeDashoffset={dashOffset}
  />
);
```

### Path length — never use DOM measuring

**Never call `document.querySelector('path').getTotalLength()`** inside a Remotion render loop. Headless Chromium workers will stall or produce race conditions.

Always use the deterministic estimator:

```typescript
import { estimateSvgPathLength } from './vector';
const pathLength = estimateSvgPathLength(svgPathD);
```

This parses `M`, `L`, `C`, `A`, `Q`, `Z` commands mathematically without touching the DOM.

---

## 3 — After Effects ExtendScript exporter (`scripts/export_ae_jsx.py`)

### Run it

```bash
python3 scripts/export_ae_jsx.py --preset=full_showcase --output=out/showcase.jsx
# or via npm:
npm run export:ae
```

### What it generates

1. `app.beginUndoGroup` / `app.endUndoGroup` wrapper
2. `app.project.items.addComp(name, w, h, 1.0, dur, fps)` — comp setup
3. `comp.layers.addShape()` → `ADBE Root Vectors Group` → shape group
4. `ADBE Vector Shape - Group` with vertices, inTangents, outTangents
5. `ADBE Vector Graphic - Stroke` with normalized RGB, round caps
6. `ADBE Vector Filter - Trim` animating `ADBE Vector Trim End`
7. `comp.layers.addText()` with font, justification, keyframed position/opacity

---

## Critical pitfall: tangent offsets are RELATIVE, not absolute

In After Effects `Shape()`, `inTangents` and `outTangents` are **relative vector offsets `[dx, dy]` from the vertex coordinates**, not absolute stage positions.

```python
# WRONG — absolute coordinates
out_tangents.append([cp1x, cp1y])

# CORRECT — relative offset from the vertex
out_tangents.append([cp1x - anchor_x, cp1y - anchor_y])
```

Failing to subtract the vertex position distorts all bezier curves.

---

## Critical pitfall: KeyframeEase dimension must match property type

Calling `setTemporalEaseAtKey()` with mismatched dimension count throws an ExtendScript runtime error:

```javascript
// 2D/3D spatial property (Position, Anchor Point) — MUST use 3 ease objects:
prop.setTemporalEaseAtKey(i, [ease, ease, ease], [ease, ease, ease]);

// 1D scalar property (Opacity, Rotation, Trim End) — use 1 ease object:
prop.setTemporalEaseAtKey(i, [ease], [ease]);
```

---

## npm scripts

```json
{
  "scripts": {
    "render:vector": "remotion render src/index.ts VectorKeyframeDemo out/vector.mp4 --gl=angle",
    "export:ae":    "python3 scripts/export_ae_jsx.py --preset=full_showcase --output=out/after_effects_comp.jsx"
  }
}
```

---

## Verification checklist

- [ ] `app.beginUndoGroup` present as first non-comment line
- [ ] Shape vertices are arrays of `[x, y]` pairs
- [ ] `inTangents` / `outTangents` are relative offsets (subtract vertex from control point)
- [ ] All 2D/3D spatial properties use 3-element ease arrays
- [ ] All scalar properties use 1-element ease arrays
- [ ] No `document.querySelector` or DOM calls anywhere in the Remotion source

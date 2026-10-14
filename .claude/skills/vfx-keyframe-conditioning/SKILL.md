# VFX Thinking Mode: Keyframe Conditioning

> **When to load:** Any task where you need a generative AI video model to travel between two specific visual states — a start plate and an end plate — with controlled intermediate motion. Also load when a generated video cuts, morphs, or drifts rather than following the intended path.

---

## Platform note

In Scratchbox IDE, use these native Gemini tools for the assembly and alignment steps:
- **`build_conditioning_contact_sheet`** — composites image panels into a borderless contact sheet
- **`normalize_conditioning_plates`** — normalizes resolution, runs alpha-scan anchor alignment, asserts spread ≤ 5px

The decision tree and conditioning strategy below still applies; the tools handle the pixel-level execution.

---

## The core idea

Generative video models are probability distributions over motion paths. Given only a start and end frame, the model chooses the highest-probability interpolation — which is rarely the one you want. **Keyframe conditioning** narrows the probability distribution by explicitly encoding the path at multiple intermediate stages. The model is no longer free to invent its own trajectory.

---

## The mental model: constraint density

Think of your conditioning as "constraint density" along the timeline. More conditioning plates = higher density = less freedom for the model to deviate. The minimum viable conditioning set is:

```
[start_plate, end_plate]           ← low density: model invents the middle
[start_plate, midpoint, end_plate] ← medium density: model fills two halves
[start, stage_2, stage_3, ..., end] ← high density: model fills narrow gaps
```

For complex physical actions (hand reveals, product flips, athlete movements), high density is almost always required.

---

## The 4-image conditioning array (standard pattern)

```
[anchor_start, prop/reference, trajectory_contact_sheet, anchor_end]
```

| Slot | Purpose | What to put here |
|---|---|---|
| anchor_start | Locks frame 0 appearance | The exact opening frame at final resolution and framing |
| prop/reference | Locks object appearance | The product, card, or prop at clean front-facing orientation |
| trajectory_contact_sheet | Locks the motion path | A multi-panel strip showing intermediate stages (see below) |
| anchor_end | Locks final frame appearance | The exact landing/hero-hold plate |

The model reads these as simultaneous visual constraints, not a sequence to follow in order.

---

## Building the contact sheet (trajectory strip)

The contact sheet is the most important element. It encodes the intermediate angular/positional states that constrain the model's interpolation path.

**Rules:**
- Each panel shows the subject at a distinct, well-separated stage
- Panels must be **completely borderless** — no text labels, no borders, no annotations. All description goes in the text prompt only. Text overlays can clip extremities (fingertips, edges) and cause the model to generate truncated anatomy.
- Minimum 3 intermediate stages for a 2–5 second action; 4–6 stages for longer
- Panels should cover the full action range: rest → preparation → action apex → landing

Use the native `build_conditioning_contact_sheet` Gemini tool to assemble panels. For manual assembly (Python / Pillow):

```python
from PIL import Image

panels = ['path/to/stage_1.jpg', 'path/to/stage_2.jpg', ..., 'path/to/stage_n.jpg']
cols = 3
rows = (len(panels) + cols - 1) // cols
panel_w, panel_h = 640, 360
sheet = Image.new('RGB', (cols * panel_w, rows * panel_h))
for i, path in enumerate(panels):
    img = Image.open(path).resize((panel_w, panel_h), Image.Resampling.LANCZOS)
    sheet.paste(img, ((i % cols) * panel_w, (i // cols) * panel_h))
sheet.save('contact_sheet.jpg', quality=95)
```

---

## Frame-to-frame continuity metric

The quantitative signal for whether conditioning worked:

| Delta value | Meaning |
|---|---|
| < 4.1 | Clean interpolation — model followed the path |
| 4.1 – 15.0 | Acceptable — some model invention but no hard cut |
| > 15.0 | Morph-cut or hard edit — conditioning failed |

A delta spike identifies the exact frame where the model departed from the path. Use the native `video_qa_check` Gemini tool to compute this automatically.

**Self-improving retry loop:** when a delta spike is detected at frame N, add an intermediate contact sheet panel at that timestamp, then regenerate.

---

## Camera plate matching rule

Both anchor plates must share:
- Identical camera angle and focal length
- Identical lighting setup (key/fill direction, color temperature)
- Identical background (same color, void, or scenery)

Any difference in these causes the model to execute an **editorial cut** or camera reposition at the midpoint. This is the most common failure mode and has no prompt-only fix — the plates themselves must match.

---

## v2v motion lock (advanced)

When you already have an approved take and need to repaint it (change hand appearance, swap the card, alter wardrobe) without changing any motion: pass the existing video composited over a chroma key color as the source input. Ask the model to hold all motion frame-for-frame identical while updating only appearance. Pass a separately-painted first frame as a "look anchor" to define the new appearance from frame 0.

---

## Decision tree

```
Need AI to interpolate between two states?
│
├── Is it a simple A→B movement with no complex kinematics?
│   └── Start + end + text prompt may be sufficient
│
├── Does it involve a complex physical action (flip, reveal, hand motion)?
│   └── Use full 4-image array with a 4–6 panel contact sheet
│
├── Is the camera moving or changing angle between plates?
│   └── Fix the plates first — no prompt engineering overrides plate mismatch
│
└── Did a previous attempt produce morph-cuts or wrong trajectory?
    └── Increase contact sheet density; add more intermediate stages
```

# PPTX & Google Slides Engine Invariants

This document codifies the technical and architectural invariants required when generating `.pptx` presentations and converting them to Google Slides via Google Drive API. Failure to follow these rules results in coordinate clipping, file corruption, or severe visual defects.

---

## 1. Canvas Dimensions & Layout Selection

| Canvas Setting | Width | Height | Aspect Ratio | Status |
| :--- | :--- | :--- | :--- | :--- |
| **`LAYOUT_WIDE`** | **`13.333"` (33.867 cm)** | **`7.5"` (19.05 cm)** | **16:9 Widescreen** | **MANDATORY DEFAULT** |
| `LAYOUT_16x9` | `10.0"` (25.4 cm) | `5.625"` (14.29 cm) | 16:9 Compact | DO NOT USE for 13.3" coordinate math |
| `LAYOUT_4x3` | `10.0"` (25.4 cm) | `7.5"` (19.05 cm) | 4:3 Legacy | Only if explicitly requested |

> [!CRITICAL]
> In `pptxgenjs`, setting `pres.layout = 'LAYOUT_16x9'` creates a **10.0" × 5.625"** slide. If coordinate math uses `13.333"` and `7.5"`, shapes, vertical accent lines, and bounding boxes will punch straight through the bottom and right edges of the slide.
> **Always set `pres.layout = 'LAYOUT_WIDE'` for 16:9 widescreen.**

---

## 2. Hex Color Formatting

- **Never prefix with `#`**: Use `"07111E"`, never `"#07111E"`.
- **Never pass 8-digit hex codes**: Alpha values must NOT be baked into the hex string (`"00000020"` corrupts the OOXML).
- **Translucency Handling**:
  - Shapes & Fills: Use `transparency: 0-100` (e.g. `transparency: 20` for 80% opacity).
  - Shadows: Use `opacity: 0.0-1.0`.

---

## 3. Text Frames & Bounding Boxes

- **Zero Margin Alignment**: Text boxes in PowerPoint have default internal padding. Always set `margin: 0` whenever a text box must align flush with a container card, shape, or divider line.
- **Line Spacing vs Paragraph Spacing**:
  - Never use huge `lineSpacing` multipliers on body text. Use `lineSpacingMultiple: 1.25` to `1.35`.
  - For lists, use `paraSpaceAfter: 6` to `10` points rather than inserting double newlines (`\n\n`).
- **Lists & Bullets**:
  - Set `bullet: true` on array items. Never insert literal bullet symbols (`•`, `*`, `-`) in the text string (causes double bullets).
  - Include `breakLine: true` on each list item except the last.

---

## 4. Visual Card Containers (The Anti-Prose Architecture)

Raw markdown paragraphs must never be dumped directly onto the slide canvas. Instead, group information into **visual card containers**:

1. **Card Background Shape**:
   - Shape: `pptx.ShapeType.roundRect` (`rectRadius: 0.08` to `0.12`).
   - Fill: Subtle elevated background (e.g., `slideBg` lightened by 8–12% or semi-translucent dark slate).
   - Border: 1pt subtle hairline (`color: palette.secondaryAccent` or `palette.border`, `transparency: 60`).
2. **Internal Card Layout**:
   - Card Header / Tag Badge (10pt, bold, uppercase, brand accent color).
   - Card Title / Action Assertion (13–15pt, bold, high contrast).
   - Card Body / Bullet Points (10–11pt, clean contrast `7:1`).

---

## 5. Image & Media Invariants

- **Aspect Ratio Preservation**: Always pass `sizing: { type: 'contain', w: targetW, h: targetH }` or `type: 'cover'` with an explicit bounding box. Never allow images to stretch or distort.
- **Local Filesystem Paths**: Strip `file://` prefixes before passing to `slide.addImage({ path: localPath })`.
- **Layering Order**: Always add background scrims and card shapes *before* adding text and foreground images.

---

## 6. Slide Title & Fallback Protection

- **Never Print Document Filenames**: If a slide has no `#` header, extract the first sentence or synthesize an active assertion headline from the content. Under no circumstance should `directors_treatment` or a file path appear as a slide title.
- **Tracked Uppercase Category Labels**: Place a small tracked uppercase kicker (10pt, letter spacing, accent color) above main headlines to establish section context.

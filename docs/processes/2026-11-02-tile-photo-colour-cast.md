# The blue-purple cast at the Haughwout and the Ferry is in Google's tile photos

Date: 2026-11-02. Measured offline from the second ablation run's paid outputs
([its preregistration](./2026-11-02-k-step-ablation-2-prereg.md)), with no new model call. Status: **measured; the fix is
the next de-light target, not made here.**

## Why it was measured

In run 2's proof sheet every textured arm at the Haughwout and the Ferry, the raw scan included, rendered blue-purple. The
real photos show grey stone (Haughwout) and beige stone (Ferry). Since the raw scan has the cast too, it comes from one of two
places:
- the tile photos themselves (skylight baked into shadow, or the capture's white balance);
- the judge's render path.

## Method

Every number is a mean CIELAB (D65) value, averaged over the judged views: 6 at the Haughwout, 5 at the Ferry.

- **Photo:** inside the judge's target mask. The judge does not save the photo, so it is recovered exactly from the region
  overlay (`<view>_masks.png` is the photo × 0.55 + the target's red × 0.45 on target pixels, `regionOverlay`). Each pixel's
  label is read against the grid's photo tile, and the target edge is eroded by 1 px.
- **Judge's raw render:** `<view>_raw.png`, over the same pixels.
- **Raw tile texels:** the tile's own textures on the target, picked as the judge picks it (tile triangles on the
  isolate's surface, `onSurfaceFlags`). Samples are area-weighted, one per 2 × 2 cm, bilinear in the decoded texture. Walls are
  triangles with |n_y| < 0.5.
- **Decoder check:** every image of both tiles was decoded with PIL, independently of the app's decoder.

## Result

| Place | Photo L* / a* / b* | Judge raw render | Raw texels, walls | Raw texels, all | K render |
|---|---|---|---|---|---|
| Haughwout | 42.3 / −0.6 / 0.0 | 29.6 / **+6.1 / −10.6** | 34.4 / **+7.4 / −8.6** | 36.3 / +6.9 / −7.6 | 30.5 / +5.9 / −10.0 |
| Ferry | 51.1 / −1.2 / **+10.0** | 30.7 / −0.8 / **−7.3** | 30.3 / −1.0 / **−8.1** | 36.5 / −0.6 / −6.0 | 34.0 / −0.7 / −6.8 |

- **The texels carry the cast; the render only reproduces it.**
  - The judge's textured render is the texel times a grey scalar shade (ambient plus headlight). The judge never sets
    `specular`, so no tinted environment is added (`photo-match-eval.ts` `renderTriangles`).
  - The app's JPEG decode matches PIL within 0.56/255 of mean sRGB on all 111 images (97 Ferry, 14 Haughwout). There is no
    channel swap and no ICC profile.
  - The seam weld keeps the image bytes: the welded tile's images are the raw extraction's, byte for byte.
- **Two parts, by texel lightness** (dark third / bright third):
  - **Skylight in shadow:** b* runs −8.3 / −2.1 at the Ferry and −9.7 / −4.7 at the Haughwout. The darker the texel, the bluer.
  - **A capture white balance (Haughwout):** a* is about +6.5 at every lightness, a magenta tint over the whole capture.
- **K keeps it.** The fixed de-light keeps the photo's chroma, as designed, and the tile's cast is part of that chroma. The
  de-light off changes nothing here (noDelight matches K within 0.1).
- **The photos vary by view:**
  - Ferry b* runs from +1.0 (v0) to +24.0 (v3).
  - Haughwout views lie within ±1.7 of neutral.
  - Street View's white balance is not ground truth either, but it is what the judge compares against.

## What follows

This is a judge finding only in that the judge sees it; the judge renders the texels faithfully, so nothing goes to MAIN.
The next de-light target is in the twin, on the tile photos:
- neutralise the capture's white balance;
- take the skylight's blue out of shadowed texels, measured against the same material where it is lit;
- keep the chroma that belongs to the material.

Scripts: `texels.ts`, `photo_render.py`, `decode_check.py` and `cast_sheet.py` (this session's scratchpad, `ablation/cast/`).
Numbers and the proof sheet: `docs/screenshots/k_step_ablation_2026-11-02/colour_cast/` (gitignored).

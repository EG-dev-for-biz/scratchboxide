---
name: surface-materials
description: >-
  Give rebuilt surfaces of a real-place district their materials with infer_surface_materials, judge whether a
  material reads as real, and keep material values physically plausible. Load when the user asks about the materials,
  textures or surface look of a rebuilt place. infer_surface_materials applies only to builds made with the opt-in
  procedural district path.
---

# Surface materials

## Fast paths
- Default look of a built place: the photo-tile texture transferred onto the surfaces. Nothing to call.
- Library materials per surface instead (clean, no baked shadows, but no windows or signs): `infer_surface_materials { stageDir, tilesGlb, mode: "inferred" }`. `stageDir` is the massing stage folder the build reports. Use it only when the user asks for clean or stylised materials, and only on a build made with the opt-in procedural district path: an ordinary district's or isolated building's stage folder lacks the files it needs, and the call fails.
- What a real surface looks like (paving, cladding, roofing): `location_reference_images { place, subject: "<the surface> close up" }`.

## Rules (what makes a surface read as fake)
1. **Photo first.** Inferred library materials lose windows, signs and ornament: walls come out blank. Say so before using them.
2. **Repetition shows at distance.** A tile repeated across a road or wall reads as a grid of identical stains or bands. A material that repeats visibly is not acceptable.
3. **Roughness is never constant.** A single roughness value looks plastic.
4. **Base colour has no lighting in it.** Shadows or highlights in a colour map are baked light and break under the scene's sun.
5. **Metallic is 0 or 1.** Painted metal is not metal.
6. **Scale matters.** Bricks are about 0.23 × 0.076 m, setts about 0.1–0.2 m; a material at the wrong scale is the first thing people notice.

## Plausible base colours (sRGB, dielectrics)
| Surface | Albedo | Roughness |
|---|---|---|
| Asphalt fresh / worn | 60 / 90 | 0.8–0.95 |
| Concrete | 130–150 | 0.8–0.95 |
| Red brick | 150, 80, 60 | 0.8–0.9 |
| Sandstone | ~190, 160, 110 | 0.8–0.9 |
| Grass | 75, 110, 45 | 0.6–0.8 |
| Fresh snow | 240 | 0.6–0.8 |
| Glass, water | transmission; IOR 1.5, 1.33 | 0–0.05 |

A dielectric surface averaging below about 50 or above about 200 is almost certainly wrong.

## Findings → next step
| You see | Do |
|---|---|
| Blank walls after `infer_surface_materials` | expected: tell the user; the photo mode keeps windows |
| Precast concrete chosen everywhere | the library lacks a better match (curtain wall, metal cladding, membrane roof); say so |
| A grid of stains or bands on a large surface | that material repeats visibly; name it |
| Very dark or very bright material | out of the plausible range above; name it |

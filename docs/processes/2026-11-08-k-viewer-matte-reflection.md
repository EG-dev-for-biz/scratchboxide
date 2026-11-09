# App viewer: why matte stone looked wet, and the fix (2026-11-08)

**Ask** (MAIN, after #194): the ESB base, drawn at roughness 0.82-0.85, still renders dark and wet in the app viewer. Find why a rough dielectric looks glossy, with measurements, and fix it.

**Checked in the page** (Seagram and ESB scenes, branch builds of #194):
- **Fine:**
  - the probe is a PMREM (mapping 306), sampled by roughness, at envMapIntensity 1;
  - the twin's ORM roughness map is linear (NoColorSpace) and reaches the shader (roughness and metalness factors 1);
  - the specular anti-aliasing term only raises roughness.
- **Tone mapping:** ACES Filmic at the scene's exposure of 1.72; left unchanged.

**Controlled test:** a flat wall (albedo 0.15, roughness 0.85) placed in the scene, with its probe and lights, read back in linear light. The table gives the share of the shaded wall's brightness that is the probe's reflection, at 0, 45, 70 and 80 degrees from the wall's normal:

| | 0° | 45° | 70° | 80° |
|---|---|---|---|---|
| viewer on main | 21% | 25% | 37% | 47% |
| three.js MeshPhysicalMaterial (probe's diffuse kept) | 8% | 9% | 15% | 20% |
| after the fix | 7% | 9% | 14% | 20% |

- Sunlit wall: 7-17% on main, 2-6% after the fix.
- Glass (roughness 0.08) keeps the whole probe, unchanged.

**Cause:** `facadeMaterialLook.ts` takes the probe's diffuse light out (the photo is lit by the hemisphere fill) but kept its reflection whole. On a shaded wall the probe's light is about 4x the hemisphere's, so a dark rough wall was lit mostly by a reflection of the sky.

**Fix:** a rough dielectric's probe reflection is scaled by the fill's share of the probe's irradiance at that point (`MATTE_REFLECTION`, roughness 0.3 to 0.7). Metal and smooth surfaces are unchanged.

**Seen in the viewer** (same twin and camera, the fix toggled in the page): the ESB's shaded wall goes 66.4 -> 55.7 (sRGB mean) at the same texture contrast; Penn 2's piers go 124 -> 120 with its panels and glass unchanged; Seagram is unchanged (metal and glass). Sheet: `benchmarks/2026-11-08-texture-expert/viewer-matte-sheet.jpg`.

**Left for a decision:** shaded walls stay dark because the hemisphere fill gives them about a quarter of the light the scene's own sky probe implies (0.022 against 0.093 linear on the test wall).

# App viewer: shade lit by the scene's own sky (2026-11-08)

**Ask** (MAIN's decision after #198): shaded facades should be lit as the scene's own sky implies. The hemisphere fill gave them about a quarter of the probe's irradiance, so shade read dark and heavy.

**Change** (`facadeMaterialLook.ts`, the K material-regions look only):
- A rough dielectric takes its diffuse light from the probe's irradiance, in place of the hemisphere and ambient fill. This ramps in from roughness 0.3 to 0.7 (`SKY_FILL`).
- Glass, polished surfaces and metals keep the fill: a glass pane's photo shows what lies behind it, not an albedo, and lit by the probe the Seagram's glass bands went pale grey.
- The probe's reflection is drawn in proportion to whichever fill lights the texel; #198's weight is the special case of the hemisphere fill.
- Pipeline E's parameter path is unchanged.

**Test wall** (flat, albedo 0.15, roughness 0.85, in the scene with its own probe and lights; linear light at 0 / 45 / 70 / 80 degrees):
- **Shaded:** 0.032 before; 0.093 / 0.091 / 0.095 / 0.100 after.
- **Reflection share in shade:** 6 / 7 / 11 / 16% (three.js MeshPhysicalMaterial 8 / 9 / 15 / 20%).
- **Sunlit** (sun 20 degrees up, wall facing it): 0.154. Sun to shade is 1.66:1, below a clear sky's 3-6:1, because the staged sky is bright for its sun. Changing that is a global lighting decision, left alone.
- **Glass:** unchanged.

**Viewer A/B** (same twin and camera, the change toggled in the page; sRGB means):

| Building | Before | After | Notes |
|---|---|---|---|
| ESB shaded wall | 55.7 | 116.9 | texture std 5.4 -> 7.3; nothing clipped (max 203) |
| Penn 2 piers | 120 | 129 | glass and panels unchanged |
| Seagram | — | — | unchanged |

Sheet: `benchmarks/2026-11-08-texture-expert/viewer-sky-fill-sheet.jpg`.

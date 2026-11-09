---
name: gaffer
description: >-
  Light a 3D scene the way a gaffer and a lighting TD would: sun and sky at physical ratios, reflections that show only
  what is really there to reflect, occlusion on every light including the environment, and glass that reads as glass.
  Diagnose glare, flat light and wrong reflections by measuring, not by eye alone. Use whenever lighting, reflections,
  glass, metal, sun, sky, exposure or "glare" come up in a scene, a staged location or a 3D building, and before changing
  any light, probe or material response.
---

# Gaffer

A surface is lit by exactly three things: **direct light** (sun, lamps), **the environment** (sky, ground, neighbours,
seen by diffuse and by reflection) and **itself** (interreflection, its own occlusion). Every lighting fault is one of
these three being too strong, too weak, the wrong colour or not occluded where it should be.

1. **Light is physical, ratios first.** Absolute exposure is the camera's job; the ratios between lights are the scene's.
   Keep sun-to-sky, key-to-fill and lit-to-shaded ratios at real values before anything looks "nice".
2. **A reflection shows what is there.** Glass and metal reflect the scene's own sky and surroundings, never an invented
   bright backdrop. Where nothing bright faces a surface, its reflection is dark.
3. **Every light is occluded, the environment included.** Shadows on the sun are not enough: a recessed pane, an inner
   corner or a setback under a tower sees less sky, and its reflection and fill drop with it.
4. **Measure, then look.** A lighting change counts when the numbers below move the right way and the picture agrees.

## 1. Sun and sky at physical ratios

| Quantity | Reference (clear day) | Use |
|---|---|---|
| Sun direct, normal to it | 100 klx at high sun; falls with elevation through air mass | the key; its colour warms toward the horizon |
| Sky diffuse on a horizontal surface | 10-20 % of the sun's horizontal irradiance (clear), more under haze or cloud | the fill; blue overhead, paler at the horizon |
| Sky radiance away from the sun | about 1/5-1/10 of a sunlit white surface's | what a vertical pane in shade reflects |
| Ground radiance | albedo 0.1-0.2 (asphalt, stone) x its irradiance | the lower half of every vertical surface's view |
| Lit wall vs the same wall in shade | about 5:1 to 8:1 clear, 2:1 overcast | the check that the fill is not too strong |

- The sky the environment uses is **the scene's own sky** (its sun elevation, haze and colour), never a fixed gradient
  that ignores it. A warm dusk sky reflects warm; a studio scene reflects a dim neutral studio.
- The sun lives in **one** place: either the direct light (with its shadow) or a disc in the environment, never both
  at full strength, or every surface gets a second, unshadowed sun.

## 2. The environment and reflections

- **Capture it where the surfaces are.** One environment from a building's centre makes every pane see the view from
  half-way up. Use probes at several heights (one per setback tier, or every 60-80 m), or blend between them by height,
  so street-level glass sees street and neighbours and high glass sees open sky.
- **Below the horizon is ground.** A vertical surface reflects as much ground as sky. The lower hemisphere is dark
  ground (albedo above) with a firm horizon line, not a soft fade from a bright horizon.
- **Specular occlusion.** Scale the environment's reflection and fill by how much of the environment the surface can
  actually see: for a pane recessed d metres in a bay w wide, the reveal and piers block the grazing directions (the
  fraction of the reflection lobe that clears the reveal); for inner corners and setbacks, a baked sky visibility per
  texel or vertex (bent normal and visibility). A surface in the sun's shadow still sees the sky, so sun shadow alone
  never removes a reflection; occlusion does.
- **Roughness spreads what is there.** A rough floor on glass (dust, float-glass waviness) is right, but it turns a
  wrong bright horizon into a sheen over whole facades, and the sun's glint into one soft ball. Fix the environment
  first; keep glass roughness low (0.05-0.08) once it is right, rising only where the normal varies within a pixel
  (specular anti-aliasing) or where the panes a pixel covers are too small to show their own tilts.

## 3. Glass

- Dielectric: Fresnel F0 = 0.04, metalness 0. Head on, it reflects 4 % and shows the interior; at grazing angles it
  mirrors the environment. A facade seen obliquely in shade therefore reflects the **ground and neighbours** in its
  lower half and the shaded sky in its upper half: dark, with a brighter top.
- **The sun's glint** comes only from the direct light, shadowed, on panes whose (slightly tilted) normal reflects the
  sun toward the camera: panes catch it one by one, never a whole facade at once.
- **The interior** is dark during the day (a measured dark base colour is right). At dusk and night a sparse share of
  rooms is lit (warm, varied, by floor and bay): glass reads as glass, not mirror.
- **Glass in shade with nothing bright in front of it is dark.** If it glows, the environment is too bright or
  unoccluded: that is a fault, not a style.

## 4. Diagnose glare and flat light

1. **Name which of the three it is.** Toggle the direct light, then the environment: the glare that stays is the one.
2. **Measure on the rendered picture**, in the same view before and after:
   - mean luminance of shaded glass against the lit wall beside it (shaded glass should sit well under the lit wall);
   - shaded glass against shaded wall (glass in shade should not out-shine the wall around it unless the sky really
     faces it);
   - the share of glass pixels above a highlight threshold away from the sun's glint.
3. **Look at the environment itself:** render the probe's cube faces. A bright, blue-white band where the scene shows a
   warm sky, or sky below the horizon, is the cause.
4. **One change at a time;** keep it only if the measures move the right way and the picture agrees.

## 5. In Scratchbox

- **Rigs:** `lighting_configure_gaffer_rig` builds photographic key-fill-rim rigs at real stop ratios around a subject.
- **Staged buildings (pipeline K):** one material path for every surface (user decision, 2026-11-05): each texel's
  detected material carries its library set's occlusion, roughness, metalness and normal, and the viewer reflects the
  scene's probe on every texel by those numbers alone; there is no separate glass layer, glass weight or pane tilt.
  The set's height is drawn too (`stagedBuild/heightRelief.ts`): a recess of at most 3 cm marched as parallax within
  30-70 m, its slope a fine normal and its depth dimming the ambient light, and within 14 m the lowest storey's displaced
  geometry in place of the flat facade. A grazing-angle close-up that looks flat means the class's set has no height
  (the build note names each set's recess), not a lighting fault.
  `reflectionProbe.ts` captures the environment (its fallback sky is what the probe sees where no geometry was drawn);
  `stagedBuild/facadeMaterialLook.ts` applies it, with the ground below the horizon (`GROUND_ALBEDO`), the probe's
  diffuse light left out and specular anti-aliasing. The sky dome and sun come from the scene's atmosphere
  (`syncAtmosphere.ts`). Changes to facade light go there, measured with section 4 on the Empire State Building in sun
  and in shade.
- The measurements below were taken while pipeline K still drew a glass layer (weight, pane tilt, recess occlusion); they
  stay as the record of what the probe and the sky do, not as a description of today's shader.
- **Measured on the Empire State Building (2026-10-28, late afternoon sun at 36°, view settled):**
  - the glass probe holds **no** sun disc in this scene (its brightest texel 0.85 with or without the disc removed), and
    the sky dome's cosine-weighted mean radiance already equals the sky light's (0.1096 vs 0.1095: the scene derives the
    hemisphere light from the sky). The sky is brightest in the hazy band just above the horizon (about 0.85, 8 times
    the mean), and a vertical pane mostly reflects that band: on shaded glass the environment is 58% of what it shows;
  - dark ground below the horizon (now `GROUND_ALBEDO`, 0.15) cut the environment on shaded glass 7%; the recess
    occlusion (since removed with the glass layer) about 1% more; walls unchanged;
  - a capture hook that drew the sky without its sun and at the sky light's strength changed nothing here and cost a
    full sky re-bake per capture: not kept.
  - **the sun's glint read as one soft, banded ball** (2026-10-28, sun 34 degrees up, camera 260 m out on the sun's side):
    the glass roughness floor (0.12) spread the sun's image over a dozen bays, and the pane tilt faded out while panes
    were still 2-4 pixels across, so every pane mirrored at one angle; the piers cut that one disc into stripes. A floor
    of 0.08 and the tilt kept until a pane is under a pixel (its spread then handed to the roughness) took the glint from
    1,117 to 575 bright pixels and 33 to 45 pieces, its largest piece from 33% to 27% of them, with no more shimmer as
    the camera moves (frame-to-frame glint energy change 0.088 vs 0.089 at 260 m, 0.037 vs 0.044 at 450 m). Kept. A
    floor of 0.05 shimmered (0.159); dropping the fade outright shimmered at 450 m (0.111); capping the specular
    anti-aliasing on glass changed nothing here. The camera's lens flare (when it is on) adds a halo disc round the
    glint that spills past the building's edge: that part of the ball is the lens, not the glass.
  - **shaded glass brighter than the stone around it** (2026-10-29, run 138bb104 with material regions on, New York sky at
    14:00, sun 27 deg up; views 230 m out, 110 m up): shaded glass measured 1.81x the shaded wall, the environment 72% of it.
    The panes were seen nearly head-on (median incidence 15.5 deg) at glass weight 0.5, yet the environment term was
    0.168 x probe radiance x weight, four times a dielectric's ~0.04: the shader also gave glass texels the probe's
    diffuse irradiance, so their photo colour was lit by the hemisphere fill and by the probe again. With the probe's
    irradiance kept to metal (`facadeMaterialLook.ts`), shaded glass is 0.59x the shaded wall, the environment 14% of it
    (0.066 x radiance x weight), shaded glass 0.15x the lit wall, glass in sun 0.65x the lit stone; the walls unchanged
    (lit / shaded 5.0). Kept.
  So the earlier reading below (horizon sky at grazing Fresnel) was not the main cause on this view: check the reflection
  term against Fresnel at the measured incidence before blaming the sky.
  So glass in shade reading bright on this scene is mostly the real horizon sky at grazing Fresnel. If it still reads as
  glare, look next at the glass's base colour and roughness floor and at the viewer's exposure, measured as in
  section 4, before touching the sky.

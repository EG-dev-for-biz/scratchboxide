# De-lighting, geometric shaping and material identification: research and plan

Date: 2026-10-28. Status: plan, nothing built. Scope: staged-location buildings (pipeline K first), then districts.

These three are what make the app's buildings read as real. They depend on each other in one order:

1. **De-lighting first.** Wrong albedo breaks material identification (a shaded wall reads as a dark material, which is
   how "dark class = metal" happened) and glass (a reflection mixed with baked shadow).
2. **Material identification next.** It tells shaping what is window and what is wall.
3. **Shaping last.** Better geometry then makes the de-lighting more exact. So it is a loop, but de-lighting is the root.

Every step below is measured before and after on an uncached build, and kept only if its measure improves and nothing
else gets worse (scene-healing skill §2, gaffer skill §4). Measures are defined in §5; each phase names the ones it
must move.

## 1. Where we are

| Area | Today | What goes wrong |
|---|---|---|
| De-lighting | Per-photo image heuristics in the twin: shadow lift, then harmonise (`texture-harmonize.ts`: a gain per photo, seam offsets). No sun direction. Since a7055292, an opt-in sky-visibility de-light (`pipeline-k/sky-delight.ts`, `SCRATCHBOX_K_SKY_DELIGHT=1`): wall texels divided by a smooth gain (about 0.95-1.27 on the ESB) after the roof-shadow lift and before harmonising, roofs untouched, reported as `twin.skyDelight`. That is the V_sky term of §2 on its own; phase 1 adds the sun term and the fit, and measures this step with M1-M3 first. | Shaded walls stay darker than lit walls of the same stone; cast shadows stay baked in; the viewer then lights the photo again (double shading). |
| Material identification | CIELAB appearance classes matched to library sets by colour (`material-regions.ts`, `material-sets.ts`); openings from the window fit; off by default since 2026-10-28 because openings' finishes were wrong. | Colour cannot tell glass from dark stone; it judged raw (shaded) colour, not albedo. |
| Shaping | Wall planes flattened (tile_refine), lattice rebuild on the photo's lines (`facade-lattice.ts`), whole-wall sheets (`wall-sheets.ts`), infill, base cleanup. | Melted massing where the scan is poor; noisy detail (sills, mullions, cornices) at the scan's ~8 cm; soft arrises. |

What we have that few others have: measured geometry under every photo, Google's vector footprints, Solar API roof
facets, registered Street View panoramas, and the wall grammar (bays and repeats per wall).

## 2. De-lighting: invert the light with our own geometry

### Model
A texel's photo value is approximately

    photo = albedo x ( V_sun * E_sun * max(0, n . s) + V_sky * E_sky )

where `s` is the sun direction, `V_sun` sun visibility (shadow), `n` the normal, `V_sky` sky visibility (ambient
occlusion / bent normal) and `E_sun`, `E_sky` the sun and sky strengths. We know `n`, can compute `V_sun` for any `s`
and `V_sky` from the scan. Unknown per tile capture: `s`, `E_sun`, `E_sky` (and a sky colour). A tile's photos were taken
at one moment, so that is a handful of unknowns per tile, fitted over thousands of texels.

### Method
1. **Sky visibility** per texel: bake AO and bent normal from the scan (native, from the welded extraction).
2. **Sun direction** from the photo's own shadows: for candidate directions, cast shadows from the scan; keep the
   direction whose shadow map best matches the photo's dark regions (correlation of predicted shadow with log
   luminance, on surfaces facing alike). No capture date needed.
3. **Sun and sky strength** from the same material lit and in shade: lit/shaded ratio = (E_sun * n.s + E_sky * V_sky) /
   (E_sky * V_sky); the albedo cancels. Fit by least squares over matched pairs across shadow edges.
4. **Albedo** = photo / predicted shading, bounded (shading floor, an albedo cap) and blended back toward the photo where
   the fit is poor: shadow edges the scan cannot resolve, foliage, moving objects. Labelled `photo-inferred` with the
   fitted parameters and residual in the extras.
5. **Keep the heuristic as fallback** where step 2 finds no confident direction (overcast, no shadows), with that reason.

### Prior art
- Song & Qin, ISPRS 2022: model sun and sky from known geometry and capture date for aerial photogrammetry; fewer shadow
  artifacts than Agisoft De-Lighter. We differ by fitting the sun from the shadows.
- Unity de-lighting tool: needs AO, normal and bent-normal maps, as here.
- Olbedo (CVPR 2026): a large aerial albedo/shading dataset; diffusion models fine-tuned on it improve outdoor albedo.
  Candidate second opinion where geometry is weak (trees, small detail). Adopting any learned model is a user
  decision (AGENTS.md §2 lists the supported models).

### Measures this phase must move
- M1 lit/shaded albedo ratio on the same material (target: toward 1.0).
- M2 shadow-edge contrast left in the albedo (target: down).
- M3 seam steps between photos (must not rise).
- Outside check: untextured, smears and holes (must not rise).

## 3. Material identification: physics cues before appearance

### Cues, most reliable first
0. **The vision reader (the base to build on; user decision, 2026-10-29).** Since 750c776f, `pipeline-k/facade-reader.ts`
   (step `remesh.facadeRead`, on whenever a vision model is available) reads every plane, roofs and terraces included,
   in zones: each window with its panes, self-judged. On the ESB tower it read 910, 964 and 615 windows where every
   brightness fit failed. Each zone carries a glass reading in `window_fit.json` (`entry.glass[]`: region in photo
   pixels, label, transparency, reflectivity, tint, opaque); material regions now put glass on read panes only, and the
   spandrels get the frame's finish (`material-regions/28`). The cues below confirm, refine or veto its reading; they do
   not replace it. Next step not yet wired: the zone's tint and reflectivity drive the glass material.
1. **View-dependence (specularity).** Glass changes with view; stone does not. The tile atlas has already fused its
   views, but registered Street View panoramas give several views of each facade texel. High variance across views,
   after de-lighting, marks glass. Prior art: Drauschke & Mayer (ISPRS 2015) found windows by multi-view colour
   variation; reflectance-residual features have been used for building materials from multi-angle satellite views.
2. **Shape context.** Recessed, inside a bay, on a repeating grid: likely glass. Proud and continuous up the facade:
   structure. Read from the wall grammar and lattice already built.
3. **Albedo, not raw colour.** After §2: stone about 0.3-0.6; dark glass low with sharp reflection; painted metal low and
   even.
4. **Open-vocabulary segmentation** on straightened orthos and Street View crops (`vfx_segment_subject`): "window
   glass", "stone pier", "metal spandrel", "awning". The 2023 work on holistic inverse rendering of facades uses
   zero-shot segmentation as a regularizer, because otherwise smooth glass is not recovered.
5. **An architectural reading** by a vision model (open labels with confidence) as a weak prior.

### Method
Combine the cues into a probability per region (bay, pane, structure strip), not one hard class: a per-region
classifier over the cue features, with a spatial smoothness term along the facade's grid. Draw a material only above a
confidence; below it, keep the photo with its reason. Labels stay open (`(string & {})`); execution reads continuous
material parameters (roughness, metalness, specular, transmission), never a class name.

### Measures this phase must move
- M4 window precision and recall against the hand-checked sets (`docs/research/2026-10-27-fenestra-checked-sets/`).
- M5 glass-on-wall: share of glass texels that fall on structure in those sets (target: near 0).
- M6 material agreement with Street View crops (classified the same way).
- Outside check unchanged or better; the gaffer skill's shaded-glass ratio held.

## 4. Geometric shaping

1. **Clean solid as the backbone, the scan as relief.** From the vector footprint, Solar API roof facets and the scan,
   build a clean LoD2 polyhedral solid (ideas from 3DBAG roofer, City3D, PolyFit and kinetic shape reconstruction; ideas
   only, several are GPL or CGAL-licensed). Store the scan's signed offset from the solid as measured relief. The shape is
   clean, the detail measured, nothing invented. Labels: solid `vector-modelled` + `measured`, relief `measured`.
2. **Average geometry over repeats.** The photo is already averaged over repeated bays; do the same for depth: sills,
   mullions and cornices, averaged over every repeat of a bay and storey, so 8 cm noise becomes a crisp mean profile.
3. **Feature-preserving sharpening.** Edge-preserving normal filtering, then snap to the fitted planes, so corners and
   cornice lips regain their arris (and catch the light).
4. **Facade detail from Street View** (the Texture2LoD3 idea): sills, frames and recess depths read from registered
   street-level photos, inside the footprint, labelled `photo-inferred`.

### Measures this phase must move
- M7 plane-fit RMS and corner sharpness on the rebuilt walls.
- M8 relief agreement with the raw scan (RMS of the backbone-plus-relief surface against the scan).
- M9 repeat consistency: depth variance across repeats of one bay (target: down, without the mean moving).
- Building seam census (scene-healing-dev skill) and outside check: must not get worse.

## 5. Measurements to take (before building anything)

Baseline on the Empire State Building (pipeline K, uncached) and one district (Washington Square Park), recorded in
`docs/processes/` with a README row.

| # | Measure | How |
|---|---|---|
| M1 | Lit/shaded albedo ratio | Pairs of texels across shadow edges on surfaces of one appearance class and equal normal; median ratio of de-lit values |
| M2 | Shadow edges left in albedo | Gradient magnitude of the de-lit texture along predicted shadow boundaries, against the photo's |
| M3 | Seam steps between photos | The harmonise step's own seam residual, before and after |
| M4 | Window precision / recall | Against the hand-checked sets, IoU 0.5 |
| M5 | Glass on wall | Glass texels on structure cells in the checked sets |
| M6 | Material agreement with Street View | The same classifier on registered Street View crops; agreement per region |
| M7 | Plane RMS and corner sharpness | Per rebuilt wall: RMS to its plane; dihedral sharpness at corners |
| M8 | Relief fidelity | Surface-to-scan RMS and coverage |
| M9 | Repeat consistency | Depth variance across repeats of one bay type |
| QC | Outside check, seam census, shaded-glass ratio | `pipeline_k_visible_defects*.json`; scene-healing-dev census; gaffer skill §4 |

Also record per-phase cost: build time and memory.

## 6. Plan

| Phase | Work | Done when |
|---|---|---|
| 0 | Measurement kit: M1-M9 as scripts over a build's outputs; baselines on the ESB and Washington Square Park | Baselines recorded |
| 1 | Geometry-driven de-lighting, offline on the ESB tiles: AO and bent normal bake, sun-direction fit, sun/sky strength fit, bounded division | M1 toward 1.0, M2 down, M3 and QC not worse |
| 2 | Wire de-lighting into the twin, in place of the heuristic where the fit is confident | Same measures on an uncached build |
| 3 | On the vision reader's windows: wire its tint and reflectivity into the glass; add the Street View specular-variance and shape-context cues as confirmation or veto, per region | M4 up, M5 near 0 on the checked sets |
| 4 | Material regions back on, driven by phase 3 and de-lit albedo | M6 and QC hold; the user reviews screenshots |
| 5 | Backbone solid plus measured relief; geometry averaged over repeats; feature-preserving sharpening | M7-M9 better, QC not worse |
| 6 | Street View facade detail (sills, frames, recess depths) | M8 holds; screenshots reviewed |

Decisions needed from the user: whether to adopt a learned intrinsic or material model (phase 1 fallback, phase 3
segmentation beyond the existing segmenter), and whether the backbone solid replaces or complements the lattice
rebuild on walls the lattice already handles well.

## 7. Considered and set aside for now
- Provenance- and saliency-weighted edge collapse for LOD: right for building LOD, but not one of these three areas.
- Poisson-disk scatter, Voronoi cells, offset and Chaikin smoothing, constraint placement: useful for generators; they
  do not move de-lighting, shaping or material identification.
- Watertight mesh repair aimed at 3D printing (most of the mesh-repair topic): the wrong goal for scenes (the seal's caps).
- Render, judge, fix-when-confident (Suzanne): the pattern belongs to the QC step, not to these phases.

## Sources
- Song & Qin, intrinsic decomposition for aerial photogrammetry, ISPRS 2022: https://arxiv.org/pdf/2204.04142
- Olbedo, CVPR 2026: https://arxiv.org/html/2602.22025v1
- DeRenderNet: https://ar5iv.labs.arxiv.org/html/2104.13602
- Unity de-lighting tool: https://digitalproduction.com/2017/07/14/photogrammetrie-workflow-unity-delighting-tool/
- Drauschke & Mayer, window detection from specular reflections, ISPRS 2015: https://isprs-annals.copernicus.org/articles/II-3-W4/33/2015/
- Holistic inverse rendering of complex facades: https://ar5iv.labs.arxiv.org/html/2311.11825
- SAAF, wall and window segmentation (2025): https://www.arxiv.org/pdf/2506.09071
- 3DBAG roofer: https://github.com/3DBAG/roofer ; City3D: https://github.com/tudelft3d/City3D ; PolyFit: https://github.com/LiangliangNan/PolyFit ; CGAL kinetic reconstruction: https://doc.cgal.org/latest/Kinetic_surface_reconstruction/index.html
- Texture2LoD3: https://arxiv.org/abs/2504.05249

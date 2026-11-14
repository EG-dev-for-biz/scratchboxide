# ESB from measurements: a procedural rebuild against Pipeline K (experiment, 2026-11-07)

> **Question (user, via MAIN):** how close can our procedural 3D engine get to the Empire State Building when it is driven by every measurement we already hold for it, with none of the scan's own surface in the final model?
> **Inputs:** local caches only, from the 2026-11-06 benchmark run `1f1a6717` (`benchmarks/2026-11-06-main/main/esb/`): K's isolate and twin, tile_refine's facade orthos and `facades.json`, the facade reader's records and readings, and the material classes. No cloud downloads and no model calls ($0).
> **Status:** experiment. Nothing here is wired into the app. MAIN judges.
> **Artefacts** (outside the repo, in the session notes folder `…/side-session-notes/local_c64a1c20-…/esb-procedural/`): the measured spec (`esb_measured_spec.json`), the procedural GLB, the generator (`measured_spec_build.cpp`), the spec builder, the render and metric scripts, and the sheet `esb_procedural_sheet.jpg`.

## 1. What was measured (the spec)

Every value in the spec carries `{value, provenance, source}`.

| Quantity | Value | How | Provenance |
|---|---|---|---|
| Frame | walls at 28.9° | `scratchbox_shape_program.hpp` `analyseScan` over K's isolate (the scan's vertical walls; the footprint gives 29.6°) | measured |
| Setback tiers | 15 prisms from the street to 332 m, each with its traced and squared outline. Levels: 4.8, 11.9, 13.8, 21.0, 22.3 (podium), 76.7, 92.2, 111.4, 262.7, 295.3, 312.1, 318.5 (86th-floor deck), 325.0, 328.2, 332.4 m | height-map tiers: mean-shift modes of the up-facing area, 0.25 m grid. Raised `maxTiers` to 16 and lowered `minTierShare` to 0.001 so the slender upper tiers survive | measured |
| Mast and antenna | 108 slices of 1 m from 332.4 m to 439.9 m. Each slice has 32 sector radii (95th percentile), cut into 41 steps. The shaft is r ≈ 5.5 m with 4 stepped buttress lobes (r_max 10 → 7.5 → 6.6 m); the lantern r ≈ 5 m reaches 378 m; the antenna stages are r 1.5 / 1.0 / 0.5 m | area-weighted surface samples of the scan above the deck | measured |
| Storey pitch | 3.52 m | facade reader: median of 38 zones that agree within 0.15 m. Autocorrelation of the photos gives 3.51 m | photo-inferred |
| Bay pitch | 5.59 m | K's straightening: median facade repeat, `periodM` | photo-inferred |
| Pier layout | 22 facades read: about 1.5 m limestone piers, 7 bays on the 40.8 m shaft faces, 10–11 piers on the 56.4 m faces | bright-column runs (Otsu) of K's harmonised, straightened facade photos. A facade counts as read when coverage ≥ 0.6, there are ≥ 3 runs, and contrast ≥ 30 | photo-inferred |
| Pane width | 1.5 m | sub-column autocorrelation of the photos: 1.39–1.57 m | photo-inferred |
| Opening share | 0.55 of the storey | facade reader openings over 49 zones (IQR 0.38–0.67, a wide spread) | photo-inferred |
| Pier relief, glass recess, mullion width, parapet | 0.12 m, 0.10 m, 0.10 m, 1.2 m | **not measurable:** the raw scan folded at the bay pitch shows under 5 cm of relief, i.e. noise | generated |
| Materials | piers: class 2, L 58.9, roughness 0.75 ("weathered limestone piers"). Spandrels: class 1, L 49.0, roughness 0.45, metal 0.8 ("cast aluminum spandrels"). Glass: class 0, L 39.6. Library maps: K's own picks, Plaster005 at 1.5 m and MetalPlates008 at 2.0 m (normal + ORM from the model readings store) | K's material classes (CIELAB means) and the vision model's finish reading | photo-inferred (colour); the library tile sizes are generated |

The facade reader's window boxes are kept in crop pixel coordinates, so they were not mapped back to the planes. The grid comes from the photos and the reader's pitches instead.

## 2. What was built

`measured_spec_build.cpp` is a generic spec → GLB driver of about 400 lines. It names no building and no part kind. It uses the four operators:

1. **Prism sweeps:** each measured tier outline is extruded between its levels, with its roof cap triangulated by `scratchbox_cdt.hpp`.
2. **Affine replicators:** piers, bays and panes along every wall.
   - Piers come from the photo of the matching plane (same normal within 14°, within 2 m, over half the height).
   - Otherwise piers are laid at the measured median rhythm (labelled generated).
   - Bays repeat at the storey pitch; panes repeat at the pane width.
3. **Isoparametric relief:** bays sit behind the pier face, and glass sits behind the bays with reveal faces.
4. **Harmonic solid of revolution:** the mast is built from the sector radii, truncated to 8 harmonics and stepped where the profile steps.

Every node carries `extras.sb.provenance` and its source:

| Node | Provenance |
|---|---|
| tier masses, mast | measured |
| piers read from a photo | photo-inferred |
| piers laid at the rhythm, bays, glass, parapets | generated |

Output:

| | Value |
|---|---|
| Triangles | **131,390** (K's twin: 863,633) |
| Panes | 8,079 |
| Walls with photo-read piers | 35 |
| Walls on the measured rhythm | 95 |
| Plain walls (short or under one storey) | 222 |
| Mast steps | 41 |
| GLB size | 10 MB (K's twin: 149 MB) |
| Build time | under 1 s, natively |

**Hybrid:** the same generator with `hybrid` set. Any wall matched to a photographed plane (178 walls) takes K's harmonised facade photo, projected through that plane's own ortho frame (`centroid`, `axisS`, `axisT`, `orthoSMin`, `orthoTMax`, `pixel`) onto the procedural relief.

## 3. Comparison at the same cameras

There are nine cameras, all placed from the scan's box and identical for every model:

- the building benchmark's four (headings 45/135/225/315, pitch 15°, 35° vertical field of view, 640×800);
- two street views at a 1.7 m eye height;
- one view of the setbacks between the 72nd and 86th floors;
- one of the mast and antenna;
- the glass benchmark's stone close-up.

All are rendered with the native path tracer (`NativeTilePathTracerService`, 12 spp, denoised). The procedural model is relit (sun at 45° elevation, azimuth 135°). The hybrid, K and the scan are rendered in baked mode, as in the building benchmark.

**Silhouette IoU against the scan** (depth > 0 masks):

| View | procedural | hybrid | K |
|---|---|---|---|
| benchmark 45° | 0.978 | 0.981 | 0.987 |
| benchmark 135° | 0.977 | 0.980 | 0.985 |
| benchmark 225° | 0.979 | 0.980 | 0.987 |
| benchmark 315° | 0.973 | 0.976 | 0.983 |
| street SW | 0.994 | 0.994 | 0.993 |
| street NW | 0.992 | 0.992 | 0.995 |
| setbacks | 0.988 | 0.988 | 0.997 |
| mast and antenna | 0.952 | 0.952 | 0.959 |
| facade close-up | 0.997 | 0.998 | 0.998 |

**Height and setbacks.** Each model is rasterised to the scan's own 0.25 m height grid and compared with it:

| | procedural | K |
|---|---|---|
| height MAE | 1.85 m | 1.82 m |
| median absolute error | 0.31 m | 0.02 m |
| top | 440.2 m | 440.2 m |
| plan IoU per tier, street to the 86th-floor deck (318.5 m) | 0.96–0.99 | 0.96–0.99 |
| plan IoU, upper tiers | 0.92 / 0.87 / 0.94 / 0.84 | 0.96 / 0.98 / 0.97 / 0.85 |

**Window grid:**

- The storey pitch agrees with 38 of the reader's 66 zones within 0.15 m. Three zones are double-storey readings; the other 25 are the reader's known pitch errors.
- Before the long shaft faces (2 and 29) were admitted at coverage 0.6, the even rhythm placed only 36–40% of their photo piers within 0.75 m. Their real layout is not even: it has a narrow-pier triplet section in the middle. With the photo's runs the piers sit where the photo has them.
- The rhythm is good enough for pier *count* (exact or ±1 on the long faces). It is not good enough for *position* on irregular faces.

**Photo-match judge: not run.** It needs held-out Street View panoramas, and none are cached locally for the ESB (only `streetview/metadata.json`). Fetching them would break the local-caches rule for this experiment. In this note, "the real photos" means the scan's own photogrammetry texture.

## 4. What the procedural build gets right, and where it falls short

**Right:**

- **The silhouette and setbacks.** IoU is within 0.003–0.010 of K in every benchmark view and equal at street level. Every setback level is the measured one.
- **The mast's profile only.** The step heights and radii (shaft, lantern, antenna stages) come from measured radii. Its surface does not match: the scan's mast has a lattice, buttress fins and a dark ring, while the procedural mast is a smooth stepped solid and the antenna a plain dark column. It is the weakest view (IoU 0.952), and an independent visual check called it a mismatch.
- **The pier rhythm in close-up.** The procedural piers line up with the scan's in count and spacing.
- **Cost.** The model has 15% of K's triangles and 7% of its file size, and builds in under a second with no model calls.
- **A clean, closed solid.** It is watertight per tier, with no holes or tears. K's run flagged 0.73% of views showing holes.

**Short:**

- **Texture and weathering.** This is the big gap, and the independent visual check named it the biggest visible difference. Flat class colours plus library normal/ORM maps cannot carry the red-brown window bands, the blinds, the lit windows, the staining and the colour drift that make the scan read as *that* building. In the overviews the procedural model reads as a clean grey replica.
- **Ornament.** The Art Deco spandrel panels, the podium friezes and entrances, and the eagle and setback ornaments are not built. The reader names them, but nothing measures their shape.
- **Relief depths are guesses.** The scan resolves none of the pier, spandrel or reveal depths at tile resolution, so every depth is generated.
- **The podium.** The punched-window and pilaster facades (35, 27, 59, 78) fail the read gate (photo contrast 13–23), so they get the shaft rhythm, which is wrong for the podium. Low-coverage facades (37, 3, 5, 10, 8, 13) also fall back to the rhythm.
- **The upper tiers.** The tiers between 325 and 332 m are squared boxes (IoU 0.84–0.94). The mast's material split at 378 m is a guess.

## 5. Would a hybrid beat K?

The hybrid (procedural structure carrying K's photos) is close to K in every close-up and gains about 0.002–0.003 IoU over pure procedural. It is not better than K:

- **The texture comes from K anyway.** Its photos are K's harmonised photos, so its look equals K's, including K's washed-out window bands. The scan's own photo is visibly redder and more contrasted than K's harmonised twin in the close-ups, which is a finding about K's harmonising rather than about this experiment.
- **Unmatched surfaces fall back.** The roof caps, the mast and the plain walls fall back to flat procedural materials, which read worse than K's photo-textured scan in those places (see the mast row).
- **The mesh trade-off.** The hybrid gives up K's measured mesh (median height error 0.02 m against the procedural 0.31 m) for a clean, holeless and much lighter one.

**Verdict for MAIN:**

- **For the hero building:** procedural from measurements does **not** beat K. Shape is near parity, but texture, ornament and every relief depth are worse or generated.
- **Where it has a case:**
  1. as a **fallback or LOD** for K: a closed, 131k-triangle, holeless model that matches K's silhouette within about 1%, useful for distant district buildings or where K's closure leaves holes;
  2. as a **regularity prior**: the measured spec (tiers, storey and bay pitch, pier runs) is the same evidence K's lattice and wall grammar already use.
- **Not a candidate:** the hybrid as the hero pipeline. It would need the procedural grid to carry K's photo where the geometry differs, which is K's own lattice job.

## 6. Reusable pieces and recommendation

- **The measured-spec extraction** (tiers from `analyseScan`, the mast from sector radii, the photo pier runs, the rhythm, and the materials from K's classes) is about 150 lines of Python over a finished K run's records. It would only be worth porting into the app if MAIN wants the LOD/fallback use above.
- **The generator** is a small generic driver that fits `scripts/` under §3.4 (a reusable CLI driver for engine headers, not a scene file).

**No draft PR is opened.** Neither piece improves a pipeline output today (class 3 for integration as a pipeline replacement, class 2 at best as a district LOD tool). That decision is MAIN's.

**If MAIN wants the LOD path, the next steps are:**

1. port the spec builder to TypeScript inside `pipeline-k/` and read K's run in memory;
2. move the generator into `scripts/` with a parity test on a real cached building;
3. test it at Penn Station's district, where K-D's far buildings are the candidates.

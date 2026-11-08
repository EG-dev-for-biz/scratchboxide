# The measured procedural twin of the Empire State Building, built in the app

**Date:** 2026-11-07 · **Target domain:** Real-world 3D locations (procedural rebuild from pipeline K measurements) · **Status:** Verified in the live app (chat → `location_measured_twin` → scene); the twin matches K's shape but not its close-up surface

## What it is

`location_measured_twin` (Google 3D Tiles pack) makes a procedural twin of a finished pipeline K building with none of the scan's surface in it. The native generator (`scratchbox_measured_twin.hpp`, CLI `scripts/measured_twin.cpp`) builds it from K's records (`measured-twin.ts`):

- **Massing (measured).** The tree-free scan's height-map tiers, each a prism with a flat cap.
- **Slender top (measured).** Where the scan above a tier is slender and tall, it is revolved from per-slice sector radii. These are smoothed harmonically and over three slices up the axis, then merged into stepped bands.
- **Windows (photo-inferred).** Every window box K kept (`window_fit.json`) is mapped through its plane photo's frame onto the prism wall it stands on, punched and recessed. Each opening gets reveals, its read panes as glass, and the frame between the panes.
- **Colour (photo-inferred).** Every element (a wall cell split at the window column lines, a reveal, a pane, a frame, a roof or mast cell) takes the median of the scan's own photo over it.
- **Material (photo-inferred).** The nearest of K's appearance classes, with the class's library normal and ORM maps at real size.

Three corrections are labelled generated:

- **One photo per wall.** A wall takes its windows from its best photo. Another photo's box fills only spans with no window near, so two photos' grids never interleave.
- **Storey phase.** A wall whose windows split into two storey phases keeps the phase whose boxes hold more fine detail in the photo, and moves the rest onto it. This fixes K's reader putting neighbouring columns half a storey apart.
- **Continued rows.** Rows step on at the wall's pitch into spans K never read, where the photo there looks like the wall's windows rather than its stone.

The reveal depth is photo-inferred when the reveal-depth stage read a trusted value from Street View. Otherwise it is a generated 0.12 m.

The tool also renders four proof views (two obliques, a facade close-up, the top). They go to the chat model and the turn's reviewer as images, and the result carries the GLB's absolute file path.

## Run

- **Build:** cached pipeline K run `493d1ee7` of the ESB, from the 2026-11-07 window-array benchmark (main at b2a41010). Its model readings store provides the library maps.
- **App instance:** my own, on ports 3130/3131/3132, with the run linked into the worktree's `.scratchbox/cache`.
- **Cost:** the build makes no model calls. The chat turns used `gemini-4-argon` (a few calls).

| Step | Result |
|---|---|
| Chat: "Build the measured procedural twin of the Empire State Building from staged run 493d1ee7" | The chat called `location_measured_twin` (33 s, first native build included). It opened a new scene, *Measured twin (run 493d1ee7)*, and the viewport drew the twin with its photo colours and materials. |
| First attempt (before the tool rendered views) | The turn's reviewer scored 3.0/10 because no renders were shown. The chat then guessed image names that did not exist (`…_audit_0.png`) and failed `workspace_view_image` and `path_trace_render` calls. The tool now renders its own views. |
| Second attempt | No failed calls from the tool path. Review round 1 scored 6.7/10, with one fix asked for: jagged mast steps. Round 2 passed at 8.3/10. One `mesh_apply_deformers` call was correctly refused, because the GLB has several materials and textures. The mast smoothing was then added to the generator: 108 → 58 bands. |

**Twin (final generator):**

| Measure | Value |
|---|---|
| Tiers | 13 measured, plus a revolved mast from 324.9 m in 58 bands to 439.9 m |
| Windows | 5,690 punched out of 7,844 K kept. 5,023 as K read them; 584 re-phased on 8 walls and 58 continued (both generated). Dropped and counted: 1,669 as duplicates of overlapping photos, 334 clipped, 198 off any wall. |
| Triangles | 235,699 (K twin 863k) |
| Photo colour | 94.7k elements coloured from the photo; 22.4k with no photo near, which take their wall's colour (mostly roof caps hidden under the tier above) |

**Against the scan, at the same 9 cameras** (native path tracer):

| | Twin | K |
|---|---|---|
| Silhouette IoU, benchmark views | 0.975–0.978 | 0.983–0.985 |
| Silhouette IoU, street views | 0.993 | 0.993–0.997 |
| Silhouette IoU, setbacks | 0.987 | 0.996 |
| Silhouette IoU, mast | 0.919 | 0.967 |
| Silhouette IoU, facade close-up | 0.997 | 0.998 |
| Height error, mean / median | 1.89 / 0.31 m | 2.18 / 0.02 m |
| Tier plan IoU, street to the 86th-floor deck | 0.95–0.99 | 0.97–0.99 |

## Verdict

- **At distance:** the twin reads as the ESB, with the light piers, dark window strips, setbacks and mast profile. It is closer to the scan's colour than this run's K twin, which is washed out.
- **Up close:** it is a clean mosaic of flat-coloured elements: straight strips, aligned storeys and recessed windows. It is not photoreal, because each element has one colour.
- **Mast:** it keeps its stepped profile but loses the lattice and the observation ring.
- **Use:** a light, watertight, fully labelled stand-in, for example far buildings in a district. It does not replace K for a hero building. MAIN decides whether to take it.

## Round two: detail textures from each wall's own storey repeats (2026-11-07)

**What changed.** A wall with windows from a photographed plane now carries a detail texture.

- **Source:** the plane's straightened photo, which is the scan's own photo, straightened by K.
- **Each texel:** the median of that point and the same point 6 storeys up and down, so one-off reflections, lit windows and smears are outvoted.
- **Colour:** each element's measured colour is baked over its own rect as a square-root gain.
- **Atlas:** 85 walls at 0.12 m share one 4096 x 1744 atlas (4.2 million texels).
- **Unchanged:** the geometry stays procedural. Roofs and the mast keep their flat colours, since they have no storey repeats to take a median over.

**Measured against the scan's photo** at the same 9 cameras, unlit colours:
- dE is the mean CIELAB difference.
- "detail" is the correlation of fine luminance detail (luminance minus its 5 px blur) with the scan's.

| | Flat twin | Detail twin | K twin |
|---|---|---|---|
| dE, benchmark views | 4.6–5.6 | 3.9–4.6 | 8.9–10.1 |
| dE, street views | 6.9–7.3 | 5.3–6.0 | 13.5–14.2 |
| dE, setbacks | 8.2 | 7.0 | 9.9 |
| dE, facade close-up | 9.5 | 6.3 | 13.1 |
| detail, benchmark views | 0.79–0.81 | 0.87–0.88 | 0.86–0.89 |
| detail, street views | 0.27–0.36 | 0.67–0.68 | 0.69–0.71 |
| detail, setbacks | 0.19 | 0.45 | 0.59 |
| detail, facade close-up | 0.04 | 0.57 | 0.55 |
| Mast | dE 11.0, detail −0.03 | unchanged | dE 8.3, detail 0.64 |

**Two variants that lost:**
- **K's harmonised twin photos as the source:** dE rose above the flat twin's, because K's harmonising moves the colours away from the scan's.
- **The full per-element gain:** cells read as blocks. The square-root gain keeps each cell's colour without the blocks.

**Verdict.**
- **From the street up:** the twin is now about as close to the scan in fine detail as K, and closer in colour.
- **Close up:** it reads like the photo at its own ~0.3 m detail, without the scan's one-off marks.
- **Still short:** the mast and the roofs.
- **Size:** 230k triangles and a 32 MB GLB, against K's 863k triangles and 179 MB.

## Candidate tool and service ideas

- **Mouldings as measured sweeps** (from the review of lsimic/ProceduralBuildingGenerator; GPL, so the idea only). Sweep a stepped moulding profile around each tier outline, mitred at the corners, wherever the scan's own profile at a tier edge resolves one. This would add cornices and copings without breaking the footprint rule.
- **Layered window frames.** Sweep a frame profile around each read pane, so sashes show depth and shadow. Their widths and depths are generated and labelled.
- **Detail for the mast and roofs.** Use a median over the mast's angular repeats (its sectors) and over the roof's own repeats, so they get detail textures like the walls.
- **Build from a staged scene's own run.** Pipeline K's 3D Building flow could offer the twin as a toggle beside the K layer (today it is a chat tool).

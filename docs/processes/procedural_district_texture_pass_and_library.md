# Process: The procedural district through the texture pass, with the surface library as its fill (Federation Square)

> **Recorded:** 2026-10-22
> **Status:** Verified (live build of Federation Square, Melbourne; screenshots below). Off by default: it runs with SCRATCHBOX_STAGED_PROCEDURAL=1.
> **Tags:** `operate-scratchbox` `staged-location` `procedural-district` `texture-pass` `surface-library` `provenance` `no-baked-shadows`
> **Target Domain:** Real-world 3D locations (procedural district) / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** the procedural district (SCRATCHBOX_STAGED_PROCEDURAL=1) laid the Google tile photo straight onto its rebuilt surfaces (a top-down render on the ground, photo pages on the walls, a redrawn atlas on the streets), with the photo's sun and shadows baked in. The task began as "use library materials instead of tile-photo drapes". During the session the user decided (2026-10-22, in this order): rebuild from scratch in the scan's likeness; always rebuild textures so no shadow is baked in; do not rely on repeating textures (the tiling library is the base layer); and finally "I would prefer a method like this for textures" about the staged texture pass on the Haughwout rebuild. The work ended there: the procedural layers go through that texture pass, and the library fills only where no photo texel reaches, under the whole twin as relief and sheen.
* **Instance used:** web port `3140`, API port `3141`, tools port `3142` (launch entry `scratchbox-procedural-materials`, SCRATCHBOX_STAGED_PROCEDURAL=1). Headless builds: `scripts/dev/staged-replay.ts --isolate false --query "Federation Square, Melbourne"`.
* **Scope tested:** the massing stage's procedural branch, the texture pass on the procedural layers (l2m, l1g, l2r), the library choice, the fill, the twin detail, and the viewport loading the twins.

---

## 2. What Was Tested & What Worked (Verified)

* **Library choice by vision.** 214 surfaces (after rebasing onto plane-first walls; 197 before) (the ground's appearance regions, the carriageway, the kerbs, every building's walls and roofs) measured on the tile photo's lit texels and chosen by gemini-4-argon among the whole library (ordered by measured colour): all answered (214 of 214 in the final run). With only the 6 nearest entries by chroma as candidates the lawn's own entry was missing from the lawn's list (it became fine gravel) and paving reached walls; the whole library fixed both (ground: concrete footpath, rail ballast as fine gravel, lawn, asphalt; carriageway asphalt; kerbs bluestone; walls mostly precast concrete panel, standing seam, brick, ashlar; roofs mostly corrugated metal, standing seam, precast).
* **Shadow-robust measurement.** litColour keeps the lit side of an Otsu split of log luminance (sun vs shade 1.6x or more) and drops the top 5% as highlights; otherwise the 40th-95th percentiles. Ground segmentation sets aside cells darker by 10 L* and bluer by 2.5 b* than the lit cells around them (cast shadows), which take their lit neighbours' region: the first segmentation (4 m cells, colour only) made building shadows a material of their own; the second (2 m, shadow detection, connected pieces, merged to at most 24) does not.
* **Texture pass on the procedural layers.** The layers are committed as clay with `extra.proceduralFill` and textured by the pass even though a district otherwise takes tile_refine's twin. Rung shares (Federation Square, final run on origin/main with plane-first walls): l2r 85% tile photo / 14% library; l1g 76% / 24%; l2m 43% / 55%. Lighting correction with no Street View gate (labelled "ungated: no Street View reaches the surface"), on islands as well as charts: 463 of 773 wall charts, 34 of 108 ground blocks, 22 of 64 street blocks relit. Library entries used: precast concrete panel x126, slate roof x24, concrete footpath x15, painted render x9, asphalt x8, red brick x8, and 9 more; 24 ground regions, 6,770 cast-shadow cells set aside.
* **Fixes found on the way, each measured:**
  - the streets faced down (buildRoadMesh's level quads; drawn only because the viewport's clay is double-sided): the pass found a tile surface facing the same way for 2-5% of street texels; facing up, 89%;
  - a 0.25 m transfer gate is for registered scan geometry; rebuilt surfaces stand off the scan by their fit: 1.5 m;
  - one ground island of 500 m was one image the relighting model could not take (0 of 1 accepted); 48 m blocks: 31 of 108;
  - 2048 atlas: the district's walls at a third of the photo's texel, read as blurred camouflage; 4096: the Federation Square cladding's triangles read as in the earlier photo pages (compare the plaza screenshots);
  - the fill sampled one texel of a 1 mm gravel map per 0.3 m atlas texel and read as coarse noise; it now samples the mip level of the texel's footprint;
  - one provenance entry per surface (about 200) was copied onto each of 2,295 twin nodes: a 150 MB GLB; one per library entry: 36-49 MB;
  - the detail's metallic-roughness JPEG (R 255, B metal) decoded with stray metalness and darkened the walls; R = G, B = 255, the metalness in the factor.
* **Viewport.** The twins load with `sbKeepAuthoredMaterial`; 224 twin materials carry the library detail (normalTexture and metallicRoughnessTexture on TEXCOORD_1). Console: no errors from these layers (the only errors are the Google 3D Tiles root 403 of the photorealistic backdrop).

Screenshots (docs/screenshots/, the same five cameras): `procedural_materials_before_*.png` (the previous procedural build: tile photo laid on) and `procedural_materials_after_*.png` (texture pass + library fill), views overview, top, street_a, street_b, plaza; `procedural_materials_detail_{on,off}_closeup.png` (library relief under the twin, on and off).

What the screenshots show, judged critically:
* From above and at the overview distance the after build reads as Federation Square (the plaza's Kimberley sandstone bands, the rail yards, the cladding) and is close to the before. Large grey wall areas are library fill where no tile texel reached (the precast panel entry, flat at that distance).
* At street level both are blurry: the tile photo is ~0.15-0.3 m a texel. The after streets carry less of the cars and tram shadows than the before but some relit blocks still show blue shadow blobs (42 of 64 street blocks were not relit). The before's redrawn lane markings were crisper than the photo's.
* The library relief is barely visible under the viewport's soft studio light at street distance; it shows as fine grain on the ground close up.
* The river is ground in the after build (the water sheet of procedural-ground.ts is not wired); the before showed the river from the photo.

---

## 3. What Broke / Didn't Work

* **Library entries changing under a build.** The library was pruned and regenerated during the session (69647de1 keeps only entries the critic scores at 0.5 or below): a fill spec naming `corrugated_iron` failed the texture stage once ("the surface library no longer has corrugated_iron"). loadFillSpec now takes the nearest entry by the use's measured colour and labels the substitution; the library's own version is in the texture cache key.
* **Relighting acceptance.** 40% of wall charts, 69% of ground blocks and 66% of street blocks came back rejected by the detail lock: those keep the photo's lighting (shadows included), labelled `lighting_tile_no_gain` per layer, not per chart.
* **Lane markings.** The texture pass carries the photo's markings, blurred; the redrawn markings (buildRoadMarkings, painted ribbons) are built but not in the procedural layers.
* **Remaining photo laid on as before:** the solids of revolution (l2v, coloured per height from the de-lit tile photo) and, when the texture pass is off or preparing fails, the ground, streets and massing (the earlier tile-photo versions, labelled). The tile-refine twin of the scan (l2) is the scan's own photo; it is superseded and kept as the reference.
* **Street View for districts.** None: the pass runs from the tile photo alone (a district reads no Street View); transient removal (the vehicles agent) applies to Street View views, not to the tile photo.

---

## 4. Candidate Tool/Service Ideas

* **A capture endpoint for the staged viewport** - write `__scratchbox_capture_active_3d_scene()` to docs/screenshots from the app itself; this session ran a one-off local HTTP sink to save the canvas.
* **A camera-by-name helper** (`__SB_SET_CAMERA_VIEW__` takes theta/phi/distance; every before/after pair needed a hand-rolled position-to-orbit conversion).
* **Per-chart lighting provenance in the twin** - which charts kept baked shadows is only in the run note; the provenance view cannot show it.
* **Twin swap for A/B** - comparing two twins of one layer meant copying GLBs over the published files and reloading.

---

## 5. Reproduction Steps

1. `SCRATCHBOX_STAGED_PROCEDURAL=1` (and the durable asset store holding `/models/surfaces/index.json`: `npx tsx scripts/generate_surface_textures.ts`).
2. Headless: `SCRATCHBOX_STAGED_PROCEDURAL=1 SCRATCHBOX_REPLAY_DIR=<rec> SCRATCHBOX_ROOT=<worktree> node --env-file=<.env> -r ts-node/register scripts/dev/staged-replay.ts --runs 1 --query "Federation Square, Melbourne" --isolate false`; read `runs/<id>/texture_fit.json` for rung shares and lighting, `massing/<key>/materials.json` for the choices.
3. In the app: a launch entry with SCRATCHBOX_STAGED_PROCEDURAL=1, "Stage Federation Square, Melbourne as a 3D location (whole district, not an isolated structure)"; the textured layers land with the late texture stage.
4. Library gaps seen here (scripts/surface-textures/specs.json): glazed curtain wall with mullions, zinc / perforated metal cladding, small variegated sandstone setts (the plaza: Kimberley sandstone, per the search-grounded references), rail ballast with sleepers, a water surface.

# Staged location: real-world texture pass (design)

Status: design only, nothing built. Decisions fixed by the user: Google terms and model cost are not constraints; clay stays the first result; textures are computed in the background and applied when the user picks Textures & Materials; every photo-derived value is labelled photo-inferred; a failing rung degrades one step to simpler REAL data, never to fabrication; images are decoded in memory (no temp files).

## 0. Where the code is (read first)

`packages/core/src/node/3d-engine/staged-location/*` is NOT on main. It lives on branch `push-integration` (worktree `.claude/worktrees/push-integration`, head ca4b996e; same files incl. `pano-registration.ts`, `view-match.ts`, `survey-casting.ts`, `face-survey.ts`, `photo-palette.ts`, `staged-glb-writer.ts`, `fitted-solid.ts`). All paths below are under `packages/core/src/` of that branch. The first task of this work is to land that branch on main; the texture pass builds on it.

Already there, and reused instead of rebuilt:
- Camera model: `StreetViewPoseRegistrar.frameCamera/projectToFrame/renderFrameDepth` (pinhole fx,fy,cx,cy; pose = nominal eye + `PoseCorrection{dx,dy,dz,dyaw,dpitch,droll}`), `survey-casting.castCamera/pixelRay`. `registerPanos` returns per-pano corrections plus before/after residuals (about 1.3 m residual after the live fit, 214 of 319 pairs used; two panos set aside).
- Images: `EvidenceImage` (grounding JPEG bytes in memory, `sha256`, `nativeSampleM`), `SurveyImage`, `decodeJpegInMemory` (jpeg-js) in `photo-palette.ts`; `FacePalette` (Lab k-means, CIEDE2000, `measuredFromPhoto: true`).
- Geometry: fitted surfaces carry analytic charts (`SurfaceChart` plane or cylinder, `chartPoint(u,v)` in `slot-projection.ts`); `readFittedShells` gives the closed fitted solid; `HeadlessMeshSilhouetteRenderer` gives software depth for occlusion.
- Texturing machinery that already exists in `node/spatial/` (it works on tile GLBs that have per-primitive `TEXCOORD_0`): `SurveyTextureUnprojector` (plates onto UV atlas: depth-tested, incidence-weighted `cos^gamma`, multi-station blend, optional Huber reweighting, gutter bleed, solar de-lighting, `accumulators`), `StationRadianceEqualizer` (CDF histogram matching across stations), `StreetViewTextureFusion` (tile texture T fused with Street View detail S as `T*(1+c(D-1))`, `D = S / blur(S)`; unobserved texels keep T exactly; the tile never gets softer), `AlgorithmicUvEngine` (`decomposePbr`: Scharr normals, Toksvig roughness, HBAO), `MaxRectsAtlasPacker`, `GlbTextureRecolorService`, `applyPhotogrammetricDelightShader`/`LocationObjectLightingService` (browser, runtime only).
- Not there: the name `AlgorithmicUVRewrapService` does not exist in the tree (the real one is `AlgorithmicUvEngine`). `tile_restyle` (42cf40d1/aa821d43, `tile-restyle-service.ts`) moves tile vertices and keeps images/UVs byte-identical, can only palette-regrade textures (`recolor3DTilesGlb`); it does no model enhancement. `staged-glb-writer.ts` writes POSITION, NORMAL and `_`-attributes with ONE material, `StudioGreyClay`; no TEXCOORD_0, no images. The remesh (tile_refine, `field-remesh-service`) outputs no UVs. Fitted GLBs have no UVs either. So the gap is UVs plus a texture-capable writer, not the projection maths.

## 1. Data flow

```
tiles(raw, textured) ─┐
survey/evidence panos ─┼─ registered poses (Registration) ─┐
fit (charts, shells) ──┤                                    ├─> TexturePass (background) ─> texture bundle (cache) ─> reveal on "Textures & Materials"
remesh scan (occluder) ┘   tile photo texture (tier 2) ─────┘
```

`TexturePass` starts when `evidence` finishes (poses and JPEGs in memory exist) and the `fit` and `remesh` layers are published. It never blocks or alters the clay stages. Output is a sidecar bundle per layer, cached by `stageKey(layerKey, poseHash, imageSha256s, passVersion)` in `StageCache`, then published as textured twins of the clay GLBs (same node names, same positions, same `StagedNodeExtras`, plus UVs and a material). The viewport keeps the clay GLB mounted; picking Textures & Materials swaps material, not geometry.

## 2. Contracts (typed, open-ended; in `common/spatial/staged-location-contracts.ts`)

```ts
type TexelSource = 'street-view-projection' | 'tile-photo-transfer' | 'tile-photo-enhanced' | 'generated-pbr' | (string & {});
interface TexelProvenance { source: TexelSource; label: 'photo-inferred' | 'generated' | (string & {}); method: string; panoIds?: string[]; coverage: number /*0..1 of the layer's texels*/ }
interface SurfaceUvMap { nodeName: string; kind: string /*diagnostic: 'chart-plane'|'chart-cylinder'|'atlas'*/; texelsPerMeter: number; atlasRect: [number,number,number,number]; chartId?: string }
interface TextureLayerBundle { layerKey: string; maps: { albedo: string; normal?: string; roughness?: string }; /* published file refs, bytes never on disk before publish */ uv: SurfaceUvMap[]; provenance: TexelProvenance[]; ladderRung: number; rungReason?: string; weights: 'baked per-texel confidence map ref' }
interface TexturePassRecord { passVersion: string; layers: TextureLayerBundle[]; degradations: Array<{ stage: string; reasonCode: string; reason: string }>; costUsd?: number; timingsMs: Record<string, number> }
```
`source`/`label` are open string literals; nothing branches on them. Decisions use measured quantities (`coverage`, `texelsPerMeter`, residuals). Per-texel provenance is a second channel (a `confidence` plane R=source index into `provenance[]`, G=weight) so the viewport can paint the provenance overlay the stage UI already has (`provenanceShading.ts`).

## 3. UV strategy by geometry kind

- Fitted solids (planes, cylinders): chart UVs are free and exact. Plane: `(u,v)` = chart coordinates divided by `extentUv` bounds; cylinder: `(arc=u, z=v)`. One atlas rect per surface, rect size from `areaM2` and a target `texelsPerMeter = min(nativeSampleM best view, 1/0.05)`; rects packed by `MaxRectsAtlasPacker`; 2-texel gutters. The writer gains TEXCOORD_0 from the same chart, so UV-to-3D is the analytic `chartPoint`, no search.
- Remeshed scan (quad-dominant, arbitrary topology, no UVs): per-triangle-cluster atlas. Cluster triangles by normal (angular tolerance in degrees, a continuous parameter) and connectivity into developable-ish islands, pack with `MaxRectsAtlasPacker`, fixed texel density in metres. This is new code in the native C++ path (`scratchbox_uv_engine.hpp` already has barycentric/tangent helpers, not an unwrapper). Vertices on island borders are duplicated; clay positions stay bit-identical, so the clay twin and textured twin are interchangeable. Per-vertex provenance (`_PROV`, `remesh-provenance.ts`) is carried over.
- Tile photogrammetry (tier 2 source): its own per-primitive UVs, read as is.
- Ornament/detail builds (`l4`) and figures: built from solids with known parametrisation, so they use the fitted-chart rule where they have one; otherwise they stay clay and are listed as "no texture source" (honest gap, not fill).

## 4. Tier 1: Street View projection (primary)

Per layer texel (u,v) -> world point P (chart or atlas inverse) and geometric normal n. For each registered view k (corrected `FrameCamera`):
1. Project: `(px,py,z) = projectToFrame(cam_k, P)`; reject behind camera or outside image minus a 6 px feather.
2. Visibility: depth map `renderFrameDepth(scanMesh, cam_k)` of the remeshed scan (the true occluder, trees removed unless rebuilt) plus the fitted solid; keep if `z <= depth(px,py) + tol`, `tol = 0.20 m + 0.02 z` (the unprojector's defaults). Drop within 3 px of a depth discontinuity (existing `guardPlateDepthEdges`).
3. Weight: `w_k = cos(theta)^2 * (1/ground-sample-distance) * poseQuality_k * edgeFeather`, with `theta` the view/normal angle (drop below cos 0.15), `poseQuality` from the registration's residual for that pano (0 for panos set aside, per-pair RMS otherwise). Grounding images are redacted (people/vehicles removed), but redaction blur regions are masked out of the weight when detectable (low local variance patch flagged by the survey step).
4. Blend: weighted mean in linear RGB, plus a Huber pass for texels with >= 3 views. Single-view texels keep that view's colour.
5. Exposure and seams: (a) `StationRadianceEqualizer` CDF match on overlapping footprints; (b) per-view gain solved as a small least-squares over overlap texels (gain_k in log-space, anchored to the view with median luminance); (c) a measured-palette gate: the face's `FacePalette` (Lab, CIEDE2000) is the anchor, and a view whose masked-region mean sits more than 6 dE from the palette after (a)+(b) gets its gain pulled toward the palette, because palette pixels are the one photometrically consistent measurement across all faces; (d) seam correction by multi-band (Laplacian, 4 levels) blending between neighbouring weight regions, and a gradient-domain low-frequency correction across island borders. The palette also measures residual brightness error and is reported (`paletteDeltaE`).
6. De-lighting: reuse `SurveyTextureUnprojector.solarDelighting` (NOAA sun at each pano's capture date, per `EvidenceImage.view.date`) for the albedo; shadow lift and highlight compression use the same parameters as `applyPhotogrammetricDelightShader` (shadowLift 0.60, highlightCompress 0.45), moved to a shared pure function so node baking and the browser shader cannot drift. Albedo is labelled photo-inferred; lighting is not baked as ground truth.

Texels no view sees keep going down the ladder (below). `pose` uncertainty is carried: a texel's weight is multiplied by `exp(-(sigma_px/3)^2)` where `sigma_px = uncertaintyPx(distance, fov, width)` from `slot-projection.ts`.

## 5. Tier 2: tile photo transfer and enhancement

Transfer: fetch the textured tile once (`getGoogle3DTilesFullTexture`, leaf LOD, 0.154 m texel); for every layer texel P find the nearest tile surface point (BVH on tile triangles, query point nudged along the normal; reject when distance > `max(0.25 m, 2*registrationResidual)` or normal angle > 60 deg) and sample the tile texture bilinear in its own UV. Photogrammetry on facades is melted and lit; so transfer is albedo-only, de-lit, and confidence-capped at 0.5 relative to tier 1.
Fuse with tier 1 using the existing `StreetViewTextureFusion` rule (tile = base, Street View adds detail ratio `D`, never softens). This is exactly its documented operation; the new work is feeding it atlas-UV plates instead of tile-UV plates.
Enhance (optional, behind its own rung): an image model (Gemini image edit, developer credits) is given the transferred crop plus the 2 to 3 nearest registered real views of the same face as grounding references and asked for a sharper same-layout crop; the result is accepted only if an edge-position gate passes (Sobel NCC to the input >= 0.97 and no new structure beyond 3 px). It is NOT the old `tile_restyle`. Enhanced texels carry `source: 'tile-photo-enhanced'`, label photo-inferred, and are never used where tier 1 has >= 2 views.

## 6. Tier 3: generated tileable PBR (only where no real data exists)

Coverage holes (roofs unseen from the street, back faces) get a tileable albedo/normal/roughness set whose colour comes from the measured palette (never invented), generated by the image model from the face crop and tiled with a seamless-wrap pass; labelled `generated`. This tier cannot ship while `pbr_synthesize_material` is broken: memory says it errors on main ("Cannot find module './native-material-pbr-service.js'") and behind that returns the INPUT GLB unchanged while reporting "Applied Adaptive PBR". Branch `pbr-import-fix` (worktree head 84c6cb6c, last commit WIP, unreviewed) has the import fix, real dominant-axis box projection, and tests. Plan: do not call that tool. Add a texture-set generator function (`generateTileablePbr(palette, cropRefs)`) in the new pass that returns maps, and have the pass write them itself; resume `pbr-import-fix` separately (honest `appliedMethod`, MaterialX/USDZ files actually written, ts-node child test, render the 25-part telescope GLB) before the tool is exposed. Never merge only the import fix.

## 7. Depth/normal relief experiment

Experiment, off by default: run a monocular depth/normal model (Marigold, Depth Anything or Depth Pro, chosen by a bake-off on 20 real crops) on Street View face crops; convert to relief only relative to neighbours (subtract the fitted plane through the crop, high-pass at about 0.5 m) so metric scale comes from the scan, never the network. Accept per region only if reprojection passes: displace the surface by the relief, re-render the corrected view, and require Sobel NCC to the real crop to improve by >= 0.03 and not worsen elsewhere. Accepted relief is stored as a normal map only (not geometry) labelled photo-inferred; rejected relief is dropped with a logged reason. Output: a report with accept rate, not geometry changes. This requires an AGENTS.md amendment (section 11).

## 8. Degrade ladder (one rung at a time, each labelled)

0 tier 1 multi-view blend (>= 2 good views per texel)
1 tier 1 single view
2 tier 2 tile photo transfer (de-lit)
3 measured palette colour (flat `FacePalette` top colour, texel-uniform, labelled photo-inferred)
4 generated tileable PBR driven by the palette (labelled generated)
5 clay (as today). No rung invents content: a failing view, pano, fetch, model call, or gate marks its texels down one rung and records a `degradations[]` entry with the real reason. Texel-level rung is in the confidence plane, layer-level `ladderRung` is the worst share above 10 percent.

## 9. Stages, reveal, timing

Stages added to `STAGES` (all `order: -1`, i.e. background, same as survey/evidence): `uv` (charts + island atlas, ~2 s fitted, ~6 s scan native), `bake-projection` (software depth per pano ~0.3 s x 20, accumulate ~15 s per 4096 atlas), `exposure` (~3 s), `tile-transfer` (BVH + fetch ~20 s, fetch already cached by `tiles`), `enhance` (model, 10 to 40 s per face, parallel x4, optional), `pbr-fill` (10 to 30 s only if holes), `publish`. Budget 180 s target, 300 s hard (`budgetMs`), run concurrently with the photo survey tail and trees; abortable via the existing stage stop. Viewport: `Textures & Materials` selects `rendermode: textured`; `materialOverride.ts` is the wrong tool (it replaces one explicit PBR); instead the textured twin is loaded with the existing staged reveal (cross-fade from clay by `_REVEAL`, sweep up the facade), and the clay GLB stays the fallback. If the bake is not finished when picked, the pill shows live progress and applies per layer as each publishes; it never blocks.

## 10. Tests (no billed calls, replayed data)

Fixtures recorded once from a live run into `packages/core/test/fixtures/staged-build/texture-pass/`: Registration JSON, per-pano JPEG bytes at 1920 px (already redacted grounding output), fit JSON and shells, a remeshed scan GLB, a tile GLB crop. Tests (vitest, credential-guarded: empty HOME, creds unset, per the standing rule) use injected `fetchViews`/model/geocode stubs that throw if called without a replay entry, so a missing fixture fails instead of billing.
- Math: a synthetic cube with analytic camera: projected texel = ground truth colour within 1/255, occluded texels untouched, weight monotone in cos(theta).
- Fidelity: re-project the baked texture into each held-out real view and require SSIM >= 0.85 and median dE <= 6 vs the real crop; palette gate triggers on a synthetic +20 percent exposure view.
- Seams: max dE across island borders <= 3.
- UV: every fitted-surface triangle has finite UV in [0,1], atlas rects non-overlapping, clay positions byte-equal to the textured twin.
- Ladder: kill each source in turn (no panos, no tile, model throws); assert next rung, a degradation entry with the real reason, and that no output texel came from a made-up value (provenance covers 100 percent of texels, none unlabeled).
- GLB: magic bytes, TEXCOORD_0 count = vertex count, images decode.
- Screenshot test per AGENTS.md (clay vs textured, provenance overlay) into `test-results/screenshots/`.

## 11. AGENTS.md amendments needed

1. "Monocular dense depth (Marigold)" is listed unsupported: amend to allow it ONLY as the section-7 experiment (relief from Street View crops, neighbour-relative, reprojection-gated, never as metric geometry), with the rest of the "never approximate/simulate" rule intact.
2. The Performer/Street View rule and the "Tier-0" language are untouched; add that texture synthesis for locations must carry per-texel provenance labels and that generated PBR is permitted only for texels with no real data.
3. Note that grounding imagery (redacted Street View via Maps Imagery Grounding) may be used for texture projection under the tester agreement; this overrides the "no generative use of non-redacted" memory for texture only when the images are redacted grounding output.
4. Fix the stale name `AlgorithmicUVRewrapService` -> `AlgorithmicUvEngine`.

## 12. Risks

- Registration residual (about 1.3 m) is large for 0.154 m texels: ghosting at repeated ornament. Mitigation: per-texel weight by pose sigma, multi-band blending, and per-island local refinement (a 2D shift search of each island against its best view, Sobel NCC) before blending.
- Occluder fidelity: remeshed scan trees/awnings cause wrong projection onto walls behind. Use scan with trees stripped for the wall pass, and mark texels behind rebuilt trees as lower weight.
- Photogrammetric tile melt makes tier 2 look wrong on facades; kept low-confidence by design.
- Model-enhanced texels can hallucinate; hence the edge gate and the "never above tier 1" rule.
- Memory: 20 decoded JPEGs of 1920x1080 RGBA are 160 MB; decode, accumulate, drop per pano.
- Redaction blur on people/vehicle regions bakes smears: mask from grounding output.
- The pbr tool (section 6).

## 13. Work breakdown (parallel agent tasks, file ownership)

A. Land and baseline: merge `push-integration` to main (or branch from it); add contracts (section 2); fixtures recording; stage entries in `STAGES`. Owns: `common/spatial/staged-location-contracts.ts`, `orchestrator.ts` stage wiring, fixtures.
B. UV + writer: chart UVs for fitted surfaces, native island atlas for the scan (C++ in `scratchbox_uv_engine.hpp`/new header, compiled via `NativeCppCompilerService`), `staged-glb-writer.ts` gains TEXCOORD_0, images, material, confidence plane. Owns: `staged-glb-writer.ts`, `texture-uv.ts`, native header.
C. Projection bake: camera/visibility/weights/blending/exposure/seams/de-lighting (section 4), built on `SurveyTextureUnprojector`/`StationRadianceEqualizer`. Owns: new `texture-projection.ts`, `texel-exposure.ts`, shared de-light function extracted from the browser shader (edit of `applyPhotogrammetricDelightShader` limited to extracting the pure function).
D. Tile transfer + enhance: BVH nearest-surface transfer, `StreetViewTextureFusion` feed, enhancement and its edge gate. Owns: `tile-texture-transfer.ts`, `texture-enhance.ts`.
E. Fill + PBR: tileable generated set, palette fill, and finishing `pbr-import-fix` separately. Owns: `texture-fill.ts`; branch `pbr-import-fix` files.
F. Viewport + reveal + relief experiment: textured twin load, Textures & Materials pill wiring, progress, provenance overlay; the depth/normal experiment harness (off by default). Owns: `scene3d/stagedBuild/*`, `materialOverride.ts` interplay, `texture-relief-experiment.ts`.
Dependencies: A first (contracts); then B, C, D in parallel against the contracts; E and F follow B. Integration test (section 10) is owned by A.

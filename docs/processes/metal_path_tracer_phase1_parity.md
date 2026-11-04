# Metal Path Tracer, Phase 1: hardware ray tracing on the cluster LOD cut, verified against the CPU tracer

**Date:** 2026-10-20
**Machine:** Apple M1 Ultra (GPU family Apple7: Metal ray tracing on the shader cores, no dedicated RT unit), macOS 26.6, Apple clang 16, no Xcode (Command Line Tools only; Metal shaders compile at run time).

## What was built

- `packages/core/src/native/3d-engine/include/scratchbox_sbvg_reader.hpp`: reads the `.sbvg` cluster LOD files the virtual geometry builder writes and takes the per-camera LOD cut with the same rule as `cluster-selection.ts` (projected self error within the pixel threshold, parent error not), without frustum or cone culling, because bounce and shadow rays need the geometry behind the camera.
- `scratchbox_metal_pathtracer_kernels.hpp` + `scratchbox_metal_pathtracer.hpp`: a Metal compute path tracer over `primitive_acceleration_structure`. It is a port of `render::PathTracer::tracePath`: same camera, same per-pixel PCG32 sample stream, same GGX metallic-roughness BSDF, solar next-event estimation, sky lookup table, haze and Russian roulette. Fast math is off. One sample per dispatch into a per-pixel accumulation buffer; render time is the GPU's own and rays are counted by the kernels.
- `scripts/sbvg_pathtracer.mm`: the helper (`--probe`, or a JSON config). Backend `metal` or `cpu`; the CPU backend feeds the identical LOD cut to `render::PathTracer`, so the two can be compared.
- `packages/core/src/node/3d-engine/metal-path-tracer-service.ts`: `MetalPathTracerService` (compile through the native build cache with `-fobjc-arc`, frameworks Metal and Foundation).
- `packages/core/test/metal-path-tracer.test.ts`: furnace, sphere parity, real-tile parity (gitignored Flatiron capture), failure messages. Skips with a reason off macOS or without a ray tracing device.
- `render::PathTracer` now counts rays (`RenderOutput::rays`; `stats.json` gains `rays` and `raysPerSecond`); `sky::PhysicalSky` exposes its lookup table and sun basis for the GPU upload.

Lighting is the neutral studio dome unless the config asks for a sun (AGENTS.md §3.6). Materials are one uniform material: `.sbvg` version 2 carries positions and normals only (Phase 2 adds UVs and material ids).

## Baseline (CPU tracer, `render_tile_pathtraced`, Flatiron full-texture GLB, 403,385 triangles, 20 threads)

| Framing | Coverage | spp | Rays | Render | Rays/s |
| :--- | :--- | :--- | :--- | :--- | :--- |
| wide (distanceScale 0.9) | 12.9% | 16 | 19.2 M | 0.42 s | 46.0 M |
| tight (distanceScale 0.45) | 47.7% | 64 | 123.6 M | 4.61 s | 26.8 M |

## Metal vs CPU on the same LOD cut (Flatiron `.sbvg`: 11,028 clusters, 5 levels; cut at 1 px: 2,984 clusters, 209,713 triangles; 1280x720, 64 spp, 4 bounces, sun 42 deg / 150 deg)

| Backend | Rays | Render | Rays/s | Coverage | Mean luminance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Metal (M1 Ultra) | 140,582,463 | 0.842 s (GPU time) | 167.0 M | 0.519135 | 0.0569009 |
| CPU reference | 140,581,816 | 5.050 s | 27.8 M | 0.519136 | 0.0569001 |

Acceleration structure build: 366 ms (Metal) vs 72 ms (CPU BVH).

Agreement (scene-linear luminance): mean ratio 1.000013; pixel RMS difference 0.75% of the mean (the two sample streams are identical, so this is float rounding, not Monte Carlo noise); 8x8-block mean relative difference 0.044%, 4 of 14,400 blocks over 2% (rays grazing an edge where the hardware intersector and the CPU BVH pick different triangles). Ray counts differ by 0.0005% for the same reason.

Furnace (unit sphere, uniform unit dome, albedo 1, roughness 1, metallic 0, 8 bounces, no clamp): mean 0.976 over geometry pixels. Lambert alone would return 1; single-scatter GGX at roughness 1 loses a few percent and never gains, which is what the test asserts (0.85 to 1.02).

**Verdict:** 6.0x the CPU tracer on this GPU at parity. Rendered images: `test-results/screenshots/` is not used for these; the vitest run writes under a temp dir, and the two 1280x720 beauties were compared by eye (identical).

## Lessons

- The engine's existing `NaniteClusterDAG` (`scratchbox_nanite.hpp`) is not the cluster DAG to build on: its parents are made by sort order and its errors are invented (`0.01 * 2^level`), so its cuts crack. `vgeo::ClusterDag` / `.sbvg` is the real one.
- The whole C++20 engine compiles as Objective-C++ without changes; one `.mm` translation unit can include the tracer, sky, glTF and denoiser headers and the Metal code.
- Metal's `triangle_barycentric_coord` is (u, v) for vertices 1 and 2, the same convention as the CPU Moller-Trumbore hit, so normals interpolate identically.
- Command buffers hold 4 sample passes: enough to amortise submission, short enough for the GPU watchdog at 1280x720x4 bounces.

## Phase 2 (2026-10-20): materials in `.sbvg` version 3, real materials in the tracer

**Format.** File vertices are now wedges (position, normal, uv; 8 floats) and every level block ends with one glTF material index per triangle (`0xFFFFFFFF` for none); header word 26 is the glTF material count. Readers (C++ `scratchbox_sbvg_reader.hpp`, TS `sbvg-format.ts`, the WebGPU renderer) still read versions 1 and 2, repacking old vertices with uv (0, 0).

**Seams.** The first attempt welded vertices by (position, uv) and locked every seam and material-border vertex. On the Flatiron tile that doubled the vertex count (229,748 positions, 498,620 wedges: Google tiles chart their textures per short triangle run) and the DAG collapsed from 5 levels to 2. The rule that shipped instead: positions stay welded through the whole DAG, a uv lives on each triangle corner, and a collapse is allowed only when every surviving triangle at the moving vertex can take its uv at the target from a removed triangle of the same material and the same chart (`LockedSimplifier::chartTargets`), so collapses run *along* seams and borders, never across them. Seams cannot crack (positions are shared) and no triangle ever straddles two charts or materials.

**Cost of exact seams on photogrammetry.** Flatiron: level 1 keeps 206,764 of 403,385 triangles (174 of 914 groups stuck), level 2 keeps 158,074 (538 of 988 stuck), then the DAG stops: 3 levels, 14,030 clusters, where the position-only build had 5 levels. The 1 px cut for the test camera is 329,205 triangles (was 209,713). Deeper LOD on such data needs re-textured coarse levels (a new atlas per level), which is follow-up work; the synthetic sphere still builds 9 levels.

**Tracer.** `shade()` on the GPU is a port of the CPU `PathTracer::shade`: base colour factor and texture (bilinear with the glTF wrap modes, sRGB-decoded), metallic-roughness and occlusion maps read linear, normal maps with tangents derived from the uv derivatives, emission; textures are bindless (a buffer of Metal resource ids, one per decoded image; 209 for Flatiron). The CPU tracer sampled its data maps (metallic-roughness, occlusion, normal) through the sRGB decode too; that was a bug, fixed in `scratchbox_pathtracer.hpp` (`sampleTexture(..., srgb)`), and the GPU matches the fixed behaviour.

| Flatiron, textured, 1280x720, 64 spp, cut 329,205 tris | Rays | Render | Rays/s | Mean luminance |
| :--- | :--- | :--- | :--- | :--- |
| Metal (M1 Ultra), 209 textures | 126,657,960 | 0.953 s | 133.0 M | 0.0278386 |
| CPU reference | 126,658,041 | 4.373 s | 29.0 M | 0.0278389 |

Agreement: mean ratio 0.99999; 8x8-block mean relative difference 0.040%; 19 of 14,400 blocks over 2% (sunlit high-contrast edges where the intersectors' tie-breaks differ). The always-available test fixture is a checkerboard-textured sphere (GLB with TEXCOORD_0, a PNG and a sampler), compared GPU vs CPU the same way and against clay.

## Phase 3 (2026-10-20): the path-traced view in the app

**Resident helper.** `sbvg_pathtracer --serve <dir>` keeps the GPU tracer alive: JSON commands on stdin (`open` a file and its GLB's materials, `view` with the camera, size, LOD threshold and target spp, `close`), JSON events on stdout (`opened`, `view`, `frame`). `MetalPathTracer` gained a progressive API (`beginFrame` / `samplePasses` / `readback`); the helper samples 1, 2 then 4 passes per batch and writes the display-ready 8-bit RGBA frame (AgX, the first frame's auto exposure held for the view) to `<dir>/frame.rgba` by atomic rename at most every 40 ms. The LOD cut and acceleration structure are rebuilt only when the eye moves more than a tenth of the scene radius or the LOD parameters change. Frames travel as a file in the page cache read by the server, not shared memory proper.

**Server.** `MetalPathTraceSession` (spawn, line protocol, latest-frame bookkeeping) in `metal-path-tracer-service.ts`; `/3d/path-trace` (`open` by served `.sbvg` URL and workspace GLB path, `view`, `frame?after=<seq>.<spp>` answering 204 until a newer frame exists, `close`; idle sessions reaped after 10 min). The frame headers must be listed in `Access-Control-Expose-Headers`: the page runs on another origin in development and the browser hides them otherwise, which silently rejected every frame on the first live try.

**Viewport.** A "Path traced" toggle (and a "Studio / Sun" toggle beside it) on `VirtualGeometryViewport`, persisted as `virtualGeometry.pathTrace`. On, it opens a session for the loaded `.sbvg` and source GLB, pauses the WebGPU loop, follows the orbit camera (`VirtualGeometryRenderer.getView()`, debounced 80 ms), polls frames every 50 ms and draws the newest over the WebGPU canvas; the HUD shows device, spp, resolution, measured rays/s, the cut and the materials. Off, it closes the session and resumes WebGPU.

**Live evidence** (isolated instance `scratchbox-metal-pt`, ports 3310/3311/3312, Flatiron opened through the agent's `virtual_geometry_open_glb`): session opened with 209 materials and 209 textures; the 615x713 view cut 251,218 triangles in 4,676 clusters and reached 256 spp in about 3 s at 216 M rays/s (studio dome) and 190 M rays/s (sun); an orbit drag restarted accumulation (seen at 140 of 256 spp on the new view); a wheel zoom rebuilt the cut (238,888 triangles); toggling off closed the session. Console clean throughout. Tests: `metal-path-tracer.test.ts` (resident session: frames accumulate, a small move keeps the cut, a bad view is refused without killing the process) and `desktop-app/test/path-trace-routes.test.ts` (URL validation, a session through the standalone server).

**Not done.** Frames are noisy at low spp (Phase 4 denoises); the cut rebuild (~100 ms for 240k triangles) is synchronous in the helper, so a long drag across the scene stalls frames briefly each tenth of a radius; the resolution is capped at 1280 wide.

## Phase 4 (2026-10-20): GPU denoising and temporal reuse

**Denoiser.** `denoise::denoiseATrous` ported to Metal compute (`kDenoiseKernelSource`: `dn_prepare`, `dn_gradients`, `dn_blur`, `dn_atrous` per iteration, `dn_finish`), reading the accumulation buffer directly (mean colour, albedo, normal, depth, luminance variance, geometry mask) and remodulating by albedo at the end. `MetalPathTracer::denoise()` runs it on the current frame. Checked against the CPU filter on the same raw frame (`denoiseCheck` writes `denoised_cpu.f32`): Flatiron 640x360 at 16 spp, max relative difference 1.8e-5, mean 2e-7, no block over 2%: the same algorithm to float rounding. 2.5 ms on the GPU vs 23 ms on the CPU (20 threads). The test pins max relative difference < 1e-3.

**Temporal reuse.** On each view change the helper commits the last denoised frame as history (`commitHistory`: illumination, samples it stands for, depth, normal, and the view). `dn_prepare` projects each new pixel's hit point into the previous view, takes that history pixel when its depth agrees within 2% and its normal within 37°, and combines it with the new samples as a weighted mean (history capped at 32 samples, so stale light fades), scaling the variance down accordingly; `dn_finish` writes the next history. Measured in resident mode on Flatiron 640x360: identical camera 43,536-45,278 of ~50,500 geometry pixels reused at 1 spp; after a 12 m sideways move 43,536; after a 60 m move 39,412; with `temporal: false` 0. The viewport HUD reports "Denoised on the GPU in N ms · M px reused from the last view".

**Live** (isolated instance, Flatiron through the agent): the toggle shows the denoised frame from the first sample on; a drag restarts at the new view with most pixels reused, so the image never falls back to raw noise; console clean. A bug found on the way: the history buffer swap left the output buffer nil after the first commit, so the second move reused nothing until the allocator was taught to replace it.

**Honest limits.** The temporal blend trusts history that passes the depth/normal test, so lighting that changes between views (the Sun toggle) lingers up to the 32-sample cap before fading; disocclusions show the raw-sample noise until the filter catches up; the helper's cut rebuild is still synchronous.

## Phase 5 (2026-10-20): ray cost, each idea measured against the baseline

The harness is `scripts/bench_sbvg_pathtracer.cjs` (the Phase 1 shot: textured Flatiron, 1280x720, 64 spp, sun). Every speed idea is a flag in the helper's `optimizations` and scored on GPU render time and on 8x8-block bias against the baseline image; samplers are scored by RMSE against a 1024 spp reference. Baseline today: 329,205-triangle cut, 126.7 M rays, 925-964 ms, 131-137 M rays/s.

| Idea | Result | Verdict |
| :-- | :-- | :-- |
| Acceleration structure "prefer fast build" | trace 0.91x; the build itself was not faster here | rejected, kept as a flag |
| Coarser cut for bounce and shadow rays (4 / 8 / 16 px, rays start past the cut's error bound) | 1.13x / 1.19x / 1.28x, but block bias 3.3% / 6.5% / 16.9% with maxima of hundreds of percent: this DAG's coarse levels carry 9-18 m of error, so shadows and bounce light land on the wrong walls | rejected on photogrammetry, kept as a flag |
| Rasterized primary hit (one visibility pass per frame, each jittered sample re-intersects its pixel's triangle, edges trace) | 0.94x (1025 vs 964 ms) with 20% fewer traced rays; biased at silhouettes (1.7% block mean, 14% of blocks over 2%) because a jittered ray can meet a closer triangle than the one under the pixel centre, and checking that is a trace. Half the pixels see sky anyway | rejected, kept as a flag |
| Merged acceleration structures | the tracer has always built one structure over the whole cut (no per-cluster instances), so there was nothing to merge | n/a |
| Owen-scrambled Sobol sampler (Joe-Kuo direction vectors for 32 dimensions, Burley's nested scramble per pixel and dimension, 6 dimensions per bounce, PCG past the table) | RMSE vs reference, Flatiron 8 / 32 spp: 1.44e-3 / 6.5e-4 against PCG's 2.25e-3 / 1.12e-3; clay sphere 8 / 32 / 128 / 512 spp: 2.1e-3 / 9.9e-4 / 3.7e-4 / 2.1e-4 against 3.2e-3 / 1.5e-3 / 7.5e-4 / 3.4e-4. PCG needs 2.5-3x the samples for the same error; the sampler costs ~17% per sample | **adopted**: default in the resident mode (`view.sampler`, `pcg` on request); the one-shot default stays PCG for the CPU parity tests |
| MetalFX spatial upscale (resident mode `renderScale`) | 64 spp frame, 1280x720: 702 ms full size; 303 ms traced at 854x480 + 0.2 ms upscale (PSNR 35.3 dB against the full-size frame); 268 ms at 640x360 (33.6 dB) | **adopted** as an option (`virtualGeometry.pathTrace.renderScale`, default 1); the HUD says what the frame was traced at |

Two samplers were measured and thrown away on the way: Halton with higher primes under Owen scrambling (worse than PCG below 64 samples: its first samples in base 19 or 23 fill a few of many cells), and base-2 radical inverses with an independent scramble per dimension (best at 8 spp, then stalled at 1.9e-3 from 32 spp on, because every dimension is the same sequence re-permuted and a pixel's samples lie on a curve). A Laine-Karras constant that is odd (0xc7afe785) zeroes bit 0 of `x ^= x * c` and halves the pixel jitter range; Burley's constants are even.

**What this means for the viewport:** the honest wins are fewer samples for the same error (Sobol) and fewer pixels (MetalFX), not faster rays; on an M1 Ultra the hardware intersector already spends only ~20% of its rays on primaries and has no cheaper geometry to trace against until the DAG's coarse levels are re-textured.

## Phase 6 (2026-10-20): re-textured coarse levels (`.sbvg` version 4)

**What.** When the GLB has materials, every coarse level is simplified without regard to UV seams or material borders (only group borders stay locked) and gets an atlas of its own (`scratchbox_lod_retexture.hpp`): each coarse triangle takes a square cell (sized by its area at a texel tied to the level's error, never finer than the source textures' median texel, atlas capped at 4096 wide), and every texel is baked by projecting back along the coarse normal onto the surface the triangle was simplified from (two rays from either side through the point; the nearest source point as fallback) and sampling that surface's albedo: the glTF textures for level 1, the previous level's atlas above. Each level becomes one material appended after the glTF materials (base colour = the atlas PNG written next to the file, metallic and roughness of the area-dominant glTF material); the file's atlas table (header words 27-31) names them, and both readers, the helper (Metal and CPU reference) and the build service's cache (atlas PNGs live and die with their file) know version 4.

**Flatiron** (403,385 triangles, 209 textures), builder 9.6 s on 20 threads:

| | before | re-textured |
| :-- | --: | --: |
| DAG levels | 3 | 7 |
| level 1 / 2 / 3 triangles | 206,764 / 158,074 / - | 201,680 / 106,233 / 67,846 |
| coarsest level triangles | 158,074 | 43,401 |
| 1 px cut for the test camera | 329,205 | 216,035 |
| frame at 64 spp | 0.95 s | 0.96 s (fewer triangles, same rays) |
| atlases | - | 6 levels, 4096x3076 down to 1024x690, 84 MB of PNG |
| file | 28 MB | 85 MB (per-cell uvs: three wedges per coarse triangle) |

Level 1 bakes 12.4 M texels at a 0.29 m texel in 0.9 s with 4% of texels falling back to the nearest-point search; the checker sphere goes from 9 to 10 levels with a 512x145 level-1 atlas, and a render from level 3 up (1,182 triangles instead of 2,719) keeps the checkerboard and agrees with full detail to 3.4% in block means. Rendering Flatiron from level 2 up (106k triangles) differs from full detail by 20% in block means from the test camera: that level carries up to 10 m of error and is meant for far views.

**Coarser bounce cut, re-measured on the re-textured DAG:** 8 px cut, shadows and bounces on it: 8.4% block bias; bounce light only, shadows on the fine cut: 1.9% (16 px: 2.6%), with local maxima of 150-1300%, whether rays start past the error along their own direction or along the surface normal. Re-texturing fixed what the coarse levels look like, not where they are: the remaining bias is geometric, so the coarse bounce cut stays rejected for correctness and the flags stay in the harness.

**Costs and limits.** Per-triangle cells triple the coarse levels' vertex count and make the file 3x larger; cells of a few texels show the gutter's clamped colours as a fuzz along edges at the coarsest levels; the bake only carries base colour (no normal or metallic-roughness maps on coarse levels); groups the simplifier cannot reduce by 15% are still carried up unchanged, which is what stops the DAG at 7 levels (300 of 450 groups stuck at level 5).

## Phase 7 (2026-10-20): paired atlas cells and baked normal maps (`.sbvg` version 5)

**What.** Two triangles that share an edge now share one square atlas cell with the common edge on its diagonal (greedy pairing, largest triangles first; a triangle without a free neighbour takes the lower half of a cell of its own), so a pair has four wedges instead of six and half the cells; cell sizes follow the pair's summed area at the same texel rule as before. Every level also gets a normal atlas beside its colour atlas: for each texel the baker takes the source surface's shading normal at the projected point (the interpolated vertex normal, refined by the source's own normal map when it has one; the previous level's normal atlas above level 1) and encodes it in the coarse triangle's tangent frame, derived from its cell uvs exactly as the tracer's `shade()` derives it (`retex::tangentFrame`), in the glTF encoding with the z component floored at 0.05. The atlas table rows carry the normal PNG's name after the colour PNG's (version 5; version 4 rows without it are still read), the helper loads it as the atlas material's normal map (clamped, scale 1; `materials.atlasNormals: false` leaves them out for measurement), and the build cache counts the normal PNGs as the file's siblings.

**Flatiron** (403,385 triangles, 209 textures), Phase 6 build vs this one:

| | per-triangle cells (v4) | paired cells + normals (v5) |
| :-- | --: | --: |
| DAG levels / clusters | 7 / 25,643 | 7 / 21,653 |
| coarse-level wedges per triangle | 3.00 (1,554,936) | 2.11 (1,074,509) |
| file wedges | 2,053,556 | 1,573,129 (-23%) |
| level 1 cells | 201,680 | 111,524 (81% of triangles paired) |
| level 1 atlas | 4096x3076, 0.29 m texel, 4.1% texels missed | 4096x3431, 0.19 m texel, 2.4% missed |
| colour atlas PNG | 81 MB | 68 MB, plus 68 MB of normal PNG |
| file | 85 MB | 67 MB |
| builder (20 threads) | 9.3 s | 10.2 s (normal bake and pairing add 0.9 s) |

Fewer gutters and no empty half-squares leave room under the 4096 cap, so the level-1 atlas lands on a finer texel at the same byte count; the atlases are stored PNGs (no deflate gain on photogrammetry), so the normal maps double the atlas bytes on disk. The checker sphere goes from 10 to 11 levels and 32,748 to 24,332 wedges, and its normal atlases are 99.6-99.8% flat (it is a sphere of flat shading normals), as they should be.

**Render agreement with full detail** (1280x720, 128 spp, denoised, block means against the 0.5 px cut, 8x8 blocks):

| cut | triangles | v4 build | v5, colour only | v5, colour + normals |
| :-- | --: | --: | --: | --: |
| 8 px | 83k | 3.54% (RMS 11.1%) | 3.95% (RMS 10.7%) | **3.46% (RMS 9.3%)** |
| 24 px | 56k | 10.7% (RMS 16.7%) | 9.57% (RMS 15.8%) | **9.35% (RMS 15.2%)** |

The baked normals carry the source's facet shading onto the coarse triangles: at the 8 px cut they take the block error from 3.95% to 3.46% and the pixel RMS from 10.7% to 9.3%, better than the Phase 6 build with its three-wedge cells. The 24 px cut (level 3-4, metres of error) stays geometrically broken from the test camera whatever its texturing; that is the stuck-group limit noted in Phase 6, not a texturing problem.

**Limits.** The normal atlas floors grazing normals at z = 0.05, so a coarse triangle spanning a wall-roof edge shades its wall texels darkly rather than flat; pairing is greedy (81% paired, not the 100% a quad-mesh would give); metallic and roughness are still per-level factors, not maps.

## Phase 8 (2026-10-20): stuck groups merged, and the DAG runs to the top

**Diagnosis first.** A build instrumented with rejection counters showed what a stuck group is: the partition's leftovers, one to five clusters of 3-150 triangles with 30-99% of their vertices on borders with other groups, every one of them exhausting its collapse heap. Healthy groups (about 7 clusters, 220-540 triangles) at the coarse levels were also exhausting their heaps after ~1,500 link-condition rejections each: a scanned tile is a non-manifold soup, and the link condition (common neighbours must be exactly the edge's apexes) refuses most collapses at pinch points. Coarse clusters also hold only ~33 triangles because their 128-wedge table fills first, which made groups of 8 clusters small and border-heavy.

**Three changes, measured one at a time on Flatiron.**

| builder | levels | stuck groups per level | coarsest level |
| :-- | --: | :-- | --: |
| Phase 7 | 7 | 163 / 324 / 335 / 308 / 309 / 255 | 42,605 triangles |
| + stuck groups merge into the neighbour sharing the most vertices (nearest group when none; union re-simplified with only its outer border locked, up to 32 clusters) | 6 | 0 / 1 / 0 / 9 / 24 | 39,804 |
| + groups grow to `kGroupTriangles` (1,024) rather than 8 clusters | 5 | 0 / 0 / 1 / 11 | 41,762 |
| + no link condition (an edge collapse needs a live triangle on it, the flip test stays; two triangles folded onto the same three vertices keep one) | **18** | 0 everywhere but 1 at level 4 | **2 triangles** |

The first two alone could not continue the DAG: they removed the stuck groups but the healthy ones were still walled in by the link condition. Without it every level halves to the top (201k, 101k, 50k, 25k, 12.5k, 6.2k, 3.1k, 1.6k, 775, 387, 193, 96, 48, 24, 12, 6, 2), the level-1 error drops from 1.24 m to 0.47 m (more candidates, cheaper collapses chosen), and the build takes 8.9 s. The merge step still matters at levels 1-6 (36, 120, 60, 20, 5, 1 groups merged). The group's border stays locked, so a topology change inside a group cannot open a crack between groups; the closed-sphere fixture test (every level closed, no open edges) guards the manifold case, and the checker sphere now reaches 34 triangles at level 8.

**Render agreement with full detail** (same camera, 1280x720, 128 spp, denoised, block means against the 0.5 px cut):

| cut | Phase 7: triangles / error | Phase 8: triangles / error |
| :-- | --: | --: |
| 1 px | 216k / - | 103k / 0.56% |
| 4 px | - | 39k / 1.26% |
| 8 px | 83k / 3.46% | **22k / 2.05%** |
| 24 px | 56k / 9.35% | **12.5k / 3.05%** |

A quarter of the triangles for a lower error at 8 px, and the 24 px cut goes from shards to whole buildings (crops in the chat log). This reopens the coarse bounce cut measured and rejected in Phases 5 and 6: that bias was geometric, from levels with 9-44 m of error; those levels now carry 1.7-3.6 m at the same triangle counts.

**Coarse bounce cut, re-measured on the deep DAG** (bench camera, 195k-triangle primary cut, 64 spp, 8x8-block bias against the baseline):

| variant | bounce tris | speed | block bias | Phase 6 bias |
| :-- | --: | --: | :-- | --: |
| bounce-cut-4px (shadows and bounces) | 87k | 1.12x | 4.7% (max 582%, 24% of blocks over 2%) | - |
| bounce-cut-8px | 56k | 1.19x | 8.3% (max 983%, 27%) | 8.4% |
| bounce-cut-16px | 38k | 1.24x | 15.0% (max 1934%, 31%) | - |
| gi-cut-4px (bounce light only) | 87k | 1.08x | 1.6% (max 53%, 20%) | - |
| gi-cut-8px | 56k | 1.13x | 2.1% (max 90%, 24%) | 1.9% |
| gi-cut-16px | 38k | 1.17x | 2.7% (max 155%, 27%) | 2.6% |

The bias is the same as on the 7-level DAG although those levels went from 9-44 m of error to 1.7-3.6 m, so it was never the shattered geometry: it is the offset between the fine surface a path hits and any coarser surface its next ray is traced against. A shadow ray leaving a fine hit finds the coarse wall in front of it (black blocks) or behind it (light leaks through a street canyon, the 10x blocks), and metres of offset do that as well as tens. **Rejected again, for good**: a bounce cut only works where the coarse surface sits within the ray's own offset epsilon, which on a scanned city means the 1 px cut. The bench flags stay for the record. The honest speed path for bounces remains fewer samples (Sobol) and fewer pixels (MetalFX).

## Phase 9 (2026-10-20): ReSTIR DI for the sky, measured and rejected

**Where the noise is.** On the bench shot (Sobol, RMSE against a 1024 spp reference of the same transport), the full path tracer sits at 1.370e-3 / 6.28e-4 at 8 / 32 spp and the direct-only transport (`maxBounces: 1`: sun shadow ray plus the first hit's sky through its BSDF ray) at 1.308e-3 / 5.92e-4. About 95% of the error is first-hit lighting; the bounces add almost nothing. So the sky at the first hit is the right target, and ReSTIR DI (Bitterli 2020) is the standard tool for it.

**What was built** (`optimizations.restir`, off by default; `restirCandidates`, `restirSpatial`, `restirTemporal`; kernels `restirSkyLighting` and `restir_spatial`, buffers 14-17): per pixel, cosine-sampled sky directions are resampled into a reservoir with target p̂ = luminance(BSDF x sky x cos), the chosen direction is shaded with one visibility ray (an occluded choice is dropped from the reservoir: visibility reuse), and the first hit's BSDF ray no longer counts the sky so nothing is counted twice. Temporal mode keeps the reservoir across the frame's passes (M capped at 20 candidates' worth); fresh mode restarts it each pass and merges neighbours' previous-pass reservoirs (16 px, same facing, depth within 10%), double-buffered so reads never race writes. A first version drew the candidates from Sobol dimensions 6-30, which overlap the next bounce's dimensions; they come from the pixel's PCG stream now. The sun stays a delta light with its own shadow ray.

| variant | 1 spp | 8 spp | 32 spp | mean ratio (32) | GPU ms (32) |
| :-- | --: | --: | --: | --: | --: |
| Sobol (baseline) | 5.96e-3 | **1.370e-3** | **6.28e-4** | 1.0000 | 539 |
| ReSTIR temporal, 8 candidates, 3 neighbours | 6.02e-3 | 1.505e-3 | 9.44e-4 | 0.9884 | 737 |
| ReSTIR fresh, 8 candidates, no neighbours | 6.02e-3 | 1.446e-3 | 6.58e-4 | 1.0000 | 737 |
| ReSTIR fresh, 32 candidates | 6.02e-3 | 1.439e-3 | 6.56e-4 | 1.0000 | 898 |
| ReSTIR fresh, 8 candidates, 3 neighbours (previous pass) | - | 1.837e-3 | 1.81e-3 | 1.0161 | 768 |
| ReSTIR fresh, 8 candidates, 8 neighbours | - | 2.094e-3 | 2.01e-3 | 1.0264 | 807 |

**Why it loses here.** Resampling only helps where the target function tracks the integrand: for a sun+sky scene whose sun is sampled separately, the sky LUT is smooth and the cosine term is already in the proposal, so 32 candidates are no better than 8 (the target is nearly flat). The noise that is left is visibility, which the target cannot see. Temporal reuse with visibility reuse converges on *visible* directions and goes 1.2% dark, the known bias of that variant, and correlates successive passes so the RMSE stalls; spatial reuse goes 1.6-2.6% bright (a neighbour's W already encodes its visibility, so re-weighting it here over-counts visible directions), and the unbiased fix costs one visibility ray per neighbour, which is the budget the method was meant to save. At 1 spp, the game regime, it is a wash (6.02e-3 vs 5.96e-3) for 30% more GPU time. **Rejected**; the flags stay in the helper and in the bench's sampler table for the record.

**What would address the visibility term:** sampling sky directions from a per-pixel visibility estimate learned over the passes (a small hemisphere histogram of shadow-ray outcomes), combined with BSDF sampling by MIS so it stays unbiased: path guiding for the first hit. That targets the term the measurements say is left. (Phase 10 built it and found the attribution above was wrong: see below.)

## Phase 10 (2026-10-20): visibility-guided sky sampling, and where the noise really is

**What was built** (`optimizations.guidedSky`, off by default; `guideTile`, `guideBands`, `guideSectors`, `guideSamples`; kernels `guideBegin/guideSample/guidePdf` and `guide_commit`, buffers 18-19): each tile of pixels keeps equal-area world-space bins (bands by direction.y times azimuth sectors) counting rays sent that way and rays that reached the sky. At the first hit one sky direction is drawn in proportion to estimated visibility times the cosine at the bin centre and shaded with a visibility ray; the BSDF ray is the other strategy and the two combine by the balance heuristic with the pdfs the samples were drawn with, so the estimate is unbiased whatever the histogram says. Bin weights are recomputed on demand (only their sum is kept) so a 1024-bin histogram costs no thread memory. Outcomes go to a pending buffer committed between passes: the first version updated the counters atomically during the pass, so the pdf a thread sampled with and the pdf it weighted with could differ, a bias of 1% at 8 spp that shrank with samples; frozen per pass it is 0.9998-1.0000.

**Measured** (bench shot, RMSE vs 1024 spp, mean ratio 1.0000 throughout):

| variant | 8 spp | 32 spp | GPU ms at 32 |
| :-- | --: | --: | --: |
| Sobol | 1.370e-3 | 6.28e-4 | 539-577 |
| guided, per pixel, 4x8 bins | 1.323e-3 | 5.93e-4 | 837 |
| guided, 8 px tiles, 4x8 bins | 1.314e-3 | 5.88e-4 | 817 |
| guided, 8 px tiles, 8x16 bins | **1.306e-3** | **5.82e-4** | 1004 |
| guided, 16x16 and 32x32 bins | 1.307e-3 / 1.310e-3 | 5.82e-4 | 1200 / 2242 |
| guided, 8x16, 4 and 16 sky samples per hit | 1.273e-3 / 1.255e-3 | - | - |

Unbiased and 4-7% better per sample, for 35-75% more GPU time: a loss per unit of time, so Sobol stays the default. **Rejected as a default; kept behind its flag.**

**The decomposition, corrected.** Phase 9 read "95% of the noise is first-hit lighting" off the `maxBounces: 1` transport, but that transport also contains the sun's shadow ray at the *second* hit, i.e. one bounce of indirect sunlight. Separating the terms on the same shot (Sobol, 8 spp, each against its own 1024 spp reference):

| transport | textured RMSE (mean 0.027) | clay RMSE (mean 0.041-0.049) |
| :-- | --: | --: |
| camera ray + sun at the first hit (`maxBounces: 0`) | 8.40e-4 | 1.61e-3 |
| + sky at the first hit, haze, and sun at the second hit (`maxBounces: 1`) | 1.308e-3 | 4.36e-3 |
| full (4 bounces) | 1.370e-3 | - |
| sky only, sun below the horizon, `maxBounces: 1`: Sobol / guided / 16 guided samples | - | 2.94e-5 / 2.35e-5 / 0.99e-5 |

Three readings. (1) The camera+sun term is 38% of the variance and is *not* texture aliasing: on flat clay it is relatively larger (3.9% of the mean vs 3.3%), so it is sub-pixel geometry, facets with different normals and sun-shadow edges inside a pixel, at the 1 px cut of a scanned tile. (2) On a pure sky the guide does what it should: 20% less error per sample, 3x less with 16 samples. (3) Under sun, 16 guided sky samples per hit move the `maxBounces: 1` error by only 11% (clay: 1.7%), so the large remainder is the **one-bounce sunlight**: the BSDF ray lands on a sunlit or a shadowed wall, a binary of high contrast. That is the term left after primary visibility, and no sky sampler reaches it. The sky itself is a small share in a sunlit scene (dark photogrammetry albedo, bright sun).

**Where that leaves the "exceed gaming" question.** Per-sample gains at the first hit are exhausted (Sobol took them; ReSTIR DI and guiding are measured losses per unit time). The remaining noise is (a) sub-pixel geometry under the sun and (b) one-bounce sunlight. (a) is prefiltering: render from a coarser re-textured cut (Phase 8 made the 2-4 px cuts faithful) so a pixel sees one facet, and measure the agreement/noise trade. (b) is the domain of ReSTIR GI (reservoirs over *secondary hit points* with their outgoing radiance, reused spatially) and of radiance caching; a guide over "where are the sunlit surfaces" is the same idea in guiding form. Both act on the bounce ray, not the sky ray, and that is where the next measurement belongs.

## Phase 11 (2026-10-21): ReSTIR GI over second hits, measured and rejected

**What was built** (`optimizations.restirGi`, `giSpatial`; off by default; `GiSample` buffers 20-21): past its first hit a path gathers into a separate accumulator with the throughput reset to one, so its second hit (or escape direction) with that radiance is a sample of weight 1/pdf. Each pass resamples the path's own sample with `giSpatial` neighbours' samples of the previous pass (16 px, same facing within 25°, depth within 10%), each reconnected to this first hit with the Jacobian of the solid-angle pdf between the two first hits (p_r = p_q · (cos_q / cos_r) · (d_r² / d_q²); directions need none), and shades the choice after one visibility ray. Passes read only the previous pass, so they stay independent. With no neighbours the estimator reproduces the path tracer (1.357e-3 vs 1.370e-3 at 8 spp, mean ratio 1.0000), which checks the plumbing. A first build had the Jacobian inverted (RMSE 4.6x worse, fireflies of 15x the image mean).

| variant (8 spp / 32 spp) | RMSE | mean ratio | GPU ms (32) | rays (32) |
| :-- | --: | --: | --: | --: |
| Sobol | 1.370e-3 / 6.28e-4 | 1.0000 | 586 | 63.6 M |
| GI, 3 neighbours, Jacobian in [1e-3, 1e3] | 1.408e-3 / 8.26e-4 | 0.9991 | 732 | 69.4 M |
| GI, 8 neighbours, same | 1.380e-3 / 7.35e-4 | 0.9986 | 819 | 71.8 M |
| GI, 3 neighbours, Jacobian in [0.2, 5] | **1.291e-3** / 6.07e-4 | 0.9993 | 735 | 69.3 M |
| GI, 8 neighbours, same | **1.258e-3** / 6.17e-4 | 0.9990 | 837 | 71.8 M |

The loose bound converges slower than Sobol (8 to 32 spp: 1.7x instead of 2.2x) because of a few fireflies: without the worst 1% of pixels the 8-neighbour GI is already better than Sobol at 32 spp (4.35e-4 vs 4.68e-4), but 22 pixels off by up to 15x the mean set the RMSE. Those are the plain 1/M resampling weights meeting reconnection pdfs that differ by orders of magnitude between domains, the failure the GRIS pairwise-MIS weights (Lin et al. 2022) exist to bound; the tight Jacobian bound removes the fireflies by rejection at a 0.1% bias. The best case is then 6-8% less error per sample at 8 spp, 2-3% at 32, for 22-43% more GPU time: **a loss per unit of time, rejected as a default; kept behind its flag**.

**Why the pool is empty.** The ray counts give the acceptance rate: 8 neighbours tried add 8.2 M visibility rays over 29.5 M samples, so a neighbour's sample is chosen in 28% of samples, which puts the mean reservoir at about 1.4 candidates. At the 1 px cut of a scanned tile, pixels 16 px apart rarely share a normal within 25° and a depth within 10%: the same sub-pixel geometry that holds 38% of the variance also starves spatial reuse. ReSTIR GI's published gains come from surfaces that are locally flat at the pixel scale; a photogrammetry city at full detail is not one.

**Standing conclusion after Phases 9-11.** Three per-sample techniques (ReSTIR DI, visibility-guided sky sampling, ReSTIR GI) are each implemented, unbiased or measured to 0.1%, and each a loss per unit of GPU time on this scene; Sobol with the a-trous denoiser and MetalFX stays the configuration. The measured structure of the noise says the next lever is geometric: render from the 2 px re-textured cut so a pixel sees one facet and neighbours see each other, which addresses the 38% primary term *and* feeds every reuse method. Measure it first; only then re-run the GI variant on it.

## Phase 12 (2026-10-21): the coarser cut, where ReSTIR GI's pool really goes, and a free 10%

**Coarser cuts do not buy noise.** Each cut rendered to its own 1024 spp reference (noise) and compared with the 0.5 px cut's reference (fidelity), bench shot, Sobol:

| cut | triangles | fidelity vs 0.5 px: RMSE / 8x8 block mean | Sobol RMSE 8 spp / 32 spp |
| :-- | --: | :-- | --: |
| 0.5 px | 257,981 | - | 1.399e-3 / 6.42e-4 |
| 1 px | 195,163 | 2.24e-3 / 1.50% | 1.370e-3 / 6.28e-4 |
| 2 px | 132,193 | 2.95e-3 / 2.22% | 1.356e-3 / 6.24e-4 |
| 4 px | 87,364 | 4.67e-3 / 4.58% | 1.334e-3 / 6.15e-4 |

A third of the triangles (4 px) lowers the noise by 5% and costs 4.6% in block fidelity; ReSTIR GI on the 2 px cut gains exactly what it gained on the 1 px cut (1.277e-3 / 1.248e-3 at 8 spp for 3 / 8 neighbours, bias -0.1%) with the same number of extra visibility rays. So the Phase 10-11 hypothesis that sub-pixel facets hold the primary noise and starve reuse is wrong, and the cut stays at 1 px.

**Where the pool goes.** A counter of resampled candidates per first hit (`optimizations.giMeanCandidates` in the stats, kept) and a diagnostic build counting rejections: with 8 neighbours the mean reservoir holds 1.78 candidates over all samples, 3.4 over samples that hit; of the neighbour lookups, 26% find a pixel with no sample, 16% fail the 25° normal test (loosening it to 60° changes nothing), 1% the depth test and 2% the reconnection. The 26% were the surprise: **21% of first-hit samples end before continuing** (`bsdfSample` fails or the direction is below the geometric surface), so a fifth of all paths carry no sky and no bounce light at all. Bending shading normals to within 30° of the geometric normal does not change that count (790k vs 815k of 3.8 M), so it is not the smoothed normals of `weld()`; 87% of the dead samples had chosen the GGX lobe, which at a roughness near 1 reflects below the horizon most of the time. Fresnel-weighted lobe selection with a 0.1 floor picked that lobe for a tenth of all samples on rough dielectrics.

**Lobe selection by directional albedo (adopted).** `makeBsdf` (Metal) and `MetallicRoughnessBsdf` (CPU) now choose the specular lobe in proportion to its directional albedo (Lazarov's fit of the GGX environment BRDF), floor 0.02. Any mixture weight leaves the estimator unbiased, so the existing references stay valid and the gain is direct:

| | 1 spp | 8 spp | 32 spp | mean ratio | rays (32) |
| :-- | --: | --: | --: | --: | --: |
| Sobol, Fresnel-weighted lobes | 5.96e-3 | 1.370e-3 | 6.28e-4 | 1.0000 | 63.6 M |
| Sobol, albedo-weighted lobes | **5.87e-3** | **1.312e-3** | **5.66e-4** | 1.0000 | 66.2 M |

4% less error at 8 spp and 10% at 32 for 4% more rays (more paths continue), dead first-hit samples 21% to 13% (the rest are the rough lobe's own lost energy, a property of single-scattering GGX), and GPU and CPU still agree to 0.04% in block means. The one change in Phases 9-12 that is a win per unit of time, and it cost nothing. Remaining known term of this kind: a multiple-scattering GGX (Kulla-Conty energy compensation) would return the lost energy of rough lobes; it changes the images, so it is a model decision, not a sampling one.

## Phase 13 (2026-11-03): the 3D scene viewport, stills, full-resolution frames and multiple-scattering GGX

**3D scene viewport.** A "Path traced" toolstrip button (`scene3d/ScenePathTrace.tsx`). It captures what the viewport shows as one GLB (`scene3d/pathTraceSnapshot.ts`: every visible triangle mesh at its world transform with its own material, instanced meshes written per instance up to 30M triangles, the viewport's furniture left out; points, lines and shader materials counted as "not traced", never approximated), posts it to `POST /3d/path-trace/snapshot` (stored by content hash beside the builds, the newest 24 kept, built once with the same builder), and opens a session on it (`/open` with `snapshotId`). The camera goes over in the file's coordinates (world less the file origin, `readSbvgOrigin`). The light is the atmosphere's sun when one is up (elevation and azimuth in the helper's convention), else the studio dome. While a traced frame covers the viewport, the viewport stops drawing its own. "Re-capture" takes the scene again after it changes.

**Shared client.** `services/virtual-geometry/path-trace-client.ts` now runs the session (open, views, frame polling, drawing) for both viewports.

**Full resolution.** The 1280-wide cap is gone: frames are shown at the overlay's device pixels (up to 8192), traced at about 1280 x 720 pixels' worth and scaled up by MetalFX unless a `renderScale` is set.

**Stills.** "Render still" in both viewports. `POST /3d/path-trace/render` renders one denoised 4K, 1024 spp still of the session's file, materials and light, at the live view's exposure, into `renders/path-traced/` with a JSON of how it was made. The agent tool `path_trace_render` does the same for any workspace GLB (camera in the GLB's coordinates, or automatic framing; studio or sun).

**Multiple-scattering GGX** (Turquin 2019), in both tracers. The specular lobe is scaled by 1 + f0 (1 / Ess - 1). Ess, the lobe's directional albedo at F = 1, comes from a 32 x 32 table integrated once for this exact lobe (height-correlated Smith, visible-normal quadrature, 4,096 samples a cell). The Metal kernels get the same numbers as source (`ggxEssMetalSource`), so the two tracers stay at parity. White metal sphere under a white dome, 256 spp:

| Roughness | Single scatter | Compensated |
| :--- | :--- | :--- |
| 0.3 | 0.976 | 0.9996 |
| 0.6 | 0.808 | 0.9994 |
| 1.0 | 0.429 | 0.9981 |

Lazarov's environment-BRDF fit used as Ess overshot to 1.16, so the table replaced it. The fit still sets the lobe-selection weights. All 11 tracer tests pass (GPU/CPU parity on the sun sphere and the checkerboard included), as do 4 route tests (snapshot validation, build reuse, origin offset, still into the workspace).

**Not done.** No live check in the app yet. The snapshot re-encodes textures in the browser, so big staged builds will be slow to capture: the server should assemble the scene from its saved JSON instead, keeping the browser snapshot only for content that exists only there. Mac only.

## Phase 14 (2026-11-04): the scene's own lights, a light tree and MIS

Until now the only light either tracer sampled was the sun. Emissive surfaces counted only when a BSDF ray happened to hit them, and the GLB's lamps were not read at all.

**What the tracers sample now** (`scratchbox_light_tree.hpp`, shared by both tracers and ported line for line into the Metal kernels):
- **Emissive triangles of the traced cut.** Emission is the factor times `KHR_materials_emissive_strength` times the emissive texture, which the loader now reads.
- **`KHR_lights_punctual` point, spot and directional lights**, in glTF units (candela, lux), with the spec's cone falloff and range window.
- **Selection.** Local lights sit in a power and orientation bounding tree (Estevez and Kulla 2018: binned SAOH build, conservative importance, depth capped at 40 levels). Distant lights are picked beside its root. One light is drawn per vertex by walking the tree with one random number.
- **Weighting.** A triangle light's sample is weighted against the BSDF by the power heuristic. A BSDF ray that finds an emitter is weighted with the selection pdf recomputed at the previous vertex (`selectPdf`, walked up from the light's leaf), so no light is counted twice. At the last bounce the light sample takes full weight. Delta lights (point, spot, distant) take no weight.
- **Emitter power.** Each emitter's power in the tree is its own emission read at seven points times its area. A triangle that reads zero is left out, which is always safe: BSDF rays still find it and count it in full.
- **Emission is two-sided**, as the tracers have always shaded it.
- **Indirect clamp.** Emitter light found at bounce 1 or later now goes through the same indirect clamp as the sun.

**Emission at coarse LOD (`.sbvg` version 6).** The coarse levels' baked material carried colour and normals but no emission, so an emitter vanished wherever the cut chose a coarse cluster. Flat grids simplify with zero error, so that happened even at a 0.01 px threshold: the test room's cut was 7,690 of 12,160 leaf triangles. Each re-textured level now also bakes an emission atlas: linear radiance over its own peak, sRGB PNG `<stem>.emission<level>.png`, peak stored in the atlas table. The driver turns it into the level material's emissive texture and factor. The browser reader and the C++ reader accept version 6.

**CPU reference under the studio dome.** `render::Environment` (sky, or uniform dome radiance) lets the CPU backend render without a sun, so lamp-lit scenes have a reference.

**Viewport and switches.**
- **Snapshot.** `pathTraceSnapshot.ts` writes the viewport's point, spot and directional lights into the GLB at their world placement. The atmosphere's sun stays the tracer's own sun. Area lights have no glTF form and are listed as not traced.
- **Comparison switch.** `lighting.sampleLights: false` turns light sampling off: BSDF rays alone, no punctual lights.
- **Stats.** `stats.lights` and the session's view event report what was sampled.

**Measured** (M1 Ultra, machine load 200-380, so timings are not comparable to earlier phases; `packages/core/test/metal-path-tracer.test.ts`, "Path tracer scene lights"):

| Check | Result |
| :--- | :--- |
| Panel only, studio dome off, 2048 spp: light sampling against BSDF rays alone | mean ratio 1.0016 (unbiased both ways) |
| Same, 16 spp, relative RMSE on lit surfaces (pixels seeing the panel left out) | 0.976 with the light tree + MIS, 4.028 BSDF only: 4.1x lower |
| Panel + point + spot + directional, 128 spp, GPU against CPU | same cut, rays within 0.5%, mean ratio 1.0000, block error under 2% |
| Point light at 1 m against 2 m | 3.9-4.1x (inverse square) |
| Twice the intensity | 2.00x |
| Spot aimed down, centre inside the inner cone | equals the point light of the same intensity |
| Spot aimed away | exactly 0 |
| 4 lux directional straight down against a 4 cd point 1 m up | within 3% |

Proof sheet: `docs/screenshots/path_tracer_scene_lights_2026-11-04.png`. The existing tracer tests still pass (furnace, sun parity, checkerboard parity, denoise parity, sampler, coarse atlases, resident session).

**Not done.**
- The light sampling leaves a few fireflies at 16 spp, from paths that reach the panel through the rough metal sphere.
- With a bounce cut, emissive triangles come from that cut. With `bounceShadowRays: false`, shadow rays to those coarse emitters trace the fine cut and can be blocked by the fine emitter itself.
- Viewport point/spot export not yet checked live in the app.
- Glass and transmission, participating media, and the material extensions are the next phases.

## Next (plan)

- Metallic-roughness atlases; a quad-aware pairing to lift the 81% paired share.
- Phase 4: the a-trous denoiser on the GPU and temporal reuse.
- Rays: rasterize the camera hit with the existing WebGPU cluster pass; coarser cuts for bounce and shadow rays; any-hit shadow rays (done); merged per-chunk acceleration structures; better samplers; MetalFX upscale.

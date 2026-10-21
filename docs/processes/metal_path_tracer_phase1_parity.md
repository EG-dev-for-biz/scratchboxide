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

## Next (plan)

- A group-merging step for stuck groups so the DAG continues past level 7; metallic-roughness atlases; a quad-aware pairing (pair across the longest shared edge first) to lift the 81% paired share.
- Phase 4: the a-trous denoiser on the GPU and temporal reuse.
- Rays: rasterize the camera hit with the existing WebGPU cluster pass; coarser cuts for bounce and shadow rays; any-hit shadow rays (done); merged per-chunk acceleration structures; better samplers; MetalFX upscale.

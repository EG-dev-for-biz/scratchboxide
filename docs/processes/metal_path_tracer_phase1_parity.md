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

## Next (plan)

- Phase 3: a resident helper process driven by the Electron app, frames through shared memory into the `VirtualGeometryViewport`, a "Path traced" toggle.
- Re-textured coarse levels for charted photogrammetry, so the DAG regains its depth without crossing seams.
- Phase 4: the a-trous denoiser on the GPU and temporal reuse.
- Rays: rasterize the camera hit with the existing WebGPU cluster pass; coarser cuts for bounce and shadow rays; any-hit shadow rays (done); merged per-chunk acceleration structures; better samplers; MetalFX upscale.

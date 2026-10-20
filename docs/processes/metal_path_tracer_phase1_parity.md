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

## Next (plan)

- Phase 2: `.sbvg` version 3 with UVs and per-triangle material ids; the simplifier keeps material borders and UV seams as it keeps group borders.
- Phase 3: a resident helper process driven by the Electron app, frames through shared memory into the `VirtualGeometryViewport`, a "Path traced" toggle.
- Phase 4: the a-trous denoiser on the GPU and temporal reuse.
- Rays: rasterize the camera hit with the existing WebGPU cluster pass; coarser cuts for bounce and shadow rays; any-hit shadow rays (done); merged per-chunk acceleration structures; better samplers; MetalFX upscale.

# Python composes, C++ loops: implementation plan

Date: 2026-10-27. Status: plan, not started. Design and rationale: `2026-10-27-cpp-python-split-design.md`.

Three phases, each landing as its own small commits. Phase 2 depends on the golden meshes captured at its start;
Phase 3 is independent of Phase 2 and may run alongside it.

## Phase 1: Write the rule down

| File | Change |
|---|---|
| `AGENTS.md` §3 | Rule 9, "Python composes, C++ loops", condensed from the design's §2 table (for coding agents) |
| `packages/core/src/node/gemini/prompt-builder.ts` | Tell the in-app agent its job is composition: per-vertex work goes to the four operators and mesh ops; never compute vertices in Python loops |
| `execute_3d_python_script` tool description (`packages/core/src/node/gemini/tools/`) | Same guidance, one sentence |

Check: `packages/core/test/instruction-tool-drift.test.ts` stays green.

## Phase 2: One native kernel per operator

### 2.0 Capture goldens first

Before touching any builder, write the current outputs (positions, indices, vertex and index counts) of:

- `object_spec` sweep and revolve parts, from the fixtures in `test/object-build-spec.test.ts`;
- `sweep_curve_profile`, `revolve_harmonic_solid`, `replicate_metric_array` over a spread of parameters (keyframes,
  twist, modulation, lobes, helix, both replication modes).

Store them as test fixtures; the parity test in 2.6 compares against them.

### 2.1 Sweep (`scratchbox_shaper.hpp`, `Shaper::sweep` :759)

Add an overload taking:

- explicit carrier samples `us` (arc-length fractions) and a closed-loop flag;
- profile keyframes `{t, width, height, exponent}` (superellipse, interpolated along t);
- a twist curve as `(t, deg)` pairs;
- radial modulation `{amplitude, frequency}`;
- an explicit ring parameterisation `vs`.

Reuse `rotationMinimizingFrames` and `Loft3D::skin`. The existing signature keeps its behaviour byte-identical.

### 2.2 Revolve (`Shaper::revolve` :1004)

Add an overload with anchor and axis, `lobeCount`, `lobeDepthRatio`, `helixPitchM` and explicit meridian samples. The
existing signature is unchanged.

### 2.3 Replicate

`replicate_along_curve` and `replicate_on_grid` already exist natively. Add `orient` (false translates only, matching the
current Python behaviour), so a polar ring is a closed circular carrier rather than its own code path.

### 2.4 Bindings and stubs

Bind the new overloads in `bindings/python_bindings.cpp` (`m_shaper` around :1092–1111, `m_geom` around :676–696), then
`npm run stubs:sb` (regenerates `typings/` and `src/node/3d-engine/sb-api.generated.ts`).

### 2.5 Python wrappers

- `adaptive_object.py` (:432–661): `sweep_curve_profile`, `revolve_harmonic_solid`, `replicate_metric_array` become
  argument validation plus one native call. `profile` strings are replaced by `profile_exponent` and
  `profile_dimensions`. Update every caller (grep `profile=` and the three names across `packages/`, `scripts/`, and the
  prompt text).
- `object_spec.py` `_build_sweep` (:728), `_build_revolve` (:870): keep `_relief_refinement`, `_u_samples`,
  `_check_grid_budget` and the edge budget in Python; pass control points, keyframes, `us` and `vs` to the native kernel
  and drop the Python frame and ring evaluation.

### 2.6 Checks

- C++: extend `native/3d-engine/test_shaper_sweep_replicate.cpp` with keyframe, lobe, helix and `orient` cases (vertex
  counts, watertight closure, bounding boxes).
- Parity: new vitest comparing against the 2.0 goldens; positions within 1e-4 m, identical vertex and index counts.
- Speed: time a 2,000-ring x 64 sweep and a 128-lobe revolve before and after; record both in the commit message.

## Phase 3: Scan-size algorithms out of `__init__.py`

1. Profile one ESB run of `site_tiers`, `site_score` and `write_textured_building`
   (`docs/benchmarks/empire_state_building.json`, `packages/core/test/fixtures/esb-tier0-footprint.json`).
2. Port only functions over 10% of runtime or whose loops grow with scan size. Candidates: `_rectilinear_consensus`,
   `_simplify_ring`, `_hull_area`, `_min_rect_axis_deg`, `_scan_shell`, `_outer_shell_interior`, `_gap_report`, LAB
   helpers.
3. For each, look first for an existing native equivalent in `scratchbox_footprints.hpp`,
   `scratchbox_scan_massing.hpp`, `scratchbox_scan_geom.hpp`, `scratchbox_material_maps.hpp`; reuse it, else add the
   function there and bind it.
4. Composition (`site_tiers`, `create_building_parts`, `stack_buildings`, `library_surface` selection) stays in Python.
5. Check: identical outputs on the ESB fixture before and after; profile again and record the change.

## Out of scope

Pipeline K's TypeScript pixel kernels; see the design's §4.

## Verification (whole plan)

- Vitest with credentials unset and an empty HOME: `object-build-spec`, the new parity test,
  `python-3d-scene-synthesis`, `python-3d-api-reference`, `python-engine-mesh-integrity`, `sb-stubs`,
  `sb-script-typecheck`, `instruction-tool-drift`, `adaptive-domain-architecture`.
- `scripts/test_pillar11_operators.py`, `npm run typecheck`, `npm run lint:primitives`.
- Live app (operate-scratchbox skill, own `scratchbox-<branch>` launch entry, stage caches cleared): one
  `build_3d_object_from_reference` build and one `execute_3d_python_script` prompt that uses all four operators.
  Screenshots to `docs/screenshots/`, judged with the `visual-critic` skill.

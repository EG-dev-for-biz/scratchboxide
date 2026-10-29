# Python composes, C++ loops: where 3D logic lives

Date: 2026-10-27. Status: design, awaiting decision. Scope: 3D generation reached from the in-app agent's Python
(`import scratchbox as sb`, run by `execute_3d_python_script` and `build_3d_object_from_reference`) and the native
engine underneath it. Implementation plan: `2026-10-27-cpp-python-split-plan.md`.

## 1. Problem

Nothing says which logic belongs in the C++20 engine and which is the agent's job when it writes Python. The code
shows what that costs.

| Where | What it holds | Why it is a problem |
|---|---|---|
| `scratchbox_shaper.hpp` `Shaper::sweep` (:759), `Shaper::revolve` (:1004) | Native sweep with rotation-minimising frames, twist, scale lerp; native lathe | Lacks profile keyframes, twist curve, modulation, harmonic lobes, helix, arbitrary axis, so Python reimplements them |
| `scratchbox/adaptive_object.py` `sweep_curve_profile`, `revolve_harmonic_solid`, `replicate_metric_array` (:432–661) | The agent-facing operators | Every frame and ring vertex computed in Python loops, then handed to `create_loft`. `profile="CIRCULAR" \| "BEVELED_RECT" \| "I_BEAM"` is a closed string switch (AGENTS.md §1) |
| `scratchbox/object_spec.py` `_build_sweep` (:728), `_build_revolve` (:870) | The richest version: profile keyframes with superellipse exponent, twist curve, lobes, helix, edge-length sampling, relief refinement | Written entirely in Python tuple maths; a third implementation of the same two operators |
| `scratchbox_relief.hpp` `apply` with `Layer`s | The fourth operator (isoparametric relief) | Already right: C++ only |
| `scratchbox/__init__.py` (3,584 lines) | Composition (`site_tiers`, `create_building_parts`, `stack_buildings`) mixed with algorithms whose loops grow with scan size (`_rectilinear_consensus`, `_simplify_ring`, `_scan_shell`, `_outer_shell_interior`, `_gap_report`, LAB maths) | Scan-size work runs in interpreted Python; the boundary is invisible |

The helper library from the external drive (`scratchbox_ide_arch_helpers.py`: `add_fluted_art_deco_column_y`,
`add_swept_cornice_ring_y`, ...) is the same question from the other side: named-category vocabulary that cannot go into
the `sb` package as library functions (AGENTS.md §1.5: never design code around named categories).

## 2. The rule

| Layer | Owns | Test |
|---|---|---|
| **C++ engine** (`packages/core/src/native/3d-engine/include/*.hpp`, bound in `bindings/python_bindings.cpp`) | Anything whose inner loop grows with output resolution: vertices, rings, texels, scan samples, rays. The four operators, mesh ops, scan analysis, image kernels, GLB I/O. Inputs are continuous parameters only, never names | Does the loop count grow when finer output is asked for? Yes → C++ |
| **`sb` Python package** (`packages/core/src/python/scratchbox/`) | Thin validated wrappers turning friendly arguments into native calls; composition helpers that loop over parts, not vertices; actionable errors | A function's per-call cost is dominated by its native calls |
| **Agent-written Python** (runtime, per prompt) | Design intent: which parts exist, their dimensions, placement, materials, assembly. Named vocabulary lives here: an "Art Deco column" is the agent's own revolve plus relief, written for this prompt | Could a concept nobody anticipated be expressed without editing the package? It must be |
| **TypeScript pipelines** (orchestrator, pipeline K) | Orchestration, caching, provenance, product policy (AGENTS.md §4). Never agent-editable | Outside this design except the follow-up in §4 |

### Corollaries

1. Named architectural or mechanical vocabulary never becomes `sb` library code; it is what the agent writes. Scripts
   like the external helper library are reference material for prompt examples, not code to import.
2. The agent may loop freely over parts. If it needs a per-vertex operation that `sb` lacks, the answer is a new C++
   kernel, not a Python loop.
3. Sampling *policy* (how many rings for an edge budget, where relief needs refinement, grid budgets) may stay in
   Python: its cost scales with the number of samples chosen, not with the work per sample, and it is a decision. Sampling
   *evaluation* (frames, rings, skinning) is C++.
4. Execution never branches on a string label. Profiles, lobes and replication patterns are continuous parameters.

### Why this split

- **Speed where it compounds:** per-vertex Python costs grow with every resolution increase. Per-part Python is
  negligible next to the native calls it makes.
- **One implementation per operator:** three sweeps drift apart; one kernel with continuous parameters cannot.
- **The agent stays creative:** the `sb` surface is small and general, and everything prompt-specific is the agent's own
  composition, which is what ADA asks for.

## 3. Decisions taken in this design

- `profile` strings in `sweep_curve_profile` are replaced, not aliased: continuous `profile_exponent` and
  `profile_dimensions`, with every caller and the prompt text updated in the same change.
- The `object_spec` builders keep their sampling decisions in Python and hand evaluation to the native kernel; outputs
  must match the current Python builders within 1e-4 m.
- Scan-size helpers move to C++ only where profiling on the ESB shows they matter (over 10% of runtime, or loops growing
  with scan size), and only after checking `scratchbox_footprints.hpp`, `scratchbox_scan_massing.hpp`,
  `scratchbox_scan_geom.hpp` and `scratchbox_material_maps.hpp` for an existing equivalent.

## 4. Open follow-up

Pipeline K's TypeScript pixel kernels (k-means and NCC rhythm in `material-regions.ts`; `windowGrid`, `facadeSamples`,
`photoLattice` in `facade-lattice.ts`) are C++ candidates under the same rule. That belongs to the pipeline K work in
flight (and to SB-Fenestra, `2026-10-27-sb-fenestra-window-fit-design.md`, which already proposes a native window model),
so it is decided there, not here.

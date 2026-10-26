# Process: `location_fit_object` — clean swept geometry for thin residual members (water tower legs, masts, drainpipes)

> **Recorded:** 2026-10-25
> **Status:** Verified live (real residual audit + generated script actually executed and produced a valid GLB)
> **Tags:** `gemini-tools`, `location-evidence`, `residual-audit`, `sweep-curve-profile`, `replicate-metric-array`, `believability-first`
> **Target Domain:** 3D Building staging — residual-cluster shape fitting

---

## 1. Why

A screenshot of a live Haughwout Building rebuild showed a rooftop water tower whose support legs rendered as raw, tangled, asymmetric scan residue — not clean geometry. The question that prompted this: what tools exist, or are missing, to carve clean leg/strut geometry instead of leaving it as unexplained scan triangles.

## 2. What was already there (two rounds of investigation)

* The native engine's sweep/replicate operators (AGENTS.md's operator 1, "SE(3) curve sweeps... limbs, hoses, struts", and operator 3, "affine metric replicators... bolt circles") are **already fully shipped**, not a gap: `sb.sweep_curve_profile(path, profile='CIRCULAR', profile_dimensions, scale_taper, twist_deg, ...)` and `sb.replicate_metric_array(distribution_mode='CURVE_1D', guide_points, pitch_meters, seed_geometry, ...)` are documented in `sb-api.generated.ts` and callable today through the existing `execute_3d_python_script` tool (`python-3d-tools.ts:191`).
* `residual-audit.ts`'s `AuditedCluster` already computes everything a carrier curve needs — `slices: Array<{y, cx, cz, r, ...}>` (a per-height circle fit, i.e. a ready-made centreline) and `symmetry: {radialSymmetry, radiusMedianM, crossSectionConstancy, periodicity, periodM}` — and its own comment (line 148, before this change) already named `location_fit_object` as a planned consumer. It just never existed.
* `location_residual_audit` (the existing tool) writes the *full* audit JSON to disk (every cluster, `slices` included) but only returns a *trimmed* summary to the agent (no `slices`, no `radiusMedianM`/`periodM`) — so the carrier-curve data was on disk and reachable by path, just never surfaced.
* **Scope-defining finding:** `execute_3d_python_script` always starts a *new* scene — "nothing is carried over from the scene already on the canvas." There is no existing mechanism to splice generated geometry back into a staged build in place of a residual cluster. That integration step doesn't exist yet, for this tool or any other.

## 3. What was built

New file `packages/core/src/node/gemini/tools/location-evidence/fit-object.ts`, wired into `location-evidence-tools.ts` / `tool-registry.ts` the same way as its sibling tools (generic array iteration, no special-casing needed).

`location_fit_object(resultJson, clusterId)`:
1. Reads the full audit JSON `location_residual_audit` already wrote, finds the cluster.
2. Refuses scan-artefact clusters (`not_real`) — only real-object/unsure clusters are worth fitting.
3. Classifies from measured shape numbers alone (mirrors the existing tank/chimney classifier pattern in `residual-audit.ts:309-317`):
   - **single-member** — high verticality, slenderness, and cross-section constancy, low periodicity (a mast, drainpipe, flagpole, single leg if scanned as its own cluster). Carrier curve and radius come straight off the measured slice fits.
   - **bundle** — high verticality and slenderness, high *periodicity* (the audit's own circumferential-repeat measure) — a radial bundle of thin members (a water tower's four-plus legs, cross-bracing).
   - **none** — reports which measures fell short, no geometry emitted.
4. Returns a ready `execute_3d_python_script` script for a **standalone preview** GLB.

### Honesty boundary (the part worth reading carefully)

For a **bundle**, the audit's per-height data is one *aggregate* circle fit across all legs combined — it cannot tell you one leg's own thickness or exactly how many legs there are. Those two numbers (`memberRadiusM`, `memberCountGuess`) come back in a separate `estimated` field, explicitly labelled as not measured. The generated script itself does **not** use the estimated count — `sb.replicate_metric_array` is told to space copies by the *measured* period (`pitch_meters = periodM`), so the actual number of legs placed comes from real data wherever the engine can determine it, not from this tool's guess. This follows AGENTS.md's "believability first, honestly labelled" rule: a plausible labelled fill where data is genuinely missing, never a confident fabrication.

## 4. Tests

`packages/core/test/location-fit-object.test.ts` — 7 tests, pure synthetic fixtures (no native binary, no network):
- a slender constant-section non-periodic member → `single-member`, script uses `sweep_curve_profile` only;
- a slender periodic member → `bundle`, script uses `replicate_metric_array` with the measured `pitch_meters`, `estimated` field present and non-null;
- a short/squat or non-vertical cluster → `none`;
- too few valid slices → `none` with a clear reason, not a crash;
- `runFitObjectTool` end-to-end against a hand-written `residual_audit.json`: fits by id, refuses a scan-artefact cluster (`not_real`), errors clearly on an unknown cluster id or missing file.

All pass; `tsc --noEmit` clean; `instruction-tool-drift.test.ts` (87 tests) and `residual-audit.test.ts` (5 tests) unaffected.

## 5. Live verification (2026-10-25, same session)

Ran the real pipeline directly (no chat UI needed — the dev-server slot limit was already at 5/5 from other sessions, so this called the tool functions directly rather than through a live agent turn): `runResidualAuditTool` against the actual Haughwout Building pipeline E build (run `88eae258`, compiling and running the real native `residual_audit` binary, not a stand-in).

* **Real data, real results:** 58 clusters, 5 real-objects, 13 unsure, 40 artefacts. Of the 18 non-artefact clusters, **3 classified as `single-member`** (confidences 0.42, 0.74, 0.81) and 0 as `bundle` — this building's own scan residue happened not to include a multi-leg assembly. (Separately worth noting: the tangled water-tower legs from the original motivating screenshot were in *Pipeline I's Trellis-generated* geometry, not Pipeline E's scan residual — `location_residual_audit` only ever looks at scan residue, so this tool as built does not reach that specific generated-geometry case. It solves the sibling problem: real scan residue that reads as a clean member, which is still a genuine, distinct gap this fixes.)
* **A real bug was found and fixed by this test:** the generated script was missing `import scratchbox as sb` — `execute_3d_python_script` requires every script to start with it (per the tool's own description), and without it the script failed immediately with `NameError: name 'sb' is not defined`. Added the import to both script branches (single-member and bundle), added a regression assertion to both corresponding unit tests (`toMatch(/^import scratchbox as sb$/m)`), confirmed via a second live run.
* **After the fix, cluster 5's generated script actually ran and produced a real GLB:** 192 vertices, 284 triangles, one connected part (`structureReport.passed: true`, no floating pieces), bounding box `0.32m x 1.16m x 0.27m` — matching the measured carrier (`heightM 1.55`, `radiusMedianM 0.26`). `execute_3d_python_script`'s own `GeometricComplexityGate` flagged it as under its 5,000-vertex prop minimum (a thin single-tube sweep is naturally low-poly) — a quality note (raise segment counts), not a correctness failure; `success: true` throughout.

## 6. Not yet done

* **Not verified against a real multi-leg cluster specifically** — the live building tested didn't happen to have one in its scan residue (see above). The `bundle` branch is unit-tested with synthetic fixtures only.
* **Splicing the result back into the staged build is not implemented anywhere** — today this only produces a standalone preview GLB, exactly as `execute_3d_python_script` allows. The tool's description says this plainly rather than imply the residue gets replaced in place.
* The `memberRadiusM`/`memberCountGuess` estimate formulas (bundle case) are simple, bounded heuristics, not validated against a real multi-leg structure — the generated geometry's actual leg *placement* still comes from the measured period, so the visual result should be more trustworthy than the reported estimate numbers alone, but this hasn't been checked against a real case.

## 7. Not committed

`fit-object.ts` (new), `location-evidence-tools.ts` (wiring), `location-fit-object.test.ts` (new) are in the working tree, verified at the unit level and live against real data, but uncommitted pending the user's go-ahead.

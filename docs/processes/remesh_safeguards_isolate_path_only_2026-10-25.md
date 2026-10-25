# Process: the remesh/isolate safeguard trail only protects the single-building isolate path, not district-wide returns

> **Recorded:** 2026-10-25
> **Status:** Verified (code-read + cross-checked against two real run records already on disk; no code changed)
> **Tags:** `staged-location`, `structure-pick`, `footprint-lock`, `isolate`, `district`, `remesh`, `pipeline-e`
> **Target Domain:** 3D Building staging — scope boundary of the remesh/isolate safeguards

---

## 1. Why

Earlier the same day this session traced the real improvement history behind "remesh has gotten better": `80f1f76f` (2026-10-15, one-structure-pick + request-sized extraction) through `201a5a93` (2026-10-24, this session's own `footprintClampEdits` fix, which turned the footprint lock from measure-only into an actual re-fit). That trail was illustrated by two builds run back-to-back this session: a "Piazza del Duomo, Milan" build (`isolate: false`, a plaza/district query) whose `remesh` stage degraded straight to the raw 1.79M-triangle merged scan with every downstream stage skipped, and a Flatiron Building build (`isolate: true`, a single named structure) whose `remesh` stage degraded for a completely different, more specific reason — `checkIsolate` rejecting the pick (IoU 0.27) before `massing-choice`'s scan-led chooser could ever run (`docs/processes/massing_choice_flatiron_live_test.md`).

The user asked directly whether the improvement trail only covers district returns, not single buildings. It's the reverse — this doc exists to state that precisely, with code evidence, so it isn't re-derived from scratch next time this question comes up.

## 2. What was checked

Read the actual gating logic in `packages/core/src/node/3d-engine/staged-location/orchestrator.ts`, then cross-checked it against the two real run records already on disk from this session (no re-run needed):

1. **Structure pick** (`pickStructure`/`sizeExtraction`, `extraction-sizing.ts`) only runs inside `if (request.isolate) { ... }` (`orchestrator.ts:1497`). When `isolate: false`, this block is skipped entirely and extraction stays at the flat district radius (`request.radiusM ?? 250`) — no structure is ever picked out of the scan.
2. **The isolate-mismatch check** that rejected the Flatiron pick (`checkIsolate`) only runs inside `if (isolateMode)` (`orchestrator.ts:3204`), where `isolateMode = !!structure` (`:1688`) is itself only set when `request.isolate && sizedTo === 'structure'` (`:1687`).
3. **`checkFootprintLock`/`clampToFootprint`** (this session's `201a5a93` fix) is called at exactly two sites (`orchestrator.ts:3115`, `:3664`), both inside the pipeline E/G massing/grammar rebuild, which itself only runs when `pipelineE = stagedPipelineE() && request.isolate` (`:1757`). It also takes a single picked structure's massing `parts` as input — it is structurally incapable of running against a multi-building district mesh even if it were called.
4. **Run-record cross-check:** the Duomo run (`isolate: false`, `.scratchbox/cache/staged_location/runs/7f396d88/`) has no `pipeline_e.json` at all — only `stages.json`/`timeline.jsonl`. None of this machinery ran. The Flatiron run (`isolate: true`) does have a `pipeline_e.json`, and it exists only because `isolate: true` was set.

## 3. Result

Confirmed on all four points: **every fix in the "remesh has improved" trail — vector-footprint seeding, tight-footprint containment, the footprint lock, and this session's clamp fix — is isolate-path-only.** A whole-district return (`isolate: false`, a plaza, a block, an area query with no single named building) gets none of it. When a district-scale `remesh` can't settle on one structure, it has exactly one fallback today: ship the whole merged raw scan, untextured, with every downstream stage (massing, grammar, relief, texture) skipped. That's precisely what the Duomo run did.

## 4. The implication

The two run failures this session hit are not variations on one bug — they're genuinely different failure modes at different points in the pipeline, gated by the same flag:

| | `isolate: false` (district) | `isolate: true` (single building) |
| :--- | :--- | :--- |
| Example this session | Piazza del Duomo, Milan | Flatiron Building |
| Structure pick runs? | No | Yes |
| Footprint lock / clamp applies? | No (nothing to lock to) | Yes |
| What failed | Nothing isolated at all; raw merged scan shipped | A structure *was* picked, but `checkIsolate` rejected it as not matching (IoU 0.27) |
| Current fallback | Whole district, untextured, no downstream pipeline | Whole district (the same fallback, for a different reason) |

Both failure modes currently land on the identical "ship the raw district" fallback — which means a multi-building plaza query and a single acute-footprint building whose isolate failed are, today, visually indistinguishable in the output, even though the causes are unrelated. `location_split_block` (`62fab439`, 2026-10-19) already exists and does per-footprint splitting for a block, but it is not wired into `remesh`'s degraded path for either case.

## 5. Not done

* No code changed — this is a scope clarification, not a fix.
* Did not check whether `location_split_block` could be wired into the district-return fallback (named as a next step in this session's own remesh-improvement summary, not attempted here).
* Did not check whether other staged-location stages (`vision`, `correct`, `detail`) have the same isolate-only gating, or whether any of them apply partially to district builds — out of scope for this check.

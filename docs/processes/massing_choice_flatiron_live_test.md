# Process: `massing-choice` on a genuinely new building — the Flatiron Building blocks earlier than massing

> **Recorded:** 2026-10-25
> **Status:** Verified live (real headless staged-location run against the real Flatiron Building, real Google Maps/3D Tiles data)
> **Tags:** `massing-choice`, `scan-massing`, `flatiron-building`, `pipeline-e`, `isolate-check`, `watch-staged-build`
> **Target Domain:** 3D Building staging — massing candidate selection (unmerged branch) and the isolate gate upstream of it

---

## 1. Why

The user asked to see `massing-choice`'s scan-led `chooseMassing()`/`runScanMassing()` tested on a completely new building — not Haughwout (this session's own benchmark) and not the Empire State Building (already tested by a peer session, see `docs/plans/supertall-massing-shape-fix.md`). The Flatiron Building (175 Fifth Avenue, New York) was chosen: it's a well-documented hard case already referenced in this codebase's own comments (`footprint-lock.ts`'s note on "the Flatiron's rounded prow") for its acute triangular footprint and curved "prow" at the converging intersection of Fifth Avenue and Broadway.

## 2. What was attempted

A real headless run of the staged-location pipeline (`scripts/dev/staged-replay.ts --runs 1 --query "Flatiron Building, 175 Fifth Avenue, New York, NY" --isolate true --procedural false`), from the `massing-choice` worktree so the orchestrator's `structure_scan` run-note (massing-choice's required input, not yet on `main`) would be written right after the `remesh` stage, exactly as it was for the Haughwout test. This bills real Google Maps/Places/3D-Tiles APIs — no mocks, no offline data.

The chat UI was deliberately avoided for this run: the `massing-choice` worktree's dev server (port 3700) was found to have another session's in-flight build ("Piazza del Duomo, Milan") using the same on-disk chat-session storage, so driving it risked colliding with that session's work. The CLI replay script (the same pattern already used for the Haughwout and vector-evidence tests, see `docs/processes/staged_location_pipeline_e.md`) avoids the UI entirely.

## 3. Result: the run never reached `massing-choice`

The geocode resolved correctly (`40.74106, -73.989699`, "Flatiron Building, 175 5th Ave, New York, NY 10010, USA") and the district tiles extraction (62,919 triangles) loaded fine. But the **`remesh` stage itself degraded** before pipeline E's massing (and before `chooseMassing()` could ever be invoked):

> `remesh degraded in 14.3 s: l2 127679 tris - tile_refine isolated a different structure than the one picked: only 54% of it lies on the footprint picked (375 m² isolated against 116 m² picked, 100% of the pick covered, seed 14.5, -24.5), so the district around it is shown whole instead of a partial isolate, and nothing is rebuilt`

`checkIsolate()` rejected the isolate (IoU 0.27, agreement 0.54, per `.scratchbox/cache/staged_location/runs/a9de6c0f/pipeline_e.json`). Per the orchestrator's own fallback path (`orchestrator.ts`, `runPipelineE`'s `fallBack()`), this `return`s **before** the line that writes the `structure_scan` run note — so unlike the Haughwout run, no note existed for `chooseMassing()`/`runScanMassing()` to consume. The pipeline fell all the way back to the un-isolated full district (the "current pipeline" fallback), and the run finished (`success: true`) with a degraded `remesh` and a downstream `grammar` degradation that followed from it — but **`massing-choice`'s scan-led chooser was never reached on this building**, because a more fundamental, earlier gate failed first.

This is itself the finding: for Haughwout and the ESB, `massing-choice` was reachable because pipeline E's isolate was clean; for the Flatiron, it is not — so the question "which of the four candidates wins" doesn't yet have an answer for this building. No coverage/precision table exists for the Flatiron, honestly: fabricating one by force-feeding the rejected isolate into `runScanMassing()` would misrepresent a corrupted structure as the real building and was not done.

## 4. Visual confirmation

Rendered directly from the real GLBs this run produced (`parseGlbNodes` + the test suite's `renderSoups`/`encodePng` helpers, no browser needed), under `docs/screenshots/flatiron_massing_choice_2026-10-25/`:

| File | Shows |
| :--- | :--- |
| `04_flatiron_district_context_plan.png` | Plan (top-down) view of the full district scan (grey, 62,919 tris) with the rejected isolate attempt highlighted in orange, centred on the Fifth Ave/Broadway intersection. |
| `05_flatiron_district_context_oblique.png` | Oblique view of the same scene — the real Flatiron Building's iconic curved prow and flat facade are clearly recognisable in the grey district scan (the raw data is good), with the rejected isolate (orange) visible as a thin strip down one edge of the building, not the building as a whole. |
| `01_flatiron_rejected_isolate_oblique_A.png`, `02_..._oblique_B.png`, `03_..._plan.png` | The rejected isolate mesh alone, at three angles — a tangled, sawtoothed vertical sliver (1,550 triangles), not a coherent building mass. |

The oblique context view (`05`) makes the failure legible at a glance: the scan itself clearly resolved the Flatiron's distinctive shape, but the pick/isolate step only captured a narrow edge strip of it, not the building's acute triangular mass.

## 5. Why this likely differs from Haughwout and the ESB

Not yet root-caused (out of scope for this test — it would mean reading `pickStructure()`'s raised-cell/connectivity logic and the Google vector footprint actually returned for this address), but the numbers point at the acute triangular geometry itself: the picked footprint (116 m², from vector/structure seeding) is far smaller than the Flatiron's real ~550 m² footprint, suggesting the seed or raised-cell walk under-captured the building's narrow point before growing outward — plausibly because `extraction-sizing.ts`'s opening/connectivity rules (built and tuned against more conventional rectangular massing) treat the acute, narrowing prow differently than a typical block-shaped structure. This is a distinct failure mode from Haughwout's "scan geometry doesn't fit flat tiers" (clean isolate, bad massing fit) and the ESB's (clean isolate, `tiers` wins) — here the isolate itself never produces a usable single-structure scan to hand `massing-choice` in the first place.

## 6. Not done

* No `chooseMassing()`/`runScanMassing()` candidate table for the Flatiron Building — blocked by the isolate failure above, not run on corrupted data to force a result.
* No root-cause fix attempted on `pickStructure()`/`extraction-sizing.ts` for acute/narrow footprints — this test's job was to surface a real gap, not fix it.
* Did not retry with `--isolate false` (whole-district, no single-structure pick) to see whether a hand-derived footprint could let `massing-choice` run anyway — would depart from testing the pipeline as it actually runs today, and wasn't attempted given time scope.
* No code was changed. The throwaway render script (`scripts/dev/_flatiron_render_scratch.ts`, in the `massing-choice` worktree) is not meant for commit.

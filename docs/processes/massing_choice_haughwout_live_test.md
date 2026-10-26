# Process: `massing-choice`'s scan-led massing, tested live against the Haughwout benchmark

> **Recorded:** 2026-10-25
> **Status:** Verified live (real `chooseMassing()`/`runScanMassing()` run against the real Haughwout scan)
> **Tags:** `massing-choice`, `scan-massing`, `haughwout-benchmark`, `watch-staged-build`
> **Target Domain:** 3D Building staging — massing candidate selection (unmerged branch)

---

## 1. Why

The user asked whether the codebase has an improved massing method worth testing. `docs/plans/supertall-massing-shape-fix.md` (already on `main`) names one: `massing-choice`'s `chooseMassing()`, on the unmerged `massing-choice` branch/worktree (`.claude/worktrees/massing-choice`) — a scan-led massing chooser that already scored IoU 0.92 on the Empire State Building (vs 0.19 from Pipeline I's generative approach). That plan only tested the ESB. This session's own benchmark is the Haughwout Building, untested there — worth checking since a "wedding-cake" supertall and a flat-faced cast-iron historic building are very different shape challenges.

## 2. What was tested

`chooseMassing()`/`runScanMassing()` (`scan-massing.ts`, massing-choice branch) picks the simplest of four candidates — **block**, **block + roof objects**, **tiers**, **lofted sections** — that explains the real scan within tolerance (`minCoverage: 0.9`, `minPrecision: 0.85`). Ran it directly (no dev server — the session's 5-server cap was already exhausted by other sessions; same direct-function-invocation approach used for `location_fit_object` earlier) against the Haughwout Building's real isolated scan GLB (`tile_refine` cache, 469KB clay mesh, 15,416 samples) and its real Google vector footprint, both already sitting in the main checkout's cache from this session's earlier builds.

## 3. Result

| Candidate | Coverage | Precision | Accepted |
| :--- | :--- | :--- | :--- |
| block | 0.674 | 0.508 | no |
| block + roof objects | 0.922 | 0.775 | no (precision short) |
| tiers | 0.945 | 0.712 | no (precision short) |
| **lofted sections** | **0.987** | **0.957** | **yes** |

**`chooseMassing()` picked `lofted sections`** — notably *not* `tiers`, the candidate that won for the Empire State Building. Haughwout's own scan geometry (a flat-faced building with projecting cornices and a non-trivial rooftop water tower + bulkhead) isn't explained well enough by a stack of flat horizontal tiers (0.71 precision, well under the 0.85 bar); the chooser correctly fell through to the next-most-detailed candidate and that one passed cleanly.

**Visually:** rendering the raw scan and the chosen lofted-sections massing side by side (screenshots sent to the user) shows the massing closely following the real facade's banded window-row pattern *and* the rooftop water tower — straight from measured data, not a generative guess. This is the same water tower whose tangled Trellis-generated legs were the original motivation for this session's `location_fit_object` work; here it shows up correctly-shaped because it comes from the scan directly, not a 4-view neural reconstruction.

## 4. The real limitation this run surfaces

`asMassingParts()` on the chosen result returns `{reason: "the scan chose lofted sections, which has no flat walls for a facade to be read onto"}`. **A lofted-sections winner can't currently feed Pipeline H's facade-grammar stage** — unlike the ESB's `tiers` winner, which has flat walls a facade reading can sit on. So for a building shaped like Haughwout, `massing-choice` already derives a high-fidelity *shape* for free from the scan, but the existing facade/texture pipeline has nothing to attach to it yet. This is a real, specific gap beyond what the supertall plan's `tiers`-only case covered — worth adding to that plan's scope if `massing-choice` moves toward merging.

## 5. Not done

* No code was changed — this is an experiment against someone else's unmerged branch, not a fix.
* Didn't test `block + roof objects` or `tiers` visually, only compared their numbers.
* Didn't investigate what a lofted-sections candidate *would* need to feed a facade stage (survey station planning, wall-plate projection, etc. all assume flat walls today).

# Process: Facade Grammar — window and bay lattices read from the tile photo, gated on held-out evidence

> **Recorded:** 2026-10-18
> **Status:** Verified (on by default; accepted on the Puck Building's Houston Street face and the Haughwout Building's Broadway face; rejected everywhere the measurement did not support it)
> **Tags:** `operate-scratchbox` `staged-build` `facade-grammar` `tile-refine` `photometric-relief` `google-vector-data` `provenance`
> **Target Domain:** Real-world 3D locations (Google 3D Tiles clay), the remeshed layer's window lattices

---

## 1. Session Context

* **What prompted this session:** build "facade grammar" inference for staged-location builds: floors, bay rhythm and openings read by the vision model from a photo of each facade, fitted as continuous numbers to the scanned facade, gated on the scan and on held-out evidence, and used as the facade's window lattice.
* **Instance used:** web port `3292`, API port `3293`, tools port `3294`, started from the `facade-grammar` worktree with the `scripts/dev/staged-replay.ts` recorder preloaded (live calls recorded); headless builds through `staged-replay.ts --runs 1 [--isolate false]`.
* **Scope tested:** the `grammar` stage end to end (orthophoto export, five readings per facade, fit, gates, the second relief run, the `l2g` layer), its provenance in the result, the overlay and the viewport's provenance view, before and after in clay and textured.

## 2. What Was Tested & What Worked (Verified)

Numbers are the held-out check (`facade_grammar.json` run note): symmetric edge chamfer in ortho px (8 px truncation; lower is better) and structural gradient NCC (higher is better), the relief's own lattice before, the grammar's prediction after, and the same prediction moved half a bay and half a storey ("out of place") as the control. All on the tile photo of each facade, scored only on the parts each reading did not see.

| Build | Facades read | Accepted | Held out on the accepted facades (before → after, control) | Over every facade read (rejected keep the relief) |
|---|---|---|---|---|
| Puck Building (isolated, 2026-10-19 main) | 4 with a grammar of 12 | 1 (facade 3, Houston St, 2588 m², 8 tiers, 122 openings, agreed by vector footprints) | 5.75 → 4.90 px, NCC 0.017 → 0.072 (out of place 5.21 px, 0.038) | 6.07 → 5.69 px, NCC −0.005 → 0.020 |
| Haughwout Building (isolated) | 2 | 1 (facade 0, 5 tiers, storeys 5.06 / 4.63 / 4.33 / 4.33 m, agreed by vector footprints) | 8.00 → 3.48 px, NCC 0.000 → 0.257 (out of place 4.17 px, 0.090) | same |
| Haughwout Building (district) | 12 | 5 (3 agreed by vector footprints) | 6.23 → 4.39 px, NCC 0.047 → 0.148 | 6.48 → 6.04 px, NCC 0.049 → 0.073 |
| Puck Building (district) | 11 | 2 | 7.25 → 5.27 px, NCC −0.003 → 0.136 | 6.61 → 6.42 px, NCC 0.019 → 0.033 |
| Washington Square Arch (replayed recordings) | 2 | 0 (no rhythm to predict; no footprint edge on either face) | — | geometry byte-identical to the build without the stage |

* **The stage in the app** — "Build the Puck Building, 295 Lafayette Street, New York in 3D (clay)" → `Facade grammar degraded · 1 of 12 facades took a photo-inferred grammar; 3 read were not used (...)`; the model's reply names the layer `Remeshed Scan & Facade Grammar (l2g), provenance remeshed, as-scanned, photo-inferred`; the provenance legend reads "photo-inferred: facade grammar (photo-inferred, confidence 0.75): facade 3 (2588 m², read from tiles, agreed by vector footprints): 8 tiers, 122 openings; held out: edge chamfer 5.75 -> 4.90 px, gradient NCC 0.017 -> 0.072". Console: no errors.
* **Clay and textured** — with the stage off (`SCRATCHBOX_FACADE_GRAMMAR=0`) the Houston Street face is a flat remesh; with it, a regular window lattice (`app_puck_clay_before_grammar.jpg`, `app_puck_clay_after_grammar.jpg`); the textured twin of `l2g` is made by the texture pass (`app_puck_textured_*`).
* **Provenance view** — in clay, the grammar's carved openings shade as photo-inferred on the Houston Street face (`app_puck_provenance_clay.jpg`).
* **Timings** (live, first reading): Puck isolated 40 vision calls in 31.9 s, relief with the grammar 2.3 s, build 129 s; Haughwout isolated 10 calls in 11.5 s, 0.7 s, build 59 s; Haughwout district 60 calls ~50 s, 29 s.

Screenshots: `test-results/screenshots/facade_grammar/` (gitignored).

## 3. What Broke / Didn't Work

* **The relief's own cells as a scan check** — the first gate also required half the relief's dark cells to fall in the grammar's openings. On the Puck Building (isolated) the relief found 48 cells, most on piers, spandrels and the fire escape; a grammar reading the facade's windows right explained 17 and was refused. They are photo-contrast guesses, not a measurement: now reported, not gated.
* **Facades whose storeys or bays do not repeat** (ground floors, attics, single-building fragments) are often refused by the held-out check: the hidden parts cannot be predicted from the shown ones. Conservative by design.
* **No Street View source here**: these builds' scan fit is refused by `scan_fit`'s gates, so no Street View close-up is registered; the grammars come from the tile photo, checked against the vector footprints. Agreement with Street View is reported when a registered view exists (not exercised).
* **Shared Browser pane**: another session's app instance took over the pane's active tab mid-session; work moved to a tab of its own.

## 4. Candidate Tool/Service Ideas

* **A "material / provenance mode" control on the canvas toolbar** — the textured toggle and the provenance view live at the bottom of the staged-build panel, below the stage list; driving them needed scrolling the panel each time.
* **A per-layer show/hide in the overlay** — comparing `l2` and `l2g` in the app needed a second build with the stage off; a toggle for the superseded layer alone would replace it.

## 5. Reproduction Steps

1. In the worktree: `SCRATCHBOX_REPLAY_DIR=<rec> SCRATCHBOX_ROOT=$PWD node -r ts-node/register scripts/dev/staged-replay.ts --runs 1 --query "Puck Building, 295 Lafayette Street, New York"` (with the server's ts-node options; `--isolate false` for the district).
2. Read `.scratchbox/cache/staged_location/runs/<runId>/facade_grammar.json` (per facade: readings, the fit, scan and held-out checks, footprints) and the overlays in the grammar stage's cache entry (`overlays/facade_<id>_grammar.png`, `_heldout.png`).
3. In the app: ask for the same build; open the staged-build panel, "Show real textures", "Provenance".

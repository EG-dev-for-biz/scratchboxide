# Pipeline H-S sheet plates, split-wall openings, and the Haughwout district massing (2026-10-24 to 2026-10-26)

Branch `pipeline-h-sheet`, commits 70aae905 to 114f0ae3. All runs were headless (`scripts/dev/staged-replay.ts`) from the branch, each from a fresh `SCRATCHBOX_ROOT`. Every number below comes from a run whose exit code and logs were checked. Images were sent into the chat as they were produced. The scratch copies are not kept in the repo.

## 1. Sheet plates in pipeline H (opt-in)

With `SCRATCHBOX_H_SHEET_PLATES=1`, pipeline H draws a building-survey character sheet from the isolated textured scan and lays its passing panels onto the wall plates. The relief stays the scan's. Every texel taken from the sheet is labelled generated. The code is in `pipeline-g/sheet-plates.ts`, `building-character-sheet.ts` and `pipeline-g.ts`.

- **Station framing (B4 method):** four views — the largest wall straight on, its perpendicular neighbour straight on, their corner, and an aerial at 35°. Each view frames the structure's full bounds with a margin of 1.25.
- **Best-of-N:** candidate sheets are ranked by the facade reading, scored as explained × edge precision on the 2 largest walls. A sheet with at most one failing panel can still be used: only its passing panels are laid.

Headless Haughwout builds:

| Build | Explained % (long wall / Broadway) | Edge precision | Elements |
|---|---|---|---|
| Option off | 10 / 21 | 0.50 / 0.64 | 125 of 148 |
| Option on, image quota error (survey plates kept) | 7 / 16 | 0.48 / 0.61 | 110 of 138 |
| Option on, sheet used (9 generated, all checks passed, colour shift 2.2–6.4) | 7 / 18 | **0.80 / 0.83** | **131 of 165** |

Findings:
- The sheet consistently raises edge precision and the element count.
- Explained % is within the reader's own noise: the same plates read 10/21 one time and 7/16 another.
- Ranking candidate sheets by the reading gave no quality gain (0.173 vs 0.171 on a fresh, independent re-read). It does make the step finish reliably once near-miss sheets are allowed.
- Running three builds in parallel hit the image quota (429). The step degraded honestly, but builds should run one at a time.

## 2. Openings across a split wall (af61b79e)

When a wall is split into pieces, an opening straddling a cut lay outside every piece's ends and was rejected. The native builder (`scratchbox_staged_massing.hpp`) now puts a copy on each piece the opening overlaps by at least 0.3 m. Openings that fit inside one piece are unchanged.

- **Haughwout H with sheet plates:** rejected openings went from 6 of 113 to 0. The build took 433 s.
- **Test:** `pipeline-g-opening-detail.test.ts` fails without the fix and passes with it.

## 3. clipOpenings face sweeps (ef026e54, then corrected)

Under `clipOpenings`, which only district massing uses, the builder clamped profile heights that are relative to each placement against the wall's absolute raised bottom. It then dropped any profile under 0.3 m, which rejected every ordinary 12 cm sill.

The clamp now works per placement on absolute height. A placement the clamp cuts into is dropped when less than 0.3 m, or less than half its height, is left. A placement the clamp doesn't reach is kept at any height.

The first version used a 2 cm floor. On the district it "recovered" 8 sweeps, but all of them were 4 cm slivers of bands that a neighbouring part hides (`pf193_8`: 0.04 m of 2 m left). That version was corrected.

On Haughwout's district spec (1,206 sweeps), both the old and the corrected builder reject 107. The plane-first sweeps there are all at least 0.3 m tall, so the bug never showed on this district. The new tests cover the short-sill case.

## 4. Getting the Haughwout district massing to run

Each blocker hid the next. The command was `run_district.sh`: `SCRATCHBOX_STAGED_PLANE_FIRST=1`, `--isolate false`.

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | `tile_refine failed (Invalid array length)`; massing skipped | `applyFacadeLattices` copied the GLB's binary chunk into a plain JS array one byte at a time; the district's chunk is bigger than V8's limit of about 134 M elements | Build the GLB from byte chunks; `glbSoup` sized up front (f82474a5 series). Test with a 140 MB GLB |
| 2 | Massing stopped at its 1,500 s limit, with a 20 min block on the main thread | `fillFromOtherFacades` recomputed every other wall's row bands for each wall it filled: quadratic, 620 s | Compute each wall's bands once (`occluders.ts`) |
| 3 | Still over 1,500 s | The stage is long on a district | User decision: 5× massing budget (7,500 s); district run budget 140 min, chat tool limit 142 min; isolated builds unchanged (0bf3294d) |
| 4 | `ENOSPC` during massing | Disk 99 % full; one district massing writes about 17 GB of temp files (12,637 walls × 4 rasters, `detail/` 15 GB) | Freed space by deleting stale temp folders. **Open** |
| 5 | Massing ran out its 7,500 s; main thread idle for 92 min | The revolution fit asked the vision model about each of 184 candidates one after another (plan view, then reference) | Calls go out 8 at a time, one per axis position (`revolution-fit.ts`, 114f0ae3). Test checks they overlap |

Result after all five:
- Massing committed in 3,039 s (51 min): l2m 415,550 tris, l2c 407,243 tris, l2v 1,449,104 tris.
- 423 buildings rebuilt.
- 26 of 184 revolution candidates kept.
- The facade detail step (texture inference) took 1,773 s of the stage.

## Still open

- **Later-layer textures:** texturing the later layers times out at its 1,200 s limit on the district.
- **Disk use:** about 17 GB of temp files per district massing. With little free disk the build fails.
- **Slow steps inside massing:** texture repeat-fill (about 250 s), PNG encoding (about 170 s) and the facade detail step.
- **Pipeline H-S follow-ups:** read each plate twice to cut reader noise; E4 attachments.
- **Pre-existing test failure:** `staged-location-tool.test.ts` fails a Street View Static API check in `street-identify.ts`. It is unrelated to this work.

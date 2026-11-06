# Building benchmark: every kind of building, uncached, on one sheet

**Date:** 2026-11-04
**Status:** Verified: the baseline was run on main on 2026-11-04 (see "Baseline" below).

## Why

Pipeline K changes have been proven on Penn 2 and the ESB only, so a fix that helps one kind of building can quietly
break another. The benchmark builds one real building of each kind, uncached, the same way every time, and puts them
on one labelled sheet you can judge by eye. With two checkouts it builds both side by side.

## The set

The place list is test data: [`packages/core/test/fixtures/benchmark-buildings.json`](../../packages/core/test/fixtures/benchmark-buildings.json).
No product code reads it. The kind is only a label on the sheet.

| Slug | Building | Kind |
|---|---|---|
| `penn2` | Penn 2, 2 Pennsylvania Plaza | standing benchmark: tower over the rail yard |
| `esb` | Empire State Building, 350 Fifth Ave | standing benchmark: stepped stone tower |
| `lever-house` | Lever House, 390 Park Ave | tower on a podium |
| `30-rock` | 30 Rockefeller Plaza | stepped setbacks |
| `apthorp` | The Apthorp, 2211 Broadway | courtyard block |
| `flatiron` | Flatiron Building, 175 Fifth Ave | angled facade |
| `faneuil-hall` | Faneuil Hall, Boston | brick low-rise |
| `nypl` | NYPL Schwarzman Building, 476 Fifth Ave | ornate stone |
| `seagram` | Seagram Building, 375 Park Ave | glass box |
| `helmsley` | Helmsley Building, 230 Park Ave | over a road and rail cut |
| `steinway` | Steinway Tower, 111 W 57th St | narrow infill |

The user approved this set on 2026-11-04. Faneuil Hall is pinned by coordinates, because its name resolves to the marketplace.

## Run it

You need Node 22.18 (`nvm use 22.18`), Pillow for `python3`, and the app's credentials as for any live build. Each side
is a checkout with its own `node_modules`. To compare a branch, add a worktree for it and run `npm install` there.

```bash
npx vite-node scripts/benchmark_buildings.ts run --side main=/path/to/main-checkout --side feat=/path/to/feat-checkout --out .scratchbox/benchmarks/feat-vs-main
```

**Other commands:**
- `plan` lists the set.
- `sheet --out <dir>` rebuilds the sheet from whatever results exist.
- `views --out <dir>` renders any missing views again, while the models still exist.
- `measure --glb <file>` prints one model's generated share.

**Run flags:**
- `--places a,b`: a subset of the set.
- `--retry-failed`: builds failed places again.
- `--keep-caches`: keeps each build's stage cache under the output folder (several GB each) instead of deleting it.
- `--max-load N`: the load ceiling; the default is 100.

**Resumable:** a place with a `result.json` is skipped, so stop the run at any time and start it again with the same
command.

## What one build does

1. **Waits for the load.** It waits while the 1-minute load average is above `--max-load`.
2. **Empties the stage cache.** It sets the checkout's stage cache (`.scratchbox/cache`) aside under
   `.scratchbox/cache_aside/before-benchmark-*`, and never deletes that. It then makes an empty cache carrying a
   `.benchmark-owned` mark. Only a marked cache is ever deleted.
   - The tile leaf cache, the Street View cache and the native build cache are downloaded data and compiled binaries,
     not stage results, so they stay.
3. **Starts a fresh server.** It starts that checkout's own API server (`npm run server:dev`) on free ports with a
   fresh token, with `SCRATCHBOX_STAGED_BUILDING_PIPELINE=k` and `SCRATCHBOX_CACHE_RESTORE=off`. It stops the server
   after the build, so nothing in memory carries over to the next build.
4. **Builds.** It runs `google_3d_tiles_get_clay { query, isolate: true, pipeline: 'k' }` through
   `/gemini/tools/run-stream`, the route the build graph uses.
5. **Reads the run's records.**
   - **Holes and untextured:** `holeShare` and `clayShare` from the outside check of the finished twin
     (`pipeline_k_visible_defects_textured.json`, from `pipeline-k/visible-defects.ts`), over all its views.
   - **Build time:** the timeline's `finish`.
   - **The model:** the stage statuses and the finished model (`pipeline_k_model.json`).
6. **Measures the generated share** from the model's own provenance extras, by surface area:
   - the base skirt and the seal (labelled `generated`) count whole;
   - a rebuilt facade counts its texels filled from repeats or the nearest real texel, plus its windows drawn as their
     repeats' median;
   - the texture library's roughness and normal maps are not counted. They lie on every surface, and the share is about
     the colour you see.
7. **Renders four views** with the native path tracer: headings 45, 135, 225 and 315, pitch 15, baked texture,
   framed on the model.
8. **Records the result.**
   - It writes `<out>/<side>/<slug>/result.json`, with copies of the run's records under `run/`.
   - It appends one row to the checkout's ledger directory (`.scratchbox/ledger/benchmarks.jsonl`, or
     `SCRATCHBOX_LEDGER_DIR`). The row has schema `scratchbox.run-ledger.benchmark/1` and joins the run ledger's
     `builds.jsonl` on `runId` where that ledger exists.
9. **Composes the sheet** again (`sheet.jpg`, `sheet.md`), then deletes the stage cache this build made.

**Order:** places go one by one, each side in turn, so both sides of a comparison are built minutes apart under the
same load. The sheet shows each number's change against the first side, red where it got worse.

## Cost

Each build makes roughly 150–350 flash-tier vision calls: the survey, the ownership vote, the facade reader and the
material finish and pick. That is about $0.5–1.5 a building, and $5–15 for the set of 11. It takes about 5–25 minutes
a building, so 2.5–4 hours a side.

## Baseline: main, 2026-11-04

The run used main's app code: the last commit that changed it is `3c5c5f0b`, inside main `7e96dc8f`. This branch's own
commits change only this script, its docs and its test data.

**Status:** Verified. Every number below is from a live, uncached build, read back from that run's own records.

**The sheet:** [building_benchmark/baseline-2026-11-04-main.jpg](building_benchmark/baseline-2026-11-04-main.jpg), with
the same numbers as a table in [baseline-2026-11-04-main.md](building_benchmark/baseline-2026-11-04-main.md).

| Building | Outcome | Holes | Untextured | Generated | Build |
|---|---|---|---|---|---|
| Penn 2 | degraded | 1.71% | 0.76% | 28.9% | 20.7 min |
| Empire State Building | complete | 0.67% | 0.37% | 26.3% | 17.9 min |
| Lever House | degraded | **18.8%** | 2.34% | 13.9% | 12.7 min |
| 30 Rockefeller Plaza | degraded | **13.4%** | 2.16% | 29.6% | 38.4 min |
| The Apthorp | degraded | 1.74% | 2.17% | 13.1% | 12.1 min |
| Flatiron Building | **no K model** | (scan 11.2%) | (scan 2.76%) | — | 2.8 min |
| Faneuil Hall | degraded | 0.81% | 0.57% | 9.9% | 4.9 min |
| NYPL Schwarzman Building | degraded | **11.0%** | **6.66%** | 5.6% | 6.1 min |
| Seagram Building | degraded | 6.63% | 0.93% | 25.6% | 4.1 min |
| Helmsley Building | **no K model** | (scan 17.7%) | (scan 4.65%) | — | 14.0 min |
| Steinway Tower | degraded | 3.11% | 1.32% | 21.4% | 18.5 min |

Only the ESB passes the outside check's 1% limits. The ESB and Penn 2 are the two buildings pipeline K has been tuned
on, and every other kind does worse.

### What is wrong, building by building

- **Penn 2:** two faces got no survey.
  - The 29° face has no panorama looking at it.
  - The 119° face's reading timed out at 240 s.
  - The worst view shows 4.5% holes. The largest hole is 369 m², and the low block on the 225°/315° side is ragged.
- **ESB:** within every limit: 0.67% holes, 0.37% untextured, and the largest hole 27 m². Its 0.88% worst view is under
  the 3% per-view limit.
- **Lever House:** a whole rebuilt facade (`FacadeLattice_4`) faces inward.
  - That is a 92 m × 24 m hole, half of the 225° view, where the viewer shows the slab's inside.
  - Thin vertical needles stand off the podium.
  - Loose pieces hang below the podium.
- **30 Rockefeller Plaza:** the same failure on a bigger scale.
  - `FacadeLattice_25` is a 258 m × 21 m wall facing inward, 39% of the 90° view.
  - The untextured share reaches 7.3% in one view, mostly one scan piece (`relief_m88`).
  - The 38 min includes the first download of three 8K library textures.
- **The Apthorp:**
  - **Geocode:** it resolved "Apthorp Sales Office", but the whole block was built.
  - **Colour:** the faces disagree. 45° and 135° are cold blue-grey, 225° and 315° warm buff, so the harmonising
    leaves sides apart.
  - **Untextured:** most of it is the base skirt (72%).
  - **Courtyard:** these views cannot show it. A 15° pitch never sees inside a deep courtyard.
- **Flatiron Building:** pipeline K never ran.
  - `tile_refine` isolated a 375 m² structure, while the footprint picked was 116 m², far smaller than the building.
    Only 54% of the isolate lay on the pick, and the ownership vote's isolate disagreed too (37%).
  - So the build showed the remeshed district whole, with no textures.
- **Faneuil Hall:** the cleanest of the set: 0.81% holes, the largest 4.5 m². The untextured 0.57% is mostly the base
  skirt.
  - Asked by name, the place resolves to "Faneuil Hall Marketplace" and builds Quincy Market instead, so the list pins
    it by coordinates.
  - That first, wrong build is kept apart as a data point and is not on the sheet: 35% untextured and 13% holes on a
    long glass-roofed market hall.
- **NYPL:**
  - **Inward wall:** the merged wall sheet `FacadeLattice_10000` faces inward over 63 m × 18 m, 48% of the 135° view.
  - **Base:** the ground storey and the Fifth Avenue portico are torn away along two sides, so the building stands on
    stilts in the 225° view. It looks like the base cleanup or the footprint clip took the terraces and portico.
  - **Untextured:** 6.7%, worst 10%.
- **Seagram Building:** the tower reads right, but its bronze comes out flat grey.
  - `FacadeLattice_8` faces inward over 107 m × 15 m.
  - A thin vertical blade stands off the rear annex.
  - The annex's walls split apart in the 315° view.
- **Helmsley Building:** pipeline K never ran, for the same reason as the Flatiron.
  - The isolate was 3,120 m² against a 1,285 m² pick, 55% on it. The Park Avenue viaduct through it probably joins it
    to its neighbours.
  - The build fell back to the district scan.
- **Steinway Tower:** reads right from the landmark base to the crown. The largest hole is 443 m², a merged wall sheet
  (`FacadeLattice_10009`) showing its back.

### What repeats, and is worth a general fix

1. **Rebuilt facades facing inward** (Lever House, 30 Rock, NYPL, Seagram, and smaller on Penn 2 and Steinway).
   - Every large hole region is the back of one `FacadeLattice_*` sheet, often a merged wall (`_1000x`).
   - The path tracer draws both sides, so the sheet's views look whole while the app's viewer shows the inside.
   - The hole share is the number to trust here.
2. **The isolate and the footprint pick disagree** (Flatiron, Helmsley): 2 of 11 never reach pipeline K. The build
   falls back to the whole district instead of rebuilding the part it picked.
3. **Stray sheets and needles** standing off low parts (Lever House podium, Seagram annex).
4. **Ground storeys and bases torn or ragged** (NYPL portico, Penn 2's low block, Lever House underside). The base skirt
   is also the largest untextured source on most buildings.
5. **Survey calls that fail:** 11–35 failed model calls a build, Street View images timing out at 30 s, and vision
   readings at 240 s.

### Cost and time

- **Model calls** (each run's own `model_calls.json`): $2.33 of `gemini-3.8-flash`, priced by the app, for all 12 builds
  including the wrong Faneuil Hall.
- **Unpriced calls:** the `gemini-4-argon` survey and ownership calls the app does not price came to 429k input and 192k
  output tokens. At pro-tier rates that is roughly $2–4 more.
- **Other costs:** Google tiles and Street View requests, small at this scale.
- **Total:** about $5–7.
- **Time:** about 3 hours of builds.

## Candidate Tool/Service Ideas

- **Generated share in the build.** The twin does not report its own generated share; the benchmark reads it back from
  node extras. The texture pass could write it into a run note, as the visible-defects check does.
- **Cost per run.** No run records its model calls or spend. One `model_calls.json` per run would let the sheet show
  each build's cost.

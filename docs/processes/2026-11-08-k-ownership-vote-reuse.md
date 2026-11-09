# Pipeline K ownership vote: judge on the isolate, refine once, reuse unchanged facades

**Date:** 2026-11-08/09 · **Branch:** `perf/ownership-vote-reuse` · **Benchmark:** `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-08-ownership-reuse` (sheet `ownership_reuse_sheet.jpg`, numbers `sheet_rows.json`)

## What changed

The ownership vote reran the whole first-pass chain on the voted remesh. It ran tile_refine twice: once without orthos, only to judge whether the vote was material, and again with orthos. Then it straightened, read, fitted and arrayed every facade again, including those the vote never touched.

1. **Judge on the isolate.** tile_refine has a new `--isolate-only` mode (`TileRefineService.isolate`). It stops after the isolate's raw clay, which is byte-identical to a full refine's (`tile-refine-service.test.ts`, real ESB tile). `ownershipChange` reads it.
   - Not material: no refine at all.
   - Material: one tile_refine with orthos.
   - The tear guard (`ownership_vote_torn`) is unchanged.
2. **Reuse unchanged facades** (`pipeline-k/facade-reuse.ts`). A facade keeps the first pass's straightened photo, masks, report, window-fit entry and reader record only when every one of these holds:
   - its plane matches (normal within 0.5°, offset ≤ 5 cm, rectangle edges ≤ 0.3 m);
   - no scan the vote moved lies within 1 m of it;
   - its ortho matches on one grid after the frame offset: coverage XOR ≤ 2% of the union and colour mean ≤ 8 levels. On 30 Rock, unchanged facades fall at XOR ≤ 1.4% and changed ones at ≥ 2.5%.

   Changed facades take fresh ids, so the first pass's brief and families never name them. The whole-building steps (building system, tier grammar, building storey) rerun over the merged set. Reused facades lend their photo, read only, to the others' featureless continuation. `SCRATCHBOX_K_FACADE_REUSE=0` turns reuse off.

## Results (uncached, one shared answer store)

| Building | Vote | Final model, main vs branch | Ownership stage (clean pair) |
| :--- | :--- | :--- | :--- |
| ESB | not material | byte-identical geometry and textures (also both branch reruns) | 36.3 s → 16.7 s; judge 20.1 s → 1.4 s (both runs alone, load ≤ 67) |
| Penn 2 | not material | byte-identical geometry and textures (also the branch rerun) | judge 18.8 s → 4.4–7.5 s (loaded runs, context only) |
| 30 Rock | material, 21 of 68 facades kept | **different**, see below | not comparable, see below |

**30 Rockefeller Plaza.**
- **Main.** The voted pass hits the tear audit's last resort in `facade-lattice.ts`: a tear stays after four rounds, so all 59 facades are dropped. Main then shows the voted scan with no lattice: holes 0.44%, untextured 2.81%, shards, flat walls and voxel infill. Every earlier 30 Rock bench since 2026-11-08 shows the same (`rebuilt 0, dropped 59`).
- **Branch.** The voted pass is built from the same raw clay, with the kept facades taken from the first pass. It rebuilds all 59 facades, at holes 0.95%. That is more than the first isolate's 0.62%, so the unchanged tear guard keeps the first isolate. The shown model is byte-identical to main's own first isolate: holes 0.62%, untextured 0.75%.
- The ownership totals are not comparable: main's no-lattice polish takes 36 s, the branch's full polish 311 s.
- **Like for like:**
  - **Judge step:** a 17–88 s refine becomes a 1.2–3.8 s isolate.
  - **Straightening the voted set:** 86.8 s on main, 61.2 s on the branch, same orthos at similar load.
  - **Reader:** 98 answers on main, 80 on the branch, with no answer needed for the 21 kept planes.
  - **Kept facades:** orthos, masks and reports byte-identical to the first pass. Lattice textures are identical on all 19 rebuilt in both passes. Lattice geometry differs by 0.02 mm to 2.8 cm because it is rebuilt on the voted scan's depths.

**Determinism.** On all three buildings the branch rerun gives the same geometry and textures, including 30 Rock's voted polish (`4cc277f992`).

**Load.** Main's ESB retry, the branch's ESB rerun and the branch's 30 Rock ran wholly below load 100. Every other build ran partly above it, and its timings are context only. The red rows on the sheet mark them.

## Open

- Main's all-facades-dropped vote on 30 Rock is a pre-existing defect in main's second pass, and this branch does not fix it. On the branch the same vote is rejected as torn, so neither side shows a lattice built on the voted scan.
- On a material vote the branch's first run makes fresh reader calls for changed facades, because they carry new ids. The rerun made none.

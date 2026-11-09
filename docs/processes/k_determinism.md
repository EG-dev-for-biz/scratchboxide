# Pipeline K builds the same model twice (2026-11-06)

**Question.** The tile-seams work (2026-11-05, `tile_seam_weld.md` §10 on `claude/tile-seam-smoothing`) found that pipeline K's
output differed between builds of identical code: the ESB's east face rebuilt differently every time, facade sheet ids
moving, Penn 2 landing on different isolates. No single before/after pair could then tell a fix from K's own variation.

**Answer.** K's code is repeatable. Every difference came from a model answer, and one kind of answer moved geometry.

## 1. How it was found

- Builds headless through `scripts/dev/staged-replay.ts`, one workspace on `/Volumes/3DTESTING/scratchbox-ide/k-det`, every stage
  cache cleared before each build except the tile extraction and the geocode (the same fresh extraction for all builds).
- The replay harness had stopped working when the build moved to its own worker thread: its patches to the vision client
  and Street View service live in the main thread, so `record` recorded nothing and `strict` called live. Fixed: a replayed
  headless build runs in-process (`SCRATCHBOX_STAGED_WORKER=0`).
- **Replayed answers, same code (ESB A, recorded; ESB B, strict replay):** every polish step GLB byte-identical, and the final
  twin's binary chunk byte-identical; the only JSON difference was a millisecond count inside a provenance sentence.
  tile_refine, the rectify, the window fit, the wall grammar, the wall sheets, the lattice, the closure, the de-light, the
  roof-shadow lift, harmonising and the material regions are deterministic, native kernels and thread pools included.
- **Live answers, same code (ESB live1 vs A):** the first stage whose output differed was K's rectify
  (`relief_orthos_k_*`): facades 8 and 73's straightened photos, through `holes.fromInpaint` / `fromSmooth`. Geometrically
  one node differed: `FacadeLattice_73` (2,588 vs 2,664 triangles, the east-facing setback face 40–57 m up), and the seal and
  inner core behind it.

## 2. Causes

1. **The hole inpaint moved the lattice (geometry).** The rectify sends a facade photo's small holes that no real source
   covers to the image model, then closes the rest with a smooth fill from the hole's edge. `photoLattice`
   (`facade-lattice.ts`) finds the facade's row and column lines from the photo's gradients over every texel, so the model's
   picture, different every build, drew different lines, hence different cells and recesses. All the differing texels lay
   inside the uncovered mask, which the per-cell reads already skip; only the line search read them.
2. **The ownership vote's outlines and its 30 s cut (isolate).** Every earlier ESB and Penn 2 build went ahead at 30 s with a
   different set of views answered (9–11 of 12). The outlines were never kept between builds. On the ESB the vote moved
   0.3–0.5% of the surface, under the share that replaces the isolate; on Penn 2 a vote that crosses it replaces the isolate,
   which is the flip the tile-seams session saw. In this session's Penn 2 builds the vote was once rejected and once too
   small, so both kept the geometric isolate.
3. **Texture-only answers.** The facade reader's readings, the material finish and choice and the class names, and the
   inpaint's colours change materials and glass between uncached builds. They move no geometry.
4. **The polish's cache key** hashed whole JSON inputs that record their own `ms` timings, so two builds of the same scan
   never shared a polish (no effect on the output, only on caching).

## 3. Fixes (branch `claude/k-determinism-aaa73f`)

- **Lattice lines past the model's holes.** The rectify writes `facade_<n>_inpainted.png` (named `inpaintedMask` in
  facades.json): every hole sent to the image model, decided before it is asked. `photoLattice` reads those texels as the
  uncovered grey (128) they were before any fill, in TypeScript and the native port (`SBLF/2`). The facade's own fills (its
  repeats, a facade facing the same way) are the same every build and still draw the rhythm they continue. A first version
  that greyed every uncovered texel was repeatable but flattened facades (ESB 861k to 844k triangles): rejected.
  `facade-lattice/21`, `pipeline-k/4`.
- **Kept answers.** The ownership outlines (`ownership-outline/…`, by the view's pixels, target and prompt) and the hole
  inpaint (`k-hole-inpaint/…`, by the facade's pixels and holes) join the model readings store. A view answered before is
  never cut by the vote. `SCRATCHBOX_MODEL_READINGS_DIR` points the store at a shared folder, so before/after checkouts and
  benchmark builds take the same answer to the same question.
- **Polish key by content** (`contentHash`, timings dropped).
- Test: `packages/core/test/pipeline-k-determinism.test.ts`.

## 4. Proof (code 6169b1ff, live model answers)

| Pair | Kept answers | Geometry buffers | Whole GLB |
| :--- | :--- | :--- | :--- |
| ESB v3-a / v3-b | a kept, b none | 2,731 of 2,731 identical | images differ (448 of 816) |
| ESB v3-b / v3-e | none / none | 2,731 of 2,731 identical | images differ (545 of 816) |
| ESB v3-a / v3-c | shared store | 2,731 of 2,731 identical | images differ (119): answers a's build did not keep |
| Penn 2 v3-a / v3-b | a kept, b none | 1,596 of 1,596 identical | images differ (301 of 520) |
| Penn 2 v3-a / v3-c | shared store | identical | **byte-identical** |

- ESB 861,478 triangles, holes 0.73% (main 861,474, 0.73%); Penn 2 966,865 triangles, holes 1.08%.
- With the earlier version of the fix, ESB c and d on one store were byte-identical: once every answer is kept the textures
  settle. A first build can leave answers unkept (views cut by the vote, replies that could not be used), so the second
  build on a store may still differ in textures from the first.
- Sheet: `docs/screenshots/2026-11-06-k-determinism-before-after.jpg` (gitignored; also in the session notes folder).

## 5. What is left

- Uncached builds (stage caches and kept answers cleared) still differ in textures, because the models answer differently.
  For a before/after comparison of texture work, run both sides on one `SCRATCHBOX_MODEL_READINGS_DIR`.
- A wall sheet (`wall-sheets.ts`) builds its photo from its members' rectified photos; the inpainted mask is not carried
  into the sheet. In these builds no sheet's geometry differed.
- The ownership vote, asked afresh, can still land differently (outlines and the 30 s cut); the store makes a kept vote repeat.

## 5. Addendum (2026-11-08, `feat/k-deterministic-stats`): three ESB builds, three class sets, and what varied

Three builds of the ESB on current main (17f1d2f1) from one cached remesh and one shared answer store gave three different
appearance-class sets and set picks (Gravel030 at metalness 0.18; concrete_floor_worn_001 at 0.32; Concrete015/029), which
also made any single-build material comparison meaningless. What varied, in the order it was found:

- **Every run that differed had re-asked the facade reader about the same 77 planes** (38 lattice facades, 39 scan-photographed
  planes) and the building brief, about 110 to 120 store misses; every run that reproduced its predecessor had none. The twin's
  harmonised images, the window fit and the wall grammar were then re-derived from the new readings, and the classes with them.
- **The twin chain itself is repeatable.** `tileRefineTwin` run twice on one input, in one process and in two processes, with
  the de-light, the roof-shadow lift (with the tiles' geometry as context) and harmonising, gave byte-identical GLBs (272 images).
- **The misses came from unsettled caches and from checkouts, not from the clustering.** The first build after a pipeline change
  rebuilt tile_refine's straightened photos (the reader keys a facade by them), and a worktree's own measured library statistics
  (`build/texture-library/stats`, 2,451 files in the main checkout, none in the worktrees) override the committed bundle and
  change the shortlists. Once a checkout's caches settled, consecutive builds reproduced the classes, the picks and the answer
  store hits exactly, across code versions that leave the pre-reader pipeline alone (runs 10925ecc, 37ccfb4d, 9265a7fc), and the
  texturing session's two repeats of the ESB and Penn 2 matched texel for texel.
- **Fixes.** A build reads the committed `stats.json` alone and measures no set into its checkout; `SCRATCHBOX_LIBRARY_LOCAL_STATS=1`
  (set by `npm run library:stats`) turns the local files back on for the maintainer who writes the bundle. The twin's stage key
  hashed `window_fit.json` and `wall_grammar.json` by their bytes, which carry timings, so every build of the same scan re-ran the
  twin (a cache miss, not a change); it hashes them without timings now, as the polish key has since §3.
- **Proof.** Three uncached ESB builds on commit 6482e5b8 (runs 0eab8f0e, 15d74cf2, fd15619b; one cached remesh, one shared answer store, 247 readings kept and 0 missed in each) wrote `model.glb` with one SHA-256, `bab9d30e…`, the same six appearance classes (shares 0.188, 0.306, 0.215, 0.144, 0.079, 0.067) and the same sets (Concrete027, PavingStones105, Plaster004, PaintedPlaster015, Foam001 x2). An earlier proof on 1607ea7d alone had identical binary chunks and three hashes: the JSON differed only in the material-regions provenance sentence's "(N ms)" and `sbHeightRelief.ms`, both removed in 6482e5b8. Records: `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-07-height/determinism/proof_final.txt` and `final_model{1,2,3}.glb`.

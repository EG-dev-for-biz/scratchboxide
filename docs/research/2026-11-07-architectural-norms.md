# Architectural norms for the Google-Maps-to-3D pipelines (2026-11-07)

**Question:** which published methods for "architectural norms" (regular layouts, plausible heights, storey lines,
learned grammars) would improve pipeline K's facades or the district's plausible fills, by how much, at what cost, and
against which AGENTS.md rules.

**Answer in one line:** a height norm for unmeasured footprints had the best payoff for its cost, so it is the one
prototyped (`height-norm.ts`, beside the first paint). Its test turned up a larger, simpler win: most of Penn's
height-less footprints are duplicates of a Google modelled volume. Where a real height is missing, the norm only helps
buildings that actually stand above the street. The facade papers mostly confirm what K already does, and each would cost
a training run or a solver for a modest gain.

All five papers were read on 2026-11-07, except Martinović & Van Gool (CVF returned 403). That section comes from prior
knowledge of the paper and is marked as such. No paper's code was read or copied. Paper 1 and FloorLevel-Net released no
code, StructuredMesh's code is not stated, and Milojevic-Dupont's scripts are supplementary material. The prototype is
our own method.

## Ranking

| # | Paper | Would improve | Expected measured gain | Cost | Verdict |
|---|---|---|---|---|---|
| 3 | Ma et al. 2025 / Milojevic-Dupont et al. 2020: heights from footprints and urban form | First paint and the outer layer past the tile cap: unmeasured heights (today a flat 12 m) | Measured below: leave-one-out error 33–70% lower than 12 m in 7 cities; −20% on real unmeasured buildings that stand ≥ 6 m; no gain on ground-level "buildings" | ~300 lines of TypeScript, no model, no spend; ~3 s per district | **Prototyped**, opt-in (`SCRATCHBOX_HEIGHT_NORM=1`); the duplicate fix it found is on |
| 2 | StructuredMesh: facade components regularised by binary integer programming | Lattice completion and window array: one layout per facade that minimises distinct sizes and positions | Paper: +6.5% precision, +4.5% recall, +5.5% F over 7 buildings. K's window array (#165) already does the consensus step, so the likely gain on K is 1–3 F points on irregular facades | An ILP solver (Gurobi is commercial; an open solver or our own branch-and-bound); NP-hard, so it needs pruning | Later: worth it only if #165's consensus leaves measured misalignments |
| 1 | Visual-to-Executable Procedural Reconstruction (arXiv 2611.03143): layout tree → tile codes → deterministic program | Facade reader: a split/repeat tree in place of zone-by-zone boxes; a compiled program in place of tiled cells | Paper: TRC 1.47 vs 1.83 expert edits for direct LLM code; execution 0.98 vs 0.94; tile attributes 0.89–0.98 | A LoRA-tuned 7B VLM (training data, GPU) or prompting our reader to emit the tree; the compiler is cheap | Borrow the *reflection loop* (render the reading, show it back, repair) into the reader; skip the fine-tune |
| 4 | FloorLevel-Net (arXiv 2107.02462): floor lines from street photos | Storey pitch on facades the tile photos barely see (low, occluded) | Paper: line accuracy 0.894 overall, 0.798 on GSV; no metric-pitch error reported | A segmentation net trained on street images; we no longer read Street View in K (the evidence stage is off) | No: K reads pitch from the straightened ortho by Viterbi on its own lines; the paper's gain is in perspective street photos we do not use |
| 5 | Martinović & Van Gool 2013: Bayesian grammar learning (from prior knowledge; not re-read) | Wall grammar: grammar rules learned from labelled facades, not fitted per building | Unknown for us: their results are on labelled datasets (ECP, eTRIMS) | Labelled facades (we have none in house), MCMC over grammar space | No for now: §1 forbids a learned closed vocabulary of element classes, and our grammar is continuous measurements per tier |

## 1. Visual-to-Executable Procedural Reconstruction of Buildings (Zhu, Liu, Sharf, Cheng; arXiv 2611.03143, 2 Nov 2026)

**What it does:** a dominant facade is cropped and segmented. A LoRA-tuned Qwen-VL-7B writes a split/repeat YAML layout
tree. The tree is rendered, shown back to the model, and repaired, for two rounds. Each tile crop then gets attribute
codes from a CLIP+DINO encoder, and a deterministic compiler turns tree plus codes into CGA rules on a box mass.

**Against K:**
- K's facade reader already does the scaffold first (overview zones), then components (each zone's openings), then a
  deterministic placement (the zone tiled at the measured storey pitch, `facade-reader-template.ts` for a family).
- The window array (#165) is the consensus grid the paper's tree encodes.
- The lattice (`facade-lattice.ts`) is the deterministic program.
- What K lacks is the paper's reflection step. K's judge accepts or rejects an outline, but nothing renders the reader's
  whole reading back to it and asks for repairs. Their Table 5 shows reflection doing most of the work: expert edits fell
  from 4.32 to 1.47.

**Measured gain to expect:**
- Their tile-attribute accuracy (arch 0.98, sill 0.92, rows/cols 0.89) is on CMP/eTRIMS crops of planar facades, not
  straightened tile photos.
- For K the realistic target is fewer rejected or repaired zones per facade. K logs no such count today, so it would have
  to be added before any claim.

**Cost:** about 2–4 extra reader calls per plane (render, show, repair) at flash pricing. The fine-tune is out of
reach: it needs training data, a GPU job and a model service.

**AGENTS.md conflicts:**
- The paper's schema has named element types (window, entrance, arch, sill), which ADA §1 forbids as geometry switches.
  A reflection loop over our open-vocabulary reading has no such conflict.
- The facade reader belongs to the materials session (local_b9f26171), and its glass PR is open. Any change goes through
  that session.

## 2. StructuredMesh (Wang, Hu, Shang, Xu, Zhu; arXiv 2306.04184)

**What it does:**
- Renders an orthographic colour and depth view of a photogrammetric mesh and detects components with Faster R-CNN
  (F 0.71).
- Back-projects each detection by depth, then picks every component's attributes (position, depth, width, height,
  orientation) from clustered candidate values with a binary integer program.
- Objective: residual + ω · (number of distinct values used), with one-hot constraints, no two components at one site,
  shared θ per floor and shared λ per column.

**Against K:**
- `completeLattice` (window-fit.ts) and the window array (#165) fit pitch and phase by consensus histograms, then snap
  each box to its site.
- `wall-grammar.ts` fits one grammar per tier from all its walls.
- What StructuredMesh adds is a *global* trade-off: one solve that weighs moving a box against adding a distinct size.
  K decides those greedily (snap, then drop a duplicate). The paper's "enum" term is exactly the regularity a reader
  sees in a good facade.

**Measured gain to expect:** +5.5 F on average, but F fell on two of seven buildings. K's consensus already removes most
distinct values, so measure first: count distinct widths, heights and column x-positions per facade before and after
#165 on the ESB and Penn 2. Prototype only if many remain.

**Cost:** an ILP per facade, with tens to hundreds of components × a few candidates each. An open solver (HiGHS has a
permissive MIT licence, used as a library) or a small branch-and-bound of our own in C++. Native port and parity test as
for the other K kernels.

**AGENTS.md conflicts:**
- The detector's classes (window/door/balcony) are a closed taxonomy. The BIP itself works on boxes and numbers only,
  which is compatible.
- It touches files the materials session owns, so it waits for their glass PR.

## 3. Heights from footprints and urban form (Ma, Zhao, Ogawa, Sekimoto 2025, ISPRS XLVIII-4-W15-2025-107; Milojevic-Dupont et al. 2020, PLOS ONE e0242010)

**What they do:**
- Ma et al. predict height from footprint, zoning and roof type. They cluster zoning types by height profile, fit one
  model per cluster, and report random forest best at R² 0.67 in homogeneous zones. Only the abstract was readable.
- Milojevic-Dupont fit XGBoost on 152 features from footprints, streets and blocks over 11.5 M European buildings:
  - MAE 1.47 m (cross-validation) and 1.72–2.98 m (unseen region);
  - 2% local labels cut MAE by up to 1.03 m;
  - footprint area is "by far" the strongest single feature, block features the strongest group, and 500 m context beats
    50 m;
  - tall buildings are predicted poorly.

**What we have:** the first paint (`vector-first-paint.ts`) draws Google's vector footprints while the tiles stream, and
keeps the ones beyond the leaf-tile cap as their own layer. A part with no height was drawn at a flat
`PLAUSIBLE_DEFAULT_HEIGHT_M` = 12 m, labelled generated. The district massing itself never lacks a height: a building is
massed only where the scan stands raised over 60% of its footprint, so the scan measures it.

**Prototype (our own code):** `packages/core/src/node/3d-engine/staged-location/height-norm.ts`.
- Each footprint is continuous numbers only: centroid, ln(area), compactness 4πA/P². No zoning, roof class or type code
  (ADA §1).
- The estimate is a kernel-weighted geometric mean of the place's measured heights, weighted by plan distance, area
  difference and compactness difference. The place median acts as a weak prior.
- The three widths are chosen per place by leave-one-out on a fixed grid, so the answer is deterministic.
- Each estimate carries a 10–90% band and a confidence capped at 0.6. It is always `generated`, with the tested error in
  its provenance.
- One estimate per building, held under the slenderness (height / √plan) that 95% of the place's whole measured
  buildings stay under. Small extruded parts in Google's data are tower setbacks, and without the cap a 3 m² kiosk came
  out 45 m tall.
- Opt-in: `SCRATCHBOX_HEIGHT_NORM=1`. Without it the plain 12 m stays (see the measured results for why).

**Testing it found the duplicate problem first:**
- At Penn (7th Ave & W 32nd St, 500 m), 1,586 of 4,116 footprint parts and 128 buildings had no height.
- Every one was a 2D-only footprint. 115 of these buildings lie under another feature's modelled 3D volume: one 81–89 m
  volume, f38, holds 85 of the 96 that are 30 m² or larger.
- They are that volume's own plan published again, drawn as 12 m slabs inside it. The same change therefore leaves out a
  2D-only footprint when at least half its plan is under another feature's volume (`VECTOR_VOLUME_DUPLICATE_SHARE`,
  `SCRATCHBOX_VECTOR_VOLUME_DEDUP=0` off). The volume already draws that building at its measured height.

### Measured results

**Leave-one-out on measured footprints:** each measured footprint is hidden in turn and predicted from the rest. MAE in
metres, norm vs flat 12 m, 400 m radius (Penn 500 m):

| Place | Measured | Norm | 12 m | Change |
|---|---|---|---|---|
| Penn, NYC | 2,518 | 17.8 | 35.5 | −50% |
| Melbourne CBD | 813 | 14.3 | 21.4 | −33% |
| London, Soho | 2,856 | 3.4 | 5.0 | −32% |
| Shibuya | 2,399 | 6.0 | 10.0 | −40% |
| Paris, Marais | 2,405 | 2.6 | 6.1 | −58% |
| SF, Mission | 1,780 | 1.8 | 3.3 | −44% |
| Austin, East | 1,058 | 1.8 | 6.0 | −69% |

**Penn by height band:**

| Band | Norm | 12 m |
|---|---|---|
| < 10 m | 20.3 | 5.6 |
| 10–30 m | 9.8 | 6.0 |
| 30–80 m | 15.8 | 40.4 |
| ≥ 80 m | 38.7 | 87.5 |

The norm wins where buildings are tall and loses on the few low ones, which 12 m happens to suit.

**Against a measured surface on the real unmeasured buildings:**
- The truth is Google's Solar API DSM: 75th-percentile roof inside the footprint, minus street level measured on the road
  centrelines within 60 m.
- The DSM agrees with Google's own vector heights to a median 1.0 m on 119–464 measured buildings per place. Its mean
  error is 2–8 m, from roof objects and pitched roofs.
- 27 Solar calls in all, under $3.

| Place | Unmeasured (≥ 5 m²) | Norm MAE | 12 m MAE | Area-weighted norm / 12 m |
|---|---|---|---|---|
| Penn (after dedup) | 11 | 20.6 | 19.3 | 20.7 / 23.4 |
| Shibuya | 73 | 19.9 | 16.1 | 39.6 / 38.8 |
| Melbourne | 10 | 9.2 | 11.0 | 18.1 / 25.3 |
| London, Soho | 16 | 8.3 | 14.8 | 2.3 / 13.0 |
| **Pooled** | **110** | **17.3** | **15.7** | |
| Pooled, DSM ≥ 6 m (stands above the street) | 69 | **15.5** | **19.3** | |

**What this says:**
- Unmeasured footprints are not a random sample of buildings. 37% of them (49% at Shibuya) measure under 6 m in the DSM:
  plazas, platforms, canopies, cleared lots.
- No neighbour-based norm can know that, and a flat 12 m is just as wrong there; it is only closer in metres. Where the
  structure stands, the norm is 20% better.
- Before Penn's dedup, the norm cut its error from 56.4 m to 31.0 m on 96 buildings. Nearly all of that was the
  duplicates inside f38, which the dedup now removes outright.
- The literature reports the same selection effect and the same tall-building weakness.

**Expected gain in the product:**
- The dedup removes 115 generated slabs at Penn and changes nothing visible, because they were inside the volume.
- The norm changes the height of the few real unmeasured buildings: 8–80 per 400 m district in these seven places. It
  draws them in scale with their block where they stand.
- Hidden error moves from "every gap is 12 m" to "every gap is its block's typical height". Ground-level things are
  still drawn as buildings, as before.

**In the app (uncached, 2026-11-07, run 53fcfbec, Penn district 300 m, norm switched on):**
- The first paint committed in 8.8 s with 50,930 triangles.
- The norm was fitted on 720 measured footprints, with leave-one-out error 21.9 m against 39.9 m for 12 m.
- 109 duplicates under a modelled volume were left out, and 4 real gaps were estimated: 7.7, 18.4, 33.7 and 46.4 m.
- The 46.4 m one is a 1,077 m² footprint the DSM puts at 2.8 m (street level). Before, it was a 12 m slab; now it is a
  46 m slab. This failure is why the norm is opt-in.
- The same run's tiles stage hit its 360 s limit while streaming under a load average of about 60. The vector stage then
  went degraded at its 120 s limit while waiting on the tiles, after its own layer had committed.

**Default:** the duplicate fix is on. The norm is opt-in until a measured existence gate keeps it off street-level
footprints.

**Cost:** about 3 s per district (fit with 60 grid points × 400 targets) and no spend.

**AGENTS.md conflicts:** none found.
- §1: continuous features only, no zoning or roof classes.
- §4: generated, with its reason and tested error, never over a measured height.
- No vision model is used.

**Next:**
- Gate on a measured existence check. Where the Solar DSM or the scan shows no structure, draw nothing, or a ground-level
  slab, in place of any guess. The DSM is a measurement, so the label becomes `measured` where it reaches.
- A 500 m block-context term, as Milojevic-Dupont found, for the tall-building tail.

## 4. FloorLevel-Net (Wu, Zeng, Fu; arXiv 2107.02462, 2021)

**What it does:** DeepLabV3+ with a facade decoder and a floor-line decoder. Height-attention layers pool width-wise to
carry the strong vertical prior on floor order. Afterwards it fits one line per facade by least squares, refits a shared
vanishing point and enforces increasing order. Line accuracy is 0.894 overall and 0.798 on Street View (UK/HK), in 0.19 s
per image.

**Against our storey pitch:**
- K measures storey pitch on the straightened facade ortho: pier and storey lines traced by Viterbi with sub-pixel
  refinement (`pipeline-k/` rectify), then the window fit's pitch over the band and the reader's measured pitch per zone.
- The ortho removes perspective, which is the paper's main difficulty.
- The paper's useful idea for us is its *position prior* (floor k sits in a predictable height band) and the
  monotone-order constraint. K's Viterbi already enforces order. A prior from the measured ground storey would help only
  where the photo is dim.

**Measured gain to expect:** small. K does not read Street View since the evidence stage was turned off
(`SCRATCHBOX_K_EVIDENCE=1` to enable), so the paper's domain is absent.

**Cost:** a trained network and a model service.

**Conflicts:** none in principle. It is a learned model, which §2 lists among unsupported depth/3D models only if it
were used for geometry. Floor lines are photo-inferred labels, allowed.

## 5. Martinović & Van Gool, CVPR 2013: Bayesian Grammar Learning for Inverse Procedural Modeling (not re-read; CVF returned 403)

**What it does, from prior knowledge, to be checked against the paper before relying on it:**
- Learns a split grammar for facades from labelled facades.
- Starts from one grammar per labelled example and merges rules (Bayesian model merging) to trade the likelihood of the
  examples against the grammar's size (an MDL-style prior).
- Parses new facades with the learned grammar.
- Evaluated on labelled facade datasets (ECP, eTRIMS-style).

**Against the wall grammar:**
- `wall-grammar.ts` reads bays per wall from all its facades' photos together.
- `fitTierGrammar` fits one continuous grammar per setback tier (bay width, pitch, window rows) and lays it only where
  the photo does not show wall.
- That is a per-building grammar from measurements, not a learned prior over buildings. A learned prior could fill a
  facade the photo barely covers.

**Measured gain to expect:** unknown; we have no labelled facades. The facade specialist model plan
(memory, 2026-11-04) would capture reader pairs first, and those could later serve as the labelled set.

**Cost:** a labelled set plus an MCMC/merge search. Weeks.

**Conflicts:** ADA §1. Learned rules over named terminals (window, balcony, shop) are a closed taxonomy. It is
compatible only if the terminals are boxes with continuous attributes. §4's footprint rule is unaffected.

## The prototype in the code

- `height-norm.ts`: the method (`fitHeightNorm`, `estimateHeight(s)`, `footprintNumbers`).
- `vector-first-paint.ts`: `selectPaintBuildings` applies the dedup and the norm (`applyHeightNorm`) and reports
  `heightNorm` (samples, widths, leave-one-out error vs 12 m) and `buildingsUnderOtherVolume`.
  `paintGeneratedHeightProvenance` names the tested error. `VECTOR_MASSING_VERSION` carries `height-norm/1`, so cached
  first paints are rebuilt.
- `orchestrator.ts`: the layer note says what was estimated and what was left out. The chunk planner and the place store
  ask for footprints only (`heightNorm: false`).
- `packages/core/test/height-norm.test.ts`: synthetic districts with known heights.

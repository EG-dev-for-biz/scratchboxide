# Plan: fine-tune TRELLIS.2 on our building data

Drafted 2026-10-24. Status: proposal, nothing built.

## 0. Training code: confirmed released

The [microsoft/TRELLIS.2](https://github.com/microsoft/TRELLIS.2) README documents a full training codebase for training from scratch **or fine-tuning on custom datasets**:

- **Entry point:** `train.py` (`--config --output_dir --load_dir --ckpt --data_dir`, multi-node flags).
- **Data prep:** `data_toolkit/` converts raw meshes to O-Voxel and dumps renders, latents and stats. Dataset entries: `mesh_dump`, `dual_grid`, `pbr_dump`, `pbr_voxel`, `asset_stats`, `ss_latent`, `render_cond`, `shape_latent`, `pbr_latent`.
- **Configs, one per stage:**
  - shape and texture SC-VAE (`scvae/*`);
  - sparse-structure flow at 64³ (`gen/ss_flow_img_dit_1_3B_64_bf16.json`);
  - image→shape flow at 512 (`slat_flow_img2shape_dit_1_3B_512_bf16.json`), plus a `_ft1024` fine-tune;
  - image+shape→texture flow at 512, plus `_ft1024`;
  - higher-resolution fine-tunes set `finetune_ckpt`.
- **Open questions to settle in Phase 0:**
  - The shipped configs say `dit_1_3B`, while the public weights are named "4B". It may be the sum of three 1.3B flows; verify before training.
  - The README gives no training GPU numbers (inference needs 24 GB or more; verified on A100/H100).
  - The roadmap still lists "Release training code"; I couldn't read its checkbox state, so check whether it's complete.

## 1. What we're teaching it

**Input:** our building-survey views (the 2×2 character sheet panels from `pipeline-i/sheet-stations.ts` + `building-character-sheet.ts`).
**Output:** a building that fits the scan's footprint and height and reads as the real place.

That is exactly Pipeline I's job, with Meshy swapped out for our own model. The win condition is not "beat Meshy in general" but beating it on **plan IoU, coverage, scan RMS and photo-match realism/identity** on held-out real buildings.

## 2. The key decision: what is the target mesh?

| Candidate target | Pros | Cons |
|---|---|---|
| Raw isolated 3D Tiles scan | Measured, plentiful | Melty, baked-in trees and cars; the model would learn melt |
| Our accepted rebuilds (pipeline H/G massing + facades) | Clean, footprint-true, labelled | Fewer; inherits our procedural style |
| Meshy outputs fitted to the scan (Pipeline I) | Detailed | Distilling a competitor's output; check Meshy's terms; caps us at Meshy quality |

**Recommendation:** train on **accepted rebuilds**, filtered by a quality gate:
- Haughwout-class gate, 0 degradations;
- plan IoU ≥ 0.85;
- photo-match above a threshold.

Use the scan only as coarse-structure supervision for the 64³ sparse-structure stage. Leave Meshy outputs out of the training set until the terms are checked; they are fine as eval baselines. **This is your call** (§8).

## 3. Data collection (we build this)

1. **Exporter:** add a dataset writer to the staged build. Every finished building writes one record to the durable asset store (`~/.scratchbox`, `asset-db.ts`):
   - the 4 sheet panels + camera poses;
   - the target GLB;
   - the clay scan GLB;
   - footprint + height envelope;
   - anchor;
   - per-part provenance labels;
   - fit metrics from `register.ts` (`planIoU`, `coverage`, `overflowShare`);
   - photo-match scores;
   - pipeline version.

   The exporter must not change build behaviour; it only writes.
2. **Harvest runs:** a headless batch over a place list (via `staged-replay --procedural` style runs) to collect volume without the UI. We need diversity: era, height, roof types, materials, climates, non-US cities.
3. **Hygiene:**
   - strip vehicles and trees (already default per the clean-reference rule);
   - normalise to a unit cube with Y up and the footprint centred, recording the scale for de-normalisation;
   - split train/val/test **by city block**, so neighbouring buildings never leak between splits.
4. **Volume targets:**
   - pilot: 300 buildings;
   - v1: 3,000;
   - v2: 10,000+.

   Plus a replay set of about 20–30% general Objaverse-XL architecture so the model doesn't forget general shape.
5. **Prep:** run `data_toolkit` to O-Voxel + `render_cond` (our 4 panels plus extra renders at random views for single-view augmentation).

## 4. Training phases (each with a go/no-go)

| Phase | Work | Compute (estimate) | Gate to continue |
|---|---|---|---|
| 0. Repro | Run the base TRELLIS.2 inference + `train.py --tryrun` on cloud GPU; confirm the config/weights match; run base TRELLIS.2 through Pipeline I on 20 buildings as a baseline | 1×H100, days | Pipeline runs end to end; we have baseline numbers vs Meshy |
| 1. Pilot shape fine-tune | 300 buildings; fine-tune the ss_flow (64³) + img2shape flow at 512, low LR, full fine-tune or LoRA on the DiT blocks; VAEs frozen | 8×H100, ~2–4 days | Held-out plan IoU / RMS beat base TRELLIS.2 clearly |
| 2. Multi-view conditioning | Extend the conditioning: concatenate the 4 panels' DINO tokens with learned view embeddings (Hunyuan3D-style); train on 3k buildings | 8×H100, ~1–2 weeks | Beats single-view; within reach of Meshy on fit metrics |
| 3. 1024 fine-tune + texture | `_ft1024` shape config; then the texture flow on de-lit PBR targets | 8–16×H100, ~1–2 weeks | Realism/identity ≥ Meshy on held-out; Haughwout benchmark met |
| 4. Preference tune | DPO / reward fine-tune on sampled pairs ranked by photo-match + fit metrics | 8×H100, days | Gains with no regression on the benchmark |

Rough total compute: about 4–8 weeks of an 8×H100 node, roughly $30k–$100k at cloud rates. The cost range is my estimate, not a quoted price.

**We can't train on this Mac.** TRELLIS.2 needs CUDA (sparse conv / flex-gemm kernels). Training runs on rented H100s (Vertex AI custom training fits the Vertex-first preference).

## 5. Evaluation (reuse what exists)

- **Held-out test set:** 100 buildings, never trained on, including Haughwout.
- **Metrics:**
  - `registerToFootprint` plan IoU, coverage and overflow;
  - scan RMS residual;
  - `photo_match_evaluate` realism + identity;
  - vertex/triangle budgets;
  - the `watch-staged-build` Haughwout score.
- **Baselines:** base TRELLIS.2, Meshy 7.1 Ultra 2K multi-view (current Pipeline I), pipeline H.
- **Ship rule:** adopt only if it matches or beats Meshy on fit and identity without dropping realism.

## 6. Integration (after Phase 3 passes)

- New `TrellisClient` beside `fal-meshy.ts`, implementing the same `MeshyClient`-shaped interface. Then Pipeline I can pick its generator, and that's two real implementations of the interface, not a hollow one.
- Output labelled `generated` with a confidence, keeping the fit-and-report behaviour.
- **Serving:** a GPU endpoint (Vertex AI endpoint, or Fal custom deployment).

## 7. Risks

- **Small data:** 3k buildings is small for a 4B-class model. Risk of overfitting to our procedural style; mitigate with the replay set, LoRA, and early stopping on the held-out metrics.
- **Target quality ceiling:** the model can only be as good as our rebuilds. If those are blander than Meshy, we gain fit and lose detail.
- **Licensing:**
  - TRELLIS.2 is MIT;
  - Google 3D Tiles terms on training from tile-derived data: the user has said Google terms aren't a constraint, but note it;
  - Meshy's terms on training from its outputs.
- **Policy:** AGENTS.md §2 lists neural image-to-3D (Trellis) outside Fal.ai as unsupported, and says there is no Cloud Run GPU tier. Both lines need a user decision before integration.

## 8. Decisions needed from you

1. **Training targets:** accepted rebuilds only (recommended), or include Meshy outputs?
2. **Policy:** OK to amend AGENTS.md §2 to allow a self-hosted TRELLIS.2 + a GPU serving tier?
3. **Compute:** OK to spend at this level (§4), and on which provider (Vertex recommended)?
4. **First step:** start Phase 0 + the dataset exporter now?

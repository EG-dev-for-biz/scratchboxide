# Plan: self-hosted Trellis services on Google Cloud

Drafted 2026-10-24. Status: proposal, nothing deployed. Pipeline I's committed model is Trellis multi (user decision 2026-10-24, Puck test: 0.79 vs Meshy's 0.75, about $0.12 vs $1.20 a building); Meshy is dropped. Today Trellis runs on Fal.ai (`pipeline-i/fal-trellis.ts`). This plan brings it in-house as four services that pass work to each other.

## 1. The four services

| Service | Model | Does | Runs as |
|---|---|---|---|
| `trellis1-multi` | TRELLIS (v1) image-large, multidiffusion over 1–4 views | Pipeline I's current job: character sheet views → textured GLB. Same settings as Fal "D" (25+25 steps, 2048 texture, seed per call) so results match | Cloud Run GPU, scale to zero |
| `trellis2-generate` | TRELLIS.2-4B (+ optional LoRA adapter) | image(s) → shape + PBR GLB at 512/1024/1536³ | Cloud Run GPU, scale to zero |
| `trellis2-retexture` | TRELLIS.2 shape-conditioned texture flow (`slat_flow_imgshape2tex`) | an existing mesh + reference image(s) → new PBR textures on *that* mesh, geometry untouched | Cloud Run GPU, scale to zero |
| `trellis2-lora-train` | TRELLIS.2 `train.py` + LoRA on the flow DiTs | a dataset snapshot (our capture bucket) → a LoRA adapter, plus eval scores | Vertex AI custom job (batch, 8×H100/A100), reusing `tools/geobox/launch_vertex_job.cjs` |

**Still to verify before building:**
1. The TRELLIS.2 README listed shape-conditioned texture inference code on its roadmap. Confirm it has shipped; if not, retexture runs the texture flow from the released training configs ourselves (more work).
2. TRELLIS.2's training code is full fine-tuning; LoRA is not in the repo. We add it with `peft` on the DiT attention/MLP blocks. Our own code, small but real.
3. TRELLIS v1 multi-image: the open repo has the multidiffusion multi-image mode Fal exposes. Check that Fal's settings map 1:1 (`multiimage_algo`, guidance strengths, `mesh_simplify`, `texture_size`).

## 2. How they talk to each other: one job contract

All four sit behind one small **gateway** (Cloud Run, CPU) with one API. Bytes never travel in requests: everything is a GCS object.

```
POST /v1/jobs
{ "task": "trellis1.multi" | "trellis2.generate" | "trellis2.retexture" | "trellis2.lora_train",
  "inputs": { "images": ["gs://…/view_1.png", …], "mesh": "job://<id>/model.glb", "adapter": "job://<id>/adapter.safetensors", "dataset": "gs://scoutscan-building-training/training/building/v1/…" },
  "params": { "seed": 7, "resolution": 1024, "texture_size": 2048, … },
  "callback": "optional https URL" }
→ { "id": "<jobId>", "status": "queued" }

GET /v1/jobs/<id> → { status: queued|running|done|failed, outputs: { "model.glb": "gs://…", … }, error?, timings, model, params }
```

- **Chaining:** any input may be `job://<id>/<output>`. The gateway waits for that job and passes its gs:// URI on. Examples:
  - `trellis1.multi` → `trellis2.retexture`: v1's shape, re-skinned with TRELLIS.2 PBR;
  - `trellis2.lora_train` → `trellis2.generate` with `adapter: job://<train>/adapter.safetensors`;
  - `trellis2.generate` → `trellis2.retexture` with a swatch-matched reference.
- Optionally a `pipeline` array in one request runs a chain server-side.
- **Outputs:** `gs://scoutscan-trellis-jobs/jobs/<id>/…` (separate bucket, 30-day lifecycle). Every output carries the model, version, params and seed as metadata, so provenance labels stay honest (`generated`).
- **App client:** `TrellisServiceClient` implements the existing `ModelClient` interface (`fal-trellis.ts`), so pipeline I can switch between Fal and self-hosted. That's two real implementations of the interface. Retexture and LoRA get their own small typed clients.
- **Seeds in parallel:** pipeline I's best-of-6 seeds becomes 6 jobs at once; Cloud Run scales GPU instances out to match.

## 3. Infrastructure

- **Project and region:** `scoutscan`, `us-central1`. Images in Artifact Registry `us-central1-docker.pkg.dev/scoutscan/trellis-repo/*`.
- **Images:** one per model family (`trellis1`, `trellis2`), CUDA 12.4, weights baked in or mounted from GCS. The CUDA base can come from `scripts/train/Dockerfile.train`; replace its toy `trellis_urban_dit.py` entrypoint.
- **GPUs:**
  - TRELLIS.2 needs ≥ 24 GB. Cloud Run's L4 (24 GB) is tight at 1024³; the RTX PRO 6000 (96 GB) tier is safe. Measure in Phase 0.
  - TRELLIS v1 fits on an L4.
  - Cold start matters: use min-instances 0 for retexture and v2, and 1 for `trellis1-multi` during build hours if cold start hurts pipeline I's budget.
- **Queue:** Cloud Tasks per service, so GPU containers pull one job at a time; job state lives in Firestore (or a GCS JSON per job, which is simpler; start there).
- **Auth:** the app's existing service account (Vertex-first), IAM-only ingress.
- **Cost:** pay per GPU-second, with scale to zero. To measure against Fal's about $0.02 per call; self-hosting only wins with steady volume, or for what Fal doesn't offer (TRELLIS.2 LoRA, retexture, our own adapters).

## 4. Build order

1. **Phase 0, measure:** `trellis1-multi` container; reproduce Fal "D" on Puck with the same seeds, then compare score, seconds and cost. Gate: within noise of Fal's 0.79.
2. Gateway + job contract + `TrellisServiceClient`; pipeline I selectable `fal | self-hosted`.
3. `trellis2-generate` (base weights), compared on Puck and Haughwout against v1 multi.
4. `trellis2-retexture`, tested by re-skinning v1 outputs with the swatch.
5. `trellis2-lora-train`, reading the capture bucket; first adapter on the pilot set; eval through `trellis2-generate`.

## 5. Policy changes this needs (your decision)

AGENTS.md §2 currently says:
- neural image-to-3D (Trellis/TripoSR) outside the Fal.ai path is unsupported;
- there is no Cloud Run GPU tier.

Both lines would change to something like: "Trellis (v1 multi via Fal or the self-hosted services, TRELLIS.2 generate / retexture / LoRA) on the `scoutscan` Trellis services is supported; GPU work runs on Cloud Run GPU or Vertex jobs." Also `resolveTaskCapability` (`task-capability-resolver.ts`) would need to report these as native.

# Pipeline K: parts-aware generation — research + scoped plan

> Drafted 2026-10-24, forked session. Companion to the Pipeline I/J investigation in
> [docs/processes/pipeline_i_empire_state_building_gate_rejection.md](../processes/pipeline_i_empire_state_building_gate_rejection.md).
> Not implemented. This is a scoped brief for the main agent to pick up.

## 1. The ask

Add a general split-into-parts → generate-per-part → assemble-in-unison capability ("Pipeline K"), usable on anything — a
single huge structure (the Empire State Building's setback tiers), a district (many buildings), or a general object —
not just staged-location buildings. Keep the parts stylistically and geometrically coherent on reassembly. A "parts list
JSON" was proposed to carry the relationships.

## 2. Research: PartCrafter, HoloPart, OmniPart

| Model | Base / architecture | Hosting | Part input | Taxonomy stance |
|---|---|---|---|---|
| **PartCrafter** ([arXiv 2506.05573](https://arxiv.org/abs/2506.05573), [NeurIPS 2025](https://papers.nips.cc/paper_files/paper/2025/file/32cc61322f1e2f56f989d29ccc7cfbb7-Paper-Conference.pdf), [project page](https://wgsxm.github.io/projects/partcrafter/)) | Compositional latent diffusion transformer built on a pretrained whole-object mesh DiT (TripoSG lineage); each part gets its own latent tokens (K tokens/part), hierarchical attention within and across parts; up to 16 parts/object. No separate segmentation step — generates multiple part meshes from one image directly. | No hosted API found (self-host only; [GitHub](https://github.com)/weights via the project page). | None needed — infers parts directly from the image. | No labels at all; parts are just latent slots. Taxonomy-free by construction, but gives you *no* semantic/relational metadata either — you'd have to derive the "parts list JSON" yourself from the output. |
| **HoloPart** ([arXiv 2504.07943](https://arxiv.org/pdf/2504.07943), [GitHub](https://github.com/VAST-AI-Research/HoloPart), [HF weights](https://huggingface.co/VAST-AI/HoloPart)) | Diffusion model built on TripoSG; *completes* parts (amodal segmentation) given existing segment masks — fills in geometry hidden by occlusion. MIT-licensed, open weights (~2B params), self-hostable. | Not Fal.ai-hosted. | **Requires external segmentation masks as input** (typically from SAMPart3D) — output quality is directly gated on mask quality. | Depends entirely on the upstream segmenter's vocabulary. If that segmenter is open-vocabulary (SAM-style), this stays taxonomy-free; if not, it isn't. |
| **OmniPart** ([arXiv 2507.06165](https://arxiv.org/abs/2507.06165), [paper page](https://huggingface.co/papers/2507.06165)) | Two-stage: an **autoregressive structure-planning module** lays out part bounding boxes first, then a **spatially-conditioned rectified-flow model built directly on TRELLIS** (the same holistic 3D generator this codebase already runs) synthesizes each part inside its planned box. Evaluated on 180K annotated objects. | **Hosted on Fal.ai**: `fal-ai/omnipart`, image-to-3D, ~$0.2/request, takes an image URL plus an optional `minimum_segment_size` (default 2000 px) — same request/poll shape as the existing `fal-ai/trellis/multi` and `fal-ai/meshy/multi` endpoints. | Flexible 2D masks, from the user **or from an open-vocabulary segmenter like SAM** — the paper is explicit that these "do not impose strict one-to-one correspondences or require explicit semantic labels." | **Taxonomy-free by design**, not by exception — it never requires a fixed part vocabulary anywhere in its pipeline. |

## 3. Recommendation: OmniPart

Three reasons this is the clear best fit for *this* codebase specifically, not just "best paper":

1. **It's TRELLIS, not a new backbone.** The part-synthesis stage is built directly on TRELLIS — the same model family already running in both the self-hosted GCP services (`trellis1-multi`, `trellis2-generate`, `trellis2-retexture`, `trellis2-lora-train`) and the Fal.ai path (`fal-ai/trellis/multi`, used by Pipeline I today). This isn't a new dependency to vet; it's an extension of one already trusted.
2. **It's already on Fal.ai, in the exact shape the integration pattern expects.** `fal-ai/omnipart` takes the same request/poll/upload shape as `fal-ai/trellis/multi` and `fal-ai/meshy/multi`. A `createFalOmnipartClient()` next to [`fal-trellis.ts`](../../packages/core/src/node/3d-engine/staged-location/pipeline-i/fal-trellis.ts) and [`fal-meshy.ts`](../../packages/core/src/node/3d-engine/staged-location/pipeline-i/fal-meshy.ts) is close to a drop-in, using the same `createFalQueue`/`FAL_KEY` plumbing both already use.
3. **It resolves the ADA tension without needing the exception the user offered.** OmniPart's planner takes open 2D masks and never requires semantic labels or a fixed part vocabulary. Feed it masks from `vfx_segment_subject`/`ObjectSegmenterService` — the open-vocabulary segmenter this codebase already has — and the whole pipeline stays closed-taxonomy-free end to end. **No exception to `AGENTS.md` §1 needed; the right tool choice makes the exception moot.** (Worth keeping in reserve: if some future part-aware method genuinely needs a small, honestly-scoped exception, record it the way `AGENTS.md` already records other standing decisions — explicit, dated, narrow — rather than assuming one here.)

PartCrafter is the strongest *pure* research result (beats HoloPart on Chamfer distance) but needs self-hosting with no existing infra to land it in, and gives back latent part slots with no relational metadata — more building-it-from-scratch work for the same outcome. HoloPart needs an external segmenter already, so it's strictly more plumbing than OmniPart for the same taxonomy-free property, with no Fal.ai hosting either. OmniPart dominates on fit-to-existing-infra even if it isn't the newest or single best-benchmarked paper.

## 4. Kept from the earlier brainstorm (user confirmed these)

- **Dispatch by verifiability, not "always generate."** Parts with something real to register against (a scan slice for a building tier, a district's measured footprint) go through OmniPart/Trellis and get fit/judged against that ground truth. Parts with nothing real to check against (pure-imagination object parts) stay on the four geometric operators / parametric grammars, per `AGENTS.md` §1.6 — OmniPart generation is additive to that, not a replacement for it.
- **Always something to register against.** For a non-building part, that's the pre-existing procedural/clay geometry's own bounding transform before replacement — never a free-floating generated part with nothing to verify it against.
- **One shared coordinate frame, one shared style reference.** Every part's `transform` is in the whole assembly's frame, never relative to a sibling part. Harmonize color/material in one pass over a single `styleRef`, not per-part.
- **Two-level verification.** Per-part fit metrics (OmniPart/Trellis's own, or procedural tolerance stats) *and* a whole-assembly check — a `photoMatchGate`-style judge where real photos of the whole subject exist, a geometric seam/continuity check where they don't.
- **Placement: a standalone capability, not a staged-location pipeline letter.** E/G/H/I/J are specifically about real geocoded structures with scan evidence. This needs to work on districts *and* general objects, so it should live as its own split/dispatch/assemble service that staged-location calls into for building tiers, and that object builds call into for parts — not "Pipeline K" bolted onto the building-only letter sequence.

## 5. Parts-relationship JSON (refined)

```ts
interface PartSpec {
  partId: string;                 // opaque, stable id
  labels: string[];                // open vocabulary, human/prompting hints ONLY — never branched on
  geometrySource: 'measured' | 'procedural' | 'generated' | 'generated-fitted';
  registrationTarget:              // what this part was verified against — never absent
    | { kind: 'scan-slice'; ref: string }
    | { kind: 'pre-replacement-geometry'; transform: Mat4; silhouette: Vec2[] };
  boundaryInterfaces: Array<{      // shared seams with neighbors, in the whole assembly's frame
    neighborPartId: string;
    curveOrPlane: unknown;         // boundary geometry, coordinates in the shared frame
  }>;
  styleRef: string;                // pointer to ONE shared master swatch/material — never per-part
  fit: Record<string, number>;     // heterogeneous by generation method, always present
  transform: Mat4;                 // placement in the shared assembly frame
}
```

Assembly = place every part by `transform`, verify every `boundaryInterfaces` pair actually meets (cheap, no model
calls), run one swatch-harmonization pass against the single `styleRef`, then the two-level verification from §4.

## 6. Scoped rollout for the main agent

1. `createFalOmnipartClient()` next to the existing Trellis/Meshy clients — mechanical, same pattern, lowest risk.
2. A standalone split/assemble service (not inside `staged-location/`) implementing the `PartSpec` schema above; its
   split step calls `vfx_segment_subject` for open masks, feeds them to OmniPart.
3. Wire it into the Pipeline I/J path *first*, scoped to the tier-decomposition case from the ESB investigation — it's
   the concrete, already-diagnosed failure this solves, and gives a real benchmark to verify against (plus the
   Haughwout/Puck/Flatiron regression set already used to gate staged-location changes).
4. Only after that's verified live: generalize the same service to object builds' parts, where the four-operator /
   procedural path remains the default and OmniPart/Trellis is additive, gated on verifiability per §4.

Do not implement without live-verifying step 3 against the existing benchmark buildings first — same discipline this
session already applied to the texture-atlas and held-out-fold patches.

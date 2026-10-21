# External Repo Logic Research Brief — GitHub License-Verification List

**Source:** `GitHub-Repos-License-Verification.xlsx` (41 repos, NeRF/3DGS/diffusion research, uploaded 2026-10-18)
**Purpose:** Direct research-agent passes to determine which repos contain *algorithmic logic* worth porting into Scratchbox IDE's native pipelines. This is a research/analysis task, not an implementation task — do not write production code against any of these repos until findings are reviewed.

## Ground rules for this research

1. **ADA and Native Capabilities compliance first.** Before reading any repo, re-check it against `AGENTS.md`'s Native Capabilities Directive and Open-Domain Universality Directive. Any repo that is fundamentally a hosted diffusion/LoRA/CUDA-training stack is **out of scope for adoption** regardless of how good its logic is — the app is contracted to Google's Gemini/Imagen/Veo models and the native C++20 engine only. Document *why* a repo is out of scope rather than skipping it silently.
2. **Logic extraction, not code reuse.** We are never vendoring or copy-pasting GPL/unclear-license code into this repo. The ask is: read the paper/README/core algorithm, understand the math, and assess whether an equivalent *native* (C++20 / TypeScript, license-clean) implementation would improve an existing Scratchbox service. Flag the license status explicitly for anything recommended (per the spreadsheet's own "Verified / Likely Open / Needs Verify" column — don't assume "Likely Open" is actually clear).
3. **Tie every finding to a concrete file/service in this codebase.** A finding like "SuGaR has a good mesh-extraction idea" is useless without naming which service it would improve (e.g. `Calibrated3DGSReconstructionService`, `AnalyticalGroomSplatService`, `scratchbox_engine.hpp`'s Marching Cubes path) and what the current gap is.
4. **No simulation traps.** Per the Mechanical Reality Grounding directive, don't report a technique as "adoptable" without actually reading its core algorithm (paper or source), and don't claim verification without it.

## Priority tiers to research (already triaged — verify and deepen)

### Tier 1 — directly maps to an existing pipeline, highest expected payoff
For each, answer: *what is the core algorithm, and what specific gap in our pipeline does it close?*

- **graphdeco-inria/i3dgs** — original 3DGS authors' repo. Check what's improved vs. the original 3DGS paper (SH encoding, covariance/rasterization, compression). Relevant to `PhotorealGaussianSplatMesh.ts` / `createAnisotropic3DGSSplatMaterial`.
- **Anttwo/SuGaR** — surface-aligned Gaussian splatting → mesh extraction. Relevant to bridging `splat` and `mesh` layers of `Universal3DStructureFoundation`.
- **xxlong0/NeuralUDF** — unsigned distance field surface reconstruction (no mask supervision needed). Relevant to `scratchbox_engine.hpp`'s SDF/Marching Cubes path — could inform reconstructing surfaces from noisy/partial point data.
- **dcharatan/pixelsplat**, **chensjtu/GaussianObject**, **caiyuanhao1998/Open-DiffusionGS**, **TencentARC/FreeSplatter** — feed-forward, few-view 3DGS reconstruction with no per-scene optimization and no COLMAP dependency. Relevant to `single_image_to_3dgs`, `panorama_to_3dgs`, `DepthBoxInferenceService`. Note: some of these *are* neural-network-based (diffusion or transformer feed-forward nets) — assess per rule 1 whether the *algorithm* (e.g. the geometric initialization/ray-based splat placement) is separable from "stand up a neural net we'd have to train/host," which would make it out of scope.
- **ywq/psnerf (PS-NeRF)** — photometric-stereo inverse rendering (reflectance + normal estimation from multi-view photos). Relevant to `LocationObjectLightingService` / photogrammetric de-lighting.
- **asadcinewedding-debug/V5** — image relighting tool. Directly on-topic for the de-lighting directive, but it's an unverified/tiny repo (0 stars, "Needs Verify" license) — confirm it's actually real, working code before investing time.
- **Bita-Panahi/Gonio_BRDF**, **hussainmir05/RGBNMat-Material-Recognition** — BRDF / material-from-image estimation. Relevant to `AlgorithmicUvEngine`'s PBR synthesis. Both are "Needs Verify" license status — check LICENSE files first.
- **fabiotosi92/NeRF-Supervised-Deep-Stereo** — stereo depth estimation. Relevant to whether `PanoramaDepthService` (currently monocular-only, Depth Anything V2) could add a stereo-refinement path — note this would need an explicit product decision since AGENTS.md currently pins depth to one model.

### Tier 2 — large-scale / dynamic-scene ideas, moderate payoff
- **city-super/BungeeNeRF** (city-scale LOD), **AIBluefisher/DOGS** (distributed large-scene 3DGS), **MisEty/RTG-SLAM**, **Southparketeer/SLAM-Large-Dense-Scene-Real-Time-3D-Reconstruction**, **fangzhou2000/DrivingForward** — large-scale/LOD-aware real-time reconstruction. Relevant to UTDRA tile decomposition and multi-district gallery scaling. Research question: do any of these describe an LOD/tiling strategy better than what `UniversalTileDecompositionService` already does for the 9 macro-geographic domains?
- **zju3dv/object_nerf** — object-level scene decomposition. Relevant to the "atomic building entity, zero-clipping" rule — check if its segmentation approach could harden boundary-dilation logic.
- **DSaurus/Tensor4D**, **med-air/EndoNeRF** — deformable/dynamic 4D scene representations. Relevant to `VideoTo4DPerformerPipelineService`.

### Tier 3 — explicitly out of scope, document and close
Confirm and record (one line each is enough) why these don't warrant further research time:
- `huggingface/diffusers`, `FoundationVision/VAR`, `open-mmlab/mmagic`, `FoundationVision/LlamaGen`, `kandinskylab/kandinsky-5`, `Tencent-Hunyuan/HunyuanImage-2.1`, `sharonzhou/long_stable_diffusion`, `showlab/Tune-A-Video` — hosted diffusion/autoregressive generative model stacks; app is pinned to Google Imagen/Veo/Gemini only.
- `NVlabs/tiny-cuda-nn` — CUDA-accelerated neural net training; app does no GPU model training (no ComfyUI/Cloud-Run GPU tier).
- `KillianCartelier/UnityGaussianCapture`, `genesisinteractive/QuestRoomScan` — Unity/Quest-native; wrong platform (WebXR/Three.js/C++20 stack, not Unity).
- The two "Awesome-*-in-Medical-Imaging" repos — curated reading lists, not code; skip unless medical-imaging domain work is explicitly requested later.
- `ventusff/neurecon`, `apchenstu/mvsnerf`, `liuyuan-pal/NeuRay`, `jkulhanek/viewformer`, `snap-research/R2L`, `JOP-Lee/READ` — older per-scene/generalizable NeRF techniques now superseded by the app's 3DGS stack; only worth revisiting if a specific multi-view-consistency gap surfaces that Tier 1/2 don't cover.

## Deliverable

A short findings doc (same `docs/processes/` location, one doc, not one per repo) with, per Tier 1/2 repo actually researched:
1. Repo name + verified license status (re-check on GitHub, don't trust the spreadsheet's "Likely Open" guess)
2. Core algorithm in 2-4 sentences
3. Named target service/file in this codebase it would improve
4. Concrete gap it closes
5. Recommendation: port the idea natively / not worth it / needs a product decision first (and why)

Do not begin implementation from this brief — it's a research/analysis pass. Surface the findings doc back to the user before touching any pipeline code.

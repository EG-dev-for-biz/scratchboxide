---
name: google-genai-models
description: >-
  Call on all of Google's Generative AI models across Google AI Studio (Gemini API) and Google Cloud Vertex AI,
  dynamically tracking GA (General Availability), Public Preview (-preview), Developer Experimental (-exp), and
  Whitelisted/Pre-GA models. Use when creating text, code, structured JSON schemas, photorealistic PBR textures via
  Imagen 3, cinematic video via Veo 2 / Omni 1.1, continuous multimodal embeddings, or dynamically querying live model
  capabilities for Google developers.
---

# Google Generative AI Models (GA & Non-GA Unified Director)

This skill equips Antigravity to discover, direct, and programmatically invoke **all of Google's Generative AI models** across **Google AI Studio (Developer API)** and **Google Cloud Vertex AI (Model Garden & Interactions API)**.

It ensures that Antigravity stays synchronized with Google's rapid model releases, distinguishing between:
- **GA (General Availability)**: Production-ready, enterprise SLA-backed, stable contracts (`gemini-2.5-flash`, `gemini-1.5-pro-002`, `imagen-3.0-generate-002`, `text-embedding-004`).
- **Public Preview (`-preview`)**: Feature-complete upcoming versions (`gemini-3.8-flash`, `gemini-3.7-pro`, `gemini-2.5-pro`, `veo-2.0-generate-001`, `imagen-3.0-capability-001`).
- **Developer Experimental (`-exp`)**: Rapid-iteration experimental checkpoints with transparent reasoning traces and generous developer limits (`gemini-2.0-flash-thinking-exp-01-21`, `gemini-2.0-pro-exp-02-05`).
- **Whitelisted / Pre-GA / Trusted Tester**: Advanced multimodal video and spatial physics endpoints (`gemini-omni-1.1-flash`, `veo-3-preview`).

---

## 1. Authentication & Dual-Provider Architecture

The workspace provides automatic dual-credential resolution through [scripts/google_genai_hub.mjs](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-genai-models/scripts/google_genai_hub.mjs):

```
                                  ┌───────────────────────────────┐
                                  │      Antigravity Agent        │
                                  └──────────────┬────────────────┘
                                                 │
                                 ┌───────────────▼────────────────┐
                                 │   google_genai_hub.mjs Engine  │
                                 └───────┬────────────────┬───────┘
                                         │                │
                     ┌───────────────────▼──┐          ┌──▼────────────────────┐
                     │   Google AI Studio   │          │ Google Cloud Vertex AI│
                     │  (Developer API Key) │          │ (Service Account/ADC) │
                     ├──────────────────────┤          ├───────────────────────┤
                     │ • Experimental Check-│          │ • Enterprise SLAs     │
                     │   points (-exp)      │          │ • Interactions API    │
                     │ • Generous Dev Quota │          │   (Omni 1.1 Video)    │
                     │ • Rapid Prototyping  │          │ • Model Garden        │
                     └──────────────────────┘          └───────────────────────┘
```

### Credential Resolution Hierarchy
1. **Google AI Studio API Key**: Automatically extracted from `secrets.json` (`GEMINI_API_KEY`, `GOOGLE_GENAI_API_KEY`, or `GOOGLE_AI_API_KEY`) or environment variables.
2. **Google Cloud Vertex AI**: Automatically loaded from `secrets.json` (`GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`), targeting GCP project (e.g. `scoutscan` or `scratchbox-canvas`) in `us-central1` or `global`.
3. **Application Default Credentials (ADC)**: Resolves active credentials via `gcloud auth application-default login`.

To diagnose credential status at any time, run:
```bash
node .agents/skills/google-genai-models/scripts/test_model_access.mjs
```

---

## 2. Dynamic Model Discovery & Capabilities Registry

Never rely on hardcoded enums. In accordance with **Adaptive Domain Architecture (ADA)**, Google models are cataloged across continuous physical and computational parameters (context tokens, max output tokens, latency tier, reasoning scratchpad support, multimodal inputs).

### Discover Models via CLI
```bash
# Instant catalog view (filtered by lifecycle or modality)
node .agents/skills/google-genai-models/scripts/google_genai_hub.mjs --list
node .agents/skills/google-genai-models/scripts/google_genai_hub.mjs --list --lifecycle experimental
node .agents/skills/google-genai-models/scripts/google_genai_hub.mjs --list --modality video

# Inspect full continuous parameters for any model
node .agents/skills/google-genai-models/scripts/google_genai_hub.mjs --info gemini-2.5-pro

# Live network query to detect newly dropped Google models and update catalog
node .agents/skills/google-genai-models/scripts/google_genai_hub.mjs --update-catalog
```

Full continuous schema details are maintained in [references/model_registry.json](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-genai-models/references/model_registry.json).

---

## 3. Google Generative AI Models Matrix

### A. Reasoning, Multimodal & Coding (Gemini Family)

| Model ID | Lifecycle | Context | Modalities | Key Strengths & Use Cases |
|---|---|---|---|---|
| `gemini-3.8-flash` | **Preview** | 1M tokens | Text, Code, Image, Video, Audio | Next-gen ultra-fast reasoning; interactive pair programming and sub-200ms TTFT. |
| `gemini-3.7-pro` | **Preview** | 2M tokens | Text, Code, Image, Video, Audio | Frontier reasoning, deep architectural synthesis, large-scale codebase refactoring. |
| `gemini-2.5-pro` | **Preview** | 2M tokens | Text, Code, Image, Video, Audio | Workhorse for native C++20 engine code generation, SIMD algorithms, and spatial logic. |
| `gemini-2.5-flash` | **GA** | 1M tokens | Text, Code, Image, Video, Audio | Production-stable sub-second tool execution and structured JSON contracts. |
| `gemini-2.5-flash-lite` | **Preview** | 1M tokens | Text, Code, Image, Audio | Ultra-lightweight model with sub-100ms latency for batch parsing. |
| `gemini-2.0-flash-thinking-exp-01-21` | **Experimental** | 1M tokens | Text, Code, Multimodal | Dedicated thinking scratchpad; mathematical invariant verification, logic puzzles. |
| `gemini-2.0-pro-exp-02-05` | **Experimental** | 2M tokens | Text, Code, Multimodal | Advanced coding benchmark model for complex shaders and algorithmic kernels. |
| `gemini-2.0-flash` | **GA** | 1M tokens | Text, Code, Image, Video, Audio | Real-time multimodal streaming and live audio/video understanding. |
| `gemini-1.5-pro` | **GA** | 2M tokens | Text, Code, Image, Video, Audio | Enterprise production SLA with 2-million-token repository ingestion. |
| `gemini-1.5-flash` | **GA** | 1M tokens | Text, Code, Image, Video, Audio | High-speed production endpoints and RAG retrieval. |

### B. High-Fidelity Image Generation & Inpainting (Imagen & Nano Banana Family)

| Model ID | Lifecycle | Aspect Ratios | Capabilities & Creative Use Cases |
|---|---|---|---|
| `nano-banana-2.1` | **Whitelisted** | `1:1`, `16:9`, `9:16`, `4:3`, `3:4` | Google's non-GA flagship neural image diffusion engine. Photographic micro-detail, razor-sharp typography, and alpha-accurate disocclusion inpainting. |
| `nano-banana-2.1-mig` | **Whitelisted** | Variable | **Nano Banana with Maps Imagery Grounding (MIG)**. Grounds diffusion against authentic Google Street View panoramas, aerial photogrammetry, and 6-DOF camera attitude with zero hallucination drift. |
| `imagen-3.0-generate-002` | **GA** | `1:1`, `16:9`, `9:16`, `4:3`, `3:4` | Production photorealism, tactile PBR material texture maps, fine material sheen. |
| `imagen-3.0-fast-generate-001` | **GA** | `1:1`, `16:9`, `9:16`, `4:3`, `3:4` | Rapid concept thumbnailing and storyboard iteration with 3x lower latency. |
| `imagen-3.0-capability-001` | **Preview** | Variable | Masked inpainting, background environment swapping, outpainting panoramas. |

### C. Cinematic Video Generation & Spatial Trajectories (Veo & Omni)

| Model ID | Lifecycle | Resolution / FPS | Conditioning & Creative Use Cases |
|---|---|---|---|
| `veo-2.0-generate-001` | **Preview** | 720p / 1080p / 4K, 24fps | Text-to-video and image-to-video with camera motion tags and cinema lighting. |
| `gemini-omni-1.1-flash` | **Whitelisted** | 720p / 1080p | Vertex AI Interactions API with `<FIRST_FRAME>`, `<LAST_FRAME>`, and `<VIDEO_REF_0>` blockout matchmoving. |
| `gemini-omni-preview` | **Whitelisted** | 720p / 1080p | Non-GA Omni multimodal foundation model with Bidirectional Streaming and low-latency interaction. |
| `veo-3-preview` | **Whitelisted** | 4K | Bleeding-edge neural video foundation model with advanced physical fluid simulation. |

### D. Embeddings & Open Weights

| Model ID | Lifecycle | Dimensions | Use Cases |
|---|---|---|---|
| `text-embedding-004` | **GA** | 768 (truncatable) | Continuous semantic search, RAG retrieval, codebase symbol clustering. |
| `multimodalembedding@001` | **GA** | 1408 | Joint text, image, and video vector search in unified metric space. |
| `gemma-2-27b-it` | **GA** | N/A | Open-weights model for local deployment or private Cloud Run microservices. |
| `paligemma-2-28b-pt-448` | **Preview** | N/A | Pixel-grounded bounding boxes and fine-grained visual object detection. |

### E. Geo Cloud Automotive Program (GCAP) Vector & Roadmap Tiles API

| Endpoint / Method | Lifecycle | Resolution | Capabilities & Creative Use Cases |
|---|---|---|---|
| `tile.googleapis.com/v1/vectortiles/featuretiles` (`GetFeatureTiles`) | **Whitelisted** | $4096 \times 4096$ Sub-pixel | High-precision vector geometry: 3D building meshes (`modeledVolumes` via `TriangleStrip`), 2.5D extruded prisms (`extrudedAreas`), parcels, water, and detailed road surfaces. |
| `tile.googleapis.com/v1/vectortiles/traffictiles` (`GetTrafficTiles`) | **Whitelisted** | Polylines | Real-time traffic speeds, congestion levels, road closures, and directional incident markers. |
| **Detailed Road Markings** | **Whitelisted** | Metric Space | Sub-pixel lane markings (`_LANE_MARKING`), dashed lines (`_CROSSABLE`), turn icons (`_LANE_TURN_ICONS`), and crosswalks (`_CROSSWALK`). |

---

## 4. Model Selection Heuristic for Creative Pipelines

When executing tasks in Scratchbox IDE, route to the optimal model based on task demands:

```
                                      [User Task Objective]
                                                │
         ┌──────────────────┬───────────────────┼───────────────────┬──────────────────┬──────────────────┐
         ▼                  ▼                   ▼                   ▼                  ▼                  ▼
    [Deep Logic /      [Sub-Second         [Photorealistic      [Street View       [Cinematic Video   [Vector Roads /
   C++ Architecture]   Agent Loops]         PBR Textures]      Grounded Visuals]  & 3D Blockouts]    3D Building Tiles]
         │                  │                   │                   │                  │                  │
         ▼                  ▼                   ▼                   ▼                  ▼                  ▼
   gemini-2.5-pro /   gemini-2.5-flash /   nano-banana-2.1 /   nano-banana-2.1    veo-2.0-generate /  gcap-vectortiles
   gemini-3.7-pro /   gemini-3.8-flash     imagen-3.0-002      -mig (Vertex MIG)  gemini-omni-1.1     (FeatureTiles)
   thinking-exp
```

1. **Complex C++20 Geometry / SIMD Kernels**: Use `gemini-2.5-pro` or `gemini-3.7-pro`.
2. **Step-by-step Math & Differential Geometry Proofs**: Use `gemini-2.0-flash-thinking-exp-01-21`.
3. **High-Speed Agent Loops & JSON Schema Enforcement**: Use `gemini-2.5-flash` or `gemini-3.8-flash`.
4. **Photographic Surface Textures & Typography**: Use `nano-banana-2.1` or `imagen-3.0-generate-002`.
5. **Real-World Street View Grounded Synthesis**: Use `nano-banana-2.1-mig` with Vertex AI Maps Imagery Grounding.
6. **3D Camera Blockout Matchmoving into Photoreal Video**: Use `gemini-omni-1.1-flash` or `gemini-omni-preview`.
7. **Authentic Road Corridors & 3D Building Volumes**: Query GCAP Vector Tiles (`fetchGcapFeatureTile`).

---

## 5. Programmatic Code Snippets

### A. Generating Text, Code, or Structured JSON
```javascript
import { generateContent } from './.agents/skills/google-genai-models/scripts/google_genai_hub.mjs';

const result = await generateContent({
  model: 'gemini-2.5-pro',
  systemInstruction: 'You are an expert computational geometer for Scratchbox IDE.',
  prompt: 'Synthesize continuous physical parameters for a subterranean hyperloop terminal.',
  json: true // Enforces strict JSON output
});
console.log(result.text);
```

### B. Multimodal Visual Inspection (Images & Viewports)
```javascript
import { generateContent } from './.agents/skills/google-genai-models/scripts/google_genai_hub.mjs';

const audit = await generateContent({
  model: 'gemini-2.5-pro',
  images: ['public/images/dense_plaza_omni_kf01_f1.png'],
  prompt: 'Audit this 3D viewport rendering against the 70-20-10 form hierarchy and report geometric flaws.'
});
console.log(audit.text);
```

### C. Synthesizing High-Fidelity PBR Textures (Imagen 3)
```javascript
import { generateImages } from './.agents/skills/google-genai-models/scripts/google_genai_hub.mjs';

const texture = await generateImages({
  model: 'imagen-3.0-generate-002',
  prompt: 'Macro photographic flat lay of oxidized basalt stone, orthogonal top-down texture map, perfectly flat lighting, 8k resolution, physically accurate albedo.',
  aspectRatio: '1:1',
  outputPath: 'public/renders/basalt_pbr_albedo.png'
});
console.log(`Saved texture to: ${texture.savedPaths[0]}`);
```

### D. Nano Banana 2.1 with Maps Imagery Grounding (MIG)
```javascript
import { createGenAIClient } from './.agents/skills/google-genai-models/scripts/google_genai_hub.mjs';

const { client } = createGenAIClient({ vertex: true });

const response = await client.models.generateContent({
  model: 'nano-banana-2.1-mig',
  contents: 'Synthesize the south facade of the Colosseum in Rome at golden hour.',
  config: {
    tools: [
      {
        googleMaps: {
          groundingTypes: {
            streetviewImagery: {} // Grounds diffusion against Street View ERP panoramas
          }
        }
      }
    ],
    temperature: 0.2
  }
});
```

### E. Querying GCAP 3D Building Meshes & Detailed Road Markings
```javascript
import { fetchGcapFeatureTile, decodeGcapDeltaOffsets } from './.agents/skills/google-genai-models/scripts/google_genai_hub.mjs';

const { tile, featureCount } = await fetchGcapFeatureTile({
  zoom: 17,
  x: 66371,
  y: 45091,
  enableModeledVolumes: true, // Returns 3D building meshes
  alwaysIncludeBuildingFootprints: true
});

for (const feature of tile.features) {
  // Decode true 3D building modeledVolumes
  if (feature.geometry?.modeledVolumes) {
    for (const volume of feature.geometry.modeledVolumes) {
      const vertices3D = decodeGcapDeltaOffsets(volume.vertexOffsets);
      // vertices3D contains [x, y, z] points in local tile coordinates [0..4095]
    }
  }
}
```

---

## 6. Keeping Up-to-Date with Google Releases

As a Google developer, new models and canary checkpoints release frequently:
1. **Periodic Refresh**: Run `node .agents/skills/google-genai-models/scripts/update_model_catalog.mjs` whenever Google announces a new model checkpoint or API update.
2. **Experimental Models Access**: Check AI Studio regularly for new `-exp` checkpoints (`gemini-exp-*`). They are instantly usable through `google_genai_hub.mjs --generate --model <id>`.
3. **Whitelisted Projects**: If your GCP project receives Trusted Tester access to new foundational models (such as Veo 3 or Gemini Omni updates), update your GCP project ID in `secrets.json` and invoke directly through the unified client.

---

## Related References
- [references/model_registry.json](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-genai-models/references/model_registry.json) - Complete structured model specifications & capabilities
- [references/gcap_vector_tiles_spec.md](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-genai-models/references/gcap_vector_tiles_spec.md) - Geo Cloud Automotive Program (GCAP) Vector & Traffic Tiles API specification
- [references/nano_banana_mig_spec.md](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-genai-models/references/nano_banana_mig_spec.md) - Nano Banana 2.1 & Maps Imagery Grounding (MIG) deep dive
- [references/vertex_vs_aistudio.md](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-genai-models/references/vertex_vs_aistudio.md) - Deep dive on auth, quotas, and endpoints
- [references/prompt_templates.md](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-genai-models/references/prompt_templates.md) - Specialized prompt engineering templates for 3D, VFX, and code
- [scripts/google_genai_hub.mjs](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-genai-models/scripts/google_genai_hub.mjs) - Unified CLI and programmatic runner
- [scripts/test_model_access.mjs](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-genai-models/scripts/test_model_access.mjs) - Diagnostic connectivity & privileges checker


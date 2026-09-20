---
name: two-tier-problem-solving
description: >-
  Evaluate user requests against Scratchbox IDE native app capabilities (Tier 1: C++20 Astra 3D Engine,
  Three.js, Video Timeline NLE, UTDRA, NOAA Solar Ephemeris, Google Maps 3D Tiles) and seamlessly fall back
  to the ComfyUI autonomous pipeline (Tier 2: Google Cloud Run NVIDIA L4 GPU / local) for neural generation
  (Trellis, TripoSR, AnimateDiff, Marigold, specialized LoRAs). Enforces zero closed classifiers, transactional failover,
  and bidirectional 3D state synchronization.
---

# Two-Tier Problem-Solving Directive & ComfyUI Autonomous Fallback

The **Two-Tier Problem-Solving Directive** establishes the architectural principle of Scratchbox IDE: **Native App Capabilities First $\rightarrow$ ComfyUI Service Fallback**.

---

## 1. System Architecture

```
                       [User Prompt / Goal]
                                │
                                ▼
                   [TaskCapabilityResolver]
                 (`resolve_task_capability`)
                                │
          ┌─────────────────────┴─────────────────────┐
          ▼                                           ▼
[Tier 1: Native App Capabilities]         [Tier 2: ComfyUI Service]
- C++20 Astra Engine (SDF, SIMD, GLB)     - Neural Mesh (Trellis, TripoSR)
- Google Photorealistic 3D Tiles          - Video Restyling (Omni, AnimateDiff)
- Video Timeline NLE & Matchmove          - Dense Depth (Marigold)
- UTDRA / ULDRA Mesh Rectification        - Custom Checkpoints & LoRAs
- NOAA Ephemeris & Atmospheric Skies      - Google Cloud Run NVIDIA L4 GPU
          │                                           ▲
          │ (Unexpected runtime error,                │
          │  missing driver, or GPU fault)            │
          └─────────────────── Fallback ──────────────┘
                                │
                                ▼
                  [TwoTierExecutionResult<T>]
        { tier: 'tier1-native' | 'tier2-comfyui', success: true }
                                │
                                ▼
              [Stage Mount & Scene3DWorldLens Sync]
```

---

## 2. Decision Matrix: Tier 1 vs Tier 2

| Feature / Task Type | Primary Tier | Implementation Route |
| :--- | :--- | :--- |
| **Real-World Locations** | **Tier 1 (Native)** | `getGoogle3DTilesFullTexture` / `getGoogle3DTilesClay` |
| **Procedural 3D Geometry** | **Tier 1 (Native)** | C++20 Astra Engine (`#include "scratchbox_engine.hpp"`), SIMD math, Marching Cubes SDF |
| **Parametric Mesh Reshaping** | **Tier 1 (Native)** | `mesh_reshape_via_prompt` / `NativeMeshReshaperService` (Bernstein FFD, Taper, Bend, Twist) |
| **Photogrammetry Rectification** | **Tier 1 (Native)** | `utdra_probe_tile` / `UniversalTileDecompositionService` (Shafts, crowns, bridge voids) |
| **Camera Matchmove & Tracking** | **Tier 1 (Native)** | `VfxPlateMatchmoveService` / `interpolateCameraSolve` |
| **Solar & Atmospheric Lighting** | **Tier 1 (Native)** | `AtmosphereService` (NOAA geodetic ephemeris, Rayleigh/Mie scattering, Worley clouds) |
| **Neural Image-to-3D** | **Tier 2 (ComfyUI)** | ComfyUI with Trellis / TripoSR / SV3D |
| **Neural Video Restyling** | **Tier 2 (ComfyUI)** | ComfyUI with AnimateDiff / Omni / ControlNet |
| **Monocular Dense Depth** | **Tier 2 (ComfyUI)** | ComfyUI with Marigold / Depth-Anything-v2 |
| **Custom LoRA / Diffusion** | **Tier 2 (ComfyUI)** | ComfyUI custom workflow + dynamic node injection |

---

## 3. Canonical Programmatic APIs

### `ComfyUiPipelineAgent.executeWithTwoTierFallback<T>`

```typescript
import {
  ComfyUiPipelineAgent,
  type TwoTierExecutionResult
} from '@scratchbox/core/node';

const agent = new ComfyUiPipelineAgent(bridge, cloudRun);

const executionResult: TwoTierExecutionResult<My3DOutput> =
  await agent.executeWithTwoTierFallback(
    prompt,
    async () => {
      // Tier 1: Attempt native C++20 / Three.js / Google 3D Tiles execution
      return await executeNative3DPipeline(prompt);
    },
    async (fallbackReason) => {
      // Tier 2: Spin up ComfyUI autonomous workflow (local or Cloud Run L4)
      return await executeComfyUiWorkflow(prompt, fallbackReason);
    }
  );

if (executionResult.tier === 'tier2-comfyui') {
  console.log('Fell back to Tier 2 ComfyUI:', executionResult.attempts);
}
```

### In-App Gemini Agent Tool: `resolve_task_capability`

```json
{
  "name": "resolve_task_capability",
  "description": "Evaluates whether a user's prompt or VFX/3D task can be natively fulfilled using Scratchbox Tier 1 capabilities, or requires Tier 2 ComfyUI autonomous pipeline.",
  "parameters": {
    "type": "OBJECT",
    "properties": {
      "userGoal": {
        "type": "STRING",
        "description": "The user's high-level goal or instruction"
      },
      "promptContext": {
        "type": "STRING",
        "description": "Optional additional technical or domain context"
      }
    },
    "required": ["userGoal"]
  }
}
```

---

## 4. 3D State Trilemma & Fallback Metadata

When a 3D scene or mesh falls back from C++20 generation to Tier 2 ComfyUI:
1. **Preserve Fallback Metadata**:
   ```json
   {
     "fallbackTier2ComfyUi": {
       "active": true,
       "reason": "Task requires neural diffusion image-to-3D not feasible in native engine",
       "prompt": "Cyberpunk robotic hovercraft",
       "modelArchitecture": "trellis-l4",
       "timestamp": 1789858000000
     }
   }
   ```
2. **Link Binary GLB**: Set `data.cppGenerator.glbPath` to the synthesized output asset.
3. **Preserve C++ Blueprint**: Keep `data.cppGenerator.sourceCode` intact for inspection, auditability, and hybrid composition.
4. **Synchronize via Lens**: `Scene3DWorldLens` projects both the `.scene.json` and the `.cpp` file cleanly without data loss.

---

## 5. Architectural Invariants

1. **Zero Closed Classifiers**:
   - Never introduce `switch(domain)` or regex keyword matching on strings like `"space"`, `"biology"`, or `"robot"`.
   - The LLM's latent semantic space performs capability matching against structural feature contracts.
2. **Transparent Observability**:
   - When failing over, log clear status badges (`⚡ Tier 1 -> Tier 2 Failover: Spinning up Cloud Run ComfyUI L4 GPU`) to ensure the user understands which pipeline generated their asset.

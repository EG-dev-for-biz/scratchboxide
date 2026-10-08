---
name: local-sf3d-organic-director
description: >-
  Generate, extract, and ground small organic 3D objects, props, and biomorphic forms (coral, rocks, fruit,
  mushrooms, seashells, bones, figurines, ornaments) using local Stable Fast 3D (SF3D) in no_pbr mode. Executes locally
  on Apple Silicon (MPS) or desktop GPU in < 500ms with metric scale grounding, 18% Studio Grey Clay baseline,
  and flat ground contact planes.
---

# Local SF3D Organic Prop Director Skill

The **Local SF3D Organic Prop Director Skill** equips AI agents to synthesize small organic objects, biomorphic props, and sculpted assets directly from single 2D photos or concept images using local Stable Fast 3D (SF3D). 

By enforcing a dedicated **`no_pbr` mode**, the pipeline bypasses slow UV island parameterization and neural texture rasterization, dropping execution latency from over 1.2s to **under 450ms**, generating clean **18% Studio Grey Clay** geometry that integrates seamlessly into Scratchbox procedural scenes.

---

## 1. System Architecture

```
                 [2D Input Image]
                        │
                        ▼
       [Local SF3D Organic Director (Node.js)]
              (LocalSf3DService)
                        │
                        ▼
       [Local Python SF3D Engine Runner]
     (packages/core/src/python/scratchbox/sf3d/run_local_sf3d.py)
                        │
    ┌───────────────────┴───────────────────┐
    ▼                                       ▼
[Apple Silicon (Metal/MPS)]             [NVIDIA CUDA / CPU]
    │                                       │
    └───────────────────┬───────────────────┘
                        ▼
           [Feed-Forward Triplane LRM]
                        │
                        ▼
         [Marching Tetrahedra (DMTet)]
      (Extracts Explicit 3D Triangle Soup)
                        │
      ┌─────────────────┴─────────────────┐
      │  no_pbr Mode (Default Baseline)   │
      │  BYPASS UVs & Texture Baking!     │
      └─────────────────┬─────────────────┘
                        ▼
     [Metric Rescaler & Contact Plane Snap]
     - Scale major axis to targetScaleMeters (e.g. 0.35m)
     - Align base at Y=0 (groundCut contact plane)
     - Center X/Z at origin
                        │
                        ▼
    [Standard Binary glTF 2.0 (.glb) Output]
    - Magic header: 0x46546C67 ("glTF")
    - 18% Studio Grey Clay PBR Material
      (baseColor: [0.55, 0.57, 0.60], roughness: 0.85)
    - Execution time: < 450ms
                        │
                        ▼
          [Mount into 3d-scene Stage]
```

---

## 2. Why `no_pbr` is the Architectural Baseline

When generating props for procedural scenes:
1. **60% Latency Reduction**: In neural reconstruction, computing UV layouts (via `xatlas`) and differentiable texture rasterization account for the majority of execution time. Skipping them drops inference latency to **~350–450ms**.
2. **Scratchbox Clay Invariant**: Untextured grey clay matches Scratchbox's mandatory **18% Studio Grey Clay Baseline**, preventing baked lighting artifacts, noisy photogrammetry seams, and blurry neural projections.
3. **Decoupled PBR Materials**: After geometry extraction, Scratchbox's native C++ PBR engine ([`adaptive-material-pbr-service.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/3d-engine/adaptive-material-pbr-service.ts), [`scratchbox_pbr.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_pbr.hpp)) can compute analytical curvature, cavity ambient occlusion, and sun-ephemeris lighting on top of the clean mesh.

---

## 3. Dedicated In-App Agent Tool

### `generate_local_sf3d_organic_prop`

Agents can invoke local SF3D directly via Gemini Function Calling:

```json
{
  "name": "generate_local_sf3d_organic_prop",
  "args": {
    "imagePath": "assets/props/chanterelle_mushroom.png",
    "outputGlbPath": "public/models/props/chanterelle_prop.glb",
    "noPbr": true,
    "targetScaleMeters": 0.25,
    "groundCut": true,
    "remeshOption": "none",
    "promptHint": "chanterelle mushroom with organic gills"
  }
}
```

### Parameter Reference

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `imagePath` | `string` | **Required** | Local filesystem path to the input photograph or 2D image. |
| `outputGlbPath` | `string` | *Auto* | Optional destination file path for the binary `.glb`. |
| `noPbr` | `boolean` | `true` | Bypasses UV unwrapping and neural texture baking for 18% Studio Grey Clay in $< 500\text{ms}$. |
| `targetScaleMeters` | `number` | `0.35` | Major bounding axis scale in meters (e.g. 0.15m for a seashell, 0.40m for a coral head). |
| `groundCut` | `boolean` | `true` | Snaps base vertices to $Y=0$, creating a perfectly flat contact plane for physical staging. |
| `remeshOption` | `string` | `'none'` | `'none'` (fastest raw geometry), `'triangle'` (Botsch isotropic), or `'quad'` (4-RoSy Instant Field-Aligned quads). |
| `device` | `string` | `'auto'` | Target device: `'auto'` (MPS on Apple Silicon, CUDA on NVIDIA), `'mps'`, `'cuda'`, or `'cpu'`. |
| `promptHint` | `string` | `undefined`| Semantic label or physical hint for cataloging and telemetry. |

---

## 4. Programmatic TypeScript API

```typescript
import { LocalSf3DService } from '@scratchbox/core';

const sf3dService = LocalSf3DService.getInstance();

const result = await sf3dService.generateOrganicProp({
    imagePath: '/path/to/reference_rock.png',
    noPbr: true,
    targetScaleMeters: 0.30,
    groundCut: true
});

console.log(`Generated ${result.mode} GLB in ${result.executionTimeMs}ms at ${result.glbPath}`);
console.log(`Bounding Box dimensions: ${result.overallBoundingBox.dimensions.join(' x ')}m`);
```

---

## 5. Direct CLI Execution

The underlying Python script can also be executed directly from the terminal or sub-processes:

```bash
python3 packages/core/src/python/scratchbox/sf3d/run_local_sf3d.py \
    input_prop.png \
    output_prop.glb \
    --no_pbr \
    --target_scale_meters=0.35 \
    --ground_cut \
    --device=auto
```

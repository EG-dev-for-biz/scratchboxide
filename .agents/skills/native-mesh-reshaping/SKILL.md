---
name: native-mesh-reshaping
description: >-
  Reshape and deform 3D meshes via natural language prompts or explicit parametric operators using the native
  C++20 Astro 3D engine (scratchbox_shaper.hpp) and NativeMeshReshaperService. Applies non-linear deformers
  (taper, twist, bend, bulge, squash, shear), Bernstein FFD tensor lattices, sculpt brushes, loop subdivision,
  and manifold topology healing with zero external dependencies and sub-millisecond execution.
---

# Native Prompt-Driven Mesh Reshaping Skill

The **Native Prompt-Driven Mesh Reshaping Skill** equips AI agents to translate natural language styling instructions (e.g., *"taper the top by 50%, add a 45 degree twist, bulge the middle, and sculpt fine creases"*) into high-performance C++20 geometric deformation operations executed directly on 3D meshes.

---

## 1. System Architecture

```
[User Prompt or Parametric Ops]
                 │
                 ▼
    [Prompt Parser & Schema]
  (Deform, Taper, Twist, Bend, Bulge,
   Lattice, Sculpt, Subdivide)
                 │
                 ▼
  [NativeMeshReshaperService (Node.js)]
                 │
                 ▼
[Native C++20 Pipeline Runner (Apple Clang)]
 (scripts/run_mesh_reshaping_pipeline.cpp)
                 │
   ┌─────────────┼─────────────┬─────────────┐
   ▼             ▼             ▼             ▼
[Deformer]  [Lattice3D]  [SculptEngine] [Loop Subdiv]
(Taper,      (Bernstein   (Clay, Crease, (Topology
 Twist, Bend, 3D Tensor   Smooth, Flat,   Cleaner &
 Bulge, Shear) FFD)       Inflate)        Re-normal)
   └─────────────┼─────────────┴─────────────┘
                 │
                 ▼
   [Standard Binary glTF 2.0 (.glb) Output]
   - Magic header: 0x46546C67 ("glTF")
   - Updated vertex coordinates & normals
   - Exact execution telemetry (< 1ms execution time)
                 │
                 ▼
   [Mount to Three.js Canvas Stage]
```

---

## 2. Supported Deformation Operations

All operations conform to the `MeshDeformOperation` contract:

| Operation Type | Key Parameters | Description |
| :--- | :--- | :--- |
| **`taper`** | `factor` (0.0–2.0), `axis` ('x'\|'y'\|'z') | Scales cross-section along the selected axis. Values $< 1.0$ narrow towards the top; $> 1.0$ expand. |
| **`twist`** | `angle` (degrees), `axis` ('x'\|'y'\|'z') | Progressively rotates vertices about the central axis. |
| **`bend`** | `angle` (degrees), `axis` ('x'\|'y'\|'z') | Curvatures mesh geometry along a circular arc. |
| **`bulge`** | `factor` (e.g. 0.4), `axis` ('x'\|'y'\|'z') | Parabolic middle expansion / waist pinching. |
| **`squash`** | `factor` (e.g. 0.7), `axis` ('x'\|'y'\|'z') | Compresses primary axis while volume-preserving orthogonal axes expand. |
| **`shear`** | `amount` (e.g. 0.3), `axis` ('x'\|'y'\|'z') | Skews cross-sections relative to axis elevation. |
| **`sculpt`** | `brush` ('clay'\|'crease'\|'smooth'\|'flatten'\|'inflate'), `strength`, `radius`, `center` | Applies local spherical brush deformation with smooth falloff. |
| **`lattice`** | `controlPoints` ($3 \times 3 \times 3$), `resolution` | Trivariate Bernstein polynomial Free-Form Deformation (FFD). |
| **`subdivide`**| `iterations` (1–2) | Loop subdivision smoothing and resolution refinement. |
| **`weather`** | `roughness`, `erosionAmount` | Procedural weathering, micro-relief, and edge erosion. |

---

## 3. Dedicated In-App Agent Tools

Agents can reshape meshes directly using these two tools via Gemini Function Calling:

### 1. `mesh_reshape_via_prompt`
Parses a natural language instruction and executes deformation on input GLB mesh or benchmark geometry:
```json
{
  "name": "mesh_reshape_via_prompt",
  "args": {
    "prompt": "Taper the top by 50% and twist 60 degrees around the Y axis, then bulge the waist",
    "inputGlbPath": "public/models/base_sculpture.glb",
    "outputGlbPath": "public/models/base_sculpture_reshaped.glb"
  }
}
```

### 2. `mesh_apply_deformers`
Applies an explicit array of structured deformation operations:
```json
{
  "name": "mesh_apply_deformers",
  "args": {
    "benchmark": "cylinder",
    "operations": [
      { "type": "taper", "factor": 0.4, "axis": "y" },
      { "type": "twist", "angle": 45.0, "axis": "y" },
      { "type": "bulge", "factor": 0.3, "axis": "y" }
    ],
    "outputGlbPath": "public/models/twisted_cylinder.glb"
  }
}
```

---

## 4. TypeScript Codebase APIs

In Node.js services, background tasks, or server routes, developers can use either the standalone functional API or `NativeMeshReshaperService` (aliased as `MeshReshapingService`):

```typescript
import {
  reshapeMesh,
  parsePromptToMeshOperations,
  NativeMeshReshaperService,
  MeshReshapingService
} from '@scratchbox/core'; // also available from '@scratchbox/core/node'

// Option A: Standalone functional API
const result = await reshapeMesh({
  prompt: 'Taper the top to a spire and twist 90 degrees',
  inputGlbPath: 'public/models/tower.glb',
  outputGlbPath: 'public/models/tower_twisted.glb'
});

// Option B: Parse prompt into inspectable AST before execution
const operations = parsePromptToMeshOperations('Bulge the center by 0.4 and twist 30 deg');
const parametricResult = await reshapeMesh({
  inputGlbPath: 'public/models/vase.glb',
  operations
});

// Option C: Class facade / instance
const service = NativeMeshReshaperService.getDefault();
const classResult = await service.reshapeMesh({ benchmark: 'cylinder', prompt: 'taper top' });

console.log(result.telemetry);
// {
//   executionTimeMs: 0.11,
//   inputVertexCount: 1024,
//   outputVertexCount: 1024,
//   operationsApplied: 2,
//   ...
// }
```

---

## 5. Canvas Direct-Dispatch Operator

In the Three.js viewport / browser client, trigger interactive deformations in-memory with zero network overhead:

```typescript
operatorEngine.dispatch('sb_reshape_mesh', {
  objectId: 'mesh-123',
  prompt: 'Taper top and twist 45 degrees'
});
```

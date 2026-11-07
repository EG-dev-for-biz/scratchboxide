---
name: native-mesh-reshaping
description: >-
  Deform a given 3D mesh (.glb) with explicit operations in the native C++20 engine (scratchbox_shaper.hpp)
  through mesh_apply_deformers / NativeMeshReshaperService: taper, twist, bend, shear, bulge, Bernstein FFD
  lattices, sculpt brushes, Kelvinlet elastic loads, loop subdivision, repair and weathering. Every value is chosen by the agent and is
  relative to the mesh's measured bounding box; nothing is read from prose or applied by default.
---

# Native Mesh Reshaping Skill

The agent turns a request such as *"taper the top by half and twist the upper third 45 degrees"* into explicit
operations itself (the LLM is the domain engine) and runs them on a mesh that exists on disk. There is no prompt
parser in the engine: an operation without its values, an unknown operation type, a missing mesh or an empty list
fails with the reason.

---

## 1. System Architecture

```
[Agent: explicit operations, values relative to the mesh bounds]
                 │
                 ▼
  [mesh_apply_deformers / NativeMeshReshaperService (Node.js)]
                 │   (rebuilds the binary when its source changed)
                 ▼
[Native C++20 runner: scripts/run_mesh_reshaping_pipeline.cpp]
  --input <mesh.glb> (required)  --operationsFile <ops.json> (required)
                 │
   ┌─────────────┼─────────────┬─────────────┐
   ▼             ▼             ▼             ▼
[Deformer]  [Lattice3D]  [SculptEngine] [Loop Subdiv]
                 │
                 ▼
   [Binary glTF 2.0 (.glb) + [TELEMETRY] line with the measured input bounds]
```

---

## 2. Operations

Positions and sizes are fractions of the mesh's axis-aligned bounding box as it stands before each operation, so an
operation means the same on a 4 cm prop and a 60 m tower:

- `range: [start, end]` — fractions of the extent along `axis` (0 = min, 1 = max), `0 <= start < end <= 1`.
- `center: [u, v, w]` — fractions of the box along X, Y, Z.
- `radius`, `strength` — fractions of the box diagonal (`strength` is a 0..1 blend for the smooth and flatten brushes).

| Type | Required parameters | Effect |
| :--- | :--- | :--- |
| `taper` | `axis`, `factor` (> 0), `range`; optional `power` (default 1) | Scales cross-sections about the box's centre line, reaching `factor` at the range end. |
| `twist` | `axis`, `angleDeg`, `range` | Rotates cross-sections about the box's centre line, `angleDeg` in total across the range. |
| `bend` | `axis` (length direction), `secondaryAxis`, `angleDeg` | Arc-length preserving bend of the whole extent; the min end stays fixed. |
| `shear` | `axis`, `secondaryAxis`, `factor` | The far end moves `factor` x the extent along `axis`; the min end stays fixed. |
| `bulge` | `center`, `radius`, `strength`; optional `power` (default 2) | Radial push (negative `strength` pinches). |
| `sculpt` | `sculptBrush`, `center`, `radius`, `strength`; `direction` for clay, flatten | Local brush stroke (clay, inflate, flatten, crease, smooth). A local grab or pinch is `kelvinlet`. |
| `lattice` | `latticeDimensions` (2..8 each), `latticeOffsets` `[{ i, j, k, offset: [dx, dy, dz] }]` | Bernstein FFD; offsets are fractions of the box size per axis. |
| `kelvinlet` | `center`, `radius` (the load's core width), and one or more of `displacement` `[dx, dy, dz]`, `twistDeg` + `twistAxis`, `scaleFactor`, `pinchStrength` + `pinchDirection` (`pinchSecondaryDirection` for planar); optional `poissonRatio` (default 0.5), `falloffScales` (1..3, default 1), `falloffRatio` (default 1.5), `steps` | Elastic response to a point load: no falloff edge, the load point does exactly what is asked (moves by `displacement`, turns by `twistDeg`, scales by `scaleFactor`), and at `poissonRatio` 0.5 volume is kept, so a grab bulges the sides like clay. More `falloffScales` confine it closer to the load point. `scaleFactor` is refused at 0.5 (an incompressible medium cannot change volume). |
| `subdivide` | `subdivideIterations` (1..3) | Loop subdivision. |
| `repair` | — | Removes degenerate faces. |
| `weathering` | `weatheringIntensity`, `weatheringScale` (noise cycles across the mesh) | Vertex colour variation. |

---

## 3. Agent Tool: `mesh_apply_deformers`

```json
{
  "name": "mesh_apply_deformers",
  "args": {
    "inputGlbPath": "public/models/tower.glb",
    "operations": [
      { "type": "taper", "axis": "Y", "factor": 0.5, "range": [0, 1] },
      { "type": "twist", "axis": "Y", "angleDeg": 45, "range": [0.66, 1] }
    ],
    "outputGlbPath": "public/models/tower_twisted.glb"
  }
}
```

The summary reports the measured input bounds the operations were read against. There is no
`mesh_reshape_via_prompt`, and the tile restructure tools (closed style and primitive taxonomy, keyword prompt parser)
are removed; for new geometry, build it procedurally instead.

---

## 4. TypeScript API

```typescript
import { reshapeMesh, NativeMeshReshaperService } from '@scratchbox/core/node';

const result = await reshapeMesh({
  inputGlbPath: 'public/models/vase.glb',
  operations: [{ type: 'bulge', center: [0.5, 0.5, 0.5], radius: 0.3, strength: 0.05 }]
});
console.log(result.telemetry.inputBoundsMin, result.telemetry.inputBoundsMax, result.telemetry.outputVertices);
```

`reshapeMesh` throws `MissingInputError` for a missing mesh, an empty list or an invalid operation, and
`GeneratorFailedError` when the native run fails or reports no telemetry or no output.

---

## 5. Canvas Direct-Dispatch Operator

`sb_reshape_mesh` deforms a viewport mesh in memory along its vertical extent, with explicit operations only:

```typescript
operatorEngine.dispatch('sb_reshape_mesh', {
  objectId: 'mesh-123',
  operations: [{ type: 'taper', factor: 0.5 }, { type: 'twist', angle: 45 }]
});
```

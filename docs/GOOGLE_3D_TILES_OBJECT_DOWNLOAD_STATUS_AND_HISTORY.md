# Google Photorealistic 3D Tiles 3D Object Download APIs: Specification, Quality Guarantees & Engineering History

This document serves as the canonical technical reference, mathematical formulation, evolutionary history, and automated test suite status for the **Google Maps Photorealistic 3D Tiles 3D Object Ingestion & Download APIs** ([`getGoogle3DTilesFullTexture`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Google3DTileBlockoutPipelineService.ts#L2023) and [`getGoogle3DTilesClay`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Google3DTileBlockoutPipelineService.ts#L2048)), the underlying pipeline service ([`Google3DTileBlockoutPipelineService`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Google3DTileBlockoutPipelineService.ts)), and their in-app Gemini agent tools (`google_3d_tiles_get_full_texture` and `google_3d_tiles_get_clay`) in Scratchbox IDE.

---

## 1. Executive Summary & Current Test Status

| Metric | Status / Value | Verification Source |
| :--- | :--- | :--- |
| **Pipeline Test Suite** | [`packages/core/test/google-3d-tiles-blockout-pipeline.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/google-3d-tiles-blockout-pipeline.test.ts) | Vitest v2.1.9 (11/11 tests passing) |
| **Agent Tools Test Suite** | [`packages/core/test/google-3d-tiles-agent-tools.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/google-3d-tiles-agent-tools.test.ts) | Vitest v2.1.9 (4/4 tests passing) |
| **Monorepo Typecheck** | **0 Errors** across `@scratchbox/core` | `npm run build --workspace=@scratchbox/core` (`tsc`) |
| **Geometric Refinement Budget** | Deepest Leaf LOD: $\text{errorTarget} \le 0.5$ | `3d-tiles-renderer` Octree Traversal |
| **Screen-Space Error Resolution** | Virtual 4K UHD: $3840 \times 2160$ | `tiles.setResolution(cam, 3840, 2160)` |
| **Corridor Perimeter Coverage** | $360^\circ$ Multi-Camera Array + Nadir Contextual Camera | `exportCameras` (16 orbital + 1 overhead) |
| **Asynchronous Settle Threshold** | Multi-frame queue drain (`downloading === 0 && parsing === 0`) | `stableFramesThreshold: 15`, `maxSettleWaitMs: 25000` |
| **Mesh Output Standard** | Standard Binary glTF 2.0 (`.glb`) with baked ENU transforms | `GLTFExporter({ binary: true })` |
| **Domain Architecture** | **Strict Zero Presets & Zero Procedural Fallback** | `AGENTS.md` Directives |

---

## 2. Chronological Engineering History

The Google 3D Tiles 3D object extraction architecture progressed through four major generations:

```
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 1: Trajectory Planning & Clay Blockout Video Synthesis      │
│ • Geodetic WGS-84 to Local Tangent Plane (ENU) conversion              │
│ • 6-DoF Catmull-Rom spline camera flight corridors (72 frames @ 24fps) │
│ • Headless Chrome canvas rasterization for Vertex AI Omni 1.1 conditioning│
│ • Basic single-camera frustum mesh extraction                          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 2: Dual Dedicated APIs & Zero-Preset Ingestion              │
│ • User Directive: Strict separation between Textured & Clay workflows │
│ • getGoogle3DTilesFullTexture: Authentic photogrammetric PBR albedo   │
│ • getGoogle3DTilesClay: Studio grey clay (#dcd6cd, rough 0.82)         │
│ • Zero Presets & No Fallback: Explicit geocoding / API key mandatory   │
│ • Dynamic ephemeral port binding (server.listen(0)) & runner isolation │
│ • Fast binary glTF chunk-0 JSON parser for vertex/triangle statistics  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 3: Settle Synchronization & 360° Multi-Frustum Synthesis    │
│ • Quality Audit: Identified settle timeout disparity (6s vs 25s)       │
│ • Synchronized default maxSettleWaitMs = 25000 across all APIs         │
│ • Identified single-frame camera frustum culling gap at extraction    │
│ • 3d-tiles-renderer multi-camera integration (tiles.setCamera)        │
│ • 16-Waypoint orbital array + overhead nadir camera pre-settle pass    │
│ • Complete 360° perimeter leaf octree unification without duplicate meshes│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 4: In-App Agent Availability & Semantic Task Resolution     │
│ • User Directive: Make APIs available and understandable by app agent │
│ • ToolRegistry function declarations: google_3d_tiles_get_full_texture │
│   and google_3d_tiles_get_clay registered in 'workspace' group         │
│ • TaskCapabilityResolver: Tier 1 Native 3D Engine routing directive    │
│ • Grounding Agent Skill: .agents/skills/google-3d-tiles-ingestion/    │
│ • Invariant Codification: AGENTS.md "Dual Dedicated 3D Object APIs"   │
│ • Canvas Primitive Mounting: Direct mount to 3d-scene viewport        │
└────────────────────────────────────────────────────────────────────────┘
```

### Generation 1: Trajectory Planning & Clay Blockout Video Synthesis
* **Original Context**: Initial development centered on rendering intermediate blockout videos (`<VIDEO_REF_0>`) as spatial motion conditioning for Vertex AI Omni 1.1 neural video generation.
* **Architecture**: Implemented geodetic WGS-84 ellipsoid conversion to East-North-Up (ENU) coordinates centered on the user's target landmark anchor. Headless Chrome loaded a Three.js runner incorporating `3d-tiles-renderer` and `GoogleCloudAuthPlugin`. Camera paths followed smooth parabolic arcs clearing skyscraper rooftops.
* **Limitations**: Mesh extraction occurred solely from the perspective of the final video frame. Facades facing away from the camera corridor were frustum-culled, leaving hollow shells and perimeter voids in the exported mesh.

### Generation 2: Dual Dedicated APIs & Zero-Preset Architecture
* **User Directives**:
  1. *Dual Dedicated Separate APIs*: Provide two separate, explicitly named APIs:
     - `getGoogle3DTilesFullTexture(queryOrCoords, options)` for full photogrammetric textures.
     - `getGoogle3DTilesClay(queryOrCoords, options)` for studio grey clay massing.
  2. *Strict Zero Presets & Zero Procedural Fallback*: Eliminate static landmark dictionaries and coordinate hashes. If a query lacks coordinates or an active API key, the pipeline must reject with an actionable error.
* **Innovations**:
  - Auto-discovered Chrome and FFmpeg binaries across macOS and Linux standard paths.
  - Replaced hardcoded ports with ephemeral dynamic binding (`server.listen(0) -> actualPort`) to support concurrent execution.
  - Implemented fast binary glTF chunk-0 JSON parsing to report exact geometric metrics (`vertexCount`, `triangleCount`, `submeshCount`) directly from the binary `.glb` header without external dependencies.

### Generation 3: Settle Timeout Synchronization & 360° Multi-Frustum Synthesis
* **Problem 1 (Default Settle Timeout Disparity)**: An architectural audit revealed that while `TileLodQualityConfig` specified `maxSettleWaitMs: 25000` (and `generateRunnerHtml` used 25 seconds for video rendering), the `fetch3DObject` wrapper defaulted to `6000` ms. Under congested network conditions or high-density urban environments, 6 seconds could cause the settle loop to time out prematurely before the deepest leaf octree nodes finished streaming.
* **Fix 1**: Aligned `fetch3DObject`'s default `maxSettleWaitMs` to `25000` ms, fully forwarded all `lodQuality` parameters, and exposed `maxSettleWaitMs` in `Google3DTileQualityReport`.
* **Problem 2 (Frustum Coverage at Mesh Extraction)**: In `generateRunnerHtml`, after rendering the camera flight, the exporter traversed `tiles.group` while the renderer was focused only on the final camera frame. Tiles outside the final frame's field of view were unmounted or culled.
* **Fix 2**: Deep-dived `3d-tiles-renderer` internals and discovered that `TilesRenderer` natively supports multi-camera evaluation via `tiles.setCamera(cam)`. Before extracting the mesh:
  1. An orbital array of up to 16 perspective cameras is generated along the flight path, facing the landmark centroid.
  2. A high-angle overhead camera ($65^\circ$ FOV, nadir look-at) is registered to capture rooftops and footprint courtyards.
  3. All cameras are assigned 4K SSE resolution ($3840 \times 2160$).
  4. A multi-camera convergence loop updates `tiles.update()` until all octree queues drain.
  5. The resulting `tiles.group` contains all active leaf tiles spanning the full $360^\circ$ perimeter.
  6. Mesh extraction deduplicates submeshes via a `Set` of node UUIDs, bakes world transforms via `geom.applyMatrix4(node.matrixWorld)`, and exports the unified object via `GLTFExporter({ binary: true })`.
  7. Temporary export cameras are unmounted and the primary viewport camera is cleanly restored.

### Generation 4: In-App Gemini Agent Availability & Semantic Task Resolution
* **User Directive**: *"how do we make these APIs avialable and understanble by the agent of the app?"*
* **The Challenge**: While the TypeScript APIs existed in `@scratchbox/core/node`, the Scratchbox IDE Gemini in-app reasoning agent had no semantic knowledge of their existence, no tool calling schema to invoke them, and would fall back to guessing or invoking Tier 2 ComfyUI 2D-to-3D diffusion pipelines when prompted with real-world 3D queries.
* **The Solution (4-Pillar Integration)**:
  1. *Tool Registry Schema Declarations & Dispatch*: Registered `google_3d_tiles_get_full_texture` and `google_3d_tiles_get_clay` with typed JSON schemas under the `'workspace'` tool group in [`packages/core/src/node/gemini/tool-registry.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tool-registry.ts). Tool execution dispatches the query, writes the binary `.glb`, and formats human-friendly card summaries.
  2. *Semantic Capability Resolution*: Augmented [`packages/core/src/node/agent/task-capability-resolver.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/agent/task-capability-resolver.ts) so that user queries involving real-world geographic coordinates, addresses, or landmarks are classified under Domain `'3d'` as **Tier 1 Native Capabilities** (`cpp-3d-engine`), explicitly instructing the agent to call `getGoogle3DTilesFullTexture` or `getGoogle3DTilesClay`.
  3. *Agent Skill & Directives Codification*: Authored [`.agents/skills/google-3d-tiles-ingestion/SKILL.md`](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-3d-tiles-ingestion/SKILL.md) and codified `Rule: Dual Dedicated 3D Object APIs & Zero Presets` in [`AGENTS.md`](file:///Users/eligreen/dev/scratchbox-ide-master/AGENTS.md).
  4. *Canvas Primitive Mounting*: The agent mounts the output `.glb` directly into the interactive Three.js viewport via `mount_canvas_primitive` (`3d-scene`).

---

## 3. Mathematical Foundations & LOD Telemetry

### 1. Geodetic WGS-84 to Local Tangent Plane (ENU) Projection
Given a target anchor geodetic latitude $\phi_0$, longitude $\lambda_0$, and ellipsoid height $h_0$, the WGS-84 reference ellipsoid parameters are:
$$a = 6378137.0\text{ m (semi-major axis)}, \quad f = \frac{1}{298.257223563}, \quad e^2 = 2f - f^2$$

The prime vertical radius of curvature $N(\phi)$ is:
$$N(\phi) = \frac{a}{\sqrt{1 - e^2 \sin^2\phi}}$$

Any point $(\phi, \lambda, h)$ converts to Earth-Centered, Earth-Fixed (ECEF) coordinates:
$$\mathbf{P}_{\text{ECEF}} = \begin{bmatrix} (N(\phi) + h)\cos\phi\cos\lambda \\ (N(\phi) + h)\cos\phi\sin\lambda \\ (N(\phi)(1 - e^2) + h)\sin\phi \end{bmatrix}$$

Transforming from ECEF to the Local Tangent Plane (ENU Cartesian frame) centered at $\mathbf{P}_0$:
$$\begin{bmatrix} X_{\text{East}} \\ Y_{\text{North}} \\ Z_{\text{Up}} \end{bmatrix} = \begin{bmatrix} -\sin\lambda_0 & \cos\lambda_0 & 0 \\ -\sin\phi_0\cos\lambda_0 & -\sin\phi_0\sin\lambda_0 & \cos\phi_0 \\ \cos\phi_0\cos\lambda_0 & \cos\phi_0\sin\lambda_0 & \sin\phi_0 \end{bmatrix} \left(\mathbf{P}_{\text{ECEF}} - \mathbf{P}_{0, \text{ECEF}}\right)$$

In Three.js coordinate space, $+X = \text{East}$, $+Y = \text{Up}$, and $-Z = \text{North}$.

### 2. Screen-Space Error (SSE) & Deepest Leaf LOD Refinement
The Screen-Space Error metric determines whether an octree tile node is sufficiently refined or must subdivide into children:
$$\text{SSE} = \frac{\text{geometricError} \cdot H}{2 \cdot d \cdot \tan\left(\frac{\text{FOV}}{2}\right)}$$

Where:
- $\text{geometricError}$ is the tile's bounding volume geometric error in meters.
- $H$ is the viewport resolution height (set to $2160$ for 4K SSE calculation).
- $d$ is the distance from the camera optical center to the tile bounding volume.
- $\text{FOV}$ is the camera vertical field of view.

When $\text{SSE} > \text{errorTarget}$, `3d-tiles-renderer` subdivides the node and fetches child tiles. By specifying $\text{errorTarget} = 0.5$ against $H = 2160$, the pipeline enforces sub-pixel geometric precision, ensuring leaf tiles load at the highest resolution available from the Google Photorealistic 3D Tiles API.

### 3. Multi-Camera Frustum Intersection & Perimeter Refinement
When multiple cameras $\mathbf{C}_1, \dots, \mathbf{C}_K$ are registered on the `TilesRenderer` instance:
$$\text{inView}(\text{tile}) = \bigvee_{i=1}^{K} \left(\text{tile.boundingVolume} \cap \text{Frustum}(\mathbf{C}_i) \neq \emptyset\right)$$

$$\text{inViewError}(\text{tile}) = \max_{i=1}^{K} \left( \frac{\text{geometricError} \cdot H_i}{2 \cdot d_i \cdot \tan(\frac{\text{FOV}_i}{2})} \right)$$

Because a tile is marked in view if it intersects *any* camera frustum, and subdivides based on the maximum error across all cameras, registering the 16-camera perimeter array plus the overhead nadir camera forces the entire $360^\circ$ spatial envelope around the landmark to simultaneously descend to leaf LOD.

### 4. Asynchronous Octree Settlement Condition
The settlement loop guarantees that geometry extraction occurs only after all network transfers and decompression tasks conclude:
$$\text{QueueDrained} = (\text{stats.downloading} == 0) \land (\text{stats.parsing} == 0)$$

The pipeline requires $\text{QueueDrained}$ to hold true for $N_{\text{stable}} \ge 15$ consecutive frames:
$$\sum_{f=1}^{N_{\text{stable}}} \mathbb{I}(\text{QueueDrained}_f) \ge 15$$

If new child tiles are scheduled, the stability counter resets to 0.

---

## 4. Architectural API Contracts & Code Interfaces

### Dual Dedicated TypeScript APIs

```typescript
import {
  getGoogle3DTilesFullTexture,
  getGoogle3DTilesClay,
  Google3DTile3DObjectResult,
  Google3DTilesQueryOptions
} from '@scratchbox/core/node';

// 1. Full Photogrammetric Texture Ingestion
const texturedModel: Google3DTile3DObjectResult = await getGoogle3DTilesFullTexture(
  'Midtown Manhattan, coordinates: 40.748400, -73.985700',
  {
    outputGlbPath: 'public/models/midtown_textured.glb',
    lodQuality: {
      errorTarget: 0.5,
      virtualSseWidth: 3840,
      virtualSseHeight: 2160,
      maxSettleWaitMs: 25000
    }
  }
);

// 2. Studio Grey Clay Geometric Ingestion
const clayModel: Google3DTile3DObjectResult = await getGoogle3DTilesClay(
  { lat: 48.8584, lng: 2.2945, landmarkName: 'Eiffel Tower' },
  {
    outputGlbPath: 'public/models/eiffel_clay.glb',
    clayPreset: 'studio-grey'
  }
);
```

### Result Schema (`Google3DTile3DObjectResult`)

```typescript
export interface Google3DTile3DObjectResult {
  success: boolean;
  mode: 'full-texture' | 'clay';
  geoAnchor: GeoAnchor;
  resolvedAddress?: string;
  glbBuffer: Buffer;           // Standard binary glTF 2.0 buffer
  glbPath: string;             // Persistent disk path (.glb)
  mesh: Google3DTileMeshStats; // vertexCount, triangleCount, submeshCount
  quality: Google3DTileQualityReport;
  render: Google3DTileRenderOutput;
  manifest: Record<string, any>;
  error?: string;
}

export interface Google3DTileQualityReport {
  source?: string;
  errorTarget: number;         // <= 0.5 (Leaf LOD)
  resolution?: string;         // '4K (3840x2160)'
  maxSettleWaitMs?: number;    // 25000 ms per frame default
  asynchronousSettle: boolean | Record<string, any>;
  preWarmedWaypoints?: number[]; // [0, 18, 36, 54, 71]
  leafLodSettled?: boolean;
}
### In-App Gemini Agent Availability & The 4 Pillars of Comprehension

To ensure that the dual 3D tiles APIs are natively callable and semantically understood by the Scratchbox IDE in-app Gemini reasoning engine, we established a **4-Pillar Integration Architecture**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        User Goal / Natural Language                   │
│         "Ingest 3D tiles for Midtown Manhattan in full texture"        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
    ┌───────────────────────────────┴──────────────────────────────┐
    ▼                                                              ▼
[Pillar 1: Semantic Task Resolver]              [Pillar 3: Agent Skill & Directives]
  TaskCapabilityResolver                          .agents/skills/google-3d-tiles-ingestion/SKILL.md
  - Detects 3D real-world location query          - Instructions, parameter schemas & examples
  - Routes to Tier 1 Native 3D Engine             - AGENTS.md directives for Zero Presets
    (not ComfyUI diffusion)                                        │
    │                                                              │
    └───────────────────────────────┬──────────────────────────────┘
                                    ▼
                 [Pillar 2: Gemini Tool Registry & Function Calling]
                   tool-registry.ts (Workspace Tool Group)
                   - google_3d_tiles_get_full_texture
                   - google_3d_tiles_get_clay
                   - Dispatches request, streams .glb, reports mesh statistics
                                    │
                                    ▼
                 [Pillar 4: Canvas Primitive Mounting]
                   mount_canvas_primitive -> 3d-scene
                   - Visualizes exported binary .glb in Three.js viewport
```

#### Pillar 1: Gemini Tool Declarations & Handlers
Exposed in [`packages/core/src/node/gemini/tool-registry.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tool-registry.ts) under the `'workspace'` tool group:
1. `google_3d_tiles_get_full_texture`:
   - **Schema**:
     ```typescript
     {
       name: 'google_3d_tiles_get_full_texture',
       description: 'Ingest and download any real-world address or geographic coordinates as a high-fidelity 3D object (.glb) in full photogrammetric texture from Google Maps Photorealistic 3D Tiles. Enforces zero presets, no procedural fallback, leaf LOD errorTarget <= 0.5, 4K screen-space error budget, and asynchronous queue draining.',
       parameters: {
         type: 'OBJECT',
         properties: {
           query: { type: 'STRING', description: 'Address, landmark description, or geodetic coordinates (e.g. "40.748400, -73.985700" or "Midtown Manhattan").' },
           outputGlbPath: { type: 'STRING', description: 'Optional persistent filesystem path for the output .glb.' },
           mockExecution: { type: 'BOOLEAN', description: 'Enable deterministic offline mock mode for testing.' }
         },
         required: ['query']
       }
     }
     ```
2. `google_3d_tiles_get_clay`:
   - **Schema**:
     ```typescript
     {
       name: 'google_3d_tiles_get_clay',
       description: 'Ingest and download any real-world address or geographic coordinates as a studio grey clay 3D object (.glb) from Google Maps Photorealistic 3D Tiles. Enforces zero presets, no procedural fallback, leaf LOD errorTarget <= 0.5, 4K screen-space error budget, and asynchronous queue draining.',
       parameters: {
         type: 'OBJECT',
         properties: {
           query: { type: 'STRING', description: 'Address, landmark description, or geodetic coordinates (e.g. "40.748400, -73.985700" or "Midtown Manhattan").' },
           outputGlbPath: { type: 'STRING', description: 'Optional persistent filesystem path for the output .glb.' },
           clayPreset: { type: 'STRING', description: 'Shading preset: "studio-grey" (default), "warm-clay", or "alabaster".' },
           mockExecution: { type: 'BOOLEAN', description: 'Enable deterministic offline mock mode for testing.' }
         },
         required: ['query']
       }
     }
     ```
- Automatic tool injection occurs via `isWorkspaceNeeded` whenever user prompts reference `3d`, `tile`, `photorealistic`, `geodetic`, `landmark`, `coordinates`, or `address`.

#### Pillar 2: Semantic Capability Routing
In [`packages/core/src/node/agent/task-capability-resolver.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/agent/task-capability-resolver.ts):
- Requests for real-world geometry are classified into Domain `'3d'` with `recommendedResolutionRoute = 'tier1-native'` and `primaryNativeEngine = 'cpp-3d-engine'`.
- The resolver directs the agent to execute native Google 3D Tiles ingestion (`getGoogle3DTilesFullTexture` or `getGoogle3DTilesClay`) and mount the resulting model directly into `3d-scene`, preventing erroneous failovers to ComfyUI diffusion models.

#### Pillar 3: Agent Skill & Root Directives
- **Dedicated Skill**: [`.agents/skills/google-3d-tiles-ingestion/SKILL.md`](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/google-3d-tiles-ingestion/SKILL.md) provides detailed instructions on leaf LOD configurations, multi-waypoint pre-warming, coordinate formatting, and Three.js canvas mounting.
- **Root Directives**: Codified in [`AGENTS.md`](file:///Users/eligreen/dev/scratchbox-ide-master/AGENTS.md) under `Rule: Dual Dedicated 3D Object APIs & Zero Presets` to enforce zero presets and no procedural fallbacks across all agent instances.

#### Pillar 4: Canvas Primitive Mounting
When the tool finishes, the resulting `.glb` file is mounted onto the Scratchbox IDE visual stage:
```typescript
await ctx.geminiService.executeMountCanvasPrimitive({
  primitiveType: '3d-scene',
  title: 'Midtown Manhattan 3D Tiles',
  summary: 'Ingested high-fidelity Google Maps Photorealistic 3D Tiles at leaf LOD.',
  payload: {
    modelUrl: result.glbPath, // 'public/models/midtown_textured.glb'
    cameraPosition: [0, 50, 100],
    environment: 'city'
  }
});
```

---

## 5. Automated Verification & Regression Prevention

The pipeline is safeguarded by two automated test suites in `@scratchbox/core` (15/15 tests passing):

### 1. Blockout Pipeline & 3D Object Test Suite
**File**: [`packages/core/test/google-3d-tiles-blockout-pipeline.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/google-3d-tiles-blockout-pipeline.test.ts)
* **Test 1**: GoogleCloudAuthPlugin injection & Session token URL rewriting.
* **Test 2**: 6-DoF trajectory parsing & Catmull-Rom spline altitude envelope.
* **Test 3**: HTML runner generation, 4K SSE resolution, stable settlement thresholds, and **360° perimeter multi-camera frustum synthesis**.
* **Test 4**: End-to-end pipeline execution with frame capture and `<VIDEO_REF_0>` token generation.
* **Test 5**: Parabolic clearance lift avoiding obstacle collisions while locking Frame 0.
* **Test 6**: Multi-level void carving clearance.
* **Test 7**: Photorealistic textured runner preserving PBR diffuse textures.
* **Test 8**: **Zero-preset and no-fallback geocoding** (rejecting unresolvable addresses when coordinates or API keys are missing).
* **Test 9**: 72-frame corridor generation with multi-waypoint pre-warming (`[0, 18, 36, 54, 71]`).
* **Test 10**: High-fidelity API execution returning standard `.glb` buffers with valid magic headers (`0x46546C67`).
* **Test 11**: **Dedicated Zero-Preset APIs (`getGoogle3DTilesFullTexture` and `getGoogle3DTilesClay`)** verifying `maxSettleWaitMs === 25000`, 4K resolution, and non-zero vertex/triangle counts.

### 2. Gemini Agent Tools Test Suite
**File**: [`packages/core/test/google-3d-tiles-agent-tools.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/google-3d-tiles-agent-tools.test.ts)
* **Test 1**: Exposes `google_3d_tiles_get_full_texture` and `google_3d_tiles_get_clay` in Gemini tool declarations.
* **Test 2**: Executes `google_3d_tiles_get_full_texture` via tool registry (`registry.dispatch`).
* **Test 3**: Executes `google_3d_tiles_get_clay` via tool registry (`registry.dispatch`).
* **Test 4**: `TaskCapabilityResolver` correctly routes real-world 3D location queries to Tier 1 native 3D engine without falling back to ComfyUI.

### Verification Execution Commands
```bash
# 1. Execute blockout pipeline test suite (11/11 passing)
npx vitest run packages/core/test/google-3d-tiles-blockout-pipeline.test.ts

# 2. Execute agent tools test suite (4/4 passing)
npx vitest run packages/core/test/google-3d-tiles-agent-tools.test.ts

# 3. Verify TypeScript type safety across @scratchbox/core (0 errors)
npm run typecheck --workspace=@scratchbox/core

# 4. Verify clean compilation to dist/
npm run build --workspace=@scratchbox/core
```

---

## 6. Canonical Usage & Workflow Examples

### Example 1: Programmatic Ingestion in Node.js / TypeScript
```typescript
import { getGoogle3DTilesFullTexture, getGoogle3DTilesClay } from '@scratchbox/core/node';

// Download full photogrammetric textured model
const textured = await getGoogle3DTilesFullTexture(
  '40.748400, -73.985700',
  {
    outputGlbPath: 'public/models/manhattan_textured.glb',
    lodQuality: { errorTarget: 0.5, virtualSseWidth: 3840, virtualSseHeight: 2160 }
  }
);
console.log(`Ingested ${textured.mesh.vertexCount} vertices, ${textured.mesh.triangleCount} triangles.`);

// Download studio grey clay blockout
const clay = await getGoogle3DTilesClay(
  '40.748400, -73.985700',
  {
    outputGlbPath: 'public/models/manhattan_clay.glb',
    clayPreset: 'studio-grey'
  }
);
```

### Example 2: In-App Natural Language Gemini Agent Query
When a user asks the Scratchbox IDE agent:
> *"Download a high-resolution photorealistic 3D model of Midtown Manhattan around coordinates 40.748400, -73.985700 and show it on the canvas."*

The agent executes the following reasoning flow:
1. `TaskCapabilityResolver` classifies the goal as Domain `'3d'` -> Tier 1 Native (`cpp-3d-engine`).
2. Gemini dispatches tool `google_3d_tiles_get_full_texture` with `{ query: "40.748400, -73.985700", outputGlbPath: "public/models/midtown.glb" }`.
3. The tool drains the octree queues, packages the binary `.glb`, and returns geometric metrics.
4. The agent dispatches `mount_canvas_primitive` (`3d-scene`) to render the `.glb` into the Three.js viewport.

# A Living Model of the World: Architectural Blueprint, Current Codebase Status & Engineering History

**Canonical Document URI:** [`docs/LIVING_MODEL_OF_THE_WORLD_STATUS_AND_HISTORY.md`](file:///Users/eligreen/dev/scratchbox-ide-master/docs/LIVING_MODEL_OF_THE_WORLD_STATUS_AND_HISTORY.md)  
**Author / Conceptual Thesis:** Eli Green | September 2026  
**Implementation Engine:** Scratchbox IDE & Astra C++20 Spatial Engine  
**Current Date:** September 20, 2026  
**Status:** In Active Production & Substrate Maturation  

---

## 1. Executive Summary & Verification Matrix

The working thesis of **"A Living Model of the World"** represents a foundational architectural pivot away from hallucinatory generative 3D/video models toward a **persistent, versioned, evidence-backed representation of reality that AI can observe, reason over, simulate, and safely change**. Rather than continually prompting neural models to hallucinate the physical world in vacuum, Scratchbox IDE grounds world state in real geographic, geometric, and observational telemetry—positioning artificial intelligence as an **analytical intelligence and state-transition layer** over a maintained canonical world.

The table below summarizes the implementation status across all core architectural subsystems in the Scratchbox IDE monorepo:

| Architectural Subsystem | Target Functional Contract | Implementation Status | Monorepo Source Location | Verification Test Suite |
| :--- | :--- | :---: | :--- | :--- |
| **Universal 4D ECS Protocol** | Primitives: Entity, Space, Time, State, Relationship, Event, Evidence | **Operational (95%)** | [`packages/core/src/common/geospatial-4d-protocol.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/common/geospatial-4d-protocol.ts) | [`packages/core/test/geospatial-photoreal-pipeline.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/geospatial-photoreal-pipeline.test.ts) |
| **Deterministic C++ Reality Plane** | Apple Clang C++20 engine: SIMD math, collision, XPBD physics, Marching Cubes, ephemeris | **Operational (100%)** | [`packages/core/src/native/3d-engine/include/scratchbox_engine.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_engine.hpp) | Automated C++ native runners (`test_utdra`, `test_field_remesh`, `test_fracture`) |
| **Observational Grounding** | Google 3D Tiles leaf-LOD ingestion, NOAA solar ephemeris, Open-Meteo weather | **Operational (90%)** | [`Google3DTileIngestionService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Google3DTileIngestionService.ts)<br>[`WeatherApiService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/WeatherApiService.ts) | [`packages/core/test/google-3d-tiles-agent-tools.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/google-3d-tiles-agent-tools.test.ts) |
| **Inverse Ephemeris Deduction** | Closed-loop shadow angle & length ratio solving for exact date/time/confidence | **Operational (100%)** | [`ChronoSpatialDeductionEngine.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/ChronoSpatialDeductionEngine.ts) | Automated solar inversion unit tests |
| **Multiverse World-State Store** | Git-like branching (`earth/main`), copy-on-write commits, entity snapshots, diffs | **Operational (85%)** | [`WorldBranchManager.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/WorldBranchManager.ts)<br>[`packages/cli/src/state/spatial-repository.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/cli/src/state/spatial-repository.ts) | [`packages/cli/test/sbox-spatial.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/cli/test/sbox-spatial.test.ts) |
| **Bidirectional Lens Protocol** | Domain projections over shared underlying data without world duplication | **Operational (80%)** | [`packages/core/src/common/codebase-lens-protocol.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/common/codebase-lens-protocol.ts)<br>[`Scene3DWorldLens.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/lenses/Scene3DWorldLens.ts) | [`packages/core/test/codebase-lens-architecture.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/codebase-lens-architecture.test.ts) |
| **S4D State-Transition Model** | 4D Occupancy Diffusion Transformer conditioned on 6-DOF trajectories ($(S, A) \to S'$) | **In Training / Staging (75%)** | [`OccSoraBridge.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/OccSoraBridge.ts)<br>[`Synthetic4DDataGenerator.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Synthetic4DDataGenerator.ts) | [`packages/core/test/occsora-4d-bridge.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/occsora-4d-bridge.test.ts) |
| **ARCore Geospatial Bridge** | WGS-84 to WebXR metric space, sensor fusion & millimeter optical reticle calibration | **Operational (100%)** | [`WebXRGeospatialAnchorBridge.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/xr/WebXRGeospatialAnchorBridge.ts) | [`packages/core/test/webxr-geospatial-anchor-bridge.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/webxr-geospatial-anchor-bridge.test.ts) |
| **World Controller API** | Narrow Gemini grammar: `world_query`, `world_propose`, `world_simulate`, `world_commit` | **In Engineering (50%)** | [`packages/core/src/node/gemini/tool-registry.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tool-registry.ts) | Agent tool dispatch integration tests |
| **Multi-Source Reconciler** | Automated deduplication & confidence reconciliation across OSM, Tiles, and Permits | **In Design (35%)** | `PlaceRecord.placeId` & `SpatialObservation4D` | Benchmark in development |

---

## 2. Chronological Engineering History

The realization of the Living World Model within Scratchbox IDE has evolved across five distinct architectural phases:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Native C++20 Deterministic Reality Plane (Q1-Q2 2026)                         │
│ • Built 50+ high-performance C++20 modular headers in Astra Engine                     │
│ • Implemented SIMD vector math, Marching Cubes, half-edge topological manifolds        │
│ • Integrated NOAA geodetic ephemeris, Beer-Lambert atmospheric scattering, XPBD physics│
│ • Direct binary glTF 2.0 (.glb) streaming into Three.js canvas in <50ms                │
└───────────────────────────────────┬────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Observational Reality Grounding & Geospatial Protocols (Q2-Q3 2026)           │
│ • Integrated Google Maps Photorealistic 3D Tiles (leaf-LOD errorTarget <= 0.5)         │
│ • Standardized WGS-84 reference ellipsoid and Local Tangent Plane (ENU) Cartesian frames│
│ • Built Universal Tile Decomposition & Rectification Algorithm (UTDRA / ULDRA)         │
│ • Developed ChronoSpatialDeductionEngine for inverse solar ephemeris from shadows      │
│ • Integrated live atmospheric weather via Open-Meteo REST service                      │
└───────────────────────────────────┬────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Multiverse World-State Store & Sbox CLI Toolchain (Mid 2026)                  │
│ • Implemented WorldBranchManager: copy-on-write branching (earth/main, alternate worlds)│
│ • Built immutable commit snapshots, structural entity diffing, and rollback mechanics   │
│ • Shipped @scratchbox/cli (sbox init, branch, commit, diff, status, attach, bake)      │
│ • Established .scratchbox/spatial-state.json workspace persistence                     │
└───────────────────────────────────┬────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: S4D (Scratchbox-4D) Spatiotemporal Diffusion World Model (August 2026)        │
│ • Formulated OccSora-style 4D occupancy diffusion foundation architecture               │
│ • Replaced flat automotive grids with 128 x 128 x 64 volumetric urban lattices         │
│ • Built Synthetic4DDataGenerator producing 50,000 paired (Trajectory, Occupancy) items │
│ • Established state-transition paradigm: given (World State S, Action A) -> State S'   │
└───────────────────────────────────┬────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: The Operating System for Reality — Unified Blueprint Synthesis (September 2026)│
│ • Formulated "A Living Model of the World" architectural blueprint                     │
│ • Formalized the Universal Primitive Set: ENTITY + SPACE + TIME + STATE + RELATIONSHIP │
│   + EVENT + EVIDENCE                                                                   │
│ • Unified Codebase Lenses with Domain Lenses (Robotics, Autonomous Transit, Twins)     │
│ • Defined the 7-step closed agent loop: OBSERVE -> QUERY -> PROPOSE -> VALIDATE        │
│   -> SIMULATE -> COMMIT -> MEASURE                                                     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Deep Architectural Blueprint vs. Codebase Mapping

### 3.1 The Central Idea: Generating vs. Maintaining Reality
* **Blueprint Mandate (Section 1):** Avoid the trap of asking AI foundation models to hallucinate plausible 3D worlds. Instead, start from real geographic and observational data, resolve it into persistent entities, and attach time, semantics, behavior, evidence, and transformation history. AI acts as an intelligence and transformation layer over a maintained world state.
* **Codebase Manifestation:**
  - In [`Google3DTileIngestionService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Google3DTileIngestionService.ts), real-world geometry is fetched directly from Google Maps Platform 3D Tiles without arbitrary procedural approximations or coordinate hashes.
  - In [`LocalTangentPlane.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/common/coordinate/LocalTangentPlane.ts), all positions are grounded on the WGS-84 reference ellipsoid ($a = 6378137.0\text{ m}, f = 1/298.257223563$).
  - In [`ChronoSpatialDeductionEngine.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/ChronoSpatialDeductionEngine.ts), physical photographs are anchored to calendar dates and astronomical coordinates by solving inverse solar shadow equations.

### 3.2 What the World Contains: Universal Primitives & The "Lens" Concept
* **Blueprint Mandate (Section 2):** A physical object (e.g., the Empire State Building or a door) must not exist as disjoint representations across multiple systems. It has **one persistent identity** with multiple domain-specific **lenses**. Universal primitives:
  $$\text{ENTITY} + \text{SPACE} + \text{TIME} + \text{STATE} + \text{RELATIONSHIP} + \text{EVENT} + \text{EVIDENCE}$$
* **Codebase Manifestation:**
  - In [`geospatial-4d-protocol.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/common/geospatial-4d-protocol.ts#L219-L228), the canonical `Entity4D` interface binds all 7 primitives:
    ```typescript
    export interface Entity4D {
      id: string;                               // Canonical Persistent ID
      name: string;                             // Human-readable identifier
      space: SpaceDimension4D;                 // WGS-84 GeoAnchor, Cartesian ENU, S2 Cell
      time: TimeDimension4D;                   // Temporal start, duration, property tracks
      environment: EnvironmentDimension4D;     // Solar ephemeris, weather, AQI, elevation
      content: ContentRepresentation4D;         // Multi-LOD representations (Mesh, Splat, Tensor)
      behavior: BehaviorDimension4D;           // Kinematic rigs, mass, telemetry streams
      lineage: LineageDimension4D;             // Branch ID, commit hash, version, provenance
    }
    ```
  - In [`codebase-lens-protocol.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/common/codebase-lens-protocol.ts), the `CodebaseLens` interface establishes the bidirectional contract (`project` / `unproject`) allowing any domain lens to project raw world state into specialized visualizations (3D scene, Gantt timeline, CAD topology, occupancy tensor) without duplicating the underlying data.

### 3.3 Semantics & The Meaning Layer
* **Blueprint Mandate (Section 3):** Meaning extends beyond visual geometry into attributes, relationships, function, and affordances. Semantic claims must carry source, timestamp, confidence, and provenance to reflect state changes over decades.
* **Codebase Manifestation:**
  - In [`geospatial-4d-protocol.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/common/geospatial-4d-protocol.ts#L259-L295):
    - `WorldRelationship`: Expresses graph triplets ($Subject \xrightarrow{Predicate} Object$) with contextual metadata.
    - `GeospatialSemanticClass`: Standardizes 10 architectural and spatial classes (`AIRSPACE`, `TERRAIN`, `WATER`, `BUILDING_FACADE`, `BUILDING_INTERIOR`, `VEGETATION`, `TRANSIT_ROAD`, `DYNAMIC_AIR_AGENT`, `DYNAMIC_GROUND_AGENT`, `DYNAMIC_HAZARD`).
    - `SpatialObservation4D`: Preserves sensor type (`camera-rgb`, `lidar`, `satellite`), raw capture URIs, camera optics, estimated solar angles, and author provenance.

### 3.4 Reality as an Event Stream
* **Blueprint Mandate (Section 4):** External observations (weather, permits, transit, sensor pings) enter as observations. An analytical compiler reconciles them against persistent entities and produces state-transition events. The system answers: *What was the best-known state of this entity at time $T$, according to the evidence available?*
* **Codebase Manifestation:**
  - `WeatherApiService` continuously reconciles current meteorological conditions (temperature, precipitation, cloud cover, wind vectors) and maps them to physical material wetness and fog parameters.
  - `TemporalSimulationSolver` executes kinematic evaluation along continuous Catmull-Rom splines, emitting discrete timestamped `TelemetryLog` events ($t, x, y, z, v$).
  - `WorldBranchManager` records versioned snapshots with parent commit pointers, allowing chronological time-travel to any historical commit.

### 3.5 Data Substrate & Licensing Boundaries
* **Blueprint Mandate (Section 5):** The world graph combines OpenStreetMap, Overture, USGS, Landsat, Sentinel, NOAA, GTFS, and municipal open data. Google data is treated strictly according to co-development rights rather than assumed to be extractable.
* **Codebase Manifestation:**
  - In [`packages/core/src/common/project-artifact-graph-protocol.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/common/project-artifact-graph-protocol.ts#L63-L74), `ArtifactCapabilityGrant` enforces strict policy gates (`map.read`, `workspace.write`, `media.generate`) with explicit origin and actor restrictions.
  - In [`Google3DTileBlockoutPipelineService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Google3DTileBlockoutPipelineService.ts), Google Photorealistic 3D Tiles are loaded into isolated headless browser contexts and transformed into standard `.glb` assets for local downstream processing.

### 3.6 Proposed Architecture: AI Reasoning Separation
* **Blueprint Mandate (Section 6):** Gemini is the reasoning engine, but it is not the database and does not directly mutate physical reality. The proprietary core is the reconciliation and versioning engine.
* **Codebase Manifestation:**
  - Gemini operates through [`tool-registry.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tool-registry.ts) via structured JSON schema function declarations.
  - All file and state mutations pass through [`ContainerSandboxService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/container-sandbox-service.ts), [`path-guard.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/security/path-guard.ts), and [`sandbox-policy.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/security/sandbox-policy.ts).
  - Scene mutations are executed via the atomic [`DirectDispatchOperatorEngine.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/direct-dispatch-operator-engine.ts) with full rollback stacks.

### 3.7 The IDE Becomes the Laboratory & The Agent Loop
* **Blueprint Mandate (Section 7):** The agentic coding IDE and C/C++ 3D engine are the foundational laboratory assets. Agents execute a 7-step loop:
  $$\text{OBSERVE} \longrightarrow \text{QUERY} \longrightarrow \text{PROPOSE} \longrightarrow \text{VALIDATE} \longrightarrow \text{SIMULATE} \longrightarrow \text{COMMIT} \longrightarrow \text{MEASURE}$$
  Every loop generates an execution trace, accumulating proprietary training data.
* **Codebase Manifestation:**
  - **Deterministic C++20 Reality Plane:** Modular native headers in [`packages/core/src/native/3d-engine/include/`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/):
    - Physics & Trajectories: [`scratchbox_xpbd.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_xpbd.hpp), [`scratchbox_trajectory_collision.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_trajectory_collision.hpp).
    - Atmospheric & Ephemeris: [`scratchbox_ephemeris.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_ephemeris.hpp), [`scratchbox_volumetrics.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_volumetrics.hpp).
    - Bi-directional BSDF Materiality: [`scratchbox_substrate.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_substrate.hpp).
  - **Visual Verification & Pose Oracle:** Headless Puppeteer closed-loop verification in [`visual-verification-service.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/visual-verification-service.ts) and [`HeadlessPoseOracle.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/HeadlessPoseOracle.ts).
  - **Studio Stage:** Interactive Three.js canvas in [`GenerativeCanvasStudio.tsx`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/GenerativeCanvasStudio.tsx).

---

## 4. Analysis of "What to Build First" (Section 8 Scorecard)

The roadmap outlines eight critical modules to construct first. The table below details their exact implementation status and next engineering milestones:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        PHASE 8 DELIVERABLES - IMPLEMENTATION STATUS                    │
├───────────────────────────────────┬────────┬───────────────────────────────────────────┤
│ DELIVERABLE                       │ STATUS │ CURRENT IMPLEMENTATION & NEXT ACTION      │
├───────────────────────────────────┼────────┼───────────────────────────────────────────┤
│ 1. Canonical Schema               │  95%   │ Complete in geospatial-4d-protocol.ts.    │
│                                   │        │ Next: Add EvidenceClaim verification tree.│
├───────────────────────────────────┼────────┼───────────────────────────────────────────┤
│ 2. World-State Store              │  85%   │ Operational in WorldBranchManager & sbox. │
│                                   │        │ Next: Implement append-friendly log store.│
├───────────────────────────────────┼────────┼───────────────────────────────────────────┤
│ 3. Identity Resolution            │  35%   │ PlaceRecord has ID hashes.                │
│                                   │        │ Next: Build cross-source entity reconciler│
├───────────────────────────────────┼────────┼───────────────────────────────────────────┤
│ 4. Event Ingestion                │  60%   │ WeatherApiService & ephemeris operational.│
│                                   │        │ Next: Add GTFS & permit ingestion daemons.│
├───────────────────────────────────┼────────┼───────────────────────────────────────────┤
│ 5. World Controller API           │  50%   │ DirectDispatchOperatorEngine operational. │
│                                   │        │ Next: Expose world_* tools in Gemini registry.│
├───────────────────────────────────┼────────┼───────────────────────────────────────────┤
│ 6. C++ Reality Bridge             │  85%   │ NativeCppCompilerService & Clang operational│
│                                   │        │ Next: Expose XPBD physics via Node addon. │
├───────────────────────────────────┼────────┼───────────────────────────────────────────┤
│ 7. State Inspector in IDE         │  75%   │ Scene3DPrimitive & s4d_multi_gallery ready│
│                                   │        │ Next: Add entity inspector & slider UI.   │
├───────────────────────────────────┼────────┼───────────────────────────────────────────┤
│ 8. Trace Capture                  │  70%   │ conversation-diff-memory logs agent steps.│
│                                   │        │ Next: Export (S, A, S') tuples for S4D.   │
└───────────────────────────────────┴────────┴───────────────────────────────────────────┘
```

---

## 5. The Stress Test: 10,000 Entities in a Bounded District

* **Blueprint Mandate (Section 9):** Do not begin with the entire planet. Begin with a deliberately messy bounded district ($10,000$ imperfect entities). Verify:
  1. Multi-source entity survival (disagreeing sources resolved to one persistent ID).
  2. Historical state reconstruction at an earlier time $T$.
  3. Provenance and belief explanation (why a fact is believed).
  4. Non-corrupting agent proposals and instant rollback.
  5. Deterministic C++ physics simulation of proposed changes.
  6. Multi-lens reuse of identical entities without data duplication.
* **Execution Benchmark Environment:**
  - **Target Geographic Zone:** Midtown Manhattan (Empire State Building corridor, $40.748400, -73.985700$, $1\text{ km} \times 1\text{ km}$ bounding box).
  - **Existing Assets on Disk:**
    - [`empire_state_building_improved_tile.glb`](file:///Users/eligreen/dev/scratchbox-ide-master/empire_state_building_improved_tile.glb) (1.96 MB rectified mesh)
    - [`sf_ferry_building_photoreal.glb`](file:///Users/eligreen/dev/scratchbox-ide-master/sf_ferry_building_photoreal.glb) (1.96 MB photoreal mesh)
    - [`cleaned_tile_output.glb`](file:///Users/eligreen/dev/scratchbox-ide-master/cleaned_tile_output.glb) (76.3 MB full urban blockout)

---

## 6. The Model Strategy: S4D (Scratchbox-4D) as the State-Transition Model

Section 11 of the blueprint defines the long-term machine learning strategy:
> *"Its fundamental training question is not 'what should the next frame look like?' but 'given world state $S$ and action $A$, what is the resulting state $S'$?' That is the point where the system begins to learn a world model from its own accumulated history."*

In Scratchbox IDE, this mathematical formulation was codified in [`docs/SCRATCHBOX_4D_MODEL_TRAINING_PLAN.md`](file:///Users/eligreen/dev/scratchbox-ide-master/docs/SCRATCHBOX_4D_MODEL_TRAINING_PLAN.md) through **Scratchbox-4D (S4D)**:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│               SCRATCHBOX-4D (S4D) STATE-TRANSITION ARCHITECTURE                        │
│                                                                                        │
│  [Current World State S] (Occupancy Tensor V_t ∈ R^(128 × 128 × 64))                   │
│  [Action Trajectory A]   (6-DOF Catmull-Rom Kinematic Prompt from TemporalSimulation) │
│         │                                                                              │
│         ▼                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ S4D-DiT (Diffusion Transformer Backbone, 130M-380M parameters)                    │  │
│  │ • AdaLN-Zero conditioning on Action Trajectory A                                 │  │
│  │ • Flow Matching / DDIM latent diffusion                                          │  │
│  │ • 3D/Spatiotemporal Rotary Position Embeddings (RoPE)                             │  │
│  └──────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                         │ Latent Transition Tokens Z'                  │
│                                         ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ S4D-Tokenizer (3D/4D Spatiotemporal VAE Decoder)                                 │  │
│  │ • Decodes latent tokens back to dense 4D semantic occupancy                      │  │
│  └──────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                         │ Resulting World State S' (V_{t+1})           │
│                                         ▼                                              │
│  [Native C++20 Marching Cubes] ──────> Binary glTF 2.0 (.glb) Mesh Stream (<50ms)     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

The synthetic data generation engine ([`Synthetic4DDataGenerator.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Synthetic4DDataGenerator.ts)) generates 50,000 paired $(P, V)$ sequences across 20 global metropolises, providing the training substrate for this state-transition model.

---

## 7. Commercial Surface: One Substrate, Many Lenses

Section 10 of the blueprint cautions against building separate, disconnected products for robotics, autonomous vehicles, and industrial digital twins:
> *"The architectural idea is to avoid building three unrelated products. Build one world substrate, then sell domain-specific lenses, skills, APIs and governed access to it."*

In Scratchbox IDE, domain applications are implemented as polymorphic **Lenses** projecting the same underlying `Entity4D` records:

1. **Physical AI & Robotics Lens:**
   - Projects entities into 4D semantic occupancy tensors ($128 \times 128 \times 64$ voxels via `OccSoraBridge`), bounding volume hierarchies (`scratchbox_bvh.hpp`), and collision envelopes.
2. **Autonomous Transportation Lens:**
   - Projects high-definition road corridors, lane centerlines, dynamic vehicle obstacles, and Catmull-Rom trajectory clearances.
3. **Field AR & Infrastructure Inspection Lens:**
   - Projects millimeter-accurate ARCore deployment contracts ([`DeploymentManifestCompiler.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/DeploymentManifestCompiler.ts)) with True North geodetic headings and streetscape depth occlusion.
4. **Civic & Architectural Digital Twin Lens:**
   - Projects zoning boundaries, municipal permit history, UTDRA planar facade rectifications, and solar shadow envelopes.

---

## 8. Immediate Tactical Engineering Roadmap

To advance the Living World Model from its current operational substrate to complete Phase 8 & 9 fulfillment, the following four engineering sprints are scheduled:

### Sprint 1: World Controller API in Gemini Registry
* Implement `packages/core/src/node/gemini/world-controller-service.ts`.
* Register five core tools in [`tool-registry.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tool-registry.ts):
  - `world_query_entities`: Spatial, temporal, and semantic filtering.
  - `world_propose_mutation`: Copy-on-write staging on target branch.
  - `world_simulate_physics`: Deterministic C++ trajectory and collision check.
  - `world_commit_transaction`: Atomic commit with provenance and diff summary.
  - `world_rollback`: Instantaneous restoration of prior branch commit.

### Sprint 2: The 10,000-Entity District Stress Test Suite
* Create `packages/core/test/living-world-district-stress.test.ts`.
* Populate a 10,000-entity Midtown Manhattan district from Google 3D Tiles and synthetic municipal permit feeds.
* Verify cross-source conflict resolution, historical rollback, and multi-lens query without entity duplication.

### Sprint 3: Autonomous Trace Harvester
* Connect Gemini `world_commit_transaction` outcomes to an append-only `.zarr` trace logger.
* Format execution records into structured $(S_t, A_t, S_{t+1})$ tuples.
* Feed directly into the S4D training pipeline.

---

## 9. Conclusion

The blueprint **"A Living Model of the World"** provides the unified conceptual architecture for Scratchbox IDE. By anchoring artificial intelligence to a versioned, deterministic, and evidence-backed representation of reality, Scratchbox moves beyond the limitations of generative hallucination to deliver a true **operating system for shared reality**.

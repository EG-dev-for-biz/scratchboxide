---
name: adaptive-domain-architecture
description: >-
  Architectural paradigm and execution directive for Scratchbox IDE specializing in
  Adaptive Domain Architecture (ADA), Zero Closed Taxonomies, Schema-Driven Latent Synthesis,
  Ephemeral Compilation, and Open-Domain Universality. Eliminates hardcoded scene .cpp files,
  preset enums, and switch-case classifiers in favor of continuous physical parameter schemas
  and on-the-fly C++20 Clang compilation.
---

# Adaptive Domain Architecture (ADA) & Open-Domain Synthesis Directive

The **Adaptive Domain Architecture (ADA)** is the foundational architectural paradigm of Scratchbox IDE. It establishes that **the LLM is the domain engine**, eliminating hardcoded domain enums, keyword regex classifiers, preset scene templates, and static `.cpp` generator files.

---

## 1. Core Architectural Pillars

```
                        [User Prompt / Unconstrained Goal]
                                       │
                                       ▼
                       [The LLM as the Domain Engine]
                   (Latent semantic space & first principles)
                                       │
                                       ▼
                     [Continuous Schema-Driven Contracts]
                    (`Adaptive3DSceneContract`, `BuildingConfig`)
                                       │
                                       ▼
                     [Ephemeral In-Memory Code Synthesis]
                     (`Adaptive3DSceneSynthesizer.generateCppSource()`)
                                       │
                                       ▼
                     [JIT Native Compilation & Execution]
               (`NativeCppCompilerService` / `clang++ -std=c++20 -O3`)
                                       │
                                       ▼
                       [Streamed Binary glTF 2.0 (.glb)]
                     (Zero static .cpp artifacts on disk)
```

### Pillar 1: Adaptive Domain Architecture (ADA)
- Domain logic must **never** be restricted to predetermined themes, canned genres, or pre-baked scenarios.
- The system must treat an arctic glaciated research station, an ancient desert canyon ziggurat, a deep-sea geothermal lab, or an exo-atmospheric orbital ring with the exact same first-principles pipeline.

### Pillar 2: Zero Closed Taxonomies
- **Strict Prohibition on Closed Enums**: Never declare `type Domain = 'arctic' | 'desert' | 'space' | 'urban'` or `type SceneType = 'highway_overpass' | 'alpine_valley' | 'ziggurat'`. Closed taxonomies are presets in disguise.
- **Strict Prohibition on Regex Keyword Classifiers**: Never write regex trees like `if (/snow|arctic/i.test(prompt))` to route execution. The LLM's latent semantic space already understands domain nuances, vocabularies, physical scales, and material properties.
- **Zero Switch-Case Trees**: Replace monolithic `switch (domain)` blocks with continuous dimensional models.

### Pillar 3: Schema-Driven Latent Synthesis
- Instead of picking from fixed presets, models project their semantic reasoning into **continuous physical schemas**:
  - Topographical fields: Peak altitude ($m$), cirque sharpness, arête knife-edge exponents, talus scree angles, valley floor datum, snow line threshold.
  - Architectural massing: Archie `BuildingConfig` (bay width, sill/header height, window recess depth, mullion profiles, structural buttress pylon dimensions, parapet coping).
  - Botanical ecology: SB-Veggie continuous morphology (`SbVeggieMorphology`: apical dominance, branch-angle mean and spread, crown aspect, internode length, leaf distribution, blade outline; no tree classes), branching levels, phyllotaxis divergence, transferred envelope normals.
  - Atmospheric ephemeris: Diurnal solar zenith/azimuth, Rayleigh/Mie scattering coefficients, turbidity, Kelvin color temperatures ($1,000\text{K} - 40,000\text{K}$).
- The schemas define **structural contracts**, never static content.

### Pillar 4: Ephemeral Execution (Python Nanobind & JIT C++20)
- **Zero Static Scene Files**: Never write `arctic_outpost.cpp`, `desert_temple.cpp`, or similar one-off generator files into `scripts/` or `src/`.
- **Dual Execution Engines**:
  1. *Python Nanobind Dynamic Sandbox (`execute_3d_python_script`)*: Scripts run in a sandboxed Python subprocess importing `scratchbox as sb` (`sb.core`, `sb.shaper`, `sb.create_tree` for SB-Veggie trees, `sb.human`, `sb.terrain`), driving native C++20 algorithms directly in memory with sub-millisecond execution.
  2. *Ephemeral C++20 JIT Compilation (`NativeCppCompilerService`)*: On-the-fly Apple Clang compilation (`clang++ -std=c++20 -O3`) synthesizing temporary procedural modules in memory, streaming binary `.glb` chunks, and cleaning up object files immediately.
- Both paths preserve non-destructive reproducibility by attaching the procedural source directly to scene metadata (`data.cppGenerator.sourceCode` or `data.pythonGenerator.sourceCode`) without polluting the repo.

### Pillar 5: Open-Domain Universality
- The architecture scales seamlessly to any arbitrary prompt from the user without needing codebase modifications, new enum variants, or specialized handlers.
- New capabilities are added as continuous parameters in the schema contracts, not as new discrete cases in a classifier.

### Pillar 6: C++20 Bare-Metal Engine vs. Three.js Viewport Separation
- **Heavy Geometric Work Belongs in C++20 (via Python nanobind or native Clang)**: Native C++ with Apple Clang (`-std=c++20 -O3`) and nanobind SIMD math generates 100,000+ vertices, calculates smooth envelope normals, applies noise algorithms, and serializes a standard binary `.glb` in under 200 milliseconds.
- **Three.js is a Pure Renderer/Viewport**: Three.js must never be used to procedurally construct geometry loops in browser JavaScript. Three.js is best utilized as a pure renderer and viewport, mounting the streamed `.glb`, managing the WebGL context, camera choreography, and interactive orbit controls.
- **Strict Prohibition on Toy JavaScript Primitives ("Tier-0" Ban)**: Viewports and generative pipelines must NEVER catch errors and silently fall back to Three.js primitive boxes, cylinders, or cones (`new THREE.BoxGeometry`, etc.). Stacking flat boxes is strictly banned.
- **Mandatory Geometric Complexity Floor (`GeometricComplexityGate`)**: Every procedural generative scene must pass `GeometricComplexityGate` with a strict minimum of **25,000 vertices** (5,000 for single isolated props), **15,000 triangles**, and an authentic 70-20-10 multi-mesh hierarchy.
- **Surface Native Faults**: If native C++20 / Python nanobind generation fails at runtime, report the error; never degrade to client-side JavaScript primitives.

### Pillar 7: Zero Uninvited Defaults (Atmosphere & Clouds Strictly Opt-In)
- **Preserve Visual Neutrality and User Intent**: In practice, uninvited defaults pollute user intent. When building an outpost or mechanical asset, unexpected clouds or lighting presets fight against the composition. Making atmosphere, ephemeris, and cloud layers strictly opt-in preserves visual neutrality and artistic control.
- **Neutral Studio Baseline**: Unconfigured scenes default strictly to a clean, neutral studio environment (`skybox: 'studio'`, `lighting: 'studio'`).
- **Explicit Opt-In Gate**: Atmospheric sky domes, Rayleigh/Mie scattering, diurnal solar curves, depth fog, and volumetric clouds are only instantiated when explicitly requested in the prompt or schema contract.

### Pillar 8: Dimensional vs. Taxonomic Typing (The Canonical Type Invariant)
- **Types Must Define Dimensions, Never Domains**:
  - **Taxonomic Types (Strictly Prohibited)**: Nominal categories, genre enums, and closed string unions (e.g. `type Theme = 'arctic' | 'desert'`). They force codebase edits for novel concepts, fail on unpredicted prompts, and create brittle switch-case classifiers.
  - **Dimensional Types (Mandatory)**: Continuous coordinate spaces, physical quantities, and hardware execution invariants (`Vec3`, `Bounds3D`, `PbrMaterialAttributes`, `elevationProfile: { peakReliefMeters: number, areteSharpnessExponent: number }`). They provide the physical manifold in which any arbitrary domain can exist.
- **The 3 Adversarial Stress Tests for Any Type**:
  1. *The Alien Planet Test*: Can an entity the developer never conceived of (e.g. *"bioluminescent geothermal mycelium forest inside a hollow asteroid with liquid methane geysers"*) be represented without editing TypeScript or C++ source? If it requires adding an enum variant, the type fails.
  2. *The Continuous vs. Discrete Test*: Can states in this type space be linearly interpolated ($\operatorname{lerp}$)? Strings and discrete cases cannot be blended; physical dimensions (temperatures, roughness, ratios, dimensions, simplex weights) morph smoothly.
  3. *The What vs. How Test*: Does the type constrain the semantic *meaning* of the scene, or does it enforce *memory layout and computational invariants* for hardware (SIMD alignment, IEEE 754 float32, glTF 2.0 contiguous buffer packing)? Types must constrain the *how* (execution safety), never the *what* (generative imagination).
- **Open-Ended Type Extension Idiom**:
  - For diagnostic strings and tooling autocomplete, use open literal types:
    ```typescript
    type TerrainTopology = 'alpine_massif' | 'canyon' | 'plateau' | (string & {});
    ```
  - Execution logic must **never** branch on string matches (e.g. `if (topology === 'alpine_massif')`). Execution must read the continuous mathematical fields (`peakHeight`, `sharpnessExponent`, `screeNoiseAmplitude`).

### Pillar 9: Internal Reference Image -> Object Build Spec -> Native Clay (`build_3d_object_from_reference`)
- **The Information Entropy Gap**:
  - A short prompt for one object (e.g. *"a vintage brass telescope on a tripod"*) carries little shape information, so a model writing geometry straight from the words collapses into generic tropes.
  - An image model has that shape information, but direct image-to-3D diffusion produces melted, non-manifold geometry with baked-in shadows.
- **The pipeline** (`packages/core/src/node/3d-engine/reference-object-builder.ts`, tool `build_3d_object_from_reference`):
  1. *Internal reference*: exactly `gemini-3.1-flash-lite-image` (Nano Banana Lite) draws one grey object at 1:1. The image stays in memory: it is never written to disk, the media store or `public/`, and never shown in the chat. No other image model is tried.
  2. *Vision to spec*: the chat's own model, on the chat's credentials, reads the reference into an `ObjectBuildSpec` (`packages/core/src/common/spatial/object-build-spec.ts`): metric parts built from the 4 operators of Pillar 11 (sweep, revolve, replicate, relief), each child attached by parameter on its parent's surface. `validateObjectBuildSpec` and the interpreter report every problem by part and field; the model gets one corrective re-ask, then the call fails.
  3. *Native build*: `sb.object_spec.build(SPEC)` (`packages/core/src/python/scratchbox/object_spec.py`) runs in the native Python engine and writes a clay GLB, within a time limit that starts once the engine's native module is ready (a failed module build is its own `engine` stage). The script is kept in `data.pythonGenerator.sourceCode`; the spec in `data.objectBuild.spec` and in the object's own `metadata.objectBuild`. To change an object, the model passes the edited spec back as `specJson`: it is rebuilt exactly as given and checked, with no new reference; at a place, with the same `location`, its `placement` and `replaceObjectId` set to that object's id.
  4. *Checks*: every listed part is built and touches its parent, the piece count equals `expectedBodies`, and the vision model compares a clay render with the reference. High-confidence differences go back for up to two revision passes; any left are listed verbatim in the result (`data.objectBuild.remainingDifferences`). A failed revision is reported as such, with the earlier build that passed every check; a comparison that cannot be had is reported as such (`comparisonFailed`) and never discards a build that passed every check.
- *At a real place*: `location` plus `placement` (metres east and north of the geocoded anchor, and a compass heading) stage the object on the clay tiles `google_3d_tiles_get_clay` returns. It stands only on ground (layers marked `isGround`): a spot under a tree crown or on another object fails before any model call, naming clear spots nearby. Once built, its whole footprint must fit: a build that would pass through a crown, a trunk, another object or a wall of the tiles fails with its spec and spots where it fits. Several objects at one place are one call each with the same location; while the active scene is an object build staged there, each call adds its object beside the ones already built there. When the active scene already shows the place (for example `google_3d_tiles_get_clay` staged it), `addToActiveScene: true` adds the object to that scene without staging the place again.
- *From a real photo*: `referenceImageUrl` replaces step 1 with a real photograph of the object, such as a street object at a place. A Street View image only as `streetview_grounding_image` or `streetview_survey` returns it; never a generated or restyled image.
  - The object (`referenceTarget`) is boxed by the vision model and cut out by the app's segmenter onto the same grey backdrop, in memory. Nothing is drawn.
  - The spec read also says where the camera stood, and every comparison renders from there.
  - Materials are photo-inferred; the parts the photo cannot show are generated.
  - A photo has no scale: pass a measured height (`heightHintMeters`) or `dimensionsHintMeters`, with `sizeSource`. The checks hold the build to it.
- Real places alone go to `google_3d_tiles_get_clay`; imagined environments, landscapes and multi-object scenes with no real place are scripted with `execute_3d_python_script`. The LLM chooses between them from the request's meaning, never from keywords.

### Pillar 10: Zero Canned Asset Libraries (Mathematical Grammars over Static Meshes)
- **Strict Prohibition on Asset Libraries (Nouns)**: The codebase must never maintain catalogues of finished `.glb` / `.obj` models (`chiller_01.glb`, `pine_tree_03.glb`). Kitbashing violates ADA and fails on novel concepts.
- **Procedural Grammars Only (Verbs)**: All spatial elements must be generated dynamically from continuous mathematical operators:
  - *Archie*: Procedural architectural operations (`extrudeSlab`, `punchRecessedOpening`, `generateLouverBay`, `createChamferedParapet`).
  - *SB-Veggie*: Algorithmic botanical branching (`apicalDominance`, `branchAngleDeg`, stem tapering, transferred envelope normals).
  - *Astro Noise*: Multi-fractal terrain harmonics (arête knife-edges, cirque hollows, scree talus noise).

### Pillar 11: Differential Geometric Primitives over Mechanical Taxonomies (The 4 Universal Geometric Operators)
- **Prohibition on Named Tool or Mechanical Taxonomies**: Never design schemas, classes, or procedural branches around anthropocentric tool categories (`drill`, `claw`, `camera`, `sensor_pod`, `grabber`, `intake`, `cockpit`). Any specialized or extraterrestrial tool, detail, or appendage must be generated purely through continuous differential geometry.
- **The 4 Universal Differential Geometric Operators**:
  1. *$\mathrm{SE}(3)$ Lie Group Curve Sweeps*: 3D carrier curves $\mathbf{C}(t)$ sweeping continuous profiles $P(u, v)$ with scaling $s(t)$, twist $\theta(t)$, and modulation (generates limbs, hoses, claw prongs, struts, coils, tentacles, and truss members).
  2. *Harmonic Solids of Revolution*: Radial profiles $r(z)$ revolved around an axis with $K$ continuous radial harmonic lobes and helical twist $P_{\text{helix}}$ (generates smooth flanges, nozzles, optical housings when $K=0$; fluted drills, spiral augers when $K \in [2, 6]$; cooling fins, cogwheels, splined hubs when $K \ge 12$).
  3. *Affine Metric Replicators*: Periodic affine distribution of seed geometry along 1D curves or 2D manifolds at continuous metric pitch $p$ (generates bolt circles, fastener arrays, louver vanes, debris screens, gripper teeth, and treads).
  4. *Isoparametric Normal Relief Fields*: Surface normal displacements $\Delta h(u, v)\,\mathbf{n}(u, v)$ along geodesic or parametric curves (generates panel shut lines, weld beads, knurling, and expansion grooves).
- Any new detail on any asset (known vehicle, futuristic rover, industrial machine, alien probe) must be synthesized through combinations of these 4 operators, ensuring infinite domain-agnostic universality and smooth parameter interpolation ($\operatorname{lerp}$).

---

## 2. Canonical Contracts & APIs

### TypeScript ADA Contract
[`Adaptive3DSceneContract`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/common/spatial/adaptive-3d-scene-contract.ts):
```typescript
import { Adaptive3DSceneContract } from '@scratchbox/core';

// Canonical schema interface for all open-domain generative 3D requests
export interface Adaptive3DSceneContract {
  id: string;
  domainName: string;
  description: string;
  terrain: AdaptiveTerrainField;
  architecture?: AdaptiveArchieCompound;
  botany?: AdaptiveBotanyField;
  atmosphere: AdaptiveAtmosphere;
}
```

### Dynamic In-Memory Synthesizer
[`Adaptive3DSceneSynthesizer`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Adaptive3DSceneSynthesizer.ts):
```typescript
import { Adaptive3DSceneSynthesizer, type Adaptive3DSceneContract } from '@scratchbox/core/node';

const synthesizer = new Adaptive3DSceneSynthesizer();

// 1. The contract comes from the LLM (it writes the continuous fields from the request); there is no
//    prompt-keyword contract synthesizer. Validate it against Adaptive3DSceneContract before compiling.
const contract: Adaptive3DSceneContract = contractFromModel;

// 2. Synthesize and compile C++20 on the fly -> streams binary .glb
const result = await synthesizer.synthesizeAndCompile(contract, {
  outputGlbPath: 'desktop-app/public/models/scene_output.glb'
});

console.log(`Generated ${result.meshMetrics?.vertexCount} vertices in ${result.compilationTimeMs}ms`);
```

---

## 3. The 7 Red Lines: Anti-Patterns to Reject

| # | Anti-Pattern | Violation | ADA Remedy |
| :--- | :--- | :--- | :--- |
| **1** | Writing `scene_name.cpp` | Hardcoded Static Generator | Synthesize C++20 source in-memory via `Adaptive3DSceneSynthesizer` |
| **2** | `enum DomainType { ARCTIC, DESERT }` | Closed Taxonomy Trap | Use open continuous parameters in `Adaptive3DSceneContract` |
| **3** | `if (/arctic/i.test(prompt))` | Fragile Regex Routing | Infer parameters via latent semantic reasoning |
| **4** | Three.js fallback for procedural meshes | Quality / Performance Regression | Enforce modern C++20 SIMD / SDF / Marching Cubes via Apple Clang |
| **5** | Hardcoded titles ("Executive Summary") | Preset Infiltration | Compose all headers, narratives, and labels dynamically |
| **6** | Closed taxonomic unions (`'arctic' \| 'desert'`) | Taxonomic Choking of LLM | Use continuous dimensional schemas & open literals `(string & {})` (Pillar 8) |
| **7** | Canned asset kitbashing (`assets/*.glb`) | Static Preset Trap | Generate all geometry dynamically via procedural C++20 grammars (Pillar 10) |

---

## 4. Verification & Testing

Every ADA implementation must be verified with automated tests confirming:
1. **Open-domain schema extraction**: Valid contracts generated across diverse, orthogonal domains without code modifications.
2. **Valid C++20 syntax generation**: Source code references standard headers (`scratchbox_engine.hpp`, `scratchbox_architecture.hpp`, `scratchbox_sb_veggie.hpp`, `scratchbox_io.hpp`) with zero unresolved symbols.
3. **Clean compilation & execution**: Compiles with `NativeCppCompilerService` (`-std=c++20 -O3`) and streams valid binary glTF 2.0 (`.glb`) within seconds.

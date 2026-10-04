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
  - Botanical ecology: SB-Veggie archetypes (`ExcurrentConifer`, `DeciduousOak`, etc.), branching levels, phyllotaxis divergence, transferred envelope normals.
  - Atmospheric ephemeris: Diurnal solar zenith/azimuth, Rayleigh/Mie scattering coefficients, turbidity, Kelvin color temperatures ($1,000\text{K} - 40,000\text{K}$).
- The schemas define **structural contracts**, never static content.

### Pillar 4: Ephemeral Compilation
- **Zero Static Scene `.cpp` Files**: Never write `arctic_outpost.cpp`, `desert_temple.cpp`, or similar one-off files into `scripts/` or `src/`.
- All C++20 source code is generated dynamically in memory via `Adaptive3DSceneSynthesizer.generateCppSource(contract)`.
- Code is compiled on the fly using Apple Clang (`clang++ -std=c++20 -O3`) through `NativeCppCompilerService`, executed in a sub-process sandbox, and the binary `.glb` stream is captured directly.
- Compiling dynamically via `NativeCppCompilerService`, streaming the `.glb` directly, and retaining the source in the scene data metadata (`data.cppGenerator.sourceCode`) guarantees non-destructive reproducibility without polluting the repository. Intermediate objects and binaries are automatically cleaned up.

### Pillar 5: Open-Domain Universality
- The architecture scales seamlessly to any arbitrary prompt from the user without needing codebase modifications, new enum variants, or specialized handlers.
- New capabilities are added as continuous parameters in the schema contracts, not as new discrete cases in a classifier.

### Pillar 6: C++20 Bare-Metal Engine vs. Three.js Viewport Separation
- **Heavy Geometric Work Belongs in C++20**: Native C++ with Apple Clang (`-std=c++20 -O3`) compiles and generates 100,000+ vertices, calculates smooth envelope normals, applies noise algorithms, and serializes a standard binary `.glb` in under 200 milliseconds.
- **Three.js is a Pure Renderer/Viewport**: Three.js must never be used to procedurally construct geometry loops in browser JavaScript. Three.js is best utilized as a pure renderer and viewport, mounting the streamed `.glb`, managing the WebGL context, camera choreography, and interactive orbit controls.
- **Strict Prohibition on Toy JavaScript Primitives ("Tier-0" Ban)**: Viewports and generative pipelines must NEVER catch errors and silently fall back to Three.js primitive boxes, cylinders, or cones (`new THREE.BoxGeometry`, etc.). Stacking flat boxes is strictly banned.
- **Mandatory Geometric Complexity Floor (`GeometricComplexityGate`)**: Every procedural generative scene must pass `GeometricComplexityGate` with a strict minimum of **25,000 vertices** (5,000 for single isolated props), **15,000 triangles**, and an authentic 70-20-10 multi-mesh hierarchy.
- **Strict Two-Tier Failover**: If Tier 1 native C++20 fails at runtime, execution must fail over transparently to **Tier 2 ComfyUI (Cloud Run L4 GPU / local)**, never degrading to client-side JavaScript primitives.

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

### Pillar 9: Ephemeral Multimodal Vision Conditioning (Fast Reference -> CAD-Grade C++20)
- **The Information Entropy Gap**:
  - Short natural language prompts (e.g. *"arctic glaciated research station"*) have low information entropy, causing LLMs to collapse into generic tropes (a plain box with a radar dish).
  - 2D diffusion models (Nano Banana Lite / Imagen 3 Fast) have infinite visual variety, composition, and micro-clutter, but direct 3D diffusion produces melted, non-manifold geometry with baked-in shadows.
- **The 4-Stage Ephemeral Pipeline**:
  1. *Ephemeral 2D Draft*: Synthesize an ephemeral reference image via Nano Banana Lite / Imagen 3 Fast to a temporary scratch path.
  2. *Multimodal Vision Reverse-Engineering*: Gemini Multimodal Vision inspects the image as an architectural surveyor, translating visual forms into continuous physical fields of `Adaptive3DSceneContract` (measuring fenestration reveals, cantilevered floorplates, specific rooftop mechanical dimensions, and ridge profiles).
  3. *Immediate Cleanup / Zero Chat Clutter*: The reference image is an internal, intermediate latent representation. It is **never** shown to the user in the chat UI and is unlinked immediately upon schema extraction.
  4. *Bare-Metal C++20 Polygonization*: The C++20 engine polygonizes the schema with CAD-grade precision (sub-millimeter bevels, planar walls, authentic window reveals, 100,000+ vertices) in under 200 milliseconds.

### Pillar 10: Zero Canned Asset Libraries (Mathematical Grammars over Static Meshes)
- **Strict Prohibition on Asset Libraries (Nouns)**: The codebase must never maintain catalogues of finished `.glb` / `.obj` models (`chiller_01.glb`, `pine_tree_03.glb`). Kitbashing violates ADA and fails on novel concepts.
- **Procedural Grammars Only (Verbs)**: All spatial elements must be generated dynamically from continuous mathematical operators:
  - *Archie*: Procedural architectural operations (`extrudeSlab`, `punchRecessedOpening`, `generateLouverBay`, `createChamferedParapet`).
  - *SB-Veggie*: Algorithmic botanical branching (`apicalDominance`, `branchAngleDeg`, stem tapering, transferred envelope normals).
  - *Astra Noise*: Multi-fractal terrain harmonics (arête knife-edges, cirque hollows, scree talus noise).

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
import { Adaptive3DSceneSynthesizer } from '@scratchbox/core/node';

const synthesizer = new Adaptive3DSceneSynthesizer();

// 1. Synthesize contract from prompt (or LLM tool)
const contract = synthesizer.synthesizeContractFromPrompt(userPrompt);

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

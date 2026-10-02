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
- The binary and intermediate objects are ephemeral and cleaned up; the canonical state is preserved purely as the schema contract (`Adaptive3DSceneContract`) and the synthesized GLB asset.

### Pillar 5: Open-Domain Universality
- The architecture scales seamlessly to any arbitrary prompt from the user without needing codebase modifications, new enum variants, or specialized handlers.
- New capabilities are added as continuous parameters in the schema contracts, not as new discrete cases in a classifier.

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

## 3. The 5 Red Lines: Anti-Patterns to Reject

| # | Anti-Pattern | Violation | ADA Remedy |
| :--- | :--- | :--- | :--- |
| **1** | Writing `scene_name.cpp` | Hardcoded Static Generator | Synthesize C++20 source in-memory via `Adaptive3DSceneSynthesizer` |
| **2** | `enum DomainType { ARCTIC, DESERT }` | Closed Taxonomy Trap | Use open continuous parameters in `Adaptive3DSceneContract` |
| **3** | `if (/arctic/i.test(prompt))` | Fragile Regex Routing | Infer parameters via latent semantic reasoning |
| **4** | Three.js fallback for procedural meshes | Quality / Performance Regression | Enforce modern C++20 SIMD / SDF / Marching Cubes via Apple Clang |
| **5** | Hardcoded titles ("Executive Summary") | Preset Infiltration | Compose all headers, narratives, and labels dynamically |

---

## 4. Verification & Testing

Every ADA implementation must be verified with automated tests confirming:
1. **Open-domain schema extraction**: Valid contracts generated across diverse, orthogonal domains without code modifications.
2. **Valid C++20 syntax generation**: Source code references standard headers (`scratchbox_engine.hpp`, `scratchbox_architecture.hpp`, `scratchbox_sb_veggie.hpp`, `scratchbox_io.hpp`) with zero unresolved symbols.
3. **Clean compilation & execution**: Compiles with `NativeCppCompilerService` (`-std=c++20 -O3`) and streams valid binary glTF 2.0 (`.glb`) within seconds.

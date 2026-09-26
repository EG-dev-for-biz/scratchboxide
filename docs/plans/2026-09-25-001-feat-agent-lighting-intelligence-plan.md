---
title: Agent 3D Scene Lighting Intelligence & Inverse Photographic Matching
date: 2026-09-25
type: feat
status: draft
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Agent 3D Scene Lighting Intelligence & Inverse Photographic Matching - Plan

## Goal Capsule

- **Objective:** Equip the Scratchbox IDE Gemini Agent with comprehensive 3D scene lighting intelligence spanning planetary daylight physics, cinematic/photographic gaffer reasoning, inverse photometric photograph estimation, and closed-loop lighting alignment.
- **Product Authority:** Pinned to Scratchbox IDE's two-tier 3D architecture (C++20 Astra 3D Engine `#include "scratchbox_lighting.hpp"`, Three.js canvas stage, NOAA solar ephemeris, and GLSL de-lighting shaders). Surrounding work in video NLE synthesis and 4D avatar generation are context, not active scope.
- **Open Blockers:** None. Codebase already possesses foundations in `scratchbox_lighting.hpp`, `AtmosphereService`, `AtmosphereImageEstimationService`, `lightingRigs.ts`, and `LocationObjectLightingService`.

---

## Product Contract

### Summary

This feature establishes an end-to-end Lighting Intelligence Subsystem for Scratchbox IDE agents. It enables agents to act as autonomous "Directors of Photography" (DP) and "Gaffers": generating physically authentic daylight from planetary coordinates and timestamps, constructing motivated cinematic lighting rigs using photographic stop ratios and beam modifiers, inversely estimating the complete lighting environment from an arbitrary input photograph, and running a closed-loop photometric optimization loop that matches 3D rendered lighting to reference plates with sub-pixel shadow fidelity.

### Problem Frame

Currently, 3D scene lighting in generative environments suffers from three critical disconnects:
1. **Disconnected Presets over Photographic Craft:** Lighting is typically applied as flat static presets (`studio`, `sunset`, `noir`) without understanding motivated light sources, key-to-fill contrast ratios in photographic stops, beam diffusion, or light shaping with flags and gobos.
2. **Fragile Daylight & Non-Physical Ephemeris:** Daylight is frequently simulated with arbitrary directional lights and tint colors that violate Rayleigh/Mie scattering, Planckian blackbody diurnal curves, and real-world astronomical sun positions.
3. **Inability to Match Real Photographs:** When a user provides a reference photograph (e.g. for VFX plate compositing, architectural visualization, or Google 3D Tiles matchmoving), existing tools cannot reverse-engineer where the lights were, whether the light was hard or soft, what the ambient sky bounce was, or how to de-light baked textures to prevent double-shadowing.

The Agent Lighting Intelligence Subsystem bridges this gap by unifying physical radiative transfer, cinematographic grammar, and inverse computer vision into a cohesive, agent-executable pipeline.

### Key Decisions

- **Unify Natural and Studio Lighting under a Common Photometric Rig Schema:** Rather than treating daylight and studio lighting as disjoint systems, all lights (sun, sky dome, softboxes, practical lamps, kickers) are expressed in physically grounded photometric units (lux, lumens, candelas, correlated color temperature in Kelvin, and beam angles). *(session-settled: user-directed — chosen over separate isolated daylight vs studio tools: enables seamless hybrid lighting like interior window daybeams plus interior tungsten practicals)*. Governs R1, R2, R4.
- **Four-Stage Inverse Photometric Decomposition for Photograph Matching:** When ingesting a photograph, the agent executes four complementary estimators: (1) shadow back-projection raycasting, (2) surface normal-irradiance gradient fitting ($\mathbf{N} \cdot \mathbf{L}$), (3) specular highlight/catchlight triangulation, and (4) spherical harmonics ($L_{lm}$) for ambient diffuse environment fill. Governs R5, R6, R7, R8.
- **Closed-Loop Iterative Lighting Optimizer (Analogous to 6-DOF Camera Resection):** Rather than stopping at a one-shot estimation, the agent renders candidate 3D plates and iteratively adjusts lighting parameters (elevation, azimuth, intensity, softness, Kelvin) via coordinate descent to minimize photometric residual error against the reference image. Governs R9, R10.
- **Mandatory Albedo De-Lighting for Photogrammetric 3D Meshes:** When applying matched lighting to real-world 3D tiles (Google Photorealistic 3D Tiles), the system applies non-linear GLSL shadow lifting and highlight compression (`LocationObjectLightingService`) to eliminate double-shadowing and burnt-in sun bleaching. Governs R11.

---

### Requirements

#### Planetary Daylight & Atmospheric Radiometry

- R1. The engine calculates sub-arcminute astronomical solar elevation and azimuth from geographic latitude, longitude, and ISO 8601 timestamps using high-precision NOAA solar ephemeris equations.
- R2. The atmosphere renderer computes wavelength-dependent Rayleigh scattering ($\beta_R(\lambda) \propto \lambda^{-4}$), aerosol forward Mie scattering, and turbidity to synthesize dynamic sky domes matching the Perez and Hosek-Wilkie sky models.
- R3. The lighting system maps solar elevation across 10 diurnal lighting phases to calculate correlated color temperature (CCT) along the Planckian blackbody locus (1,800K to 40,000K), direct lux, ambient sky bounce, and shadow softness.
- R4. The daylight pipeline renders dynamic volumetric Worley noise clouds, projects analytical cloud shadows along the solar vector $\mathbf{L}$ onto ground terrain, and injects crepuscular god rays and Beer-Lambert aerial perspective haze extinction.

#### Cinematic & Photographic Gaffer Engine

- R5. The agent reasons about "motivated lighting" by identifying natural openings (windows, skylights) and practical fixtures (lamps, monitors, candles, streetlights) within the scene graph to anchor light placements.
- R6. The gaffer system provides parametric photographic modifiers: area softbox diffusion (tunable penumbra width), barn door beam shaping, snoots, and gobo/cookie texture projection (Venetian blinds, tree foliage dappling, window mullions).
- R7. The gaffer system enforces configurable Key-to-Fill lighting ratios expressed in photographic stops: 1:1 (high-key commercial/product), 2:1 (standard cinematic portrait), 4:1 (dramatic narrative), and 8:1 to 16:1 (low-key film noir).
- R8. The gaffer system supports classical portrait and cinematic lighting configurations: Rembrandt chiaroscuro (45° key producing triangle cheek highlight), Split (90° hard lateral key), Paramount/Butterfly (high frontal key with nose shadow), Loop, Broad vs. Short lighting, and dual-rim complementary accent kickers.

#### Inverse Photometric Photograph Estimation

- R9. The agent analyzes an input photograph to detect cast shadows, contact shadows, and shadow penumbra sharpness, back-projecting shadow edge rays through scene depth to estimate dominant light vectors $(\theta_{\text{elev}}, \phi_{\text{azim}})$ and angular source diameter.
- R10. The agent inspects specular highlights and catchlights in reflective surfaces (corneas/eyes, polished metals, glass, wet roads) to determine light source geometry and 3D positions.
- R11. The agent fits surface normal variations ($\mathbf{N}$) against pixel luminance to estimate directional illumination and extracts order-3 (9 coefficients per RGB channel) Ramamoorthi Spherical Harmonics for ambient diffuse fill.
- R12. The agent synthesizes an out-of-frame 360° high-dynamic-range environment map (HDRI) from the perspective photograph using generative panoramic inpainting to supply authentic off-screen reflections and fill radiance.
- R13. The pipeline automatically applies analytical GLSL de-lighting shaders (non-linear shadow lift, highlight compression, and calibrated stone/material albedo) to 3D photogrammetric tiles to prevent double-shadowing when synthetic lights are introduced.

#### Closed-Loop Lighting Matchmove & Verification

- R14. The closed-loop lighting optimizer renders candidate 3D viewport plates and computes a multi-channel difference metric against the reference photograph: shadow boundary correlation, luminance histogram delta, and Planckian chromaticity residual.
- R15. The optimizer iteratively perturbs light vectors, intensities, Kelvin temperatures, and cone softness via coordinate descent until shadow penumbras and tonal gradients reach $\ge 95\%$ photometric similarity.
- R16. Every lighting configuration must pass the 8-Dimension Visual Fidelity Rubric (`visual-critic`), ensuring directional contact shadows, radiometric Kelvin harmonization, zero pitch-black void backdrops, and photorealistic depth integration.

---

### Key Flows

- F1. Autonomous Daylight Scene Construction
  - **Trigger:** User or agent specifies a location, date, time of day, or atmospheric mood (e.g., "Athens Acropolis at 5:45 PM in mid-October, hazy golden hour").
  - **Actors:** Gemini Agent, NOAA Ephemeris Service, AtmosphereService.
  - **Steps:**
    1. Resolve geodetic coordinates and capture timestamp.
    2. Compute NOAA solar elevation, azimuth, and diurnal phase (Golden Hour).
    3. Fit Planckian Kelvin temperature (~2,400K direct, ~8,500K ambient sky).
    4. Configure Rayleigh/Mie scattering dome, turbidity, and aerial perspective extinction.
    5. Attach directional sun with soft cascaded shadow maps and ambient sky hemisphere.
  - **Covered by:** R1, R2, R3, R4.

- F2. Cinematic Studio & Dramatic Scene Rigging
  - **Trigger:** User requests cinematic lighting for a character, car, or interior scene (e.g., "Dramatic Rembrandt lighting with warm practical desk lamp and cool window rim").
  - **Actors:** Gemini Agent, Cinematic Gaffer Operator Engine.
  - **Steps:**
    1. Scan scene graph for hero subject bounding box and camera framing.
    2. Place motivated practical lamp (3,000K point light) and cool window fill (7,500K directional/area).
    3. Position Rembrandt Key spot light at 45° horizontal and 45° vertical to subject facade.
    4. Compute Fill light intensity to establish exact 4:1 (2-stop) contrast ratio.
    5. Add subtle Hair/Rim kicker from rear oblique angle to pop subject from dark background.
    6. Attach gobo cookie to key light casting subtle window blind shadows.
  - **Covered by:** R5, R6, R7, R8.

- F3. Inverse Photograph Matching & Closed-Loop Alignment
  - **Trigger:** User provides a reference photograph and asks to match its lighting in a 3D scene or on a Google 3D Tiles mesh.
  - **Actors:** Gemini Agent, Inverse Lighting Estimator, Silhouette Software Rasterizer, Closed-Loop Optimizer.
  - **Steps:**
    1. Decompose photo into sky luminance, cast shadow edges, and specular catchlights.
    2. Extract dominant light vectors and estimate penumbra softness (hard sun vs diffuse overcast).
    3. Solve order-3 Spherical Harmonics for ambient sky/ground bounce.
    4. If photogrammetric mesh present, apply GLSL de-lighting shader to neutralize baked noon sunlight.
    5. Render candidate 3D plate with initial lighting rig.
    6. Compute shadow overlap score, histogram error, and chromaticity delta.
    7. Execute coordinate descent loop (adjusting light angles $\pm 2^\circ$, intensity $\pm 5\%$, Kelvin $\pm 100\text{K}$) until photometric overlap $\ge 95\%$.
    8. Audit final rendered buffer against `visual-critic` rubric.
  - **Covered by:** R9, R10, R11, R12, R13, R14, R15, R16.

---

### Acceptance Examples

- AE1. Golden Hour Historical Validation
  - **Covers:** R1, R3
  - **Given:** Coordinates $41.8902^\circ\text{ N}, 12.4922^\circ\text{ E}$ (Colosseum, Rome) and timestamp `2026-06-21T18:30:00Z`.
  - **When:** Solar ephemeris and diurnal profile are computed.
  - **Then:** Sun elevation is within $[10^\circ, 14^\circ]$, azimuth is within $[285^\circ, 300^\circ]$, diurnal phase is `golden_hour`, direct solar Kelvin is within $[2,200\text{K}, 2,700\text{K}]$, and ambient sky fill is $>7,500\text{K}$.

- AE2. 4:1 Dramatic Portrait Contrast Ratio
  - **Covers:** R7, R8
  - **Given:** A scene with a character avatar and a request for "dramatic portrait lighting".
  - **When:** The agent configures a 4:1 key-to-fill rig.
  - **Then:** Key light illuminance is exactly $4.0\times$ (+2 photographic stops) of the fill light illuminance on the subject's face, key light angle creates Rembrandt triangle catchlight on cheek, and fill light casts zero conflicting second shadow.

- AE3. Inverse Photograph Shadow & Sun Vector Resection
  - **Covers:** R9, R14, R15
  - **Given:** A photograph of an architectural plaza with a visible cast shadow from a vertical plinth.
  - **When:** The inverse lighting estimation and closed-loop optimizer run against the 3D model.
  - **Then:** Synthetic shadow direction matches photograph shadow direction within $<1.5^\circ$, shadow penumbra softness matches within $<5\%$ blur radius difference, and overall photometric correlation exceeds $95\%$.

- AE4. De-Lighted Google 3D Tile Ingestion
  - **Covers:** R13, R16
  - **Given:** Google Photorealistic 3D Tiles of a city district with harsh baked noon shadows.
  - **When:** Sunset lighting (elevation $8^\circ$) is applied with `atmosphere_harmonize_location_3d`.
  - **Then:** Baked dark crevices are lifted by factor $\ge 0.60$, noon specular highlights are compressed by factor $\ge 0.45$, and the new sunset low-angle light and long shadows render without dark double-shadow artifacts.

---

### Scope Boundaries

#### In Scope
- Physical daylight ephemeris, atmospheric scattering, and diurnal radiometry.
- Cinematic and photographic lighting rigs (3-point, Rembrandt, butterfly, split, kickers, practicals).
- Photographic modifier simulations (softboxes, penumbra softness, barn doors, gobos, stop ratios).
- Inverse photometric estimation from photographs (shadow tracing, specular catchlights, spherical harmonics).
- Out-of-frame 360° HDR environment synthesis / inpainting.
- Photogrammetric de-lighting shader integration.
- Closed-loop iterative photometric alignment optimizer.

#### Out of Scope
- Full offline Monte Carlo path tracing engines (Scratchbox operates at real-time 60 FPS WebGL / Three.js and headless software rasterization).
- Non-optical physics (e.g. thermal infrared or ultraviolet non-visible imaging).
- Camera hardware sensor fabrication simulation (focus is on photographic lighting and exposure, not semiconductor CMOS design).

---

### Outstanding Questions

- Deferred to Planning: Should the 360° HDR environment synthesis use a local lightweight spherical harmonics inpainting pipeline (Tier 1 native) or dispatch to the Cloud Run ComfyUI L4 GPU service (Tier 2) when complex multi-room interior panoramas are needed? Resolved in KTD4: local 9-coefficient spherical harmonics for Tier 1 native; optional ComfyUI outpainting when requested.
- Deferred to Planning: What is the optimal software rasterizer resolution for the closed-loop lighting optimizer iterations? Resolved in KTD2: hierarchical multiscale optimization ($128\times 128$ for coarse angle search in $<2\text{ms}$, refining to $512\times 512$ for final shadow penumbra convergence).

---

## Planning Contract

### Approaches Considered

1. **Approach A: Pure LLM Text-to-Parameter Prompting (Rejected)**
   - *Description:* Agent generates raw Three.js code with hardcoded numbers in prompt responses.
   - *Drawbacks:* No physical grounding, frequent hallucination of RGB colors, no validation against shadow boundaries or ground-truth physics.
2. **Approach B: Offline Monte Carlo Inverse Path Tracer (Rejected)**
   - *Description:* Run heavy offline Mitsuba or Blender Cycles inverse rendering via python subprocesses.
   - *Drawbacks:* Latencies exceed 45–120 seconds per frame, impossible to run interactively in the web canvas stage or automated CI.
3. **Approach C: Hybrid Photometric Analytical Engine + Pure Node.js Closed-Loop Optimizer (Selected)**
   - *Description:* Use exact analytical formulas (NOAA, Planckian CCT, Rayleigh/Mie) and photographic stop ratios for instant feed-forward synthesis, coupled with pure Node.js headless software rasterization (`HeadlessMeshSilhouetteRenderer`) for sub-millisecond iterative closed-loop shadow alignment.
   - *Benefits:* Sub-second execution, 100% type-safe, runs identically in browser Three.js and headless CLI, zero heavy external GPU/driver dependencies.

### Key Technical Decisions (KTDs)

- **KTD1: Unified Photometric AST Schema (`PhotometricLightingRigData`)**
  - All lights are represented in a declarative JSON AST capturing: `type` (`directional`, `point`, `spot`, `area_rect`), `photometric`: `{ lux, lumens, candelas, kelvin, exposureStops }`, `beam`: `{ innerConeRad, outerConeRad, penumbraSoftness, barnDoors, goboTexture }`, and `motivation`: `{ sourceEntityId, description }`.
  - Governs R1, R3, R5, R6, R7, R8.
- **KTD2: Hierarchical Multiscale Closed-Loop Shadow & Penumbra Optimizer**
  - Uses the existing pure Node.js software rasterizer (`HeadlessMeshSilhouetteRenderer.ts`) at 2 scales: coarse $128\times 128$ ($<2\text{ms}$/eval) to resect dominant azimuth and elevation over a $\pm 45^\circ$ cone, followed by fine $512\times 512$ coordinate descent for sub-degree alignment and penumbra softness matching.
  - Governs R9, R14, R15.
- **KTD3: Decoupled 4-Tier Inverse Photograph Decomposition**
  - Decomposes photo into:
    1. Solar/Key locus via sky gradient peak luminance and cast shadow back-projection.
    2. Shadow penumbra width $\Delta w$ fitted to angular light diameter $\alpha \approx \frac{\Delta w}{d_{\text{shadow}}}$.
    3. Order-3 (9 coefficients per channel) Ramamoorthi Spherical Harmonics ($L_{lm}$) for ambient diffuse irradiance.
    4. Corneal / specular highlight triangulation for multi-light studio scenes.
  - Governs R9, R10, R11, R12.
- **KTD4: Seamless Albedo De-Lighting Integration**
  - Before applying matched photographic lighting to Google 3D Tiles, automatically inject `LocationObjectLightingService.applyPhotogrammetricDelightShader` to lift crushed dark crevices ($u_{\text{shadowLift}} = 0.60$) and compress baked specular noon sun ($u_{\text{highlightCompress}} = 0.45$), preventing double-shadow artifacts.
  - Governs R13, R16.
- **KTD5: Modular Tool Pack `lighting-tools.ts`**
  - Following the Megaservice Deconstruction Directive, tool declarations and execution handlers are encapsulated in `packages/core/src/node/gemini/tools/lighting-tools.ts`, registered dynamically in `ToolRegistry` and exposed through `task-capability-resolver.ts`.
  - Governs R1–R16.

### Preflight Validations

- Clang++ C++20 toolchain is validated for `scratchbox_lighting.hpp` (`-std=c++20 -O3`).
- Pure Node.js rasterizer `HeadlessMeshSilhouetteRenderer` is operational without headless Chrome dependency.
- Existing tests in `packages/core/test/atmosphere-image-estimation.test.ts` and `packages/core/test/location-lighting-atmosphere.test.ts` pass green.

---

## Implementation Units

### U1. Core Photometric Units, Photographic Stops & CCT Radiometry
- **Goal:** Establish foundational math for photometric units (lux, lumens, candelas, EV stops, key-to-fill ratios) and high-precision Planckian locus CCT calculations in TypeScript and C++20.
- **Files to Modify/Create:**
  - `packages/core/src/common/spatial/photometric-units.ts` (create: conversions between lux, candelas, lumens, EV, and stop ratios)
  - `packages/core/src/native/3d-engine/include/scratchbox_lighting.hpp` (update: expose stop ratio solvers and penumbra spread calculations)
  - `packages/core/src/common.ts` (export photometric unit types)
- **Requirements Covered:** R1, R3, R7
- **Test Scenarios:**
  - Unit test verifying 1 stop increase doubles illuminance ($2.0\times$ lux).
  - Unit test verifying 4:1 key-to-fill ratio corresponds to exactly 2 stops delta.
  - Unit test verifying Kelvin-to-linear-sRGB matches CIE 1931 D-illuminant standards from 1,800K to 12,000K.

### U2. Photographic Gaffer Engine & Beam Modifiers
- **Goal:** Implement the "Gaffer Engine" providing motivated lighting placement, photographic modifiers (softbox diffusion, barn doors, snoots, gobo cookies), and classical portrait configurations (Rembrandt, Split, Butterfly, Loop).
- **Files to Modify/Create:**
  - `packages/core/src/browser/generative-canvas/services/atmosphere/LightingGafferService.ts` (create: DP reasoning, motivated placement, modifier generation)
  - `packages/core/src/browser/generative-canvas/primitives/scene3d/lightingRigs.ts` (update: extend cinematic rigs with parametric modifiers and stop ratios)
  - `packages/core/src/browser/generative-canvas/services/operators/lighting-camera-operators.ts` (update: register `sb_configure_gaffer_rig` operator)
- **Requirements Covered:** R5, R6, R7, R8
- **Test Scenarios:**
  - Verify `LightingGafferService.buildRig('rembrandt', { stopRatio: 4.0 })` configures 45° key and exact 2-stop fill.
  - Verify gobo texture generation produces clean window blind and foliage stencil decals.
  - Verify softbox diffusion calculation correctly adjusts Three.js spotlight `penumbra` and shadow radius.

### U3. Inverse Photometric Photograph Decomposer
- **Goal:** Implement inverse computer vision estimators that extract light vectors, penumbra sharpness, specular catchlights, and order-3 Spherical Harmonics from reference photographs.
- **Files to Modify/Create:**
  - `packages/core/src/node/spatial/InverseLightingEstimatorService.ts` (create: shadow raytracing, catchlight analysis, normal-irradiance fitting)
  - `packages/core/src/browser/generative-canvas/services/atmosphere/AtmosphereImageEstimationService.ts` (update: integrate with `InverseLightingEstimatorService`)
  - `packages/core/src/node.ts` (export `InverseLightingEstimatorService`)
- **Requirements Covered:** R9, R10, R11, R12, R13
- **Test Scenarios:**
  - Verify shadow back-projection recovers known light azimuth within $\pm 2^\circ$ on test ground plate.
  - Verify eye/cornea catchlight detector triangulates key light elevation and horizontal offset.
  - Verify 9-coefficient Ramamoorthi Spherical Harmonics fit ambient sky/ground bounce correctly from input raster.

### U4. Closed-Loop Photometric Matchmove Optimizer
- **Goal:** Implement the closed-loop optimization engine that renders candidate 3D plates and iteratively adjusts lighting parameters to achieve $\ge 95\%$ photometric similarity.
- **Files to Modify/Create:**
  - `packages/core/src/node/spatial/ClosedLoopLightingOptimizerService.ts` (create: multi-channel difference metric, coordinate descent optimizer)
  - `packages/core/src/node/spatial/HeadlessMeshSilhouetteRenderer.ts` (update: support fast shadow mask and penumbra depth buffer extraction)
- **Requirements Covered:** R14, R15, R16
- **Test Scenarios:**
  - Verify optimizer converges to ground-truth light vector within 25 iterations on synthetic test benchmark.
  - Verify multi-channel metric computes shadow boundary correlation and Planckian chromaticity error with sub-pixel sensitivity.

### U5. Gemini Agent Domain Pack & Operator Routing
- **Goal:** Expose the complete lighting intelligence capabilities to the Gemini Agent via structured function-calling tools and the Direct Dispatch Operator Engine.
- **Files to Modify/Create:**
  - `packages/core/src/node/gemini/tools/lighting-tools.ts` (create: `lighting_estimate_from_photo`, `lighting_configure_gaffer_rig`, `lighting_optimize_closed_loop`, `lighting_harmonize_daylight`)
  - `packages/core/src/node/gemini/tool-registry.ts` (update: register lighting tool pack)
  - `packages/core/src/node/agent/task-capability-resolver.ts` (update: route lighting and photographic matching prompts to native Tier 1 engine)
- **Requirements Covered:** R1–R16
- **Test Scenarios:**
  - Verify `task-capability-resolver` identifies "match photograph lighting" as a native Tier 1 capability.
  - Verify `lighting_estimate_from_photo` tool handler returns complete `PhotometricLightingRigData` JSON.

### U6. Verification Test Suite & Visual Critic Integration
- **Goal:** Build comprehensive automated regression tests and audit rules adhering to the Visual Critic 8-Dimension Rubric.
- **Files to Modify/Create:**
  - `packages/core/test/agent-lighting-intelligence.test.ts` (create: end-to-end unit and integration test suite)
  - `docs/features/agent_lighting_intelligence_guide.md` (create: architecture and DP gaffer documentation)
- **Requirements Covered:** R1–R16, AE1–AE4
- **Test Scenarios:**
  - Golden hour historical ephemeris test (AE1).
  - 4:1 dramatic portrait contrast ratio test (AE2).
  - Inverse photograph shadow & sun vector resection test (AE3).
  - Google 3D Tile de-lighting test (AE4).

---

## Verification Contract

### Automated Test Suite
- Run the dedicated lighting intelligence test suite:
  ```bash
  npm run test -- packages/core/test/agent-lighting-intelligence.test.ts
  ```
- Run the full spatial and atmosphere test suites to guarantee zero regression:
  ```bash
  npm run test -- packages/core/test/atmosphere-image-estimation.test.ts
  npm run test -- packages/core/test/location-lighting-atmosphere.test.ts
  ```
- Run typecheck across the monorepo:
  ```bash
  npm run typecheck
  ```

### Manual Visual Validation & Visual Critic
- Render test scene comparing ground-truth photograph against synthetic 3D model with matched lighting.
- Capture side-by-side screenshot and evaluate against the 8-Dimension Visual Fidelity Rubric:
  1. Directional shadow congruence ($\ge 95\%$ penumbra and angle alignment).
  2. Radiometric Planckian Kelvin harmonization across surfaces.
  3. Contact ambient occlusion grounding subject to floor.
  4. Zero double-shadow artifacts on photogrammetric 3D tiles.

---

## Definition of Done

- All 16 requirements (R1–R16) are verified and covered by Implementation Units U1–U6.
- Acceptance Examples AE1, AE2, AE3, and AE4 pass with 100% green assertions in automated tests.
- Tool handlers for `lighting_estimate_from_photo`, `lighting_configure_gaffer_rig`, `lighting_optimize_closed_loop`, and `lighting_harmonize_daylight` are registered and callable via Gemini function calling.
- Typecheck passes cleanly with zero errors.
- Visual Critic audits confirm photorealistic visual fidelity with zero floating geometry or ungrounded shadows.

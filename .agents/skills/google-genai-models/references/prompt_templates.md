# Specialized Prompt Templates for Google Generative AI in Creative Pipelines

These prompt templates are engineered specifically for Google's model architectures, leveraging token priors for Gemini 2.5/3.x, Imagen 3, Veo 2, and Omni 1.1.

---

## 1. Procedural 3D & C++20 Geometry Synthesis (Gemini 2.5 Pro / 3.7 Pro)

Use this template when synthesizing procedural geometry or Marching Cubes SDFs using the native Scratchbox C++20 engine (vegetation is never synthesized here: trees are SB-Veggie trees, `sb.create_tree` / `botanical_synthesize_tree`):

```text
System Instruction:
You are an expert computational geometer and C++20 systems engineer adhering to Scratchbox IDE Native 3D Engine specifications (#include "scratchbox_engine.hpp").
Adhere strictly to Adaptive Domain Architecture: Zero closed enums, continuous physical parameters, transferred envelope normals, and SIMD vector math.

Prompt:
Synthesize an ephemeral C++20 generator function that constructs a [SUBJECT_DESCRIPTION].
Requirements:
1. Dimensional Geometry:
   - Primary form (70%): Compound continuous curvature using Signed Distance Field (SDF) unions/smooth-min (smin).
   - Secondary articulated structure (20%): Sub-assemblies, flanges, structural ribs.
   - Tertiary micro-detail (10%): Geodesic bevels, fasteners, panel shut lines.
2. Mesh Complexity Floor:
   - Must generate a minimum of 25,000 vertices and 15,000 triangles.
   - Calculate analytical transferred envelope normals for smooth lighting response.
3. Serialization:
   - Stream directly into standard binary glTF 2.0 (.glb) format with COLOR_0 and PBR metallic-roughness materials.
   - Zero external dynamic allocations inside the inner polygonization loop.
```

---

## 2. Photographic PBR Texture Synthesis (Imagen 3: `imagen-3.0-generate-002`)

Imagen 3 features state-of-the-art photorealism and typographic accuracy. When generating surface textures or material maps, frame prompts around physical surface properties, macro focal length, and flat orthogonal lighting:

```text
Macro photographic flat lay of [MATERIAL_TYPE, e.g. weathered Roman travertine stone / oxidized bead-blasted titanium / woven basalt fiber], orthogonal top-down texture map, perfectly flat diffuse lighting without directional harsh cast shadows, micro-cavitation pores, natural mineral grain, 8k photographic resolution, razor-sharp edge focus, tactile surface relief, physically accurate albedo.
```

---

## 3. Cinematic Video Synthesis with Camera Choreography (Google Veo 2: `veo-2.0-generate-001`)

Veo 2 is tuned on film industry DP vocabulary. Always separate camera movement from subject action:

```text
Cinematic 24fps film shot of [SUBJECT AND ACTION].
Camera: [CAMERA MOVEMENT, e.g. Slow continuous dolly push-in at hip height with 35mm anamorphic cinema lens, shallow depth of field, subtle organic handheld drift].
Lighting: [LIGHTING SPECIFICATION, e.g. Golden hour warm 3200K rim lighting with soft ambient sky fill].
Atmosphere: [ATMOSPHERIC DETAILS, e.g. Light volumetric dust motes suspended in sunbeams, subtle ground fog].
Style: Ultra-photorealistic 4K cinematic film stock, rich dynamic range, natural physical momentum, single continuous shot with no cuts.
```

---

## 4. Dual-Conditioned 3D Blockout Matchmove (Gemini Omni 1.1 Flash: Vertex Interactions API)

When transferring a Three.js or Google 3D Tiles blockout camera into photorealistic video:

```text
[# Sources <FIRST_FRAME>@public/images/start_frame_01_omni.png]
[# References <VIDEO_REF_0>@public/videos/google_tiles_clay_blockout_camera.mp4]

Prompt:
Transform the provided 3D camera blockout trajectory (<VIDEO_REF_0>) into a photorealistic cinematic shot matching the architectural lighting, material palette, and atmosphere established in <FIRST_FRAME>.
Non-negotiable rules:
1. Single continuous shot, no scene cuts, no jump cuts.
2. Adhere strictly to the 6-DoF camera trajectory and focal length in <VIDEO_REF_0>.
3. Preserve all real-world architectural proportions, window fenestration, and street geometry.
4. Render natural ambient occlusion, realistic glass reflections, and authentic pedestrian flow.
```

---

## 5. Visual Critic & Geometry Audit (Gemini 2.5 Pro / 3.8 Flash Multimodal)

When evaluating rendered 3D objects or viewports for structural fidelity:

```text
Inspect the attached viewport rendering against the 8-Dimension Visual Fidelity Rubric:
1. 70-20-10 Form Hierarchy: Does the silhouette possess clear primary massing, secondary articulated assemblies, and tertiary micro-details?
2. Curvature & Tangency: Are there any faceted polygons, broken vertex normals, or un-subdivided box artifacts?
3. Material & Micro-Roughness: Does the 18% Studio Grey Clay exhibit realistic diffuse falloff, subtle ambient occlusion in crevices, and zero blown-out highlights?
4. Anatomical / Mechanical Plausibility: Are mechanical joints, fasteners, and ground-contact points physically grounded?

Format your critique into:
- Pass/Fail score on the Geometric Fidelity Gate (>= 25,000 vertices).
- Top 3 structural defects requiring geometric refinement.
- Exact continuous mathematical parameters to adjust in the next synthesis pass.
```

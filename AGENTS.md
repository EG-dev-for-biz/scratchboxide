# Scratchbox IDE Agent Directives

## Two-Tier Problem-Solving Directive (VFX, 3D & Generative Tasks)

### Rule: App Capabilities First -> ComfyUI Service Fallback
When a user attempts to accomplish something specific (especially VFX-related, 3D-related, or generative):
1. **Tier 1: Look Through Current App Capabilities First**:
   - Inspect what Scratchbox IDE can natively do via coding, pipelines, attached skills, and Google models:
     - **3D**: Primary path is C++20 via Scratchbox 3D engine (`#include "scratchbox_engine.hpp"`), Apple Clang (`-std=c++20 -O3`), SIMD math, SDFs, Marching Cubes, FastNoise3D, streaming binary `.glb`, and Google Photorealistic 3D Tiles (`GLTFExporter`). Fall back to Three.js customScript/shaders if needed.
     - **VFX & Video**: Native Video Timeline NLE (`video-timeline`, `videoTimelineSynthesizer`), 6-DOF camera solve matchmoving (`VfxPlateMatchmoveService.interpolateCameraSolve`), Brown-Conrady lens undistortion, NOAA geodetic solar ephemeris tracking (`getSolarPosition`), anti-drift holdout mattes (`destination-out`), and composite WebGL layer rendering (`Video3DLayerRenderer`).
     - **Google Models**: Gemini 3.7 / 2.5 high-reasoning multimodal inspection, Imagen image generation (`generate_image`), and Vertex AI.
     - **Attached Skills & Tools**: Canvas primitives (`3d-scene`, `video-timeline`, `live-code-sandbox`, `node-graph`), Generative UI, modern web, Chrome DevTools, Google Maps Platform.
2. **Tier 2: Resort to Spinning Up a ComfyUI Solution if Incapable**:
   - If and ONLY if the native app capabilities and Google models are not capable (e.g. requires neural image-to-3D diffusion like Trellis/TripoSR, neural video-to-video restyling like Omni/AnimateDiff, monocular dense depth estimation like Marigold, or specialized custom LoRAs/checkpoints):
   - Explicitly resort to spinning up a solution on the ComfyUI service!
   - Execute via `comfyui_research_pipeline` / `comfyui_execute_pipeline` (routing to Google Cloud Run with NVIDIA L4 GPU acceleration or local), dynamically synthesize any missing Python custom nodes (`comfyui_inject_dynamic_code`), and stream the resulting 3D GLB mesh, PBR texture maps, or restyled video back into the canvas stage.

### Rule: Programmatic Two-Tier Execution & Transactional Failover
1. **Canonical API & Agent Tool**:
   - **Agent Tool**: `resolve_task_capability({ userGoal, promptContext })` assesses whether a prompt is natively feasible in Tier 1 or requires Tier 2 ComfyUI.
   - **Programmatic Executor**: `ComfyUiPipelineAgent.executeWithTwoTierFallback<T>(prompt, nativeExecutor, comfyExecutor)` from `@scratchbox/core` and `@scratchbox/core/node`.
   - **Typed Return Contract**: `TwoTierExecutionResult<T>` (`tier: 'tier1-native' | 'tier2-comfyui'`, `success: boolean`, `result: T`, `attempts: string[]`).
2. **Transactional Failover Semantics**:
   - If the task is assessed as natively feasible, Tier 1 is attempted first.
   - If Tier 1 encounters an unexpected runtime error (e.g., C++ Clang compilation failure, missing driver, or GPU allocation fault), the pipeline must NEVER fail the user task; it must automatically and transparently fail over to Tier 2 ComfyUI execution.


## 3D Engine Architecture & Implementation Directive

### Rule: Lean on C/C++ First for 3D

When implementing 3D (scenes, models, procedural geometry, terrain generation, spatial physics, or visual effects):
23: 1. **Primary Generation Path (C/C++20)**:
24:    - Always prioritize modern C++20 via the native Scratchbox 3D Engine (`#include "scratchbox_engine.hpp"`).
25:    - Use high-performance SIMD vector math (`scratchbox_math.hpp`), Signed Distance Fields (SDFs), Marching Cubes polygonization, FastNoise3D (Perlin/FBM/Worley), and physical material assignment.
26:    - Procedural C++ modules compile via Apple Clang / modern C++ toolchain (`process.env.CXX || 'clang++' -std=c++20 -O3`) through `NativeCppCompilerService`.
27:    - To prevent `SIGILL` illegal instruction faults across containerized CI, Cloud Run, and heterogeneous macOS/Linux architectures, `-march=native` is conditioned strictly behind `process.env.SCRATCHBOX_NATIVE_ARCH === '1'`.
28:    - Native binaries stream binary glTF 2.0 (`.glb`) chunks containing vertices, normals, UVs, vertex colors (`COLOR_0`), and PBR metallic-roughness materials directly into the Three.js viewport.
29:    - Attach or preserve the generator source code in `data.cppGenerator.sourceCode` (`world_generator.cpp`).
30: 
31: 2. **Secondary / Fallback Path (Three.js / WebGL / TS)**:
32:    - Only use alternative methods (such as Three.js `customScript`, client-side WebGL/WGSL shaders, or TypeScript geometry builders) when:
33:      - Native C/C++ compilation tools (Clang) are explicitly unavailable in the environment.
34:      - The user explicitly requests pure browser client-side scripts.
35:      - Performing lightweight viewport camera choreography, UI overlays, or non-geometric DOM manipulations.
36: 
37: ## 3D Tile & Mesh Ingestion Quality Directive
38: 
39: ### Rule: Always Download Highest Quality Mesh & Convert to GLB
40: When fetching, downloading, or ingesting real-world 3D meshes (e.g. from Google Photorealistic 3D Tiles / Geospatial APIs, Cesium, or photogrammetry sources) to work with:
41: 1. **Always Demand Maximum Quality (Deepest Leaf LOD)**:
42:    - Configure the tile streamer with the tightest geometric error budget (`errorTarget = 0.5` or lower) and calculate Screen-Space Error (SSE) against high-resolution viewports (4K $3840 \times 2160$ resolution).
43:    - Never settle for coarse root or intermediate octree LODs; always wait for leaf tile streaming to fully settle (`stats.downloading === 0 && stats.parsing === 0`) to guarantee maximum geometric fidelity, sharp architectural feature edges, and authentic textures.
44: 2. **Convert Directly to Standard Binary glTF 2.0 (`.glb`)**:
45:    - Extract and isolate the target submeshes (preserving position, vertex normals, UVs, and photogrammetric textures) within the target bounding volume or geofence.
46:    - Package immediately into standardized binary glTF 2.0 (`.glb`) via `GLTFExporter({ binary: true })` or native glTF packer.
47:    - Standardize `.glb` as the canonical input for all downstream native C++20 engine pipelines (e.g., UTDRA decomposition, half-edge topology extraction, and 4-RoSy field-aligned quad remeshing).
48: 3. **Preserve Raw High-Resolution Assets**:
49:    - Always persist the extracted high-resolution raw mesh (e.g., `public/models/..._raw.glb` or `public/tiles/...`) to maintain reproducible, non-destructive workflows from the highest-quality source.
50: 
51: ### Rule: Dual Dedicated 3D Object APIs & Zero Presets
52: When retrieving real-world locations or addresses as 3D models from Google Maps Photorealistic 3D Tiles:
53: 1. **Two Dedicated Separate APIs**:
54:    - `getGoogle3DTilesFullTexture(queryOrCoords, options)` / `google_3d_tiles_get_full_texture`: Ingests full photogrammetric PBR textures.
55:    - `getGoogle3DTilesClay(queryOrCoords, options)` / `google_3d_tiles_get_clay`: Ingests studio grey clay volumetric massing.
56:    - Both return standard binary glTF 2.0 (`.glb`) buffer (`glbBuffer`), disk path (`glbPath`), geometric mesh statistics (`mesh.vertexCount`, `mesh.triangleCount`), and render frames.
57: 2. **Strict Zero Presets & Zero Procedural Fallback**:
58:    - Never use static landmark dictionary lookups or artificial coordinate hashes.
59:    - Queries must supply explicit geodetic coordinates or an active Google Maps API key for geocoding.
60:    - Any query lacking coordinates or geocoding credentials must throw an actionable error.
61: 3. **Headless Blockout Runner Isolation & Ephemeral Port Allocation**:
62:    - Dynamic ephemeral port binding (`server.listen(0)` -> `actualPort`) avoids port collisions during concurrent test or pipeline runs.
63:    - Runner files are generated uniquely per run (`s4d_tile_blockout_runner_${timestamp}_${rand}.html`) and automatically unlinked upon pipeline completion or process exit.
64:    - Headless Chrome and FFmpeg executables are auto-discovered across macOS and Linux standard paths.

### Rule: Google 3D Tiles Clay Mode as Canonical Blockout Runner (<VIDEO_REF_0>)
When providing 3D spatial blockouts for video generation, camera trajectory conditioning, or generative restyling with Gemini Omni / Vertex AI:
1. **Google Maps 3D Tiles Clay Mode is Canonical**:
   - Always prefer the automated headless Google Maps 3D Tile Clay Blockout Runner (`runTileClayBlockoutRunner` / `google_3d_tiles_clay_blockout_runner`) over manual external Blender workflows or textured tile blockouts.
   - Studio grey clay shading (`#dcd6cd` / `#b0b8c4`, roughness 0.82, metalness 0.02) provides pure geometric massing, occlusion, and parallax without photogrammetric texture baking, burnt-in lighting, or texture boiling in diffusion video synthesis.
2. **Canonical Contract & Artifact Output**:
   - `videoRef`: Strictly `<VIDEO_REF_0>` (H.264 MP4 and VP9 WebM camera flight).
   - `startFramePngPath`: High-resolution Frame 0 PNG (`blockout_frame_00.png`) providing the 1:1 camera pose precursor for AI Beautify (`buildBeautifyPrompt`) to generate `<IMAGE_REF_0>`.
   - `clayGlbPath`: Standardized binary glTF 2.0 (`.glb`) containing the real-world geodetic volumetric massing for downstream simulation or compositing.
3. **Trajectory Presets & Raycast Collision Avoidance**:
   - Supported trajectories: `cinematic_arc` (default 72-frame orbital descent), `orbit_360` (full 360-degree orbital survey), and `canyon_push` (street-level forward push-in).

### Rule: Zero Building Clipping During Tile Extraction & Ingestion (Atomic Building Integrity)
When extracting, downloading, or ingesting 3D tile submeshes, bounding volumes, or real-world district geometry:
1. **Atomic Architectural Entity Invariant (Zero-Cut Extraction)**:
   - Buildings, towers, and architectural structures are indivisible atomic entities. Under NO circumstance may a tile extraction boundary, bounding volume, geofence, elevation slice, camera frustum, or polygonization algorithm bisect, truncate, shear, or clip a building.
   - Slicing through facades, walls, or rooms to expose open, non-manifold hollow "dollhouse" shells or paper-thin vertical walls without roof caps is strictly prohibited.
2. **Unbounded Vertical Skyward Extent ($Y_{\max} = +\infty$ Invariant)**:
   - The vertical bounding volume for tile extraction must NEVER cap the skyward dimension. $Y_{\max}$ must be unbounded ($+\infty$) or set well above the tallest structure on Earth ($\ge 2,500\text{m}$).
   - Architectural crowns, mansard roofs, mechanical penthouses, spires, and antennae must be 100% preserved with zero horizontal planar shearing.
   - Vertical grounding or elevation datum slicing applies strictly below the lowest natural foundation level ($Y \le Y_{\text{ground}}$) to prune subterranean noise, never slicing downward from above into architectural envelopes.
3. **Boundary Dilation & Connected Component Expansion**:
   - Extraction boundaries (geofences, radii, or bounding boxes) must snap to natural clearings (street canyons, boulevards, plazas, parks, or waterways) rather than bisecting parcels.
   - If an extraction boundary intersects any portion of a building structure:
     - Dilate the boundary outward to encompass the entire connected structure and its full footprint, OR
     - Retain the entire connected component cluster of the building mesh.
4. **Multi-Tier Zenith & Horizon Frustum Encompassment in Headless Streaming**:
   - In automated 3D tile streaming (`Google3DTileBlockoutPipelineService.ts`, `3d-tiles-renderer`), contextual cameras must never be restricted to low-altitude multipliers (e.g. `maxAlt * 2.2` which fails for skyscrapers).
   - Contextual camera rigs must incorporate a high-altitude zenith camera array ($\ge 1,800\text{m} - 2,500\text{m}$, FOV 75°, far plane $\ge 25,000\text{m}$) and upward-inclined horizon cameras covering the entire vertical envelope of metropolitan skylines, guaranteeing leaf LOD tiles for all building crowns and upper stories without near-plane or frustum culling.
5. **Unified Multi-District Contiguous Tile Streaming**:
   - When ingesting adjacent or contiguous tiles across a district, the extraction must be executed as a single unified bounding volume or with overlapping boundary dilation to prevent artificial vertical planar seams between tiles.
6. **Automated Verification & Rejection Gate**:
   - Automated test suites, pipeline validators, and the `visual-critic` skill must audit extracted models for open upper boundary edges, sliced non-manifold facades, and flat horizontal cuts through vertical walls. Any extracted model displaying clipped building geometry must be rejected.

## Universal 3D Structure Foundation Directive: Canonical Master Anchor & Multi-Format Projections

### Rule: Single Source of Truth — Geometric Anchor First, Multi-Format Outward
When an agent creates, transforms, ingests, or exports 3D scenes, photogrammetry datasets, Gaussian splats, camera blockouts, or spatial assets:
1. **Never Daisy-Chain Incompatible Formats**:
   - The agent must NEVER attempt ad-hoc format-to-format conversions (e.g. attempting to extract clean triangular CAD meshes from raw 3D Gaussian Splats, or reverse-engineering camera flight paths from flat AI video).
   - All spatial transformations must originate from the authoritative canonical master: `Universal3DStructureFoundation` (`@scratchbox/core`).
2. **Canonical Master Structure Contract (`Universal3DStructureFoundation`)**:
   - Every 3D entity must maintain five synchronized ground-truth layers:
     - **Solid Geometry**: Metric surface vertices, indices, normals, and UVs for rasterization (`mesh`).
     - **Point Constellation**: Surface points, normals, and RGB colors for point clouds and neural seeds (`points`).
     - **Calibrated Observation Rig**: Multi-view 6-DoF poses with exact pinhole optics ($f_x, f_y, c_x, c_y$) and OpenCV/Nerfstudio matrices (`cameras`).
     - **Bounding Envelope & Collision**: Metric AABB, bounding sphere, and simplified convex bumper hull (`boundingBox`, `collisionHull`).
     - **Geodetic Anchor**: Real-world WGS-84 coordinates (`anchor`: `lat`, `lng`, `elevation`).
3. **Deterministic Outward Projection**:
   - Downstream tools must consume outward projections generated by the Foundation:
     - `.toGlbBuffer()`: Standard binary glTF 2.0 for WebGL / Three.js / Unreal viewports.
     - `.toColmap()`: `cameras.txt`, `images.txt`, `points3D.txt` for photogrammetry and GLOMAP.
     - `.toNerfstudio()`: `transforms.json` + `sparse_pcd.ply` for 3D Gaussian Splatting and NeRF.
     - `.toVideoCameraBlockout()`: `<VIDEO_REF_0>` Catmull-Rom camera trajectory for Google Omni, Veo, and Sora diffusion models.
     - `.toCollisionHull()`: Simplified envelopes for physics engines and obstacle avoidance.
     - `.toGeoJson()`: RFC 7946 geodetic camera frustum footprints for Google Maps Platform.

## 3DGS Interoperability & Reconstruction Directive: Nerfstudio Dataset Contract & Visual-Hull Carver

### Rule: Universal Nerfstudio Dataset Interchange Contract
When exporting, exchanging, or ingesting multi-view camera datasets for 3D Gaussian Splatting (3DGS) across pipelines, agents, or external tools:
1. **Canonical Nerfstudio Dataset Layout**:
   - Every multi-view capture (e.g. multi-camera video, drone photogrammetry orbits, or synthetic viewport camera sweeps) must be serializable to the standard Nerfstudio dataset structure:
     ```
     <dataset_dir>/
     ├── transforms.json       # OpenCV/Pinhole camera intrinsics & c2w extrinsics
     ├── sparse_pcd.ply        # Initial point cloud with positions, normals & RGB
     ├── images/*.png          # Extracted RGB frames (e.g. 00.png, 01.png...)
     └── masks/*.png           # Foreground alpha masks (strictly binarized >= 128)
     ```
2. **Strict Camera Coordinate Transformation Contract**:
   - Nerfstudio adheres to OpenGL camera space (+X Right, +Y Up, -Z Viewing Direction), whereas OpenCV, Three.js image unprojections, and standard computer vision pipelines adhere to OpenCV camera space (+X Right, +Y Down, +Z Viewing Direction).
   - The conversion matrix between OpenCV camera-to-world ($\mathbf{T}_{\text{opencv}}$) and Nerfstudio camera-to-world ($\mathbf{T}_{\text{nerfstudio}}$) is strictly defined as:
     $$\mathbf{T}_{\text{nerfstudio}} = \mathbf{T}_{\text{opencv}} \cdot \begin{pmatrix} 1 & 0 & 0 & 0 \\ 0 & -1 & 0 & 0 \\ 0 & 0 & -1 & 0 \\ 0 & 0 & 0 & 1 \end{pmatrix}$$
   - Any agent serializing `transforms.json` must invert columns 1 and 2 (Y and Z axes) of the rotation-translation matrix, and vice-versa upon deserialization.
3. **Boolean Mask Binarization**:
   - Nerfstudio casts mask pixel buffers directly to `bool`. Soft boundary predictions from matting networks (BiRefNet) cause edge noise.
   - All masks serialized for Nerfstudio must cross a hard threshold at $\ge 128$ (`NERFSTUDIO_MASK_THRESHOLD = 128`).

### Rule: Visual-Hull Prior over COLMAP for Moving & Dynamic Subjects
When initializing 3D Gaussians for performers, humans, or dynamic subjects from multi-view captures:
1. **Never Depend on Slow/Fragile SfM (COLMAP)**:
   - COLMAP feature matching is brittle on non-rigid humans, smooth skin, and rapidly deforming clothing.
2. **Canonical Visual-Hull Voxel Carving**:
   - Always initialize `sparse_pcd.ply` using volumetric visual-hull carving from the multi-camera silhouette masks via `scratchbox_visual_hull.hpp` or `NerfstudioDatasetService.carveVisualHull()`:
     - Metric bounding box: $2.5\text{m}$ cube centered on the human root (`halfExtent = 1.25m`).
     - Resolution: $2\text{cm}$ voxel grid (`voxelSize = 0.02m`).
     - Ray projection: candidate 3D voxels are projected into all calibrated cameras; voxels falling within foreground masks across $K \ge \text{minViews}$ cameras are retained.
     - RGB Color Averaging: base Gaussian color is computed as the mean foreground RGB observation: $\mathbf{C}_p = \frac{1}{\sum \mathbf{1}_{\text{fg}}} \sum_k I_k(u_k, v_k)$.

### Rule: Two-Tier 3DGS Execution Roles
1. **Tier 1 (Interactive In-App Viewport)**:
   - Always use native Three.js instanced WebGL shaders (`PhotorealGaussianSplatMesh.ts`, `createAnisotropic3DGSSplatMaterial`) and 4-bone partition-of-unity Linear Blend Skinning (LBS) in the browser for real-time 60 FPS playback with zero external Python servers.
2. **Tier 2 (Cloud Run / ComfyUI Offline Reconstruction)**:
   - When a user demands dense neural reconstruction ($>1\text{M}$ splats) from raw multi-view video, route the exported Nerfstudio dataset to Cloud Run with NVIDIA L4 GPU running `splatfacto` / `splatfacto-perceptual` with VGG-19 feature loss ($\lambda_{\text{perc}} = 0.4$), random background color regularizer, and depth supervision.

### Rule: Performer & Avatar Video/Image Prompt Neutrality (Head-to-Toe, Flat Studio, A-Frame Pose)
When directing or constructing prompts for video creation tools (Google Omni 1.1 / Veo) or image creation tools (Imagen 3, Nano Banana 2) for human characters, performers, or avatars:
1. **Zero Context & Zero Theatrical Lighting**:
   - Prompts must **NEVER** include environmental context (no rooms, parquet floors, rugs, stages, concert venues, city streets, outdoors, furniture, or architectural sets) or theatrical/directional lighting (no golden hour sun, stage spotlights, colored gels, rim lights, harsh direct sun, deep cast shadows).
   - Directional illumination and background scenery corrupt 2D silhouette extraction, bake illumination artifacts into albedo textures, and cause hollow cavities and severe distortion in torso, crotch, and feet during backprojection.
2. **Strict Neutral Studio & Even Illumination Invariant**:
   - **Backdrop**: Plain solid neutral grey studio backdrop (`#808080`), completely devoid of environment or props.
   - **Illumination**: Completely flat, neutral, high-CRI, diffuse, shadowless studio illumination. Uniform even lighting from all angles with zero directional keylights, zero harsh specular hotspots, and zero cast shadows on the subject or floor.
3. **Full-Body Head-to-Toe Vertical Framing (9:16)**:
   - Always specify vertical uncropped portrait framing (`9:16`).
   - The entire figure must be visible from the crown of the head down to the soles of the shoes, with clear uncropped top and bottom margins. Never crop at knees, waist, or neck.
4. **Canonical Symmetrical A-Frame Pose (A-pose)**:
   - The performer must stand upright in a symmetrical A-frame pose:
     - Arms angled downward and outward ~35°–45° from the flanks.
     - Hands open facing forward with relaxed fingers (eliminating torso-arm occlusion).
     - Legs straight and shoulder-width apart.
     - Feet planted flat on the floor facing forward (eliminating leg-to-leg fusion).
   - This provides the ground-truth baseline required for MediaPipe/SB-Human shape estimation, 22-bone skeletal rigging, LBS weight assignment, and visual-hull carving.
5. **Programmatic Builder & Tool**:
   - Use `buildNeutralPerformerPrompt` (`omniVideoPromptService.ts`) or the agent tool `build_neutral_performer_prompt`.

### Rule: 4DAnyone Video Diffusion Backbone (Wan2.2-TI2V-5B) & Frame-Motivated A-Pose Ingestion
When conditioning video generation for performer avatars or generating multi-view capture angles for 4D dynamic reconstruction:
1. **Frame-Motivated Video Conditioning (<FIRST_FRAME>)**:
   - The video fed into the 4D performer reconstruction pipeline must be explicitly motivated by and anchored to the hero reference frame.
   - Always condition video prompts using `<FIRST_FRAME><IMAGE_REF_0></FIRST_FRAME>` syntax (or Frame 0 latents).
   - The video motion must strictly originate from the initial symmetrical A-frame pose (A-pose: arms angled outward 35°–45°, palms facing forward, legs straight and shoulder-width apart, feet flat on floor).
   - Motion must preserve identity, hair/skin texture, and clothing morphology seamlessly from Frame 0 with zero abrupt scene cuts or perspective jumps.
2. **4DAnyone Video Diffusion Backbone (Wan2.2-TI2V-5B)**:
   - To synthesize the complete set of camera capture positions around the performer from a single casual frame, use the video diffusion architecture established by `4DAnyone` (`ant-research/4DAnyone`, arXiv:2608.20335): **Wan2.2-TI2V-5B** (Text-and-Image to Video 5B DiT backbone).
   - Enforce **Reference Context Packing (RCP)** for $O(1)$ memory consumption while conditioning on high-resolution reference appearances.
   - Enforce **Target Context Routing (TCR)** for cross-view multi-angle attention synchronization across capture viewpoints.
3. **Capture Viewpoint Rig & Photogrammetric Angles**:
   - Capture viewpoints must systematically cover:
     - Front: 0° eye-level perspective
     - Left Oblique: 45° azimuth
     - Right Oblique: -45° azimuth
     - Rear Dorsal: 180° azimuth
     - (Or full continuous 360° orbital ring at radius $2.2\text{m}$, elevation $1.25\text{m}$)
   - All synthesized multi-view video streams must maintain identical subject timing, A-pose starting frame, and shadowless `#808080` studio environment.
4. **Programmatic Builder, Tool & Pipeline Invariant**:
   - Prompt Builder: `buildFrameMotivatedPerformerVideoPrompt` (`omniVideoPromptService.ts`) and Gemini tool `build_frame_motivated_performer_prompt`.
   - Multi-View Diffusion Runner: `ComfyUiPipelineAgent` Wan2.2 blueprint and Gemini tool `generate_4danyone_multiview_video`.
   - 4D Pipeline Ingestion: `VideoTo4DPerformerPipelineService.process({ frameMotivatedInput: { referenceFramePath, videoModelBackbone: 'Wan2.2-TI2V-5B', cameraPositions, initialPose: 'a-pose' } })`.

## Code Quality & Engineering Principles

1. **Precision & Investigation**: Inspect existing files before editing. Never guess symbol names or file paths.
2. **Type Safety**: Maintain 100% clean TypeScript typechecks across all monorepo packages.
3. **Continuous Verification**: Test all procedural generation and 3D pipelines with automated test suites.

## Visual Progress & Verification Directive

### Rule: Always Take Screenshots to Check Progress
- **Mandatory Visual Feedback Loop**: Whenever developing, generating, modifying, or testing UI components, interactive web views, 2D canvases, or 3D scenes/viewports, always capture screenshots at key milestones, stage completions, and verification phases to check and demonstrate progress.
- **Visual Critic & Photorealistic Quality Gate**:
  - Activate the `visual-critic` skill (`.agents/skills/visual-critic/SKILL.md`) for all 3D scenes, Gaussian splats, WebGL viewports, and generative media.
  - Never declare victory or claim photorealism based on technical checklists, compiling shaders, or passing unit tests alone. The final rendered pixel buffer is the only truth.
  - Evaluate against the **8-Dimension Visual Fidelity Rubric** (minimum passing score $\ge 8.5/10$ across all dimensions):
    1. *Geometric Definition & Silhouette Crispness*: No amorphous, lumpy, or melting "cotton-ball" shapes.
    2. *Splat Density & Anisotropic Covariance*: Real 3D-to-2D projected covariance ($\Sigma' = J W V W^T J^T$), not point-sprite billboard discs; minimum density threshold ($>500\text{k}-2\text{M}$ for focal entities).
    3. *Material, Texture & Micro-Surface Definition*: Physically grounded albedo, roughness, specular highlights, and micro-detail, never untextured flat grey polygons.
    4. *Environmental Context & Grounding*: Complete 360° environment with physical atmospheric sky dome (Rayleigh/Mie scattering) and authentic streetscape/ground, never pitch-black `#000` or `#050811` voids.
    5. *Radiometric Lighting & Analytical Shadows*: Directional shadows cast by sun ephemeris matching silhouette + tight contact ambient occlusion; NEVER slap 2D radial gradient canvas drop-shadow stickers under feet.
    6. *Color Temperature & Radiance Harmonization*: Synchronized Planckian Kelvin color temperature ($1,000\text{K} - 40,000\text{K}$) across foreground and background geometry.
    7. *Volumetric Depth & Interleaving*: Smooth Soft-Z depth penetration without clipping or boundary seams.
    8. *The "Squint Test" & Photographic Realism*: Indistinguishable from a genuine optical photograph to an unprimed human observer.
  - **Zero Tolerance for Red Line Violations**: Any scene with a void background, cotton-ball splats, sticker drop shadows, or floating cut-off geometry is an immediate automatic failure.

## Adaptive Domain Architecture & Zero-Preset Directives

### Rule: Adaptive Domain Architecture — Zero-Preset & Schema-Guided Generation

To prevent codebase clutter, avoid the "ontology trap", and maintain infinite semantic breadth in the style of Google Antigravity:

1. **The LLM is the Domain Engine (Zero Closed Classifiers)**:
   - Never introduce hardcoded domain enums (`DomainCategory = 'biology' | 'astrophysics' | ...`), regex keyword classifiers, or `switch(domain)` branches in AI generation or model-streaming paths.
   - Closed domain taxonomies are presets in disguise. Real-world user requests span infinite disciplines that cannot be captured by static buckets.
   - The LLM *is* the domain engine. Rely on the model's latent semantic space to infer context, domain vocabulary, industry-standard units, and operational steps directly from the user's prompt.

2. **Strict Schema Contracts over Presets**:
   - Enforce rigorous TypeScript and JSON Schema interfaces (`KanbanData`, `MetricCardsData`, `NodeGraphData`, `Scene3DData`, etc.) defining structural contracts, not content presets.
   - Meta-prompts must instruct the model on structural integrity and domain fidelity (e.g., *"Synthesize realistic, domain-accurate metrics, industry-standard units, and meaningful step sequences reflective of the specific subject matter"*), never hardcoding sample cards or mock data.

3. **AST-Grounded Document Projections (Zero Injected Presets)**:
   - When morphing architectural specifications or markdown documents into Kanban boards or telemetry dashboards, extract stages from markdown headings, cards strictly from user checklist bullets/tasks, and KPIs from in-text metrics.
   - Under NO circumstance should canned domain profiles (e.g., mock CRISPR sgRNA cards, Keplerian orbital mechanics) be injected into user documents.

4. **Entity-Driven Offline Fallbacks**:
   - Client-side or offline fallbacks (when network/LLM is unavailable) must use lightweight entity/action extraction from the prompt (subjects, action verbs, quantities) via `extractPromptEntities`, rather than expanding monolithic switch-case trees.
   - Reserve local rule-based synthesis strictly as a minimal fallback safety net, keeping boilerplate lean and unentangled with AI generation pipelines.

5. **Zero Static Heading / Content Mandates**:
   - Never mandate static section titles (e.g., `"Executive Summary"`, `"Central Spatial Monolith"`, or fixed column names like `"ASTROPHYSICS Telemetry"`) in system prompts or code. All titles, headers, and narratives must be composed dynamically on the fly based on the user's specific context.

### Rule: Adaptive Domain Architecture Over Preset Structures (`sceneType` Guidance Deprecation)

When synthesizing, managing, or rendering 3D scenes:
1. **Never Use Preset Structures as a Guide**:
   - `sceneType` must **NEVER** act as a rigid generation guide, routing trigger, or closed category enum that forces 3D scenes into predetermined canned shapes (e.g. `'highway_overpass'`, `'alpine_valley'`, `'ziggurat'`, `'battlefield'`, `'city'`, `'solar-system'`, `'architecture'`).
   - Closed preset enums and keyword regex matchers are strictly prohibited from hijacking scenes away from structured types or dynamic domain synthesis.
2. **Adaptive Domain Architecture When Possible**:
   - For generative, procedural, or open-ended 3D requests, always deploy the **Adaptive Domain Architecture** (`AdaptiveDomainEngine.synthesizeAdaptive3DScene` / `classifyDomain` / `extractPromptEntities`).
   - Synthesize scenes dynamically from first principles:
     - **70-20-10 Geometric Form Hierarchy**: Primary hero massing (70%), secondary functional detailing (20%), and tertiary micro-elements / interface instrumentation (10%).
     - **Biophysical PBR Materials**: Physically grounded dielectric and conductor parameters (`roughness`, `metalness`, `color`, `emissive`, ambient occlusion, and procedural weathering).
     - **Domain-Calibrated Environment**: Tailored skybox (`studio`, `deep_space`, `dark_studio`, `realistic-sky`, `golden_hour`, `overcast`), Planckian Kelvin studio or daylight illumination, and ergonomic camera framing.
     - **Adaptive Classification**: `sceneType: 'adaptive'` or the open semantic domain name (`'astrophysics'`, `'technology'`, `'geology'`, `'architecture'`, etc.).
3. **Structured Types When Needed**:
   - When explicit, typed geometric or simulation data exists on the scene, the engine and renderer must honor and render those structured types directly with absolute precedence:
     - `customMeshes`: Explicit typed array of mesh definitions (`id`, `name`, `type`, `position`, `rotation`, `scale`, `material`, `tier`).
     - `cppGenerator`: Native C++20 Astra engine with `sourceCode` and binary GLB mesh generation.
     - `objects`: Typed 3D media objects with durable URIs, spatial coordinates, and mime types.
     - `geoAnchor`: WGS-84 geodetic coordinates and Google Photorealistic 3D Tiles.
     - `splat`: 3DGS Gaussian splat radiance fields.
     - `customScript` / `code`: Typed dynamic WebGL / Three.js execution scripts.
     - `timeline`: 4D temporal simulation solver configuration.
     - `features`: PBR and rendering pipeline flags.
   - Structured types must **never** be intercepted or overridden by legacy presets or keyword regexes.

## Video Pipeline & Multi-District Gallery Directives

### Rule: Strict District Asset Isolation & Semantic Coherence
To ensure that district viewports and comparison modes never display mismatched, stale, or cross-contaminated assets:
1. **Never Index by Fixed Array Offset**:
   - In scripts updating gallery metadata or evaluations (`s4d_multi_gallery.html`, manifests, etc.), always query districts by their unique identifier (`dist.id === 's4d_google_tiles_textured_01'` or `dist.id === 's4d_google_tiles_clay_01'`), NEVER assume array indices (e.g., `evaluationsData[0]`).
2. **Strict District-to-Asset Coherence**:
   - **Textured Flight Districts (`s4d_google_tiles_textured_*`)**:
     - `videoSources.blockout` MUST point to `videos/google_tiles_textured_blockout_camera.mp4`.
     - `videoSources.synthesis` MUST point to `videos/google_tiles_omni_restyled.mp4`.
     - `videoSources.comparison` MUST point to `videos/google_tiles_textured_vs_omni_comparison.mp4`.
     - `storyboardBeats` MUST point to `storyboards_textured/beat_*.jpg`.
     - Under NO circumstance may a textured flight district reference clay assets.
   - **Clay Flight Districts (`s4d_google_tiles_clay_*`)**:
     - `videoSources.blockout` MUST point to `videos/google_tiles_clay_blockout_camera.mp4`.
     - `videoSources.synthesis` MUST point to `videos/google_tiles_omni_restyled.mp4`.
     - `videoSources.comparison` MUST point to `videos/google_tiles_clay_vs_omni_real_comparison.mp4`.
     - `storyboardBeats` MUST point to `storyboards_clay/beat_*.jpg`.
     - Under NO circumstance may a clay flight district reference textured assets.
3. **Automated Asset Integrity Gate**:
   - Always run `node scripts/validate_gallery_pipeline_assets.cjs` (or vitest `packages/core/test/gallery-asset-integrity.test.ts`) prior to completing any task modifying pipeline outputs. All referenced videos and keyframes must exist on disk, have non-zero size, and pass semantic type validation.

### Rule: Exhaustive Multi-State Viewport Verification
Whenever verifying gallery or video player changes:
1. **Never Verify Only the Default View**:
   - Do NOT just capture the default landing state (`synthesis`).
2. **Cycle Through Every Video Mode**:
   - Must explicitly trigger and verify all three video switcher buttons:
     - `Step 3: Omni Video Output` (`synthesis`)
     - `Step 1: <VIDEO_REF_0> Blockout` (`blockout`)
     - `⚡ Side-by-Side (Step 1 vs 3)` (`comparison`)
3. **Multimodal Visual Inspection of Comparison Split**:
   - Inspect the captured screenshot of `Side-by-Side`:
     - Left half must display the authentic blockout geometry (photogrammetric textured tiles for textured flight; clay mesh for clay flight).
     - Right half must display the neural Omni synthesis.
     - Confirm horizon lines, perspective vanishing points, and timing match.

## Universal Tile Decomposition & Rectification Directive (UTDRA / ULDRA)

### Rule: Always Rectify Photogrammetric 3D Tiles with UTDRA / ULDRA
When working with raw photogrammetric 3D tiles (e.g. Google Photorealistic 3D Tiles, Cesium, or photogrammetry meshes) that suffer from photogrammetric melting, false bridge curtain walls, or sloping facades:
1. **Probe Macro-Domain Telemetry First**:
   - Classify the tile into one of 9 macro-geographic domains via `utdra_probe_tile` or `UniversalTileDecompositionService.probeTile()`:
     - `UrbanHighRiseCore`, `SuburbanResidential`, `CivilInfrastructure`, `MountainAlpineCanyon`, `ForestWoodlandCanopy`, `IndustrialLogistics`, `CoastalShorelineHarbor`, `AridDesertBadlands`, `OpenAgriculturalPlains`.
   - Never mutate geometry during probe analysis; check relief $\Delta Y$, planarity ratio, and verticality score.
2. **Apply Domain-Specific Geometric Rectification**:
   - **Shafts & Sculptural Crowns**: Rectify vertical building facades into true planar walls while preserving crowns, spires, and ornamental finials without clipping.
   - **Bridges & Viaducts**: Multi-level void carver MUST excise false photogrammetric vertical curtain walls beneath elevated spans (guaranteeing $\ge 3.5\text{m}$ clearance) while preserving road decks and ground terrain.
   - **Elevation Slicing**: Sutherland-Hodgman analytical kernel clips straddling triangles across cutoff planes without hole formation or boundary seam artifacts.
3. **Canonical Codebase APIs & In-App Agent Tools**:
   - **TypeScript Services**: `UniversalTileDecompositionService` with dual aliases `UtdraService` and `UldraService`.
   - **In-App Gemini Agent Tools**:
     - `utdra_probe_tile({ inputGlbPath, benchmark })`: Zero-mutation domain probe.
     - `utdra_decompose_tile({ inputGlbPath, benchmark, mode, minVoidHeightMeters, outputGlbPath })`: Full pipeline decomposition.
     - `utdra_slice_elevation({ inputGlbPath, benchmark, cutoffY, outputGlbPath })`: Non-destructive planar slicing.
     - `utdra_carve_bridge_voids({ inputGlbPath, benchmark, minVoidHeightMeters, outputGlbPath })`: Multi-level void carving under bridges.

## AI Beautify Location Pipeline & Strict 3D Framing Directive

### Rule: Always Enforce Verbatim AI Beautify Template & Non-Negotiable Framing
When transforming or restyling real-world 3D tiles renderings (e.g. Google Photorealistic 3D Tiles) into photorealistic images or start frames (`<IMAGE_REF_0>`):
1. **Canonical API & In-App Agent Tool**:
   - Always call `buildBeautifyPrompt(options)` from `packages/core/src/browser/generative-canvas/services/location-beautify-service.ts` or invoke the in-app agent tool `build_beautify_prompt`.
2. **Verbatim Template Conformance**:
   - Never deviate from or alter the core template phrasing:
     - Output MUST match canvas aspect ratio (`{aspectRatio}`).
     - Preserve EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view.
     - Every building, street, and rooftop must stay in the same on-image position (no pan, zoom, crop, or horizon shift).
     - Do not invent or add buildings or landmarks not visible in the reference.
3. **Exact Subject Distance Phrasing**:
   - When subject distance is provided:
     ` Subject distance: approximately {distance} meters from camera (use this for depth-of-field, focus, and aerial-perspective haze).`
   - When distance is omitted: MUST be empty string `""`.
4. **Style Suffix Injection**:
   - Caller-supplied artistic style and modifiers (`{styleSuffix}`) are appended verbatim with exact spacing and capitalization.

## 3D Atmospheric Scattering & Radiometric Environment Directive

### Rule: Physically-Grounded Atmosphere, Diurnal Curves & Solar Ephemeris
When configuring, synthesizing, or simulating lighting, skies, weather, and environmental effects in 3D scenes:
1. **Physical Scattering & Radiometric Diurnal Curves**:
   - Always prioritize physical atmospheric parameters over arbitrary ambient light values:
     - **Scattering**: Model wavelength-dependent Rayleigh scattering ($\lambda^{-4}$) and forward aerosol Mie scattering with tunable turbidity.
     - **Solar Ephemeris**: Derive authentic sun elevation and azimuth using high-precision NOAA geodetic ephemeris (`calculateNOAASolarPosition` or `atmosphere_calculate_solar_position`) given real-world latitude, longitude, and timestamps.
     - **Diurnal Phasing**: Classify the 10 diurnal lighting phases (`classifyDiurnalPhase`) and interpolate Planckian blackbody color temperatures ($1,000\text{K} - 40,000\text{K}$) through `kelvinToRGB` / `blackbodyKelvinToLinearRgb`.
2. **Volumetric Media & Optical Depth**:
   - **Volumetric Clouds**: Two-octave 3D Worley noise raymarching with dynamic wind advection, density thresholds, and absorption.
   - **Terrain Cloud Shadows**: Analytical sun-ray projection onto ground planes or 3D terrain meshes (`TerrainCloudShadows`), avoiding expensive shadow-map redraws.
   - **Crepuscular God Rays**: Screen-space radial light scattering pass (`VolumetricGodRays` / `createVolumetricGodRays`) projecting sun shafts through cloud gaps and geometry occluders.
   - **Aerial Perspective**: Multi-spectral Beer-Lambert distance extinction $T(s) = \exp(-\beta_{\text{ext}} \cdot s)$ and inscattered airlight blending with height stratification (`evaluateAerialPerspective`).
   - **Participating Media & Spherical Harmonics**: Riemann numerical quadrature raymarching (`marchVolumetrics`) and 9-coefficient order-3 Ramamoorthi polynomials (`SphericalHarmonics9`) for ambient diffuse irradiance.
3. **Canonical Codebase APIs, Operators & Agent Tools**:
   - **Unified Facade**: `AtmosphereService` in `@scratchbox/core/browser` coordinates complete atmospheric lifecycle (`attach`, `update`, `render`, `dispose`).
   - **Direct Dispatch Operators** (`nature_atmosphere` category):
     - `sb_configure_atmospheric_scattering`: Configure Rayleigh, Mie, turbidity, and volumetric cloud coverage.
     - `sb_set_diurnal_time_of_day`: Adjust solar time of day via presets (`golden_hour`, `sunset`, `midday`, etc.) or NOAA coordinates (`latitude`, `longitude`, `isoDate`).
     - `sb_configure_aerial_perspective`: Tune Beer-Lambert extinction range and inscattering intensity.
     - `sb_configure_terrain_cloud_shadows`: Enable analytical ground cloud shadow advection and softness.
     - `sb_add_volumetric_god_rays`: Inject crepuscular god rays with density, decay, and exposure controls.
   - **In-App Gemini Agent Tools**:
     - `atmosphere_calculate_solar_position({ latitude, longitude, isoDate })`: Calculate sub-arcminute sun vectors.
     - `atmosphere_get_diurnal_profile({ elevationDeg, turbidity })`: Compute photometric sun intensity, ambient bounce, kelvin temperature, and diurnal phases.
     - `atmosphere_configure_scene({ preset, latitude, longitude, clouds, godRays, aerialPerspective })`: High-level atmospheric scene configuration.

## WebXR Geospatial Anchor Bridge & Metric Space Alignment Directive

### Rule: Bidirectional Geodetic-to-WebXR Alignment & Multi-Tier Sensor Calibration
When aligning real-world geodetic assets, ARCore geospatial anchors, Google Maps road corridors, or parcels into WebXR environments:
1. **Mathematical Conventions & Coordinate Transformations**:
   - Geodetic Coordinates: WGS-84 reference ellipsoid ($a = 6378137.0\text{m}$, $f = 1 / 298.257223563$).
   - Local Tangent Plane (ENU): Standard East-North-Up Cartesian frame with $+X = \text{East}$, $+Y = \text{Up}$, and $-Z = \text{North}$ in WebXR/Three.js camera conventions.
   - WebXR `local-floor` space: Metric ($1.0 = 1\text{m}$), $+Y$ aligned with physical gravity vector, $+X = \text{Right}$, $+Z = \text{Backward}$.
   - Compass heading $\theta$ (clockwise from True North) converts to yaw: $\text{yaw} = -\theta \cdot \frac{\pi}{180}$.
   - Affine transform: $\mathbf{P}_{\text{xr}} = \mathbf{R}_y(\theta_{\text{align}}) \cdot \mathbf{P}_{\text{enu}} + \mathbf{T}_{\text{align}}$.
   - Inverse: $\mathbf{P}_{\text{enu}} = \mathbf{R}_y(-\theta_{\text{align}}) \cdot (\mathbf{P}_{\text{xr}} - \mathbf{T}_{\text{align}})$.
2. **Three-Tier Drift Elimination & Calibration**:
   - **Anchor Origin Calibration**: Ground the primary geodetic anchor at the WebXR world origin $[0, 0, 0]$ with an optional True North compass heading offset.
   - **Autonomous Sensor Fusion**: Fuse mobile device GPS fixes ($\ge 5\text{m}$ accuracy threshold), hardware magnetometer/compass heading, and 6-DOF WebXR viewer pose without requiring manual user interaction.
   - **Manual Optical Pin Calibration**: User points at and confirms the physical position of a known landmark or AR entity to compute an exact zero-drift residual delta $\mathbf{T}_{\text{align}} = \mathbf{P}_{\text{pinned}} - \mathbf{P}_{\text{projected}}$.
3. **Canonical Codebase APIs & In-App Agent Tools**:
   - **Core Service**: `WebXRGeospatialAnchorBridge` in `@scratchbox/core/browser` (or `packages/core/src/browser/generative-canvas/services/xr/WebXRGeospatialAnchorBridge.ts`).
   - **In-App Gemini Agent Tools**:
     - `webxr_geospatial_align_coordinates({ originAnchor, targetGeodetic, webXRPosition, headingDeg, quaternion, headingOffsetDeg, translationOffset })`: Bidirectional WGS-84 $\leftrightarrow$ WebXR metric coordinates and compass heading $\leftrightarrow$ quaternion conversion.
     - `webxr_geospatial_calibrate({ originAnchor, mode, headingOffsetDeg, sensorSample, viewerPose, contract, targetEntityId, measuredWebXRPosition })`: Calibrates coordinate alignment via anchor-origin, sensor fusion, or optical manual pin.
     - `webxr_geospatial_project_vectors({ originAnchor, roadCorridors, parcels })`: Projects Google Maps Platform road centerlines or parcel boundaries into WebXR 3D metric lines and extruded volume massing meshes.

## 6-DOF Camera Resection & Spatial Pose Estimation Directive

### Rule: Analytical 2D-to-3D Spatial Resection, solvePnP & Closed-Loop Edge Alignment
When aligning real-world photographs or video frames with 3D tile models, estimating camera poses, or resecting geodetic camera positions:
1. **Zero Presets & Analytical Feature-to-Pose Resection**:
   - Never rely on hardcoded landmark coordinates, canned bounding boxes, or artificial landmark dictionary lookups.
   - **Feature Extraction & Matching**: Detect salient 2D Harris/FAST corners on the query raster, extract 128-D gradient patch descriptors, match via Normalized Cross-Correlation (NCC) with Lowe's ratio test ($d_1 / d_2 < 0.75$) and bidirectional cross-checking, and lift matched pixels into metric 3D East-North-Up (ENU) coordinates via surface depth unprojection (`VisualFeatureMatcherService`).
   - **Perspective-n-Point Pose Estimation**: From $\ge 4$ point correspondences, analytically compute the camera extrinsics $(\mathbf{R}, \mathbf{t})$ and focal length $f$ via Direct Linear Transform (DLT) with SVD matrix decomposition, enforce orthonormal rotation ($\det(\mathbf{R}) = +1$), and refine non-linearly via damped Levenberg-Marquardt least squares (`SpatialPoseEstimatorService.solvePnP`).
   - **Outlier Rejection Consensus**: In uncurated, cluttered scenes with noise, use 4-point minimal sample consensus with reprojection thresholding to reject gross correspondence mismatches with 100% precision (`SpatialPoseEstimatorService.solvePnPRansac`).
2. **Everyday Non-Monument Topology & Authentic Google 3D Tiles**:
   - The resection engine must succeed with sub-pixel precision across random, everyday non-monument environments (suburban residences, urban storefronts, logistics parks, highway overpasses), maintaining $< 0.05\text{ px RMS}$ reprojection residual.
   - When matching with Google Photorealistic 3D Tiles, ingest authentic binary glTF (`.glb`) meshes directly from disk (`loadMeshFromGlb`), extracting raw vertices, normals, and triangle indices without intermediate format conversions.
3. **Pure Node.js Headless Software Rasterization & Closed-Loop Edge Optimization**:
   - Avoid launching heavy headless Chrome or GPU contexts for iterative alignment loops. Use pure Node.js software rasterization (`HeadlessMeshSilhouetteRenderer`), projecting 3D triangles and wireframes with near-plane clipping into $W \times H$ raster buffers in $< 5\text{ms}$ per pose.
   - Connect the edge optimizer directly to the headless renderer callback: every coordinate perturbation in 6-DOF parameter space $(\Delta x, \Delta y, \Delta z, \Delta \text{yaw}, \Delta \text{pitch}, \Delta \text{roll}, \Delta \text{fov})$ dynamically renders a fresh edge silhouette, driving Normalized Cross-Correlation (NCC) and overlap score to convergence ($\ge 97\%$ overlap, $< 0.1\text{ px}$ sub-pixel residual).
4. **Canonical Codebase APIs & In-App Gemini Agent Tools**:
   - **TypeScript Core Services**:
     - `SpatialPoseEstimatorService`: Analytical `solvePnP`, `solvePnPRansac`, Rodrigues rotation transformations, and Levenberg-Marquardt optimizer in `packages/core/src/node/spatial/SpatialPoseEstimatorService.ts`.
     - `VisualFeatureMatcherService`: 2D corner detection, patch descriptors, Lowe ratio matching, and 3D depth unprojection in `packages/core/src/node/spatial/VisualFeatureMatcherService.ts`.
     - `HeadlessMeshSilhouetteRenderer`: High-speed software triangle/edge rasterizer and `.glb` loader in `packages/core/src/node/spatial/HeadlessMeshSilhouetteRenderer.ts`.
     - `SubPixelEdgeAlignmentOptimizer`: Iterative coordinate descent edge alignment in `packages/core/src/node/spatial/SubPixelEdgeAlignmentOptimizer.ts`.
     - `GeoBoxPrecisionResectionService`: End-to-end multimodal resection facade in `packages/core/src/node/spatial/GeoBoxPrecisionResectionService.ts`.
   - **In-App Gemini Agent Tools**:
     - `spatial_solve_pnp({ points2D, points3D, imageWidth, imageHeight, focalLengthPx, useRansac, ransacReprojThresholdPx })`: Analytically recovers 6-DOF camera pose, position, attitude (heading, pitch, roll), FOV, and reprojection error from point correspondences.
     - `spatial_match_features_2d_3d({ queryImagePath, renderImagePath, maxKeypoints, loweRatio, crossCheck })`: Extracts robust 2D-to-3D keypoint correspondences.
     - `spatial_closed_loop_edge_align` / `geobox_closed_loop_edge_align({ imagePath, meshBoxCenter, meshBoxSize, initialPose, maxIterations, targetOverlapScore, subpixelTolerancePx })`: Closed-loop iterative edge alignment with dynamic offscreen software rendering.
     - `geobox_resect_image_location` / `spatial_resect_image_location({ imagePath, promptHint, targetLandmarkName, sensorFocalMm, optimizeTo100Percent })`: Full end-to-end autonomous 6-DOF camera resection and geodetic positioning.

## Location 3D Object De-Lighting & Atmosphere Directive

### Rule: Photogrammetric De-Lighting, Dusk Atmosphere & Architectural Backlighting
When integrating real-world photogrammetric 3D tiles (e.g. Google Photorealistic 3D Tiles) to match photograph lighting and atmosphere:
1. **Analytical GLSL De-Lighting Shader**:
   - Never render raw daytime baked photogrammetry directly into dusk or twilight scenes (prevents crushed black shadows and bleached noon highlights).
   - Inject analytical fragment shader chunks via `applyPhotogrammetricDelightShader`:
     - Non-linear shadow lifting: `uShadowLift: 0.60` (lifts crushed dark crevices toward neutral stone luma).
     - Highlight compression: `uHighlightCompress: 0.45` (tames baked noon solar glare).
     - Stone albedo calibration: calibrated neutral tones (`travertine` `[0.86, 0.82, 0.78]`, `limestone`, `sandstone`, `granite`, `terracotta`, `marble`, `concrete`).
     - Normal-dependent twilight sky catch-light (`uTwilightSkyTint`) and warm plaza ground bounce (`uGroundBounceTint`).
     - Ground plane de-washing: `uGroundDeWash: 0.42`.
2. **Atmospheric Lighting & Architectural Window Portal Illumination**:
   - Configure Mediterranean civil twilight ambient (`#3a7ea5`), hemisphere sky/ground light, low dusk horizon fill (`#b8dcfa`), and vertical gradient sky canvas.
   - Architectural portal fixtures: Place physical spotlight fixtures behind window cutouts emitting $2,850\text{K}$ incandescent amber illumination outward without washing out the exterior facade stone.
3. **Canonical Codebase APIs & In-App Agent Tools**:
   - **Standalone Function**: `harmonizeLocationObjectAtmosphere(request)` in `@scratchbox/core`, `@scratchbox/core/browser`, `@scratchbox/core/node`.
   - **Core Service**: `LocationObjectLightingService` in `packages/core/src/browser/generative-canvas/services/atmosphere/LocationObjectLightingService.ts`.
   - **In-App Gemini Agent Tools**:
     - `geobox_harmonize_location_lighting({ landmarkName, preset, stoneType, shadowLift, highlightCompress, enableArchitecturalBacklighting })`: Full photogrammetric de-lighting and atmospheric harmonization.
     - `atmosphere_harmonize_location_3d(...)`: High-level atmospheric alias.

## Native Prompt-Driven Mesh Reshaping Directive

### Rule: Native C++20 Astra Engine Reshaping & Parametric Deformation
When executing prompt-driven mesh deformation, organic sculpting, or parametric reshaping:
1. **Prioritize Native C++20 Astra Pipeline First**:
   - Always run deformations through the native C++20 Astra 3D engine (`scratchbox_shaper.hpp`), compiling via Apple Clang (`clang++ -std=c++20 -O3 -march=native`) through `NativeMeshReshaperService` / `run_mesh_reshaping_pipeline.cpp`.
   - Never spawn heavy external neural models or Python services for geometric deformations that can execute in sub-milliseconds via SIMD vector math:
     - **Non-Linear Deformers**: Taper, Twist, Bend, Bulge, Squash, Shear with smooth cubic Hermite and polynomial transitions.
     - **Free-Form Deformation**: Trivariate Bernstein polynomial tensor lattices (`Lattice3D`).
     - **Multi-Brush Digital Sculpting**: Clay, Crease, Smooth, Flatten, and Inflate with spatial acceleration.
   - **Topology & Subdivision**: Loop subdivision polygonization and manifold degenerate cleanup (`MeshTopologyCleaner`).
2. **Canonical Codebase APIs, Operators & Agent Tools**:
   - **Standalone Functions**: `reshapeMesh(options)` and `parsePromptToMeshOperations(prompt, bounds)` in `@scratchbox/core` and `@scratchbox/core/node`.
   - **Core Service**: `NativeMeshReshaperService` (aliased as `MeshReshapingService`) in `@scratchbox/core` and `@scratchbox/core/node`.
   - **Canvas Direct-Dispatch Operator**: `sb_reshape_mesh` in `packages/core/src/browser/generative-canvas/services/operators/mesh-edit-operators.ts` for real-time in-memory Three.js deformation.
    - **In-App Gemini Agent Tools**:
      - `mesh_reshape_via_prompt({ prompt, inputGlbPath, benchmark, outputGlbPath })`: Natural-language-driven mesh reshaping.
      - `mesh_apply_deformers({ operations, inputGlbPath, benchmark, outputGlbPath })`: Explicit parametric deformation pipeline.

## Adaptive Keyframe Calibration & 6-DOF Matchmove Directive

### Rule: Sub-Pixel Sequence Calibration & C2 Hermite Trajectory Synthesis
When solving camera matchmoves, optical resection, and live-action plate alignment with 3D geospatial tiles or geometry:
1. **Adaptive Domain Calibration Engine**:
   - Resect camera poses via `AdaptiveMatchmoveCalibrationService` using Levenberg-Marquardt bundle adjustment and robust Huber loss outlier rejection against 3D-to-2D spatial anchor correspondences.
   - Enforce rigorous metrology thresholds: Sequence Mean Reprojection RMS $< 0.05\text{ px}$, Sobel Edge Normalized Cross Correlation (NCC) $\ge 98.0\%$, and physical drone flight safety limits (velocity $< 15\text{ m/s}$, acceleration $< 10\text{ m/s}^2$).
   - Dynamically model Brown-Conrady radial lens distortion and optical focal breathing ($k_1, k_2$).
   - Synthesize smooth, non-uniform $C^2$ Hermite cubic spline trajectories with gimbal-free facade-normal slerp to eliminate roll jitter.
2. **Canonical Codebase APIs & In-App Gemini Agent Tools**:
   - **Core Service**: `AdaptiveMatchmoveCalibrationService` in `@scratchbox/core` and `@scratchbox/core/node`.
   - **In-App Gemini Agent Tools**:
     - `adaptive_matchmove_calibrate_sequence({ sequencePath, landmark, context, milestones, outputCameraPath, outputReportPath, ... })`: End-to-end multi-milestone bundle adjustment, spline synthesis, and metrology certification.
     - `adaptive_matchmove_resect_keyframe({ anchors, cameraPosition, targetPosition, lens, ... })`: Single keyframe 6-DOF pose and lens breathing solver.
     - `adaptive_matchmove_synthesize_trajectory({ milestones, fps, totalFrames, durationSec, facadeNormal, ... })`: Continuous $C^2$ spline generator with full velocity/acceleration telemetry.
     - `adaptive_matchmove_verify_metrology({ report, reportPath, maxAllowedRmsPx, minAllowedCorrelationPercent, ... })`: Automated metrology audit and pass/fail gate.

## Code-First Live Preview & In-Situ Commenting Directive

### Rule: Code-First to Create Anything & Live-Preview Heavy
When synthesizing applications, interactive prototypes, visual tools, or domain-specific solutions:
1. **Code is the Infinite Generative Substrate**:
   - Never artificially constrain creative breadth to pre-baked widget types or static GUI menus. Code (React, TypeScript, HTML/CSS, Python, WebGL) is Turing-complete and capable of creating *anything*—from a 1776 historical event tracker to an interactive molecular viewer or custom audio synthesizer.
   - Always mount generated code into a living, sub-second hot-reloading iframe sandbox (`live-code-sandbox` / `LiveCodeSandboxData`) on the canvas stage.
2. **Transparent Code & File Inspection**:
   - The user must always have immediate access to inspect the multi-file project tree (`App.tsx`, components, data JSON, styles).
   - Code must be formatted, type-safe, and viewable in Monaco editor tabs with syntax highlighting, AST diagnostics, and diff hunks.
3. **In-Situ Interactive Commenting Loop**:
   - Enable users to interact directly with the running output and drop visual annotation pins onto live DOM elements.
   - Captured annotations MUST include the DOM selector (`#element-id > .badge`), source-map component file location (`src/components/Card.tsx:42`), visual crop, and user feedback note.
   - The Gemini Agent ingests these spatial annotations to perform surgical Hot Module Replacement (HMR) updates without resetting overall application state.
4. **Primitives as Canonical Accelerators (Never Constraints)**:
   - Hardcoded canvas primitives (`3d-scene`, `video-timeline`, `node-graph`, `kanban-board`, `metric-dashboard`) are **Canonical Accelerators**, NOT rigid boundaries.
   - Accelerators exist purely to save time, tokens, and compute from reinventing complex wheels (e.g. C++20 Marching Cubes SDF polygonization, multi-track NLE scrubbers, SVG bezier wiring engines).
   - Whenever user intent is bespoke or exploratory, the universal engine is the **Live Code Sandbox**.

## 3D State Trilemma & Bidirectional Lens Synchronization Directive

### Rule: Synchronize AST, C++ Generator, and Viewport State
The Scratchbox 3D ecosystem maintains three concurrent representations of a 3D scene (the 3D State Trilemma):
1. **Declarative Scene AST** (`.scene.json`, schema: `Scene3DData`): High-level metadata, camera pose, lighting, atmosphere, and mesh references.
2. **Procedural C++ Generator** (`world_generator.cpp` via `data.cppGenerator.sourceCode`): Native C++20 code producing the procedural geometry.
3. **Live Three.js Viewport Stage**: GPU-resident meshes, materials, and scene graph hierarchy.

When updating or falling back between tiers:
- **Lens Synchronization**: `Scene3DWorldLens` bidirectionally projects and unprojects between files on disk and the stage. Edits to one must reflect across all three without state drift.
- **Two-Tier Fallback Metadata Preservation**: When a scene or model falls back from C++20 generation to Tier 2 ComfyUI (e.g., neural mesh synthesis), the engine preserves:
  - `data.fallbackTier2ComfyUi`: Records fallback reason, prompt, model architecture, and execution timestamp.
  - `data.cppGenerator.glbPath`: Links the resulting binary `.glb` asset into the scene.
  - `data.cppGenerator.sourceCode`: Preserves the generator blueprint for inspection or future native re-synthesis.

## Megaservice Deconstruction & Modular Architecture Directive

### Rule: Modular Domain Packs for Tools and Canvas Operators
To avoid monolithic file bloat, unmaintainable merge conflicts, and coupling:
1. **Modular Gemini Tool Registry**:
   - `ToolRegistry` (`packages/core/src/node/gemini/tool-registry.ts`) is a lightweight orchestrator (under 350 LOC) that registers declarations and delegates dispatch to 9 domain packs in `packages/core/src/node/gemini/tools/`:
     - `canvas-tools.ts`, `spatial-tools.ts`, `utdra-tools.ts`, `comfyui-tools.ts`, `atmosphere-tools.ts`, `mesh-shaping-tools.ts`, `vfx-video-tools.ts`, `workspace-tools.ts`, `lens-browser-tools.ts`.
   - Never add raw tool declarations or execution handlers directly to `tool-registry.ts`; always place them in their respective domain pack.
2. **Modular Direct Dispatch Operator Engine**:
   - `DirectDispatchOperatorEngine` (`packages/core/src/browser/generative-canvas/services/direct-dispatch-operator-engine.ts`) is a lightweight router (under 300 LOC) delegating across 11 operator packs in `packages/core/src/browser/generative-canvas/services/operators/`:
     - `lighting-camera-operators.ts`, `scene-assembly-operators.ts`, `advanced-realism-operators.ts`, `physics-animation-operators.ts`, `nature-atmosphere-operators.ts`, `mesh-edit-operators.ts`, `material-pbr-operators.ts`, `transform-operators.ts`, `modifier-operators.ts`, `state-history-operators.ts`, `inspect-operators.ts`.
   - All operator modifications, undo/redo handling, and schema validations belong in these modular packs.

## Tool Self-Awareness & Encapsulation Boundary Directive

### Rule: Proactive Tool Exploitation with Zero Leaked Plumbing
When leveraging Scratchbox's unique superpowers to solve user tasks:
1. **Antigravity-Style Tool Self-Awareness**:
   - The agent MUST possess deep, proactive awareness of the platform's 57 specialized in-app tools:
     - **Two-Tier Capability Routing**: `resolve_task_capability` (assess Tier 1 native feasibility vs Tier 2 ComfyUI fallback).
     - **3D Geospatial Tiles & Photogrammetry**: `google_3d_tiles_get_full_texture`, `google_3d_tiles_get_clay`, `panorama_heal_seam`, `panorama_inpaint`, `panorama_generate_360`, `panorama_generate_perspectives`.
     - **Universal Tile Decomposition (UTDRA / ULDRA)**: `utdra_probe_tile`, `utdra_decompose_tile`, `utdra_slice_elevation`, `utdra_carve_bridge_voids`.
     - **Optical Resection & Alignment**: `geobox_resect_image_location`, `geobox_resect_camera_pose`, `geobox_harmonize_location_lighting`, `geobox_optimize_edge_alignment`, `optics_configure_lens_distortion`.
     - **WebXR Geospatial Anchor Bridge**: `webxr_geospatial_align_coordinates`, `webxr_geospatial_calibrate`, `webxr_geospatial_project_vectors`.
     - **Atmospheric Scattering & Ephemeris**: `atmosphere_calculate_solar_position`, `atmosphere_get_diurnal_profile`, `atmosphere_configure_scene`, `atmosphere_estimate_from_image`, `atmosphere_harmonize_location_3d`.
      - **Native C++ Mesh Reshaping**: `mesh_reshape_via_prompt`, `mesh_apply_deformers`.
      - **Adaptive Keyframe Calibration & 6-DOF Matchmove**: `adaptive_matchmove_calibrate_sequence`, `adaptive_matchmove_resect_keyframe`, `adaptive_matchmove_synthesize_trajectory`, `adaptive_matchmove_verify_metrology`.
      - **AI Beautify & VFX Prompting**: `build_beautify_prompt`.
     - **ComfyUI Autonomous Fallback & Cloud Run L4**: `comfyui_get_status`, `comfyui_research_pipeline`, `comfyui_cloudrun_status`, `comfyui_cloudrun_sync_upstream`, `comfyui_inject_dynamic_code`, `comfyui_execute_pipeline`.
     - **Canvas Primitives & Codebase Lenses**: `mount_canvas_primitive`, `lens_project`, `lens_unproject`, `lens_list_bindings`, `lens_sync`, `browser_navigate`, `browser_snapshot`, `browser_extract_content`, `browser_click`, `browser_type`, `browser_evaluate`.
     - **Workspace & Subagents**: `workspace_read_file`, `workspace_view_file`, `workspace_write_file`, `workspace_apply_diff`, `workspace_list_directory`, `workspace_search`, `workspace_grep_search`, `workspace_find_by_name`, `workspace_run_command`, `workspace_get_diagnostics`, `workspace_find_symbols`, `workspace_semantic_search`, `invoke_subagent`.
   - The agent must automatically exploit these tools when relevant, rather than asking the user or attempting crude approximations.
2. **Zero Plumbing Inlining (Never Dump Engine Implementation)**:
   - Under NO circumstance may the agent dump low-level internal engine code into user files or chat:
     - Never paste raw NOAA solar trigonometry, Julian day formulas, or Planckian integrals into user code.
     - Never paste raw Cesium 3D tile octree walkers, Sutherland-Hodgman clippers, or WebGL buffer allocations.
     - Never paste Brown-Conrady camera distortion matrices or C++ shaper source code into user sandboxes.
3. **Canonical SDK Ingestion via `@scratchbox/core`**:
   - When authoring code in `live-code-sandbox` (e.g., `App.tsx`), user-facing components must import cleanly from `@scratchbox/core` (or `@scratchbox/core/browser`, `@scratchbox/core/common`):
     ```tsx
     import { Google3DViewport, useAtmosphere } from '@scratchbox/core';
     ```
   - User code must be clean, concise (15–30 lines), idiomatic, and readable, consuming the platform as a first-party SDK while heavy C++20 and GPU pipelines remain encapsulated in the platform kernel.
4. **Transparent Telemetry Observability**:
   - The agent reports tool execution via clean `McpExecutionState` cards and status badges in chat (`☀️ Atmosphere: Calculated solar vector for Rome at 17:00`), letting the user see *that* the tool was leveraged without cluttering *how* it was implemented.

---
name: complex-visual-workflows
description: >-
  Orchestrate and execute complex visual tasks across 3D generation, video production, and 3D imagery
  using the Scratchbox IDE codebase, native C++20/Python engines, Google 3D Tiles, Omni 1.1 video synthesis,
  camera matchmove, and ComfyUI two-tier pipelines. Enforces 18% Grey Clay void staging, 70-20-10 form hierarchy,
  Two-Tier Problem Solving, and multi-disciplinary visual production.
category: 3D & Spatial
accentColor: indigo
tags: [3D, Video, VFX, Gaussian Splats, Photogrammetry, Omni, ComfyUI, Scratchbox]
---

# Complex Visual Workflows Skill (3D, Video & 3D Imagery)

The **Complex Visual Workflows Skill** equips Antigravity to act as a **Master Visual Director and Technical Supervisor**, seamlessly commanding Scratchbox IDE's native engines, C++20 kernels, Python nanobind tooling, Google Photorealistic 3D Tiles, Vertex AI Omni 1.1, matchmove NLE, and ComfyUI pipelines to execute sophisticated, end-to-end visual productions.

```
                                [USER OBJECTIVE]
                                        │
                                        ▼
                   [Pre-Flight Task Capability Resolver]
               (scripts/preflight_capability.cjs / resolve_task_capability)
                                        │
             ┌──────────────────────────┴──────────────────────────┐
             ▼                                                     ▼
  [TIER 1: Native Scratchbox Engine]                  [TIER 2: ComfyUI Fallback]
  • 3D: C++20 Astro Engine / Python nanobind          • Neural 3D Diffusion (Trellis / TripoSR)
  • Geospatial: Google 3D Tiles / Vector MVT          • Neural Video Restyle (AnimateDiff / Omni)
  • Video: Geo-Camera Matchmove / Timeline NLE        • Monocular Dense Depth (Marigold)
  • Imagery: AI Beautify / 2DGS & 3DGS Splats         • Cloud Run NVIDIA L4 GPU / Local Service
             │                                                     ▲
             └──────────────── Transactional Failover ─────────────┘
                                        │
                                        ▼
                           [Visual Production Hub]
             ┌──────────────────────────┼──────────────────────────┐
             ▼                          ▼                          ▼
      [1. 3D DOMAIN]             [2. VIDEO DOMAIN]          [3. 3D IMAGERY DOMAIN]
  • 18% Grey Clay Void Baseline • 6-DoF Spline Matchmove    • AI Beautify Pipeline
  • 70-20-10 Form Hierarchy     • Headless 4K 3D Blockout   • Multi-Angle Turnarounds
  • 4 Geometric Operators       • Omni 1.1 Conditioning     • PBR Material Director
  • Google 3D Tiles Clay/Tex    • Multi-Angle Quad-Split    • 2DGS Planar Surfels
  • UTDRA Mesh Rectification    • Video Timeline NLE        • Analytical Forward Grooms
  • Dynamic 4DGS Humanoids      • 50/50 Comparison Splits   • Algorithmic UV Rewrap
             │                          │                          │
             └──────────────────────────┼──────────────────────────┘
                                        │
                                        ▼
                  [Mechanical Closed-Loop Verification]
             (scripts/verify_visual_asset.cjs & Visual Critic)
```

---

## 1. Core Architectural Invariants

Every visual task executed in Scratchbox IDE must strictly obey six foundational architectural invariants:

### 1. Two-Tier Problem-Solving Directive
- **App Capabilities First**: Always attempt Tier 1 native capabilities (C++20 Astro Engine, Python nanobind `scratchbox`, Google 3D Tiles, UTDRA, matchmove NLE, Omni 1.1, Google models).
- **Resort to ComfyUI If and Only If Incapable**: Only spin up ComfyUI when the task genuinely requires neural diffusion (e.g. image-to-3D diffusion like Trellis/TripoSR, video-to-video restyling like AnimateDiff, dense monocular depth like Marigold, or custom LoRAs).
- **Strict Prohibition on Toy JavaScript Primitives ("Tier-0" Ban)**: Viewports and generative pipelines must **never** catch errors and silently fall back to client-side Three.js boxes (`new THREE.BoxGeometry`). Failover routes strictly to Tier 2 ComfyUI GPU neural generation.

### 2. Adaptive Domain Architecture (ADA) & Open Universality
- **The Alien Planet Test (Zero Closed Taxonomies)**: Never design closed enums (e.g. `type Domain = 'arctic' | 'desert'`). All structures, biomes, and extraterrestrial forms must be expressible via continuous physical parameter manifolds ($R^N$).
- **No Regex Noun Dictionaries**: Spatial intent is recognized through dimensional verbs of fabrication (`build`, `model`, `construct`, `sculpt`, `extrude`, `assemble`, `render`), never exhaustive lists of human artifacts.

### 3. Universal First-Request 3D Staging Invariant
- **When Location is Described in Initial Prompt**: Return the scene staged at that authentic location by default using **Google 3D Tiles Studio Grey Clay** (`google_3d_tiles_get_clay`, `location: "..."`, or `stage_3d_vector_world`). Model the hero object in 18% Grey Clay right on the real-world corridor. **Never build fake procedural asphalt boxes or lollipop trees**.
- **When NO Location is Described First**: Model the hero object in **18% Studio Grey Clay** (`sb.PbrMaterial.clay()`, roughness 0.85, metalness 0.0, color `[0.55, 0.57, 0.60]`) in a **3D Stage Void** (`environment: { skybox: 'studio', lighting: 'studio', ground: false }`).
- **Separation of Staging & Environments from Textures & Materials**: Present two distinct, dedicated follow-up sections via interactive chat pills:
  1. *Section 1: Staging & Environments* (Google 3D Tiles Clay, Vector World Roadway, Environmental Plinth, Solar Ephemeris).
  2. *Section 2: Textures & Materials* (PBR clearcoat/metal, 2DGS planar surfels, 3DGS radiance fields, Algorithmic UV micro-textures).

### 4. The 70-20-10 Geometric Form Hierarchy
- **70% Primary Edifice / Silhouette**: Sculpted compound curvature, stance, non-linear deformers (taper, twist, bend, bulge, FFD lattices).
- **20% Secondary Articulated Assemblies**: Discrete functional sub-parts (splitters, diffusers, multi-element chassis, hollow-spoke wheel rims, calipers, cockpit framework).
- **10% Tertiary Micro-Detail**: Panel shut lines, hex grilles, hood louvers, quad exhaust tips, mechanical fasteners, chamfers.
- **Complexity Floors**: $\ge 25,000$ vertices for scenes, $\ge 5,000$ vertices for standalone props.

### 5. Analytical Forward Splatting over Inverse Photogrammetry
- For fur, hair grooms, and feathered surfaces, **never** render 2D images to train inverse 3DGS. Always formulate grooming as direct analytical forward splatting (`scratchbox_hair.hpp`, `scratchbox_spz.hpp`, `AnalyticalGroomSplatService`) projecting segment Gaussians directly into Niantic SPZ v2 (`.spz`) in $< 100$ milliseconds.

### 6. Mechanical Verification (Anti-Simulation Trap)
- Never assume an asset is valid based on generated code alone. Mechanically verify output geometry, triangle counts, video codecs, and splat files using [verify_visual_asset.cjs](./scripts/verify_visual_asset.cjs).

---

## 2. Domain 1: 3D Generation & Spatial Environments

### Procedural 3D Modeling (Python Nanobind & C++20)
Scratchbox provides a high-performance C++20 geometry core bound directly to Python (`import scratchbox as sb`). Agents author procedural geometry using the **4 Universal Differential Geometric Operators**:

1. **$\mathrm{SE}(3)$ Lie Group Curve Sweeps**: 3D carrier curves sweeping continuous profiles with scaling, twist, and taper (limbs, hoses, roll cages, chassis spines, claw prongs).
2. **Harmonic Solids of Revolution**: Radial profiles revolved with $K$ continuous radial harmonic lobes and helical twist ($K=0$: smooth housings, nozzles; $K=5$: 5-spoke hollow alloy wheel rims; $K \ge 12$: cooling fins, splined hubs).
3. **Affine Metric Replicators**: Periodic affine distribution of seed geometry along 1D curves or 2D manifolds at metric pitch $p$ (fastener circles, louvers, gripper teeth, treads).
4. **Isoparametric Normal Relief Fields**: Geodesic normal displacements $\Delta h(u, v) \mathbf{n}(u, v)$ (panel shut lines, weld beads, knurling).

*See the [3D Engine Cheat Sheet](./references/3d-engine-cheat-sheet.md) for complete Python nanobind code recipes and C++20 engine header specifications.*

### Geospatial Grounding & Google 3D Tiles Ingestion
- **Maximum Quality Invariant**: Tile streamer must use the tightest geometric error budget (`errorTarget <= 0.5`) and high-resolution 4K screen-space error. Wait for leaf tile streaming to fully settle (`downloading === 0 && parsing === 0`).
- **Two Dedicated Separate APIs**:
  - `getGoogle3DTilesClay` / `google_3d_tiles_get_clay`: Pure architectural/topographical massing rendered in neutral 18% Studio Grey Clay with flat lighting.
  - `getGoogle3DTilesFullTexture` / `google_3d_tiles_get_full_texture`: Full photogrammetric textured capture.
- **2D Vector Roadmap Staging (`stage_3d_vector_world`)**:
  - Queries Google 2D roadmap vector tiles (zoom 16) to generate 5-tier road cross-sections with beveled granite curbs, sidewalks, parcel massing prisms, lane-aligned traffic, streetlamps, and street trees.
- **UTDRA Photogrammetric Rectification (`utdra_probe_tile`)**:
  - Classifies across 9 macro-geographic domains, excises curtain walls beneath bridges, rectifies building vertical shafts while preserving historic cornices/crowns, and executes non-destructive elevation slicing.

### Parametric Mesh Reshaping & Dynamic Avatars
- **Native Mesh Reshaping (`mesh_reshape_via_prompt` / `NativeMeshReshaperService`)**: Applies Bernstein FFD tensor lattices, taper, bend, twist, bulge, squash, and shear with zero external dependencies.
- **Local SF3D (`local-sf3d-service.ts`)**: Generates small organic forms, rocks, fruit, and biomorphic props in $< 500$ms on local GPU/MPS with flat ground contact planes.
- **Dynamic 4DGS Humanoids (`scratchbox_4dgs_humanoid.hpp`, `Dynamic4DGaussianSplatService`)**: Controls 22-joint SB-Human canonical kinematic skeletons with Linear Blend Skinning (LBS), ground-contact IK altitude clamping, and SPZ/PLY streaming.

---

## 3. Domain 2: Video Production & Cinematic Motion

### Geo-Camera Matchmove Pipeline
The matchmove pipeline extracts 6-DoF camera trajectories from reference video footage and replicates the exact motion anchored into real-world geographic coordinates:

```bash
# 1. Inspect trajectory and keyframe resectioning (dry run)
sbox matchmove reference.mp4 --landmark "The Plaza Hotel" --dry-run

# 2. Render 4K Google 3D Tiles blockout (<VIDEO_REF_0>)
sbox matchmove reference.mp4 --landmark "The Plaza Hotel" --render-mode textured --resolution 4k

# 3. Headless runner targeting arbitrary coordinates with lens distortion
node scripts/run_geo_camera_matchmove_pipeline.cjs \
  --video reference.mp4 \
  --lat 40.7645 --lng -73.9744 --alt 180 --heading 45 \
  --render-mode textured --resolution 4k \
  --precision --lens-k1 -0.015 --lens-k2 0.002
```

### Google Omni 1.1 Video Synthesis
- **Media Tag Syntax**:
  - `<VIDEO_REF_0>`: 3D camera blockout reference video.
  - `<FIRST_FRAME>` / `<LAST_FRAME>`: Temporal anchor images.
  - `<IMAGE_REF_N>`: Character / asset visual references.
- **Camera Motion Conditioning**: Enforce complete adherence to `<VIDEO_REF_0>` trajectory while generating hyper-photorealistic surfaces, natural optical flares, and shallow depth of field.
- **Cut Suppression**: Explicitly instruct: *"Zero jump cuts, zero camera stutter, continuous single-take cinematic camera trajectory."*

### Multi-Angle Quad-Split Video
- Render multi-camera productions in a 2x2 grid at 4K UHD ($3840 \times 2160$), guaranteeing that each quadrant retains full 1080p resolution.
- Crop into 4 synchronized 1080p camera feeds in a single FFmpeg pass:
  ```bash
  ffmpeg -i quad_4k.mp4 -filter_complex "\
    [0:v]crop=1920:1080:0:0[tl];[0:v]crop=1920:1080:1920:0[tr]; \
    [0:v]crop=1920:1080:0:1080[bl];[0:v]crop=1920:1080:1920:1080[br]" \
    -map "[tl]" -c:v libx264 -crf 18 cam1.mp4 -map "[tr]" -c:v libx264 -crf 18 cam2.mp4 \
    -map "[bl]" -c:v libx264 -crf 18 cam3.mp4 -map "[br]" -c:v libx264 -crf 18 cam4.mp4
  ```

### Video Timeline NLE & Post-Production
- Assemble timelines via `video-timeline` primitive and `HeadlessVideoEditorService`.
- Generate synchronized 50/50 side-by-side comparison splits between original reference video and synthesized video using FFmpeg `hstack`.
- Apply Kelvin temperature filters (3200K golden hour warmth) and audio sidechain ducking.

*See the [Video Production Cheat Sheet](./references/video-production-cheat-sheet.md) for full FFmpeg scripts and Omni prompt templates.*

---

## 4. Domain 3: 3D Imagery & Surface Synthesis

### AI Beautify Location Pipeline (`buildBeautifyPrompt`)
Transforms coarse 3D tile captures into photographic-grade imagery by constructing structured prompts encoding:
- Viewport canvas aspect ratio (16:9 widescreen or 4:3 aerial).
- 6-decimal geodetic coordinates (`lat: 40.748441, lng: -73.985664`).
- Standoff distance, altitude, and horizon pitch.
- Distance-based depth of field ($f/5.6 - f/8.0$ for architectural scales).

### Multi-Angle Turnaround Capture Orbits (`generate_multi_angle_turnaround`)
- Directs continuous spherical camera orbits ($\theta \in [0^\circ, 360^\circ)$, $\phi \in [-15^\circ, +45^\circ]$, standoff $r = 1.8 \times \text{AABB}_{\text{diagonal}}$).
- **Dual-Anchor Identity Conditioning**: Conditions each subsequent orbital frame on Frame 0 (Hero Anchor) for structural proportions AND the immediate previous frame for local texture continuity.
- Non-negotiable isolation: zero ground plane, zero cast shadows, pure neutral void to guarantee artifact-free 3D reconstruction.

### PBR Material Directing
- Synthesizes 1K/2K/4K PBR material sets using native C++20 multithreaded SIMD kernels on continuous biophysical manifolds ($R^{20}$).
- Multi-layer procedural rhytidome (cork bark ridges, Voronoi cellular fissures).
- Thin-wall subsurface scattering (chlorophyll backface transmission for leaves and petals).
- Automotive multi-layer clearcoat, carbon fiber weave, brushed aluminum, packed ORM textures.

### Gaussian Radiance Fields & Planar Surfels
- **2D Planar Surfels (`SURFACE_2DGS_PLANAR_SURFEL`)**: Near-zero thickness along surface normals, eliminating floating sky splatter and maintaining razor-sharp geometric edges.
- **Analytical Forward Grooming (`AnalyticalGroomSplatService`)**: Direct projection of biophysical hair/fur guide curves into Niantic SPZ v2 (`.spz`) in $< 100$ms.

### Algorithmic UV Rewrap & Micro-Textures (`AlgorithmicUVRewrapService`)
- 100% geometric spatial lock (0.000 px drift).
- Sobel photographic joint deepening for masonry, analytical travertine cavitation pores, calcite mineral grain, and bitumen asphalt surfacing.

*See the [3D Imagery Cheat Sheet](./references/3d-imagery-cheat-sheet.md) for mathematical formulations and turnaround graphs.*

---

## 5. End-to-End Multi-Stage Runbooks

### Runbook A: Concept $\rightarrow$ Hero 3D Asset $\rightarrow$ Location Staging
1. **Pre-flight Check**: Run [preflight_capability.cjs](./scripts/preflight_capability.cjs) to confirm Tier 1 viability and identify whether a real-world location is requested.
2. **Procedural Geometry Generation**:
   - If no location given: Author Python procedural script using `import scratchbox as sb` enforcing 70-20-10 form hierarchy in **18% Studio Grey Clay**. Stream binary `.glb` to canvas.
   - If location given: Retrieve Google 3D Tiles in Studio Grey Clay (`google_3d_tiles_get_clay`) or Vector World (`stage_3d_vector_world`), and model hero asset placed directly on the terrain/corridor.
3. **Interactive Follow-up Pills**:
   - Provide Section 1 (Staging & Environments: Google 3D Tiles, Vector World, Studio Cyclorama, Solar Ephemeris).
   - Provide Section 2 (Textures & Materials: PBR Clearcoat, 2DGS Planar Surfels, Algorithmic UV Rewrap).
4. **Mechanical Asset Verification**: Run [verify_visual_asset.cjs](./scripts/verify_visual_asset.cjs) to verify vertex count ($\ge 5,000$ for props, $\ge 25,000$ for scenes).

### Runbook B: Reference Video $\rightarrow$ Matchmove $\rightarrow$ 3D Blockout $\rightarrow$ Omni Video $\rightarrow$ 50/50 QA
1. **Probe Reference Video**: Extract framerate, resolution, and duration with `ffprobe`.
2. **Resect Keyframes & Solve Spline**: Run `adaptive_matchmove_resect_keyframe` and `adaptive_matchmove_solve_spline` to fit continuous $C^2$ spline.
3. **Render 4K 3D Tiles Blockout**: Execute `sbox matchmove reference.mp4 --landmark "<name>" --render-mode textured --resolution 4k` to produce `<VIDEO_REF_0>`.
4. **Synthesize Omni 1.1 Video**: Format Omni prompt conditioned on `<VIDEO_REF_0>` with timestamped shot blocks and zero-cut enforcement.
5. **Compile 50/50 Comparison**: Run FFmpeg `hstack` to produce side-by-side synchronized split verification video.

### Runbook C: Google 3D Tiles Landmark $\rightarrow$ UTDRA $\rightarrow$ Algorithmic PBR $\rightarrow$ 4K Turnaround
1. **Ingest Maximum Quality 3D Tiles**: Call `getGoogle3DTilesFullTexture` with `errorTarget <= 0.5`. Wait for leaf tiles to settle and package to `.glb`.
2. **UTDRA Rectification**: Probe tile with `utdra_probe_tile`. Excise curtain walls beneath bridges and rectify vertical building shafts.
3. **Algorithmic Micro-Textures**: Apply `AlgorithmicUVRewrapService` to deepen masonry joints and inject travertine cavitation pores with 0.000 px spatial lock.
4. **Multi-Angle Turnaround Orbits**: Execute `generate_multi_angle_turnaround` across 8 dual-anchor orbit stations in isolated neutral void.

### Runbook D: Two-Tier Transactional Failover to ComfyUI
1. **Pre-flight Detection**: If prompt requires neural image-to-3D diffusion (Trellis/TripoSR), neural video-to-video restyling (AnimateDiff), or specialized LoRAs:
2. **Spin Up ComfyUI Pipeline**:
   - Route execution to Google Cloud Run NVIDIA L4 GPU or local ComfyUI instance via `comfyui_execute_pipeline`.
   - If required custom nodes are missing, synthesize and inject dynamic Python nodes via `comfyui_inject_dynamic_code`.
   - Stream resulting 3D `.glb` mesh or restyled video back into the Scratchbox canvas stage.

---

## 6. Verification & Quality Control

### Mechanical Validation Commands
```bash
# 1. Pre-flight check any visual prompt
node .agents/skills/complex-visual-workflows/scripts/preflight_capability.cjs "build a 3d sports car in monaco"

# 2. Mechanically verify 3D mesh complexity floor (>= 5,000 vertices for props, >= 25,000 for scenes)
node .agents/skills/complex-visual-workflows/scripts/verify_visual_asset.cjs output/hero_asset.glb

# 3. Mechanically verify synthesized video parameters (codec, resolution, fps, duration)
node .agents/skills/complex-visual-workflows/scripts/verify_visual_asset.cjs output/synthesized_video.mp4

# 4. Quick staging helper for hero models and landmarks
node .agents/skills/complex-visual-workflows/scripts/quick_stage_hero.cjs --location "Monaco"
```

### Visual Critic 8-Dimension Rubric
When reviewing viewports or render proofs via Chrome DevTools snapshots:
1. **Geometric Fidelity**: Zero low-poly faceting on curved hero surfaces; compliant with 70-20-10 hierarchy.
2. **Proportions & Scale**: Anatomical and mechanical accuracy; realistic ground contact altitude.
3. **Material Authenticity**: Physically grounded PBR parameters; thin-wall transmission on organic leaves; micro-roughness.
4. **Radiative Lighting**: Correct Mie forward scattering ($g \approx 0.8$); solar angle matching NOAA ephemeris.
5. **Temporal Coherence**: Zero jump cuts or bubbling noise across video keyframes.
6. **Sub-Pixel Edge Alignment**: Zero seam drift or floating splats against real-world 3D tiles.
7. **Zero Artifacts**: Clean alpha boundaries; zero uninvited skyboxes or clouds unless requested.
8. **Color Fidelity**: Ground-truth palettes (natural forest loam, authentic travertine, automotive clearcoat).

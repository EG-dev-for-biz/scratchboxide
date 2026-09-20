# Generative Video Inpaint & VFX Patch Engine: Specification, Verification Status & Engineering History

This document serves as the canonical technical reference, evolutionary history, mathematical foundation, and automated verification status for the **Generative Video Inpaint & VFX Patch Engine** in Scratchbox IDE.

It covers the localized video-to-video generative patch architecture, Google Gemini Omni Interactions API (`task: "edit"`), dynamic runtime aspect ratio deduction (16:9 vs 9:16), VFX plate resolution evaluation (720p / 1080p / 4K supersampling invariant), face obstacle avoidance, multi-tile decomposition, headless FFmpeg compositing with feathered alpha edge masks and film grain matching, and timeline inspector controls.

---

## 1. Executive Summary & Current Test Status

| Metric | Status / Value | Verification Source |
| :--- | :--- | :--- |
| **Primary Test Suite** | `packages/core/test/generative-video-patch.test.ts` | Vitest v2.1.9 (**13/13 Passed**) |
| **Compositor Engine Suite** | `packages/core/test/video-compositor-engine.test.ts` | Vitest v2.1.9 (**13/13 Passed**) |
| **Full Video Test Suite** | 5 Test Files (`video-3d-compositing`, `video-timeline-*`, etc.) | Vitest v2.1.9 (**60/60 Passed, 100% Green**) |
| **Monorepo Typecheck** | **0 Errors** across all packages | `npm run typecheck` (`core`, `cli`, `desktop-app`) |
| **Core AI Model** | `gemini-omni-1.1-flash` via Google Interactions API | `task: "edit"`, video-in $\to$ video-out |
| **Aspect Ratio Modes** | Dynamic Auto (16:9 vs 9:16 Area Minimizer), Manual 16:9, Manual 9:16 | Analytical Geometry Solver |
| **Resolution Tiers** | Dynamic Auto (720p / 1080p / 4K), Manual Override | VFX Supersampling Invariant ($S \ge 1.0$) |
| **Edge Feathering** | Analytical Soft Alpha Ramp ($0 - 32\text{px}$) | FFmpeg `format=rgba,geq=...` |
| **Film Grain Matching** | Temporal Noise Injection Pass ($1 - 40\text{ intensity}$) | FFmpeg `noise=alls=...:allf=t+u` |
| **Spatial Scaling** | Lanczos-8 Filtered Spatial Resampling | FFmpeg `scale=flags=lanczos` |
| **Multi-Tile Spanning** | Automated decomposition for defect spans $> 3840\text{px}$ ($15\%$ overlap) | `calculateMultiTilePlan` |

---

## 2. Chronological Engineering History

The Generative Video Inpaint & VFX Patch Engine in Scratchbox IDE was designed to solve high-value post-production and archival restoration problems that historically required expensive frame-by-frame rotoscoping or manual cloning:

```
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 1: Archival Documentary BITC Restoration (Proof-of-Concept) │
│ • Archival documentary footage: 19 reels (~2:47 total), burned-in      │
│   timecode (BITC) windows with no clean transfer available.            │
│ • Validated Gemini Omni 1.1 Flash via Google Interactions API:         │
│   POST https://generativelanguage.googleapis.com/v1beta/interactions   │
│ • Discovered "task: edit" requires exact 16:9 or 9:16 input ratios.    │
│ • Still-image fallback path identified (gemini-3.1-flash-image).       │
│ • Production run completed at $33.12 total ($1.74 / clip).             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 2: Architectural Generalization & Safety Filter Avoidance   │
│ • Expanded beyond defect removal to object insertion and 3D plates.    │
│ • Discovery of likeness safety filters: whole-frame processing often   │
│   trips human likeness safety filters if background actors are present.│
│ • Discovery of Area Minimization: tight localized crops reduce cost    │
│   and preserve 95%+ of original master plate pixels untouched.        │
│ • Identified need for face obstacle collision avoidance: steering the  │
│   crop window between 16:9 and 9:16 to avoid human faces.             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 3: Production VFX Engine in Scratchbox IDE (Current State) │
│ • Pure domain logic: packages/core/src/common/video-generative-patch.ts│
│ • Dynamic Aspect Ratio Solver (16:9 vs 9:16 minimal area + face dodge) │
│ • Resolution Deduction Engine (720p/1080p/4K VFX supersampling $S>=1.0$)│
│ • Multi-Tile Decomposition for ultra-wide spans (> 3840px, 15% overlap)│
│ • Timeline Element integration: generativePatch in videoTypes.ts       │
│ • Headless FFmpeg Compositor: Lanczos downscale, geq alpha feathering, │
│   and noise film grain injection to eliminate AI plastic smoothness.   │
│ • Interactive UI: VideoInspectorPanel with real-time solver badges.    │
│ • 100% verified with Vitest test suite and clean TypeScript typecheck. │
└────────────────────────────────────────────────────────────────────────┘
```

### Generation 1: Archival Documentary BITC Restoration (Proof-of-Concept)
* **The Origin Problem**: In archival documentary filmmaking, directors frequently license historical newsreel or broadcast footage that only exists with a burned-in timecode (BITC) window across the lower third. Licensors frequently charge prohibitive fees or cannot locate clean negative transfers.
* **The Discovery**: A production test across 19 historical clips (~2:47 total runtime) demonstrated that Google's `gemini-omni-1.1-flash` model—invoked via the Google Interactions API endpoint (`task: "edit"`)—could temporally inpaint moving video backgrounds behind burned-in timecode digits, seamlessly hallucinating complex textures (ocean waves, moving crowds, historical asphalt, camera grain) with temporal stability.
* **Economic Viability**: The entire 19-clip restoration was achieved for \$33.12 ($1.74 per clip average), replacing weeks of manual visual effects paint work.
* **API Constraints Uncovered**:
  - The endpoint is `https://generativelanguage.googleapis.com/v1beta/interactions`, not `generateContent`.
  - The input video must be staged via the Files API first (resumable upload, polling for `ACTIVE`).
  - On `task: "edit"`, the model strictly requires either a `16:9` or `9:16` input aspect ratio; arbitrary custom aspect ratios are rejected with an API error.

### Generation 2: Architectural Generalization & Safety Filter Avoidance
* **Generalization to General VFX**: The user posed critical architectural inquiries:
  1. *Can this be used for object insertion or contact shadow synthesis?*
  2. *Can MediaPipe or spatial bounding boxes prevent tripping likeness filters?*
  3. *How should the engine handle vertical (9:16) versus landscape (16:9) framing?*
  4. *How does the system maintain plate acuity when working with 4K, 6K, or 8K cinema footage?*
* **The Likeness Filter Challenge**: Feeding a whole 16:9 cinema frame into Gemini Omni often triggers false-positive likeness or person-generation safety blocks if the camera frames recognizable historical figures or background actors.
* **The Solution**: Localized crop patching. By isolating a localized bounding box enclosing only the defect or insertion zone and expanding it strictly to the minimum enclosing 16:9 or 9:16 frame, the human subjects are excluded from the API payload, completely bypassing likeness filter triggers while reducing API latency and cost.

### Generation 3: Production VFX Engine in Scratchbox IDE (Current Milestone)
* **Initiative**: Native integration into Scratchbox IDE's video timeline, headless compositor, and generative UI inspector.
* **Key Innovations Implemented**:
  1. **Dynamic Aspect Ratio Solver**: Computes the minimal enclosing area between 16:9 ($A_{16:9} = \frac{16}{9} \cdot H^2$) and 9:16 ($A_{9:16} = \frac{16}{9} \cdot W^2$). Automatically clamps within frame boundaries and applies a $25\times$ penalty function if an orientation collides with detected face bounding boxes.
  2. **Resolution Deduction Engine**: Enforces the VFX Nyquist invariant: *Always Oversample, Never Upsample*. Selects between 720p, 1080p, and 4K so that the generative patch resolution always exceeds or matches the native crop window resolution ($S = L_{\text{patch}} / L_{\text{crop}} \ge 1.0$).
  3. **Multi-Tile Plan**: Automatically segments wide defect spans exceeding $3840\text{px}$ into dual overlapping 4K tiles with a $15\%$ overlap margin for seamless edge blending.
  4. **Headless FFmpeg Compositor Pass**: Extends `HeadlessVideoCompositorService` to build a localized filterchain: Lanczos downscaling, analytical edge feathering via the `geq` expression filter, film grain matching via `noise`, and coordinate overlay directly onto the clip stream before layer transformations.
  5. **Timeline Inspector UI**: Adds an interactive "AI Inpaint & Generative Patch" panel in `VideoInspectorPanel.tsx` with live solver badges, target bounding box controls, prompt presets, feather radius sliders, and grain intensity controls.
  6. **Automated Verification**: Complete Vitest test suite (`generative-video-patch.test.ts`) covering all mathematical invariants and dry-run execution.

---

## 3. Mathematical Foundations & Deduction Algorithms

### 1. Dynamic Aspect Ratio Solver (Area Minimization & Face Collision Avoidance)

Given a target defect or insertion bounding box $B = (x, y, w, h)$ on a master video frame $F = (W_F, H_F)$:

#### A. Minimal Enclosing Dimensions
* **For 16:9 Landscape ($\rho_{16:9} = 16/9 \approx 1.7778$):**
  $$W_{16:9} = \max(w, h \cdot \rho_{16:9}), \quad H_{16:9} = \frac{W_{16:9}}{\rho_{16:9}}$$
  $$\text{Area}_{16:9} = W_{16:9} \cdot H_{16:9}$$

* **For 9:16 Portrait ($\rho_{9:16} = 9/16 = 0.5625$):**
  $$H_{9:16} = \max(h, \frac{w}{\rho_{9:16}}), \quad W_{9:16} = H_{9:16} \cdot \rho_{9:16}$$
  $$\text{Area}_{9:16} = W_{9:16} \cdot H_{9:16}$$

#### B. Centroid Centering & Frame Boundary Clamping
To prevent the bounding box from drifting off-target, the crop is centered around the defect centroid:
$$c_x = x + \frac{w}{2}, \quad c_y = y + \frac{h}{2}$$
$$x_{\text{crop}} = \text{clamp}\left(c_x - \frac{W_{\text{crop}}}{2}, 0, W_F - W_{\text{crop}}\right)$$
$$y_{\text{crop}} = \text{clamp}\left(c_y - \frac{H_{\text{crop}}}{2}, 0, H_F - H_{\text{crop}}\right)$$

If the defect is larger than the plate itself, the crop box is clamped to $W_F \times H_F$.

#### C. Face Collision Penalty Scoring
If obstacle bounding boxes (e.g., actor faces detected via MediaPipe or YOLO) are supplied:
$$\text{Cost}(\rho) = \text{Area}_{\rho} \cdot \left(1.0 + 25.0 \cdot N_{\text{collisions}}(\rho)\right)$$
Where $N_{\text{collisions}}(\rho) = \sum_{i} \mathbf{1}_{B_{\text{crop}}(\rho) \cap F_i \neq \emptyset}$.
The solver selects:
$$\rho^* = \arg\min_{\rho \in \{16:9, 9:16\}} \text{Cost}(\rho)$$
This ensures that if a horizontal 16:9 expansion would intersect an actor's face, the engine automatically pivots to a vertical 9:16 orientation, dodging the safety filter.

---

### 2. Resolution Deduction Engine (The VFX Supersampling Invariant)

In high-end visual effects compositing, upsampling an AI-generated patch causes noticeable blur and spatial softness when composited back onto a high-acuity 35mm, 4K, 6K, or 8K plate.
Therefore, the engine enforces the **VFX Supersampling Invariant**:

$$\text{Sampling Ratio } S = \frac{\max(W_{\text{api}}, H_{\text{api}})}{\max(w_{\text{crop}}, h_{\text{crop}})} \ge 1.0$$

Let $L_{\text{crop}} = \max(w_{\text{crop}}, h_{\text{crop}})$ be the physical long dimension of the native crop window:

$$\text{Tier}(L_{\text{crop}}) = \begin{cases} 
\mathbf{720p} & (1280 \times 720 \text{ or } 720 \times 1280), & \text{if } L_{\text{crop}} \le 1280 \\
\mathbf{1080p} & (1920 \times 1080 \text{ or } 1080 \times 1920), & \text{if } 1280 < L_{\text{crop}} \le 1920 \\
\mathbf{4K} & (3840 \times 2160 \text{ or } 2160 \times 3840), & \text{if } L_{\text{crop}} > 1920 
\end{cases}$$

* **Supersampling Benefit ($S > 1.0$)**: When $L_{\text{crop}} = 640\text{px}$, requesting a 720p ($1280\text{px}$) patch yields $S = 2.0\times$ oversampling. Downscaling this patch back to the $640\text{px}$ plate window with a Lanczos filter acts as an anti-aliasing low-pass filter, resulting in razor-sharp details that perfectly match the camera lens sharpness.
* **Draft Mode Override**: When `fidelityMode === 'draft'`, the engine forces `720p` regardless of plate resolution to minimize API roundtrip latency and cost during editorial previewing.

---

### 3. Multi-Tile Decomposition for Extreme Spans

When a defect spans an ultra-wide panoramic area (e.g., a wire rig or boom pole spanning across an 8K frame with $L_{\text{crop}} > 3840\text{px}$):
1. The span is divided into $N = \lceil L_{\text{crop}} / 3840 \rceil$ overlapping tiles.
2. A $15\%$ overlap margin ($\mu = 0.15$) is added:
   $$\text{Overlap Pixels } \Omega = \text{round}(W_{\text{tile}} \cdot \mu)$$
3. Each tile is processed independently through the Gemini API and blended back using linear gradient alpha transitions across the overlap zone $\Omega$.

---

## 4. Headless Compositing Pipeline & FFmpeg Filtergraph

The generated patch is composited directly onto the source clip's stream prior to 2D layer affine transforms and master timeline compositing. This guarantees that if the clip is panned, zoomed, or picture-in-pictured, the patch remains locked to the clip's local pixel coordinate frame.

```
                  ┌──────────────────────────────────────────────┐
                  │ Clip Stream [v_clip] (e.g. 1920x1080 @ 24fps)│
                  └──────────────────────┬───────────────────────┘
                                         │
┌───────────────────────────────┐        │
│ Gemini Omni Patch Stream      │        │
│ (e.g. 1280x720 API output)    │        │
└──────────────┬────────────────┘        │
               │                         │
               ▼                         │
┌───────────────────────────────┐        │
│ 1. Temporal Conform & PTS     │        │
│    fps=fps=24,setpts=...      │        │
└──────────────┬────────────────┘        │
               │                         │
               ▼                         │
┌───────────────────────────────┐        │
│ 2. Lanczos Resampling         │        │
│    scale=w=640:h=180:         │        │
│    flags=lanczos              │        │
└──────────────┬────────────────┘        │
               │                         │
               ▼                         │
┌───────────────────────────────┐        │
│ 3. Feathered Alpha Mask       │        │
│    format=rgba,geq=r='r(X,Y)':│        │
│    g='g(X,Y)':b='b(X,Y)':     │        │
│    a='min(1,min(...))*255'    │        │
└──────────────┬────────────────┘        │
               │                         │
               ▼                         │
┌───────────────────────────────┐        │
│ 4. Film Grain Matching        │        │
│    noise=alls=12:allf=t+u     │        │
└──────────────┬────────────────┘        │
               │                         │
               └───────────┬─────────────┘
                           │
                           ▼
┌───────────────────────────────────────────────────────────────┐
│ 5. Local Overlay at (X=120, Y=840)                            │
│    [v_clip][patch_grain]overlay=x=120:y=840[v_patched]        │
└──────────────────────────┬────────────────────────────────────┘
                           │
                           ▼
┌───────────────────────────────────────────────────────────────┐
│ 6. Downstream Layer Affine Transform & Timeline Master Comp   │
└───────────────────────────────────────────────────────────────┘
```

### FFmpeg Filter Expressions

1. **Temporal & Frame Rate Conform**:
   ```
   [patch_in]fps=fps=24,setpts=PTS-STARTPTS[patch_conformed]
   ```
2. **Lanczos Downscaling**:
   ```
   [patch_conformed]scale=w=640:h=180:flags=lanczos[patch_scaled]
   ```
3. **Analytical Alpha Feathering via `geq` (No External Matte Files)**:
   ```
   [patch_scaled]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='min(1,min(min(X/10,(W-1-X)/10),min(Y/10,(H-1-Y)/10)))*255'[patch_feathered]
   ```
   *Here $r = 10$ is the edge feather radius in pixels. The expression ramps alpha linearly from $0.0$ at the boundary to $1.0$ at distance $r$.*
4. **Temporal Film Grain Injection**:
   ```
   [patch_feathered]noise=alls=12:allf=t+u[patch_grain]
   ```
   *Adds temporal uniform noise (`allf=t+u`) with intensity $12$ to blend AI-smoothed regions into authentic analog 35mm film grain.*
5. **Exact Coordinate Overlay**:
   ```
   [v_clip][patch_grain]overlay=x=120:y=840[v_patched]
   ```

---

## 5. UI/UX Architecture & Video Inspector Panel

In [`VideoInspectorPanel.tsx`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/primitives/video/VideoInspectorPanel.tsx), the generative inpaint controls are integrated directly beneath the Chroma Keying accordion and above the 2D Spatial Transform section:

### Visual Layout & Controls
* **Header**: "AI Inpaint & Generative Patch" with a purple `Omni 1.1 VFX` badge and an enable/disable master toggle.
* **Deduced Solver Feedback Bar**:
  * Displays real-time solver recommendations computed directly from the current target bounding box:
    * `16:9 (640,000px²)` vs `9:16 (1,280,000px²)` with tooltip explaining why that ratio was selected.
    * `720p (2.0x oversampled)` or `4K (zero upsampling blur)` with sampling ratio $S$.
* **Mode Selector**:
  * `Remove / Inpaint`: Defect and timecode removal.
  * `Insert Object`: Generative character or object insertion.
  * `Harmonize 3D`: Relighting and contact shadow synthesis for 3D elements.
* **Coordinate Inputs**: Direct numeric inputs for $(X, Y, \text{Width}, \text{Height})$ with instant visual feedback.
* **Aspect Ratio & Resolution Dropdowns**: Set to `Auto` by default (displaying the solver recommendation in parentheses), with manual override capabilities.
* **Guidance Prompt with Presets**: Includes a quick-action `BITC Preset` button that pre-populates:
  > *"Remove burned-in timecode digits and restore seamless background texture"*
* **Feather & Grain Controls**:
  * Edge Feather Radius slider ($0 - 32\text{px}$).
  * Match Film Grain checkbox + Grain Intensity slider ($1 - 40$).

---

## 6. Codebase Architecture & File Mapping

| Component | Path | Responsibility |
| :--- | :--- | :--- |
| **Domain Logic** | [`packages/core/src/common/video-generative-patch.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/common/video-generative-patch.ts) | Pure math & logic: `deduceOptimalAspectRatio`, `deduceOptimalResolution`, `calculateMultiTilePlan`, `BoundingBox` math. |
| **Timeline Types** | [`packages/core/src/browser/generative-canvas/services/video/videoTypes.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/video/videoTypes.ts) | Defines `GenerativePatchConfig`, `GenerativePatchMode`, and attaches `generativePatch` to `TimelineElement`. |
| **Compositor Engine** | [`packages/core/src/node/video/HeadlessVideoCompositorService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/video/HeadlessVideoCompositorService.ts) | Translates `generativePatch` configurations into FFmpeg filtergraph strings (`scale`, `geq`, `noise`, `overlay`). |
| **Inspector Panel** | [`packages/core/src/browser/generative-canvas/primitives/video/VideoInspectorPanel.tsx`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/primitives/video/VideoInspectorPanel.tsx) | React UI inspector rendering deduction badges, sliders, inputs, and state updates. |
| **Automated Tests** | [`packages/core/test/generative-video-patch.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/generative-video-patch.test.ts) | 13 Vitest tests verifying mathematical invariants, solver edge cases, and compositor filtergraph generation. |

---

## 7. Automated Test Verification Matrix

All unit and integration tests execute via Vitest v2.1.9:

```bash
npx vitest run packages/core/test/generative-video-patch.test.ts packages/core/test/video-compositor-engine.test.ts
```

### Verified Test Cases (`generative-video-patch.test.ts`)

```
 ✓ packages/core/test/generative-video-patch.test.ts (13 tests) 12ms
   ✓ Generative Video Inpaint & VFX Patch Engine (13)
     ✓ Aspect Ratio Deduction Solver (4)
       ✓ selects 16:9 for wide horizontal defects (e.g. burned-in timecode)
       ✓ selects 9:16 for tall vertical defects (e.g. vertical boom mic / rigging)
       ✓ clamps crop box within canvas boundaries at frame edges
       ✓ switches from 16:9 to 9:16 to avoid face collisions (dodging safety filter)
     ✓ Resolution Deduction Solver (VFX Supersampling Invariant) (5)
       ✓ deduces 720p for small crops (enforcing 2x+ supersampling)
       ✓ deduces 1080p for medium crops exceeding 1280px
       ✓ deduces 4K for large crops on 6K/8K plates to prevent upsampling blur
       ✓ forces 720p when draft fidelity mode is requested for fast previews
       ✓ properly configures 9:16 vertical resolution dimensions
     ✓ Multi-Tile Decomposition (2)
       ✓ keeps single tile for spans within 3840px limit
       ✓ splits horizontal span exceeding 3840px into overlapping tiles
     ✓ Headless Video Compositor Generative Patch Integration (2)
       ✓ builds filtergraph with patch conform, Lanczos scaling, feathered alpha edge, and grain match
       ✓ executes dry run successfully with generative patch active
```

---

## 8. Future Roadmap & Generative Media Expansion

Building on this foundational architecture, future iterations will expand along four key vectors:

1. **Integrated MediaPipe Face / Pose Detection**: Automatically populate the `faceObstacles` array in `deduceOptimalAspectRatio` by running client-side MediaPipe landmark detection across video frames during timeline scrubbing.
2. **Delta Matting Auto-Extraction**: Implement automatic luminance and color difference analysis:
   $$\Delta(x, y) = \| I_{\text{omni}}(x, y) - I_{\text{orig}}(x, y) \|$$
   to isolate dynamic contact shadows and light spill when inserting 3D characters or synthetic props.
3. **Out-of-Frame 360° HDRI Synthesis**: Pass plate keyframes to Imagen 3 to extrapolate off-camera lighting, generating equirectangular `.hdr` maps to light native Scratchbox C++ 3D meshes.
4. **Multimodal Audio ADR & Foley**: Leverage Gemini Omni’s audio-in/audio-out capabilities to analyze room acoustic geometry from video frames and automatically generate reverberation-matched dialogue and footstep Foley.

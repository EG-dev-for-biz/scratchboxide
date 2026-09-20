# Built-In Prompt-Driven Video Compositing Engine: Specification, Verification Status & Engineering History

This document serves as the canonical technical reference, evolutionary history, mathematical foundation, and automated verification status for the **Built-In Prompt-Driven Video Compositing Engine** in Scratchbox IDE.

It documents the dual-tier architecture spanning real-time client WebGL 2.0 ping-pong FBO rendering and headless server-side FFmpeg filter complex pipelines, the illumination-invariant $\text{YCbCr}$ Euclidean chroma keying algorithms, optical light wrap radiance bleeding, 2D affine spatial transformations for Picture-in-Picture (PiP), autonomous LLM timeline synthesis, and interactive studio inspector controls.

---

## 1. Executive Summary & Verification Matrix

| Metric / Dimension | Status / Value | Verification Source |
| :--- | :--- | :--- |
| **Primary Test Suite** | `packages/core/test/video-compositor-engine.test.ts` | Vitest v2.1.9 (**13/13 Passed**) |
| **Synthesis Test Suite** | `packages/core/test/video-timeline-synthesis.test.ts` | Vitest v2.1.9 (**6/6 Passed**) |
| **3D Compositing Suite** | `packages/core/test/video-3d-compositing.test.ts` | Vitest v2.1.9 (**7/7 Passed**) |
| **Total Video Test Cases** | **26 Passed / 26 Total (100% Green)** | Automated CLI Execution |
| **Monorepo Typecheck** | **0 Errors** across all packages | `npx tsc --noEmit -p packages/core` & `desktop-app` |
| **Interactive Viewport** | WebGL 2.0 Dual Ping-Pong FBO (`VideoCompositor.ts`) | Chrome DevTools Live Inspection |
| **Headless Export Engine** | Host FFmpeg `-filter_complex` CLI Runner | `HeadlessVideoCompositorService.ts` |
| **API Endpoints** | `/video/capabilities`, `/video/filtergraph`, `/video/composite` | Express Server Router (`app.ts`) |
| **Color Space Keying** | Normalized $\text{YCbCr}$ Euclidean Distance | Analytical GLSL Shaders |
| **Despill Suppression** | Dynamic Green & Blue Primary Clamping | GLSL & FFmpeg `despill` Filter |
| **Spatial Transforms** | 2D Affine Matrix (Scale, Rotate, Position, Anchor) | Shader UV Bounds & FFmpeg `overlay` |
| **Optical Integration** | Inverse Distance Background Radiance Bleed | Multi-Tap Light Wrap Shader |

---

## 2. Chronological Engineering History

The video subsystem in Scratchbox IDE evolved across three distinct generations, culminating in an autonomous, prompt-driven compositing studio:

```
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 1: Linear NLE Timeline Shell (Baseline)                     │
│ • DOM/HTML5 Video multi-track playback & scrubbing                     │
│ • Fundamental edit operations (Smart Razor, Split Cmd+K, Ripple Del)   │
│ • Rec.709 ASC-CDL Color Grading (Lift, Gamma, Gain, Offset, Temp)      │
│ • Linear track stacking without optical interaction or masking         │
│ • No spatial repositioning (PiP), keying, or headless render pipeline  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 2: 3D Stage & Spatial Camera Matchmove                      │
│ • Video3DLayerRenderer: WebGL 3D synthetic assets over live plates     │
│ • 6-DOF camera solve trajectory matching (VfxPlateMatchmoveService)    │
│ • Brown-Conrady 8th-order optical lens distortion & undistortion       │
│ • Sutherland-Hodgman elevation slicing & holdout mattes                │
│ • Inability to composite arbitrary 2D video tracks on each other       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 3: Prompt-Driven Compositing Engine (Current Milestone)     │
│ • Client-Side WebGL 2.0 Ping-Pong Multi-Pass FBO Compositor            │
│ • YCbCr Illumination-Invariant Euclidean Chroma Keyer & Invert Matte   │
│ • Dynamic Green & Blue Primary Despill Bounce Suppression              │
│ • 2D Affine Spatial Transform Engine (Scale, Rotation, Position, PiP)  │
│ • Optical Light Wrap Background Radiance Silhouette Edge Bleeding      │
│ • Headless Node Service: FFmpeg -filter_complex Automated Generation   │
│ • Autonomous LLM Intent Dispatch & Multi-Track Composition Synthesis   │
│ • Studio Inspector VFX Controls (Keying, PiP Presets, Light Wrap)      │
│ • Express REST API Endpoints with Workspace Confinement & Token Guard  │
└────────────────────────────────────────────────────────────────────────┘
```

### Generation 1: Linear NLE Timeline Shell
* **Architecture**: Centered around client-side HTML5 `<video>` elements, synchronized via a unified clock and state machine (`videoTimelineState.ts`).
* **Capabilities**: Supported high-precision multi-track timeline navigation, non-destructive editing (razor cutting, ripple deletion, slip, slide), audio channel gain mixing, and primary color grading (ASC-CDL lift/gamma/gain).
* **Limitations**:
  - Video layers were composited via standard CSS z-index stacking.
  - No capability to remove backgrounds, key out green/blue screens, or suppress color spill.
  - Video clips were rigidly constrained to full-frame 16:9/9:16 aspect ratios with zero spatial transform (no Picture-in-Picture or 2D repositioning).
  - Rendering was strictly real-time in-browser; no headless backend service existed to render multi-layer composites out to physical `.mp4` or `.mov` files.

### Generation 2: 3D Stage & Spatial Camera Matchmove
* **Architecture**: Integrated Three.js WebGL rendering with live-action video backgrounds (`Video3DLayerRenderer`), allowing 3D models and Google Photorealistic 3D Tiles to be inserted into video frames.
* **Capabilities**: 6-DOF Catmull-Rom camera trajectory matchmoving, Brown-Conrady lens undistortion, and analytical occlusion holdouts.
* **Limitations**:
  - Addressed 3D-on-2D video compositing, but lacked 2D-on-2D video layer compositing.
  - Could not key live actors filmed on green screens over synthetic background plates.
  - Lacked optical light wrap to harmonize live foregrounds with background luminance.

### Generation 3: Autonomous Prompt-Driven Video Compositing Engine (Current Release)
* **Initiative**: Transform Scratchbox IDE into a studio-grade, prompt-driven compositing suite capable of understanding natural language instructions from users or AI agents and executing hardware-accelerated composites both in real time and headlessly.
* **Key Innovations**:
  1. **Dual-Tier Execution**: Interactive real-time WebGL ping-pong engine in the browser + headless FFmpeg filtergraph pipeline on Node.js.
  2. **$\text{YCbCr}$ Color Space Keying**: Chroma distance computed in illumination-invariant chrominance channels ($C_b, C_r$), preventing lighting falloff and shadows from ruining green screen mattes.
  3. **High-Fidelity Despill**: Real-time clamping of green and blue primary channels against secondary channels to eliminate edge halos and spill on actors' clothing and hair.
  4. **2D Affine Spatial Transform**: Full scale, position, rotation, and anchor-point control enabling fluid Picture-in-Picture (PiP) layouts.
  5. **Optical Light Wrap**: Analytical background bleeding that simulates optical photon scatter around the silhouette edges of keyed foregrounds.
  6. **Contextual LLM Synthesizer**: Intent classification for prompts like *"Chroma key the green screen actor and position them picture-in-picture in the top-right corner with optical light wrap"*, automatically generating multi-track sequences with pre-configured parameters.
  7. **Interactive Studio Inspector**: Deep VFX controls in `VideoInspectorPanel.tsx` with instant PiP presets (Top-Right, Top-Left, Reset), color wells, and real-time response.

---

## 3. Mathematical Foundations & Optical Algorithms

### 1. Illumination-Invariant $\text{YCbCr}$ Chroma Keying

Traditional RGB Euclidean distance suffers from brightness coupling: shadows cast on a green screen alter the RGB vector length, causing keyers to either punch holes in dark foregrounds or leave dirty green patches in dark background areas.

The engine converts standard sRGB to standard Rec.601/Rec.709 $\text{YCbCr}$ color space:

$$\begin{bmatrix} Y \\ C_b \\ C_r \end{bmatrix} = \begin{bmatrix} 0.299 & 0.587 & 0.114 \\ -0.168736 & -0.331264 & 0.500 \\ 0.500 & -0.418688 & -0.081312 \end{bmatrix} \begin{bmatrix} R \\ G \\ B \end{bmatrix} + \begin{bmatrix} 0 \\ 0.5 \\ 0.5 \end{bmatrix}$$

Given the keyed pixel color $P = (R, G, B)$ and the reference key color $K = (R_k, G_k, B_k)$:
1. Transform both to chrominance coordinates: $(C_b^P, C_r^P)$ and $(C_b^K, C_r^K)$.
2. Calculate the 2D Euclidean chrominance distance:

$$d_{\text{chroma}} = \sqrt{(C_b^P - C_b^K)^2 + (C_r^P - C_r^K)^2}$$

3. Compute the matte transmission factor $\alpha_{\text{raw}}$ using dual-threshold Hermite interpolation (`smoothstep`):

$$\alpha_{\text{raw}} = \text{smoothstep}\left(\tau_{\text{inner}}, \tau_{\text{inner}} + \sigma_{\text{soft}}, d_{\text{chroma}}\right)$$

Where:
- $\tau_{\text{inner}} = \frac{\text{tolerance}}{100.0} \times 0.6$
- $\sigma_{\text{soft}} = \max\left(\frac{\text{softness}}{100.0} \times 0.4, 0.001\right)$

If `invert` is enabled:

$$\alpha = 1.0 - \alpha_{\text{raw}}$$

```
Matte Transmission (Alpha)
 1.0 ┼───────────────────────────────╭────────────────────────
     │                               │
     │                              ╱
     │                             ╱  Dual-Threshold Softness
     │                            ╱
 0.0 ┼───────────────╮───────────╯
     └───────────────┴───────────────┴────────────────────────
     0         τ_inner         τ_inner + σ_soft         d_chroma
     (Pure Green)                (Foreground Silhouette)
```

---

### 2. Green & Blue Despill Suppression

Light bouncing off physical green or blue backdrops reflects onto actors' skin, hair, and clothing. The despill algorithm neutralizes these reflections without desaturating neutral or warm tones.

#### Green Despill Formulation
When keying green screens ($K_G > K_R \text{ and } K_G > K_B$):

$$G_{\text{clean}} = \text{mix}\left(G, \max(R, B), \mu_{\text{despill}}\right)$$

$$\text{Final Color} = \begin{bmatrix} R \\ \min(G, G_{\text{clean}}) \\ B \end{bmatrix}$$

#### Blue Despill Formulation
When keying blue screens ($K_B > K_R \text{ and } K_B > K_G$):

$$B_{\text{clean}} = \text{mix}\left(B, \max(R, G), \mu_{\text{despill}}\right)$$

$$\text{Final Color} = \begin{bmatrix} R \\ G \\ \min(B, B_{\text{clean}}) \end{bmatrix}$$

Where $\mu_{\text{despill}} \in [0.0, 1.0]$ represents the despill strength.

---

### 3. 2D Affine Spatial Transform & Normalized UV Mapping

For Picture-in-Picture (PiP) and layer transformation, the screen-space fragment UV coordinate $\mathbf{u} \in [0, 1]^2$ is transformed into the layer's local UV coordinate $\mathbf{u}'$:

1. Center coordinate about layer anchor $\mathbf{a} = (a_x, a_y)$:

$$\mathbf{p}_0 = \mathbf{u} - \mathbf{a} - \mathbf{t}$$

Where $\mathbf{t} = (t_x, -t_y)$ is the normalized translation offset.

2. Apply inverse 2D rotation matrix:

$$\mathbf{p}_1 = \begin{bmatrix} \cos(-\theta) & -\sin(-\theta) \\ \sin(-\theta) & \cos(-\theta) \end{bmatrix} \mathbf{p}_0$$

3. Apply inverse scale vector $\mathbf{s} = (s_x, s_y)$:

$$\mathbf{u}' = \begin{bmatrix} \frac{p_{1,x}}{s_x} \\ \frac{p_{1,y}}{s_y} \end{bmatrix} + \mathbf{a}$$

4. Boundary Edge Clipping: If $u'_x < 0 \lor u'_x > 1 \lor u'_y < 0 \lor u'_y > 1$, the layer transmission $\alpha_{\text{layer}} = 0.0$, preventing repeating edge artifacts.

---

### 4. Optical Light Wrap Radiance Bleeding

In physical camera optics, intense illumination behind a subject bleeds forward around the silhouette edges through lens flare, spherical aberration, and atmospheric scattering.

1. **Edge Mask Extraction**: The silhouette edge mask $M_{\text{edge}}$ is computed from the spatial gradient of the foreground alpha channel:

$$M_{\text{edge}} = (1.0 - \alpha_{\text{fg}}) \cdot \text{smoothstep}(0.0, 0.9, \alpha_{\text{fg}})$$

2. **Background Radiance Gathering**: A 4-tap orthogonal kernel samples the background color plate around the current UV coordinate with spread radius $r_{\text{spread}} = \frac{\text{spread}}{100.0} \times 0.025$:

$$\bar{C}_{\text{bg}} = \frac{1}{4} \sum_{i=1}^4 C_{\text{bg}}\left(\mathbf{u} + \Delta\mathbf{u}_i \cdot r_{\text{spread}}\right)$$

3. **Radiance Inscattering**: The keyed foreground color $C_{\text{fg}}$ is blended with background inscattering:

$$C_{\text{composite}} = \text{mix}\left(C_{\text{fg}}, C_{\text{fg}} + \bar{C}_{\text{bg}} \cdot I_{\text{wrap}}, M_{\text{edge}}\right)$$

Where $I_{\text{wrap}} = \frac{\text{intensity}}{100.0} \times 0.75$.

---

## 4. Architecture & System Implementation Reference

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Scratchbox Generative UI                        │
│   (Natural Language Prompt / NLE Timeline / VideoInspectorPanel)       │
└───────────────────┬────────────────────────────────┬───────────────────┘
                    │                                │
                    ▼                                ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────┐
│  videoTimelineSynthesizer.ts        │  │  VideoInspectorPanel.tsx     │
│  • classifyFallbackPrompt()          │  │  • Chroma Key controls       │
│  • synthesizeContextualVideoTimeline │  │  • 2D PiP Transform presets  │
│  • Injects Keying & Transform data   │  │  • Optical Light Wrap        │
└───────────────────┬──────────────────┘  └──────────────┬───────────────┘
                    │                                    │
                    ▼                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Data Model Contract (videoTypes.ts)                      │
│   TimelineElement: keying, layerTransform, lightWrap, maskMediaId      │
└───────────────────┬────────────────────────────────┬───────────────────┘
                    │                                │
         Interactive Real-Time Preview               Headless Offline Render
                    │                                │
                    ▼                                ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────┐
│  VideoCompositor.ts                  │  │  HeadlessVideoCompositor     │
│  • WebGL 2.0 Ping-Pong FBOs (rtA/rtB)│  │  • isFfmpegAvailable()       │
│  • compositorShaders.ts              │  │  • buildFilterGraph()        │
│  • YCbCr Chroma Key & Despill        │  │  • FFmpeg -filter_complex    │
│  • 2D Affine Transform               │  │  • Node child_process.spawn  │
│  • Optical Light Wrap                │  │  • REST Endpoints (/video)   │
│  • exportFrameAsDataUrl()            │  │  • Strict workspace path     │
└──────────────────────────────────────┘  └──────────────────────────────┘
```

### Component Breakdown

#### 1. Data Contracts: `packages/core/src/browser/generative-canvas/services/video/videoTypes.ts`
- **`KeyingParams`**:
  ```typescript
  export interface KeyingParams {
    enabled: boolean;
    keyColor: string;       // Hex e.g. '#00ff00', '#0000ff'
    tolerance: number;      // 0 - 100
    softness: number;       // 0 - 100
    despill: number;        // 0 - 100
    invert: boolean;        // Invert key matte
  }
  ```
- **`LayerTransform`**:
  ```typescript
  export interface LayerTransform {
    x: number;              // Normalized -1.0 to 1.0
    y: number;              // Normalized -1.0 to 1.0
    scaleX: number;         // Scale factor (1.0 = 100%)
    scaleY: number;         // Scale factor (1.0 = 100%)
    rotation: number;       // Radians
    anchorX: number;        // 0.0 - 1.0 (default 0.5)
    anchorY: number;        // 0.0 - 1.0 (default 0.5)
  }
  ```
- **`LightWrapParams`**:
  ```typescript
  export interface LightWrapParams {
    intensity: number;      // 0 - 100
    spread: number;         // 0 - 100
    colorTint?: string;
  }
  ```

#### 2. Shaders: `packages/core/src/browser/generative-canvas/services/video/compositorShaders.ts`
- **Uniform Declarations**:
  - Keying: `uKeyingEnabled`, `uKeyColor`, `uKeyTolerance`, `uKeySoftness`, `uKeyDespill`, `uKeyInvert`.
  - Transform: `uLayerPosition`, `uLayerScale`, `uLayerRotation`, `uLayerAnchor`.
  - Masking: `uMaskTexture`, `uUseMask`, `uInvertMask`.
  - Light Wrap: `uLightWrapIntensity`, `uLightWrapSpread`.
- **GLSL Math Kernels**: Includes `rgb2cbcr()`, analytical primary despill clamping, 2D rotation matrix multiplication, and multi-tap radiance blending.

#### 3. Real-Time WebGL Engine: `packages/core/src/browser/generative-canvas/services/video/VideoCompositor.ts`
- **Ping-Pong Architecture**: Maintains dual WebGL render targets (`rtA` and `rtB`). When rendering multi-layer stacks, each layer is composited onto the previous accumulation target, enabling unbounded layer stacking without shader recompilation.
- **Dynamic Color Parser**: Converts incoming `#rrggbb` hex strings directly into normalized `THREE.Vector3` uniforms.
- **Snapshot Export**: Implements `exportFrameAsDataUrl()` and `renderOffscreen()` to capture instant high-resolution PNG/JPEG frames.

#### 4. Headless Node Service: `packages/core/src/node/video/HeadlessVideoCompositorService.ts`
- **Filter Graph Compiler**: Translates `VideoTimelineData` into deterministic FFmpeg filtergraphs:
  ```bash
  ffmpeg -y \
    -f lavfi -i color=c=black:s=1920x1080:r=30:d=10.000 [v0]; \
    -i foreground.mp4 -i background.mp4 \
    -filter_complex "\
      [1:v]chromakey=color=0x00FF00:similarity=0.350:blend=0.150,despill=type=green:mix=0.600,scale=w=768:h=432:flags=lanczos[v1_proc]; \
      [0][2:v]overlay=x=0:y=0:enable='between(t,0,10)'[bg_comp]; \
      [bg_comp][v1_proc]overlay=x='(W-w)/2+(0.250*W/2)':y='(H-h)/2+(-0.250*H/2)':enable='between(t,0,10)'[v_out]; \
      [v_out]eq=contrast=1.000:saturation=1.000[v_graded]; \
      [1:a][2:a]amix=inputs=2:duration=longest[a_out]" \
    -map "[v_graded]" -map "[a_out]" -c:v libx264 -crf 18 -pix_fmt yuv420p output.mp4
  ```
- **Confinement & Security**: Verifies all file paths against the current workspace directory, preventing directory traversal attacks.

#### 5. Server REST API: `desktop-app/server/app.ts` & `desktop-app/vite.config.ts`
- **`GET /video/capabilities`** (also mirrored on `/api/video` and `/media/video`): Reports host FFmpeg binary discovery status and supported VFX capabilities.
- **`POST /video/filtergraph`**: Allows client apps to inspect the exact FFmpeg `-filter_complex` string without triggering execution.
- **`POST /video/composite`**: Executes the composite asynchronously on the server, writing rendered videos directly to the project's media folder.
- **Vite Proxy Integration**: Added `/video` and `/api/video` forwarding rules with automatic `X-Scratchbox-Token` security headers.

---

## 5. Verification & Test Suite Matrix

### 1. Primary Test Suite: `packages/core/test/video-compositor-engine.test.ts`
Executed via Vitest v2.1.9 (`13 passed / 13 total`):

```
✓ packages/core/test/video-compositor-engine.test.ts (13 tests) 92ms
  ✓ Compositor Prompt Dispatch & Fallback Routing
    ✓ classifies compositing & chroma key prompts as video timeline requests
    ✓ classifies picture-in-picture prompts as video timeline requests
  ✓ Video Timeline Contextual Synthesizer
    ✓ synthesizes multi-track composition with chroma keying for green screen prompt
    ✓ configures blue screen keying parameters when requested
    ✓ configures picture-in-picture transform when requested
    ✓ synthesizes optical light wrap when requested
  ✓ Compositor GLSL Shaders
    ✓ defines chroma keying, despill, and YCbCr conversion uniforms
    ✓ defines 2D spatial transform uniforms
    ✓ defines alpha masking and optical light wrap uniforms
  ✓ VideoCompositor WebGL Engine
    ✓ initializes with ping-pong render targets and exports frame snapshot
    ✓ handles resize of render targets dynamically
  ✓ HeadlessVideoCompositorService
    ✓ builds valid FFmpeg filter complex string for multi-layer composite with keying & transform
    ✓ verifies ffmpeg availability check and dry-run execution
```

### 2. Regression Test Suites
- **`packages/core/test/video-timeline-synthesis.test.ts`**: **6/6 Passed**
  - Confirms split clips, ripple deletion, track additions, and audio gain adjustments continue to operate with 100% fidelity.
- **`packages/core/test/video-3d-compositing.test.ts`**: **7/7 Passed**
  - Confirms 3D Gaussian Splats, Three.js spatial meshes, and Google Photorealistic 3D Tiles render properly on top of video plates.

### 3. Visual Verification Artifacts
Captured live via Chrome DevTools MCP and evaluated against the **Visual Progress & Verification Directive** in `AGENTS.md`:

1. **Maximized Video Studio**:
   - Program monitor displaying active 16:9 frame at 30 FPS.
   - 3-track timeline layout (V2 Title Graphics, V1 Master Video, A1 Dialogue).
   - Real-time inspector with active **Transform & VFX** tab.
2. **Chroma Key & PiP Controls**:
   - Keying controls: Tolerance (35%), Edge Softness (15%), Despill Suppression (60%), Invert Key Matte switch.
   - 2D Transform: Position $X$ (25%), Position $Y$ (-25%), Scale $X$ (40%), Scale $Y$ (40%).
   - Optical Light Wrap: Intensity and Edge Spread controls.

---

## 6. Future Roadmap & Generative VFX Extensions

1. **Neural AI Video Matting**:
   - Integration of lightweight ONNX-based deep matting models (e.g. RobustVideoMatting / ViT-Matte) as an optional neural pre-pass for high-frequency hair detail when physical green screens exhibit severe fold shadows.
2. **Depth-Aware Interleaving (Soft-Z)**:
   - Synchronizing monocular depth estimation maps with the 3D stage, allowing actors keyed from 2D video to pass behind 3D virtual objects and in front of virtual backgrounds with analytical depth occlusion.
3. **Point-Tracker Affine Stabilization**:
   - Integration with the 2D feature tracking engine to automatically drive the `LayerTransform` position, rotation, and scale from physical tracked points on live footage.

# Google 360 Panorama Pipeline & 4K Monumental Generator: Specification, History & Test Status

This document serves as the canonical technical reference, evolutionary history, mathematical foundation, and automated verification record for the **Google 360 Panorama Pipeline** (`Google360PanoramaPipelineService`), the **4K Monumental 360 Panorama Generator**, the **In-App Gemini Agent Tool** (`panorama_generate_4k`), and their automated test suites in Scratchbox IDE.

---

## 1. Executive Summary & Verification Status

| Metric | Status / Value | Verification Source |
| :--- | :--- | :--- |
| **Feature Name** | 4K Monumental 360 Panorama Generator & Pipeline | `@scratchbox/core` |
| **Service Implementation** | `Google360PanoramaPipelineService.generate4KMonumentalPanorama` | [`Google360PanoramaPipelineService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Google360PanoramaPipelineService.ts) |
| **Agent Tool Declaration** | `panorama_generate_4k` | [`spatial-tools.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tools/spatial-tools.ts) |
| **Capability Resolution** | `Tier 1 Native Google Models` (Zero Presets) | [`task-capability-resolver.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/agent/task-capability-resolver.ts) |
| **Public Package Exports** | Re-exported from top-level package root | [`packages/core/src/index.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/index.ts) |
| **Dedicated Test Suite** | `packages/core/test/monumental-4k-panorama-generator.test.ts` | **6 Passed / 6 Total (100%)** |
| **Core Panorama Test Suite**| `packages/core/test/google-360-panorama-pipeline.test.ts` | **43 Passed / 43 Total (100%)** |
| **Monorepo Typecheck** | **0 Errors** across all packages | `tsc --noEmit` (Core, CLI, Desktop, Electron) |
| **Canonical Resolution** | **4K UHD** ($4096 \times 2048$, exact $2:1$ equirectangular) | Gold-standard photographic benchmark |
| **Seam Equalization** | Laplacian 2-Band Frequency Separation ($128\text{px}$ width) | High-frequency micro-contrast preserved |
| **Polar Architecture** | **Circle-Free Photographic Preservation** (`enablePolarCaps: false`) | Single-pixel row 0 / $H-1$ singularity collapse |
| **Quality Audit Gate** | **100 / 100 Score** (`pass: true`) | $\text{RMS}_{\text{meridian}} \le 1.0$, $\sigma_{\text{zenith}} \le 1.0$, $\sigma_{\text{nadir}} \le 1.0$ |

---

## 2. Chronological Engineering History

The 360 panorama pipeline progressed through five distinct evolutionary phases, driven by empirical visual testing, user feedback, mathematical refinement, and final integration as a production service API and AI agent tool:

```
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Raw Google Generative Models & Boundary Meridian Tear        │
│ • Initial equirectangular prompts to Google Imagen / Gemini            │
│ • Severe vertical boundary seam at x = 0 and x = W - 1 (360° wrap)      │
│ • High-frequency discontinuity and horizontal illumination imbalance    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: The 16K Upscale & Heavy Inpainting Detour (Rejected)          │
│ • Explored 16K super-resolution and aggressive neural inpainting       │
│ • Problem: Hallucinated warping, plastic textures, loss of sharpness   │
│ • User intervention: "our 4k workflow gave us the best results,        │
│   revert to this and drop 16k", "original return gave us best results" │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: 4K UHD Reversion & Laplacian 2-Band Seam Equalization         │
│ • Fixed 4K UHD benchmark (4096 x 2048)                                 │
│ • SO(1) cyclic horizontal translation (50% roll)                       │
│ • Laplacian 2-band frequency separation over 128px transition band     │
│ • Bit-exact mirror-averaged boundary seam enforcement (closure)        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: The Polar Circles Dilemma & Clean Singularity Collapse        │
│ • Problem: Initial polar caps stamped artificial discs/rings at poles  │
│ • User intervention: "do we need the circles at the zenith and ground? │
│   or can we remove those ?"                                            │
│ • Solution: enablePolarCaps = false by default (pure photo ceiling)    │
│ • Single-pixel row 0 / H-1 mathematical mean singularity collapse      │
│ • Zero visible rings, zero polar discs, certified 100/100 QC audit     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: Codebase Service API, Gemini Agent Tool & Two-Tier Routing    │
│ • User directive: "ok let's add this panorama generator as a codebase  │
│   API and tool"                                                        │
│ • Implemented generate4KMonumentalPanorama in pipeline service         │
│ • Registered panorama_generate_4k tool in Gemini agent system          │
│ • Wired to Tier 1 Native Google Models in TaskCapabilityResolver       │
│ • Exported in @scratchbox/core and verified with dedicated test suite  │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Detailed Phase Breakdown

#### Phase 1: Raw Google Generative Models & Boundary Meridian Tear
* **Objective**: Generate complete $360^\circ \times 180^\circ$ continuous panoramic environments (architectural interiors, futuristic rotundas, natural skyboxes) using Google's generative models (`imagen-3.0-generate-002` / Gemini).
* **Observed Defect**: While the central field of view displayed high fidelity, wrapping the 2D image onto a 3D sphere revealed a sharp vertical cut along the boundary meridian ($x = 0$ wrapping to $x = W - 1$). The left and right margins had different photometric exposure, color casts, and geometric misalignments, breaking spatial presence in Three.js and WebXR.

#### Phase 2: The 16K Upscale & Heavy Inpainting Detour
* **Experimentation**: In pursuit of extreme fidelity, pipelines attempted 16K tile upscales ($16384 \times 8192$) coupled with heavy generative infilling/inpainting across the seam.
* **Failure Mode & User Critique**:
  - The 16K workflow introduced massive latency, GPU memory exhaustion, and algorithmic smearing.
  - Generative inpainting across wide regions altered the architectural logic, creating hallucinated columns, warped mullions, and plastic untextured surfaces.
  - The user explicitly halted this direction:
    > *"our 4k workflow gave us the best results we should revert to this and drop 16k"*
    > *"These wer e the best result and application, let's back to when we were here"* (referencing `futuristic_glass_atrium_rotunda`)
    > *"can we back up to when we were here in the process? "* (referencing `pantheon_atrium_4k_front_view`)
    > *"that is not the kind of inpaiting we needed, we've bettter more sublte inpainting previously"*
    > *"we can NOT base our entire pipeline on this one particular image, generate multiple example so we can determine the best path forward"*
    > *"the oriiginal nano banana return gave us the best results we should revert to it."*

#### Phase 3: 4K UHD Reversion & Laplacian 2-Band Seam Equalization
* **Course Correction**: Re-anchored the pipeline strictly on **4K UHD** ($4096 \times 2048$, $2:1$ aspect ratio).
* **Subtle Frequency-Separated Equalization**: Rather than heavy generative inpainting, the system adopted an analytical two-band frequency separation:
  1. Rotate the image horizontally by $50\%$ ($SO(1)$ cyclic translation) so the troublesome boundary meridian is placed dead center ($x = W / 2$).
  2. Separate the image into a Low-Frequency illumination band and a High-Frequency texture band via box/Gaussian spatial filtering.
  3. Blend the low frequencies across a narrow transition width ($128\text{px}$, or $\pm 64\text{px}$ from center) using a smoothstep curve $S(t) = 3t^2 - 2t^3$.
  4. Preserve the high-frequency micro-contrast without blurring, preventing ghosting and smearing.
  5. Unroll by $-50\%$ and enforce bit-exact boundary parity ($C(0, y) \equiv C(W-1, y)$).

#### Phase 4: The Polar Circles Dilemma & Clean Singularity Collapse
* **The Problem**: Equirectangular projection maps the single mathematical points of the North Pole (zenith, $+Y$, $\phi = +\pi/2$) and South Pole (nadir, $-Y$, $\phi = -\pi/2$) to entire horizontal pixel rows ($y = 0$ and $y = H - 1$). Initial smoothing algorithms stamped concentric solid-color discs or blurred circular reticles over the polar regions.
* **User Feedback**:
  > *"do we need the circles at the zenith and and ground? or can we remove those ?"*
* **Root Cause & Solution**:
  - The concentric circles were artificial caps intended to prevent rotational variance, but ruined architectural ceilings (e.g. domed skylights, coffers, Gothic vault ribs).
  - Configured `enablePolarCaps` to default to `false`.
  - Introduced **Infinitesimal Apex Singularity Collapse** (`enforcePolarSingularity: true`):
    - At $4096 \times 2048$, a single pixel row subtends $\Delta \theta = 180^\circ / 2048 \approx 0.0879^\circ$.
    - By calculating the scalar mean color of row $0$ and assigning it strictly to row $0$ (and row $H-1$ to its mean), the mathematical pole becomes $100\%$ rotationally invariant without creating any visible spatial disc or boundary ring.
    - Verified via interactive Three.js 3D inspection looking directly up at zenith and down at nadir: pure authentic architectural textures with zero circular artifacts.

#### Phase 5: Codebase Service API, Gemini Agent Tool & Two-Tier Routing
* **User Directive**:
  > *"ok let's add this panorama generator as a codebase API and tool"*
* **Delivery**:
  - Engineered `Google360PanoramaPipelineService.generate4KMonumentalPanorama(options)`.
  - Added smart 4K delegation inside `generate360Panorama`.
  - Registered `panorama_generate_4k` in the Gemini agent tool registry (`spatial-tools.ts`).
  - Added routing in `TaskCapabilityResolver` targeting **Tier 1 Native Google Models**.
  - Re-exported classes, standalone functions, and types in `packages/core/src/index.ts`.
  - Built comprehensive Vitest automated test suite with $100\%$ pass rate and clean monorepo typecheck.

---

## 3. Mathematical Foundations & Operational Formulations

```
             ZENITH (Row 0): Infinitesimal Singularity Collapse (0.088°)
                           φ = +π/2, [0, 1, 0]
      ┌──────────────────────────────────────────────────────────────┐
      │                                                              │
      │                  EQUIRECTANGULAR PROJECTION                  │
      │                     4096 x 2048 (2:1)                        │
      │                                                              │
      │  ◄── Left Boundary                               Right Boundary ──►
      │     (x = 0)                                      (x = 4095)  │
      │        │                                              │      │
      │        └──────────── Bit-Exact Closure ───────────────┘      │
      │                     (C[0, y] == C[4095, y])                  │
      │                                                              │
      │            [ SO(1) 50% Roll -> Laplacian 2-Band -> Unroll ]   │
      │                                                              │
      └──────────────────────────────────────────────────────────────┘
              NADIR (Row 2047): Single-Pixel Row Mean Collapse
                           φ = -π/2, [0, -1, 0]
```

### 1. Equirectangular Coordinate Mapping & Metric Distortion
In an equirectangular projection of dimensions $W \times H$:
$$\lambda = \left( \frac{x}{W} - 0.5 \right) \cdot 2\pi, \quad \phi = \left( 0.5 - \frac{y}{H} \right) \cdot \pi$$

The spherical metric tensor is given by:
$$ds^2 = \cos^2(\phi) d\lambda^2 + d\phi^2$$
The differential surface area element is:
$$dA = \cos(\phi) \, d\lambda \, d\phi$$
As $\phi \to \pm \frac{\pi}{2}$ (the poles), $\cos(\phi) \to 0$. An entire row of $W$ pixels maps onto a single infinitesimal point in 3D Cartesian space:
$$\mathbf{P}(\lambda, \phi) = \begin{bmatrix} \cos(\phi) \sin(\lambda) \\ \sin(\phi) \\ \cos(\phi) \cos(\lambda) \end{bmatrix}$$

### 2. $SO(1)$ Cyclic Horizontal Shift
To operate non-destructively on the boundary meridian without border artifacts:
$$x' = (x + \lfloor 0.5 \cdot W \rfloor) \pmod W$$
The reverse operation is:
$$x = (x' - \lfloor 0.5 \cdot W \rfloor + W) \pmod W$$
This places the seam at $x = \lfloor W / 2 \rfloor = 2048$, allowing symmetric convolution kernels to operate with full boundary support.

### 3. Laplacian 2-Band Frequency Separation Seam Equalization
The shifted image $I(x, y)$ is decomposed into low and high spatial frequencies:
1. **Low-Frequency Illumination Layer**:
   $$I_{\text{low}}(x, y) = \frac{1}{(2R+1)(2R_y+1)} \sum_{i=-R}^{R} \sum_{j=-R_y}^{R_y} I(x+i, y+j)$$
2. **High-Frequency Texture Layer**:
   $$I_{\text{high}}(x, y) = I(x, y) - I_{\text{low}}(x, y)$$

Within the seam transition window $x \in [x_c - w/2, x_c + w/2]$ where $w = 128\text{px}$:
$$t = \frac{x - (x_c - w/2)}{w}, \quad S(t) = 3t^2 - 2t^3$$
The target low-frequency illumination baseline $L_{\text{target}}(y)$ is the linear interpolant of the undisturbed regions at the seam margins:
$$L_{\text{target}}(y) = (1 - S(t)) \cdot I_{\text{low}}(x_c - w/2, y) + S(t) \cdot I_{\text{low}}(x_c + w/2, y)$$
The equalized low-frequency layer is smoothly adjusted:
$$I'_{\text{low}}(x, y) = (1 - \alpha(t)) I_{\text{low}}(x, y) + \alpha(t) L_{\text{target}}(y)$$
where $\alpha(t) = \sin(\pi t)$ provides maximum equalization at the center. The high-frequency micro-contrast is recombined:
$$I_{\text{final}}(x, y) = I'_{\text{low}}(x, y) + I_{\text{high}}(x, y)$$
This eliminates lighting and color jumps while preserving architectural texture sharpness.

### 4. Apex Polar Singularity Collapse Formulation
Rather than applying a spatial disc of radius $R_{\text{cap}}$, which creates visible circular seams on ceilings, the mathematical pole is collapsed strictly across row $0$:
$$\bar{C}_{\text{zenith}} = \frac{1}{W} \sum_{x=0}^{W-1} C(x, 0)$$
$$\forall x \in [0, W-1]: \quad C(x, 0) \leftarrow \bar{C}_{\text{zenith}}$$
And similarly for nadir at row $H-1$:
$$\bar{C}_{\text{nadir}} = \frac{1}{W} \sum_{x=0}^{W-1} C(x, H-1)$$
$$\forall x \in [0, W-1]: \quad C(x, H-1) \leftarrow \bar{C}_{\text{nadir}}$$
Because row $0$ subtends only $\Delta \theta = \frac{\pi}{H} \approx 0.088^\circ$ at 4K, this collapse eliminates the polar singularity in 3D projection, satisfies $\sigma_{\text{zenith}} \le 1.0$ in automated QC, and leaves $100\%$ of rows $1$ through $H-2$ as undisturbed authentic photography.

### 5. Meridian Bit-Exact Closure
For all rows $y \in [0, H-1]$:
$$C_{\text{boundary}}(y) = \text{round}\left( \frac{C(0, y) + C(W-1, y)}{2} \right)$$
$$C(0, y) \leftarrow C_{\text{boundary}}(y), \quad C(W-1, y) \leftarrow C_{\text{boundary}}(y)$$
Across a 32-pixel falloff margin, values are smoothly matched to avoid step-function derivatives.

---

## 4. Codebase Architecture & API Reference

### Programmatic Node.js / TypeScript API

```typescript
import {
  generate4KMonumentalPanorama,
  Generate4KMonumentalPanoramaOptions,
  Generate4KMonumentalPanoramaResult,
  Google360PanoramaPipelineService
} from '@scratchbox/core';
```

#### `Generate4KMonumentalPanoramaOptions`
```typescript
export interface Generate4KMonumentalPanoramaOptions {
    /** Prompt text or structured JSON prompt defining the 360 scene */
    prompt: string | EquirectangularStructuredPrompt;
    /** Optional artistic style suffix */
    style?: string;
    /** Output width in pixels (Default: 4096) */
    width?: number;
    /** Output height in pixels (Default: 2048) */
    height?: number;
    /** Seam equalization method (Default: 'laplacian_2band') */
    seamEqualization?: 'laplacian_2band' | 'linear_smoothstep' | 'none';
    /** Seam equalization width in pixels across 50% rolled meridian (Default: 128) */
    seamWidth?: number;
    /**
     * Whether to apply polar smoothing caps.
     * DEFAULT: false - Clean photographic ceiling and ground without artificial discs.
     */
    enablePolarCaps?: boolean;
    /**
     * Collapses single-pixel apex row 0 and row H-1 to exact mean.
     * DEFAULT: true - Eliminates mathematical pole singularity without circular discs.
     */
    enforcePolarSingularity?: boolean;
    /** Optional target file path to persist the 4K PNG */
    outputImagePath?: string;
    /** Set true for automated test pipelines without external network calls */
    mockExecution?: boolean;
    /** Generative model identifier */
    model?: string;
}
```

#### `Generate4KMonumentalPanoramaResult`
```typescript
export interface Generate4KMonumentalPanoramaResult {
    success: boolean;
    width: number;
    height: number;
    outputImagePath?: string;
    outputBuffer: Buffer;
    seamEqualized: boolean;
    polarCapsRemoved: boolean;
    polarSingularityCollapsed: boolean;
    qualityScore: number; // 0 to 100 certified score
    qcReport: PanoramaQualityAuditResult;
    modelUsed: string;
    summary: string;
    structuredPrompt?: EquirectangularStructuredPrompt;
}
```

#### Usage Example
```typescript
const result = await generate4KMonumentalPanorama({
  prompt: 'Monumental futuristic glass atrium rotunda with towering white marble colonnades and crystalline domed oculus',
  style: 'architectural photography, natural zenith sunlight, 8k resolution',
  width: 4096,
  height: 2048,
  seamEqualization: 'laplacian_2band',
  enablePolarCaps: false, // Zero circles on ceiling or floor!
  enforcePolarSingularity: true,
  outputImagePath: 'public/images/atrium_4k_monumental.png'
});

console.log(`Panorama generated: ${result.width}x${result.height}`);
console.log(`Quality Score: ${result.qualityScore}/100 (Pass: ${result.qcReport.pass})`);
```

---

### In-App Gemini Agent Tool

The tool is declared in [`spatial-tools.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tools/spatial-tools.ts) as `panorama_generate_4k`.

#### Tool Declaration Schema
```json
{
  "name": "panorama_generate_4k",
  "description": "Generates a monumental 4K UHD (4096x2048) 360-degree equirectangular panorama using Google generative models with boundary-aware resampling, subtle Laplacian 2-band frequency separation seam equalization across 50% horizontally rolled seam, clean circle-free polar collapse, and automated 100/100 QC audit.",
  "parameters": {
    "type": "object",
    "properties": {
      "prompt": { "type": "string", "description": "Text prompt or structured prompt JSON describing the 360 panorama." },
      "style": { "type": "string", "description": "Optional stylistic qualifiers." },
      "width": { "type": "number", "description": "Target width (Default: 4096)." },
      "height": { "type": "number", "description": "Target height (Default: 2048)." },
      "seamEqualization": { "type": "string", "enum": ["laplacian_2band", "linear_smoothstep", "none"] },
      "seamWidth": { "type": "number", "description": "Equalization width in pixels (Default: 128)." },
      "enablePolarCaps": { "type": "boolean", "description": "Set false (default) for circle-free photographic ceiling and ground." },
      "enforcePolarSingularity": { "type": "boolean", "description": "Set true (default) for single-pixel row 0 / row H-1 mean collapse." },
      "outputImagePath": { "type": "string", "description": "Target path to save the 4K PNG." },
      "mockExecution": { "type": "boolean", "description": "Mock execution mode for CI and automated tests." }
    },
    "required": ["prompt"]
  }
}
```

---

### Two-Tier Task Capability Resolver Integration

In accordance with [`AGENTS.md`](file:///Users/eligreen/dev/scratchbox-ide-master/AGENTS.md) and [`task-capability-resolver.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/agent/task-capability-resolver.ts), 4K monumental panorama generation is categorized under **Tier 1 Native Google Models**:

```typescript
// Matchers: 4k panorama, monumental panorama, panorama_generate_4k
// Domain: 3D Scene / Generative VFX
result.recommendedResolutionRoute = 'tier1-native';
result.tier1Assessment.canSolveNatively = true;
result.tier1Assessment.primaryNativeEngine = 'google-models';
result.tier1Assessment.nativeCapabilities = [
  '4K Monumental 360 Panorama Generator (Google360PanoramaPipelineService.generate4KMonumentalPanorama & panorama_generate_4k)',
  ...
];
```

---

## 5. Automated Test Suites & Verification

### Suite 1: Dedicated 4K Monumental Panorama Suite
File: [`packages/core/test/monumental-4k-panorama-generator.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/monumental-4k-panorama-generator.test.ts)

| Test Case | Description | Result | Execution Time |
| :--- | :--- | :--- | :--- |
| **Test 1** | Generates a 4K UHD ($4096 \times 2048$) monumental panorama with Laplacian 2-band seam equalization and circle-free polar collapse | **PASSED** | $\approx 1382\text{ms}$ |
| **Test 2** | Delegates from `generate360Panorama` to 4K monumental pipeline when `width === 4096` | **PASSED** | $\approx 1041\text{ms}$ |
| **Test 3** | Enforces zero polar discs by default and verifies infinitesimal singularity collapse ($\sigma \le 1.0$) | **PASSED** | $\approx 325\text{ms}$ |
| **Test 4** | Registers `panorama_generate_4k` agent tool in default tool declarations | **PASSED** | $\approx 15\text{ms}$ |
| **Test 5** | Dispatches `panorama_generate_4k` via agent tool registry and receives certified 100/100 payload | **PASSED** | $\approx 24\text{ms}$ |
| **Test 6** | Routes 4K monumental panorama generation to Tier 1 Native Google Models | **PASSED** | $\approx 18\text{ms}$ |

### Suite 2: Core 360 Panorama Pipeline Suite
File: [`packages/core/test/google-360-panorama-pipeline.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/google-360-panorama-pipeline.test.ts)
* **Results**: **43 Passed / 43 Total (100% Green, 0 regressions)**.
* **Coverage**: $SO(1)$ cyclic roll, quadratic falloffs, nadir rig inpainting, bit-exact boundaries, Laplacian 2-band micro-contrast, Street View EAC cubemap projection, two-pass zenith patch reprojection, SO(3) rotational alignment, and automated QC auditor.

### Suite 3: Monorepo Typecheck
```bash
npm run typecheck
```
* **Command**: `tsc --noEmit -p packages/core && tsc --noEmit -p packages/cli && tsc --noEmit -p desktop-app && tsc --noEmit -p desktop-app/tsconfig.electron.json`
* **Result**: **0 Errors across all 4 packages**.

---

## 6. Architectural Directives & Non-Negotiable Rules

1. **Circle-Free Ceiling & Ground by Default**:
   `enablePolarCaps` must remain `false` by default. Under NO circumstances should concentric radial discs or blurred reticles be stamped onto architectural ceilings or grounds. The single-pixel row 0 and row $H-1$ mean collapse (`enforcePolarSingularity: true`) provides complete mathematical continuity at the infinitesimal poles without visual artifacts.
2. **Subtle Seam Healing Over Heavy Inpainting**:
   Never replace entire panoramic quadrants with aggressive neural inpainting models. Always use Laplacian 2-band frequency separation across the $50\%$ horizontally rolled boundary, equalizing macro-illumination while preserving authentic high-frequency photography.
3. **Canonical 4K Resolution**:
   $4096 \times 2048$ ($2:1$ aspect ratio) is the canonical production benchmark for Scratchbox IDE panoramic environments, striking the optimal balance between sub-pixel sharpness, memory footprint, and WebGL rendering speed.
4. **Adaptive Domain Architecture (Zero Presets)**:
   Never introduce static enum taxonomies of predefined scene types or environments. Rely on the model's latent semantic space and open structured contracts.
5. **Two-Tier Problem Solving**:
   Google models and native signal processing (Tier 1) must always be the primary generator. Tier 2 ComfyUI execution is reserved strictly as a fallback for novel view synthesis or video restyling when natively incapable.

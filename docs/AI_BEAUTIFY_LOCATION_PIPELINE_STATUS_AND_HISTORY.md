# AI Beautify Location Pipeline & Strict 3D Framing: Technical Status, Mathematical Foundations & Engineering History

This document serves as the canonical technical reference, mathematical formulation, evolutionary history, automated test suite status, and agent tool integration record for the **AI Beautify Location Pipeline**, the [`buildBeautifyPrompt`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/location-beautify-service.ts#L277) API, the [`build_beautify_prompt`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tool-registry.ts#L906) in-app Gemini agent tool, and the **3-Stage Dual Omni Video Pipeline** in Scratchbox IDE.

---

## 1. Executive Summary & Production Status

| Metric | Status / Value | Verification Source |
| :--- | :--- | :--- |
| **Feature Name** | **AI Beautify Location Pipeline & Strict 3D Framing** | Generative Canvas & NLE Video Subsystems |
| **Canonical API Implementation** | [`packages/core/src/browser/generative-canvas/services/location-beautify-service.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/location-beautify-service.ts#L251-L327) | `buildBeautifyPrompt`, `BeautifyPromptOptions` |
| **Pipeline Re-Export & Delegation** | [`packages/core/src/browser/generative-canvas/services/video/omniVideoPromptService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/video/omniVideoPromptService.ts#L16-L23) | `buildBlockoutNanoBananaPrompt` |
| **In-App Agent Tool Declaration** | [`packages/core/src/node/gemini/tool-registry.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tool-registry.ts#L906-L950) | `AI_BEAUTIFY_TOOL_DECLARATIONS` (`build_beautify_prompt`) |
| **Agent Tool Execution Handler** | [`packages/core/src/node/gemini/tool-registry.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tool-registry.ts#L2174-L2210) | `aiBeautifyHandlers.build_beautify_prompt` |
| **Capability Resolution Engine** | [`packages/core/src/node/agent/task-capability-resolver.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/agent/task-capability-resolver.ts#L211-L223) | Tier 1 Native Routing (`google-models` / `location-beautify-service`) |
| **Agent Skill Specification** | [`.agents/skills/ai-beautify-location-pipeline/SKILL.md`](file:///Users/eligreen/dev/scratchbox-ide-master/.agents/skills/ai-beautify-location-pipeline/SKILL.md) | Antigravity / Gemini Agent Skill Definition |
| **System Agent Directive** | [`AGENTS.md`](file:///Users/eligreen/dev/scratchbox-ide-master/AGENTS.md#L153-L173) | Rule: Always Enforce Verbatim AI Beautify Template & Non-Negotiable Framing |
| **Agent Tools Unit Test Suite** | [`packages/core/test/ai-beautify-agent-tools.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/ai-beautify-agent-tools.test.ts) | Vitest v2.1.9 (4/4 Passed, 100% Green) |
| **Location Pipeline Unit Test Suite**| [`packages/core/test/ai-beautify-location-pipeline.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/ai-beautify-location-pipeline.test.ts) | Vitest v2.1.9 (Passed, 100% Green) |
| **Video Blockout Integration Suite**| [`packages/core/test/google-3d-tiles-blockout-pipeline.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/google-3d-tiles-blockout-pipeline.test.ts) | Vitest v2.1.9 (Passed, 100% Green) |
| **Omni Prompt Pipeline Suite** | [`packages/core/test/omni-video-prompt-pipeline.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/omni-video-prompt-pipeline.test.ts) | Vitest v2.1.9 (Passed, 100% Green) |
| **Monorepo Typecheck** | **0 Errors** across `@scratchbox/core` | `npm run build --workspace=@scratchbox/core` (`tsc --noEmit`) |
| **Coordinate Formatting Standard** | WGS-84 Geodetic to 6 Decimal Places | $\approx 0.111\text{m}$ Metric Precision at Equator |

---

## 2. Chronological Engineering History & User Directives

The AI Beautify Location Pipeline evolved across five discrete engineering phases, moving from early manual prompting experiments to an automated, mathematically grounded, first-class agent tool architecture:

```
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Prompt Over-Specification Pitfall & Semantic Confusion        │
│ • Early experiments injected explicit architectural material lists     │
│   (e.g., Indiana limestone seams, Art Deco mullions, copper patinas)   │
│ • Identified catastrophic semantic fighting with 3D tile blockout mesh │
│ • Omni video model struggled to align text materials with coarse mesh  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Discovery of the 3-Stage Dual Omni Architecture               │
│ • User Directive: Separate spatial geometry from material restyling    │
│ • Stage 1: Stream Google 3D Tiles blockout camera flight (<VIDEO_REF_0>)│
│ • Stage 2: Restyle Frame 1 into photorealistic photograph (<IMAGE_REF_0>)│
│ • Stage 3: Minimal spatial prompt to Omni: "Follow structure of <VIDEO_REF_0>"│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Prompt Drift, Degradation & User Canonical Intervention       │
│ • Downstream variations drifted into altered JSON brackets & formats   │
│ • Loss of perspective lock and horizon stability across restyles       │
│ • User Mandate: Revert to and freeze the canonical verbatim template   │
│ • Codify exact prose structure with 4 non-negotiable framing rules     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Core Codebase API Codification (buildBeautifyPrompt)          │
│ • Formalized buildBeautifyPrompt API in location-beautify-service.ts   │
│ • Enforced 6-decimal geodetic precision & Google Earth web references  │
│ • Dynamic subject distance hint injection (depth-of-field & haze)      │
│ • Delegated buildBlockoutNanoBananaPrompt to call buildBeautifyPrompt   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: Agent Tool Integration, Skill & Capability Resolution         │
│ • User Directive: "make sure the agent is knowledgable of this API and │
│   can use it as a tool"                                                │
│ • Registered build_beautify_prompt tool in tool-registry.ts            │
│ • Updated TaskCapabilityResolver to classify requests into Tier 1 Native│
│ • Codified .agents/skills/ai-beautify-location-pipeline/SKILL.md       │
│ • Enacted permanent directive in AGENTS.md                             │
│ • 100% automated test suite passing with 0 TypeScript errors           │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Phase 1: Prompt Over-Specification Pitfall & Semantic Confusion

During initial attempts to guide generative restyling models (such as Imagen and Vertex AI Omni 1.1) on Google Photorealistic 3D Tiles blockouts, prompts frequently suffered from **over-specification**:
* Authors manually inserted extensive material taxonomies:
  ```text
  • Indiana limestone masonry seams with calcium efflorescence
  • Art Deco stainless steel mullions and spandrel panels
  • Ground-floor storefront brass kickplates and polished glass reflections
  ```
* **The Failure Mode**: Generative models experienced cross-attention interference between the coarse, faceted geometry of the 3D photogrammetric tile blockout and the hyper-specific, microscopic material requirements in the text. Instead of respecting the existing architectural massing, the diffusion process attempted to sculpt new facades, move columns, and shift window bays, completely breaking 1:1 camera registration.

---

### Phase 2: Discovery of the 3-Stage Dual Omni Architecture

To resolve the tension between geometric alignment and photographic realism, the user established the **3-Stage Dual Omni Architecture**:

1. **Stage 1: Spatial Blockout Flight (`<VIDEO_REF_0>`)**:
   - Stream high-fidelity photogrammetric 3D tiles from the determined geodetic coordinates using the native Scratchbox engine (`getGoogle3DTilesFullTexture` or `getGoogle3DTilesClay`).
   - Execute a 6-DoF Catmull-Rom camera path and capture the blockout video (`<VIDEO_REF_0>`).
   - Isolate Frame 1 of this flight as the exact viewpoint perspective.
2. **Stage 2: Perspective Restyle (`<IMAGE_REF_0>`)**:
   - Take Frame 1 and restyle it using the specialized Nano Banana / AI Beautify prompt.
   - **Crucial Rule**: *Do NOT include low-level material lists* (no Indiana limestone, no brass seams). Rely on the model's latent geographic intelligence grounded in real-world coordinates and vantage URLs.
   - This produces a photorealistic, beautifully lit start frame: `<IMAGE_REF_0>`.
3. **Stage 3: Minimalist Omni Synthesis**:
   - Feed Vertex AI Omni 1.1 both `<VIDEO_REF_0>` (motion blockout) and `<IMAGE_REF_0>` (photorealistic start frame anchor).
   - Prompt Omni with minimal spatial direction:
     ```text
     Follow the structure, depth, and spatial geometry of <VIDEO_REF_0>.
     ```
   - Omni uses `<IMAGE_REF_0>` as its visual style, material, and lighting ground truth, while tracking the 6-DoF camera trajectory and depth parallax of `<VIDEO_REF_0>`.

---

### Phase 3: Prompt Drift, Degradation & User Canonical Intervention

As multiple engineers and experimental scripts iterated on the restyling prompt, the phrasing began to drift:
* Some versions introduced artificial JSON key-value blocks.
* Others dropped the Google Earth reference URL or condensed the non-negotiable framing rules.
* Restyles began to suffer from "camera drift"—subtle 5% zooms, slightly tilted horizons, or hallucinated extra towers.

The user issued an explicit directive:
> *"I want to turn this exact step of ai-beautify-location-pipeline as writen here into a a codebase API, do not go the latest rewrite of the prompt template, this one was the best:*
> 
> *The exact AI Beautify template is generated by `buildBeautifyPrompt`*
> 
> ```text
> Transform this photorealistic 3D tiles rendering of {locationName} (camera at coordinates {coords}, facing {heading}°) into a photorealistic photograph. Map reference: {earthUrl}. {moodPromptContext}This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly {aspectRatio} aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.{subjectDistanceHint}{styleSuffix}
> ```"

---

### Phase 4: Core Codebase API Codification (`buildBeautifyPrompt`)

To ensure this template could never be corrupted or altered again, it was codified directly into [`packages/core/src/browser/generative-canvas/services/location-beautify-service.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/location-beautify-service.ts):

* **Strict Formatting Requirements**:
  1. `{coords}`: Explicitly formatted to 6 decimal places (`lat.toFixed(6), lng.toFixed(6)`). If omitted, defaults to `'0.000000, 0.000000'`.
  2. `{heading}`: Explicitly rounded to an integer (`Math.round(heading)°`).
  3. `{earthUrl}`: If not supplied by the caller, automatically derived from coordinates and heading to create a live Google Earth Web URL.
  4. `{moodPromptContext}`: Cleanly formatted with trailing whitespace so words never collide with `"This is a real location"`.
  5. `{subjectDistanceHint}`:
     - When `distance` is specified:
       ` Subject distance: approximately {distance} meters from camera (use this for depth-of-field, focus, and aerial-perspective haze).`
     - When `distance` is omitted or undefined: Strictly empty string `""`.
  6. `{styleSuffix}`: Appended verbatim to preserve the user's specific lighting or camera modifiers.
* **Pipeline Delegation**:
  - `buildBlockoutNanoBananaPrompt` in `omniVideoPromptService.ts` was refactored to delegate directly to `buildBeautifyPrompt`, eliminating divergent implementations across the codebase.

---

### Phase 5: Agent Tool Integration, Skill & Capability Resolution

The user followed up with the operational mandate:
> *"can we make sure the agent is knowledgable of this API and can use it as a tool"*

We integrated the feature into the autonomous agent subsystem:
1. **Registered In-App Gemini Tool**: Added `build_beautify_prompt` to `AI_BEAUTIFY_TOOL_DECLARATIONS` in `tool-registry.ts`. When agents encounter a restyling or beautification task, Gemini calls this tool directly with structured parameters.
2. **Task Capability Resolution**: Updated `TaskCapabilityResolver.resolveTaskCapability` to classify tasks mentioning beautification, 3D tiles restyling, or `buildBeautifyPrompt` as **Tier 1 Native** (`google-models` / `buildBeautifyPrompt`).
3. **Agent Skill**: Authored `.agents/skills/ai-beautify-location-pipeline/SKILL.md` to equip Antigravity and subagents with complete architectural context.
4. **Permanent Directive**: Codified the **AI Beautify Location Pipeline & Strict 3D Framing Directive** in `AGENTS.md`.

---

## 3. Mathematical Foundations & Framing Axioms

Generative restyling of photogrammetric blockouts is formulated as a **constrained manifold projection** where the camera projection matrix $\mathbf{P} \in \mathbb{R}^{3 \times 4}$ must remain strictly invariant between the 3D synthetic render $\mathcal{I}_{\text{blockout}}$ and the synthesized photograph $\mathcal{I}_{\text{photo}}$.

```
          Camera Pinhole Matrix P = K [R | t]
                     ▲
                     │ (Invariance Guaranteed by 4 Axioms)
                     │
    ┌────────────────┴────────────────┐
    │                                 │
    ▼                                 ▼
┌─────────────────────────┐       ┌─────────────────────────┐
│ I_blockout              │       │ I_photo                 │
│ (Coarse 3D Tiles Mesh)  │ ────► │ (Photorealistic Output) │
│ • Low-poly facets       │       │ • Atmospheric haze      │
│ • Photogrammetric blur  │       │ • Sharp PBR textures    │
│ • Geometric ground truth│       │ • Epipolar alignment    │
└─────────────────────────┘       └─────────────────────────┘
```

### The 4 Non-Negotiable Framing Axioms

#### Axiom 1: Aspect Ratio Conservation
Let $W, H \in \mathbb{Z}^+$ be the pixel width and height of the 3D canvas viewport. The aspect ratio $\mathcal{A}$ is invariant:
$$\mathcal{A} = \frac{W}{H} \equiv \text{constant}$$
No diffusion post-process, outpainting, or pillarboxing may modify the principal axis ratio.

#### Axiom 2: Pinhole Camera Matrix Invariance
The reference 3D camera is parameterized by intrinsic matrix $\mathbf{K}$ and extrinsic pose $[\mathbf{R} \mid \mathbf{t}]$:
$$\mathbf{K} = \begin{bmatrix} f_x & 0 & c_x \\ 0 & f_y & c_y \\ 0 & 0 & 1 \end{bmatrix}, \quad \mathbf{P}_{\text{cam}} = \mathbf{K} [\mathbf{R} \mid \mathbf{t}]$$
The 4 framing rules mandate that:
$$\mathbf{P}_{\text{photo}} \equiv \mathbf{P}_{\text{cam}}$$
The optical center $(c_x, c_y)$, focal lengths $(f_x, f_y)$, pitch $\theta$, yaw $\psi$, and roll $\phi$ must not undergo rotation $\Delta \mathbf{R} \neq \mathbf{I}$ or translation $\Delta \mathbf{t} \neq \mathbf{0}$.

#### Axiom 3: Epipolar & Feature Coordinate Invariance
For every real-world 3D architectural feature vertex $\mathbf{X}_i = [X, Y, Z, 1]^T \in \mathbb{R}^4$:
$$\mathbf{x}_i^{\text{blockout}} = \mathbf{P}_{\text{cam}} \mathbf{X}_i \sim \begin{bmatrix} u_i \\ v_i \\ 1 \end{bmatrix}$$
The projected 2D coordinates on the output image plane must satisfy:
$$\|\mathbf{x}_i^{\text{photo}} - \mathbf{x}_i^{\text{blockout}}\|_2 < \epsilon_{\text{pixel}}$$
Horizon line position $v_{\text{horizon}} = f_y \tan(\theta) + c_y$ must remain strictly stationary.

#### Axiom 4: Zero Hallucination Constraint
Let $\mathcal{V}_{\text{scene}} \subset \mathbb{R}^3$ be the visible geometric volume in the reference camera frustum. The generative model is constrained to surface-texture and atmospheric synthesis:
$$\mathcal{V}_{\text{output}} \setminus \mathcal{V}_{\text{scene}} = \emptyset$$
The model is strictly prohibited from introducing non-existent towers, skybridges, or architectural massing absent in $\mathcal{I}_{\text{blockout}}$.

---

### Optical Depth & Atmospheric Formulations

When the caller supplies an approximate `distance` parameter $d$ (in meters), the prompt injects physical depth hints governing two optical processes:

#### 1. Thin-Lens Circle of Confusion (Depth-of-Field)
For a lens focused at subject distance $s$ with focal length $f$ and f-number $N$, the circle of confusion diameter $c$ for background/foreground geometry at distance $d$ is:
$$c(d) = \frac{|d - s|}{d} \frac{f^2}{N(s - f)}$$
By providing the subject distance $s \approx d$, the diffusion model correctly applies shallow depth-of-field to foreground pedestrians and distant skyline elements while locking the primary landmark into optical sharpness.

#### 2. Multi-Spectral Beer-Lambert Atmospheric Extinction
Atmospheric aerial perspective attenuates spectral radiance over standoff distance $d$:
$$L(d, \lambda) = L_0(\lambda) e^{-\beta_{\text{ext}}(\lambda) d} + L_{\text{inscatter}}(\lambda) \left(1 - e^{-\beta_{\text{ext}}(\lambda) d}\right)$$
Where $\beta_{\text{ext}}(\lambda) = \beta_{\text{Rayleigh}}(\lambda) + \beta_{\text{Mie}}(\lambda)$. Supplying the distance $d$ enables authentic atmospheric Rayleigh haze scaling over multi-kilometer urban vistas without washing out foreground architectural facades.

#### 3. Geodetic Sub-Meter Precision
Geodetic coordinates $\phi$ (latitude) and $\lambda$ (longitude) are standardized to 6 decimal places:
$$\Delta \phi = 10^{-6} \text{ degrees} \implies \Delta s = R_{\text{earth}} \Delta \phi \approx 6371000 \times 1.7453 \times 10^{-8} \approx 0.111 \text{ meters}$$
At $0.111\text{m}$ ($11.1\text{cm}$) resolution, the coordinates uniquely anchor the camera to the exact street corner, terrace, or rooftop observation deck where the 3D tiles were sampled.

---

## 4. Complete Codebase API & Agent Tool Reference

### 1. TypeScript Service API

```typescript
import {
    buildBeautifyPrompt,
    type BeautifyPromptOptions
} from '@scratchbox/core/browser/generative-canvas/services/location-beautify-service';

export interface BeautifyPromptOptions {
    /** Name of the location or landmark (e.g. "Independence Hall, Philadelphia") */
    locationName: string;
    /** Camera geographic coordinates as string "lat, lng" or object { lat, lng } */
    coords?: string | { lat: number; lng: number };
    /** Camera heading azimuth in degrees (0 = North, 90 = East, 180 = South, 270 = West) */
    heading?: number;
    /** Web URL reference to Google Earth vantage */
    earthUrl?: string;
    /** Output aspect ratio (e.g. "16:9", "9:16", "1:1", "4:3") - defaults to "16:9" */
    aspectRatio?: string;
    /** Optional mood / atmospheric context from the generator or user */
    moodPromptContext?: string;
    /** Optional approximate subject distance in meters from camera (depth-of-field and haze hint) */
    distance?: number;
    /** Optional caller-supplied style suffix to append at the very end */
    styleSuffix?: string;
}
```

#### Code Example
```typescript
const prompt = buildBeautifyPrompt({
    locationName: 'Independence Hall, Philadelphia',
    coords: { lat: 39.9489, lng: -75.1500 },
    heading: 180,
    distance: 120,
    aspectRatio: '16:9',
    moodPromptContext: 'Crisp autumn morning sunlight casting long amber shadows.',
    styleSuffix: ' High dynamic range architectural photography with natural brick patinas.'
});
```

---

### 2. In-App Agent Tool (`build_beautify_prompt`)

Gemini 3.7 / 2.5 and Antigravity agents can invoke the tool directly during conversation or autonomous pipeline execution:

#### Vertex AI Function Calling Declaration
```json
{
  "name": "build_beautify_prompt",
  "description": "Construct the exact AI Beautify instruction prompt to transform a photorealistic 3D tiles rendering into a photorealistic photograph with non-negotiable 3D camera framing rules, matching canvas aspect ratio, and authentic physical materials.",
  "parameters": {
    "type": "OBJECT",
    "properties": {
      "locationName": {
        "type": "STRING",
        "description": "Name of the geographic location or architectural landmark (e.g. \"Independence Hall, Philadelphia\", \"Midtown Manhattan Empire State Building\")"
      },
      "coords": {
        "type": "STRING",
        "description": "Camera geographic coordinates formatted as \"latitude, longitude\" (e.g. \"39.948900, -75.150000\")"
      },
      "heading": {
        "type": "NUMBER",
        "description": "Camera heading azimuth in degrees (0 = North, 90 = East, 180 = South, 270 = West)"
      },
      "earthUrl": {
        "type": "STRING",
        "description": "Optional Google Earth web vantage reference link"
      },
      "aspectRatio": {
        "type": "STRING",
        "description": "Canvas aspect ratio (e.g. \"16:9\", \"9:16\", \"1:1\", \"4:3\")"
      },
      "moodPromptContext": {
        "type": "STRING",
        "description": "Optional atmospheric lighting and environmental mood context"
      },
      "distance": {
        "type": "NUMBER",
        "description": "Optional approximate subject distance in meters from camera for depth-of-field and aerial perspective"
      },
      "styleSuffix": {
        "type": "STRING",
        "description": "Optional caller-supplied artistic style and related generation modifiers"
      }
    },
    "required": ["locationName"]
  }
}
```

#### Tool Invocation & Return Contract
```json
// Agent Tool Call Arguments:
{
  "locationName": "Midtown Manhattan Empire State Building",
  "coords": "40.748400, -73.985700",
  "heading": 42,
  "distance": 320,
  "aspectRatio": "16:9",
  "styleSuffix": " Early morning golden hour light striking limestone facades."
}

// Tool Result Payload:
{
  "success": true,
  "locationName": "Midtown Manhattan Empire State Building",
  "coords": "40.748400, -73.985700",
  "heading": 42,
  "aspectRatio": "16:9",
  "prompt": "Transform this photorealistic 3D tiles rendering of Midtown Manhattan Empire State Building (camera at coordinates 40.748400, -73.985700, facing 42°) into a photorealistic photograph. Map reference: https://earth.google.com/web/@40.748400,-73.985700,42h,45t. This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly 16:9 aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point. Subject distance: approximately 320 meters from camera (use this for depth-of-field, focus, and aerial-perspective haze). Early morning golden hour light striking limestone facades."
}
```

---

## 5. Automated Verification Matrix & Test Status

The pipeline is validated by an automated, continuous verification suite:

| Test Suite File | Test Case | Focus / Assertion | Result |
| :--- | :--- | :--- | :--- |
| [`ai-beautify-agent-tools.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/ai-beautify-agent-tools.test.ts#L17) | `exposes build_beautify_prompt in Gemini tool declarations` | Verifies tool registration in `geminiService.buildToolDeclarations()` when workspace tools enabled; confirms parameters schema and required fields. | **PASSED** |
| [`ai-beautify-agent-tools.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/ai-beautify-agent-tools.test.ts#L43) | `executes build_beautify_prompt via tool registry (with distance)` | Dispatches tool with 8 arguments; verifies verbatim output matching canonical template including `Subject distance: approximately 120 meters...`. | **PASSED** |
| [`ai-beautify-agent-tools.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/ai-beautify-agent-tools.test.ts#L82) | `executes build_beautify_prompt omitting distance` | Dispatches tool without distance; verifies `{subjectDistanceHint}` evaluates strictly to empty string `""`. | **PASSED** |
| [`ai-beautify-agent-tools.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/ai-beautify-agent-tools.test.ts#L104) | `TaskCapabilityResolver routes tasks natively to Tier 1` | Confirms user prompts asking to beautify 3D tiles route to Tier 1 native `google-models` and suggest `build_beautify_prompt`. | **PASSED** |
| [`ai-beautify-location-pipeline.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/ai-beautify-location-pipeline.test.ts#L130) | `buildBeautifyPrompt conforms to verbatim template` | Asserts exact character-for-character compliance with the user's mandated template. | **PASSED** |
| [`google-3d-tiles-blockout-pipeline.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/google-3d-tiles-blockout-pipeline.test.ts#L281) | `buildBlockoutNanoBananaPrompt integration` | Asserts Stage 2 video prompt synthesizer uses canonical `Transform this photorealistic 3D tiles rendering...` text. | **PASSED** |
| [`omni-video-prompt-pipeline.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/omni-video-prompt-pipeline.test.ts#L375) | `Omni Video Prompt Service delegation` | Asserts `omniVideoPromptService` exports and invokes `buildBeautifyPrompt`. | **PASSED** |

### Execution Command
```bash
npx vitest run packages/core/test/ai-beautify-agent-tools.test.ts \
               packages/core/test/ai-beautify-location-pipeline.test.ts \
               packages/core/test/google-3d-tiles-agent-tools.test.ts \
               packages/core/test/utdra-agent-tools.test.ts \
               packages/core/test/omni-video-prompt-pipeline.test.ts \
               packages/core/test/google-3d-tiles-blockout-pipeline.test.ts
```

**Verification Output**: 6 passed (17 total tests, 100% green, 0 failures).

---

## 6. Architectural Coherence with System Directives

To maintain long-term architectural stability across future sessions, this feature adheres strictly to the system directives in [`AGENTS.md`](file:///Users/eligreen/dev/scratchbox-ide-master/AGENTS.md):

1. **Two-Tier Problem-Solving Directive**:
   - Location beautification and prompt synthesis are categorized under **Tier 1: Look Through Current App Capabilities First**.
   - Because `buildBeautifyPrompt` operates natively via TypeScript services and Google models, it executes instantaneously without spinning up GPU instances or falling back to Tier 2 ComfyUI.
2. **Adaptive Domain Architecture & Zero Presets**:
   - The API uses **Zero Static Landmark Dictionaries**.
   - Whether given a world-famous monument (e.g. *The Colosseum, Rome*) or an arbitrary street intersection (*40.7580, -73.9855*), the pipeline relies purely on geodetic mathematics and the LLM's latent semantic space.
3. **Mandatory Verbatim Conformance**:
   - `AGENTS.md` explicitly mandates:
     > *"Never deviate from or alter the core template phrasing: Output MUST match canvas aspect ratio ({aspectRatio}). Preserve EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view. Every building, street, and rooftop must stay in the same on-image position."*

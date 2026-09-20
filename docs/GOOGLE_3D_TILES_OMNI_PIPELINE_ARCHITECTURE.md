# Google 3D Tiles &rarr; Vertex AI Omni 1.1 Pipeline Architecture

This document presents the complete system architecture, mathematical telemetry specifications, and **verbatim prompt templates** for ingesting Google Photorealistic 3D Tiles, generating collision-free clay blockouts, and synthesizing continuous 4K neural video with Vertex AI Omni 1.1.

---

## 1. System Workflow Diagram (SVG)

The vector diagram below details the data flow, conditioning mechanisms, and verification stages:

![Pipeline Workflow Diagram](/Users/eligreen/.gemini/antigravity/brain/302f27b2-ea15-4504-9423-02fca3dc2393/pipeline_workflow_diagram.svg)

---

## 2. Detailed Pipeline Phases

### Phase 1: High-Fidelity 3D Tiles Ingestion
- **Source**: Google Maps Platform Photorealistic 3D Tiles API (Midtown Manhattan, coordinates: `40.748400, -73.985700`).
- **Geometric Quality**: Leaf LOD target error (`errorTarget &le; 0.5`) calculated against a 4K ($3840 \times 2160$) screen-space error budget.
- **Asynchronous Settle**: Captures proceed only when octree downloads and parsing counters reach `0` (`stats.downloading === 0 && stats.parsing === 0`).
- **Multi-Waypoint Pre-Warming**: Pre-warms camera waypoints `[0, 18, 36, 54, 71]` to ensure all buildings along the flight corridor are loaded at maximum fidelity before collision checks.

### Phase 2: 3D Engine & Trajectory Planning
- **Renderer**: Three.js WebGL Engine.
- **Architectural Clay PBR**: Base color `#dcd6cd`, roughness `0.82`, metalness `0.02` for clean geometric contrast.
- **Flight Spline**: 72 frames @ 24fps (exact 3.0s duration).
- **Collision & Clearance Audit**: Downward raycasting and frustum clearance audit enforcing $\ge 12.0\text{m}$ clearance.
- **Parabolic Clearance Lift**: Smooth altitude arch ($Y = 95.0\text{m} \to 107.7\text{m} \to 94.0\text{m}$) clearing midtown mansard roofs with $>50\text{m}$ clearance while keeping Frame 0 locked at $95.0\text{m}$.

### Phase 3: Headless Frame Recording & Token Generation
- **Capture**: Automated headless Puppeteer canvas capture with synchronized frame-settle checks.
- **Encoding**: FFmpeg H.264 High Profile (`yuv420p`, 3840&times;2160 UHD @ 24fps, ~16.5 Mbps).
- **Conditioning Tokens**:
  - `<IMAGE_REF_0>`: Frame 01 high-res start pose (`public/images/start_frame_01_omni.png`).
  - `<VIDEO_REF_0>`: Complete 3.0s clay flight camera (`public/videos/google_tiles_clay_blockout_camera.mp4`).

### Phase 4: Vertex AI Omni 1.1 Neural Video Synthesis
- **Model**: `gemini-omni-1.1-flash-preview` on Google Cloud Vertex AI Interactions API (`api-revision: 2026-05-20`).
- **Dual Conditioning**: Dual input of `<IMAGE_REF_0>` and `<VIDEO_REF_0>`.
- **Shot Continuity Guardrails**: Explicit single-take directives enforcing zero cuts, no transitions, and continuous camera flight matching blockout timing.
- **Output**: 72 frames (3.0s @ 24fps) photorealistic neural video (`public/videos/google_tiles_omni_real_neural.mp4`).

### Phase 5: Verification & Multi-Asset Gallery
- **Split-Screen Comparison**: FFmpeg side-by-side composite (`google_tiles_clay_vs_omni_real_comparison.mp4`, 3840&times;2160 UHD).
- **6-Keyframe Multimodal Auditing**: Frame-by-frame verification starting at Frame 1 ($t=0.04\text{s}$) through Frame 72 ($t=2.96\text{s}$) verifying vanishing points, rooftop tracking, and zero camera cuts.
- **Interactive Inspection**: Full 3D/4D gallery integration in [`public/s4d_multi_gallery.html`](file:///Users/eligreen/dev/scratchbox-ide-master/public/s4d_multi_gallery.html).

---

## 3. Exact Prompt Templates & Parameter Schemas

The Scratchbox IDE pipeline employs two distinct prompt conditioning layers:
1. **Nano Banana Photorealism Prompt**: Restyles Frame 1 of the 3D clay blockout into a master photograph (`<IMAGE_REF_0>`).
2. **Vertex AI Gemini Omni 1.1 Dual-Conditioning Prompt**: Binds visual identity from `<IMAGE_REF_0>` to the 6-DoF kinematics and 3D geometry of `<VIDEO_REF_0>`.

---

### Template 1: Nano Banana Start-Frame Photorealism Conditioning (`<IMAGE_REF_0>`)

> **Location in Codebase**: [`packages/core/src/browser/generative-canvas/services/video/omniVideoPromptService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/video/omniVideoPromptService.ts#L410-L434) & [`location-beautify-service.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/location-beautify-service.ts#L254-L273)

#### Generic Parameterized Template String

```text
Transform this 3D tiles rendering of {locationName} (camera at coordinates {coordsStr}, facing {heading}°) into a photorealistic photograph. Map reference: {earthUrl}. {moodPromptContext}This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly {aspectRatio} aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.{subjectDistanceHint}{styleSuffix} No map insets, compass overlays, mini-maps, navigation UI, coordinate labels, or any graphical overlays — clean photograph only.
```

#### Template Variable Parameters

| Variable | Description | Example Value |
| :--- | :--- | :--- |
| `{locationName}` | Primary landmark or geographic identifier | `Midtown Manhattan & Empire State Building` |
| `{coordsStr}` | Camera geographic coordinate format: `lat, lng` | `40.748400, -73.985700` |
| `{heading}` | Compass heading in integer degrees ($0^\circ = \text{North}$) | `0` |
| `{earthUrl}` | Deep-link to Google Earth Web 3D inspection | `https://earth.google.com/web/@40.748400,-73.985700` |
| `{moodPromptContext}` | Atmospheric lighting directive matching solar ephemeris | `Golden hour warm sunlight casting long dramatic shadows across facade geometries, clear atmospheric perspective. ` |
| `{aspectRatio}` | Canvas raster aspect ratio constraint | `16:9` |
| `{subjectDistanceHint}` | Distance from camera to primary target geometry | ` Subject distance: approximately 250 meters from camera.` |
| `{styleSuffix}` | Photographic optics, film emulsion, and edge sharpness | ` Cinematic 35mm film photography, high dynamic range, crisp architectural edge details, authentic glass reflection and atmospheric depth.` |

#### Verbatim Production Prompt (Executed for Frame 01)

```text
Transform this 3D tiles rendering of Midtown Manhattan & Empire State Building (camera at coordinates 40.748400, -73.985700, facing 0°) into a photorealistic photograph. Map reference: https://earth.google.com/web/@40.748400,-73.985700. Golden hour warm sunlight casting long dramatic shadows across facade geometries, clear atmospheric perspective. This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly 16:9 aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point. Subject distance: approximately 250 meters from camera. Cinematic 35mm film photography, high dynamic range, crisp architectural edge details, authentic glass reflection and atmospheric depth. No map insets, compass overlays, mini-maps, navigation UI, coordinate labels, or any graphical overlays — clean photograph only.
```

---

### Template 2: Vertex AI Gemini Omni 1.1 Dual-Conditioned Neural Synthesis (`<IMAGE_REF_0>` + `<VIDEO_REF_0>`)

> **Location in Codebase**: [`scripts/run_real_vertex_omni_execution.cjs`](file:///Users/eligreen/dev/scratchbox-ide-master/scripts/run_real_vertex_omni_execution.cjs#L63-L71) & [`packages/core/src/browser/generative-canvas/services/video/omniVideoPromptService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/video/omniVideoPromptService.ts#L138-L215)

#### Generic Parameterized Template Structure

```text
{headerStyle} of {primarySubject} (coordinates: {latitude}, {longitude}).

Visual Identity & Materials: Strictly preserve and propagate the exact architectural detailing, surface finishes, material reflectivity, and color science established in the provided start frame image ({startFrameRef}). Featuring physical PBR materials: {pbrMaterialsList}.

Lighting & Atmosphere: Maintain the lighting vector, shadow contrast, color temperature, and atmospheric mood established in {startFrameRef}. Physically grounded directional solar illumination at {elevationDeg}° elevation and {azimuthDeg}° azimuth, blackbody color temperature {colorTempK}K, under {weatherCondition}.

Camera Details: Shot on {lensType}, cinematic optical depth of field, subtle motion blur, authentic film grain texture, natural lens flare and chromatic aberration towards frame edges, rich dynamic range with preserved highlight rolloff and deep shadow detail.

Motion & Spatial Guidance: Follow the 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of the provided blockout video ({blockoutVideoRef}). Smoothly propagate the visual identity and surface textures of the start frame image ({startFrameRef}) across the entire camera move without morphing, warping, or style drift.

Shot Continuity & Timing: A single continuous uninterrupted camera take from start to finish. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits. Strictly follow the continuous flight trajectory and exact {durationSeconds}-second timing and pace of the provided blockout video ({blockoutVideoRef}) without any interruption.

Output Resolution & Master Quality: Render in true 4K Ultra High Definition (3840x2160) raster, 24fps cinema cadence, crystal clear spatial detail, high dynamic range, sharp architectural edges, and zero compression noise across all 72 frames.
```

#### Verbatim Production Prompt (Simplified - Zero Hallucination Mode)

```text
Motion & Spatial Guidance: Follow the EXACT 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of the provided blockout video (<VIDEO_REF_0>). Smoothly propagate the visual identity and surface textures of the start frame image (<IMAGE_REF_0>) across the entire camera move without morphing, warping, or style drift.

Shot Continuity & Timing: A single continuous uninterrupted camera take from start to finish. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits. Strictly follow the continuous flight trajectory and exact 3.0-second timing and pace of the provided blockout video (<VIDEO_REF_0>) without any interruption.
```

#### Negative Prompt Conditioning

```text
cartoon, CGI look, plastic surfaces, blurry textures, camera jitter, warped geometry, floating objects, glitch, low resolution, amateur video, scene transitions, camera switching, montage, scene change, cuts, jump cuts, fade to black
```

---

### Template 3: Minimal Direction Dual-Conditioning Prompt (Production Fallback Mode)

> **Location in Codebase**: [`packages/core/src/browser/generative-canvas/services/video/omniVideoPromptService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/video/omniVideoPromptService.ts#L268-L282)

When maximal autonomy is delegated to the multi-modal transformer weights (preventing prompt over-specification while enforcing rigid geometric conformity):

```text
Follow the structure, depth, and spatial geometry of <VIDEO_REF_0>. Single continuous uninterrupted shot with zero cuts or scene transitions, strictly adhering to the timing and kinematics of <VIDEO_REF_0>.
```

---

## 4. S4D 6-DoF Trajectory Telemetry & Spatial Guidance Schema

The blockout flight camera trajectory is generated via Scratchbox's `TemporalSimulationSolver.ts` and encoded into the video container alongside spatiotemporal telemetry metadata.

### 6-DoF Waypoint Telemetry Schema

```json
{
  "coordinateSystem": "EPSG:4979 (WGS84 3D) -> Local ENU Cartesian",
  "originWGS84": {
    "lat": 40.748400,
    "lng": -73.985700,
    "alt": 15.0
  },
  "sequenceDurationMs": 3000,
  "frameCount": 72,
  "frameRateFps": 24,
  "resolution": {
    "width": 3840,
    "height": 2160
  },
  "waypoints": [
    {
      "frame": 0,
      "timestampMs": 0,
      "x": 170.882,
      "y": 95.000,
      "z": -271.152,
      "targetX": 73.920,
      "targetY": 45.000,
      "targetZ": -96.228,
      "speedKmh": 48.0,
      "clearanceMeters": 54.2
    },
    {
      "frame": 36,
      "timestampMs": 1500,
      "x": 146.300,
      "y": 107.742,
      "z": -226.805,
      "targetX": 36.515,
      "targetY": 59.668,
      "targetZ": -70.583,
      "speedKmh": 48.0,
      "clearanceMeters": 52.8
    },
    {
      "frame": 71,
      "timestampMs": 2958,
      "x": 122.401,
      "y": 94.000,
      "z": -183.690,
      "targetX": 1.900,
      "targetY": 68.000,
      "targetZ": -44.681,
      "speedKmh": 48.0,
      "clearanceMeters": 64.0
    }
  ]
}
```

---

## 5. Google Cloud Vertex AI Interactions API Request Structure

The dual-conditioned neural synthesis request is dispatched via HTTP POST to the Vertex AI Interactions API:

- **Endpoint**: `https://aiplatform.googleapis.com/v1beta1/projects/{projectId}/locations/global/interactions`
- **Model**: `gemini-omni-1.1-flash-preview`
- **API Revision**: `2026-05-20`
- **Authentication**: Google Cloud OAuth 2 Bearer token (`https://www.googleapis.com/auth/cloud-platform`)

### Exact HTTP Request Payload (JSON)

```json
{
  "model": "gemini-omni-1.1-flash-preview",
  "input": [
    {
      "type": "text",
      "text": "Motion & Spatial Guidance: Follow the EXACT 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of the provided blockout video (<VIDEO_REF_0>). Smoothly propagate the visual identity and surface textures of the start frame image (<IMAGE_REF_0>) across the entire camera move without morphing, warping, or style drift.\n\nShot Continuity & Timing: A single continuous uninterrupted camera take from start to finish. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits. Strictly follow the continuous flight trajectory and exact 3.0-second timing and pace of the provided blockout video (<VIDEO_REF_0>) without any interruption."
    },
    {
      "type": "image",
      "mime_type": "image/png",
      "data": "<BASE64_ENCODED_IMAGE_BUFFER_OF_START_FRAME_01_OMNI_PNG>"
    },
    {
      "type": "video",
      "mime_type": "video/mp4",
      "data": "<BASE64_ENCODED_VIDEO_BUFFER_OF_GOOGLE_TILES_CLAY_BLOCKOUT_CAMERA_MP4>"
    }
  ],
  "response_format": {
    "type": "video"
  }
}
```

### Execution Telemetry & Resource Accounting
- **Input Tokens**:
  - Prompt text: `328 tokens`
  - `<IMAGE_REF_0>` (PNG): `1,100 tokens`
  - `<VIDEO_REF_0>` (MP4 @ 72 frames): `16,560 tokens`
- **Output Tokens**:
  - Neural Video (`.mp4`, 72 frames @ 4K): `17,376 tokens`
- **Total Interaction Tokens**: `35,904 tokens`
- **Interaction ID**: `ChA1OWM4NDc5MjZmYjUxYWVhEAgaATAqBG1haW4`

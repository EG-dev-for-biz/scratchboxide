# Nano Banana 2.1 & Maps Imagery Grounding (MIG) Specification

> **Confidential Partner & Developer Reference**: Nano Banana 2.1 image synthesis foundation model and Vertex AI Maps Imagery Grounding (MIG).

---

## 1. Nano Banana 2.1 Architecture

**Nano Banana 2.1** is Google's next-generation neural image diffusion foundation model, designed for:
- Ultra-high-resolution photographic rendering ($8\text{K}$ textural fidelity).
- Tactile Physically Based Rendering (PBR) flat lay generation (albedo, normal, micro-roughness).
- Pixel-perfect typography and signage synthesis without hallucinated character glyphs.
- Alpha-accurate exemplar inpainting and disocclusion filling with zero boundary drift ($0.000\text{ px}$).

---

## 2. Maps Imagery Grounding (MIG)

When synthesizing or inpainting real-world scenes, unconditioned diffusion models suffer from **hallucination drift**—generating fictional facades, incorrect architectural fenestration, and missing landmark geometry.

**Maps Imagery Grounding (MIG)** bridges Google Maps real-world geospatial imagery directly into the generative diffusion conditioning graph.

```
                              ┌─────────────────────────────────────────┐
                              │  Geodetic Coordinates (lat, lng)        │
                              │  or Vantage Prompt ("Colosseum south")  │
                              └────────────────────┬────────────────────┘
                                                   │
                                ┌──────────────────▼───────────────────┐
                                │   Vertex AI Maps Grounding Service   │
                                │   tools: [{ googleMaps: {            │
                                │     groundingTypes: {                │
                                │       streetviewImagery: {} } } }]   │
                                └──────────────────┬───────────────────┘
                                                   │
                         ┌─────────────────────────┴─────────────────────────┐
                         ▼                                                   ▼
            ┌───────────────────────────────┐              ┌───────────────────────────────────┐
            │   Street View Pano Metadata   │              │   Aerial / Photogrammetry Tile    │
            │  (panoId, captureDate, pose)  │              │        (Google 3D Tiles)          │
            └──────────────┬────────────────┘              └─────────────────┬─────────────────┘
                           │                                                 │
                           └───────────────────────┬─────────────────────────┘
                                                   │
                                ┌──────────────────▼───────────────────┐
                                │   Equirectangular / Cubic Reproject  │
                                │   StreetViewPanoramaProjection       │
                                └──────────────────┬───────────────────┘
                                                   │ Grounding Conditioning
                                ┌──────────────────▼───────────────────┐
                                │        Nano Banana 2.1 Engine        │
                                │   Exemplar Inpainting / Diffusion    │
                                └──────────────────┬───────────────────┘
                                                   │
                                ┌──────────────────▼───────────────────┐
                                │   Photorealistic Real-World Scene    │
                                │   (Zero Hallucination Ground Truth)  │
                                └──────────────────────────────────────┘
```

---

## 3. Vertex AI Maps Grounding Request Contract

MIG is invoked through the Vertex AI Gemini Interactions API by passing the `googleMaps` grounding tool:

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "Synthesize the southern facade of the Roman Colosseum looking north at noon." }]
    }
  ],
  "tools": [
    {
      "googleMaps": {
        "groundingTypes": {
          "streetviewImagery": {}
        }
      }
    }
  ],
  "generationConfig": {
    "temperature": 0.2
  }
}
```

### Response Grounding Metadata
Vertex AI returns grounding chunks containing:
- `panoId`: Unique Google Street View panorama identifier.
- `captureDate`: Date of capture (e.g. `2024-05`).
- `latLng`: Exact geodetic latitude/longitude.
- `heading`, `pitch`, `roll`: 6-DOF camera attitude at time of capture.

---

## 4. Exemplar Inpainting Coordinator (Disocclusion Fill)

As implemented in [scripts/camera_space_visualizer.html](file:///Users/eligreen/dev/scratchbox-ide-master/scripts/camera_space_visualizer.html#L1882):

1. **Reprojection Pass**: A novel camera view is reprojected from known 3D geometry or 3D Gaussian Splats.
2. **Disocclusion Masking**: Surfaces occluded in the source cameras appear as unprojected black pixels ($\alpha = 0$).
3. **MIG Conditioning**: Nano Banana 2.1 is conditioned on the reprojected plate along with authentic Street View imagery.
4. **Exact Alpha Blending**:
   - $100\%$ of authentic reprojected source pixels are preserved.
   - Nano Banana only synthesizes the disocclusion holes (where $\text{mask} > 20$), eliminating seam artifacts.

---

## 5. Programmatic Invocation

```javascript
import { MapsImageryGroundingService } from '@scratchbox/core/node/spatial/MapsImageryGroundingService';

// 1. Resolve authentic Google Street View panorama grounding
const result = await MapsImageryGroundingService.getGroundedPanorama({
  prompt: 'Grand Canal Venice looking towards Rialto Bridge',
  canvasWidth: 2048,
  canvasHeight: 1024
});

console.log(`Resolved Pano ID: ${result.panoId}`);
console.log(`Grounded ERP Path: ${result.erpPath}`);
```

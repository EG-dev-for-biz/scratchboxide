---
name: geo-camera-matchmove-pipeline
description: >-
  Match 6-DoF camera motion and trajectory from any input reference video into any real-world
  geographic coordinates or iconic landmark location. Ingests reference video, solves Catmull-Rom
  spline camera paths, renders Google Photorealistic 3D Tiles blockout in 4K UHD (<VIDEO_REF_0>),
  synthesizes photorealistic video with Vertex AI Omni 1.1, and compiles synchronized 50/50 split comparisons.
---

# Geo-Camera Matchmove Pipeline & Geography Grounding

The **Geo-Camera Matchmove Pipeline** extracts dynamic camera movement from an arbitrary reference video (drone flythroughs, crane shots, cinematic descents) and reproduces the identical 6-DoF trajectory anchored to real-world geospatial coordinates anywhere on Earth using Google Photorealistic 3D Tiles and Vertex AI Omni 1.1.

## System Architecture

```
[Reference Video]
       │
       ▼
[1. Video Ingestion & Probe] ──► Extracts fps, frame count, duration, resolution
       │
       ▼
[2. Geodetic Anchor Resolution] ──► Lat/Lng/Alt, street heading, building facade normal
       │
       ▼
[3. 6-DoF Catmull-Rom Solver] ──► Continuous position, target, FOV, and nadir-safe up-vectors
       │
       ▼
[4. Google 3D Tiles Blockout] ──► 4K UHD rendering, leaf LODs (errorTarget: 0.5), collision audit
       │
       ▼
[5. Omni 1.1 Video Synthesis] ──► Gemini Omni neural restyling conditioned on <VIDEO_REF_0>
       │
       ▼
[6. Synchronized 4K Split QA] ──► 50/50 side-by-side comparison & milestone keyframes
```

---

## Quick Start (CLI)

### 1. Matchmove via `sbox` CLI
```bash
# Matchmove camera movement to The Plaza Hotel in New York City (dry-run to inspect trajectory)
sbox matchmove reference_video_32.mp4 --landmark "The Plaza Hotel" --dry-run

# Full end-to-end execution with 4K textured 3D Tiles blockout
sbox matchmove reference_video_32.mp4 --landmark "The Plaza Hotel" --render-mode textured --resolution 4k

# Target arbitrary coordinates with custom heading and elevation
sbox matchmove drone_shot.mp4 --lat 48.8584 --lng 2.2945 --alt 300 --heading 45 --name paris_eiffel
```

### 2. Standalone Node Runner Script
```bash
# Headless pipeline runner
node scripts/run_geo_camera_matchmove_pipeline.cjs \
  --video reference_video_32.mp4 \
  --landmark "The Plaza Hotel" \
  --render-mode textured \
  --resolution 4k
```

---

## Location Resolution & Geodetic Grounding

In compliance with the removal of external Geocoding/Solar API dependencies (commit `60b8f35`), location grounding resolves via:
1. **Explicit Geodetic Coordinates**: Always prefer explicit `latitude` and `longitude` with optional `altitude` and street heading degrees.
2. **Google Vector Tile Landmark Resolution**: Resolves urban corridors and parcels directly from Google 2D roadmap vector tiles (zoom 16) without external geocoding keys.

---

## First-Class Gemini Agent Tools

Agents should invoke the dedicated matchmove tools declared in `adaptive-matchmove-tools.ts`:

### 1. `adaptive_matchmove_resect_keyframe`
Extracts camera optical pose, heading, tilt, and field-of-view from an anchor frame of the input video.
```json
{
  "name": "adaptive_matchmove_resect_keyframe",
  "args": {
    "videoPath": "uploads/reference_cinematic.mp4",
    "timestampSec": 0.0,
    "geodeticCoords": { "lat": 40.7644, "lng": -73.9745, "alt": 180 }
  }
}
```

### 2. `adaptive_matchmove_synthesize_trajectory`
Fits a continuous, nadir-safe $C^2$ Catmull-Rom spline through resected camera keyframes, enforcing smooth heading/pitch interpolation and gimbal-lock protection.
```json
{
  "name": "adaptive_matchmove_synthesize_trajectory",
  "args": {
    "milestones": [ /* the calibrated keyframe states from adaptive_matchmove_resect_keyframe */ ],
    "fps": 30,
    "totalFrames": 150,
    "durationSec": 5.0
  }
}
```

### 3. `adaptive_matchmove_render_blockout`
Renders the solved 6-DoF camera trajectory through Google Photorealistic 3D Tiles in 4K UHD, producing `<VIDEO_REF_0>` for Omni 1.1 conditioning.
```json
{
  "name": "adaptive_matchmove_render_blockout",
  "args": {
    "splineTrackId": "spline_plaza_hotel_01",
    "resolution": "4k",
    "renderMode": "textured"
  }
}
```

### Point tracking
There is no point-tracking tool for the agent to call (the former `tapir_track_video_points` tracked frames it
synthesized itself and is removed). To track points in a real clip, decode its frames and call
`TapirTrackingService.executeTracking(frames, queryPoints)` in code: TAPIR runs through `scripts/run_tapir.py` and fails
with the reason when it cannot run; Lucas-Kanade optical flow runs only when asked for (`backend: 'lk_flow'`).

---

## Motion Presets

1. **`crane-descent-to-nadir`** (Default):
   - Recreates the iconic roofline-to-street descent.
   - Begins horizontally aligned with architectural cornice / roofline.
   - Transitions smoothly down the facade.
   - Rotates pitch down into pure nadir ($90^\circ$ downward vertical view) over the entrance awning / street.
   - **Gimbal Lock Protection**: Seamlessly interpolates camera `up` vector from world-up `[0, 1, 0]` to the facade-normal horizontal vector `[-cos(heading), 0, sin(heading)]`, preventing camera flip singularity when looking straight down.

2. **`orbital-inspection`**:
   - 360-degree helical or circular orbit around a central architectural spire or facade.
   - Maintains focal lock on building centroid while varying elevation.

3. **`canyon-flythrough`**:
   - Fast low-altitude avenue glide along street corridors.
   - Heading tracks street centerline orientation with perspective depth preservation.

---

## Programmatic TypeScript Usage

```typescript
import {
  GeoCameraMatchmovePipelineService,
  GeoMatchmoveRequest,
  GeoMatchmoveResult
} from '@scratchbox/core/node';

const pipeline = new GeoCameraMatchmovePipelineService();

// 1. Configure matchmove request with explicit geodetic anchor
const request: GeoMatchmoveRequest = {
  inputVideoPath: '/path/to/reference_video.mp4',
  geoAnchor: {
    lat: 40.7644,
    lng: -73.9745,
    altitudeMeters: 180,
    headingDeg: -29,
    landmarkName: 'The Plaza Hotel, New York'
  },
  motionType: 'crane-descent-to-nadir',
  headingDeg: -29,
  renderMode: 'textured',
  resolution: { width: 3840, height: 2160 },
  outputDir: 'public',
  outputVideoName: 'plaza_hotel_matchmove'
};

// 2. Execute pipeline
const result: GeoMatchmoveResult = await pipeline.execute(request);

console.log('Blockout Video:', result.blockoutVideoPath);
console.log('Omni Video:', result.omniVideoPath);
console.log('Comparison Video:', result.comparisonVideoPath);
```

---

## Verification & Quality Checklist

Before finalizing any matchmove execution:

1. **Camera Path Continuity**:
   - Run with `--dry-run` to inspect generated `*_camera_path.json`.
   - Confirm frame count exactly matches reference video (`totalFrames === durationSec * fps`).
   - Check that camera `up` vectors avoid zero-length vectors when target is directly below camera position.

2. **Asset Integrity Gate**:
   - Run `node scripts/validate_gallery_pipeline_assets.cjs` to confirm existing districts remain valid.
   - Confirm generated videos have non-zero file sizes on disk.

3. **Multi-State Gallery Verification**:
   - Verify output in `public/s4d_multi_gallery.html`.
   - Test all three video switcher states:
     - `Step 3: Omni Video Output`
     - `Step 1: <VIDEO_REF_0> Blockout`
     - `⚡ Side-by-Side (Step 1 vs 3)`

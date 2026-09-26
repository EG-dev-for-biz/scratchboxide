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

## Location Resolution

There is no built-in landmark table. `--landmark "<place>"` is geocoded with the Google Geocoding API
(ground elevation from the Elevation API) via `GeoCameraMatchmovePipelineService.geocodeLandmarkAnchor`,
which needs `GOOGLE_MAPS_API_KEY`; otherwise pass `--lat/--lng`. A lookup with no result is an error.
Motion presets use `--heading` (compass degrees of the street grid, e.g. -29 for Manhattan) when given.

Note: motion presets generate a camera path; they do not track the reference video, and their
`precisionMetrics.measured` is `false`.

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
   - Fast low-altitude avenue glide along Manhattan-style street corridors.
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

// 1. Geocode the location (Google Geocoding + Elevation APIs)
const anchor = await pipeline.geocodeLandmarkAnchor('The Plaza Hotel, New York', { headingDeg: -29 });

// 2. Configure matchmove request
const request: GeoMatchmoveRequest = {
  inputVideoPath: '/path/to/reference_video.mp4',
  geoAnchor: anchor,
  motionType: 'crane-descent-to-nadir',
  headingDeg: anchor.headingDeg,
  renderMode: 'textured',
  resolution: { width: 3840, height: 2160 },
  outputDir: 'public',
  outputVideoName: 'plaza_hotel_matchmove'
};

// 3. Execute pipeline
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

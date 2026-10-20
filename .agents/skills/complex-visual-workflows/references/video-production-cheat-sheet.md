# Video Production & Cinematic Motion Reference Cheat Sheet

This reference document provides the production runbooks, CLI flags, media tag syntax, and FFmpeg command recipes for Scratchbox Video Timeline and Matchmove pipelines.

---

## 1. Geo-Camera Matchmove Pipeline

Extracts 6-DoF camera motion from reference video and reproduces the identical trajectory anchored into real-world geographic coordinates using Google Photorealistic 3D Tiles and Vertex AI Omni 1.1.

### Quick Start Commands
```bash
# Matchmove to iconic landmark with dry-run trajectory inspection
sbox matchmove reference.mp4 --landmark "The Plaza Hotel" --dry-run

# Full end-to-end matchmove with 4K textured 3D Tiles blockout
sbox matchmove reference.mp4 --landmark "The Plaza Hotel" --render-mode textured --resolution 4k

# Target arbitrary coordinates with custom elevation, heading, and lens distortion
node scripts/run_geo_camera_matchmove_pipeline.cjs \
  --video reference.mp4 \
  --lat 40.7645 --lng -73.9744 --alt 180 \
  --heading 45 --render-mode textured --resolution 4k \
  --precision --lens-k1 -0.015 --lens-k2 0.002
```

### Matchmove Pipeline Steps
1. **Video Ingestion & Probe**: Extracts framerate, frame count, resolution, and pixel aspect ratio.
2. **Geodetic Anchor Resolution**: Resolves latitude, longitude, elevation MSL, and street heading.
3. **6-DoF Keyframe Resection (`adaptive_matchmove_resect_keyframe`)**: Solves camera optical center, Euler angles (heading, pitch, roll), and FOV.
4. **Continuous Spline Solving (`adaptive_matchmove_synthesize_trajectory`)**: Fits a $C^2$ continuous Catmull-Rom or Hermite-Slerp spline with gimbal-lock avoidance.
5. **Headless 3D Tiles Blockout Rendering**: Renders the exact 4K trajectory against Google 3D Tiles to produce `<VIDEO_REF_0>`.

---

## 2. Google Omni 1.1 Video Synthesis Prompt Syntax

When conditioning video generation on 3D blockout trajectories:

### Official Media Tag Syntax
- `<VIDEO_REF_0>`: The 3D camera blockout reference video.
- `<FIRST_FRAME>`: Anchor keyframe defining the initial visual appearance.
- `<LAST_FRAME>`: Anchor keyframe defining the final visual destination.
- `<IMAGE_REF_0>`, `<IMAGE_REF_1>`: Style or character reference images.

### Prompt Template for Matchmove Conditioning
```text
Match the dynamic camera motion, trajectory, and framing from <VIDEO_REF_0> precisely.
Maintain complete spatial and temporal consistency with the landmark architecture and lighting.
[Shot 00:00 - 00:03]: Smooth cinematic crane descent sweeping along the western facade. Golden hour sunlight catching limestone moldings at 45-degree angle.
[Shot 00:03 - 00:06]: Low-angle tracking shot along the entrance portico. Crisp optical reflections in ground-floor glass.
Zero jump cuts, zero camera stutter, zero warping. Hyper-photorealistic cinematic 4K video, natural lens flare, shallow depth of field.
```

---

## 3. Multi-Angle Quad-Split Video Production

Produces 2x2 synchronized multi-camera views (e.g. Front, Rear, Left 3/4, Overhead) in a single pass at 4K UHD ($3840 \times 2160$), where each quadrant retains full 1080p resolution.

### Splitting 4K Quad-Split into 4 Standalone 1080p Videos (Single FFmpeg Pass)
```bash
ffmpeg -i quad_split_4k.mp4 \
  -filter_complex "\
    [0:v]crop=1920:1080:0:0[tl]; \
    [0:v]crop=1920:1080:1920:0[tr]; \
    [0:v]crop=1920:1080:0:1080[bl]; \
    [0:v]crop=1920:1080:1920:1080[br]" \
  -map "[tl]" -c:v libx264 -crf 18 -preset fast camera_front_1080p.mp4 \
  -map "[tr]" -c:v libx264 -crf 18 -preset fast camera_rear_1080p.mp4 \
  -map "[bl]" -c:v libx264 -crf 18 -preset fast camera_side_1080p.mp4 \
  -map "[br]" -c:v libx264 -crf 18 -preset fast camera_overhead_1080p.mp4
```

---

## 4. Production FFmpeg Command Recipes

### Synchronized 50/50 Side-by-Side Comparison Split
```bash
ffmpeg -i reference_video.mp4 -i synthesized_video.mp4 \
  -filter_complex "\
    [0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,drawtext=text='REFERENCE ORIGINAL':x=40:y=40:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8[ref]; \
    [1:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,drawtext=text='SCRATCHBOX SYNTHESIS':x=40:y=40:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8[syn]; \
    [ref][syn]hstack=inputs=2[outv]" \
  -map "[outv]" -c:v libx264 -pix_fmt yuv420p -crf 18 -preset fast comparison_5050_split.mp4
```

### Kelvin Color Grade & Contrast Curve
```bash
# 3200K Golden Hour Warmth + S-Curve Contrast
ffmpeg -i input.mp4 \
  -vf "colortemperature=temperature=3400,curves=strong_contrast" \
  -c:v libx264 -crf 18 -c:a copy output_golden_hour.mp4
```

### Audio Ducking for Voiceover over Music
```bash
ffmpeg -i voiceover.wav -i background_music.mp3 \
  -filter_complex "[1:a][0:a]sidechaincompress=threshold=0.125:ratio=4:attack=200:release=1000[music_ducked];[0:a][music_ducked]amix=inputs=2[aout]" \
  -map "[aout]" -c:a aac -b:a 256k mixed_master.aac
```

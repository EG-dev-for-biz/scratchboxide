---
name: ffmpeg
description: Authoritative reference for every FFmpeg / ffprobe operation in Scratchbox IDE. Use whenever building, running, or modifying server-side video features, agent video editing, keyframe extraction, clip trimming, safe N-way concat, 50/50 comparison splits, letterbox removal, GIF conversion, audio re-muxing, Kelvin color filter baking, 3D LUT grading, chroma keying, video conditioning maps, audio ducking, loudness normalization, and headless compositing.
---

# FFmpeg & Video Engineering in Scratchbox IDE

This skill catalogs every FFmpeg and ffprobe operation available in Scratchbox IDE, the canonical command shapes, hard safety rules, and the first-class Gemini Agent Tools to call instead of writing fragile shell commands.

## Hard Rules

- **Always** use `execFile` with an argument array, never `exec` with a raw shell string. Untrusted user content (paths, prompts, filters) must never be shell-interpolated.
- **Always** use system `ffmpeg` / `ffprobe` binaries auto-discovered via `resolveBinary` (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, or `PATH`). Do not bundle static binaries or import heavy wrapper libraries.
- **Always** enforce `-pix_fmt yuv420p` and `-movflags +faststart` on H.264 MP4 exports to prevent the QuickTime/Chrome black-screen playback bug and allow zero-latency progressive download/scrubbing.
- **Always** pass `-y` to overwrite destination files and prevent FFmpeg from hanging on interactive terminal prompts.
- **Always** specify an explicit `timeout` on subprocesses and raise `maxBuffer` ($\ge 32\text{ MB}$) when parsing filters that log per-frame (`select` scene detection, `cropdetect`).
- **Always** clean up temporary working files under `/tmp/scratchbox-ffmpeg-...-${randomUUID()}` in a `try/finally` block.
- **Never** pass odd dimensions to video encoders — always clamp dimensions to even integers (`w - (w % 2)`).
- **Never** `-c copy` across clips with mixed codecs, mismatched fps, or missing audio without an automated normalization pre-pass (`anullsrc` padding, SAR 1, `format=yuv420p`, `44100Hz aac`).
- **Always** use optional audio mapping (`-map 1:a:0? -shortest`) when re-muxing plate audio onto generated video so FFmpeg does not fail on silent inputs.

---

## Gemini Agent Tool Catalog

Instead of executing raw CLI commands in `run_command`, the agent should invoke these dedicated tools:

### 1. `vfx_ffmpeg_quick_edit`
Execute fast single-clip edits in a single pass:
- **Trim**: Clamps `startSec`, `durationSec`, or `endSec` with keyframe-accurate seek.
- **Scale**: Fits or covers target width/height with even dimension clamping.
- **Crop**: Centers or clamps to standard aspect ratios (`16:9`, `9:16`, `1:1`, `4:3`) or bounding boxes.
- **Retime / Speed**: Modifies playback speed multiplier (e.g. 0.5x slow-mo, 2x speedup).
- **Filter Bake**: Adjusts Planckian Kelvin color temperature, brightness, contrast, saturation, and temporal film grain.
- **Audio Operations**: Mute audio (`muteAudio: true`) or re-mux original plate audio (`remuxAudioPath`).
- **Transcode**: Outputs `mp4` (H.264), `webm` (VP9), `gif` (2-pass palette), or `mov`.

### 2. `vfx_ffmpeg_extract_frames`
Extract high-resolution still images from video files for the Visual Critic and AI Beautify pipelines:
- Seeking uses fast keyframe seek (`-ss` before `-i`).
- Accepts specific timestamps in seconds (e.g. `[0, 1.5, 3.0]`), frame counts, or extracts Frame 0 (`heroFrameOnly: true`).

### 3. `vfx_ffmpeg_split_screen`
Compile synchronized 50/50 comparison split videos (mandated by Scratchbox IDE verification guidelines):
- Layouts: `horizontal` (side-by-side) or `vertical` (stacked).
- Automatically normalizes both video streams to matching heights and frame rates.
- Maps audio safely from the primary video stream.

### 4. `vfx_ffmpeg_storyboard_sheet`
Compile a video into a single high-resolution contact sheet mosaic grid (`tile` filter) for token-efficient multimodal Gemini Vision inspection:
- Layouts: `columns` × `rows` (e.g. 3×3, 4×4, 5×5).
- Optional timestamp/timecode overlay (`labelTimecode: true`) burnt into each frame cell.
- Delivers complete temporal and spatial comprehension of the video in a single prompt image.

### 5. `vfx_ffmpeg_lut_grade`
Apply industry-standard 3D `.cube` or `.3dl` color grading LUTs (ACEScc, Kodak 2383, ARRI LogC) via `lut3d`:
- Configurable intensity blending (0.0 to 1.0) and tetrahedral interpolation.
- Preserves audio stream and embeds `+faststart` metadata.

### 6. `vfx_ffmpeg_chromakey`
Execute headless green or blue screen chroma keying with color despill suppression:
- Color selection (`green`, `blue`, or hex RGB like `0x00FF00`).
- Configurable similarity threshold and softness blend radius.
- Composite directly onto a background video/image or export transparent RGBA video.

### 7. `vfx_ffmpeg_controlnet_map`
Extract zero-inference video conditioning maps in a single FFmpeg pass:
- **`edge`**: Sobel filter chain with luminance thresholding and optional inversion for line-art/depth conditioning.
- **`height`**: Luminance-to-displacement map with tunable contrast scaling.
- Runs 10× to 50× faster than running heavy neural models or decoding frames to canvas.

### 8. `vfx_ffmpeg_audio_normalize`
Broadcast and streaming audio loudness normalization conforming to EBU R128 (`loudnorm`):
- Targets: `-14 LUFS` for web/streaming (YouTube/Vimeo/Spotify) or `-23 LUFS` for EBU broadcast standards.
- Copies video stream losslessly (`-c:v copy`).

### 9. `vfx_ffmpeg_seamless_loop`
Synthesize seamless infinite video loops for 3D environment plates, backgrounds, and generative media:
- Modes: `ping_pong` (forward-reverse reflection) or `crossfade` (`xfade` blending tail into head).

### 10. `vfx_ffmpeg_encode_sequence`
Ingest numbered image sequences (`frame_%04d.png/jpg`) rendered from 3D viewports, Gaussian splats, or NeRFs into broadcast video:
- Deterministic frame rate (`fps`), codec selection (`h264`, `prores`, `vp9`), and optional audio track muxing with `-shortest`.

### 11. `vfx_composite_patch`
Composite localized generative video patches or 3D overlays onto a master video plate:
- Downscales patch to target bounding box using **Lanczos-8** resampling.
- Generates an analytical soft-feathered alpha edge mask via `geq`.
- Injects matching temporal film grain (`noise=alls=...:allf=t+u`) to eliminate AI plastic smoothness.

### 12. `vfx_composite_timeline`
Renders a complete multi-track `VideoTimelineData` structure:
- Multi-track layering (V1 background to top overlays).
- Chroma keying with Euclidean YCbCr tolerance and green/blue despill suppression.
- Layer affine transforms, picture-in-picture, and audio mixing.

### 13. `vfx_mediapipe_track_video_motion`
Coordinated motion analysis extracting articulated 3D kinematic telemetry:
- Uses FFmpeg to extract sequential video frame samples at target sampling rates (default: 15 fps).
- Runs MediaPipe 3D pose detection per frame, solving 3D joint Euler angles conforming to the Scratchbox Parametric Humanoid Standard (`SB-Human`).
- Applies moving-average temporal smoothing across joint Euler angles and hip translation vectors to eliminate tracking jitter.
- Streams motion data directly into the native C++20 Astro 3D engine for character driving, physics ragdolls, or WebGL playback.

### 14. `vfx_video_auto_reframe`
Intelligent subject-aware camera reframing:
- Analyzes video frames with MediaPipe to detect and track human subjects (face or body center).
- Calculates target aspect ratio crop boxes (`9:16`, `1:1`, `4:5`, or custom) with rule-of-thirds composition bias.
- Generates smooth Catmull-Rom spline camera trajectory pan waypoints.
- Compiles into an FFmpeg single-pass hardware-accelerated `crop=w:h:x:y` render with `-movflags +faststart`.

### 15. `vfx_visual_critic_audit`
Autonomous visual quality gate auditing against the 8-Dimension Visual Fidelity Rubric:
- Uses FFmpeg to compile an automated 3×3 timestamped contact sheet.
- Inspects MediaPipe anatomical consistency across frames (limb length stability ratio, joint flip detection).
- Evaluates the 8 dimensions (Geometric Definition, Pixel/Splat Density, Material/Micro-surface, Environmental Grounding, Radiometric Lighting, Color Temperature, Volumetric Depth, Photographic Realism) with a strict $\ge 8.5/10$ passing gate.
- Generates automated FFmpeg remediation recipes (e.g. Planckian Kelvin balance `colortemperature`, unsharp mask `unsharp=...`) when any dimension fails.

---

## Canonical FFmpeg Command Catalog

For reference and service implementation:

### 1. Probe Metadata
```bash
# Duration in seconds
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 INPUT.mp4
# Dimensions (WxH)
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x INPUT.mp4
# Audio stream presence (empty output = silent)
ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 INPUT.mp4
# Frame rate
ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate -of default=noprint_wrappers=1:nokey=1 INPUT.mp4
```

### 2. Keyframe Extraction
```bash
# Fast seek (-ss before -i), single frame output
ffmpeg -y -ss 00:00:01.500 -i INPUT.mp4 -frames:v 1 -q:v 2 OUT.png
```

### 3. Storyboard Contact Sheet Tiling (For Gemini Multimodal Vision)
```bash
# Extract 9 evenly sampled frames with timecode burned in, packed into a 3x3 grid
ffmpeg -y -i INPUT.mp4 \
  -vf "fps=1/1.5,scale=640:360:flags=lanczos,drawtext=text='%{pts\\:hms}':x=10:y=h-24:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6,tile=3x3:padding=6:margin=6:color=black" \
  -frames:v 1 -q:v 2 STORYBOARD.png
```

### 4. 3D LUT Color Grading (.cube)
```bash
# 100% intensity tetrahedral LUT grading
ffmpeg -y -i INPUT.mp4 \
  -vf "lut3d=file='kodak_2383.cube':interp=tetrahedral" \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -c:a copy -movflags +faststart GRADED.mp4

# Blended 75% intensity LUT grading
ffmpeg -y -i INPUT.mp4 \
  -filter_complex "[0:v]split[orig][lut];[lut]lut3d=file='look.cube':interp=tetrahedral[graded];[orig][graded]blend=all_mode=normal:all_opacity=0.75[v]" \
  -map "[v]" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -c:a copy -movflags +faststart GRADED_75.mp4
```

### 5. Green Screen Chroma Keying & Despill
```bash
# Key green screen foreground over background plate
ffmpeg -y -i FG_GREENSCREEN.mp4 -i BG_PLATE.mp4 \
  -filter_complex "[0:v]chromakey=0x00FF00:0.12:0.08,despill=green[keyed];[1:v]scale=1920:1080[bg];[bg][keyed]overlay=0:0:shortest=1[v]" \
  -map "[v]" -map 0:a:0? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart COMPOSITE.mp4
```

### 6. Real-Time Video Conditioning Maps (Sobel Edge / Height)
```bash
# Single-pass Sobel edge map for ControlNet/diffusion conditioning
ffmpeg -y -i INPUT.mp4 \
  -vf "format=gray,sobel=scale=2,lut=y=val-20,negate,format=yuv420p" \
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -an -movflags +faststart EDGE_MAP.mp4

# Height/luminance displacement map
ffmpeg -y -i INPUT.mp4 \
  -vf "format=gray,lut=y=(val-128)*1.5+128,format=yuv420p" \
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -an -movflags +faststart HEIGHT_MAP.mp4
```

### 7. Broadcast EBU R128 Audio Normalization
```bash
# Conforming audio loudness to -14 LUFS (web) with video copy
ffmpeg -y -i INPUT.mp4 \
  -af "loudnorm=I=-14:LRA=7:TP=-1.0" \
  -c:v copy -c:a aac -b:a 192k -movflags +faststart NORMALIZED.mp4
```

### 8. Intelligent Dynamic Audio Ducking
```bash
# Ducks background music whenever voiceover is speaking
ffmpeg -y -i MUSIC.mp3 -i VOICEOVER.wav \
  -filter_complex "[0:a]volume=0.8[music];[1:a]volume=1.0[voice];[music][voice]sidechaincompress=threshold=0.08:ratio=4:attack=50:release=500[ducked];[ducked][voice]amix=inputs=2:dropout_transition=0[aout]" \
  -map "[aout]" -c:a aac -b:a 192k DUCKED_MIX.mp4
```

### 9. Seamless Infinite Video Looping
```bash
# Ping-pong reflection (forward + reverse)
ffmpeg -y -i INPUT.mp4 \
  -filter_complex "[0:v]reverse[rev];[0:v][rev]concat=n=2:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -preset fast -crf 19 -pix_fmt yuv420p -movflags +faststart LOOP.mp4

# Temporal crossfade transition between tail and head (1.0s crossfade on 5.0s clip)
ffmpeg -y -i INPUT.mp4 \
  -filter_complex "[0:v]split[v1][v2];[v1]trim=start=0:end=4,setpts=PTS-STARTPTS[head];[v2]trim=start=4:end=5,setpts=PTS-STARTPTS[tail];[tail][head]xfade=transition=fade:duration=1.0:offset=0[v]" \
  -map "[v]" -c:v libx264 -preset fast -crf 19 -pix_fmt yuv420p -movflags +faststart SEAMLESS.mp4
```

### 10. Frame Sequence Ingestion
```bash
# Numbered PNG/JPG render sequence to broadcast MP4 with faststart
ffmpeg -y -framerate 24 -i "/workspace/renders/frame_%04d.png" -i OPTIONAL_AUDIO.wav \
  -map 0:v -map 1:a? -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k \
  -shortest -movflags +faststart RENDER_OUTPUT.mp4
```

### 11. 50/50 Side-by-Side Comparison Split
```bash
ffmpeg -y -i LEFT.mp4 -i RIGHT.mp4 \
  -filter_complex "[0:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[left];[1:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[right];[left][right]hstack[v]" \
  -map "[v]" -map 0:a:0? -c:v libx264 -preset fast -crf 19 -pix_fmt yuv420p -movflags +faststart COMPARISON.mp4
```

### 12. Two-Pass Camera Stabilization
```bash
# Pass 1: Motion vector transform calculation
ffmpeg -y -i INPUT.mp4 -vf "vidstabdetect=stepsize=6:shakiness=8:accuracy=10:result=transforms.trf" -f null -
# Pass 2: Smoothing and optical zoom compensation
ffmpeg -y -i INPUT.mp4 -vf "vidstabtransform=input=transforms.trf:smoothing=30:zoom=2:optzoom=1" -c:v libx264 -preset fast -crf 18 -c:a copy STABILIZED.mp4
```

### 13. High-Speed Frame Stills Extraction for MediaPipe Pose Kinematics
```bash
# Extract sequential stills at 15 fps directly to PNG/JPG for MediaPipe 3D joint tracking
ffmpeg -y -ss 00:00:00.000 -i INPUT.mp4 -t 5.0 -r 15 -q:v 2 "/tmp/frames/frame_%04d.png"
```

### 14. Intelligent Subject-Centered Video Auto-Reframing (16:9 to 9:16)
```bash
# Single-pass 9:16 crop centered on MediaPipe solved subject coordinates with faststart
ffmpeg -y -i WIDE_16X9.mp4 \
  -vf "crop=608:1080:656:0" \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart -c:a copy REFRAMED_9X16.mp4
```

### 15. Automated Planckian Kelvin Color Cast Correction & Visual Remediation
```bash
# Correct cool or warm color cast and sharpen edge micro-contrast per Visual Critic audit
ffmpeg -y -i INPUT.mp4 \
  -vf "colortemperature=temperature=5600,unsharp=5:5:0.8:3:3:0.4" \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart -c:a copy REMEDIATED.mp4
```


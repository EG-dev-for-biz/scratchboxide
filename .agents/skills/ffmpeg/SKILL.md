---
name: ffmpeg
description: Authoritative reference for every FFmpeg / ffprobe operation in Scratchbox IDE. Use whenever building, running, or modifying server-side video features, agent video editing, keyframe extraction, clip trimming, safe N-way concat, 50/50 comparison splits, letterbox removal, GIF conversion, audio re-muxing, Kelvin color filter baking, and headless compositing.
---

# FFmpeg & Video Engineering in Scratchbox IDE

This skill catalogs every FFmpeg and ffprobe operation available in Scratchbox IDE, the canonical command shapes, hard safety rules, and the first-class Gemini Agent Tools to call instead of writing fragile shell commands.

## Hard Rules

- **Always** use `execFile` with an argument array, never `exec` with a raw shell string. Untrusted user content (paths, prompts, filters) must never be shell-interpolated.
- **Always** use system `ffmpeg` / `ffprobe` binaries auto-discovered via `resolveBinary` (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, or `PATH`). Do not bundle static binaries or import heavy wrapper libraries.
- **Always** enforce `-pix_fmt yuv420p` and `-movflags +faststart` on H.264 MP4 exports to prevent the QuickTime/Chrome black-screen playback bug.
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

### 4. `vfx_composite_patch`
Composite localized generative video patches or 3D overlays onto a master video plate:
- Downscales patch to target bounding box using **Lanczos-8** resampling.
- Generates an analytical soft-feathered alpha edge mask via `geq` (`format=rgba,geq=...:a='min(1,min(...))*255'`).
- Injects matching temporal film grain (`noise=alls=...:allf=t+u`) to eliminate AI plastic smoothness.

### 5. `vfx_composite_timeline`
Renders a complete multi-track `VideoTimelineData` structure:
- Multi-track layering (V1 background to top overlays).
- Chroma keying with Euclidean YCbCr tolerance and green/blue despill suppression.
- Layer affine transforms, picture-in-picture, and audio mixing.

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

### 3. Clip Trimming
```bash
# Keyframe-accurate fast cut (no re-encode)
ffmpeg -y -ss 00:00:02.000 -i INPUT.mp4 -t 00:00:05.000 -c copy -avoid_negative_ts make_zero OUT.mp4

# Re-encoded cut with exact sub-frame accuracy
ffmpeg -y -ss 00:00:02.000 -i INPUT.mp4 -t 00:00:05.000 -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -c:a aac -movflags +faststart OUT.mp4
```

### 4. Safe N-Way Concat with Audio Normalization
```bash
# 1. Normalize each clip: SAR 1, 30fps, 44.1kHz audio (or anullsrc if silent), yuv420p
ffmpeg -y -i INPUT.mp4 -f lavfi -i anullsrc=r=44100:cl=stereo -shortest \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p" \
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p \
  -c:a aac -ar 44100 -ac 2 -b:a 128k -movflags +faststart NORM_0.mp4

# 2. Concat demuxer (lossless -c copy)
ffmpeg -y -f concat -safe 0 -i concat.txt -c copy -movflags +faststart STITCHED.mp4
```

### 5. 50/50 Side-by-Side Comparison Split
```bash
ffmpeg -y -i LEFT.mp4 -i RIGHT.mp4 \
  -filter_complex "[0:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[left];[1:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[right];[left][right]hstack[v]" \
  -map "[v]" -map 0:a:0? -c:v libx264 -preset fast -crf 19 -pix_fmt yuv420p -movflags +faststart COMPARISON.mp4
```

### 6. Video Filter Bake & Color Temperature
```bash
# Kelvin color temperature + exposure/contrast + film grain
ffmpeg -y -i INPUT.mp4 \
  -vf "colortemperature=temperature=3200:mix=0.85,eq=brightness=0.02:contrast=1.12:saturation=1.08,noise=alls=12:allf=t+u" \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -c:a copy OUT.mp4
```

### 7. Audio Re-Muxing (Original Audio onto AI Video)
```bash
ffmpeg -y -i AI_VIDEO.mp4 -i ORIGINAL_PLATE.mp4 \
  -map 0:v:0 -map 1:a:0? -c:v copy -c:a aac -ar 44100 -ac 2 -b:a 128k \
  -shortest -movflags +faststart OUT.mp4
```

### 8. High-Quality 2-Pass Palette GIF
```bash
ffmpeg -y -ss 0 -i INPUT.mp4 -t 4 \
  -vf "fps=15,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  OUT.gif
```

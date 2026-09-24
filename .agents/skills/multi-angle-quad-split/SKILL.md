---
name: multi-angle-quad-split
description: >-
  Direct, generate, assemble, and deconstruct 2x2 multi-angle quad-split video productions using Google Omni 1.1
  prompt engineering and FFmpeg. Covers rendering in 4K UHD so each quadrant retains full 1080p resolution,
  cropping and splitting a 4K quad-split video into 4 standalone synchronized 1080p video files (top-left,
  top-right, bottom-left, bottom-right) in a single pass or individual passes, audio routing, and post-production xstack assembly.
---

# 2x2 Multi-Angle Quad-Split Video Production Skill

This skill provides complete, end-to-end instructions for creating, managing, and **deconstructing** **2x2 multi-camera / multi-angle split-screen videos**.

A 2x2 quad-split displays four distinct, synchronized perspectives of the same subject, action, or environment simultaneously:
- **Top-Left (Panel 1)**: Master Frontal Wide / Establishing shot (eye-level)
- **Top-Right (Panel 2)**: 45° Side Profile / Medium Close-Up (facial expression & hands)
- **Bottom-Left (Panel 3)**: Low-Angle Heroic / Dutch Tilt (looking upward from floor/table level)
- **Bottom-Right (Panel 4)**: High-Angle / 90° Overhead Top-Down Bird's-Eye View

---

## 1. The Critical 4K Resolution Requirement

When generating a 2x2 split-screen in Google Omni 1.1 or assembling it in FFmpeg:
- If rendered at **720p ($1280 \times 720$)**: each quadrant is only **$640 \times 360$** (low SD draft quality).
- If rendered at **1080p ($1920 \times 1080$)**: each quadrant is only **$960 \times 540$** (sub-HD).
- **Mandatory Standard: 4K UHD ($3840 \times 2160$)**:
  - Each individual quadrant is exactly **$1920 \times 1080$ (Full HD 1080p)**.
  - When sliced into 4 separate video files, every angle stands on its own as a broadcast-grade 1080p video without quality degradation or pixelation.

```
Total 4K UHD Canvas: 3840 x 2160
+---------------------------------------+---------------------------------------+
|  QUADRANT 0: TOP-LEFT                 |  QUADRANT 1: TOP-RIGHT                |
|  Crop: 1920x1080 offset (0, 0)        |  Crop: 1920x1080 offset (1920, 0)     |
|  Vantage: Frontal Master Wide         |  Vantage: 45° Side Profile Close-Up   |
+---------------------------------------+---------------------------------------+
|  QUADRANT 2: BOTTOM-LEFT              |  QUADRANT 3: BOTTOM-RIGHT             |
|  Crop: 1920x1080 offset (0, 1080)     |  Crop: 1920x1080 offset (1920, 1080)  |
|  Vantage: Low-Angle Heroic            |  Vantage: 90° Overhead Top-Down       |
+---------------------------------------+---------------------------------------+
```

---

## 2. Google Omni 1.1 4K Quad-Split Prompting

When prompting Google Omni 1.1 (`gemini-omni-1.1-flash`), request **4K resolution** and prompt explicitly for synchronized perspectives without internal cuts.

### The Canonical 4K 2x2 Quad-Split Prompt Template

```text
Generate a 2x2 split-screen video capturing the exact same subject and action simultaneously from four synchronized perspectives. The subject appearance, physical motion, environment, and lighting must remain 100% identical and temporally synchronized across all four panels.

Panel Layout & Camera Angles:
- Top-Left (Panel 1): Master wide frontal shot at eye level, establishing the subject in the full environment.
- Top-Right (Panel 2): Medium close-up 45-degree side profile, focusing on facial expressions and hand actions.
- Bottom-Left (Panel 3): Low-angle heroic shot looking up from ground/table level with shallow depth of field.
- Bottom-Right (Panel 4): Top-down 90-degree overhead bird's-eye view looking directly down onto the subject and workspace.

Execution Constraints:
- Output resolution: 4K UHD (3840x2160), 16:9 aspect ratio.
- Single continuous shot across all four quadrants — zero internal jump cuts or camera switching.
- Precise multi-camera synchronization: every movement, gesture, and light reflection happens at the exact same millisecond in all 4 quadrants.
- Seamless grid borders without thick frames, text overlays, or watermarks dividing the quadrants.
- Photorealistic, natural physical lighting, authentic spatial audio corresponding to the physical action. No background music.
```

---

## 3. Deconstructing a 4K Quad-Split into 4 Standalone 1080p Videos

Once the 4K quad-split video is generated, use FFmpeg's `crop` filter: `crop=out_w:out_h:x:y`.

For a $3840 \times 2160$ input:
- `out_w = 1920`, `out_h = 1080`
- **Top-Left (Angle 1)**: `x = 0, y = 0` $\to$ `crop=1920:1080:0:0`
- **Top-Right (Angle 2)**: `x = 1920, y = 0` $\to$ `crop=1920:1080:1920:0`
- **Bottom-Left (Angle 3)**: `x = 0, y = 1080` $\to$ `crop=1920:1080:0:1080`
- **Bottom-Right (Angle 4)**: `x = 1920, y = 1080` $\to$ `crop=1920:1080:1920:1080`

### Method A: Single-Pass Deconstruction (Fastest & Most Efficient)
Demuxes the 4K video once and writes all 4 individual 1080p angle files simultaneously using `split=4`:

```bash
ffmpeg -y -i "quad_split_4k.mp4" -filter_complex "\
  [0:v]split=4[v0][v1][v2][v3]; \
  [v0]crop=1920:1080:0:0[angle_tl]; \
  [v1]crop=1920:1080:1920:0[angle_tr]; \
  [v2]crop=1920:1080:0:1080[angle_bl]; \
  [v3]crop=1920:1080:1920:1080[angle_br]" \
  -map "[angle_tl]" -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_01_front_wide.mp4" \
  -map "[angle_tr]" -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_02_profile_closeup.mp4" \
  -map "[angle_bl]" -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_03_low_heroic.mp4" \
  -map "[angle_br]" -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_04_overhead_topdown.mp4"
```

### Method B: Individual Quadrant Extraction Commands
Extract single angles on demand:

```bash
# 1. Top-Left (Front Wide)
ffmpeg -y -i "quad_split_4k.mp4" -vf "crop=1920:1080:0:0" \
  -map 0:v -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_01_front_wide.mp4"

# 2. Top-Right (Profile Close-Up)
ffmpeg -y -i "quad_split_4k.mp4" -vf "crop=1920:1080:1920:0" \
  -map 0:v -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_02_profile_closeup.mp4"

# 3. Bottom-Left (Low-Angle Heroic)
ffmpeg -y -i "quad_split_4k.mp4" -vf "crop=1920:1080:0:1080" \
  -map 0:v -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_03_low_heroic.mp4"

# 4. Bottom-Right (Overhead Top-Down)
ffmpeg -y -i "quad_split_4k.mp4" -vf "crop=1920:1080:1920:1080" \
  -map 0:v -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_04_overhead_topdown.mp4"
```

---

## 4. Handling Dynamic Resolutions & Non-Standard Splits

If the input quad video is not standard 4K (e.g. 1080p, 1440p, or arbitrary dimensions $W \times H$), use FFmpeg's analytical expressions:
- `in_w/2` and `in_h/2`:
```bash
# Top-Left:
crop=in_w/2:in_h/2:0:0
# Top-Right:
crop=in_w/2:in_h/2:in_w/2:0
# Bottom-Left:
crop=in_w/2:in_h/2:0:in_h/2
# Bottom-Right:
crop=in_w/2:in_h/2:in_w/2:in_h/2
```

### Trimming Border Dividers / Seams (If AI Renders Dividing Lines)
If Omni or a screen recording includes a 2px to 4px dividing line between quadrants, add a 2px inset margin to each crop to eliminate border bleed:
```bash
# Example with 4px center divider (2px trim per side):
# Top-Left:
crop=1918:1078:0:0,scale=1920:1080:flags=lanczos
# Top-Right:
crop=1918:1078:1922:0,scale=1920:1080:flags=lanczos
# Bottom-Left:
crop=1918:1078:0:1082,scale=1920:1080:flags=lanczos
# Bottom-Right:
crop=1918:1078:1922:1082,scale=1920:1080:flags=lanczos
```

---

## 5. Reverse Workflow: Assembling 4 Angles into a 4K 2x2 Grid (`xstack`)

If starting from 4 separate 1080p camera recordings or 3D viewport renders, assemble them into a master 4K UHD video:

```bash
ffmpeg -y \
  -i angle_01_front_wide.mp4 \
  -i angle_02_profile_closeup.mp4 \
  -i angle_03_low_heroic.mp4 \
  -i angle_04_overhead_topdown.mp4 \
  -filter_complex "\
    [0:v]scale=1920:1080:flags=lanczos,setsar=1[v0]; \
    [1:v]scale=1920:1080:flags=lanczos,setsar=1[v1]; \
    [2:v]scale=1920:1080:flags=lanczos,setsar=1[v2]; \
    [3:v]scale=1920:1080:flags=lanczos,setsar=1[v3]; \
    [v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[v]" \
  -map "[v]" -map 0:a? \
  -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -b:v 25M -movflags +faststart \
  quad_split_4k_master.mp4
```

---

## 6. Node.js Service Integration: Slicing & Merging Functions

TypeScript service functions for programmatic execution inside Scratchbox IDE:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface QuadSplitOutputs {
    topLeftPath: string;
    topRightPath: string;
    bottomLeftPath: string;
    bottomRightPath: string;
}

/**
 * Splits a 4K quad-split video into 4 separate 1080p angle videos in a single pass.
 */
export async function splitQuadVideoToFourAngles(
    input4kPath: string,
    outputs: QuadSplitOutputs
): Promise<QuadSplitOutputs> {
    const filterComplex = [
        '[0:v]split=4[v0][v1][v2][v3]',
        '[v0]crop=1920:1080:0:0[angle_tl]',
        '[v1]crop=1920:1080:1920:0[angle_tr]',
        '[v2]crop=1920:1080:0:1080[angle_bl]',
        '[v3]crop=1920:1080:1920:1080[angle_br]'
    ].join('; ');

    const args = [
        '-y',
        '-i', input4kPath,
        '-filter_complex', filterComplex,
        '-map', '[angle_tl]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputs.topLeftPath,
        '-map', '[angle_tr]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputs.topRightPath,
        '-map', '[angle_bl]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputs.bottomLeftPath,
        '-map', '[angle_br]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputs.bottomRightPath
    ];

    await execFileAsync('ffmpeg', args);
    return outputs;
}
```

---

## 7. Production Directorial & Engineering Checklist

1. **Always Demand 4K UHD**: Never render quad splits at 720p or 1080p if you intend to cut the quadrants into individual videos. Only 4K ($3840 \times 2160$) yields clean $1920 \times 1080$ Full HD outputs.
2. **Audio Stream Mapping**: When deconstructing with `-map 0:a?`, the audio track from the master video is cleanly duplicated onto all four extracted angle files so each angle has synchronized sound.
3. **Even Pixel Offsets**: Always verify crop offsets and dimensions are strictly even numbers (`1920`, `1080`, `0`) to satisfy H.264/H.265 $4:2:0$ chroma subsampling restrictions.
4. **Faststart Streaming**: Always append `-movflags +faststart` to every extracted angle so web video players and review tools can scrub instantly without buffering the entire file.

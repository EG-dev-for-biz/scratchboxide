# Google Omni 1.1 Multi-Angle & 2x2 Quad-Split Production Guide

> **Target Model**: Google Omni 1.1 Flash (`gemini-omni-1.1-flash` / Google GenAI Interactions API)  
> **Core Concepts**: Multi-Angle Prompting, 2x2 Quad-Split Composition, 4K UHD Requirement ($3840 \times 2160$), Slicing/Deconstructing into 4x Standalone 1080p Videos, 3D Spatial Trajectories, Keyframe Pinning (`<FIRST_FRAME>` / `<LAST_FRAME>`), Multi-Turn Video Reshoots, FFmpeg Quad Assembly (`xstack`).

---

## Table of Contents
1. [Official Tag Syntax & Role Binding](#1-official-tag-syntax--role-binding)
2. [The Continuity Rule & Angle Directives](#2-the-continuity-rule--angle-directives)
3. [The Critical 4K Resolution Requirement](#3-the-critical-4k-resolution-requirement)
4. [2x2 Quad-Split Multi-Camera Production Prompts](#4-2x2-quad-split-multi-camera-production-prompts)
5. [Deconstructing a 4K Quad-Split into 4 Standalone 1080p Videos](#5-deconstructing-a-4k-quad-split-into-4-standalone-1080p-videos)
6. [3D Spatial Trajectories & Walkthroughs](#6-3d-spatial-trajectories--walkthroughs)
7. [First & Last Frame Interpolation](#7-first--last-frame-interpolation)
8. [Conversational Multi-Turn Reshoots](#8-conversational-multi-turn-reshoots)
9. [Reverse Workflow: Assembling 4 Angles into a 4K 2x2 Grid (`xstack`)](#9-reverse-workflow-assembling-4-angles-into-a-4k-2x2-grid-xstack)
10. [Common Pitfalls & Directorial Fixes](#10-common-pitfalls--directorial-fixes)

---

## 1. Official Tag Syntax & Role Binding

Google Omni 1.1 uses explicit role tags to control conditioning inputs. Using arbitrary tags (like `<IMAGE_0>`) degrades camera accuracy or causes the model to guess your intent.

### A. Endpoint Frame Anchors (Literal Keyframe Geometry)
- **`<FIRST_FRAME>`**: Binds the image as the **literal opening frame** at $t = 0.0\text{s}$. The camera starts from this exact pixel composition and pose.
- **`<LAST_FRAME>`**: Binds the image as the **literal closing frame**. Must always be paired with `<FIRST_FRAME>`. Omni solves the continuous in-between camera path.

### B. Reference Assets (Semantic & Style Conditioning)
- **`<IMAGE_REF_N>`**: Guide for character likeness, materials, or art style (e.g. `<IMAGE_REF_0>`, `<IMAGE_REF_1>`). Omni does **not** lock this as the starting frame.
- **`<VIDEO_REF_N>`**: Video reference for motion, 6-DoF camera kinematics, or actor choreography (e.g. `<VIDEO_REF_0>`).

### C. Multi-Asset Header Declarations
For complex pipelines, declare roles explicitly at the start of your prompt:
```text
[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]
[# References <VIDEO_REF_0>@Video1]
```

---

## 2. The Continuity Rule & Angle Directives

### The Montage Suppression Rule
By default, Google Omni creates a narrative multi-shot sequence with rapid cuts. To force a continuous, unbroken camera take, **always include one of these exact phrases**:
- `Single continuous shot, no scene cuts`
- `In a single unbroken scene`
- `One continuous shot, no jump cuts`
- `Oner`

### Approved Camera Vocabulary
Omni is trained on standard director and cinematography vocabulary:

| Category | Approved Terms | Notes |
|---|---|---|
| **Framing** | `wide shot`, `establishing shot`, `medium shot`, `close-up`, `extreme close-up`, `macro`, `over-the-shoulder` | Sets subject-to-frame ratio |
| **Angle** | `eye-level`, `low-angle`, `worm's-eye`, `high-angle`, `bird's-eye`, `90-degree top-down`, `Dutch tilt`, `POV` | Sets camera pitch/elevation |
| **Motion** | `push in`, `punch in`, `pull out`, `pull back`, `dolly in/out`, `truck left/right`, `pedestal up/down`, `crane shot` | Physical camera translation |
| **Rotation** | `pan left/right`, `tilt up/down`, `orbit`, `sweep around`, `arc`, `whip pan` | "Orbit" circles the subject |
| **Lens Optics** | `shallow depth of field`, `rack focus`, `dolly zoom` (vertigo effect), `anamorphic flare`, `tilt-shift` | Controls focal behavior |

---

## 3. The Critical 4K Resolution Requirement

When planning to cut a 2x2 quad-split into 4 individual videos:
- **720p ($1280 \times 720$)**: Slices into 4 tiny **$640 \times 360$** clips (low SD resolution).
- **1080p ($1920 \times 1080$)**: Slices into 4 **$960 \times 540$** clips (sub-HD resolution).
- **Mandatory 4K UHD ($3840 \times 2160$)**:
  - Each individual quadrant is exactly **$1920 \times 1080$ (Full HD 1080p)**.
  - Slicing yields four standalone, broadcast-ready 1080p video files with zero loss of sharpness.

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

## 4. 2x2 Quad-Split Multi-Camera Production Prompts

### Prompt A: Pure Text-to-Video 4K Quad-Split
```text
Generate a 2x2 split-screen video capturing the exact same subject and action simultaneously from four synchronized perspectives. The subject appearance, physical motion, environment, and lighting must remain 100% identical and temporally synchronized across all four panels.

Panel Layout & Camera Angles:
- Top-Left (Panel 1): Master wide frontal shot at eye level, establishing the subject in the full environment.
- Top-Right (Panel 2): Medium close-up 45-degree side profile, focusing on facial expressions and hand actions.
- Bottom-Left (Panel 3): Low-angle heroic shot looking up from ground/table level with shallow depth of field.
- Bottom-Right (Panel 4): Top-down 90-degree overhead bird's-eye view looking directly down onto the subject and workspace.

Execution Constraints:
- Resolution: 4K UHD (3840x2160), 16:9 aspect ratio.
- Single continuous shot across all four quadrants — zero internal jump cuts or camera switching.
- Precise multi-camera synchronization: every movement, gesture, and light reflection happens at the exact same millisecond in all 4 quadrants.
- Clean seamless split: no thick frame dividers, text labels, or watermarks dividing the quadrants.
- Format: Photorealistic, natural physical lighting, authentic spatial audio corresponding to the physical action. No background music.
```

### Prompt B: 4K Quad-Split from a Reference Image (`<IMAGE_REF_0>`)
```text
[# References <IMAGE_REF_0>@Image1]
Generate a 2x2 split-screen 4K UHD (3840x2160) video exploring the subject from <IMAGE_REF_0> from four distinct camera angles simultaneously.
Keep the subject's identity, clothing, materials, and lighting strictly identical to <IMAGE_REF_0> in every panel.
- Top-Left: Wide establishing front view.
- Top-Right: Close-up side profile on facial details.
- Bottom-Left: Low worm's-eye view looking up.
- Bottom-Right: 90-degree overhead bird's-eye angle.
All 4 quadrants must be perfectly synchronized in time and action. Single continuous shot, no scene cuts.
```

---

## 5. Deconstructing a 4K Quad-Split into 4 Standalone 1080p Videos

To cut a 4K ($3840 \times 2160$) quad-split into 4 distinct, synchronized Full HD 1080p video files, use FFmpeg's `crop` filter: `crop=out_w:out_h:x:y`.

### Single-Pass Extraction (Fastest & Most Efficient)
This single command reads the 4K source once and exports all four 1080p angle videos concurrently:

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

### Individual Quadrant Extraction Commands
To extract only a specific angle:

```bash
# 1. Top-Left: Front Wide (1920x1080 at 0, 0)
ffmpeg -y -i "quad_split_4k.mp4" -vf "crop=1920:1080:0:0" \
  -map 0:v -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_01_front_wide.mp4"

# 2. Top-Right: Profile Close-Up (1920x1080 at 1920, 0)
ffmpeg -y -i "quad_split_4k.mp4" -vf "crop=1920:1080:1920:0" \
  -map 0:v -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_02_profile_closeup.mp4"

# 3. Bottom-Left: Low-Angle Heroic (1920x1080 at 0, 1080)
ffmpeg -y -i "quad_split_4k.mp4" -vf "crop=1920:1080:0:1080" \
  -map 0:v -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_03_low_heroic.mp4"

# 4. Bottom-Right: Overhead Top-Down (1920x1080 at 1920, 1080)
ffmpeg -y -i "quad_split_4k.mp4" -vf "crop=1920:1080:1920:1080" \
  -map 0:v -map 0:a? -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -movflags +faststart "angle_04_overhead_topdown.mp4"
```

### Dynamic Resolution Handling (Any Input Canvas)
If the input resolution is non-standard, use relative expressions `in_w/2` and `in_h/2`:
```bash
crop=in_w/2:in_h/2:0:0             # Top-Left
crop=in_w/2:in_h/2:in_w/2:0        # Top-Right
crop=in_w/2:in_h/2:0:in_h/2        # Bottom-Left
crop=in_w/2:in_h/2:in_w/2:in_h/2   # Bottom-Right
```

---

## 6. 3D Spatial Trajectories & Walkthroughs

### Architectural Fly-Through & Walkthrough
```text
A smooth, continuous 10-second Steadicam walkthrough at a measured 1.6-meter eye height. 
The camera begins inside a minimalist concrete foyer with soft floor-level cove lighting. 
It dollies steadily forward down a narrow corridor, passes through an open floor-to-ceiling glass pivot door, and reveals an expansive double-height living pavilion overlooking a dusk pine forest. 
As the camera crosses the threshold into the wide space, it executes a slow 30-degree pan to the right while continuing its forward linear vector. 
Accurate optical depth: strong foreground occlusion as doorframes slide past, crisp perspective lines converging on the distant forest horizon, natural lens rack focus.
Single continuous shot, unbroken oner, no scene cuts, zero camera roll.
Ambient audio: soft rubber sole footsteps on polished screed, subtle change in acoustic reverberation as space transitions from narrow corridor to grand hall.
```

### 360° Volumetric Orbit with Freeze-Time ("Bullet Time")
```text
A 10-second high-precision volumetric camera probe in a rain-drenched neon alleyway. 
At 0-2s: A motorcycle rider skids across wet asphalt, sending a fan of water droplets into the air. 
At 2.5s: Time completely freezes into a static moment. The motorcycle, spinning wheels, rider, and thousands of airborne water droplets freeze in mid-air. 
From 2.5s to 8.5s: The camera performs a smooth, continuous 360-degree orbital sweep around the frozen subject at wheel-hub level, tilting upward 45 degrees as it circles behind the rear tire, then leveling out at the front headlight. 
Every frozen splash droplet reveals consistent refraction and specular neon highlights from every viewing angle. 
At 8.5s: Time resumes instantly at full speed as the motorcycle roars out of frame. 
Single unbroken take, no jump cuts, perfect 3D depth adherence.
```

---

## 7. First & Last Frame Interpolation

```text
<FIRST_FRAME> <LAST_FRAME>
One continuous shot, no jump cuts. 
The camera smoothly dollies out along the optical Z-axis and performs a sweeping 90-degree orbital arc to the right. 
Transition seamlessly from the initial macro composition of <FIRST_FRAME> to land precisely on the wide spatial composition of <LAST_FRAME>. 
Maintain rigid physical geometry, authentic depth parallax, and constant lighting throughout the transition.
```

---

## 8. Conversational Multi-Turn Reshoots

Omni retains conversational scene memory across turns using `previous_interaction_id`:

```text
# Turn 1: Master Take
A master craftsperson carving an intricate wooden violin at a workbench in a sunlit workshop. Late afternoon golden hour light rakes across wood shavings. Medium wide shot, single continuous shot, no scene cuts.

# Turn 2: Over-The-Shoulder Reverse
Change the camera angle to be an over-the-shoulder shot looking down past the craftsperson's right shoulder onto the violin. Keep the character, workbench layout, wood shavings, and lighting identical.

# Turn 3: Macro Low Worm's-Eye
Keep everything in the scene identical. Shift the camera to a low worm's-eye macro angle resting on the tabletop, looking up at the chisel slicing through the wood grain with shallow depth of field.
```

---

## 9. Reverse Workflow: Assembling 4 Angles into a 4K 2x2 Grid (`xstack`)

To combine 4 individual 1080p camera angle takes into a single 4K master:

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

## 10. Common Pitfalls & Directorial Fixes

| Problem | Root Cause | Directorial Fix |
|---|---|---|
| **Slices are low quality / blurry** | Generated quad split at 720p or 1080p | **Always generate in 4K UHD ($3840 \times 2160$)** so each split quadrant is true $1920 \times 1080$ Full HD. |
| **Video cuts unexpectedly** | Omni defaults to multi-shot narrative | Add `"Single continuous shot, no scene cuts"` or `"Oner"`. |
| **Opening frame doesn't match image** | Used `<IMAGE_0>` or `<IMAGE_REF_0>` | Change to `<FIRST_FRAME>` and append `"Use this image as the starting frame."` |
| **Dividing line seam visible in cut clips** | AI rendered a 2-4px border grid | Apply a 2px inset crop margin: e.g. `crop=1918:1078:2:2,scale=1920:1080:flags=lanczos`. |
| **Audio lost on sliced angle files** | Forgot audio stream mapping | Include `-map 0:a?` on every output map clause in the FFmpeg command. |
| **QuickTime / Web player black screen** | Missing pixel format conversion or faststart header | Always include `-pix_fmt yuv420p -movflags +faststart`. |

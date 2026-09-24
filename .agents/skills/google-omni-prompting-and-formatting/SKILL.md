---
name: google-omni-prompting-and-formatting
description: >-
  Format prompts and instructions for Google Omni 1.1 (Gemini Omni 1.1 Flash) across text-to-video,
  frame-to-video, video editing, and 3D spatial camera trajectories. Enforces official media tag syntax
  (<FIRST_FRAME>, <LAST_FRAME>, <IMAGE_REF_N>, <VIDEO_REF_N>), suppression of unwanted cuts, timestamped shot
  blocks, multi-turn conversational edits, and camera motion vocabulary.
---

# Google Omni 1.1 Prompt Formatting & Direction Skill

This skill defines the official, mathematically grounded guidelines and syntax standards for directing **Google Omni 1.1** (`gemini-omni-1.1-flash` / Vertex AI Interactions API).

Omni differs fundamentally from earlier video diffusion engines:
1. **Default Montage Behavior**: Omni defaults to narrative multi-shot sequences with camera cuts unless explicitly told otherwise.
2. **Strict Tag Grammar**: Tags like `<FIRST_FRAME>` and `<IMAGE_REF_0>` have dedicated functional roles in Omni's conditioning layer.
3. **Conversational Memory**: Follow-up turns preserve previously rendered pixels and 3D scenes when instructed surgically.

---

## 1. Official Media Tag Syntax & Role Binding

Never invent arbitrary tags (e.g., `<IMAGE_0>`, `<START_FRAME>`, `<IMG_1>`). Omni recognizes two distinct tag classes:

### A. Endpoint Frame Anchor Tags (Literal Keyframe Geometry)
Used when an image must define the exact physical start or end pose in 3D space:
- `<FIRST_FRAME>`: Binds the image as the **literal opening frame** at $t = 0.0\text{s}$. The camera must start from this exact pixel composition.
- `<LAST_FRAME>`: Binds the image as the **literal closing frame**. **Must always be paired with `<FIRST_FRAME>`**. Omni solves for the continuous in-between camera path and physical transformation.

### B. Reference Tags (Semantic & Style Conditioning)
Used when an asset serves as a visual guide, character identity, or motion trajectory, but should **not** appear as a frozen first frame:
- `<IMAGE_REF_N>`: Image reference for subject likeness, architectural textures, or color grading (starts at `0`: `<IMAGE_REF_0>`, `<IMAGE_REF_1>`, etc.).
- `<VIDEO_REF_N>`: Video reference for motion, 6-DoF camera kinematics, or actor performance (starts at `0`: `<VIDEO_REF_0>`).

### C. Multi-Asset Source Declarations (`[# Sources ...]`)
For complex multi-input pipelines with multiple roles, declare sources and references as header tags:
```text
[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]
[# References <VIDEO_REF_0>@Video1]
```

---

## 2. Core Prompting Rules & Constraints

### Rule 1: The Continuity Gate (Suppressing Unwanted Cuts)
Because Omni creates multi-shot montages by default, **every continuous camera move or single take must explicitly include one of these exact phrases**:
- `Single continuous shot, no scene cuts`
- `In a single unbroken scene`
- `One continuous shot, no jump cuts`
- `Oner`

### Rule 2: Separation of Camera Motion vs. Subject Motion
Describe what the camera does and what the subject does in separate clauses:
- **Subject**: *"A woman wearing a yellow raincoat walks briskly along the wet sidewalk."*
- **Camera**: *"Tracking shot at hip height, maintaining constant distance while moving parallel to the subject."*

### Rule 3: Do Not Re-Describe Bound Frames
When passing `<FIRST_FRAME>` or `<LAST_FRAME>`, the images already provide the materials, colors, and lighting. Describe only:
1. The physical progression/changes between the states.
2. The 3D camera trajectory (pan, dolly, tilt, orbit).
3. The continuity instruction.

---

## 3. Approved Cinematography & Motion Vocabulary

Omni's latent video diffusion backbone is specifically tuned on standard film and DP vocabulary:

| Category | Approved Terms | Notes & Usage |
|---|---|---|
| **Framing & Angle** | `wide shot`, `establishing shot`, `medium shot`, `close-up`, `extreme close-up`, `macro`, `over-the-shoulder`, `low-angle`, `worm's-eye`, `high-angle`, `bird's-eye`, `top-down`, `Dutch tilt`, `POV` | Avoid vague terms like "zoomed in"; specify subject scale. |
| **Translation & Movement** | `push in`, `punch in`, `pull out`, `pull back`, `dolly in/out`, `truck left/right`, `pedestal up/down`, `crane shot`, `tracking shot`, `aerial glide`, `FPV drone` | "Push in" = physical forward move. "Punch in" = rapid forward move. |
| **Rotation** | `pan left/right`, `tilt up/down`, `orbit`, `sweep around`, `arc`, `whip pan` | "Orbit" circles the subject. "Pan" rotates from a stationary tripod. |
| **Optical & Lens** | `shallow depth of field`, `deep focus`, `rack focus`, `dolly zoom` (vertigo effect), `anamorphic lens flare`, `fisheye`, `tilt-shift` | "Dolly zoom" shifts background perspective while subject size remains constant. |
| **Camera Texture** | `film camera`, `35mm cinema lens`, `handheld`, `natural smartphone zoom`, `webcam style` | Directly dictates motion jitter, grain, and sensor aesthetic. |

---

## 4. Multi-Shot & Multi-Angle Formatting (Timestamp Syntax)

When directing a scene with multiple angles or choreographed cuts, format the timeline using `[start-ends]` timecode brackets:

```text
A 10-second cinematic sequence of a ceramicist throwing a bowl on a pottery wheel. Preserve character likeness and studio environment across all shots.

[0-3s] Wide establishing shot: camera locked off at eye level, framing the artisan seated at the wheel in a sunlit corner of the studio. Warm 3200K side window lighting.
[3-6s] Cut to medium 45-degree angle: slow push-in framing wet hands shaping the rotating clay bowl. Clay water droplets spin outward in natural physics.
[6-8s] Cut to top-down 90-degree overhead shot: looking directly down into the interior of the expanding ceramic vessel as thumbs smooth the inner wall.
[8-10s] Cut to tight macro close-up: shallow depth of field on the artisan's focused eyes, soft clay dust on eyebrows, natural eye blink.

Sound design: rhythmic whir of the electric pottery wheel, wet clay squelching under hands, distant outdoor birdsong. No dialogue, no background music.
```

---

## 5. Dual-Conditioned 3D Blockout Pipeline (`<FIRST_FRAME>` + `<VIDEO_REF_0>`)

When generating photorealistic video from a 3D blockout (e.g. Three.js / Google 3D Tiles / Blender camera export):

```text
[# Sources <FIRST_FRAME>@Image1] [# References <VIDEO_REF_0>@Video1]

Motion & Spatial Guidance: Follow the EXACT 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of the provided blockout video (<VIDEO_REF_0>). Smoothly propagate the visual identity, architectural textures, and surface materials of the start frame (<FIRST_FRAME>) across the entire camera move without morphing, warping, or style drift.

Shot Continuity & Timing: A single continuous uninterrupted camera take from start to finish. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits. Strictly follow the continuous flight trajectory and exact timing of <VIDEO_REF_0>.

Sound design: subtle outdoor atmospheric wind, distant urban ambience. No dialogue, no music.
```

---

## 6. Multi-Turn Conversational Video Editing

When modifying an existing Omni generation in a conversational session (`previous_interaction_id`):

### The Golden Rule of Edits
**Surgical edits beat detailed paragraphs.** The more details you re-describe, the more Omni hallucinates unwanted changes.

### Prompt Formula:
1. **Preserve line**: State what must stay identical.
2. **Change line**: State the single modification.

```text
# Example 1: Camera Angle Reshoot
Change the camera angle to be an over-the-shoulder shot looking down from behind the violinist's right shoulder. Keep the violinist's appearance, playing motion, violin, environment, and lighting identical.

# Example 2: Environmental Reshoot
Change the weather outside the window from rain to heavy falling snow. Keep the character, interior room, desk lamp, and camera motion identical.

# Example 3: Object Modification
Change the coffee mug on the table into a clear glass tumbler with ice water. Keep everything else the same.
```

---

## 7. Synchronized Multi-Angle Split-Screen Directives

To produce multiple synchronized perspectives of the exact same instant:

```text
Generate a 2x2 split-screen video capturing the exact same subject and action simultaneously from four perspectives:
- Top-Left: Wide frontal shot at eye level.
- Top-Right: 45-degree side profile close-up tracking facial expressions.
- Bottom-Left: Low-angle heroic perspective looking up from floor level.
- Bottom-Right: Top-down 90-degree overhead bird's-eye view.

Subject appearance, lighting, physical actions, and speed must remain 100% identical and synchronized across all four quadrants. No cuts within panels. Photorealistic, 4K UHD, natural ambient audio only.
```

---

## 8. Common Failure Modes & Quick Fixes

| Failure Mode | Root Cause | Immediate Fix |
|---|---|---|
| **Video cuts unexpectedly** | Omni's default narrative montage | Prepend `"Single continuous shot, no scene cuts"` or `"Oner"`. |
| **Initial frame doesn't match image** | Used `<IMAGE_0>` or `<IMAGE_REF_0>` instead of anchor | Change tag to `<FIRST_FRAME>` and state `"Use this image as the starting frame."` |
| **Interpolation fails or ignores end frame** | `<LAST_FRAME>` used alone or with `<IMAGE_REF_0>` | Must pair `<FIRST_FRAME>` and `<LAST_FRAME>` together in the same prompt. |
| **Scene drifts during multi-turn edit** | Prompt re-described too much scenery | Simplify to 1 sentence change + `"Keep [character, environment, timing] identical."` |
| **Camera moves erratically / morphs** | Confused camera and subject motion | Separate subject verbs from camera verbs; use standard terms (`dolly`, `orbit`, `push in`). |
| **Text on screen degrades** | Long sentences or paragraphs requested | Enclose short text in quotes (e.g. `'OPEN'`), limit to 1–4 words, specify font position. |
| **Performer mesh/splats hollow on torso/feet** | Directional lighting / scenery baked into conditioning | Use Prompt Neutrality Contract: `#808080` studio backdrop, shadowless flat lighting, head-to-toe uncropped vertical framing (`9:16`), and symmetrical A-frame pose. |

---

## 9. Performer & Character Conditioning Directives (Head-to-Toe Neutral Studio A-Pose)

When generating character plates, motion references, or performer conditioning videos for downstream 4D Gaussian Splatting, SMPL mesh fitting, or skeletal skinning:

### The Prompt Neutrality Contract
1. **Zero Context**:
   - Strictly mandate a solid, plain neutral grey studio backdrop (`#808080`).
   - Forbid all scenery: zero rooms, wooden floors, carpets, furniture, radiators, stage sets, concert venues, or outdoor elements.
2. **Zero Theatrical / Directional Lighting**:
   - Mandate completely flat, neutral, high-CRI, diffuse, shadowless studio illumination.
   - Forbid directional sunlight, golden hour, stage spotlights, colored gels, rim lights, and cast shadows on body or floor.
3. **Full-Body Head-to-Toe Vertical Framing (`9:16`)**:
   - The entire figure must be visible from the crown of the head to the soles of the shoes.
   - Maintain clear top and bottom margins; never crop at knees, waist, or neck.
4. **Canonical Symmetrical A-Frame Pose (A-pose)**:
   - Arms angled outward 35°–45° from the flanks.
   - Palms open facing forward with relaxed fingers (eliminates torso-arm occlusion).
   - Legs straight and shoulder-width apart.
   - Feet flat on the floor pointing directly forward (eliminates leg fusion).
5. **Programmatic Builder & In-App Tool**:
   - Use `buildNeutralPerformerPrompt` from `omniVideoPromptService.ts` or the agent tool `build_neutral_performer_prompt`.

---

## 10. Frame-Motivated Video Conditioning & 4DAnyone Multi-View Capture (Wan2.2-TI2V-5B)

When capturing or generating video specifically for 4D dynamic Gaussian Splatting, SMPL rigging, or volumetric neural human reconstruction:

### A. Frame-Motivated Video Conditioning (`<FIRST_FRAME>`)
- Video motion fed into the 4D reconstruction pipeline must NOT be arbitrary unconditioned motion; it must be **strictly motivated by the hero reference frame**.
- Enforce opening frame binding via `<FIRST_FRAME><IMAGE_REF_0></FIRST_FRAME>`.
- The subject must begin motion seamlessly originating from the symmetrical **A-frame pose (A-pose)** established in Frame 0 (arms angled 35°–45°, palms forward, legs shoulder-width apart, feet flat on floor).
- Identity, skin albedo, and clothing morphology must remain continuous with zero jump cuts or perspective snapping.

### B. 4DAnyone Video Diffusion Architecture (Wan2.2-TI2V-5B)
- To synthesize multi-view camera capture streams around the performer from a single casual frame, adopt the video diffusion model backbone from `4DAnyone` (`ant-research/4DAnyone`, arXiv:2608.20335): **Wan2.2-TI2V-5B** (Text-and-Image to Video 5B DiT).
- **Reference Context Packing (RCP)**: Packs reference appearance tokens into an $O(1)$ memory representation, ensuring accurate albedo and silhouette preservation across all video frames.
- **Target Context Routing (TCR)**: Routes cross-view attention across simultaneous multi-angle capture viewpoints, guaranteeing cross-view consistency during dynamic movement.

### C. Multi-View Capture Viewpoint Rig
Capture viewpoints must systematically cover:
1. **Front 0°**: Eye-level perspective portrait, locked-off elevation.
2. **Left 45°**: 45° left lateral oblique perspective, locked-off elevation.
3. **Right 45°**: 45° right lateral oblique perspective, locked-off elevation.
4. **Rear 180°**: 180° rear dorsal perspective, locked-off elevation.
5. *(Optional continuous ring)*: 360° orbital camera at radius $2.2\text{m}$, elevation $1.25\text{m}$, FOV $50^\circ$.

### D. Programmatic Builders & Tools
- **Prompt Formulation**: `buildFrameMotivatedPerformerVideoPrompt` (`omniVideoPromptService.ts`) or Gemini tool `build_frame_motivated_performer_prompt`.
- **ComfyUI Multi-View Video Generation**: `generate_4danyone_multiview_video` invoking `ComfyUiPipelineAgent` Wan2.2 blueprint with `Wan22TI2VModelLoader`, `WanMultiViewCameraRigNode`, `Wan22MultiViewSampler`, and `SkeletonConditioningNode`.
- **Pipeline Ingestion**: `VideoTo4DPerformerPipelineService.process({ frameMotivatedInput: { ... } })`.


---
name: critical-thinking
description: >-
  Ruthlessly audit technical concepts, AI architectures, and engineering plans from first principles. Eliminates
  hand-waving, AI hype, false assumptions, and optimistic fallacies. Enforces information-theoretic limits, physical
  constraints, failure-mode stress testing, and boring high-leverage alternatives.
---

# Critical Thinking & First-Principles Technical Auditing

The **Critical Thinking** skill is an adversarial analytical framework designed to stress-test technical proposals, architectural diagrams, AI pipelines, and feature ideas. Its mission is to strip away wishful thinking, marketing abstractions, and "AI magic" before a single line of wasted code is written.

---

## 1. The Core Philosophy

1. **Optimism is Not an Architecture**:
   - Never assume an AI model "will understand the intent", "will maintain 3D consistency", or "will infer the missing geometry".
   - Treat all generative AI components as probabilistic, non-deterministic function approximations prone to hallucinations, temporal flickering (boiling), and spatial distortion.

2. **Respect the Laws of Information Theory**:
   - You cannot extract information that does not exist in the input without introducing an external prior.
   - If a 2D image does not show the back of a building, the back does not exist in the data. Any reconstructed back is a hallucination of the prior, not an observation. Acknowledge this distinction explicitly.

3. **No "Magic Box" Hand-Waving**:
   - Calling an API or feeding a prompt to a diffusion model is not a pipeline solve unless the coordinate systems, latent representations, multi-view consistency constraints, and error propagation paths are mathematically sound.

4. **Seek the Simplest, Most Boring Path First**:
   - If a deterministic 30-year-old computer graphics or photogrammetry algorithm (epipolar geometry, SVD, Marching Cubes, BVH ray tracing, classical bundle adjustment) solves 80% of the problem with 100% reliability, zero GPU compute cost, and sub-millisecond latency, you must justify why an ungrounded neural model is needed.

---

## 2. The 5-Gate Adversarial Audit Framework

When invoked to review or think critically through an idea, run the proposal sequentially through these 5 gates:

```
                            [CRITICAL THINKING 5-GATE AUDIT]
 ┌──────────────────────────────────────┬──────────────────────────────────────┐
 │ Gate 1: Epistemic & Assumption Audit │ Gate 4: Adversarial Failure Modes    │
 │ Gate 2: Information Theory & Physics │ Gate 5: The "Boring Path" Benchmark  │
 │ Gate 3: Component Reality Check      │                                      │
 └──────────────────────────────────────┴──────────────────────────────────────┘
```

### Gate 1: Epistemic & Assumption Audit (What Are We Assuming?)
- **Action**: Unearth every unstated assumption upon which the idea depends.
- **Key Probes**:
  - What are we assuming about model capabilities that hasn't been demonstrated in a reproducible benchmark?
  - Are we assuming clean, noise-free inputs (perfect lighting, static scenes, rigid objects, known intrinsics)?
  - What happens if the input video has camera shake, rolling shutter, motion blur, or dynamic moving objects (cars, pedestrians, rustling leaves)?

### Gate 2: Information-Theoretic & Physical Grounding
- **Action**: Check whether the output can mathematically be derived from the input.
- **Key Probes**:
  - **Parallax & Baseline**: Does a casual phone video or image provide sufficient angular baseline ($>15^\circ-30^\circ$) to triangulate depth, or is the baseline near zero (causing depth uncertainty $\sigma_z \propto \frac{z^2}{b \cdot f}$ to explode)?
  - **Scale Ambiguity**: Monocular video has inherent projective scale ambiguity. Without a known metric reference or IMU sensor fusion, $1\text{m}$ is indistinguishable from $100\text{m}$. How is scale resolved?
  - **Radiance vs. Albedo**: Real photographs have baked-in illumination (sun angle, sky dome color, specular hotspots, cast shadows). Does the pipeline falsely assume it can treat raw RGB as surface albedo without deliberate de-lighting?

### Gate 3: Component Reality Check (The "No Magic Boxes" Rule)
- **Action**: Inspect the exact input/output contracts of every model and library in the stack.
- **Key Probes**:
  - What does the model actually emit? (e.g., Omni/Veo emits a flat 2D MP4 video raster; it does *not* emit 3D meshes, depth buffers, camera poses, or NeRF/3DGS representations).
  - How do downstream tools consume that output? If you need camera poses, does COLMAP / solvePnP actually converge on AI-generated video, or does diffusion "texture boiling" destroy sub-pixel feature matching?
  - Is the latency, cost, and rate-limiting profile realistic for the envisioned workflow?

### Gate 4: Adversarial Failure-Mode & Edge-Case Excavation
- **Action**: Actively try to break the architecture. Brainstorm where the pipeline will fail catastrophically.
- **Failure Modes to Probe**:
  1. *Texture Boiling / Temporal Incoherence*: In AI-synthesized multi-view or video, pixels shift subtly between frames. Traditional SfM (Structure from Motion) and 3DGS optimization rely on photometric consistency ($I_1(x) \approx I_2(x')$); boiling creates severe floaters, fog, and geometric noise.
  2. *Depth Inversion / Necker Cube Illusions*: Neural depth estimators frequently invert concave/convex geometry (e.g., treating archways or doorways as outward bumps).
  3. *Occlusion Cavities*: What happens when the camera orbits behind an object not visible in the initial frame? Does the system hallucinate plausible geometry, or leave an open hollow shell?
  4. *Coordinate Frame Clashes*: Nerfstudio vs OpenCV vs OpenGL vs Three.js vs Blender. Inverting $Y$ or $Z$ turns scenes inside out or mirrors chirality.

### Gate 5: The "Boring Path" Benchmark & Opportunity Cost
- **Action**: Formulate the strongest possible alternative using existing, reliable technologies.
- **Key Probes**:
  - Can we solve this using Google Photorealistic 3D Tiles, Cesium, or standard photogrammetry directly?
  - Why not a pre-scanned asset library (Sketchfab, Polycam, OSM) paired with simple camera tracking?
  - What is the actual value proposition to the user? Does this solve a genuine pain point, or is it a tech demo masquerading as a product?

---

## 3. The 3D & Generative AI Reality Matrix

When auditing ideas in spatial computing, 3DGS, VFX, and video diffusion, keep these verified technical facts in mind:

| Domain | What Marketing Claims | What the Math/Physics Actually Delivers |
|---|---|---|
| **Text/Image-to-3D** | "Generate any 3D asset in seconds" | Low-res quad meshes or fuzzy Gaussian splats with baked lighting, missing backfaces, non-manifold topology, and no articulation. |
| **Monocular Video-to-3D** | "Turn casual phone video into a 3D world" | Scale-ambiguous, noisy point clouds; fails on non-static scenes; requires wide parallax sweeps; struggles with textureless walls or reflective surfaces. |
| **Video Generation Models (Veo, Omni, Sora)** | "World simulators with consistent 3D physics" | 2D spatio-temporal video diffusion models. Objects morph, vanish, or duplicate when occluded; vanishing points drift across frames; zero explicit 3D geometry. |
| **Photorealistic 3D Tiles** | "Every city in the world in 3D" | High-accuracy real-world geometry and textures, but with baked daytime lighting, melted building bases, and water/bridge curtain artifacts (requires UTDRA/de-lighting). |
| **3D Gaussian Splatting (3DGS)** | "Real-time photorealism replacing polygons" | Brilliant for view synthesis of static scenes with high-density calibrated camera inputs ($>50$ photos). Degrades rapidly with sparse views; heavy VRAM memory footprint; non-trivial to relight or physically simulate. |

---

## 4. Execution Standard & Response Structure

When conducting a critical review, organize the analysis into this standard structure:

1. **Executive Verdict**:
   - `[SOUND]` (Mathematically and practically viable with minimal risk)
   - `[VIABLE WITH CAVEATS]` (Viable, but requires specific mitigations for known failure modes)
   - `[FRAGILE]` (Relies on lucky assumptions, edge-case prone, high risk of degradation)
   - `[UNSOUND / FLAWED]` (Breaks fundamental physical, mathematical, or API constraints)
2. **First-Principles Breakdown**:
   - What is physically/mathematically happening under the hood.
3. **Unstated Assumptions Exposed**:
   - Explicitly list the hidden premises that the user or proposal took for granted.
4. **Where the Pipeline Breaks (Adversarial Stress Test)**:
   - Specific failure points, coordinate clashes, boiling artifacts, or geometric collapses.
5. **The "Boring High-Leverage Counterproposal"**:
   - What would a senior VFX supervisor or principal computer vision engineer build instead to achieve the real user goal with 10x less risk?
6. **The Unassailable Path Forward**:
   - Actionable, step-by-step recommendation that preserves the vision while grounding it in solid engineering.

# Scratchbox Autonomous Engineering & CLI Directives

This rule governs both the internal agentic engineering loop (Gemini CLI / Antigravity Harness) and the dedicated Scratchbox Spatial CLI (`sbox`).

---

## 1. Two-Tier Architecture Principles

1. **User Tier: Scratchbox CLI (`sbox`)**
   - The primary command-line tool for developers and spatial engineers operating on Scratchbox workspaces.
   - Purpose: Git for the Physical World (multiverse branches, geodetic anchoring, spatial diffing, asset commits) and native C++20 3D procedural baking.
   - Binary: `sbox` / `scratchbox` (run via `npm run sbox -- <command>` or `node packages/cli/bin/sbox.js`).

2. **Autonomous Tier: Gemini CLI / Agent Loop Harness**
   - Headless background agent loop for automated spatial engineering, procedural geometry synthesis, and visual verification.
   - Leverages `sbox bake`, `sbox qa`, and `sbox diff` inside automated test and generation pipelines.

---

## 2. 3D Procedural Engine & Clang Compilation Rules

### Rule: Always Lean on C/C++ First for 3D Assets
- Prioritize modern C++20 using `#include "scratchbox_engine.hpp"`.
- Use high-performance SIMD vector math (`scratchbox_math.hpp`), Signed Distance Fields (SDFs), Marching Cubes polygonization, FastNoise3D (Perlin/FBM/Worley), and physical material assignment.
- When generating new procedural generators, verify compilation via:
  ```bash
  npm run sbox -- bake <path/to/generator.cpp> -o <path/to/output.glb> --opt -O3
  ```
- All binaries must stream valid binary glTF 2.0 (`.glb`) chunks containing vertices, normals, UVs, vertex colors (`COLOR_0`), and PBR metallic-roughness materials.

---

## 3. Spatial Multiverse Version Control (`sbox`)

When working on spatial worlds and geospatial datasets:

1. **Initialize Spatial Repository**:
   ```bash
   npm run sbox -- init
   ```
   Creates `.scratchbox/spatial-state.json` initialized to root timeline `earth/main`.

2. **Branch Management (Multiverse Timelines)**:
   ```bash
   npm run sbox -- branch
   npm run sbox -- branch create earth/<feature-name> --from earth/main
   npm run sbox -- branch checkout earth/<feature-name>
   ```

3. **Stage & Geodetically Anchor 3D Assets**:
   ```bash
   npm run sbox -- attach <model.glb> --lat <latitude> --lng <longitude> [--alt <meters>] [--heading <degrees>] [--name <identifier>]
   ```

4. **Commit Spatial Delta**:
   ```bash
   npm run sbox -- commit -m "Describe spatial modifications"
   ```

5. **Compute Multiverse Diffs**:
   ```bash
   npm run sbox -- diff <targetBranch> [sourceBranch]
   ```

---

## 4. Visual Verification & Photorealism QA Directive

- Grade generated 3D assets using the photorealism evaluator:
  ```bash
  npm run sbox -- qa <model.glb>
  ```
  Evaluates:
  - **Geometric Density** (0-25 pts): High polygon density without faceted artifacts.
  - **Normal Smoothness** (0-25 pts): Coherent surface normal flow and curvature.
  - **Ambient Occlusion & Cavity Realism** (0-25 pts): Crevice shadowing and depth contrast.
  - **PBR Roughness & Metallic Balance** (0-25 pts): Realistic dielectric / metallic surface properties.
  - **Acceptance Threshold**: Total score $\ge 80/100$ for production photorealistic scenes.
- **Mandatory Visual Feedback Loop**: Capture screenshots at milestones when developing 3D scenes, viewports, or UI layouts to evaluate lighting balance, material realism, and spatial framing.

# Scratchbox Parametric Humanoid Standard (SB-Human)

## Overview

This Knowledge Base documents the architecture, mathematical formulations, binary asset specifications, and procedural synthesis workflows for the **Scratchbox Parametric Humanoid Standard (SB-Human)**.

The Scratchbox Humanoid Standard is a high-performance, native **C++20** and **TypeScript** system designed to procedurally sculpt, rig, skin, morph, and animate expressive 3D humanoid characters without runtime dependencies, Python interpreters, or deep learning frameworks.

In accordance with the 3D Engine Architecture Directives in [`AGENTS.md`](../../../AGENTS.md), all parametric mesh deformations, PCA morphology evaluations, Rodrigues kinematics, and Linear Blend Skinning routines execute in compiled native C++20 via the Scratchbox 3D Engine (`#include "scratchbox_engine.hpp"`), streaming binary glTF 2.0 (`.glb`) chunks directly into the Scratchbox Viewport.

---

## Standard Specification & Modules

1. [**01. Scratchbox Humanoid Mathematical Foundations**](./01_scratchbox_humanoid_mathematical_foundations.md)
   * The complete mathematical formulation of the Scratchbox Humanoid Standard:
   * PCA shape morphology space ($\mathcal{B}_S(\vec{\beta})$) and facial expression blend shapes ($\mathcal{B}_E(\vec{\psi})$).
   * Sparse linear joint regression ($J(\vec{\beta}) = \mathcal{J} \cdot V_{shaped}$).
   * Pose corrective blend shapes ($\mathcal{B}_P(\vec{\theta})$) for anatomical volume preservation.
   * Hierarchical Forward Kinematics (FK) via Rodrigues' axis-angle rotations.
   * Linear Blend Skinning (LBS) matrix formulation with normal transformation via inverse-transpose.
   * Dynamic facial contour landmarking with angle-driven barycentric interpolation.

2. [**02. C++20 SIMD Skinning & Kinematics Architecture**](./02_cpp20_simd_skinning_and_kinematics.md)
   * High-performance C++20 architecture using `scratchbox_math.hpp`, `scratchbox_kinematics.hpp`, and `scratchbox_skinning.hpp`.
   * SIMD-vectorized vertex transformation loops and cache-aligned memory layouts.
   * CSR (Compressed Sparse Row) evaluation for joint regression matrices.
   * glTF 2.0 binary (`.glb`) streaming for skinned meshes (`JOINTS_0`, `WEIGHTS_0`) and bone node hierarchies.

3. [**03. Scratchbox Humanoid Asset Specification (.sbhuman)**](./03_asset_schema_and_weight_ingestion.md)
   * The `.sbhuman` (Scratchbox Human Binary) standalone open binary format specification.
   * Zero-dependency binary layout: magic header (`0x4E4D4853`), rest geometry, joint regression, skinning weights, and blend shape tensors.
   * Native C++ serialization (`saveToFile`) and deserialization (`loadFromFile`).
   * Procedural anatomical asset generation via `ProceduralHumanoidBuilder`.

4. [**04. Deformation Transfer & Inverse Fitting**](./04_deformation_transfer_and_inverse_fitting.md)
   * Surface-to-surface nearest-triangle projection and barycentric coordinate mapping.
   * Multi-stage loss formulation: Edge preservation ($L_1$), Centroid alignment ($L_2$), and full parameter fitting ($L_3$).
   * Trust-region / Gauss-Newton optimization in native C++ and TypeScript.
   * Retargeting motion capture data (AMASS, BVH, MediaPipe landmarks) into Scratchbox Humanoid parameters.

5. [**05. AI Agent Character Sculpting Playbook**](./05_agent_character_sculpting_playbook.md)
   * Operational guidelines for Scratchbox AI agents (`LongRunning3DGeneratorAgent`).
   * Semantic parametrization: mapping high-level user prompts (e.g., "athletic runner", "cyberpunk operative") to morphology vectors ($\vec{\beta}$), pose vectors ($\vec{\theta}$), and facial expressions ($\vec{\psi}$).
   * Composing humanoid characters into procedural worlds using `scratchbox_scene_composer.hpp` and `scratchbox_nature.hpp`.

---

## Architectural Principles

* **Self-Contained Native Standard**: The Scratchbox Humanoid Standard is fully self-contained. It operates directly with procedural generation or standalone `.sbhuman` binary assets, eliminating reliance on external research toolkits or converters.
* **Native C++20 Execution**: All runtime mesh deformation and skinning occurs directly in C++20 binaries compiled on the fly by `NativeCppCompilerService`.
* **Zero Overhead glTF 2.0 Streaming**: Binary `.glb` chunks stream directly over stdout into the Three.js viewport for immediate rendering and inspection.
* **Complete Rigging & Skinning Fidelity**: Canonical 21-joint humanoid skeleton, 4-influence geodesic skinning weights, and GPU-ready standard accessors.

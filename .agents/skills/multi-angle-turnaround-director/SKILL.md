---
name: multi-angle-turnaround-director
description: >-
  Direct, orchestrate, and execute consistent multi-angle turnaround image captures across objects, props, and
  scenes using the Adaptive Multi-Angle Camera Orbit Engine (MultiAngleTurnaroundService and
  generate_multi_angle_turnaround). Enforces continuous spherical camera orbit mathematics (azimuth, elevation, standoff),
  dual-anchor identity conditioning graphs (Hero Anchor + Adjacent Continuity), and non-negotiable isolation rules
  (zero ground, zero cast shadows, zero text/labels) for seamless downstream 3D reconstruction (Trellis via Fal.ai, 3DGS, NeRF).
---

# Multi-Angle Turnaround Director: Consistent Multi-View Visual Orchestration

The **Multi-Angle Turnaround Director** enforces consistent 360-degree visual synthesis for 3D reconstruction and rotoscoping in Scratchbox IDE. It solves the fundamental limitation of 2D diffusion models—**rotational spatial blindness**—by transforming prompt-to-image workflows into a mathematically bounded **Adaptive Multi-Angle Camera Orbit Rig** coupled with a **Dual-Anchor Identity Conditioning Graph**.

---

## 1. The Rotational Blindness Problem in 2D Generative Models

When an agent prompts a 2D diffusion model for multiple views of a subject using separate unconditioned prompts, the model fails due to:

| Failure Mode | Root Cause | Observable Visual Defect |
| :--- | :--- | :--- |
| **Identity Mutation** | Each prompt samples a distinct latent trajectory with no cross-view attention. | A sedan turns into a station wagon; a damaged tree grows new branches on angle 2. |
| **Scale & Aspect Drift** | No explicit metric standoff distance is maintained across views. | The side profile is rendered 2× larger than the front view, corrupting downstream 3D depth unprojection. |
| **Floor Skirt Artifacts** | Unconstrained backgrounds include ground planes, asphalt slabs, or display pedestals. | Neural 3D models (Trellis / FlexiCubes) mesh the floor into the asset base, creating jagged plastic slabs. |
| **Phantom Shadow Geometry** | Directional cast shadows create dark ground patches. | Inverted depth pits or warped concave geometry at bottom contact points. |
| **Floating Text Extrusions** | Turnaround concept sheets generate labels like `"FRONT"` or dimension lines. | Neural flow-matching algorithms extrude 2D text glyphs into floating 3D plastic shards. |

---

## 2. Continuous Spherical Camera Orbit Mathematics

Camera stations are positioned on a continuous bounding sphere centered at the subject origin $\mathbf{O} = (0, 0, 0)$:

$$\mathbf{C}(\theta, \phi, r) = \begin{pmatrix} r \cos\phi \sin\theta \\ r \sin\phi \\ r \cos\phi \cos\theta \end{pmatrix}$$

Where:
- $\theta \in [0^\circ, 360^\circ)$ is the **azimuth angle** (turntable rotation around the vertical $+Y$ axis).
  - $\theta = 0^\circ$: Direct front orthographic view ($+Z$ facing).
  - $\theta = 90^\circ$: Pure right profile side elevation ($+X$ facing).
  - $\theta = 180^\circ$: Direct rear orthographic view ($-Z$ facing).
  - $\theta = 270^\circ$: Pure left profile side elevation ($-X$ facing).
  - $\theta = 45^\circ$: Hero 3/4 isometric angle.
- $\phi \in [-90^\circ, +90^\circ]$ is the **elevation / pitch angle**.
  - $\phi = 0^\circ$: Eye-level horizon elevation.
  - $\phi = 30^\circ \text{ to } 45^\circ$: Three-quarter down-angle perspective.
  - $\phi = 90^\circ$: Bird's-eye zenith top view.
- $r$ is the continuous metric standoff distance ($r \ge 1.5 \times \text{bounding radius}$).

```
                         +Y (Up)
                           │
                 [0°, 90°] Top Zenith View
                           │
                           │     [45°, 35°] Hero 3/4 Isometric
                           │     /
  [-90°, 0°]               │    /               [+90°, 0°]
  Left Profile ─────────[SUBJECT]───────────── Right Profile (+X)
                          /│
                         / │
                        /  │
               [0°, 0°] Front (+Z)
```

---

## 3. The Dual-Anchor Identity Conditioning Topology

To guarantee zero identity drift across wide camera orbits, the engine connects sequential generations via a **Dual-Anchor Graph**:

```
[Hero Angle 0: 3/4 Iso] ──── (Identity Anchor) ────► [Angle 1: 90° Side]
         │                                                    │
         │ (Identity Anchor)                                  │ (Adjacent Continuity)
         ▼                                                    ▼
[Angle 2: 0° Front] ◄─────────────────────────────────────────┘
         │
         │ (Identity Anchor)
         ▼
[Angle 3: 180° Rear] ◄─── (Adjacent Continuity) ─── [Angle 2]
```

1. **Primary Anchor (Angle 0)**: The hero 3/4 perspective establishing the asset's structural DNA (damage locations, proportions, primary massing). It is injected into **every** subsequent camera call.
2. **Secondary Anchor (Angle $i-1$)**: The immediately preceding view, ensuring that surface features visible on the horizon boundary transition smoothly across rotation steps.

---

## 4. The 3 Non-Negotiable Invariants for 3D Reconstruction

Whenever images are intended for neural 3D mesh extraction (Trellis, TripoSR, 3DGS, NeRF), the agent **must strictly enforce**:

1. **Zero Ground Surfaces / Zero Pedestals**:
   - The subject **must float completely unattached in the center of a pure solid white infinite void**.
   - No floor, no concrete slab, no pavement, no plinth, no display stand.
2. **Zero Directional Cast Shadows**:
   - No drop shadows, no ground contact shadows.
   - Illumination must be **100% uniform omnidirectional diffuse ambient light**. Spatial depth is conveyed exclusively via self-ambient occlusion in surface micro-crevices.
3. **Zero Text, Labels, or Grid Lines**:
   - Absolutely no typography, dimension markers, watermark signatures, or orthographic labels (`"FRONT"`, `"SIDE"`).

---

## 5. Standard Camera Orbit Presets

| Preset Name | Station Count | Coordinates $(\theta, \phi)$ | Primary Use Case |
| :--- | :--- | :--- | :--- |
| **`dcc-ortho-4`** | 4 | $[(45^\circ, 30^\circ), (90^\circ, 0^\circ), (0^\circ, 0^\circ), (180^\circ, 0^\circ)]$ | **Default for Trellis CAD & Set Dressing Props** |
| **`turntable-8`** | 8 | $[(0^\circ, 15^\circ), (45^\circ, 15^\circ), (90^\circ, 15^\circ), \dots, (315^\circ, 15^\circ)]$ | **Photogrammetry, 3DGS, NeRF, Splatfacto** |
| **`dome-hemisphere-12`** | 12 | 8 horizon stations ($15^\circ$) + 4 high-angle diagonal stations ($45^\circ$) | **Architectural pavilions, dioramas, ground outposts** |
| **`custom`** | $N$ | Explicit array of continuous $(\theta_i, \phi_i)$ coordinates | **Specialized VFX camera paths & rotoscoping** |

---

## 6. Prompt Formulation Matrix

### Positive Prompt Structure
```text
"A 3D digital sculpt maquette of [OPEN-DOMAIN SUBJECT], sculpted entirely in [MATERIAL/STYLE] with a matte ceramic surface finish. 
The subject is completely isolated and floating freely in the center of an infinite, pure solid white void. 
No ground plane, no floor, no pedestal, no plinth beneath the object. 
Completely shadow-free, zero cast shadows, zero drop shadow, lit exclusively by uniform omnidirectional diffuse ambient light with soft ambient occlusion in mechanical and organic crevices. 
High surface curvature relief. Clean, razor-sharp silhouette boundaries. 
No text, no letters, no typography, no labels, no watermarks, no annotations, no measurement lines, no grid. 
Viewed from [CAMERA ANGLE DESCRIPTION: e.g. 'pure horizontal side elevation profile at 90 degrees azimuth, 0 degrees pitch']."
```

### Strict Negative Prompt Token Suppressions
```text
"ground, floor, floor plane, pavement, grass, terrain, concrete slab, dirt, shadow, cast shadow, drop shadow, contact shadow, pedestal, plinth, stand, table, display base, text, typography, letters, watermark, signature, font, caption, callout, title, numbers, dimensions, grid, ruler, border, frame"
```

---

## 7. Downstream Execution Targets

- **Target 1: Fal.ai Trellis (`trellis-fal`, requires `FAL_KEY`)**:
  - Submits the hero view to Fal.ai Trellis and downloads the resulting binary `.glb` asset with metric AABB bounds.
- **Target 2: Dynamic 4DGS / Splatfacto (`gaussian-splatting`)**:
  - Unprojects camera rays using the known spherical poses $(\theta_i, \phi_i, r)$ to build a sparse camera constellation without needing COLMAP structure-from-motion.
- **Target 3: Canvas Turntable Viewport (`canvas-turntable`)**:
  - Renders an interactive 360-degree scrubbing widget directly in the chat or canvas for client visual review.

---

## 8. Programmatic API & Tool Reference

- **Service**: `MultiAngleTurnaroundService` (`packages/core/src/node/generative/multi-angle-turnaround-service.ts`)
- **Agent Tool**: `generate_multi_angle_turnaround`
  - Parameters:
    - `subject`: Natural language description of the asset/scene.
    - `rigPreset`: `'dcc-ortho-4' | 'turntable-8' | 'dome-hemisphere-12' | 'custom'`
    - `stylePreset`: `'18-percent-studio-clay' | 'pbr-delighted' | 'photorealistic'`
    - `isolation`: `{ floatingVoid: true, suppressShadows: true, suppressText: true }`
    - `downstreamTarget`: `'trellis-cloud-run' | 'gaussian-splatting' | 'none'`

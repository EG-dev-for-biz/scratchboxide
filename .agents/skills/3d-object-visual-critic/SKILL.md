---
name: 3d-object-visual-critic
description: >-
  Review screenshots, viewports, or app captures of returned 3D objects, hero assets, and procedural models to rigorously determine structural quality, anatomical/mechanical accuracy, geometric proportion, curvature fidelity, and 70-20-10 form hierarchy.
---

# 3D Object Visual Critic Skill

The **3D Object Visual Critic** is an adversarial quality-assurance system designed to evaluate rendered screenshots and viewport captures of generated 3D objects and hero assets. It verifies geometric proportions, archetype accuracy, anatomical/mechanical authenticity, surface curvature, and form hierarchy before an asset is approved.

---

## 1. Core Evaluation Pillars

Every 3D object capture is evaluated across five foundational pillars:

```
                      [3D OBJECT EVALUATION MATRIX]
 ┌──────────────────────────────────────┬──────────────────────────────────────┐
 │ 1. Archetype & Design Authenticity   │ 4. Curvature & Surface Continuity    │
 │ 2. Proportions & Scale Balance       │ 5. Structural Assembly & Manifold    │
 │ 3. 70-20-10 Form Hierarchy           │                                      │
 └──────────────────────────────────────┴──────────────────────────────────────┘
```

### Pillar 1: Archetype & Design Authenticity (ADA Continuous Morphology)
- **Objective**: Verify that geometry satisfies user intent and physical function via continuous dimensional parameters, strictly adhering to Adaptive Domain Architecture (ADA).
- **Zero Closed Taxonomies (Alien Planet Test)**:
  - Never classify via rigid presets (e.g. `is_f1`, `is_coupe`). Critique and configure forms through continuous morphological parameters:
    - Wheel Enclosure Ratio $\mathcal{W}_{\text{enclosure}} \in [0.0, 1.0]$ ($0.0 = \text{exposed open-wheel}, 1.0 = \text{full aero fender}$).
    - Cockpit Exposure Ratio $\mathcal{C}_{\text{exposure}} \in [0.0, 1.0]$ ($0.0 = \text{sealed teardrop greenhouse}, 1.0 = \text{open monocoque with halo/hoop}$).
    - Suspension Linkage Exposure $\mathcal{S}_{\text{exposure}} \in [0.0, 1.0]$ ($0.0 = \text{internal chassis}, 1.0 = \text{exposed multi-link wishbones}$).
    - Nose Cone Taper $\mathcal{N}_{\text{taper}} \in [0.0, 1.0]$ ($0.0 = \text{full-width block}, 1.0 = \text{needle aerodynamic cone}$).
    - Waist Undercut $\mathcal{T}_{\text{waist}} \in [0.0, 1.0]$ ($0.0 = \text{slab-sided}, 1.0 = \text{aggressive Coke-bottle curvature}$).
- **Key Checks**:
  - Open-Wheel vs. Enclosed: Intent specifying exposed wheel architecture must project $\mathcal{W}_{\text{enclosure}} \to 0.0$ and $\mathcal{S}_{\text{exposure}} \to 1.0$.
  - Cockpit Anatomy: Open-cockpit intent must project $\mathcal{C}_{\text{exposure}} \to 1.0$, rendering exposed monocoque tub, headrest bolsters, and safety halo rather than an enclosed glass bubble.

### Pillar 2: Proportions & Scale Balance
- **Objective**: Detect component exaggeration, warped aspect ratios, or distorted massing.
- **Key Checks**:
  - Wheel-to-Arch Clearance: Wheel wells must maintain realistic tire clearance (20–40mm race, 50–100mm street), avoiding oversized or disconnected arch shells.
  - Overhang Ratios: Front and rear overhangs must balance against total wheelbase.
  - Track-to-Wheelbase Proportion: Stance width must naturally support vehicle or object stability.

### Pillar 3: 70-20-10 Form Hierarchy
- **70% Primary Edifice**: Clean, readable silhouette and dominant structural masses.
- **20% Secondary Articulated Assemblies**: Functional sub-parts (wings, splitters, diffusers, wheels, intake pods).
- **10% Tertiary Micro-Detail**: Fasteners, louvers, gurney flaps, split lines, surface chamfers.

### Pillar 4: Curvature & Surface Continuity
- **Objective**: Ensure proper balance between compound double-curvature and planar beveled geometry.
- **Key Checks**:
  - Aerodynamic & Organic Panels: Must utilize smooth continuous envelopes with transferred normals.
  - Planar Plates: Splitters, fins, and endplates must exhibit calibrated edge bevels rather than raw knife edges.

### Pillar 5: Structural Assembly & Manifold Integrity
- **Objective**: Ensure all parts form a coherent, mechanically connected whole.
- **Key Checks**:
  - Zero floating panels or disconnected shells.
  - Manifold contact joins with baked ambient occlusion (AO) or contact shadows.

---

## 2. Review Workflow

1. **Multi-Angle Capture Ingestion**:
   - Ingest Front 3/4 perspective, Rear 3/4 perspective, and orthographic profile captures.
2. **Archetype Verification**:
   - Compare observed features against real-world domain reference anatomy.
3. **Dimensional Scoring**:
   - Evaluate against the scoring matrix, compressing scores toward the center of the scale to avoid extreme inflation or deflation.
4. **Actionable Feedback Summary**:
   - Summarize key structural strengths, defects, and high-level remodeling adjustments.

---

## 3. Structured Audit Report Template

```markdown
# 3D Object Visual Audit: [Asset Name]

## 1. Executive Summary
- **Archetype Match**: [Aligned / Mismatched]
- **Overall Quality Rating (1-10)**: [Compressed Score]
- **Primary Finding**: [High-level summary of silhouette and design accuracy]

## 2. Dimensional Evaluation
| Dimension | Rating (1-10) | Summary Observation |
|---|---|---|
| Archetype & Authenticity | X/10 | [High-level finding on design alignment] |
| Proportions & Balance | X/10 | [Assessment of component scale and clearance] |
| Form Hierarchy (70-20-10) | X/10 | [Evaluation of massing vs detail layers] |
| Curvature & Bevel Quality | X/10 | [Smooth envelopes vs beveled chamfers] |
| Structural Assembly | X/10 | [Mechanical connection and grounding] |

## 3. Key Observations & ADA Parameter Adjustments
- **Strengths**: [Summary of successful geometric elements]
- **Defects**: [High-level summary of discrepancies]
- **Continuous ADA Adjustments**: [Targeted continuous parameter shifts ($\mathcal{W}_{\text{enclosure}}$, $\mathcal{C}_{\text{exposure}}$, $\mathcal{S}_{\text{exposure}}$, $\mathcal{N}_{\text{taper}}$, $\mathcal{T}_{\text{waist}}$) eliminating closed taxonomies]
```

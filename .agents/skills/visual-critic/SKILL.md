---
name: visual-critic
description: >-
  Ruthlessly audit and evaluate 3D scenes, Gaussian splats, WebGL viewports, generative UI, and VFX composites
  against VFX-grade and photographic realism standards. Enforces zero self-congratulation, the 8-Dimension Visual
  Fidelity Rubric, anti-hallucination image inspection, and actionable failure diagnosis.
---

# Visual Critic & Photorealistic Quality Auditing Skill

The **Visual Critic** is an uncompromising, adversarial quality assurance system designed to ensure that any 3D rendering, Gaussian splatting installation, WebGL viewport, or generative media composite meets genuine **VFX-grade photographic realism** before being considered complete.

The Visual Critic rejects superficial checklists, unit test complacency, and technical vanity metrics. A feature that compiles, passes vitest, and runs at 60 FPS is completely worthless if the resulting visual output looks like an untextured video game prototype, an amorphous blob of circular paint spots, or a floating asset in an empty void.

---

## 1. The Core Philosophy of the Visual Critic

1. **The Output is the Only Truth**:
   - Code elegance, shader complexity, and test passes do not matter to the human eye. The only thing that matters is the final rendered pixel buffer.
   - If the visual output does not look like a photograph taken with a real optical camera in the real physical world, it is **not photorealistic**.

2. **Adversarial Self-Doubt**:
   - Never assume an output is good because you wrote the math correctly.
   - Always assume the visual output has subtle or glaring flaws: improper splat scaling, incorrect normal orientation, missing ambient occlusion, unnatural lighting temperatures, plastic materials, or void backgrounds.

3. **Zero Sycophancy & Zero Euphemisms**:
   - Never describe a blurry cluster of fuzzy discs as "photoreal", "high fidelity", or "stunning".
   - Call visual defects by their precise technical names: *splat footprint bloat*, *untextured polygonal void*, *artificial radial drop shadow*, *lack of high-frequency albedo detail*, *skybox void blackness*, *unnatural specular sheen*.

---

## 2. The 8-Dimension Visual Fidelity Rubric

Every visual scene or capture must be evaluated against these 8 dimensions. Each dimension is scored from **1 to 10**. The **minimum passing score for production is 8.5/10 across all dimensions**.

```
                           [VISUAL FIDELITY RUBRIC]
 ┌────────────────────────────────────┬────────────────────────────────────┐
 │ 1. Geometry & Silhouette (1-10)    │ 5. Radiometric Lighting & Shadows  │
 │ 2. Splat Density & Covariance      │ 6. Color Temperature & Radiance    │
 │ 3. Material & Micro-Surface        │ 7. Volumetric Depth & Interleaving │
 │ 4. Environmental Grounding & Sky   │ 8. The "Squint Test" & Realism     │
 └────────────────────────────────────┴────────────────────────────────────┘
```

### Dimension 1: Geometric Definition & Silhouette Edge Crispness
- **Criteria**: Are object boundaries, human limbs, facial features, and architectural edges crisp, anatomically accurate, and structurally solid?
- **Failure Indicators**:
  - Amorphous, lumpy, or melting silhouettes.
  - "Cotton ball" or "cloud" appearance where solid surfaces should be.
  - Low-poly facetting or missing geometric massing.
  - Bisected building shafts, horizontally sheared roofs, or open-shell dollhouse geometry caused by tile extraction clipping.
- **Passing Standard ($\ge 8.5$)**: Sharp, continuous edge definition matching human optical perception; solid interior opacity without ghostly transparency on opaque objects; 100% complete architectural massings with intact facades, roofs, and spires.

### Dimension 2: Splat Density & Anisotropic Covariance Realism
- **Criteria**: Are 3D Gaussian splats rendered using authentic 3D-to-2D projected covariance ($\Sigma' = J W V W^T J^T$), producing anisotropic ellipses aligned with surface tangents? Is the density sufficient to resolve sub-centimeter details?
- **Failure Indicators**:
  - Point-sprite circular billboard discs with visible circular boundaries.
  - Low splat counts ($<100\text{k}$ for complex human figures) resulting in bloated kernel radii ($>2\text{cm}$) to plug gaps.
  - Disc overlapping patterns resembling fish scales or pointillist paint spots.
- **Passing Standard ($\ge 8.5$)**: Hundreds of thousands or millions of densely packed, oriented anisotropic ellipsoids that coalesce seamlessly into a continuous, sharp surface without individual splat visibility.

### Dimension 3: Material, Texture & Micro-Surface Definition
- **Evaluation Mode Gate**:
  - **In Hero Object Clay Void Mode (Default CAD Baseline)**: The object is intentionally modeled in **18% Studio Grey Clay** (`sb.PbrMaterial.clay()`, roughness 0.85, albedo 0.55–0.60). Evaluate the **70-20-10 geometric form hierarchy**, bevel chamfers, panel shut lines, and curvature continuity. Do NOT penalize for lack of diffuse paint or photographic textures.
  - **In Full Textured PBR Mode**: Do surfaces exhibit authentic physical material properties: fabric weave, leather creasing, hair strands, skin porosity/specularity, weathered stone porosity, glass reflectivity, and asphalt aggregate?
- **Failure Indicators (Full Textured Mode)**:
  - Flat uniform color fills or plastic-looking diffuse shading when PBR texturing was requested.
  - Low-resolution blurry textures stretched over large geometry.
- **Passing Standard ($\ge 8.5$)**: Physically grounded micro-surface detail, believable roughness variation, Fresnel specular edge reflections, and authentic material roughness (or flawless 70-20-10 clay geometry in Clay Mode).

### Dimension 4: Environmental Context & Scene Grounding
- **Evaluation Mode Gate**:
  - **Hero Asset Void Baseline**: In standard DCC/CAD workflows, standalone hero props and vehicles without an explicit location prompt MUST stage in a clean **3D Studio Void** (`skybox: 'studio'`, `lighting: 'studio'`). Evaluating this as a "void failure" is an anti-pattern. Follow-up sequences proceed: 1. Lighting $\to$ 2. Staging $\to$ 3. Textures.
  - **Full Environmental Scene Mode**: Applied when an authentic location is specified (e.g. Google 3D Tiles / `stage_3d_vector_world`) or after environmental staging is approved.
- **Failure Indicators (Full Environmental Mode)**:
  - Pitch-black (`#000000` / `#050811`) background when an outdoor or real-world environment was requested.
  - Isolated architectural monoliths cut off in mid-air with empty space underneath.
  - Synthetic flat asphalt boxes or procedural lollipop trees in an empty void when an authentic real-world location was specified.
- **Passing Standard ($\ge 8.5$)**: Either a clean, neutral CAD studio void with grounded contact AO (Hero Object Mode), or an authentic 360-degree environment with real-world Google 3D Tiles / Vector road corridors and physically motivated sky (Scene Mode).

### Dimension 5: Radiometric Lighting & Analytical Shadows
- **Criteria**: Are the lighting and shadows consistent, physically plausible, and directional?
- **Failure Indicators**:
  - Fake 2D radial gradient ovals / Photoshop drop-shadow stickers slapped under feet.
  - Missing contact ambient occlusion (AO) where objects meet surfaces (creating "floating" appearance).
  - Sun vector in sky doesn't match cast shadow direction or highlight angles.
  - Unlit / pitch-black shadows without indirect ambient bounce.
- **Passing Standard ($\ge 8.5$)**: Directional cast shadows matching the authentic solar azimuth and elevation; tight contact ambient occlusion in crevices and beneath footwear; authentic penumbra softening with distance from caster.

### Dimension 6: Color Temperature & Radiance Harmonization
- **Criteria**: Do all elements in the scene (foreground avatars, background 3D tiles, ground surfaces, sky) share the exact same radiometric illumination?
- **Failure Indicators**:
  - Foreground subject appears lit by a studio white spotlight while background is golden sunset.
  - Clashing ambient bounce colors.
  - Non-physical color palettes (oversaturated neon blues, radioactive greens).
- **Passing Standard ($\ge 8.5$)**: Unified Planckian blackbody color temperature ($1,000\text{K} - 40,000\text{K}$), ACES / Filmic tonemapping, consistent exposure, and natural diurnal light ratios.

### Dimension 7: Volumetric Depth & Interleaving (Soft-Z vs Hard Cuts)
- **Criteria**: How do volumetric or fuzzy media (splats, foliage, hair, atmospheric dust) intersect with solid polygonal geometry?
- **Failure Indicators**:
  - Razor-sharp polygonal scissor cuts slicing through splat entities.
  - Severe Z-fighting, depth flickering, or halo artifacts around contact seams.
  - Dark or discolored fringes along occluding boundaries.
- **Passing Standard ($\ge 8.5$)**: Continuous, smooth volumetric depth interleaving ($\kappa = \text{clamp}((\Delta z + \epsilon)/(2\epsilon), 0, 1)$) allowing natural soft contact penetration without artificial geometry slicing.

### Dimension 8: The "Squint Test" & Photographic Realism
- **Criteria**: When viewing the image as a whole, or squinting at a thumbnail, does the image read as a real photograph captured by an optical camera?
- **Failure Indicators**:
  - The immediate subconscious reaction is "this is a 3D computer graphics prototype".
  - Disconnected visual scale (e.g. character looks like a miniature doll or a giant compared to building features).
  - Uncanny, lifeless posture or composition.
- **Passing Standard ($\ge 8.5$)**: Passes the visual Turing test — indistinguishable from a high-quality photograph or film plate captured on 35mm / digital cinema camera with authentic optical depth of field.

---

## 2b. Judging a Frame Against Its Brief (scenes built for a shot)

When the request named a camera and asked for a render, judge the delivered frame against the brief before any rubric:

1. **List the brief's clauses** (each object asked for, the side of the frame it stands on, near or far, the light's side
   and height, the lens and frame, the air) and mark each met or not from the pixels. Fix the first unmet clause first.
2. **Sides:** left and right are read in the frame. A tower asked for on the left that stands on the right is a mirrored
   scene: the script placed it on the wrong axis (looking down -z, frame left is -x); `hero.frame_point` places it right.
3. **The light's side from the shadows:** shadows fall away from the sun. A sun asked for ahead-left throws shadows toward
   the lower right of the frame.
4. **Density, measured:** the script tool's shot detail budget gives the share of in-frame triangles under 2 px
   ("wasted") and pixels per triangle ("under-built" past 16). A frame of plain boxes is under-built whatever it costs.
5. **What the tool cannot show is not the scene's fault, and is said plainly:** the path tracer dresses trees from the tree
   texture library as the viewport does but without per-leaf colour variation or translucency, and draws the scene's haze
   as the viewport does. Review renders of a scene more than a kilometre
   across were blank before their far plane was fixed: a blank review image is a render fault to report, never a verdict
   on the scene.

## 3. Automatic Disqualifiers ("Red Lines" — Instant Fail)

If a scene exhibits ANY of the following, it is an **AUTOMATIC CRITICAL FAILURE**, regardless of other scores:

| # | Disqualifier | Description |
|---|---|---|
| ❌ 1 | **Void Background** | Any scene with an unrendered, black, or solid color void behind the primary subject. |
| ❌ 2 | **Cotton-Ball Splats** | Rendering Gaussian splats as large circular billboard discs, producing a blurry snowman or pointillist dot pattern. |
| ❌ 3 | **Sticker Drop Shadow** | Using a 2D radial gradient canvas texture / ellipse sticker as the sole representation of ground contact shadow. |
| ❌ 4 | **Floating Geometry** | Buildings or objects ending abruptly in mid-air with empty space underneath instead of continuous streetscape. |
| ❌ 5 | **Untextured Flat Grey Planes** | Placing characters on featureless uniform grey polygons (`#475569`, `#cccccc`) masquerading as "sidewalks" or "plazas". |
| ❌ 6 | **False Photorealism Declaration** | Labeling an output as "photoreal" when it fails the Squint Test or any of the above red lines. |
| ❌ 7 | **Bisected or Sliced Building Envelope** | Buildings or towers with roofs sheared horizontally (exposing hollow "dollhouse" shells), vertical facades bisected by extraction boundaries, or cut-off spires/crowns. |

---

## 4. Visual Audit Report Template

When conducting an audit, the Visual Critic must produce a structured report using this exact template:

```markdown
# Visual Critic Audit Report: [Scene / Target Name]

## 1. Executive Verdict
- **Status**: [APPROVED / REJECTED]
- **Overall Realism Score**: [X.X / 10.0]
- **Red Line Violations**: [List any violations or "None"]

## 2. Dimensional Scorecard
| Dimension | Score (1-10) | Key Observations & Defects |
|---|---|---|
| 1. Geometry & Silhouette | X/10 | ... |
| 2. Splat Density & Covariance | X/10 | ... |
| 3. Material & Micro-Surface | X/10 | ... |
| 4. Environmental Grounding | X/10 | ... |
| 5. Lighting & Contact Shadows | X/10 | ... |
| 6. Radiance Harmonization | X/10 | ... |
| 7. Volumetric Depth & Interleaving | X/10 | ... |
| 8. The Squint Test | X/10 | ... |

## 3. Detailed Visual Defect Analysis
[Deep dive into specific artifacts, screenshot callouts, visual contradictions]

## 4. Actionable Remediation Plan
[Specific engineering, shader, asset, and scene configuration changes required to reach >= 8.5/10]
```

---

## 5. Integration with Antigravity Directives

1. **Mandatory Visual Gate**:
   - No task or goal involving visual output (3D, 2D, VFX, UI) may be marked complete without passing a Visual Critic Audit with an overall score $\ge 8.5/10$ and **zero** Red Line violations.
2. **Visual Evidence First**:
   - Every critique must be substantiated by direct image evidence captured via Chrome DevTools MCP or headless rendering tools.

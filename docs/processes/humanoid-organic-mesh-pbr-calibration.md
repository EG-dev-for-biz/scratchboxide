# Process: Humanoid Organic Mesh & PBR Calibration Pipeline

> **Recorded:** 2026-10-10  
> **Status:** Verified  
> **Tags:** `3d-engine` `sbhuman` `anatomy` `pbr` `uv-mapping` `ada-compliance`  
> **Target Domain:** 3D/CGI, Procedural Anatomy & Photorealistic PBR Rendering

---

## 1. Problem Statement & Context

* **Problem / Obstacle:**
  Procedurally generating hyper-realistic human appendages (such as hands, feet, ears, and facial features) from canonical character meshes (e.g. `.sbhuman` or raw CAD/rig topology) frequently suffers from severe uncanny valley distortions:
  1. Pronated or non-planar articulated bones (e.g. the thumb distal phalanx rotated $50^\circ-60^\circ$) cause global coordinate cuts to slice diagonally across nail plates and cutaneous folds.
  2. Global $Y$-height thresholding between dorsal (tanned, hair-bearing) and palmar (pale, glabrous) surfaces bleeds dorsal pigment into the delicate interdigital web spaces.
  3. Artificial displacement algorithms create unnatural bulbous or "clubbed" swellings on the undersides of digits.
  4. Nails appear skewed or misaligned relative to the skeletal curvature because planar texture projections do not track 3D surface crests.
  5. Tiled repeating micro-textures produce robotic lattice patterns across organic skin.

* **Symptom / Error:**
  - **Empirical Visual Artifacts**: In 4-viewport macro verification grids:
    - Thumb fingernail was rotated diagonally at $-43^\circ$ and drifted onto the lateral flank of the thumb.
    - Palmar interdigital webs exhibited blotchy orange/tan patches with jagged boundary steps.
    - Finger pulps had bulbous convex swellings on their undersides.
    - Vascular channels appeared ruler-straight rather than organically curvilinear.
  - **Codebase Log Indicators**:
    ```text
    GLB Mesh: 14022 vertices, 26656 triangles
    Warning: Asymmetrical rotation of thumb distal segment causes diagonal UV slicing
    Uncaught Buffer Misalignment: Float32Array byteOffset must be a multiple of 4
    ```

* **Root Cause Diagnosis:**
  1. **Carrier Coordinate Mismatch**: Using global Cartesian axes ($+Y$ as dorsal, $+X$ as lateral) for an appendage whose bones rotate along arbitrary $\mathrm{SE}(3)$ trajectories projects non-planar geometry into inverted or skewed coordinate frames.
  2. **Hyperplane Boundary Failure**: Planar separation boundaries ($y > y_{\text{mid}}$) fail on organic surfaces with varying curvature, concave interdigital webs, and pronated digits.
  3. **Heuristic Guesswork vs. Empirical 3D Querying**: Attempting to visually estimate UV coordinates for curved surfaces without querying the true 3D surface normal ridge leads to angular and translational offsets.
  4. **Micro-Tile Repetition Trap**: Skin is non-periodic biological tissue characterized by distinct structural zones (stratum lucidum, thenar creases, eponychium folds) that require continuous sectional macro photographic sheets rather than small repeating noise tiles.

* **Expected Outcome:**
  A closed-loop, mathematically grounded, ADA-compliant transformation pipeline that:
  - Preserves 100% continuous UV islands for extensor and flexor surfaces without seam cuts across nails or joints.
  - Automatically isolates concave web spaces using normal-aware invariants.
  - Sculpts sleek, natural volar contours and broad spatulate fingertip apices without bulbous swelling.
  - Accurately aligns nail plates with the underlying skeletal crests.
  - Renders multi-angle macro verification grids with zero manual camera intervention.

---

## 2. Prerequisites & Environment

* **Runtimes / Tools:**
  - Node.js v20.19+ (ESM & CJS compatibility).
  - TypeScript 5.4+ (`packages/core/tsconfig.json`).
  - Three.js (pure viewport rendering, software headless rasterization or WebGL).
  - Apple Clang / Modern C++20 toolchain (`clang++ -std=c++20 -O3`).
  - Python 3.10+ (for optional process recording helpers and analytical scripts).

* **Required Files / Context:**
  - Canonical mesh container: `public/models/sbhuman_neutral.sbhuman` (v2 binary).
  - Hand transformation service: `packages/core/src/node/spatial/SbHumanHandTransformer.ts`.
  - Canonical loader: `packages/core/src/common/spatial/SbHumanLoader.ts`.
  - High-resolution delighted macro references:
    - `public/textures/humanoid/hand_palm_macro_ref.png`
    - `public/textures/humanoid/hand_dorsal_macro_ref.png`
    - `public/textures/humanoid/hand_nail_macro_ref.png`
  - Verification harness: `scratch/render_hyperreal_hand_verification.js`.

---

## 3. Step-by-Step Resolution Procedure

### Step 1: Frenet-Serret Carrier Frame Orthogonalization
Never use global Cartesian axes to evaluate features on articulated limbs. For any digit, bone, or appendage segment between joint $\mathbf{j}_{\text{prox}}$ and $\mathbf{j}_{\text{dist}}$, construct an authentic orthonormal $\mathrm{SO}(3)$ coordinate basis using Gram-Schmidt orthogonalization:

```typescript
// 1. Longitudinal bone direction vector
const udir: Vec3 = vNorm(vSub(jDist, jProx));

// 2. Extensor / dorsal reference normal (projected perpendicular to udir)
const dot = vDot(nExtensorRef, udir);
const udorsal: Vec3 = vNorm(vSub(nExtensorRef, vScale(udir, dot)));

// 3. Lateral width axis (orthonormal cross product)
const ulat: Vec3 = vNorm(vCross(udir, udorsal));
```

*Mathematical Invariant*:
$$\mathbf{u}_{\text{dir}} \cdot \mathbf{u}_{\text{dorsal}} = 0, \quad \mathbf{u}_{\text{dir}} \cdot \mathbf{u}_{\text{lat}} = 0, \quad \mathbf{u}_{\text{dorsal}} \cdot \mathbf{u}_{\text{lat}} = 0, \quad \det([\mathbf{u}_{\text{dir}}, \mathbf{u}_{\text{dorsal}}, \mathbf{u}_{\text{lat}}]) = 1$$

---

### Step 2: Normal-Aware Manifold Partitioning for Dual UV Islands
To split an organic mesh into opposing sheets (e.g. Dorsal vs. Palmar / Extensor vs. Flexor) without cutting across interdigital webs or lateral flanks:

Do **not** use a single geometric $Y$-height cut. Couple the medial plane with the surface normal vector $\mathbf{n}_f$:

```typescript
// In SbHumanHandTransformer.ts
const fn = vNorm(vCross(vSub(p1, p0), vSub(p2, p0)));

// Normal-aware classification:
// Downward/inward facing faces belong to the flexor/palmar sheet
const isPalmarFacing = (triDigit >= 1) ? (fn[1] < 0.05) : (fn[1] < -0.15);
const isBelowMid = (relY < getYMid(relX) + (triDigit >= 1 ? 0.001 : -0.001));

// True dorsal classification:
// Only surfaces that are BOTH facing downward AND positioned below the midline are palmar.
// Lateral flanks and interdigital webs wrap cleanly without jagged seams.
const isDorsal = !(isPalmarFacing && isBelowMid);
```

---

### Step 3: Empirical Surface Ridge Extraction & Angular UV Calibration
When an anatomical feature (e.g. fingernail plate, dorsal tendon, ear helix) sits on a rotated organic form, do **not** visually guess its orientation or UV placement. Extract the empirical 3D surface ridge directly from the mesh vertices:

```javascript
// Query vertices on the extensor ridge with maximal upward normal
const ridgeVerts = [];
for (let i = 0; i < numVertices; i++) {
    if (pos[i].z > zMin && pos[i].z < zMax && norm[i].y > 0.70) {
        ridgeVerts.push({ p: pos[i], n: norm[i], uv: uvs[i] });
    }
}

// Compute the exact UV gradient from proximal to distal
const du = uvDistal.u - uvProximal.u;
const dv = uvDistal.v - uvProximal.v;

// Derive the axial inclination angle
const inclinationAngle = Math.atan2(du, -dv); // e.g. -55.0 degrees
```

Apply this calibrated angle and centered UV position to the nail synthesis kernel:
```typescript
const nails = [
    { name: 'Thumb', u: 0.4334, v: 0.4180, angle: -55.0 * Math.PI / 180, w: 0.0340, l: 0.0460 },
    // Digits 1 to 4 aligned along their respective phalangeal axes...
];
```

---

### Step 4: Anatomical Distal Phalanx & Volar Pad Sculpting
To prevent the artificial "clubbed" or bulbous finger appearance:
1. Replace spherical radial displacements with an asymmetric teardrop falloff clamped to $A_{\text{pad}} \le 1.8\,\text{mm}$.
2. Sculpt the apex into a broad spatulate squoval paddle preserving $\ge 92\%$ transverse bone width, flattening the dorsal side to support the nail plate:

```typescript
// Distal Squoval Apex Sculpting
const tApexZone = cfg.tMax - 0.0018;
if (t > tApexZone) {
    const xiApex = Math.min(1.0, Math.max(0.0, (t - tApexZone) / 0.0018));
    // Squoval transverse rounding (rounds only corners, keeping 92% width)
    const rApexW = 1.0 - 0.08 * Math.pow(xiApex, 3.2);
    // Dorsal surface remains taut and flat; volar surface curves upward
    const rApexHDorsal = 1.0 - 0.04 * Math.pow(xiApex, 2.0);
    const rApexHVolar = 1.0 - 0.10 * Math.pow(xiApex, 2.0);
    
    wNew = wRel * rApexW;
    hNew = hRel * ((hRel >= 0) ? rApexHDorsal : rApexHVolar);
}
```

---

### Step 5: Subcutaneous Chromophore Absorption & Continuous Macro Sheet Projection
1. **Dorsal Venous Synthesis**:
   Replace linear segments with continuous parametric 3D splines with subtle micro-tortuosity. Model deep dermal chromophore absorption using cubic Gaussian falloff:
   $$\Delta \text{Albedo}(d) = \mathbf{C}_{\text{vein}} \cdot \exp\left(-\left(\frac{d}{\sigma}\right)^2\right) \cdot \left(1 - \left(\frac{d}{R_{\text{vein}}}\right)^3\right)$$
2. **Continuous Sectional Photographic Sheets**:
   Project delighted photographic macro references as continuous sheets across each island rather than repeating small noise tiles. Use bilinear sampling with boundary clamping to eliminate seam repetitions:
   ```typescript
   const sampleBilinear = (img, u, v) => {
       const uu = clamp(u, 0, 1) * (img.width - 1);
       const vv = clamp(v, 0, 1) * (img.height - 1);
       // Bilinear filtering between 4 neighboring pixels...
   };
   ```

---

### Step 6: Automated 4-Viewport Orthogonal Macro Verification Harness
To verify anatomy and surface alignment without subjective manual positioning, construct a headless Three.js script that computes camera parameters directly from the target feature's 3D position, normal, and tangent vectors:

```javascript
// Example: Panel 4 Thumb Macro Camera Setup
const thumbCenter = new THREE.Vector3(0.0949, -0.0154, 0.0816);
const thumbNormal = new THREE.Vector3(0.0352, 0.9773, 0.2089).normalize();
const thumbCamPos = thumbCenter.clone().addScaledVector(thumbNormal, 0.046);
const thumbUp = new THREE.Vector3(0.4793, -0.2001, 0.8545).normalize();

const p4Buf = renderViewport(800, 800, thumbCamPos, thumbCenter, thumbUp, 22.0);
```

*Memory Alignment Invariant*: When instantiating TypedArrays from glTF binary buffers in Node.js, ensure buffers are copied or aligned to 4-byte boundaries:
```javascript
const copy = Buffer.from(slice); // Guarantees 4-byte byteOffset alignment
return new Float32Array(copy.buffer, copy.byteOffset, count * mult);
```

---

## 4. Verification & Validation

* **Verification Commands:**
  ```bash
  # 1. Compile core TypeScript services
  npx tsc -p packages/core/tsconfig.json

  # 2. Execute full transformation pipeline and PBR texture synthesis
  node scripts/run_hand_transformation.mjs

  # 3. Render 1600x1600 4-panel verification grid
  node scratch/render_hyperreal_hand_verification.js
  ```

* **Success Criteria & Mathematical Invariants:**
  - [x] **Panel 1 (Dorsal Overview)**: Vascular network exhibits smooth curvilinear paths with soft subcutaneous absorption; extensor tendon ridges and knuckle condylar blanching are distinct.
  - [x] **Panel 2 (Palmar Overview)**: Zero interdigital web discoloration; palm hollow and thenar/hypothenar pads are pale peach and uniform; Life, Head, and Heart lines feature deep normal V-grooves and cavity AO.
  - [x] **Panel 3 (Fingertip Macro)**: Nail plate displays authentic transverse C-curve arching, translucent crescent lunula, raised eponychium cuticle lip, and recessed paronychial sulcus.
  - [x] **Panel 4 (Thumb Macro)**: Nail plate is upright, dead-center on the dorsal phalanx ridge ($A = -55.0^\circ$), conforming smoothly to the pronated thumb phalanx.
  - [x] **Buffer Alignment Invariant**: Zero unaligned TypedArray exceptions in Node.js glTF parsers.
  - [x] **CI Primitive Gate**: `npm run lint:primitives` passes with zero forbidden client-side Three.js generative boxes or cylinders.

---

## 5. Pitfalls, Edge Cases & Rollback

* **Known Pitfalls:**
  - **Memory Alignment Faults**: glTF binary buffers (`.glb`) often pack vertex attributes at non-4-byte byte offsets (e.g. offset 10). Directly calling `new Float32Array(buffer, offset)` in Node.js throws `RangeError: byteOffset must be a multiple of 4`. Always wrap with `Buffer.from(slice)`.
  - **Planar UV Inversion**: Applying 2D rotation matrices to UV coordinates without checking the direction of the longitudinal axis can rotate features $180^\circ$ backward (e.g. cuticle at fingertip). Verify that $v_{\text{rot}} > 0$ always corresponds to the proximal direction.
  - **Over-Tightening Web Thresholds**: Setting the normal threshold too high ($\mathbf{n}_y > 0.3$) clips the lateral finger margins into the palmar island, creating visible vertical seams along the finger sides. Keep digit threshold at $\mathbf{n}_y < 0.05$.

* **Rollback Plan:**
  If a regression occurs in hand topology or texture mapping, restore the stable baseline files:
  ```bash
  git checkout packages/core/src/node/spatial/SbHumanHandTransformer.ts
  git checkout scratch/render_hyperreal_hand_verification.js
  npx tsc -p packages/core/tsconfig.json
  node scripts/run_hand_transformation.mjs
  ```

---

## 6. Reusability & Future Automation (ADA Compliance & Open-Domain Universality)

* **Generalizing to Any Human or Alien Body Part (The Alien Planet Test)**:
  This process was designed strictly in accordance with the **Adaptive Domain Architecture (ADA)** directives. It contains zero closed taxonomies (`type Hand = 'human' | 'alien'`).

  The five algorithmic pillars formulated here apply universally to any organic entity:
  1. **Carrier Frames on Any Kinematic Tree**: Any limb, tentacle, claw, ear, or horn with a skeletal or spline axis $\mathbf{j}(t)$ uses the Gram-Schmidt $\mathrm{SO}(3)$ frame constructor.
  2. **Normal-Aware Dual-Island Splitting**: Can partition any manifold (e.g. inside vs. outside of an ear concha, dorsal vs. plantar of a foot, anterior vs. posterior of an alien wing) using surface normals relative to local medial reference planes.
  3. **Empirical Crest Ridge Querying**: Locates feature centers along the geometric extrema of the mesh itself, remaining invariant to pose, scale, or anatomical differences.
  4. **Continuous Macro Sheet Projection**: Prevents tiling artifacts on any biomorphic surface by anchoring photographic or procedural detail to conformal coordinate charts.
  5. **Chromophore Layering**: Biophysical light absorption equations model human melanin/hemoglobin or alien bioluminescence/chlorophyll through continuous absorption coefficients $\mathbf{C} \in \mathbb{R}^3$.

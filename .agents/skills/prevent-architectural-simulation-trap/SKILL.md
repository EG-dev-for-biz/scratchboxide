---
name: prevent-architectural-simulation-trap
description: >-
  Detect, dismantle, and prevent the Architectural Simulation Trap across AI coding agents, systems engineering,
  and 3D/VFX pipelines. Enforces mechanical closed-loop verification, analytical mathematical invariant proofs
  (SO(3) chirality, WGS84 geodesics, 3DGS covariance Σ ≻ 0, Bernstein FFD partition of unity, differential UV Jacobians,
  radiometric conservation), bare-metal reality grounding, the Anti-Astronaut Principle, zero synthetic test claims,
  and elimination of hollow scaffolds and mock illusions.
---

# Preventing the Architectural Simulation Trap (AST)
### Mechanical Reality Grounding, 3D Mathematical Invariants & Anti-Astronaut Engineering Directive

The **Architectural Simulation Trap (AST)** is the fatal failure mode wherein an AI agent, engineer, or system constructs an elaborate **semantic, taxonomic, mathematical, or abstract facsimile** of an architecture—generating voluminous design documentation, deeply nested abstractions, factory interfaces, mock data pipelines, LaTeX equations in docstrings, and synthetic verification traces—**substituting the description, approximation, or simulation of a solution for real mechanical, physical, analytical, and bare-metal execution**.

Standard Large Language Models are probabilistic token predictors trained on text. They innately know what elegant architectural diagrams, clean code smells, enterprise patterns, and LaTeX mathematical formulas look like in prose. Consequently, an agent trapped in AST generates 500 lines of abstract interfaces, mock stubs, and synthetic success logs (`[PASS] 32/32 tests passed in 0.14s`) without ever invoking a compiler, verifying coordinate chirality, proving positive-definiteness of covariance matrices, testing memory layouts, checking process exit codes (`exit 0`), or writing a single line of real computational logic.

This skill provides an **adversarial, closed-loop operational framework** to guarantee that every proposal, refactor, and mathematical implementation is anchored in physical reality, closed-form analytical proofs, bare-metal performance, and verified mechanical execution.

---

## 1. The Core Philosophy: Reality Over Token Mimicry

```
                  [THE ARCHITECTURAL SIMULATION TRAP]
      ┌─────────────────────────────────────────────────────────┐
      │  LLM Token Prediction ──► Semantic Fluency ("Looks Good")│
      │  Hollow Interfaces    ──► Mock-in / Mock-out Testing    │
      │  Closed Taxonomies    ──► Synthetic Terminal Claims     │
      │  Equation Mimicry     ──► Coordinate / Metric Drift     │
      └────────────────────────────┬────────────────────────────┘
                                   │ BROKEN BY
                                   ▼
                [MECHANICAL REALITY GROUNDING (AST-FREE)]
      ┌─────────────────────────────────────────────────────────┐
      │  1. Unedited Live Subprocess Execution (Exit Code 0)    │
      │  2. Analytical Closed-Form Proofs (Machine Precision)   │
      │  3. Anti-Astronaut Principle (Rule of 3 Usages)         │
      │  4. Forward Splatting / Mapping (No Inverse Fictions)   │
      │  5. Bare-Metal Performance (C++20/SIMD/GLB Streaming)   │
      │  6. Continuous Dimensional Manifolds (No Closed Enums)  │
      └─────────────────────────────────────────────────────────┘
```

1. **Semantic Fluency is Not Mechanical Competence**:
   - An interface with zero or one implementation is not architecture; it is dead boilerplate.
   - Code that compiles only because its methods return `Promise.resolve(null)` or mock payloads is a paper tiger.
   - Beautiful LaTeX formulas in comments that do not match the compiled C++ or WebAssembly math are cognitive illusions.
   - An architecture is only as real as its live execution path under real operating system and physical constraints.

2. **The Output Buffer is the Only Truth**:
   - In 3D graphics, procedural geometry, spatial computing, and VFX: code elegance means nothing if the output buffer contains 12 flat Three.js box primitives instead of a 100,000-vertex manifold mesh, or if covariance matrices collapse with negative eigenvalues.
   - In systems engineering: a feature is not verified until a real subshell runs the compiler/test runner and returns exit code 0 with machine-precision numerical residuals.

3. **No Uninvited Abstraction (The Anti-Astronaut Invariant)**:
   - Solve the immediate, concrete, physical problem with the simplest, highest-performance code possible.
   - Do not design polymorphic multi-tiered factory orchestrators for hypothetical future requirements.

---

## 2. The 7 Cardinal Archetypes of the Simulation Trap

When evaluating code, proposals, or agent trajectories, audit for these 7 fatal archetypes:

| # | Archetype | Failure Manifestation | Grounded Mechanical Remedy |
| :--- | :--- | :--- | :--- |
| **1** | **The Hollow Scaffold** *(Syntactic Mimicry)* | Writing extensive interfaces, abstract base classes, and facades that return stubbed data or `// TODO` | **Delete the layer**. Write concrete implementation directly. Abstractions require $\ge 2$ distinct working call sites. |
| **2** | **The Synthetic Terminal Mirage** *(Hallucinated Verification)* | Declaring in chat text that tests pass or builds succeed without calling `run_command` and verifying `exit 0` | **Mandatory execution**. Run `run_command` with real CLI tools (`clang++`, `tsc`, `vitest`) and inspect raw stdout/exit codes. |
| **3** | **The Circular Inverse Reconstruction Trap** | Discarding known analytical 3D geometry to render 2D images, then running NeRF/3DGS inverse solvers to re-estimate it | **Analytical Forward Mapping**. Project known geometry directly into target formats (`scratchbox_hair.hpp`, `.spz`, `.glb`). |
| **4** | **The Toy Script / Tier-0 Regression** | Catching native engine errors and silently substituting client-side JS toy primitives (`THREE.BoxGeometry`) | **Surface the native error**. Enforce `GeometricComplexityGate` ($\ge 25,000$ vertices). Never fall back to toy JS. |
| **5** | **The Closed Taxonomy / Ontology Trap** | Creating discrete string unions (`type Domain = 'arctic' \| 'desert'`) and massive `switch-case` dispatchers | **Continuous Schemas**. The LLM is the domain engine. Project into continuous physical fields (meters, Kelvin, roughness). |
| **6** | **Static Code Proliferation** | Committing static one-off scene/handler files (`arctic_outpost.cpp`) to simulate versatility | **Ephemeral JIT Synthesis**. Synthesize code in memory via dynamic compilers, stream binary output, delete scratch files. |
| **7** | **The Mathematical Simulation Trap** *(Equation Mimicry & Drift)* | Writing LaTeX math in docstrings while implementation uses heuristic shortcuts, flipped axes, or loose tolerances | **Analytical Invariant Proofs**. Verify $\det(R)=+1$, positive-definiteness $\Sigma \succ 0$, and machine-precision residuals ($\le 10^{-6}$). |

---

### Detailed Breakdown of Archetype 7: The Mathematical Simulation Trap
- **The Trap**: An agent writes documentation or comments featuring elegant differential geometry or radiometric physics:
  ```cpp
  // Compute Projected 2D Covariance: Σ' = J * W * Σ * W^T * J^T
  // with analytical perspective Jacobian J
  ```
  However, the underlying code:
  1. Uses a crude spherical bounding radius approximation instead of full anisotropic covariance.
  2. Flips the camera coordinate frame (treating $+Y$ as Up in an OpenCV $-Y$ Down convention), producing inverted lighting or backward depth peeling.
  3. Uses loose numerical test tolerances (`expect(result).toBeCloseTo(expected, -1)`) that mask 10% to 50% cumulative precision drift.
  4. Inverts matrices without verifying that $\det(M) \ne 0$, causing silent `NaN` / `Inf` propagation during edge cases.
- **The Reality**: The model simulated mathematical mastery through prose while shipping numerically broken geometry.
- **The Fix**: Execute **Analytical Invariant Proofs** (`scripts/verify_3d_math_invariants.js`). Every 3D advancement must pass closed-form oracle tests with zero drift.

---

## 3. The 7 Core 3D Mathematical Invariants of Scratchbox IDE

To guarantee that 3D advancements are grounded in genuine mathematics rather than token simulation, all spatial computing, photogrammetry, and rendering pipelines must satisfy these 7 non-negotiable invariants:

### Invariant 1: SO(3) / SE(3) Chirality & Rotation Orthogonality
- **Mathematical Law**: Every rigid-body rotation matrix $R \in \mathrm{SO}(3)$ and unit quaternion $\mathbf{q} \in \mathbb{H}_1$ must satisfy:
  $$\det(R) = +1.000000 \quad (\text{Strictly right-handed; never } -1.0 \text{ reflection})$$
  $$R^T R = I \quad \text{with} \quad \|R^T R - I\|_\infty < 10^{-11}$$
  $$\|\mathbf{q}\|_2 = \sqrt{w^2 + x^2 + y^2 + z^2} = 1.000000 \pm 10^{-6}$$
- **Verification**: Zero tolerance for axis flipping or unnormalized quaternions drifting across integration steps.

### Invariant 2: WGS-84 <-> ECEF <-> ENU Geodesic Metric Preservation
- **Mathematical Law**: Coordinates converted from geodetic $(\phi, \lambda, h)$ to Earth-Centered Earth-Fixed (ECEF) using ellipsoidal radius of curvature:
  $$N(\phi) = \frac{a}{\sqrt{1 - e^2 \sin^2 \phi}}$$
  and projected into the Local Tangent Plane (LTP / ENU) must preserve Euclidean arc distances:
  $$|\Delta d_{\text{ECEF}} - \Delta d_{\text{expected}}| < 10^{-4}\,\text{m} \quad (\text{Sub-millimeter accuracy at any Earth latitude})$$
- **Verification**: Validated against NOAA and EPSG standards to prevent WebGL single-precision jitter.

### Invariant 3: 3D Gaussian Splatting Strict Covariance Positive-Definiteness ($\Sigma \succ 0$)
- **Mathematical Law**: In analytical splatting (`scratchbox_spz.hpp`, `scratchbox_hair.hpp`), every 3D Gaussian ellipsoid covariance $\Sigma = R S S^T R^T$ must be **symmetric positive-definite**:
  $$\mathbf{v}^T \Sigma \mathbf{v} > 0 \quad \forall\, \mathbf{v} \neq \mathbf{0}$$
  $$\det(\Sigma) = (s_x s_y s_z)^2 > 0$$
  $$\text{Sylvester's Criterion}: M_1 > 0, \quad M_2 > 0, \quad M_3 = \det(\Sigma) > 0$$
- **Verification**: Eliminates flattened, inside-out, or imaginary (NaN) Gaussian ellipsoids.

### Invariant 4: Projected 2D Screen Covariance & Affine Perspective Jacobian Conditioning
- **Mathematical Law**: The 2D projected screen covariance $\Sigma' = J W \Sigma W^T J^T$ computed from viewing transformation $W$ and camera perspective projection Jacobian:
  $$J = \begin{bmatrix} \frac{f_x}{z} & 0 & -\frac{f_x x}{z^2} \\ 0 & \frac{f_y}{z} & -\frac{f_y y}{z^2} \end{bmatrix}$$
  must maintain full row rank:
  $$\det(J J^T) > 0 \quad \forall\, z > 0$$
- **Verification**: Guarantees stable anisotropic splat footprints without numerical singular blowups.

### Invariant 5: Bernstein Polynomial Free-Form Deformation (FFD) Partition of Unity
- **Mathematical Law**: In native mesh deformation (`scratchbox_shaper.hpp`), Bernstein tensor product basis functions:
  $$B_{i,n}(t) = \binom{n}{i} t^i (1-t)^{n-i}$$
  must satisfy the partition of unity identically across the entire normalized parametric volume:
  $$\sum_{i=0}^l \sum_{j=0}^m \sum_{k=0}^n B_{i,l}(u) B_{j,m}(v) B_{k,n}(w) \equiv 1.00000000 \quad \forall\, (u, v, w) \in [0, 1]^3$$
- **Verification**: Guarantees affine invariance and zero translational drift under rigid transforms.

### Invariant 6: Differential UV Parameterization & Non-Inverted Jacobian
- **Mathematical Law**: In algorithmic UV rewrapping (`scratchbox_uv_engine.hpp`), the affine Jacobian determinant of the UV parameterization:
  $$\det(J_{uv}) = \frac{\partial u}{\partial x}\frac{\partial v}{\partial y} - \frac{\partial u}{\partial y}\frac{\partial v}{\partial x} > 0$$
  must be strictly positive across every triangle, and inverse barycentric coordinates must sum identically to unity:
  $$\sum_{i=0}^2 \lambda_i \equiv 1.000000 \quad \text{with} \quad \lambda_i \ge 0$$
- **Verification**: Guarantees 0.000px texture distortion and eliminates texture flipping or backwards mirror seams.

### Invariant 7: Radiometric Energy Conservation & Topological Manifoldness
- **Mathematical Law**:
  1. **Radiometry**: Bidirectional Reflectance Distribution Functions (BRDF) and Beer-Lambert transmission must conserve energy:
     $$R(\mathbf{\omega}_o) \le 1.0 \quad \text{and} \quad 0.0 \le e^{-\tau} \le 1.0 \quad \forall\, \tau \ge 0$$
  2. **Topology**: Every closed orientable 2-manifold surface of genus $g$ must satisfy the Euler-Poincaré formula:
     $$\chi = V - E + F = 2(1 - g)$$
     and all face normals must have strictly positive area: $\|\mathbf{e}_1 \times \mathbf{e}_2\| / 2 > 10^{-7}$.
- **Verification**: Prevents non-manifold geometry, black-hole artifacts, and perpetual-energy highlights.

---

## 4. The 5-Gate Adversarial Anti-Simulation Audit

Before finalizing any plan, pull request, or architectural design, run the proposal through this 5-gate gatekeeper:

```
                         [ANTI-SIMULATION 5-GATE AUDIT]
 ┌──────────────────────────────────────┬──────────────────────────────────────┐
 │ Gate 1: Epistemic Grounding Audit    │ Gate 3: Forward vs. Inverse Audit    │
 │ Gate 2: Concrete Substance Audit     │ Gate 4: Subprocess Execution Audit   │
 ├──────────────────────────────────────┴──────────────────────────────────────┤
 │ Gate 5: Analytical & Mathematical Invariant Proof Gate                      │
 └─────────────────────────────────────────────────────────────────────────────┘
```

### Gate 1: Epistemic Grounding Audit (Are We Simulating or Executing?)
- **Probe**: Does the proposed code do actual computation (transforming bytes, computing geometry, evaluating physics), or is it an empty pipeline passing mocks around?
- **Red Flag**: Any method containing `return Promise.resolve([])`, `return null;`, or `// TODO`.

### Gate 2: Concrete Substance Audit (The Anti-Astronaut Check)
- **Probe**: Can this new interface, wrapper, or factory be deleted without losing any runtime capability?
- **Red Flag**: Classes that simply wrap another class and call through with no transformation. Interfaces with only 1 implementing class.

### Gate 3: Forward vs. Inverse Audit (Are We Discarding Known Truth?)
- **Probe**: Are we rendering synthetic 2D views or writing heuristic regexes to approximate data we already have or can compute directly?
- **Red Flag**: Running COLMAP/3DGS on rendered 3D models; running regex keyword extractors to guess user domain when the LLM's latent space can project directly into physical schemas.

### Gate 4: Subprocess Execution Audit (Did Reality Confirm It?)
- **Probe**: Did we run the compiler, linter, and unit test suite in a real subshell, and did it return exit code 0?
- **Red Flag**: Stating "Tests pass" or "Build succeeded" without showing raw CLI command execution logs and exit code 0.

### Gate 5: Analytical & Mathematical Invariant Proof Gate (Is the Math Exact?)
- **Probe**: Have the mathematical invariants (quaternion unit norm, rotation determinant $\det(R)=+1$, covariance $\Sigma \succ 0$, UV Jacobian $\det(J)>0$, energy conservation) been confirmed with machine-precision closed-form proofs?
- **Red Flag**: Using loose test tolerances (`toBeCloseTo(..., 0)`), unchecked matrix inversions, or spherical approximations masked as anisotropic covariances.

---

## 5. The "Escape Velocity" Remediation Protocols

When an agent or developer discovers they are trapped in AST, execute this immediate 5-step escape protocol:

```
 [1. Purge Mocks] ──► [2. Collapse Hierarchy] ──► [3. Compile Bare Metal] ──► [4. Verify Math Invariants] ──► [5. Validate Binary Buffer]
```

1. **Step 1: Purge the Mocks**:
   - Delete all mock test files that only assert calls on spies.
   - Replace with integration assertions that verify real binary headers, vertex buffers, or HTTP payloads.
2. **Step 2: Collapse the Hierarchy**:
   - Merge `IFooService`, `AbstractFooService`, and `DefaultFooService` into a single, concrete `FooService`.
   - Remove factory classes that instantiate only one concrete class.
3. **Step 3: Compile Bare Metal**:
   - Invoke `clang++` or `tsc` immediately via `run_command`.
   - Force compiler diagnostics to the surface; resolve every type and memory error against the live operating system.
4. **Step 4: Verify Mathematical Invariants**:
   - Run `node .agents/skills/prevent-architectural-simulation-trap/scripts/verify_3d_math_invariants.js`.
   - Ensure all 7 core mathematical invariants hold with zero analytical or numerical drift.
5. **Step 5: Validate the Binary Buffer**:
   - Check the physical file on disk: verify size (`stat`), inspect magic bytes (`xxd` or `head`), and parse structural metadata (`vertexCount >= 25,000`).

---

## 6. Automated Codebase Audit & Math Verification Tools

This skill includes two automated command-line verification tools:

### Tool 1: Static Architectural Linter
`scripts/audit_simulation_trap.js`

Scans codebase for hollow methods, banned toy primitives, closed taxonomies, and mock echo chambers:
```bash
# Audit active generative paths
node .agents/skills/prevent-architectural-simulation-trap/scripts/audit_simulation_trap.js

# Audit changed files only
node .agents/skills/prevent-architectural-simulation-trap/scripts/audit_simulation_trap.js --diff

# Run in strict mode
node .agents/skills/prevent-architectural-simulation-trap/scripts/audit_simulation_trap.js --strict
```

### Tool 2: 3D Mathematical Invariants Verifier
`scripts/verify_3d_math_invariants.js`

Executes closed-form numerical proofs across the 7 Core 3D Mathematical Invariants:
```bash
node .agents/skills/prevent-architectural-simulation-trap/scripts/verify_3d_math_invariants.js
```

---

## 7. Standard Agent Audit Response Template

When reviewing an architecture, PR, or feature implementation for AST, organize your analysis into this standardized rubric:

1. **Mechanical & Mathematical Reality Verdict**:
   - `[MECHANICALLY & MATHEMATICALLY GROUNDED]` (Verified by live subprocess execution, exit code 0, machine-precision math invariant proofs, real computation, concrete substance).
   - `[CAUTION: POTENTIAL AST / MATH DRIFT DETECTED]` (Compiles, but contains speculative abstractions, hollow methods, unverified equations, or loose tolerances).
   - `[AST VIOLATION: REJECTED]` (Contains hollow scaffolds, synthetic test claims, toy primitive fallbacks, circular inverse traps, or broken math chirality).

2. **Grounded Substance vs. Hollow Scaffold Breakdown**:
   - Identify every hollow method, single-use interface, or mock echo-chamber.

3. **Subprocess Execution Audit**:
   - Report the exact CLI command run, stdout summary, and verified exit code (`0`).

4. **3D Mathematical Invariant Proof Audit**:
   - Report verification of SO(3) chirality ($\det(R)=+1.000000$), covariance positive-definiteness ($\Sigma \succ 0$), geodesic metric error ($<0.1\text{mm}$), Bernstein partition of unity ($\equiv 1.0$), and UV Jacobian determinant.

5. **Dimensional & Complexity Verification**:
   - Report vertex counts, triangle counts, and schema parameter ranges. Verify passing of `GeometricComplexityGate`.

6. **Actionable Remediation (Escape Velocity)**:
   - Provide the exact code diff to strip the simulated abstraction and anchor the implementation in mechanical reality.

# Default Conversation, Planning & Architectural Reasoning Directive

## Rule: Mandatory Critical Thinking & 3-Competitor Benchmark

When conversing, brainstorming, reviewing, or planning features, architectures, algorithms, or pipelines in Scratchbox IDE with Antigravity, all technical responses MUST incorporate the **Critical Thinking framework** and an **Adversarial 3-Competitor Comparative Benchmark**:

---

### 1. Mandatory Structure for Technical Conversations & Plans

Every technical discussion, design proposal, or architectural response must include:

```markdown
## Executive Verdict: [SOUND | VIABLE WITH CAVEATS | FRAGILE | UNSOUND]

### 1. First-Principles Breakdown & Unstated Assumptions Exposed
- [Rigorous physical, mathematical, and information-theoretic auditing]
- [Unearthing every hidden premise or optimistic assumption]

### 2. Adversarial Stress-Test & Failure Modes
- [Where the pipeline, memory, coordinates, or algorithms break under stress]

### 3. This is how competition has solved it — 3 examples
1. **[Competitor 1 / State of the Art]** (e.g. RealityCapture / Epic Games, Cesium / Unreal Nanite, Luma AI, etc.):
   - **Mechanism**: How they architecturally solve it.
   - **Trade-off / Compromise**: Where they cut corners or impose constraints.
   - **Insight for Scratchbox**: What we must adopt or improve.
2. **[Competitor 2]**:
   - **Mechanism**:
   - **Trade-off / Compromise**:
   - **Insight for Scratchbox**:
3. **[Competitor 3]**:
   - **Mechanism**:
   - **Trade-off / Compromise**:
   - **Insight for Scratchbox**:

### 4. The Unassailable Path Forward
- [High-leverage, industry-grounded solution that combines the best architectural lessons while eliminating fragility]
```

---

### 2. The 4 Executive Verdict Grades

- `[SOUND]`: Mathematically, physically, and computationally proven with minimal risk. No hand-waving or unverified assumptions.
- `[VIABLE WITH CAVEATS]`: Architecturally viable, but requires explicit mitigations for documented failure modes (e.g., VRAM limits, occlusion gaps, coordinate transformations).
- `[FRAGILE]`: Relies on lucky assumptions, edge-case prone, breaks under slight deviations, or causes severe downstream degradation.
- `[UNSOUND / FLAWED]`: Breaks fundamental laws of information theory, physical constraints, memory limits, or API contracts. Must be rejected or redesigned from scratch.

---

- Dissect real engineering compromises rather than marketing claims.

---

### 4. Shared-Logic Affinity & Strictly Additive / Non-Destructive Invariant

- **Prioritize Closest Logic Affinity**: Always benchmark and review based on examples we share the most logic with (e.g., Nerfstudio/splatfacto for 3DGS, Cesium for 3D Tiles, RealityCapture for optical ray bundle adjustment, Three.js for WebGL instancing). Investigate:
  1. *How far can that shared logic take us?* (Explore the theoretical limits and mathematical headroom of our shared foundation).
  2. *How much have we yet to use?* (Identify underutilized native C++ kernels, dormant SIMD routines, and uncalled API capabilities already present in our codebase before creating new abstractions).
- **Strictly Additive & Non-Destructive**:
  - Any logic examined from competitors or new developments MUST be **strictly complementary or non-destructive — it MUST BE ADDITIVE**.
  - It must never break, replace, regress, or contradict existing working primitives, mathematical invariants (e.g., 1:1 metric matrix lock, 0.000 px drift, sub-millisecond compilation, or WebGL 60 FPS stability).
  - External innovations must compose synergistically on top of our existing foundation as modular, opt-in capabilities.


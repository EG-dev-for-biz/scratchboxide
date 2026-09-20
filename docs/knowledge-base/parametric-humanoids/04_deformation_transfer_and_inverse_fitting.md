# Module 04: Deformation Transfer & Inverse Fitting

## 1. Overview of Deformation Transfer

Deformation transfer solves the problem of transferring the pose, shape, and deformation of a source mesh (e.g., an arbitrary 3D scan or a motion-captured actor) onto a target Scratchbox Humanoid model with a different vertex count and topology.

This is achieved through a combination of:
1. **Geometric Surface Mapping**: Nearest-triangle projection and barycentric coordinates.
2. **Multi-Stage Optimization**: Progressively unfreezing parameters from global translation to fine facial expressions.
3. **Loss Formulations**: Edge preservation loss, translation loss, and landmark alignment loss.

---

## 2. Geometric Mapping via Barycentric Projection

Given a source mesh $S = (V_S, F_S)$ and target mesh $T = (V_T, F_T)$:
For every vertex $v_i \in V_T$, find the closest point $p_i$ lying on the surface of $S$:

$$p_i = \arg\min_{p \in \text{Surface}(S)} \| v_i - p \|_2$$

Let triangle $f = (a, b, c) \in F_S$ contain $p_i$. The point $p_i$ is uniquely expressed by barycentric coordinates $(u, v, w)$ such that:

$$p_i = u \cdot V_S[a] + v \cdot V_S[b] + w \cdot V_S[c]$$

Where:
$$u \ge 0, \quad v \ge 0, \quad w \ge 0, \quad u + v + w = 1$$

This creates a sparse deformation matrix $D \in \mathbb{R}^{|V_T| \times |V_S|}$ where each row has at most 3 non-zero entries. When the source mesh moves or deforms ($V_S \to V_S'$), the target vertices are directly transferred via:

$$V_T^{transferred} = D \cdot V_S'$$

---

## 3. Multi-Stage Optimization Strategy

Directly optimizing all joint angles, shape components, and facial expressions simultaneously causes non-convex local minima (e.g. limbs twisting $360^\circ$ inside out).

The Scratchbox fitting pipeline employs a structured **3-Stage Progressive Fit**:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        PROGRESSIVE OPTIMIZATION CASCADE                      │
├──────────────────────────────────────────────────────────────────────────────┤
│ STAGE 1: Global Alignment                                                    │
│ • Free Parameters : Global translation (γ), Global orientation (R_0), Scale  │
│ • Frozen          : Body pose (θ), Shape (β), Expressions (ψ), Hands         │
│ • Target Loss     : Root joint distance & bounding box centroid              │
├──────────────────────────────────────────────────────────────────────────────┤
│ STAGE 2: Coarse Body Topology & Major Joints                                 │
│ • Free Parameters : Major body joints (21 joints), Shape PCA (β)             │
│ • Frozen          : Finger articulation, Facial expressions (ψ)              │
│ • Target Loss     : L_edge + L_trans + L_joint_prior                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ STAGE 3: Full Articulation & Fine Mimicry                                    │
│ • Free Parameters : All canonical joints, Expressions (ψ), Hand PCA modes    │
│ • Target Loss     : L_vertex + L_edge + L_landmarks + L_expression_prior     │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Mathematical Loss Formulations

### 4.1 Edge Preservation Loss ($L_{edge}$)
Prevents local mesh shearing and maintains natural skin curvature across non-rigid deformation:

$$L_{edge}(V, \hat{V}) = \sum_{(i, j) \in \mathcal{E}} \left| \|V_i - V_j\|_2 - \|\hat{V}_i - \hat{V}_j\|_2 \right|$$

Where $\mathcal{E}$ is the set of mesh edges, $V$ is the current model mesh, and $\hat{V}$ is the ground-truth target mesh. Using the $L_1$ norm (absolute difference) rather than $L_2$ provides robustness against outliers and local stretching.

### 4.2 Translation Loss ($L_{trans}$)
Penalizes discrepancy between the center of masses or anchor points:

$$L_{trans}(V, \hat{V}) = \left\| \frac{1}{|V|} \sum_{i=1}^{|V|} V_i - \frac{1}{|\hat{V}|} \sum_{j=1}^{|\hat{V}|} \hat{V}_j \right\|_2^2$$

### 4.3 Joint Pose Prior Regularization ($L_{pose}$)
Prevents joints from bending in anatomically impossible directions (e.g. knees or elbows bending backwards):

$$L_{pose}(\vec{\theta}) = \sum_{k=1}^{K} \max\left(0, \theta_k - \theta_k^{max}\right)^2 + \max\left(0, \theta_k^{min} - \theta_k\right)^2$$

### 4.4 Facial & Morphology Prior Regularization ($L_{prior}$)
Encourages shape and facial coefficients to stay within standard deviation bounds of the population distribution:

$$L_{prior}(\vec{\beta}, \vec{\psi}) = \lambda_\beta \|\vec{\beta}\|_2^2 + \lambda_\psi \|\vec{\psi}\|_2^2$$

---

## 5. Motion Capture Retargeting (BVH, MediaPipe)

Scratchbox IDE maps external motion capture streams onto parametric skeletons:

1. **MediaPipe / Vision-Based Landmark Mapping**:
   * Uses canonical 2D/3D joint index tables.
   * Matches skeletal joint centers $J(\vec{\beta})$ to predicted 3D landmarks.
   * Solves for joint rotations $\vec{\theta}$ using analytical Two-Bone Inverse Kinematics (IK) for limbs (legs and arms) and gradient descent for the spine.

2. **Hierarchical Retargeting from BVH**:
   * BVH Euler angles are converted to quaternions, then converted to Rodrigues axis-angles $\vec{\omega} = \theta \cdot \vec{u}$ for direct input to the Forward Kinematics engine.

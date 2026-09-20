# Module 01: Scratchbox Humanoid Mathematical Foundations

## 1. Introduction & Parametric Topology

The **Scratchbox Humanoid Standard (SB-Human)** defines a continuous mapping from low-dimensional parameter vectors representing body morphology ($\vec{\beta}$), facial expression ($\vec{\psi}$), and skeletal articulation ($\vec{\theta}$) to a high-density 3D surface mesh and underlying kinematic skeleton:

$$M(\vec{\beta}, \vec{\theta}, \vec{\psi}): \mathbb{R}^{|\beta|} \times \mathbb{R}^{|\theta|} \times \mathbb{R}^{|\psi|} \to \left(\mathbb{R}^{N \times 3}, \mathbb{R}^{K \times 3}\right)$$

In the Scratchbox Humanoid Standard:
* Surface vertices: $N$ vertices (e.g. $10,475$ for high-density, or scalable LODs down to $630$).
* Triangular faces: $F$ faces ($2F \approx N$).
* Skeletal joints: $K$ canonical joints (21 major body joints in canonical hierarchy, extendable to finger articulation and head/jaw joints).
* Shape parameters: $\vec{\beta} \in \mathbb{R}^{|\beta|}$ (typically $|\beta| \in [10, 300]$, representing principal components of bodily morphology: height, muscularity, torso-to-limb ratios).
* Expression parameters: $\vec{\psi} \in \mathbb{R}^{|\psi|}$ (typically $|\psi| \in [10, 100]$, representing facial mimicry PCA modes: smiles, brow raises, jaw drops).
* Articulation / Pose parameters: $\vec{\theta} \in \mathbb{R}^{(K+1) \times 3}$ in Rodrigues' axis-angle representation.

---

## 2. Shape and Facial Expression Blend Shapes

The rest-pose mesh begins at a neutral template mesh $\bar{V} \in \mathbb{R}^{N \times 3}$. Subject-specific morphology and facial expressions are applied as linear displacements along learned or procedural orthonormal PCA basis directions:

### 2.1 Identity Shape Displacements ($\mathcal{B}_S$)
Let $\mathcal{S} \in \mathbb{R}^{N \times 3 \times |\beta|}$ be the PCA shape basis tensor. The identity shape displacement is computed as:

$$\mathcal{B}_S(\vec{\beta}; \mathcal{S}) = \sum_{l=1}^{|\beta|} \beta_l \mathcal{S}_l$$

For vertex $m \in [1, N]$ and coordinate axis $k \in \{x, y, z\}$:

$$\mathcal{B}_S(\vec{\beta})_{m, k} = \sum_{l=1}^{|\beta|} \beta_l \cdot \mathcal{S}_{m, k, l}$$

### 2.2 Expression Displacements ($\mathcal{B}_E$)
Similarly, let $\mathcal{E} \in \mathbb{R}^{N \times 3 \times |\psi|}$ be the facial expression basis tensor. The expression displacement is:

$$\mathcal{B}_E(\vec{\psi}; \mathcal{E}) = \sum_{m=1}^{|\psi|} \psi_m \mathcal{E}_m$$

### 2.3 Subject-Specific Shaped Template ($V_{shaped}$)
Combining identity morphology and facial expression gives the unposed, shaped template:

$$V_{shaped} = \bar{V} + \mathcal{B}_S(\vec{\beta}; \mathcal{S}) + \mathcal{B}_E(\vec{\psi}; \mathcal{E})$$

---

## 3. Sparse Linear Joint Regression

Unlike rigid rigs where joint centers are fixed constants, parametric humanoids require joint centers to dynamically follow the morphed morphology (e.g. taller, wider, or proportioned bodies must have corresponding skeletal pivots).

The Scratchbox Humanoid Standard calculates the 3D joint locations $J \in \mathbb{R}^{K \times 3}$ as a sparse linear regression directly from the shaped surface vertices $V_{shaped}$:

$$J(\vec{\beta}) = \mathcal{J} \cdot V_{shaped}$$

Where:
* $\mathcal{J} \in \mathbb{R}^{K \times N}$ is the sparse joint regressor matrix.
* Each row $k$ contains non-negative weights that sum to $1$ ($\sum_{i=1}^N \mathcal{J}_{k, i} = 1$), acting as a localized centroid over the anatomical anatomical region surrounding joint $k$.
* For joint $k$ and spatial dimension $c \in \{0, 1, 2\}$:

$$J_{k, c} = \sum_{i=1}^N \mathcal{J}_{k, i} \cdot V_{shaped, i, c}$$

---

## 4. Pose-Dependent Corrective Blend Shapes ($\mathcal{B}_P$)

Standard Linear Blend Skinning (LBS) suffers from volume loss, pinching, and "candy-wrapper" twisting artifacts at acute joint angles (elbows, knees, shoulders). To solve this, learned or procedural corrective displacements are applied that are linear functions of the relative joint rotations.

### 4.1 Pose Feature Vector
Let $R_k(\vec{\theta}_k) \in \mathbb{R}^{3 \times 3}$ be the rotation matrix of joint $k$. The rest-pose rotation is the identity matrix $I_3$. The pose feature vector $\vec{\phi}(\vec{\theta})$ is constructed by flattening the deviations from identity for all non-root joints ($k = 1, \dots, K$):

$$\vec{\phi}(\vec{\theta}) = \begin{bmatrix} \text{vec}(R_1 - I_3) \\ \text{vec}(R_2 - I_3) \\ \vdots \\ \text{vec}(R_K - I_3) \end{bmatrix} \in \mathbb{R}^{9K}$$

### 4.2 Corrective Displacement
Let $\mathcal{P} \in \mathbb{R}^{9K \times 3N}$ be the matrix of pose corrective bases. The pose blend shape displacement $\mathcal{B}_P(\vec{\theta}) \in \mathbb{R}^{N \times 3}$ is:

$$\mathcal{B}_P(\vec{\theta}; \mathcal{P}) = \text{reshape}_{N \times 3}\left( \vec{\phi}(\vec{\theta}) \cdot \mathcal{P} \right)$$

The fully morphed and pose-corrected base mesh $V_{posed}$ before skeletal articulation is:

$$V_{posed} = V_{shaped} + \mathcal{B}_P(\vec{\theta}; \mathcal{P})$$

---

## 5. Forward Kinematics (FK)

The skeleton is organized as a directed kinematic tree defined by a parent mapping array $p \in \mathbb{Z}^K$, where $p(k)$ is the parent index of joint $k$, and the root joint has $p(0) = -1$.

### 5.1 Rodrigues' Rotation Formula
Each joint rotation is parameterized by an axis-angle vector $\vec{\omega}_k \in \mathbb{R}^3$. The angle of rotation is $\phi_k = \|\vec{\omega}_k\|_2$, and the unit rotation axis is $\vec{u}_k = \vec{\omega}_k / \phi_k$. 

The skew-symmetric matrix $K(\vec{u}_k)$ is:

$$K(\vec{u}) = \begin{bmatrix} 0 & -u_z & u_y \\ u_z & 0 & -u_x \\ -u_y & u_x & 0 \end{bmatrix}$$

Using Rodrigues' formula:

$$R(\vec{\omega}_k) = I_3 + \sin(\phi_k) K(\vec{u}_k) + (1 - \cos(\phi_k)) K(\vec{u}_k)^2$$

For numerical stability when $\phi_k \to 0$, Taylor series expansion is used:

$$R(\vec{\omega}_k) \approx I_3 + K(\vec{\omega}_k) + \frac{1}{2} K(\vec{\omega}_k)^2$$

### 5.2 Recursive World Transformation Chain
The 3D rest position of joint $k$ is $j_k \in \mathbb{R}^3$. The relative translation of joint $k$ from its parent in the rest pose is:

$$\Delta j_k = j_k - j_{p(k)}$$

The local homogeneous transformation matrix $T_k \in \mathbb{SE}(3)$ is:

$$T_k = \begin{bmatrix} R_k & \Delta j_k \\ \mathbf{0}^T & 1 \end{bmatrix}$$

For the root joint ($k = 0$), $T_0 = \begin{bmatrix} R_0 & j_0 \\ \mathbf{0}^T & 1 \end{bmatrix}$.

The world-space transformation $A_k \in \mathbb{SE}(3)$ is recursively accumulated along the kinematic branch:

$$A_0 = T_0$$
$$A_k = A_{p(k)} \cdot T_k \quad (\forall k > 0)$$

The posed world position of joint $k$ is given directly by the translation column:

$$J_{posed, k} = A_k \begin{bmatrix} \mathbf{0} \\ 1 \end{bmatrix} = A_k[0:3, 3]$$

### 5.3 Skinning Transform Offset Matrix ($G_k$)
Linear Blend Skinning requires transforming vertices that are defined relative to the rest pose. Therefore, the rest position $j_k$ of joint $k$ must be subtracted before applying $A_k$:

$$G_k = A_k \cdot \begin{bmatrix} I_3 & -j_k \\ \mathbf{0}^T & 1 \end{bmatrix} = A_k - \begin{bmatrix} \mathbf{0}_{3 \times 3} & A_k \begin{bmatrix} j_k \\ 0 \end{bmatrix} \\ \mathbf{0}^T & 0 \end{bmatrix}$$

---

## 6. Linear Blend Skinning (LBS)

Let $\mathcal{W} \in \mathbb{R}^{N \times K}$ be the blend skinning weights matrix, where $w_{i, k} \ge 0$ denotes the influence of joint $k$ on vertex $i$, satisfying the partition of unity:

$$\sum_{k=1}^K w_{i, k} = 1 \quad (\forall i \in [1, N])$$

For each vertex $i \in [1, N]$, the compound transformation matrix $M_i \in \mathbb{R}^{4 \times 4}$ is formed by the convex combination of all joint transforms:

$$M_i = \sum_{k=1}^K w_{i, k} G_k$$

Let $\tilde{v}_{posed, i} = \begin{bmatrix} V_{posed, i} \\ 1 \end{bmatrix} \in \mathbb{R}^4$ be the homogeneous rest coordinate. The final deformed surface coordinate $V_{final, i} \in \mathbb{R}^3$ is:

$$\begin{bmatrix} V_{final, i} \\ 1 \end{bmatrix} = M_i \cdot \tilde{v}_{posed, i} = \sum_{k=1}^K w_{i, k} G_k \begin{bmatrix} V_{posed, i} \\ 1 \end{bmatrix}$$

Global translation $\vec{\gamma} \in \mathbb{R}^3$ is applied to position the human in the world coordinate frame:

$$V_{world, i} = V_{final, i} + \vec{\gamma}$$

---

## 7. Dynamic Facial Contour Landmarks

In 3D human head tracking and facial alignment, landmark positions along the silhouette of the jawline change dynamically depending on the head orientation relative to the camera or neck. Fixed vertex indices for the jaw contour produce projection errors when the head turns.

The Scratchbox Humanoid Standard implements **Dynamic Facial Contour Landmarks**:
1. Compute the relative neck-head rotation around the vertical $Y$-axis: $\alpha_{neck} \in [-\theta_{max}, \theta_{max}]$.
2. Map $\alpha_{neck}$ to a discrete index in an angle-driven Look-Up Table (LUT).
3. The LUT yields:
   * The active triangle index $f_{dyn} \in [1, F]$ corresponding to the projected silhouette edge.
   * The barycentric coordinate weights $\left(u, v, w\right)$ within that triangle ($u + v + w = 1$).
4. The dynamic landmark position $P_{lmk} \in \mathbb{R}^3$ is computed via barycentric interpolation:

$$P_{lmk} = u \cdot V_{final, f_{dyn}^0} + v \cdot V_{final, f_{dyn}^1} + w \cdot V_{final, f_{dyn}^2}$$

---

## 8. Hand Articulation & Dimensionality Reduction

Each hand possesses multiple articulated joints (up to 15 joints or 45 rotational degrees of freedom). Directly manipulating all individual angles can produce unnatural postures.

The standard supports:
1. **Full Articulation**: Direct axis-angle inputs for all distal joints.
2. **Subspace Compression**: Hand pose is projected onto principal gesture components ($M_{hand} \in [6, 12]$):

$$\vec{\theta}_{hand} = \sum_{c=1}^{M_{hand}} \lambda_c \vec{C}_c + \vec{\mu}_{hand}$$

Where $\vec{C}_c$ are canonical gesture eigenvectors (fist, point, spread, relax), $\lambda_c$ are activation coefficients, and $\vec{\mu}_{hand}$ is the rest posture.

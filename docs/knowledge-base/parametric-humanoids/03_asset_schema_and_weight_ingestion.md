# Module 03: Scratchbox Humanoid Asset Specification (.sbhuman)

## 1. Zero-Dependency Native Architecture

The **Scratchbox Humanoid Standard (SB-Human)** establishes an open, self-contained binary asset specification (`.sbhuman`) for high-fidelity parametric humanoids.

Scratchbox IDE models are completely decoupled from external research codebases, deep learning frameworks, or proprietary Python runtimes. The `.sbhuman` container stores all data needed for:
* Template rest-mesh geometry and topology.
* Canonical kinematic skeleton hierarchy.
* Sparse linear joint regression weights.
* Linear Blend Skinning (LBS) influence weights (4 bones per vertex).
* Orthonormal PCA morph tensors (morphological shape modes $\mathcal{B}_S$ and facial expression modes $\mathcal{B}_E$).
* Pose-dependent corrective displacements $\mathcal{B}_P$.

---

## 2. The `.sbhuman` Binary Format Specification

The `.sbhuman` (Scratchbox Human Binary) file format is a high-speed, memory-mapped binary container designed for instantaneous loading in C++20 with zero parsing overhead.

### 2.1 File Header (32 bytes)
```
Offset  Type      Field             Description
0x00    uint32_t  magic             0x4E4D4853 ("SBHM" little-endian)
0x04    uint32_t  version           Format version (currently 1)
0x08    uint32_t  numVertices       Vertex count N (e.g. 630 for synthetic LOD, up to 10475+)
0x0C    uint32_t  numIndices        Triangle index count (3 * numFaces)
0x10    uint32_t  numJoints         Skeleton joint count K (canonical 21 joints)
0x14    uint32_t  numShapeModes     Number of shape PCA basis modes |β| (e.g. 10 to 300)
0x18    uint32_t  numExprModes      Number of facial expression modes |ψ| (e.g. 10 to 100)
0x1C    uint32_t  numPoseCorrectives Number of pose corrective directions
```

### 2.2 Binary Payload Blocks (Sequential Order)
1. **Base Mesh Vertices**: $N \times 3 \times \text{float32}$ ($12N$ bytes, IEEE-754 little-endian).
2. **Triangle Indices**: $\text{numIndices} \times \text{uint32}$ ($4 \times \text{numIndices}$ bytes).
3. **Skeletal Hierarchy**:
   * `parents`: $K \times \text{int32}$ ($4K$ bytes, `-1` for root).
   * `restPositions`: $K \times 3 \times \text{float32}$ ($12K$ bytes).
4. **Skinning Weights (LBS)**:
   * `joints`: $N \times 4 \times \text{uint16}$ ($8N$ bytes, 4 joint indices per vertex).
   * `weights`: $N \times 4 \times \text{float32}$ ($16N$ bytes, 4 normalized weights summing to 1.0).
5. **PCA Shape Modes ($\mathcal{B}_S$)**:
   * `shapeDirs`: $\text{numShapeModes} \times N \times 3 \times \text{float32}$.
6. **Expression Modes ($\mathcal{B}_E$)**:
   * `exprDirs`: $\text{numExprModes} \times N \times 3 \times \text{float32}$.

---

## 3. Native C++20 Implementation (`scratchbox_parametric_human.hpp`)

The native engine provides complete serialization and deserialization via [`scratchbox_parametric_human.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_parametric_human.hpp):

```cpp
#include "scratchbox_parametric_human.hpp"

// Load native .sbhuman asset
auto model = scratchbox::parametric::SbHumanModel::loadFromFile("hero_model.sbhuman");

// Evaluate parametric morphology (height, muscularity, limb proportions)
std::vector<float> betas = { 0.8f, -0.4f, 0.2f };
std::vector<float> expressions = { 0.5f }; // Smile
model.setShapeCoefficients(betas);
model.setExpressionCoefficients(expressions);

// Articulate pose via Rodrigues forward kinematics
model.setJointRotation(scratchbox::kinematics::StandardJoint::LeftShoulder, {0.0f, 0.0f, 0.3f});

// Evaluate deformed surface geometry
auto posedMesh = model.evaluate();

// Stream directly to the Three.js viewport
scratchbox::io::GlbWriter::streamSkinnedChunk(model.baseMesh, model.skinWeights, model.skeleton, "chunk-character");
```

---

## 4. Procedural Anatomical Generation

Scratchbox IDE does not require importing pre-scanned meshes. Using `ProceduralHumanoidBuilder`, the engine procedurally synthesizes rigged, skinned, and morphable humanoid models entirely from code:

```cpp
// Procedurally sculpt anatomical proportions
auto mesh = scratchbox::skinning::ProceduralHumanoidBuilder::buildProportionalHumanoid(
    1.82f,  // Total height in meters
    0.46f   // Shoulder breadth in meters
);

// Instantiate standard 21-joint humanoid skeleton
auto rig = scratchbox::kinematics::Skeleton::createStandardHumanoid(1.0f);

// Compute geodesic inverse-distance skinning weights
auto weights = scratchbox::skinning::ProceduralHumanoidBuilder::generateStandardWeights(mesh, rig);

// Save to standalone .sbhuman binary format
scratchbox::parametric::SbHumanModel model;
model.baseMesh = mesh;
model.skeleton = rig;
model.skinWeights = weights;
model.saveToFile("procedural_hero.sbhuman");
```

---

## 5. Open Topologies

The `.sbhuman` format natively supports and scales across diverse humanoid topologies:
1. **Scratchbox Procedural Humanoid**: Synthesized dynamically via mathematical primitives, procedural noise, and Marching Cubes isosurfaces.
2. **Standard Game Rig Topologies**: Clean quad-dominant low-poly and mid-poly game meshes (e.g., 5,000 to 15,000 triangles).
3. **High-Density Cinematic Humanoids**: Production assets with 50,000+ polygons, multi-region facial blend shapes, and 4-bone skinning.

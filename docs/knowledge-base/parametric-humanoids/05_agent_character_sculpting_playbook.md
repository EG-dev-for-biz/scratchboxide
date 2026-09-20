# Module 05: AI Agent Character Sculpting Playbook

## 1. Role of AI Agents in Scratchbox Character Generation

In Scratchbox IDE, the [`LongRunning3DGeneratorAgent`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/agent/long-running-3d-agent.ts) autonomously generates complete 3D environments, architectures, and scenes by formulating blueprints and compiling native C++20 generators (`clang++ -std=c++20 -O3`).

This playbook instructs autonomous agents on how to use [`scratchbox_kinematics.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_kinematics.hpp) and [`scratchbox_skinning.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_skinning.hpp) to procedurally synthesize, sculpt, pose, and populate parametric humanoid characters into 3D scenes.

---

## 2. Semantic Parameter Mapping

When given user prompts such as *"a cyberpunk street vendor standing under a neon sign"* or *"a victorious athlete raising arms"*, the agent maps natural language intents to numerical parameters:

### 2.1 Body Phenotype Space ($\vec{\beta}$)
* **Height / Limb Proportions** ($\beta_0$):
  * $\beta_0 \in [+1.5, +3.0]$: Tall, elongated limbs.
  * $\beta_0 \in [-3.0, -1.5]$: Petite, compact build.
* **Body Mass / Musculature** ($\beta_1$):
  * $\beta_1 \in [+1.5, +3.5]$: Heavily muscled, athletic silhouette.
  * $\beta_1 \in [-3.5, -1.5]$: Slender, lean silhouette.
* **Torso / Shoulder Width** ($\beta_2$):
  * $\beta_2 \in [+1.0, +2.5]$: Broad chest, wide shoulders.

### 2.2 Facial Expression Space ($\vec{\psi}$)
* **Smile / Joy**: $\psi_0 = 1.8, \ \psi_3 = 0.5$ (corners of mouth elevated, cheeks raised).
* **Shock / Surprise**: $\psi_1 = 2.0, \ \theta_{jaw} = 0.35\,\text{rad}$ (jaw dropped, eyes widened).
* **Determination / Focus**: $\psi_2 = 1.2, \ \psi_4 = 0.8$ (eyebrows furrowed).

### 2.3 Semantic Pose Presets ($\vec{\theta}$)
* **Neutral Standing**: Natural slight arm curve at sides, relaxed spinal curve.
* **Walking Stride**: Left hip $+0.45\,\text{rad}$, right hip $-0.45\,\text{rad}$, contralateral arm swings.
* **Celebration / Victory**: Bilateral shoulder abduction $+2.2\,\text{rad}$ (arms high in V-shape), slight spinal extension.

---

## 3. Photorealistic Skin & Material Presets

To adhere to the **Visual Progress & Verification Directive** ([`AGENTS.md`](../../../AGENTS.md)), characters must not look like unshaded plastic. Use the following PBR material configurations in `scratchbox_geometry.hpp`:

```cpp
// Human epidermis / skin approximation
inline scratchbox::geometry::PbrMaterial createSkinMaterial(const scratchbox::math::Vec4& tone) {
    scratchbox::geometry::PbrMaterial m;
    m.name = "human_epidermis";
    m.baseColorFactor = tone; // e.g. Vec4(0.85f, 0.65f, 0.52f, 1.0f)
    m.metallicFactor = 0.02f; // Dielectric
    m.roughnessFactor = 0.42f; // Soft skin sheen
    m.clearcoatFactor = 0.15f; // Slight natural moisture
    m.clearcoatRoughness = 0.10f;
    return m;
}

// Cybernetic / Sci-Fi plating
inline scratchbox::geometry::PbrMaterial createCyberArmorMaterial() {
    scratchbox::geometry::PbrMaterial m;
    m.name = "cybernetic_plating";
    m.baseColorFactor = scratchbox::math::Vec4(0.12f, 0.14f, 0.18f, 1.0f);
    m.metallicFactor = 0.90f;
    m.roughnessFactor = 0.22f;
    return m;
}
```

---

## 4. Agent C++20 Generator Template

When generating a character within a scene, the agent writes generator code matching this template:

```cpp
#include "scratchbox_engine.hpp"
#include <iostream>

int main() {
    using namespace scratchbox;

    // 1. Initialize Skeleton & Kinematics
    kinematics::Skeleton humanRig = kinematics::Skeleton::createStandardHumanoid();

    // 2. Apply Pose (e.g., Victorious pose)
    // Left shoulder abduction
    humanRig.setJointRotation(kinematics::StandardJoint::LeftShoulder, math::Vec3(0.0f, 0.0f, 1.9f));
    // Right shoulder abduction
    humanRig.setJointRotation(kinematics::StandardJoint::RightShoulder, math::Vec3(0.0f, 0.0f, -1.9f));
    // Left elbow flexion
    humanRig.setJointRotation(kinematics::StandardJoint::LeftElbow, math::Vec3(0.0f, 0.8f, 0.0f));
    // Right elbow flexion
    humanRig.setJointRotation(kinematics::StandardJoint::RightElbow, math::Vec3(0.0f, -0.8f, 0.0f));

    // 3. Evaluate Forward Kinematics
    humanRig.updateTransforms();

    // 4. Generate or Load Base Humanoid Mesh
    geometry::ScratchboxMesh baseMesh = skinning::ProceduralHumanoidBuilder::buildProportionalHumanoid(
        1.80f, // 1.80m height
        0.45f  // shoulder width
    );
    baseMesh.material = skinning::ProceduralHumanoidBuilder::defaultSkinMaterial();

    // 5. Apply Linear Blend Skinning
    auto skinWeights = skinning::ProceduralHumanoidBuilder::generateStandardWeights(baseMesh, humanRig);
    geometry::ScratchboxMesh posedMesh = skinning::LinearBlendSkinning::deform(
        baseMesh,
        skinWeights,
        humanRig.getSkinningMatrices()
    );

    // 6. Stream binary glTF 2.0 chunk
    io::GlbWriter::streamChunk(posedMesh, "hero_character_posed");
    return 0;
}
```

---

## 5. Composition into Environments

Autonomous agents should combine characters with terrain and structures:
1. Regress base ground height at target coordinate $(X, Z)$ using `scratchbox::nature::TerrainGenerator::sampleHeight(x, z)`.
2. Offset character root joint $\vec{\gamma}$ by $(X, \text{groundHeight}, Z)$ to ensure character feet touch the floor without clipping or floating.
3. Compute normal of terrain at contact point to align the pelvis / ankle pitch angles with sloping terrain.

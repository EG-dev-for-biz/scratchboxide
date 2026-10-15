---
name: dynamic-4dgs-performer
description: >-
  Direct, animate, retarget, and export dynamic 4D Gaussian Splatting humanoid avatars using the native
  Scratchbox C++20 4DGS engine (scratchbox_4dgs_humanoid.hpp, Dynamic4DGaussianSplatService,
  HumanoidMotionBridgeService, and avatar_4dgs_* agent tools). Enforces 22-joint SB-Human canonical kinematic
  skeletons, 4-influence partition-of-unity Linear Blend Skinning (LBS), ground-contact IK altitude clamping,
  and SPZ/PLY/.splat streaming.
---

# Dynamic 4D Gaussian Splatting (4DGS) Performer Skill

The **Dynamic 4DGS Performer Skill** empowers AI agents to orchestrate, animate, retarget, and export dynamic 4D Gaussian Splatting humanoid avatars in real-time using Scratchbox IDE's native C++20 4DGS engine and the `avatar_4dgs_*` tool suite.

---

## 1. System Architecture & Mathematical Foundations

Unlike static 3D Gaussian Splats, a **4D Gaussian Performer** represents a deformable humanoid volume parameterized over continuous time:

```
[MediaPipe 33-Joint Pose Video Track / BVH / SMPL Motion]
                           │
                           ▼
             [HumanoidMotionBridgeService]
       (Retarget to 22-Joint SB-Human Skeleton)
                           │
                           ▼
          [Ground-Contact IK Altitude Clamping]
   (Pin lowest foot to ground datum; zero floor clipping)
                           │
                           ▼
            [scratchbox_4dgs_humanoid.hpp]
      (C++20 SIMD Linear Blend Skinning Kernel)
    ┌──────────────────────┴──────────────────────┐
    ▼                                             ▼
[Position Deformation]                   [Covariance Rotation]
x_i(t) = Σ w_{i,k} (R_k(t) x_i + T_k)   q_i(t) = q_bone(t) ⊗ q_i
    └──────────────────────┬──────────────────────┘
                           │
                           ▼
       [32-Byte Binary .splat / Niantic .spz / PLY]
                           │
                           ▼
       [Mounted to WebGL Viewport / Video Timeline]
```

### Mathematical Invariants
1. **Partition-of-Unity Skinning**:
   Each Gaussian $i$ binds to up to 4 influencing skeletal bones with normalized weights:
   $$\sum_{k=1}^4 w_{i,k} = 1.0, \quad w_{i,k} \ge 0$$
2. **Dual Quaternion & Linear Blend Deformation**:
   Position is evaluated via affine bone matrices $(\mathbf{R}_k(t), \mathbf{T}_k(t))$:
   $$\mathbf{x}_i(t) = \sum_{k=1}^4 w_{i,k} \left(\mathbf{R}_{j_{i,k}}(t) \mathbf{x}_i^{(0)} + \mathbf{T}_{j_{i,k}}(t)\right)$$
3. **Orientation Conjugation**:
   The 3D covariance orientation quaternion $\mathbf{q}_i^{(0)}$ rotates with the dominant skinning transform:
   $$\mathbf{q}_i(t) = \mathbf{q}_{\text{skin}}(t) \otimes \mathbf{q}_i^{(0)}$$
4. **Ground Datum Clamping**:
   To prevent unnatural foot penetration into terrain or stage floors, the vertical translation $Y_{\text{root}}$ is dynamically clamped:
   $$Y_{\text{clamped}} = Y_{\text{root}} + \max\left(0, h_{\text{ground}} - \min_{f \in \{\text{feet}\}} Y_f(t)\right)$$

---

## 2. In-App Gemini Agent Tools (`avatar_4dgs_*`)

Agents invoke these four dedicated tools via Gemini function calling:

### 1. `avatar_4dgs_list`
Discovers all available 4DGS performer avatars in the local catalog:
```json
{
  "name": "avatar_4dgs_list",
  "args": {}
}
```
*Returns avatar identifiers, splat counts (e.g. 35,000 Gaussians), frame counts, framerates, and availability of skeletal motion tracks.*

### 2. `avatar_4dgs_get`
Retrieves detailed avatar metadata, morphology ratios, 22-joint skeletal hierarchy, and geospatial placement info:
```json
{
  "name": "avatar_4dgs_get",
  "args": {
    "avatarId": "2785536"
  }
}
```

### 3. `avatar_4dgs_animate`
Deforms the avatar's 4D Gaussian cloud to an exact frame index, optionally returning the serialized 32-byte `.splat` binary:
```json
{
  "name": "avatar_4dgs_animate",
  "args": {
    "avatarId": "2785536",
    "frameIndex": 42,
    "exportSplat": true
  }
}
```

### 4. `avatar_4dgs_retarget`
Retargets a recorded motion track onto the avatar with ground-contact altitude clamping. The track is the JSON that
`vfx_mediapipe_track_video_motion` writes to its `outputJsonPath` (per-frame MediaPipe world landmarks or joint angles);
the call fails without one, refuses a dry-run track, and writes the retargeted avatar motion to `outputMotionPath`:
```json
{
  "name": "avatar_4dgs_retarget",
  "args": {
    "avatarId": "2785536",
    "motionTrackPath": "output/tracks/dancer_take3.json",
    "groundAltitudeMeters": 14.5,
    "pinFeetToGround": true,
    "smoothingWindow": 3
  }
}
```

---

## 3. The 22-Joint SB-Human Canonical Skeleton

The native engine enforces standard 22-joint SB-Human kinematic topology:

```
[0: Pelvis (Root)]
 ├── [1: Spine1] ── [2: Spine2] ── [3: Spine3] ── [4: Neck] ── [5: Head]
 ├── [6: Left_Collar]  ── [7: Left_Shoulder]  ── [8: Left_Elbow]  ── [9: Left_Wrist]
 ├── [10: Right_Collar] ── [11: Right_Shoulder] ── [12: Right_Elbow] ── [13: Right_Wrist]
 ├── [14: Left_Hip]    ── [15: Left_Knee]     ── [16: Left_Ankle]  ── [17: Left_Toe]
 └── [18: Right_Hip]   ── [19: Right_Knee]    ── [20: Right_Ankle] ── [21: Right_Toe]
```

---

## 4. TypeScript Codebase Integration

```typescript
import {
  Dynamic4DGaussianSplatService,
  HumanoidMotionBridgeService,
  VideoTo4DPerformerPipelineService
} from '@scratchbox/core/node';

// 1. Initialize services
const splatService = new Dynamic4DGaussianSplatService();
const bridgeService = new HumanoidMotionBridgeService();

// 2. Load avatar & canonical Gaussians
const { gaussians, motion, details } = splatService.loadAvatar('2785536');

// 3. Retarget motion from video or tracking data
const retargetedFrames = bridgeService.retargetToSbHuman(videoMotionTrack, {
  groundAltitudeMeters: 0.0,
  pinFeetToGround: true
});

// 4. Deform Gaussian splats via native C++20 engine
const deformedSplats = splatService.deformAtFrame(gaussians, retargetedFrames[15]);

// 5. Export binary .splat or Niantic .spz
const splatBuffer = splatService.serializeToSplatBuffer(deformedSplats);
await fs.writeFile('public/models/performer_f15.splat', splatBuffer);
```

---

## 5. Verification Checklist

Before presenting a 4DGS performer animation:
- [ ] **Weight Sum**: 100% of Gaussians have bone weights summing to $1.0000 \pm 0.0001$.
- [ ] **Foot Grounding**: Lowest foot contact point does not penetrate below the specified floor altitude (`pinFeetToGround: true`).
- [ ] **Temporal Coherence**: Joint rotations are smoothed with a moving average window ($\ge 3$ frames) to eliminate high-frequency tracking jitter.
- [ ] **Splat Format**: Serialized `.splat` files follow the standard 32-byte layout: Position (12B float32), Scale (12B float32), Color (4B uint8 RGBA), Rotation (4B int8 normalized quaternion).

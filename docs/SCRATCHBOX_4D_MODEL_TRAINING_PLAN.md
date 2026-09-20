# Scratchbox-4D (S4D) World Model Training & Implementation Plan
## A Geospatial 4D Occupancy Diffusion Foundation for Scratchbox IDE

---

## Executive Summary

The **Scratchbox-4D (S4D) World Model** is a proprietary, geospatial-first foundation model designed to simulate physical reality across space and time. 

Inspired by the mathematical logic of **OccSora** (4D spatiotemporal tokenization + Diffusion Transformer on trajectory prompts), S4D replaces the automotive-only limitations of academic benchmarks (the $200 \times 200 \times 16$ flat road pancake) with a **full 3D volumetric grid ($128 \times 128 \times 64$)** capable of modeling complex urban architecture, aerial drone navigation corridors, steep terrain, and dynamic physical interactions.

S4D is conditioned on **6-DOF trajectory prompts** ($x, y, z, \text{yaw}, \text{pitch}, \text{roll}, \text{velocity}$) generated directly by Scratchbox's `TemporalSimulationSolver.ts` and outputs a 4D occupancy field $V(x, y, z, t)$ that feeds directly into Scratchbox's native C++20 `MarchingCubes` engine (`scratchbox_geometry.hpp`) to stream real-time `.glb` meshes into Three.js.

---

## 1. System Architecture Specification

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        SCRATCHBOX-4D (S4D) ARCHITECTURE                                │
│                                                                                        │
│  [6-DOF Trajectory] (TemporalSimulationSolver.ts)                                      │
│  [x, y, z, yaw, pitch, roll, speed]                                                    │
│         │                                                                              │
│         ▼                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ STAGE 2: S4D-DiT (Diffusion Transformer Backbone)                                │  │
│  │ - Flow Matching / DDIM Diffusion on Latent Tokens                                 │  │
│  │ - AdaLN-Zero Trajectory & Timestep Conditioning                                  │  │
│  │ - 3D/Spatiotemporal Rotary Position Embeddings (RoPE)                             │  │
│  └──────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                         │ Latent Tokens Z ∈ R^(8 × 32 × 32 × 16 × 16)  │
│                                         ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ STAGE 1: S4D-Tokenizer (3D/4D Spatiotemporal VAE)                                │  │
│  │ - Decodes latent tokens back to volumetric semantic occupancy                    │  │
│  │ - 4x Spatial Upsampling, 2x Temporal Upsampling                                  │  │
│  └──────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                         │ 4D Semantic Voxel Grid: 16 × 128 × 128 × 64   │
│                                         ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ RUNTIME: Native C++20 Marching Cubes Engine (scratchbox_geometry.hpp)            │  │
│  │ - Isosurface polygonization in <50ms                                             │  │
│  │ - Procedural PBR material assignment from semantic class IDs                     │  │
│  └──────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                         │ Binary glTF 2.0 (.glb) Mesh Stream           │
│                                         ▼                                              │
│  [Three.js Canvas Viewport] <── Synced with TimeDimension4D Playhead (60 FPS)          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Voxel Grid & Coordinate Framing

* **Coordinate System:** East-North-Up (ENU) Cartesian meters, anchored to WGS-84 GPS coordinates via `LocalTangentPlane.ts`.
* **Grid Spatial Dimensions:** $128 \times 128 \times 64$ voxels.
* **Spatial Extents:**
  * Horizontal ($X, Y$): $[-64\text{m}, +64\text{m}]$ ($128\text{m}$ bounding diameter).
  * Vertical ($Z$): $[-16\text{m}, +48\text{m}]$ ($64\text{m}$ vertical range, accommodating underground/terrain dips and 15-story structures/airspace).
* **Voxel Resolution:** $1.0\text{m} \times 1.0\text{m} \times 1.0\text{m}$ base (or $0.5\text{m}$ fine-grain mode).
* **Temporal Sequence:** $T = 16$ time steps per sequence (spanning $4.0$ to $8.0$ seconds at $2\text{Hz}-4\text{Hz}$).

### 1.2 Semantic Vocabulary (10 Geospatial & Architectural Classes)

| Class ID | Semantic Label | Description & Physics Behavior |
| :---: | :--- | :--- |
| `0` | `Airspace / Free Space` | Navigable vacuum; zero collision bounds. |
| `1` | `Ground / Terrain` | Static topographic bedrock, asphalt, soil; solid collision. |
| `2` | `Water / Marine` | Oceans, bays, rivers; hydrodynamic fluid resistance. |
| `3` | `Building Exterior / Facade` | Structural masonry, concrete, curtain-wall glass. |
| `4` | `Building Interior / Floor / Wall` | Occupiable structural slabs, partitions, rooms. |
| `5` | `Vegetation / Canopy` | Trees, foliage, parks; semi-permeable wind drag. |
| `6` | `Transit Corridor / Road` | Marked streets, highways, train lines, runways. |
| `7` | `Dynamic Air Agent` | Drones, eVTOLs, helicopters, birds. |
| `8` | `Dynamic Ground Agent` | Vehicles, autonomous rovers, pedestrians. |
| `9` | `Construction / Hazard` | Scaffolding, barriers, dynamic obstacles. |

---

## 2. Model Architecture Details

### Stage 1: S4D-Tokenizer (3D/4D Spatiotemporal VAE)

* **Function:** Compresses dense 4D voxel occupancy tensors into continuous, lower-dimensional latent embeddings without spatial aliasing.
* **Architecture:**
  * **Encoder:** 3D residual convolutional network with causal temporal convolutions.
    * Spatial compression: $4\times$ downsampling ($128 \times 128 \times 64 \rightarrow 32 \times 32 \times 16$).
    * Temporal compression: $2\times$ downsampling ($16 \rightarrow 8$ time steps).
  * **Latent Space:** Continuous Gaussian latent $Z \in \mathbb{R}^{B \times C_{\text{latent}} \times T' \times X' \times Y' \times Z'}$ with $C_{\text{latent}} = 16$ channels, regularized by a small KL-divergence loss ($\beta = 10^{-4}$).
  * **Decoder:** Mirrored 3D transpose residual convolutions with softmax over the 10 semantic classes.
* **Loss Function:**
  $$\mathcal{L}_{\text{tokenizer}} = \mathcal{L}_{\text{CrossEntropy}}(V, \hat{V}) + \lambda_{\text{focal}} \mathcal{L}_{\text{Focal}}(V, \hat{V}) + \beta \mathcal{L}_{\text{KL}}$$
  *(Focal loss is critical to counter the class imbalance of empty airspace vs. thin walls).*

### Stage 2: S4D-DiT (Diffusion Transformer Backbone)

* **Function:** Models the prior over the latent 4D token sequence conditioned on user/agent 6-DOF trajectory paths.
* **Architecture Variant:** `DiT-Base` ($\sim 130\text{M}$ parameters) or `DiT-Large` ($\sim 380\text{M}$ parameters).
  * Hidden dimension: $d = 768$ (Base) or $1024$ (Large).
  * Depth: $16$ (Base) or $24$ (Large) transformer layers.
  * Attention: Multi-Head Self-Attention with **FlashAttention-2** and 3D spatiotemporal Rotary Position Embeddings (RoPE).
* **Conditioning Mechanism (AdaLN-Zero):**
  * Trajectory prompt: 6-DOF sequence $P = \{ (x_t, y_t, z_t, \psi_t, \theta_t, \phi_t, v_t) \}_{t=1}^{T}$.
  * Trajectory embedder: 1D temporal convolution + sinusoidal frequency projection.
  * Injected into each transformer block via scale, shift, and gate modulations:
    $$\text{AdaLN}(h) = \gamma(c) \odot \text{LayerNorm}(h) + \beta(c)$$
* **Sampling Schedule:** Flow Matching or DPM-Solver++ (20 sampling steps for fast inference).

---

## 3. The Synthetic 4D Data Engine (Scratchbox-Powered)

Rather than waiting for expensive real-world LiDAR driving logs, Scratchbox synthesizes ground-truth 4D occupancy data directly from photogrammetric geospatial assets:

```
┌────────────────────────────────────────────────────────────────────────┐
│                  SYNTHETIC 4D DATA GENERATION PIPELINE                 │
│                                                                        │
│  [Google 3D Tiles] (Google3DTileCrawlerBaker.ts)                       │
│  Extract high-fidelity geometry for 20 global metropolitan areas       │
│                            │                                           │
│                            ▼                                           │
│  [Kinematic Path Synthesizer] (TemporalSimulationSolver.ts)            │
│  Generate Catmull-Rom 6-DOF spline trajectories (drones, vehicles)    │
│                            │                                           │
│                            ▼                                           │
│  [C++ Fast Voxelizer Worker] (scratchbox_geometry.hpp)                 │
│  Rasterize 3D meshes into 128 × 128 × 64 voxel lattices               │
│                            │                                           │
│                            ▼                                           │
│  [Dynamic Agent Injection]                                             │
│  Inject moving vehicle/drone voxel bounding volumes along path         │
│                            │                                           │
│                            ▼                                           │
│  Dataset: 50,000 Synthetic 4D Sequences (.h5 / .zarr)                  │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Geographic Diversity (20 Metropolises):**
   * San Francisco (coastal hills, dense downtown).
   * Manhattan (dense skyscraper canyons).
   * Tokyo, London, Paris, Hong Kong, Dubai, Sydney, etc.
2. **Trajectory Generation:**
   * Ground paths: Follow road street networks with elevation gradients.
   * Air corridors: Inspection orbits around building facades, fly-throughs beneath bridges, rooftop landings.
3. **Target Dataset:** 50,000 unique 4D sequences ($\sim 250\text{ GB}$ compressed using sparse Run-Length Encoding / Zarr).

---

## 4. Hardware Requirements & Training Budget

| Training Phase | Hardware Infrastructure | Duration | Est. Cloud Cost |
| :--- | :--- | :--- | :--- |
| **Data Generation (Voxelization)** | Local CPU/GPU Worker (Apple M-series or 1x RTX 4090) | 24 Hours | **\$0** (Local) |
| **Stage 1: S4D-Tokenizer (3D VAE)** | 1 × NVIDIA A100 (80GB) or 1 × H100 PCIe | 24 Hours | **\$35 – \$50** |
| **Stage 2: S4D-DiT Backbone** | 4 × NVIDIA A100 (80GB) or 2 × H100 SXM | 48 Hours | **\$250 – \$400** |
| **Distillation / LCM (Fast Inference)** | 1 × NVIDIA A100 (80GB) | 12 Hours | **\$20 – \$30** |
| **TOTAL** | — | — | **$\le \$500$** |

---

## 5. Phased Implementation Roadmap

### Phase 1: Synthetic Data Pipeline & Voxelizer (Weeks 1–2)
- [ ] Create `packages/occsora-engine/tools/voxelizer.cpp` leveraging `scratchbox_geometry.hpp` to rasterize glTF tiles into $128 \times 128 \times 64$ voxel grids.
- [ ] Implement synthetic trajectory generator in `packages/core/src/node/spatial/SyntheticTrajectoryGenerator.ts` using Catmull-Rom splines.
- [ ] Generate initial pilot dataset: 5,000 sequences of SF Financial District and Manhattan.

### Phase 2: S4D-Tokenizer Training (Week 3)
- [ ] Implement `packages/occsora-engine/models/tokenizer_3d.py` (3D ResNet VAE with causal temporal downsampling).
- [ ] Train on 1x A100 GPU for 100,000 steps with Focal + Cross-Entropy loss.
- [ ] Validate reconstruction quality (IoU > 0.85 on architectural facades and terrain).

### Phase 3: S4D-DiT Diffusion Training (Weeks 4–5)
- [ ] Implement `packages/occsora-engine/models/dit_4d.py` with 6-DOF AdaLN trajectory embedder and FlashAttention-2.
- [ ] Train on 4x A100 GPUs using distributed `torchrun` with Flow Matching loss.
- [ ] Evaluate long-horizon temporal consistency over 16 time steps.

### Phase 4: Scratchbox C++ Runtime Integration (Week 6)
- [ ] Implement `OccSoraBridge.ts` in `packages/core/src/node/spatial/` to serialize `TemporalSimulationSolver` telemetry into inference payloads.
- [ ] Connect the output voxel tensor directly to `MarchingCubes::extractIsosurface` in `scratchbox_geometry.hpp`.
- [ ] Stream `.glb` meshes directly into Three.js canvas under the `TimeDimension4D` timeline.

### Phase 5: Verification & Turnkey Packaging (Week 7)
- [ ] Benchmark real-time performance: Verify inference + meshing < 1.5 seconds.
- [ ] Capture automated verification screenshots via Chrome DevTools MCP.
- [ ] Export quantized ONNX/CoreML models for offline local execution in the Electron desktop app.

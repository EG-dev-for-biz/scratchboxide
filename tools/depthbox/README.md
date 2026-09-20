# DepthBox: Depth Anything 3-Based Depth-Ray Foundation Model

**DepthBox** is a high-performance urban and geospatial geometry foundation model based on the unified architecture of **Depth Anything 3 (DA3)**. It replaces decoupled depth and camera calibration pipelines with a unified **Depth-Ray** formulation.

## Core Architecture

1. **Backbone**: DINOv2 (`dinov2_vitb14_reg`) with 4 register tokens, extracting multi-scale feature hierarchies at layers 3, 6, 9, 12.
2. **Cross-View Attention**: Dynamic token rearrangement allowing seamless scalability from 1 monocular view to $N$ multi-camera views across flight trajectories.
3. **Dual-DPT Head**: Twin progressive fusion decoders:
   - **Exponential Depth**: $d(u, v) = \exp(\hat{y}(u, v)) \in [0.1\text{m}, 500\text{m}]$
   - **Ray Field**: Unit direction vectors $\hat{\mathbf{r}}(u, v) \in \mathbb{S}^2$ encoding camera intrinsics and extrinsics.
4. **Direct 3D Unprojection**:
   $$\mathbf{P}(u, v) = d(u, v) \cdot \hat{\mathbf{r}}(u, v)$$
   Unprojects directly to 3D point clouds and meshes without requiring camera focal length calibration.

## Training Pipeline

### Local Testing & Verification
```bash
# Verify model math & shapes (no external dependencies needed)
python3 tools/depthbox/tests/test_depthbox_math.py

# Quick 2-batch PyTorch smoke test
python3 tools/depthbox/train_vertex.py --dry-run
```

### Google Cloud Vertex AI Distributed Training
Submit distributed jobs across 8x NVIDIA A100 (80GB SXM) or Cloud TPU v5e:
```bash
# Dry run verification of job spec
node tools/depthbox/launch_vertex_job.cjs --dry-run

# Launch production job on 8x A100 (80GB SXM)
node tools/depthbox/launch_vertex_job.cjs

# Launch on Cloud TPU v5e
node tools/depthbox/launch_vertex_job.cjs --tpu

# Launch on single NVIDIA L4 (24GB)
node tools/depthbox/launch_vertex_job.cjs --l4
```

### ONNX Export for Scratchbox IDE
```bash
python3 tools/depthbox/deploy/export_onnx.py --checkpoint build/depthbox_checkpoints/depthbox_final.pt --output public/models/depthbox_vitb14.onnx
```

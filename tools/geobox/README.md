# GeoBox: Next-Generation Global Continuous Image Geolocation

GeoBox is a state-of-the-art continuous geospatial image localization engine designed to exceed GeoCLIP in accuracy, spatial resolution, and inference speed.

## Key Architectural Advantages Over GeoCLIP

| Feature | GeoCLIP (Standard) | GeoBox (Scratchbox) |
| :--- | :--- | :--- |
| **Location Encoding** | 2-layer MLP + Fourier features (spectral bias) | **Multi-Resolution Spherical Hash Grid** ($\mathbb{S}^2$, 16 scales, 25m to 500km) |
| **Vision Backbone** | OpenAI CLIP ViT-L/14 (224px) | **SigLIP-2** with Attention / GeM Pooling (224px / 384px) |
| **Loss Function** | Standard Binary InfoNCE | **Soft-Geodesic Haversine Contrastive Loss** ($\sigma = 25\text{km}$) |
| **Multimodal Priors** | Image + GPS only | **Tri-Modal**: Image $\leftrightarrow$ Location $\leftrightarrow$ Geo-Semantic Text |
| **Fine-scale Precision**| Flatlines at ~25 km resolution | **Sub-kilometer Continuous Refinement** |
| **Inference Engine** | Python / PyTorch PyPI package | **Direct C++20 Zero-Copy Vector Engine** (`scratchbox_geospatial.hpp`) |

---

## Directory Structure

```
tools/geobox/
├── Dockerfile                    # Multi-stage GPU/TPU training container
├── cloudbuild-geobox.yaml        # Google Cloud Build recipe for Artifact Registry
├── requirements.txt              # PyTorch, WebDataset, Transformers, ONNX dependencies
├── launch_vertex_job.cjs         # Google Cloud Vertex AI Custom Job launcher
├── train_vertex.py               # Distributed PyTorch training script (FSDP / TPU / GPU)
├── model/
│   ├── spherical_hash_encoder.py # Multi-scale spherical hash grid on S^2 + residual MLP
│   └── geobox_module.py          # Tri-modal model wrapper + Soft Haversine loss
├── data/
│   └── webdataset_gcs_loader.py  # Zero-disk-staging streaming dataloader from GCS
├── deploy/
│   └── export_onnx.py            # ONNX exporter & 100k-point global gallery generator
├── tests/
│   └── test_spherical_math.py    # Unit tests for spherical projections and distances
└── README.md
```

---

## Google Cloud Training Quickstart

### 1. Build and Push Container to Artifact Registry
```bash
gcloud builds submit --config tools/geobox/cloudbuild-geobox.yaml
```

### 2. Launch Distributed Training on Vertex AI
* **NVIDIA A100 (80GB $\times$ 8 SXM)**:
  ```bash
  node tools/geobox/launch_vertex_job.cjs
  ```
* **Cloud TPU v5e (v5e-16 Pod Slice)**:
  ```bash
  node tools/geobox/launch_vertex_job.cjs --tpu
  ```
* **Dry-Run Mode (Verifies Payload & Credentials without launching)**:
  ```bash
  node tools/geobox/launch_vertex_job.cjs --dry-run
  ```

---

## Local Verification & Tests

Run the mathematical verification test suite:
```bash
python3 tools/geobox/tests/test_spherical_math.py
```

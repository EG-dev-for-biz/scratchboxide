# Process & Runbook Catalog

> This catalog indexes all standardized troubleshooting methodologies, architectural workarounds, and engineering procedures recorded across the Scratchbox IDE codebase.

| Date | Title | Domain | Key Problem Solved | File Link | Tags |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **2026-10-10** | Humanoid Organic Mesh & PBR Calibration Pipeline | 3D/CGI, Anatomy, PBR | Resolved thumb nail skew, interdigital web discoloration, bulbous finger undersides, and macro camera alignment using normal-aware carrier frames and empirical UV crest calibration. | [`humanoid-organic-mesh-pbr-calibration.md`](./humanoid-organic-mesh-pbr-calibration.md) | `3d-engine`, `sbhuman`, `anatomy`, `pbr`, `ada-compliance` |
| **2026-10-10** | Google 3D Tiles Fresh Ingestion & Headless CDP Visual Proof Capture Pipeline | Geospatial, Photogrammetry, Automated QA | Solved stale model anisotropic distortion by ingesting fresh leaf LOD tiles (538K verts, 252 textures), dynamically binding GPU telemetry, and capturing full 1080p proofs via proxy-isolated Chrome DevTools Protocol. | [`google_3d_tiles_fresh_ingestion_and_cdp_proof_capture.md`](./google_3d_tiles_fresh_ingestion_and_cdp_proof_capture.md) | `3d-tiles`, `google-maps`, `photogrammetry`, `cdp`, `headless-capture`, `ada-compliance` |
| **2026-10-10** | Photogrammetric Tree Resection & Full-Tile PBR Transformation | Photogrammetry, 3D Botanical, C++20 PBR, WebGL | Solved road corridor tree clipping using oriented bounding manifolds (SE(2) transforms), depressed 92.7K canopy vertices, instanced 101 botanical trees, synthesized 252 PBR textures in 1.9s via native C++ Apple ImageIO, and stripped KHR_materials_unlit. | [`photogrammetric-tree-resection-and-full-tile-transformation.md`](./photogrammetric-tree-resection-and-full-tile-transformation.md) | `photogrammetry`, `tree-resection`, `cpp20`, `pbr`, `gltf`, `ada-compliance` |
| **2026-10-10** | Section Relevance & Conceptual Exemplification Pipeline | Art Direction, Presentation Architecture, Prompt Engineering | Eliminates generic ambient stock wallpaper in presentations by extracting section thesis and generating grounded physical visual proof with negative space coordination and 1/48s shutter drag. | [`section-relevance-and-conceptual-exemplification.md`](./section-relevance-and-conceptual-exemplification.md) | `art-direction`, `presentation-decks`, `conceptual-exemplification`, `scratchbox-mcp`, `google-nano-banana` |

---

## Catalog Guidelines
- Every entry follows the standard 6-section schema defined in the `process-recorder` skill.
- All processes comply with Adaptive Domain Architecture (zero closed taxonomies, continuous physical schemas, and empirical verification).
- Automated tests and verification commands must accompany every runbook.

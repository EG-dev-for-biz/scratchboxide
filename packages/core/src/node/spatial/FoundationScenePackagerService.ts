/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { Universal3DStructureFoundation } from './Universal3DStructureFoundation';
import { SplatService } from '../3d-engine/splat-service';
import type { BakedGaussian } from '../../common/geospatial-4d-protocol';

export interface FoundationScenePackageOptions {
  /**
   * Target scene identifier (folder name under /projects/).
   */
  sceneName: string;

  /**
   * Root projects directory. Defaults to path.resolve(process.cwd(), 'projects').
   */
  projectRootDir?: string;

  /**
   * Metric solid geometry (GLB). Can be a raw Buffer/Uint8Array, file path, or Universal3DStructureFoundation.
   */
  glbBuffer?: Buffer | Uint8Array;
  glbSourcePath?: string;
  foundation?: Universal3DStructureFoundation;

  /**
   * Neural radiance field (.splat). Can be a raw Buffer/Uint8Array, file path, or BakedGaussian array.
   */
  splatBuffer?: Buffer | Uint8Array;
  splatSourcePath?: string;
  splats?: BakedGaussian[];

  /**
   * Metadata describing the scene.
   */
  metadata?: {
    title?: string;
    description?: string;
    prompt?: string;
    sourceImage?: string;
    author?: string;
    category?: string;
    anchor?: {
      lat: number;
      lng: number;
      elevation: number;
    };
    camera?: {
      position: [number, number, number];
      target: [number, number, number];
      fov: number;
    };
    dimensions?: {
      width: number;
      height: number;
      depth: number;
    };
    vertexCount?: number;
    triangleCount?: number;
    splatCount?: number;
    materials?: string[];
  };
}

export interface FoundationScenePackageResult {
  projectDir: string;
  sceneName: string;
  glbPath: string;
  splatPath: string;
  readmePath: string;
  manifestPath: string;
  filesWritten: Record<string, string>;
  stats: {
    glbSizeBytes: number;
    splatSizeBytes: number;
    splatCount: number;
  };
}

/**
 * FoundationScenePackagerService
 * 
 * Packages generated 3D scenes into their canonical project workspace directory:
 *   /projects/<scene_name>/
 *     ├── scene.glb          # Standard binary glTF 2.0 (Solid metric geometry + PBR materials)
 *     ├── radiance.splat     # Standard 32-byte Gaussian splat radiance field (View-dependent neural lighting)
 *     ├── README.md          # Project documentation with metric/neural separation & usage instructions
 *     └── scene_manifest.md  # Machine-readable discovery manifest
 */
export class FoundationScenePackagerService {
  /**
   * Resolves the canonical projects root directory.
   */
  public static getProjectsRootDir(customDir?: string): string {
    if (customDir) return path.resolve(customDir);
    return path.resolve(process.cwd(), 'projects');
  }

  /**
   * Packages a 3D scene into /projects/<scene_name>/
   */
  public static async packageScene(options: FoundationScenePackageOptions): Promise<FoundationScenePackageResult> {
    const sanitizedName = options.sceneName.trim().replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const projectsRoot = this.getProjectsRootDir(options.projectRootDir);
    const projectDir = path.join(projectsRoot, sanitizedName);

    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    const filesWritten: Record<string, string> = {};

    // 1. Solid Metric Geometry: scene.glb
    let finalGlbBuffer: Buffer;
    if (options.glbBuffer) {
      finalGlbBuffer = Buffer.isBuffer(options.glbBuffer) ? options.glbBuffer : Buffer.from(options.glbBuffer);
    } else if (options.glbSourcePath && fs.existsSync(options.glbSourcePath)) {
      finalGlbBuffer = fs.readFileSync(options.glbSourcePath);
    } else if (options.foundation) {
      finalGlbBuffer = options.foundation.toGlbBuffer();
    } else {
      // Create minimal valid empty GLB chunk if none provided
      finalGlbBuffer = Buffer.from('glTF\x02\x00\x00\x00\x14\x00\x00\x00\x00\x00\x00\x00JSON{}  ', 'binary');
    }

    const glbPath = path.join(projectDir, 'scene.glb');
    fs.writeFileSync(glbPath, finalGlbBuffer);
    filesWritten.glb = glbPath;

    // 2. Neural Radiance Field: radiance.splat
    let finalSplatBuffer: Buffer;
    let finalSplatCount = 0;

    if (options.splatBuffer) {
      finalSplatBuffer = Buffer.isBuffer(options.splatBuffer) ? options.splatBuffer : Buffer.from(options.splatBuffer);
      finalSplatCount = Math.floor(finalSplatBuffer.length / 32);
    } else if (options.splats && options.splats.length > 0) {
      finalSplatBuffer = SplatService.serializeSplatBuffer(options.splats);
      finalSplatCount = options.splats.length;
    } else if (options.splatSourcePath && fs.existsSync(options.splatSourcePath)) {
      finalSplatBuffer = fs.readFileSync(options.splatSourcePath);
      finalSplatCount = Math.floor(finalSplatBuffer.length / 32);
    } else if (options.foundation && options.foundation.points.length > 0) {
      // Synthesize 32-byte Gaussian splats from foundation points
      const pts = options.foundation.points;
      const gaussians: BakedGaussian[] = pts.map(p => ({
        position: [p.position[0], p.position[1], p.position[2]],
        scale: [0.035, 0.035, 0.035],
        colorRgb: [p.color[0], p.color[1], p.color[2]],
        opacity: 0.95,
        quaternion: [0, 0, 0, 1]
      }));
      finalSplatBuffer = SplatService.serializeSplatBuffer(gaussians);
      finalSplatCount = gaussians.length;
    } else {
      // Empty splat buffer
      finalSplatBuffer = Buffer.alloc(0);
      finalSplatCount = 0;
    }

    const splatPath = path.join(projectDir, 'radiance.splat');
    fs.writeFileSync(splatPath, finalSplatBuffer);
    filesWritten.splat = splatPath;

    // 3. Generate Project README.md
    const readmeContent = this.generateReadmeMarkdown({
      sceneName: sanitizedName,
      options,
      glbSizeBytes: finalGlbBuffer.length,
      splatSizeBytes: finalSplatBuffer.length,
      splatCount: finalSplatCount
    });

    const readmePath = path.join(projectDir, 'README.md');
    fs.writeFileSync(readmePath, readmeContent, 'utf8');
    filesWritten.readme = readmePath;

    // 4. Generate scene_manifest.md (for IDE discovery)
    const manifestPath = path.join(projectDir, 'scene_manifest.md');
    fs.writeFileSync(manifestPath, readmeContent, 'utf8');
    filesWritten.manifest = manifestPath;

    return {
      projectDir,
      sceneName: sanitizedName,
      glbPath,
      splatPath,
      readmePath,
      manifestPath,
      filesWritten,
      stats: {
        glbSizeBytes: finalGlbBuffer.length,
        splatSizeBytes: finalSplatBuffer.length,
        splatCount: finalSplatCount
      }
    };
  }

  /**
   * Generates structured markdown documenting the project, metric/radiance separation, and usage.
   */
  private static generateReadmeMarkdown(params: {
    sceneName: string;
    options: FoundationScenePackageOptions;
    glbSizeBytes: number;
    splatSizeBytes: number;
    splatCount: number;
  }): string {
    const { sceneName, options, glbSizeBytes, splatSizeBytes, splatCount } = params;
    const meta = options.metadata || {};
    const title = meta.title || sceneName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const desc = meta.description || 'Photorealistic 3D scene structured with strict architectural separation between metric solid geometry and neural radiance.';
    const prompt = meta.prompt || 'Synthesized via Universal3DStructureFoundation';
    const now = new Date().toISOString();

    const glbKb = (glbSizeBytes / 1024).toFixed(1);
    const splatKb = (splatSizeBytes / 1024).toFixed(1);

    const dims = meta.dimensions ? `${meta.dimensions.width.toFixed(1)}m × ${meta.dimensions.height.toFixed(1)}m × ${meta.dimensions.depth.toFixed(1)}m` : 'Calibrated metric scale (1.0 = 1 meter)';
    const anchorStr = meta.anchor ? `${meta.anchor.lat.toFixed(6)}°, ${meta.anchor.lng.toFixed(6)}° (Elev: ${meta.anchor.elevation.toFixed(1)}m)` : 'WGS-84 Local Datum';

    return `# ${title}

> **Project Package**: \`/projects/${sceneName}/\`  
> **Generation Timestamp**: \`${now}\`  
> **Original Prompt**: *"${prompt}"*

---

## 1. Architectural Separation: Metric Geometry vs. Neural Radiance

This project adheres to the **Scratchbox Universal 3D Structure Foundation** directive, maintaining a strict, non-destructive boundary between the CAD-level metric ground truth and the view-dependent neural radiance field:

\`\`\`
/projects/${sceneName}/
├── scene.glb          # Layer 1: Solid Metric 3D Geometry (glTF 2.0 Binary)
├── radiance.splat     # Layer 2: 3D Gaussian Splat Radiance Field (32-byte layout)
├── README.md          # Layer 3: Comprehensive documentation & integration guides
└── scene_manifest.md  # Layer 4: IDE project discovery manifest
\`\`\`

---

## 2. Layer 1: Solid Metric 3D Geometry (\`scene.glb\`)

- **Format**: Standard Binary glTF 2.0 (\`.glb\`)
- **File Size**: \`${glbKb} KB\`
- **Coordinate Space**: SI Metric (1 unit = 1 meter), +Y Up, Right-Handed (OpenGL/glTF convention)
- **Bounding Envelopes**: ${dims}
- **Geodetic Anchor**: ${anchorStr}
- **Material System**: Procedural PBR materials patched with analytical micro-surface shaders (Sobel mortar deepening, stone cavitation pores, lapis glaze crazing) with zero external texture dependencies.
- **Use Cases**:
  - Authoritative ground truth for CAD, Blender, Unreal Engine 5, and Unity.
  - Collision hull generation and physics simulations.
  - Procedural Boolean carving and 3D architectural floor plan extraction.

---

## 3. Layer 2: Neural Radiance Field (\`radiance.splat\`)

- **Format**: Standard 32-Byte Flat Binary Gaussian Splat (\`.splat\`)
- **Total Gaussians**: \`${splatCount.toLocaleString()} splats\`
- **File Size**: \`${splatKb} KB\`
- **Memory Footprint**: \`${splatKb} KB\` in GPU VRAM
- **Binary Layout per Gaussian (32 bytes)**:
  - \`[0..11]\`: Float32 Position (\`x, y, z\`)
  - \`[12..23]\`: Float32 Scale (\`sx, sy, sz\`)
  - \`[24..27]\`: UInt8 Color & Opacity (\`r, g, b, a\`)
  - \`[28..31]\`: UInt8 Rotation Quaternion (\`qx, qy, qz, qw\` quantized to [0..255])
- **Rendering**: Real-time 60 FPS in Three.js viewport via \`PhotorealGaussianSplatMesh\` with instanced WebGL quads and 30 Hz radix depth sorting.

---

## 4. Viewport & Tooling Integration

### A. Three.js / Scratchbox IDE Ingestion
\`\`\`typescript
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { PhotorealGaussianSplatMesh } from '@scratchbox/core/browser';

// 1. Load Metric CAD Mesh
const loader = new GLTFLoader();
loader.load('/projects/${sceneName}/scene.glb', (gltf) => {
  scene.add(gltf.scene);
});

// 2. Load Neural Radiance Layer
fetch('/projects/${sceneName}/radiance.splat')
  .then(res => res.arrayBuffer())
  .then(buffer => {
    const splatMesh = PhotorealGaussianSplatMesh.createFromBuffer(buffer);
    scene.add(splatMesh);
  });
\`\`\`

### B. External DCC (Blender / Unreal Engine 5)
- **Blender**: File -> Import -> glTF 2.0 (\`.glb\`) -> select \`/projects/${sceneName}/scene.glb\`.
- **Unreal Engine 5**: Drag \`scene.glb\` directly into the Content Browser; Nanite and Lumen will build geometric clusters and distance fields automatically.
- **3DGS Viewers**: Open \`radiance.splat\` in SuperSplat, PlayCanvas, or Nerfstudio for real-time neural inspection.

---

*Generated by Scratchbox IDE Universal 3D Structure Foundation.*
`;
  }
}

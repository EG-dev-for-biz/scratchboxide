/********************************************************************************
 * Packaged Scene & Gaussian Splat Integrity Test
 * Validates:
 * 1. Metric glTF 2.0 Binary mesh structure (header, chunks, JSON manifest)
 * 2. 32-Byte Gaussian Splat layout (position, scale, color, rotation quaternion)
 * 3. Structured README and scene_manifest separation
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';

interface ProjectAuditResult {
    projectName: string;
    glbPath: string;
    glbSizeKB: number;
    glbValid: boolean;
    glbNodeCount: number;
    glbMeshCount: number;
    splatPath: string;
    splatSizeKB: number;
    splatCount: number;
    splatValid: boolean;
    readmeExists: boolean;
    manifestExists: boolean;
}

function auditGlb(filePath: string) {
    if (!fs.existsSync(filePath)) return { valid: false, nodeCount: 0, meshCount: 0, sizeKB: 0 };
    const buf = fs.readFileSync(filePath);
    const sizeKB = Math.round(buf.length / 102.4) / 10;
    
    // Check GLB Header: magic 0x46546C67 ("glTF"), version 2
    if (buf.length < 12) return { valid: false, nodeCount: 0, meshCount: 0, sizeKB };
    const magic = buf.readUInt32LE(0);
    const version = buf.readUInt32LE(4);
    if (magic !== 0x46546C67 || version !== 2) {
        return { valid: false, nodeCount: 0, meshCount: 0, sizeKB };
    }

    // Read JSON chunk
    const jsonChunkLength = buf.readUInt32LE(12);
    const jsonChunkType = buf.readUInt32LE(16);
    if (jsonChunkType !== 0x4E4F534A) { // "JSON"
        return { valid: false, nodeCount: 0, meshCount: 0, sizeKB };
    }

    const jsonStr = buf.toString('utf8', 20, 20 + jsonChunkLength);
    try {
        const gltf = JSON.parse(jsonStr);
        return {
            valid: true,
            nodeCount: (gltf.nodes || []).length,
            meshCount: (gltf.meshes || []).length,
            materialCount: (gltf.materials || []).length,
            sizeKB
        };
    } catch {
        return { valid: false, nodeCount: 0, meshCount: 0, sizeKB };
    }
}

function auditSplat(filePath: string) {
    if (!fs.existsSync(filePath)) return { valid: false, splatCount: 0, sizeKB: 0 };
    const buf = fs.readFileSync(filePath);
    const sizeKB = Math.round(buf.length / 102.4) / 10;
    
    // Standard flat binary format is strictly 32 bytes per splat:
    // [0..11]: 3x Float32 position
    // [12..23]: 3x Float32 scale
    // [24..27]: 4x UInt8 RGBA color
    // [28..31]: 4x UInt8 quaternion rotation
    const splatCount = Math.floor(buf.length / 32);
    const isMultipleOf32 = (buf.length % 32 === 0);

    return {
        valid: isMultipleOf32 && splatCount > 0,
        splatCount,
        sizeKB
    };
}

async function runAudit() {
    const projectsRoot = path.join(__dirname, '..', 'projects');
    const projectDirs = fs.readdirSync(projectsRoot).filter(f => {
        const full = path.join(projectsRoot, f);
        return fs.statSync(full).isDirectory();
    });

    console.log(`[Package Audit] Auditing ${projectDirs.length} projects in ${projectsRoot}...`);
    const results: ProjectAuditResult[] = [];

    for (const p of projectDirs) {
        const dir = path.join(projectsRoot, p);
        const glbFile = path.join(dir, 'scene.glb');
        const splatFile = path.join(dir, 'radiance.splat');
        const readmeFile = path.join(dir, 'README.md');
        const manifestFile = path.join(dir, 'scene_manifest.md');

        const glbInfo = auditGlb(glbFile);
        const splatInfo = auditSplat(splatFile);

        results.push({
            projectName: p,
            glbPath: glbFile,
            glbSizeKB: glbInfo.sizeKB,
            glbValid: glbInfo.valid,
            glbNodeCount: glbInfo.nodeCount,
            glbMeshCount: glbInfo.meshCount,
            splatPath: splatFile,
            splatSizeKB: splatInfo.sizeKB,
            splatCount: splatInfo.splatCount,
            splatValid: splatInfo.valid,
            readmeExists: fs.existsSync(readmeFile),
            manifestExists: fs.existsSync(manifestFile)
        });
    }

    console.log(JSON.stringify(results, null, 2));

    const allValid = results.every(r => r.glbValid && r.splatValid && r.readmeExists && r.manifestExists);
    if (!allValid) {
        console.error('[Package Audit] FAIL: Some packages did not pass validation.');
        process.exit(1);
    }
    console.log('[Package Audit] SUCCESS: All 3D foundation scene packages verified cleanly.');
}

runAudit().catch(e => {
    console.error(e);
    process.exit(1);
});

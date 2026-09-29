import { describe, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { NativeAiRenderEngineService } from '../src/node/spatial/NativeAiRenderEngineService';

describe('Render Real Multimodal Survey Passes', () => {
    it('extracts real Clay, Depth Mist, and Normal passes for Constantine Arch', () => {
        const glbPath = path.resolve(__dirname, '../../../public/models/arch_constantine_sb_archi.glb');
        if (!fs.existsSync(glbPath)) return;

        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);
        
        // Calculate mesh bounding box to place camera perfectly
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < mesh.vertices.length; i += 3) {
            const x = mesh.vertices[i];
            const y = mesh.vertices[i + 1];
            const z = mesh.vertices[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const cz = (minZ + maxZ) / 2;
        const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);

        const pose = {
            x: cx,
            y: cy + extent * 0.2,
            z: cz + extent * 1.6,
            targetX: cx,
            targetY: cy,
            targetZ: cz,
            up: [0, 1, 0] as [number, number, number],
            fov: 50
        };

        const service = new NativeAiRenderEngineService();
        const passes = service.extractRenderPasses(mesh, pose, 960, 540);

        const shotDir = path.resolve(__dirname, '../../../docs/screenshots');
        fs.writeFileSync(path.join(shotDir, '137_real_station_clay.png'), passes.clay);
        fs.writeFileSync(path.join(shotDir, '137_real_station_mist_depth.png'), passes.mist);
        fs.writeFileSync(path.join(shotDir, '137_real_station_normal.png'), passes.normal);
        console.log('Saved 137_real_station passes (clay, mist_depth, normal) to', shotDir);
    });

    it('extracts real Clay, Depth Mist, and Normal passes for Colosseum 3D Tile', () => {
        const glbPath = path.resolve(__dirname, '../../../public/models/colosseum_grounded.glb');
        if (!fs.existsSync(glbPath)) return;

        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);
        
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < mesh.vertices.length; i += 3) {
            const x = mesh.vertices[i];
            const y = mesh.vertices[i + 1];
            const z = mesh.vertices[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const cz = (minZ + maxZ) / 2;
        const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);

        // Oblique aerial survey pose matching authentic Colosseum 3D tile vantage
        const pose = {
            x: cx + extent * 0.7,
            y: cy + extent * 0.65,
            z: cz + extent * 0.9,
            targetX: cx,
            targetY: cy,
            targetZ: cz,
            up: [0, 1, 0] as [number, number, number],
            fov: 48
        };

        const service = new NativeAiRenderEngineService();
        const passes = service.extractRenderPasses(mesh, pose, 960, 540);

        const shotDir = path.resolve(__dirname, '../../../docs/screenshots');
        fs.writeFileSync(path.join(shotDir, '145_colosseum_station_clay.png'), passes.clay);
        fs.writeFileSync(path.join(shotDir, '145_colosseum_station_mist_depth.png'), passes.mist);
        fs.writeFileSync(path.join(shotDir, '145_colosseum_station_normal.png'), passes.normal);
        console.log('Saved 145_colosseum_station passes (clay, mist_depth, normal) to', shotDir);
    });
});

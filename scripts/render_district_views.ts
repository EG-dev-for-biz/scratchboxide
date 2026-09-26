/**
 * Renders named camera views of a district GLB with the native path tracer (texture as captured).
 *
 *   npx vite-node scripts/render_district_views.ts --glb <file.glb> --views <views.json> --out <dir> [--mode baked|relit]
 *
 * views.json: [{ "name": "aerial", "position": [x,y,z], "target": [x,y,z], "fov": 45 }, ...] in the GLB's own frame.
 */
import * as fs from 'fs';
import * as path from 'path';
import { NativeTilePathTracerService } from '../packages/core/src/node/3d-engine/native-tile-path-tracer-service';

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function main() {
    const glbPath = path.resolve(arg('glb')!);
    const views = JSON.parse(fs.readFileSync(path.resolve(arg('views')!), 'utf8')) as Array<{ name: string; position: [number, number, number]; target: [number, number, number]; fov?: number }>;
    const outDir = path.resolve(arg('out')!);
    const mode = (arg('mode', 'baked') as 'baked' | 'relit');
    const width = Number(arg('width', '1280'));
    const height = Number(arg('height', '720'));
    const spp = Number(arg('spp', '16'));
    const tracer = new NativeTilePathTracerService();
    for (const v of views) {
        const res = await tracer.render({
            glbPath,
            outputDir: path.join(outDir, v.name),
            sun: { latitude: 40.7646, longitude: -73.9743, isoDate: '2026-06-21T15:00:00-04:00' },
            width, height, samplesPerPixel: spp, maxBounces: 3, shadingMode: mode, denoise: true, groundPlane: false,
            camera: { position: v.position, target: v.target, verticalFovDeg: v.fov ?? 45 }
        });
        console.log(`${v.name}: ${res.success ? 'ok' : 'FAILED'} ${res.stats.triangles} tris, ${res.stats.imagesDecoded}/${res.stats.images} textures, coverage ${res.stats.geometryCoverage.toFixed(2)}, ${res.stats.totalMs} ms -> ${res.beautyPngPath}`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });

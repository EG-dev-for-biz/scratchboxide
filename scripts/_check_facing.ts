import * as fs from 'fs';
import { PerformerSurfaceMeshService, SurfaceBuildOptions } from './packages/core/src/node/spatial/PerformerSurfaceMeshService';
import { GvhmrBodyService } from './packages/core/src/node/spatial/GvhmrBodyService';

const body = JSON.parse(fs.readFileSync('models/4danyone/demos/man-in-black/gvhmr_body.json', 'utf-8'));
const gvhmr = new GvhmrBodyService();
const w = body.width || 1080, h = body.height || 1920;
const heroRgb = gvhmr.readRgb('models/4danyone/demos/man-in-black/hero_frame.png', w, h);

const base = PerformerSurfaceMeshService.fromBody(body);
const sub = PerformerSurfaceMeshService.subdivideMidpoint(base, 2);
const nv = sub.positions.length / 3;
const Vc = sub.camPositions!;
const Nc = PerformerSurfaceMeshService.computeNormals(Vc, sub.indices);
const [[fx, , cx], [, fy, cy]] = body.K;

let faceTotal = 0;
let facingCount = 0;
let boundsCount = 0;
let depthCount = 0;

for (let i = 0; i < nv; i++) {
    const b = sub.skinIndices[i * 4];
    if (b !== 15) continue;
    const y = sub.positions[i * 3 + 1];
    const z = sub.positions[i * 3 + 2];
    if (z > 0.03 && y > 1.55 && y < 1.72) {
        faceTotal++;
        const zc = Vc[i * 3 + 2];
        const nx = Nc[i * 3], ny = Nc[i * 3 + 1], nz = Nc[i * 3 + 2];
        const lenP = Math.hypot(Vc[i * 3], Vc[i * 3 + 1], zc) || 1;
        const facing = (nx * Vc[i * 3] + ny * Vc[i * 3 + 1] + nz * zc) / lenP;
        if (facing < -0.05) facingCount++;
        const u = fx * Vc[i * 3] / zc + cx;
        const v = fy * Vc[i * 3 + 1] / zc + cy;
        if (u >= 0 && v >= 0 && u < w - 1 && v < h - 1) boundsCount++;
    }
}
console.log(`faceTotal: ${faceTotal}, facingCount: ${facingCount} (${(facingCount/faceTotal*100).toFixed(1)}%), boundsCount: ${boundsCount} (${(boundsCount/faceTotal*100).toFixed(1)}%)`);

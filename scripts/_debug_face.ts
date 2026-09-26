import * as fs from 'fs';
import { decodeSurfaceGlb } from './packages/core/src/node/spatial/PerformerSurfaceMeshService';

const m = decodeSurfaceGlb(fs.readFileSync('public/models/humanoid_man-in-black.glb'));
console.log('mesh verts:', m.positions.length / 3);
const col = m.colors!;
let faceCount = 0;
let blackCount = 0;
let whiteCount = 0;
let skinCount = 0;
for (let i = 0; i < m.positions.length / 3; i++) {
    const b = m.skinIndices[i * 4];
    if (b !== 15) continue;
    const y = m.positions[i * 3 + 1];
    const z = m.positions[i * 3 + 2];
    if (z > 0.03 && y > 1.55 && y < 1.72) {
        faceCount++;
        const r = col[i * 3], g = col[i * 3 + 1], bCol = col[i * 3 + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bCol;
        if (lum < 0.10) blackCount++;
        else if (lum > 0.85) whiteCount++;
        else skinCount++;
    }
}
console.log('faceCount:', faceCount, 'blackCount:', blackCount, 'whiteCount:', whiteCount, 'skinCount:', skinCount);
if (faceCount > 0) {
    console.log(`blackPct: ${(blackCount / faceCount * 100).toFixed(1)}%, whitePct: ${(whiteCount / faceCount * 100).toFixed(1)}%, skinPct: ${(skinCount / faceCount * 100).toFixed(1)}%`);
}

/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Massing evaluation, step 3 (dev tool): for each case in <out>/report.json, the structure's scan and its chosen massing
 * rendered in clay from the same two cameras (a three-quarter view from each side, framed on the scan), as
 * <out>/<n>_sheet.png: top row the scan, bottom row the chosen massing. Labels are added by massing-eval-sheet.py.
 *
 *   npx tsx scripts/dev/massing-eval-render.ts <out-dir>
 */

import * as fs from 'fs';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer as R } from '../../packages/core/src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { encodePng } from '../../packages/core/src/node/3d-engine/staged-location/png-encode';

const out = process.argv[2];
const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(out, 'cases.json'), 'utf8'));
const W = 420, H = 420;
for (const row of report) {
    if (!row.chosenGlb) continue;
    const c = cases[row.n - 1];
    const scan = R.loadMeshFromGlb(c.scanGlb), chosen = R.loadMeshFromGlb(row.chosenGlb);
    // frame on the scan's bounds
    const v = scan.vertices as ArrayLike<number>;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); }
    const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = (lo[2] + hi[2]) / 2;
    const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    const d = r / Math.sin((22 * Math.PI) / 180);
    const cams = [[1, 0.55, 1], [-1, 0.55, -0.9]].map(([a, b, e]) => { const L = Math.hypot(a, b, e); return { x: cx + (a / L) * d, y: cy + (b / L) * d, z: cz + (e / L) * d, targetX: cx, targetY: cy, targetZ: cz, fov: 44 }; });
    const sheet = Buffer.alloc(W * 2 * H * 2 * 4);
    [scan, chosen].forEach((mesh, rowI) => cams.forEach((cam, colI) => {
        const img = R.renderShadedMesh(mesh, cam, W, H, { clayColor: [200, 194, 184], bgColor: [255, 255, 255, 255], lightDir: [0.4, 0.8, 0.3], clipNearPlane: true });
        for (let y = 0; y < H; y++) img.rgba.copy(sheet, ((rowI * H + y) * W * 2 + colI * W) * 4, y * W * 4, (y + 1) * W * 4);
    }));
    fs.writeFileSync(path.join(out, `${row.n}_sheet.png`), encodePng(W * 2, H * 2, sheet, 4));
    console.log(`${row.n}. ${row.place}: sheet written`);
}

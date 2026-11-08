/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The material regions' regression guard: measures, from a finished pipeline K twin, what its drawn materials do on the
 * rebuilt facades' window repeats (pipeline-k/material-regions.ts repeatElements), so two builds (main and a branch) can
 * be compared by numbers as well as by eye.
 *
 *   npx vite-node scripts/material_regions_metrics.ts <twin.glb> [<twin.glb> ...]   (one JSON line per model)
 *
 * Per model, over every rebuilt facade with a window family of three or more repeats:
 *  - repeatSpread: the mean, over the families' 24 x 24 cell grids, of the spread (standard deviation) of the drawn
 *    roughness across a family's repeats at that cell, plus that of the metalness: 0 when every repeat of a window is
 *    drawn alike. A bay drawn metal beside glass bays raises it.
 *  - openings: inside the windows (their middle 60%), the mean drawn roughness, metalness and normal tilt (degrees).
 *  - around: in the unit cells outside the windows (spandrels, mullions, piers), the same, and the roughness's spread
 *    within a cell (a set's pattern drawn on the wall raises it).
 * Numbers only; nothing here names a material.
 */
import * as fs from 'fs';
import { parseGlbBytes } from '../packages/core/src/node/3d-engine/staged-location/glb-bytes';
import { decodeImageInMemory, type RgbaImage8 } from '../packages/core/src/node/3d-engine/staged-location/tile-texture-transfer';
import { repeatElements, MATERIAL_REGIONS_PARAMS } from '../packages/core/src/node/3d-engine/staged-location/pipeline-k/material-regions';

const GRID = MATERIAL_REGIONS_PARAMS.repeatGrid;

function textureImage(g: ReturnType<typeof parseGlbBytes>, json: any, index: number | undefined): RgbaImage8 | undefined {
    if (index === undefined) return undefined;
    const src = json.textures?.[index]?.source, v = src !== undefined ? json.bufferViews[json.images[src].bufferView] : undefined;
    return v ? decodeImageInMemory(g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)) : undefined;
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const sd = (v: number[]) => { if (v.length < 2) return 0; const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function measure(file: string) {
    const g = parseGlbBytes(fs.readFileSync(file)), json: any = g.json;
    const spreads: number[] = [], inR: number[] = [], inM: number[] = [], inT: number[] = [], outR: number[] = [], outM: number[] = [], outT: number[] = [], outGrain: number[] = [];
    let facades = 0, families = 0;
    json.nodes.forEach((n: any) => {
        const mesh = json.meshes?.[n.mesh];
        const uv = n.extras?.sbFacadeLattice?.windows?.uv;
        if (!mesh || !/^facade_lattice_\d+$/.test(mesh.name ?? '') || !Array.isArray(uv)) return;
        const el = repeatElements(uv);
        if (!el.family.length) return;
        const mat = json.materials?.[mesh.primitives?.[0]?.material];
        const orm = textureImage(g, json, mat?.pbrMetallicRoughness?.metallicRoughnessTexture?.index), nrm = textureImage(g, json, mat?.normalTexture?.index);
        if (!orm) return;
        facades++;
        const { width: W, height: H } = orm;
        const at = (img: RgbaImage8, x: number, y: number, c: number) => img.rgba[(Math.min(img.height - 1, Math.floor((y * img.height) / H)) * img.width + Math.min(img.width - 1, Math.floor((x * img.width) / W))) * 4 + c] / 255;
        const tilt = (x: number, y: number) => { if (!nrm) return 0; const nx = at(nrm, x, y, 0) * 2 - 1, ny = at(nrm, x, y, 1) * 2 - 1, nz = at(nrm, x, y, 2) * 2 - 1; return (Math.atan2(Math.hypot(nx, ny), Math.max(1e-6, nz)) * 180) / Math.PI; };
        const span = (r: number[]) => [Math.max(0, Math.floor(r[0] * W)), Math.max(0, Math.floor(r[1] * H)), Math.min(W, Math.ceil(r[2] * W)), Math.min(H, Math.ceil(r[3] * H))];
        const F = Math.max(...el.family) + 1;
        families += F;
        // per family, per grid cell, each repeat's mean roughness and metalness
        const cells: Array<Array<{ r: number[]; m: number[] }>> = Array.from({ length: F }, () => Array.from({ length: GRID * GRID }, () => ({ r: [], m: [] })));
        el.family.forEach((f, e) => {
            const c = span(el.rects.slice(e * 4, e * 4 + 4)), w = span(el.windows.slice(e * 4, e * 4 + 4));
            if (c[2] - c[0] < 2 || c[3] - c[1] < 2) return;
            const sumR = new Float64Array(GRID * GRID), sumM = new Float64Array(GRID * GRID), cnt = new Float64Array(GRID * GRID), cellR: number[] = [];
            const wx0 = w[0] + 0.2 * (w[2] - w[0]), wx1 = w[2] - 0.2 * (w[2] - w[0]), wy0 = w[1] + 0.2 * (w[3] - w[1]), wy1 = w[3] - 0.2 * (w[3] - w[1]);
            for (let y = c[1]; y < c[3]; y += 2) for (let x = c[0]; x < c[2]; x += 2) {
                const cell = Math.min(GRID - 1, Math.floor(((y - c[1]) * GRID) / (c[3] - c[1]))) * GRID + Math.min(GRID - 1, Math.floor(((x - c[0]) * GRID) / (c[2] - c[0])));
                const rr = at(orm, x, y, 1), mm = at(orm, x, y, 2);
                sumR[cell] += rr; sumM[cell] += mm; cnt[cell]++;
                if (x >= wx0 && x < wx1 && y >= wy0 && y < wy1) { inR.push(rr); inM.push(mm); inT.push(tilt(x, y)); }
                else if (x < w[0] || x >= w[2] || y < w[1] || y >= w[3]) { outR.push(rr); outM.push(mm); outT.push(tilt(x, y)); cellR.push(rr); }
            }
            for (let k = 0; k < GRID * GRID; k++) if (cnt[k]) { cells[f][k].r.push(sumR[k] / cnt[k]); cells[f][k].m.push(sumM[k] / cnt[k]); }
            if (cellR.length > 4) outGrain.push(sd(cellR));
        });
        for (const fam of cells) for (const c of fam) if (c.r.length >= 3) spreads.push(sd(c.r) + sd(c.m));
    });
    return {
        model: file, facades, families, repeatSpread: r3(mean(spreads)),
        openings: { roughness: r3(mean(inR)), metalness: r3(mean(inM)), tiltDeg: r3(mean(inT)) },
        around: { roughness: r3(mean(outR)), metalness: r3(mean(outM)), tiltDeg: r3(mean(outT)), roughnessSpreadInCell: r3(mean(outGrain)) }
    };
}

for (const f of process.argv.slice(2)) console.log(JSON.stringify(measure(f)));

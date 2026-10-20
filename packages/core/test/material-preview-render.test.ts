/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The material preview render the object build's material check compares with the reference: the #808080 backdrop,
 * each part in its own factors (colour, metal against matte, see-through tinting what is behind it, glow), and the
 * high-confidence corrections applied to a spec within the factor ranges. No model calls.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../src/node/texture-processing';
import { renderMaterialPreview, CLAY_PREVIEW_MATERIAL } from '../src/node/3d-engine/material-preview-render';
import { applyMaterialCorrections } from '../src/node/3d-engine/reference-object-builder';
import type { TriangleSoup } from '../src/node/3d-engine/part-connectivity';
import type { ObjectBuildSpec, PartMaterial } from '../src/common/spatial/object-build-spec';
import { REPO_ROOT } from './helpers/requirements';

const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results/screenshots');

/** A UV sphere of radius r at `center`. */
function sphere(center: [number, number, number], r: number, seg = 48): TriangleSoup {
    const positions: number[] = [], indices: number[] = [];
    for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI;
        for (let j = 0; j <= seg; j++) {
            const ph = (j / seg) * Math.PI * 2;
            positions.push(center[0] + r * Math.sin(th) * Math.cos(ph), center[1] + r * Math.cos(th), center[2] + r * Math.sin(th) * Math.sin(ph));
        }
    }
    for (let i = 0; i < seg; i++) {
        for (let j = 0; j < seg; j++) {
            const a = i * (seg + 1) + j, b = a + seg + 1;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const toImg = (png: Buffer) => { const d = decodePng(png); return { width: d.width, data: d.rgba }; };

const pixel = (png: Buffer, x: number, y: number) => {
    const img = toImg(png);
    const o = (y * img.width + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
};

/** Mean colour of a square patch. */
const patch = (png: Buffer, cx: number, cy: number, half = 6) => {
    const img = toImg(png);
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = cy - half; y <= cy + half; y++) for (let x = cx - half; x <= cx + half; x++) {
        const o = (y * img.width + x) * 4;
        for (let k = 0; k < 3; k++) sum[k] += img.data[o + k];
        n++;
    }
    return sum.map(v => v / n);
};

const save = (name: string, png: Buffer) => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SCREENSHOT_DIR, name), png);
};

const VIEW = { azimuthDeg: 0, elevationDeg: 0 };

describe('renderMaterialPreview', () => {
    it('draws the #808080 backdrop and each part in its own colour', () => {
        const red: PartMaterial = { baseColor: [0.6, 0.03, 0.03], roughness: 0.6, metalness: 0, transmission: 0 };
        const png = renderMaterialPreview([{ soup: sphere([0, 0, 0], 0.5), material: red }], VIEW, 256);
        save('material_preview_red_sphere.png', png);
        expect(pixel(png, 2, 2)).toEqual([128, 128, 128]);
        const [r, g, b] = patch(png, 128, 128);
        expect(r).toBeGreaterThan(120);
        expect(r).toBeGreaterThan(g + 80);
        expect(r).toBeGreaterThan(b + 80);
    });

    it('gives a part without a material studio clay, and tells bare metal from matte paint of the same colour', () => {
        const tint: [number, number, number] = [0.6, 0.6, 0.6];
        const matte = renderMaterialPreview([{ soup: sphere([0, 0, 0], 0.5), material: { baseColor: tint, roughness: 0.9, metalness: 0, transmission: 0 } }], VIEW, 256);
        const metal = renderMaterialPreview([{ soup: sphere([0, 0, 0], 0.5), material: { baseColor: tint, roughness: 0.15, metalness: 1, transmission: 0 } }], VIEW, 256);
        const clay = renderMaterialPreview([{ soup: sphere([0, 0, 0], 0.5) }], VIEW, 256);
        const clayAgain = renderMaterialPreview([{ soup: sphere([0, 0, 0], 0.5), material: CLAY_PREVIEW_MATERIAL }], VIEW, 256);
        save('material_preview_matte.png', matte);
        save('material_preview_metal.png', metal);
        expect(clay.equals(clayAgain)).toBe(true);
        // The polished metal reflects the studio: much more contrast across the sphere than the matte one.
        const spread = (png: Buffer) => {
            const img = toImg(png);
            const lum: number[] = [];
            // inside the sphere's disc (about 60 px across at this framing), not the backdrop
            for (let y = 84; y < 172; y += 3) for (let x = 84; x < 172; x += 3) {
                if (Math.hypot(x - 128, y - 128) > 44) continue;
                const o = (y * img.width + x) * 4;
                lum.push(img.data[o] + img.data[o + 1] + img.data[o + 2]);
            }
            const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
            return Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length);
        };
        expect(spread(metal)).toBeGreaterThan(1.5 * spread(matte));
    });

    it('shows what is behind a see-through part, tinted by its base colour', () => {
        const glass: PartMaterial = { baseColor: [0.2, 0.9, 0.2], roughness: 0.05, metalness: 0, transmission: 1, ior: 1.5 };
        const inner: PartMaterial = { baseColor: [0.8, 0.05, 0.05], roughness: 0.5, metalness: 0, transmission: 0 };
        const png = renderMaterialPreview([
            { soup: sphere([0, 0, 0], 0.5), material: glass },
            { soup: sphere([0, 0, 0], 0.2), material: inner }
        ], VIEW, 256);
        save('material_preview_glass.png', png);
        // Through the green glass, beside the inner ball: the grey backdrop tinted green.
        const [r1, g1, b1] = patch(png, 128 + 42, 128, 3);
        expect(g1).toBeGreaterThan(r1 + 20);
        expect(g1).toBeGreaterThan(b1 + 20);
        // The red ball inside shows through the glass (redder than the backdrop beside it); made opaque, it is hidden.
        expect(patch(png, 128, 128, 3)[0]).toBeGreaterThan(r1 + 10);
        const opaque = renderMaterialPreview([
            { soup: sphere([0, 0, 0], 0.5), material: { ...glass, transmission: 0 } },
            { soup: sphere([0, 0, 0], 0.2), material: inner }
        ], VIEW, 256);
        const [ro, go] = patch(opaque, 128, 128, 3);
        expect(go).toBeGreaterThan(ro);
    });

    it('makes a glowing part brighter than the same part unlit', () => {
        const base: PartMaterial = { baseColor: [0.2, 0.15, 0.05], roughness: 0.6, metalness: 0, transmission: 0 };
        const dark = renderMaterialPreview([{ soup: sphere([0, 0, 0], 0.5), material: base }], VIEW, 128);
        const glow = renderMaterialPreview([{ soup: sphere([0, 0, 0], 0.5), material: { ...base, emissive: [1, 0.6, 0.1], emissiveStrength: 2 } }], VIEW, 128);
        save('material_preview_glow.png', glow);
        expect(patch(glow, 64, 64)[0]).toBeGreaterThan(patch(dark, 64, 64)[0] + 60);
    });
});

describe('applyMaterialCorrections', () => {
    const spec: ObjectBuildSpec = {
        subject: 'cup', observations: [], boundingMeters: [0.1, 0.1, 0.1], expectedBodies: 1,
        parts: [
            { id: 'body', label: 'body', material: { baseColor: [0.5, 0.5, 0.5], roughness: 0.5, metalness: 0, transmission: 0, description: 'grey glaze' }, revolve: { axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], meridian: [[0, 0], [0, 0.05], [0.1, 0.05], [0.1, 0]] } as any },
            { id: 'ring', label: 'ring', replicate: { seedPartId: 'body', count: 2, ring: { centerMeters: [0, 0, 0], axis: [0, 1, 0], spanDeg: 360 } } as any }
        ]
    };

    it('applies high-confidence corrections within range and says why the others are not applied', () => {
        const out = applyMaterialCorrections(spec, [
            { partId: 'body', problem: 'should be glossy white', confidence: 'high', correction: { baseColor: [0.85, 0.85, 0.85], roughness: 0.1 } },
            { partId: 'body', problem: 'maybe warmer', confidence: 'low', correction: { baseColor: [0.9, 0.8, 0.7] } },
            { partId: 'ring', problem: 'copies', confidence: 'high', correction: { roughness: 0.2 } },
            { partId: 'nope', problem: 'unknown', confidence: 'high', correction: { roughness: 0.2 } }
        ]);
        expect(out.applied).toEqual([{ partId: 'body', problem: 'should be glossy white', from: { baseColor: [0.5, 0.5, 0.5], roughness: 0.5 }, to: { baseColor: [0.85, 0.85, 0.85], roughness: 0.1 } }]);
        expect(out.spec!.parts[0].material).toEqual({ baseColor: [0.85, 0.85, 0.85], roughness: 0.1, metalness: 0, transmission: 0, description: 'grey glaze' });
        expect(out.notApplied.map(n => n.partId)).toEqual(['ring', 'nope']);
        // the input spec is not changed
        expect(spec.parts[0].material!.roughness).toBe(0.5);
    });

    it('applies nothing for a correction that changes nothing or leaves a factor out of range', () => {
        const out = applyMaterialCorrections(spec, [
            { partId: 'body', problem: 'same', confidence: 'high', correction: { roughness: 0.5 } },
            { partId: 'body', problem: 'out of range', confidence: 'high', correction: { metalness: 1.4 } }
        ]);
        expect(out.spec).toBeUndefined();
        expect(out.notApplied[0].reason).toBe('the correction changes no factor');
        expect(out.notApplied[1].reason).toContain('metalness must be between 0 and 1');
    });

    it('gives a glow strength without a colour the base colour', () => {
        const out = applyMaterialCorrections(spec, [{ partId: 'body', problem: 'it glows', confidence: 'high', correction: { emissiveStrength: 3 } }]);
        expect(out.spec!.parts[0].material).toMatchObject({ emissive: [0.5, 0.5, 0.5], emissiveStrength: 3 });
    });
});

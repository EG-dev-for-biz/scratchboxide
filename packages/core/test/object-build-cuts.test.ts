/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Cuts saved in an object build spec (part.cuts): validated like the rest of the spec, kept in the build script (so a
 * specJson rebuild keeps them), and subtracted natively from the part once it is built: a mirrored box leaves a pocket
 * on each side, a cylinder bores a real hole, the part stays one piece and its material says the cuts are generated.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateObjectBuildSpec, buildObjectSpecScript, objectBuildSpecJsonSchema, type ObjectBuildSpec } from '../src/common/spatial/object-build-spec';
import { buildObjectFromSpec } from '../src/node/3d-engine/reference-object-builder';
import { glbToTriangleSoup } from '../src/node/3d-engine/part-connectivity';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cuts-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A 1 m wide, 1 m tall, 2 m long block standing on the ground (a boxy sweep along Z), with the given cuts. */
const block = (cuts?: unknown[]): ObjectBuildSpec => ({
    subject: 'block', observations: [], boundingMeters: [1, 1, 2], expectedBodies: 1,
    parts: [{
        id: 'block', label: 'block', edgeRadiusMeters: 0,
        sweep: { controlPoints: [[0, 0.5, -1], [0, 0.5, 1]], closedLoop: false, smoothing: 0, profile: [{ t: 0, widthMeters: 1, heightMeters: 1, exponent: 12 }] },
        ...(cuts ? { cuts } : {})
    } as any]
});
const POCKET = { box: { centerMeters: [0.5, 0.5, 0], sizeMeters: [0.4, 0.3, 0.4] }, mirrorPlaneNormal: [1, 0, 0] };
const BORE = { cylinder: { startMeters: [-1, 0.5, 0.6], endMeters: [1, 0.5, 0.6], radiusMeters: 0.15 } };

describe('part.cuts', () => {
    it('validates boxes and cylinders, and only on parts with a solid', () => {
        expect(validateObjectBuildSpec(block([POCKET, BORE]))).toEqual([]);
        expect(validateObjectBuildSpec(block([]))).toContainEqual(expect.stringMatching(/cuts must be 1-16 boxes or cylinders/));
        expect(validateObjectBuildSpec(block([{ ...POCKET, ...BORE }]))).toContainEqual(expect.stringMatching(/cuts\[0\] must have exactly one of box, cylinder/));
        expect(validateObjectBuildSpec(block([{ box: { centerMeters: [0, 0, 0], sizeMeters: [0.1, 0, 0.1] } }]))).toContainEqual(expect.stringMatching(/every size above 0/));
        expect(validateObjectBuildSpec(block([{ cylinder: { startMeters: [0, 0, 0], endMeters: [0, 0, 0], radiusMeters: 0.1 } }]))).toContainEqual(expect.stringMatching(/coincide/));
        const relief: any = { ...block(), parts: [...block().parts, { id: 'g', label: 'g', relief: { targetPartId: 'block', curves: [[[0.5, 0], [0.5, 1]]], widthMeters: 0.02, depthMeters: -0.01, sharpness: 0.5 }, cuts: [POCKET] }] };
        expect(validateObjectBuildSpec(relief)).toContainEqual(expect.stringMatching(/part "g": a relief part has no solid of its own to cut/));
        expect(Object.keys((objectBuildSpecJsonSchema({ materials: false }) as any).properties.parts.items.properties)).toContain('cuts');
    });

    it('keeps the cuts in the build script, so a spec rebuilt as given keeps them', () => {
        expect(buildObjectSpecScript(block([POCKET]))).toContain('"cuts"');
    });

    it('cuts them natively: a pocket each side, a bored hole, still one piece, labelled generated', async () => {
        const built = await buildObjectFromSpec(block([POCKET, BORE]), {}, { buildTimeoutMs: 120_000, outputDir: TMP });
        expect(built.checks.missingParts).toEqual([]);
        expect(built.checks.connectivity.bodies).toBe(1);
        const soup = glbToTriangleSoup(built.glb, { colors: false })!;
        const verts: Array<[number, number, number]> = [];
        for (let i = 0; i < soup.positions.length; i += 3) verts.push([soup.positions[i], soup.positions[i + 1], soup.positions[i + 2]]);
        // the pockets' floors: faces 0.2 m in from each side wall, inside the pocket's span
        const floor = (side: 1 | -1) => verts.filter(v => Math.abs(v[0] - side * 0.3) < 1e-3 && Math.abs(v[2]) <= 0.2 + 1e-3 && v[1] > 0.34 && v[1] < 0.66).length;
        expect(floor(1)).toBeGreaterThan(3);
        expect(floor(-1)).toBeGreaterThan(3);
        // the bore: its wall stands 0.15 m round the axis (y 0.5, z 0.6) through the block's width
        const wall = verts.filter(v => Math.abs(Math.hypot(v[1] - 0.5, v[2] - 0.6) - 0.15) < 2e-3 && Math.abs(v[0]) < 0.5).length;
        expect(wall).toBeGreaterThan(30);
        // and nothing is left inside the bore
        const inside = verts.filter(v => Math.hypot(v[1] - 0.5, v[2] - 0.6) < 0.14 && Math.abs(v[0]) < 0.49).length;
        expect(inside).toBe(0);
        const json = JSON.parse(built.glb.subarray(20, 20 + built.glb.readUInt32LE(12)).toString('utf8'));
        const extras = json.materials.map((m: any) => m.extras?.scratchbox?.cuts).find(Boolean);
        expect(extras).toEqual({ count: 2, provenance: 'generated' });
    }, 300_000);
});

/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Blueprint lofts (blueprint-loft.ts, sweep.fromBlueprint): the sections cut from a test car's outlines, the spec
 * rules for parts lofted from a blueprint, and a real native build of a body and a cabin lofted from it whose own
 * outlines match the blueprint, with round wheel arches where clearances lift the underside.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandBlueprintParts, loftSections, LOFT_RING_POINTS, type ObjectOutlines } from '../src/common/spatial/blueprint-loft';
import { validateObjectBuildSpec, buildObjectSpecScript, objectBuildSpecJsonSchema, type ObjectBuildSpec } from '../src/common/spatial/object-build-spec';
import { compareOutlines, outlinesFromTriangles } from '../src/node/3d-engine/blueprint-outlines';
import { buildObjectFromSpec } from '../src/node/3d-engine/reference-object-builder';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { glbToTriangleSoup, type TriangleSoup } from '../src/node/3d-engine/part-connectivity';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-loft-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Box = [number, number, number, number, number, number];
/** Body 4 m long, 1.8 m wide, 0.3-1.0 m high; cabin 1.4 m wide from z -1.2 to 0.6 up to 1.5 m; four wheels. */
const CAR: Box[] = [
    [-0.9, 0.9, 0.3, 1.0, -2.0, 2.0],
    [-0.7, 0.7, 0.99, 1.5, -1.2, 0.6],
    ...[1.3, -1.3].flatMap(z => [[0.7, 0.9, 0, 0.66, z - 0.33, z + 0.33], [-0.9, -0.7, 0, 0.66, z - 0.33, z + 0.33]] as Box[])
];
function soupOf(boxes: Box[]): TriangleSoup {
    const pos: number[] = [], idx: number[] = [];
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 3, 7, 4], [1, 2, 6, 5]];
    for (const [x0, x1, y0, y1, z0, z1] of boxes) {
        const b = pos.length / 3;
        pos.push(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
        for (const [a, c, d, e] of faces) idx.push(b + a, b + c, b + d, b + a, b + d, b + e);
    }
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
const BLUEPRINT: ObjectOutlines = outlinesFromTriangles(soupOf(CAR));
const ARCHES = [1.3, -1.3].map(z => ({ zMeters: z, yMeters: 0.33, radiusMeters: 0.4 }));

describe('loft sections', () => {
    it('cuts one ring per station, all the same length, inside the drawings\' outlines', () => {
        const rings = loftSections(BLUEPRINT);
        expect(rings.length).toBeGreaterThan(70);
        expect(rings.every(r => r.points.length === LOFT_RING_POINTS)).toBe(true);
        expect(rings.map(r => r.z)).toEqual([...rings.map(r => r.z)].sort((a, b) => a - b));
        const atCabin = rings.find(r => Math.abs(r.z) < 0.03)!;
        const ys = atCabin.points.map(p => p[1]), xs = atCabin.points.map(p => p[0]);
        expect(Math.max(...ys)).toBeCloseTo(1.5, 2);
        expect(Math.max(...xs)).toBeCloseTo(0.9, 2);                    // the body, below the cabin
        const nearTop = atCabin.points.filter(p => p[1] > 1.3).map(p => Math.abs(p[0]));
        expect(Math.max(...nearTop)).toBeLessThanOrEqual(0.701);           // the cabin's width, from the front outline
        expect(atCabin.points[0]).toEqual([0, expect.closeTo(0.3, 2)]); // each ring starts at the bottom of its centre line
    });

    it('narrows the slice by height band, span, top band and clearances', () => {
        const body = loftSections(BLUEPRINT, { yToMeters: 1.0, clearances: ARCHES });
        expect(Math.max(...body.flatMap(r => r.points.map(p => p[1])))).toBeLessThanOrEqual(1.0001);
        const overWheel = body.find(r => Math.abs(r.z - 1.3) < 0.03)!;
        expect(Math.min(...overWheel.points.map(p => p[1]))).toBeCloseTo(0.73, 2);   // lifted over the hub at 0.33 + 0.4
        const roof = loftSections(BLUEPRINT, { fromTopMeters: 0.04, zFromMeters: -1.0, zToMeters: 0.5 });
        expect(roof.every(r => r.z >= -1.0001 && r.z <= 0.5001)).toBe(true);
        expect(Math.min(...roof.flatMap(r => r.points.map(p => p[1])))).toBeCloseTo(1.46, 2);
        expect(loftSections(BLUEPRINT, { yFromMeters: 1.6 })).toEqual([]);
        // glass that stops under a 4 cm roof band: its top is 4 cm under the outline, so the two never share a surface
        const glass = loftSections(BLUEPRINT, { yFromMeters: 0.97, clearTopMeters: 0.04 });
        expect(Math.max(...glass.find(r => Math.abs(r.z) < 0.03)!.points.map(p => p[1]))).toBeCloseTo(1.46, 2);
    });
});

describe('specs with fromBlueprint parts', () => {
    const spec = (parts: any[], withBlueprint = true): any => ({
        subject: 'test car', observations: [], boundingMeters: [1.8, 1.5, 4.0], expectedBodies: 1, parts, ...(withBlueprint ? { blueprint: BLUEPRINT } : {})
    });
    const body = { id: 'body', label: 'body', sweep: { fromBlueprint: { yToMeters: 1.0, clearances: ARCHES } } };

    it('validates the block, needs the outlines and a root part', () => {
        expect(validateObjectBuildSpec(spec([body]))).toEqual([]);
        expect(validateObjectBuildSpec(spec([body], false))).toContainEqual(expect.stringMatching(/needs the spec's blueprint outlines/));
        const child = { ...body, id: 'c', parentId: 'body', attach: { u: 0.5, angleDeg: 0, normalOffsetMeters: 0 } };
        expect(validateObjectBuildSpec(spec([body, child]))).toContainEqual(expect.stringMatching(/part "c": a sweep lofted fromBlueprint is a root part/));
        expect(validateObjectBuildSpec(spec([{ ...body, sweep: { fromBlueprint: { yFromMeters: 1, yToMeters: 0.5 } } }]))).toContainEqual(expect.stringMatching(/yToMeters must be above yFromMeters/));
        expect(validateObjectBuildSpec(spec([{ ...body, sweep: { fromBlueprint: { clearances: [{ zMeters: 1 }] } } }]))).toContainEqual(expect.stringMatching(/clearances\[0\] needs zMeters, yMeters and a radiusMeters/));
    });

    it('keeps the build script compact: the block and the outlines, never the rings', () => {
        const s = spec([body]) as ObjectBuildSpec;
        expect(expandBlueprintParts(s).parts[0].sweep!.sections!.length).toBeGreaterThan(70);
        expect(s.parts[0].sweep!.sections).toBeUndefined();                      // the stored spec is unchanged
        const script = buildObjectSpecScript(s);
        expect(script).toContain('"fromBlueprint"');
        expect(script).toContain('"groundContacts"');
        expect(script).not.toContain('"sections"');
        expect(script.length).toBeLessThan(40_000);
    });

    it('lofts the same rings in the engine as in TypeScript, to the last digit', async () => {
        const looks = [{}, { yToMeters: 1.0, clearances: ARCHES }, { fromTopMeters: 0.04, zFromMeters: -1.0, zToMeters: 0.5, insetMeters: -0.004 }, { yFromMeters: 0.97, clearTopMeters: 0.04, insetMeters: 0.015 }];
        const run = await NativePythonRunnerService.getInstance().runScript(
            `import json\nimport scratchbox as sb\nprint("RINGS" + json.dumps([sb.object_spec.loft_sections(${JSON.stringify(BLUEPRINT)}, l) for l in ${JSON.stringify(looks)}]))\n`,
            { timeoutMs: 120_000, outputDir: TMP });
        expect(run.success, run.stderr).toBe(true);
        const engine = JSON.parse(run.stdout.slice(run.stdout.indexOf('RINGS') + 5).trim().split('\n')[0]);
        looks.forEach((l, i) => expect(engine[i]).toEqual(loftSections(BLUEPRINT, l)));
    }, 180_000);

    it('offers fromBlueprint to the spec reader only when there is a blueprint', () => {
        const sweepOf = (schema: any) => schema.properties.parts.items.properties.sweep;
        expect(sweepOf(objectBuildSpecJsonSchema({ materials: true })).properties.fromBlueprint).toBeUndefined();
        expect(sweepOf(objectBuildSpecJsonSchema({ materials: true })).required).toEqual(['controlPoints', 'closedLoop', 'smoothing', 'profile']);
        const withBp = sweepOf(objectBuildSpecJsonSchema({ materials: true, blueprint: true }));
        expect(Object.keys(withBp.properties.fromBlueprint.properties)).toEqual(['yFromMeters', 'yToMeters', 'fromTopMeters', 'clearTopMeters', 'zFromMeters', 'zToMeters', 'insetMeters', 'clearances']);
        expect(withBp.required).toEqual([]);
    });

    it('builds natively: a body with round arches and a cabin whose outlines match the blueprint', async () => {
        const cabin = { id: 'cabin', label: 'cabin', sweep: { fromBlueprint: { yFromMeters: 0.97 } } };
        // four tyres (0.2 m wide, radius 0.33) stand it on the ground at its real height; they clear the arches
        const tyres = [1.3, -1.3].flatMap(z => [0.7, -0.9].map((x, i) => ({
            id: `tyre_${z > 0 ? 'f' : 'r'}${i}`, label: 'tyre',
            revolve: { axisOrigin: [x, 0.33, z], axisDirection: [1, 0, 0], meridian: [[0, 0], [0, 0.33], [0.2, 0.33], [0.2, 0]], smoothing: 0, lobeCount: 0, lobeDepthRatio: 0, helixPitchMeters: 0 }
        })));
        const built = await buildObjectFromSpec({ ...spec([body, cabin, ...tyres]), expectedBodies: 5 }, {}, { buildTimeoutMs: 120_000, outputDir: path.join(TMP, 'build') });
        expect(built.checks.missingParts).toEqual([]);
        expect(built.checks.connectivity.bodies).toBe(5); // the lofted body and cabin are one piece; each tyre is its own
        expect(built.glb.subarray(0, 4).toString()).toBe('glTF');
        const ours = outlinesFromTriangles(glbToTriangleSoup(built.glb, { colors: false })!, BLUEPRINT);
        const c = compareOutlines(BLUEPRINT, ours);
        expect(c.meanAbsMeters['side top']).toBeLessThan(0.005);
        expect(c.meanAbsMeters['plan half width']).toBeLessThan(0.005);
        expect(c.meanAbsMeters['front half width']).toBeLessThan(0.02);
        expect(c.meanAbsMeters['side bottom']).toBeLessThan(0.04); // round tyres here, square box wheels in the test blueprint
        // the body itself lifts round each wheel: its underside over the hub is the arch, 0.73 m up
        const bodyOnly = outlinesFromTriangles(glbToTriangleSoup(built.glb, { colors: false, exclude: name => name.startsWith('tyre') })!, BLUEPRINT);
        expect(bodyOnly.side.find(s => Math.abs(s.z - 1.3) < 0.03)!.bottom).toBeCloseTo(0.73 - 0.3, 1); // read from its own lowest point, the sill at 0.3
    }, 300_000);
});

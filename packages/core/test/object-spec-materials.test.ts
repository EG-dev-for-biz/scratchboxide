/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Per-part materials in object build specs: the contract's ranges (TypeScript and the Python interpreter), and
 * what lands in the GLB when sb.object_spec.build runs in the native engine: each part's factors (base colour,
 * metalness, roughness, transmission, ior, clearcoat, emission) on its own glTF material, shared by its replicated
 * and mirrored copies; studio clay for a part without one and for every part of a clay build. Saves a material-colour
 * render and a clay render to test-results/screenshots/object_materials_*.png (gitignored).
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { glbToTriangleSoup } from '../src/node/3d-engine/part-connectivity';
import { renderReviewViews } from '../src/node/3d-engine/visual-review';
import { interpreterSpecProblems } from '../src/node/3d-engine/reference-object-builder';
import {
    buildObjectSpecScript,
    objectBuildSpecJsonSchema,
    OBJECT_BUILD_SPEC_JSON_SCHEMA,
    partsWithoutMaterial,
    validateObjectBuildSpec,
    type ObjectBuildSpec,
    type PartMaterial
} from '../src/common/spatial/object-build-spec';
import { REPO_ROOT } from './helpers/requirements';

const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results/screenshots');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-object-materials-'));
afterAll(() => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

const revolve = (meridian: Array<[number, number]>, over: Record<string, unknown> = {}) => ({
    axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], meridian, smoothing: 0, lobeCount: 0, lobeDepthRatio: 0, helixPitchMeters: 0, ...over
}) as any;

const RED_ENAMEL: PartMaterial = { description: 'gloss red enamel', baseColor: [0.6, 0.02, 0.015], roughness: 0.25, metalness: 0, transmission: 0, clearcoat: 1 };
const GLASS: PartMaterial = { description: 'clear glass', baseColor: [0.9, 0.95, 0.92], roughness: 0.05, metalness: 0, transmission: 0.95, ior: 1.52 };
const BRASS: PartMaterial = { description: 'polished brass', baseColor: [0.91, 0.78, 0.42], roughness: 0.2, metalness: 1, transmission: 0 };
const GLOW: PartMaterial = { description: 'warm glowing bulb', baseColor: [1, 0.9, 0.7], roughness: 0.4, metalness: 0, transmission: 0, emissive: [1, 0.6, 0.2], emissiveStrength: 8 };

/** A lantern-like object: an enamel base, a glass globe, brass studs (a ring replicate) and mirrored brass handles. */
function lanternSpec(): ObjectBuildSpec {
    return {
        subject: 'lantern', observations: [], boundingMeters: [0.4, 0.62, 0.4], expectedBodies: 1,
        parts: [
            { id: 'base', label: 'base', material: RED_ENAMEL, revolve: revolve([[0, 0], [0, 0.16], [0.12, 0.14], [0.12, 0]]) },
            { id: 'globe', label: 'globe', parentId: 'base', attach: { u: 1, angleDeg: 0, normalOffsetMeters: -0.01 }, material: GLASS,
                revolve: revolve([[0, 0], [0, 0.1], [0.2, 0.13], [0.38, 0.06], [0.42, 0]], { smoothing: 1 }) },
            { id: 'bulb', label: 'bulb', parentId: 'base', attach: { u: 1, angleDeg: 0, normalOffsetMeters: -0.01 }, material: GLOW,
                revolve: revolve([[0, 0], [0, 0.03], [0.12, 0.04], [0.2, 0]], { smoothing: 1 }) },
            { id: 'stud', label: 'stud', parentId: 'base', attach: { u: 0.5, angleDeg: 0, normalOffsetMeters: -0.005 }, material: BRASS,
                revolve: revolve([[-0.01, 0], [-0.01, 0.015], [0.015, 0.015], [0.02, 0]], { axisDirection: [0, 0, 1] }) },
            { id: 'studs', label: 'stud ring', replicate: { seedPartId: 'stud', ring: { centerMeters: [0, 0, 0], axisDirection: [0, 1, 0], count: 8, spanDeg: 360, risePerCopyMeters: 0 } } },
            // No material: a part left unread is studio clay, and listed by partsWithoutMaterial.
            { id: 'handle', label: 'handle', parentId: 'base', attach: { u: 0.5, angleDeg: 90, normalOffsetMeters: -0.005 }, mirrorPlaneNormal: [1, 0, 0],
                sweep: { controlPoints: [[0, 0, 0], [0.06, 0.05, 0], [0.04, 0.12, 0]], closedLoop: false, smoothing: 1,
                    profile: [{ t: 0, widthMeters: 0.02, heightMeters: 0.02, exponent: 2 }] } }
        ]
    };
}

/** The GLB's JSON chunk. */
function gltfJson(glb: Buffer): any {
    expect(glb.toString('ascii', 0, 4)).toBe('glTF');
    const length = glb.readUInt32LE(12);
    expect(glb.readUInt32LE(16)).toBe(0x4E4F534A);
    return JSON.parse(glb.toString('utf8', 20, 20 + length));
}

/** Each mesh name -> its material. */
function materialsByMesh(json: any): Map<string, any> {
    return new Map(json.meshes.map((m: any) => [m.name, json.materials[m.primitives[0].material]]));
}

async function runSpec(name: string, spec: ObjectBuildSpec, clay = false) {
    const res = await NativePythonRunnerService.getInstance().runScript(buildObjectSpecScript(spec, { clay }), { outputDir: OUT_DIR, timeoutMs: 120_000 });
    expect(res.exitCode, res.stderr).toBe(0);
    const glb = fs.readFileSync(res.glbPath!);
    const soup = glbToTriangleSoup(glb)!;
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const [view] = renderReviewViews(soup, 512, { views: [{ label: 'three-quarter view', azimuthDeg: 35, elevationDeg: 22 }], useMaterialColors: !clay });
    fs.writeFileSync(path.join(SCREENSHOT_DIR, `object_materials_${name}.png`), view.png);
    return { glb, json: gltfJson(glb), soup };
}

const close = (a: number[], b: number[], tol = 1e-4) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe('object spec materials: contract', () => {
    it('accepts a spec with materials and lists parts without one', () => {
        expect(validateObjectBuildSpec(lanternSpec())).toEqual([]);
        expect(partsWithoutMaterial(lanternSpec())).toEqual(['handle']);
    });

    it('requires a material on every sweep and revolve part when asked to, never on replicate or relief parts', () => {
        const errors = validateObjectBuildSpec(lanternSpec(), { requireMaterials: true });
        expect(errors).toEqual(['part "handle": material is required: read this part\'s surface (baseColor, roughness, metalness, transmission) from the picture']);
    });

    it('rejects every factor out of range, naming the field', () => {
        const spec = lanternSpec();
        spec.parts[0].material = { baseColor: [1.2, 0.5, -0.1], roughness: 1.5, metalness: -0.2, transmission: 2, ior: 0.8, clearcoat: 3, emissive: [0, 2, 0], emissiveStrength: 500 } as PartMaterial;
        spec.parts[1].material = { baseColor: [0.5, 0.5, 0.5], roughness: 0.5, metalness: 0, transmission: 0, emissiveStrength: 2 };
        spec.parts[2].material = 'glass' as any;
        const errors = validateObjectBuildSpec(spec);
        expect(errors).toEqual(expect.arrayContaining([
            'part "base": material.baseColor must be [r, g, b] linear RGB, each between 0 and 1',
            'part "base": material.roughness must be between 0 and 1',
            'part "base": material.metalness must be between 0 and 1',
            'part "base": material.transmission must be between 0 and 1',
            'part "base": material.ior must be between 1 and 3',
            'part "base": material.clearcoat must be between 0 and 1',
            'part "base": material.emissive must be [r, g, b] linear RGB, each between 0 and 1',
            'part "base": material.emissiveStrength must be between 0 and 100',
            'part "globe": material.emissiveStrength needs material.emissive (the colour it multiplies)',
            'part "bulb": material must be an object'
        ]));
        expect(errors).toHaveLength(10);
    });

    it('rejects a material on a replicate or relief part', () => {
        const spec = lanternSpec();
        (spec.parts[4] as any).material = BRASS;
        expect(validateObjectBuildSpec(spec)).toEqual([
            'part "studs": a replicate part has no surface of its own, so it cannot have a material; give the material to the part it copies'
        ]);
    });

    it('states the material block to the vision model only for builds with materials', () => {
        const withMaterials = objectBuildSpecJsonSchema({ materials: true }) as any;
        const item = withMaterials.properties.parts.items;
        expect(item.properties.material.required).toEqual(['baseColor', 'roughness', 'metalness', 'transmission']);
        expect(item.propertyOrdering[item.propertyOrdering.length - 1]).toBe('material');
        expect(JSON.stringify(item.properties.material)).not.toMatch(/"enum"/);
        expect(objectBuildSpecJsonSchema({ materials: false })).toBe(OBJECT_BUILD_SPEC_JSON_SCHEMA);
        expect((OBJECT_BUILD_SPEC_JSON_SCHEMA as any).properties.parts.items.properties.material).toBeUndefined();
    });

    it('writes clay=True into the build script of a clay build', () => {
        expect(buildObjectSpecScript(lanternSpec(), { clay: true })).toContain('sb.object_spec.build(SPEC, clay=True)');
        expect(buildObjectSpecScript(lanternSpec())).toContain('sb.object_spec.build(SPEC))');
    });
});

describe('object spec materials: native build', () => {
    it('writes each part\'s factors into its own glTF material, shared by its copies', async () => {
        const { json, soup } = await runSpec('lantern_pbr', lanternSpec());
        const byMesh = materialsByMesh(json);
        expect([...byMesh.keys()]).toEqual(['base', 'globe', 'bulb', 'stud', 'handle']);

        const base = byMesh.get('base');
        expect(close(base.pbrMetallicRoughness.baseColorFactor, [0.6, 0.02, 0.015, 1])).toBe(true);
        expect(base.pbrMetallicRoughness.metallicFactor).toBeCloseTo(0, 5);
        expect(base.pbrMetallicRoughness.roughnessFactor).toBeCloseTo(0.25, 5);
        expect(base.extensions.KHR_materials_clearcoat.clearcoatFactor).toBeCloseTo(1, 5);
        expect(base.extensions.KHR_materials_transmission).toBeUndefined();

        const globe = byMesh.get('globe');
        expect(globe.extensions.KHR_materials_transmission.transmissionFactor).toBeCloseTo(0.95, 5);
        expect(globe.extensions.KHR_materials_ior.ior).toBeCloseTo(1.52, 5);
        expect(globe.doubleSided).toBe(true);
        expect(globe.pbrMetallicRoughness.roughnessFactor).toBeCloseTo(0.05, 5);

        const bulb = byMesh.get('bulb');
        expect(close(bulb.emissiveFactor, [1, 0.6, 0.2])).toBe(true);
        expect(bulb.extensions.KHR_materials_emissive_strength.emissiveStrength).toBeCloseTo(8, 5);

        // The 8 replicated studs are one mesh with the seed's brass material.
        const stud = byMesh.get('stud');
        expect(close(stud.pbrMetallicRoughness.baseColorFactor, [0.91, 0.78, 0.42, 1])).toBe(true);
        expect(stud.pbrMetallicRoughness.metallicFactor).toBeCloseTo(1, 5);

        // The mirrored handles have no material: studio clay.
        const handle = byMesh.get('handle');
        expect(close(handle.pbrMetallicRoughness.baseColorFactor, [0.55, 0.57, 0.6, 1])).toBe(true);
        expect(handle.pbrMetallicRoughness.roughnessFactor).toBeCloseTo(0.85, 5);

        for (const ext of ['KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_emissive_strength']) {
            expect(json.extensionsUsed).toContain(ext);
        }
        // Vertex colours carry only grey ambient occlusion, so a viewer that multiplies COLOR_0 by baseColorFactor
        // shows the factor itself on open surfaces (not its square): the soup (base colour x vertex colour) carries the
        // enamel red exactly there, and a darker red of the same hue where another part shades it.
        const c = soup.colors!;
        let red = 0, occluded = 0;
        for (let i = 0; i < c.length; i += 3) {
            if (close([c[i], c[i + 1], c[i + 2]], [0.6, 0.02, 0.015])) red++;
            else if (c[i] > 0.06 && c[i] < 0.6 * 0.9 && Math.abs(c[i + 1] / c[i] - 0.02 / 0.6) < 0.005) occluded++;
        }
        expect(red).toBeGreaterThan(100);
        expect(occluded).toBeGreaterThan(0);
    }, 240_000);

    it('a clay build gives every part studio clay whatever the spec says', async () => {
        const { json } = await runSpec('lantern_clay', lanternSpec(), true);
        for (const [, mat] of materialsByMesh(json)) {
            expect(close(mat.pbrMetallicRoughness.baseColorFactor, [0.55, 0.57, 0.6, 1])).toBe(true);
            expect(mat.pbrMetallicRoughness.metallicFactor).toBeCloseTo(0, 5);
            expect(mat.pbrMetallicRoughness.roughnessFactor).toBeCloseTo(0.85, 5);
            expect(mat.extensions).toBeUndefined();
        }
        expect(json.extensionsUsed ?? []).toEqual([]);
    }, 240_000);

    it('the interpreter rejects out-of-range factors with the same problems as the validator', async () => {
        const spec = lanternSpec();
        spec.parts[0].material = { baseColor: [0.5, 0.5, 2], roughness: 0.5, metalness: 0, transmission: 0, ior: 9 };
        const res = await NativePythonRunnerService.getInstance().runScript(buildObjectSpecScript(spec), { outputDir: OUT_DIR, timeoutMs: 120_000 });
        expect(res.exitCode).not.toBe(0);
        const problems = interpreterSpecProblems(res.stderr || res.errorDetails || '');
        expect(problems).toEqual([
            'part "base": material.baseColor must be [r, g, b] linear RGB, each between 0 and 1',
            'part "base": material.ior must be between 1 and 3'
        ]);
        expect(validateObjectBuildSpec(spec)).toEqual(problems);
    }, 240_000);
});

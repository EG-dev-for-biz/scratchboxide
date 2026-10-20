/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * glTF renders a surface as baseColorFactor x COLOR_0. sb's apply_material used to paint the material colour into
 * COLOR_0 as well as the material, so every script scene showed its colours squared (0.8 red came out 0.64, 0.2
 * blue came out 0.04). These tests read the exported GLB and check that the effective colour of every primitive is
 * the requested linear colour exactly once, for the ways scripts give colour: apply_material on a part, a colour
 * passed to a primitive factory, parts merged into a container exported part by part, and the same container
 * exported as one primitive (where the merged copy carries each part's colour relative to the container's material).
 * A rendered screenshot of the script scene is saved to test-results/screenshots/colour_fix/.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { renderTwinInChrome, twinChrome } from './helpers/texture-twin-chrome';
import { REPO_ROOT } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'colour_fix');

interface Prim { factor: number[]; colors: number[][]; vertexCount: number }

function readPrimitives(file: string): Prim[] {
    const buf = fs.readFileSync(file);
    expect(buf.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    const bin = buf.subarray(20 + jsonLen + 8);
    const readVec4 = (accessorIdx: number): number[][] => {
        const acc = json.accessors[accessorIdx];
        expect(acc.type).toBe('VEC4');
        expect(acc.componentType).toBe(5126);
        const view = json.bufferViews[acc.bufferView];
        const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
        const stride = view.byteStride || 16;
        const out: number[][] = [];
        for (let i = 0; i < acc.count; i++) out.push([0, 1, 2, 3].map(k => bin.readFloatLE(base + i * stride + k * 4)));
        return out;
    };
    return json.meshes.flatMap((m: any) => m.primitives.map((p: any) => {
        const factor = json.materials[p.material].pbrMetallicRoughness.baseColorFactor as number[];
        const colors = p.attributes.COLOR_0 !== undefined ? readVec4(p.attributes.COLOR_0) : [];
        return { factor, colors, vertexCount: json.accessors[p.attributes.POSITION].count };
    }));
}

/** baseColorFactor x COLOR_0 per vertex (COLOR_0 absent counts as white). */
function effective(p: Prim): number[][] {
    if (!p.colors.length) return [p.factor.slice(0, 3)];
    return p.colors.map(c => [0, 1, 2].map(k => p.factor[k] * c[k]));
}

/** The distinct effective colours of a primitive, rounded to 1e-4. */
function distinct(p: Prim): string[] {
    return [...new Set(effective(p).map(c => c.map(v => v.toFixed(4)).join(',')))].sort();
}

const key = (c: number[]) => c.map(v => v.toFixed(4)).join(',');

// Requested linear colours; none is white, so a squared colour can never pass by accident.
const RED = [0.8, 0.12, 0.08];
const BLUE = [0.15, 0.35, 0.85];
const GOLD = [0.9, 0.62, 0.18];
const CONTAINER = [0.4, 0.4, 0.4];

const SCENE = `
import scratchbox as sb
scene = sb.geometry.Mesh("Colour")
body = sb.create_box(1.2, 1.2, 1.2)
body.apply_material(sb.PbrMaterial(base_color=(${RED.join(', ')}, 1.0), roughness=0.5))
scene.merge(body)
post = sb.create_cylinder(radius=0.35, height=2.0, segments=32, material=sb.PbrMaterial(base_color=(${BLUE.join(', ')}, 1.0), roughness=0.4))
post.translate(1.6, 0.0, 0.0)
scene.merge(post)
ball = sb.create_sphere(radius=0.6, color=(${GOLD.join(', ')}))
ball.translate(-1.6, 0.0, 0.0)
scene.merge(ball)
`;

describe('sb materials give each surface its colour exactly once', () => {
    it('apply_material, material= and color= parts merged into a container export with baseColorFactor x COLOR_0 = the requested colour', async () => {
        const runner = NativePythonRunnerService.getInstance();
        const result = await runner.runScript(`${SCENE}
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`, { timeoutMs: 120000 });
        expect(result.success, result.errorDetails || result.stderr).toBe(true);

        const prims = readPrimitives(result.glbPath!);
        expect(prims).toHaveLength(3);
        // each part is one uniform colour, and the three are exactly the requested ones
        for (const p of prims) {
            expect(p.vertexCount).toBeGreaterThan(20);
            expect(distinct(p)).toHaveLength(1);
        }
        expect(prims.map(p => distinct(p)[0]).sort()).toEqual([RED, BLUE, GOLD].map(key).sort());
        // the colour lives in the material, the vertex colours stay white
        for (const p of prims) for (const c of p.colors) expect(c.slice(0, 3).map(v => v.toFixed(4))).toEqual(['1.0000', '1.0000', '1.0000']);

        if (twinChrome.ok) {
            fs.mkdirSync(SHOTS, { recursive: true });
            const shot = await renderTwinInChrome(fs.readFileSync(result.glbPath!), path.join(SHOTS, 'script_scene_after.png'), { bearingDeg: 20, elevationDeg: 15, background: '#d8d8d8' });
            expect(shot.errors).toEqual([]);
            expect(fs.statSync(shot.file).size).toBeGreaterThan(10_000);
        }
    }, 180000);

    it('a container exported as one primitive keeps every merged part at its own colour, relative to the container material', async () => {
        const runner = NativePythonRunnerService.getInstance();
        const result = await runner.runScript(`
import scratchbox as sb
scene = sb.geometry.Mesh("Container")
scene.apply_material(sb.PbrMaterial(base_color=(${CONTAINER.join(', ')}, 1.0), roughness=0.6))
${SCENE.split('\n').filter(l => !l.includes('sb.geometry.Mesh("Colour")') && !l.startsWith('import')).join('\n')}
# a list export writes the container itself: one primitive, drawn with the container's material
sb.io.write_glb(OUTPUT_GLB_PATH, [scene])
`, { timeoutMs: 120000 });
        expect(result.success, result.errorDetails || result.stderr).toBe(true);

        const prims = readPrimitives(result.glbPath!);
        expect(prims).toHaveLength(1);
        expect(prims[0].factor.slice(0, 3).map(v => v.toFixed(4))).toEqual(CONTAINER.map(v => v.toFixed(4)));
        expect(distinct(prims[0])).toEqual([RED, BLUE, GOLD].map(key).sort());
    }, 180000);

    it('per-vertex shading baked after apply_material (curvature AO) darkens the requested colour, never squares it', async () => {
        const runner = NativePythonRunnerService.getInstance();
        const result = await runner.runScript(`
import scratchbox as sb
rock = sb.create_sphere(radius=1.0, rings=32, sectors=64)
rock.displace(freq=2.0, amp=0.3)
rock.apply_material(sb.PbrMaterial(base_color=(${RED.join(', ')}, 1.0)))
rock.compute_curvature_ao(0.65)
sb.io.write_glb(OUTPUT_GLB_PATH, rock)
`, { timeoutMs: 120000 });
        expect(result.success, result.errorDetails || result.stderr).toBe(true);

        const [p] = readPrimitives(result.glbPath!);
        expect(p.factor.slice(0, 3).map(v => v.toFixed(4))).toEqual(RED.map(v => v.toFixed(4)));
        const eff = effective(p);
        // AO is a grey factor on white vertices: every vertex keeps the requested hue, at most the requested value
        let lit = 0;
        for (const c of eff) {
            const s = c[0] / RED[0];
            expect(c[1] / RED[1]).toBeCloseTo(s, 4);
            expect(c[2] / RED[2]).toBeCloseTo(s, 4);
            expect(s).toBeLessThanOrEqual(1 + 1e-6);
            if (s > 0.99) lit++;
        }
        // the open surface is unshaded, i.e. exactly the requested colour (it used to be RED squared everywhere)
        expect(lit).toBeGreaterThan(0);
    }, 180000);
});

/**
 * pbr_synthesize_material on a mesh used to synthesize a texture set and then return the INPUT glb unchanged while
 * saying "Applied Adaptive PBR [height_blended_triplanar]". These tests hold the replacement to what it claims:
 * the output differs from the input, carries real PNG textures through a REPEAT sampler on every projected
 * primitive, keeps every triangle where it was, and puts each vertex's UV where the dominant-axis box projection
 * of its world position says. The scene reader that checks this shares no code with the implementation
 * (helpers/textured-glb-scene.ts), and a software render of the result is saved to test-results/screenshots/pbr.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdaptiveUvOrchestrator } from '../src/node/3d-engine/adaptive-uv-orchestrator';
import { NativeMaterialPbrService } from '../src/node/3d-engine/native-material-pbr-service';
import {
    AdaptivePbrBudgetError,
    AdaptivePbrInputError,
    AdaptivePbrMaterialSpecError,
    AdaptivePbrOutputError,
    AdaptivePbrPartSelectionError,
    AdaptivePbrTextureSynthesisError
} from '../src/node/3d-engine/adaptive-pbr-errors';
import { BOX_PROJECTION_CAPS } from '../src/node/3d-engine/adaptive-box-projection-pbr';
import { decodePng } from '../src/node/texture-processing';
import { pbrMaterialHandlers, PBR_MATERIAL_TOOL_DECLARATIONS } from '../src/node/gemini/tools/pbr-material-tools';
import { cylinderMesh, uvCubeMesh, type FixtureMesh } from './helpers/mesh-glb-fixtures';
import { saveTestScreenshot } from './helpers/test-screenshot-helper';
import {
    buildSceneGlb, dominantAxis, pngLumaStdDev, pngSize, readTexturedScene, renderTexturedScene,
    type ReadPrimitive, type SceneMeshSpec, type SceneNodeSpec
} from './helpers/textured-glb-scene';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/pbr');
const PX = 128;
const TILE = 0.5;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-box-projection-'));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const quat = (axis: [number, number, number], deg: number): [number, number, number, number] => {
    const h = (deg * Math.PI) / 360, s = Math.sin(h);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
};

/** A smooth cylinder (shared vertices, vertex colours), a cube with its own UVs, and nodes that rotate and scale them. */
function twoPartScene(opts: { groupNode?: boolean; extras?: boolean } = {}): Buffer {
    const meshes: SceneMeshSpec[] = [
        { name: 'barrel_mesh', primitives: [{ mesh: cylinderMesh(0.5, 2, 24, 8) }] },
        { name: 'block_mesh', primitives: [{ mesh: uvCubeMesh(1.0) }] }
    ];
    const nodes: SceneNodeSpec[] = [
        { name: 'barrel', mesh: 0, translation: [1, 0.5, 0], rotation: quat([1, 0, 0], 30), ...(opts.extras ? { extras: { owner: 'kept' } } : {}) },
        { name: 'block', mesh: 1, translation: [-1, 0, 0.5], rotation: quat([0, 1, 0], 40), scale: [1, 2, 1] }
    ];
    if (opts.groupNode) {
        nodes.push({ name: 'assembly', children: [0, 1] });
    }
    return buildSceneGlb(meshes, nodes, opts.extras ? { rootExtras: { project: 'kept' } } : {});
}

const run = (glb: Buffer, extra: Record<string, unknown> = {}) => AdaptiveUvOrchestrator.applyAdaptivePbr({
    inputGlbBuffer: glb, strategy: 'height_blended_triplanar', resolutionPx: PX, tileSizeMeters: TILE, ...extra
} as any);

/** Triangles of a primitive as canonical "x,y,z|x,y,z|x,y,z" strings (rotated to start at their smallest vertex, winding kept). */
function triangleSet(p: ReadPrimitive): string[] {
    const v = (i: number) => `${p.localPositions[i * 3]},${p.localPositions[i * 3 + 1]},${p.localPositions[i * 3 + 2]}`;
    const out: string[] = [];
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
        const tri = [v(p.indices[t]), v(p.indices[t + 1]), v(p.indices[t + 2])];
        const k = tri.indexOf([...tri].sort()[0]);
        out.push([tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]].join('|'));
    }
    return out.sort();
}

/** The documented mapping: dominant world-normal axis X -> (z, -y), Y -> (x, -z), Z -> (x, -y), over the tile size. */
function expectedUv(world: Float64Array, v: number, axis: number, tile: number): [number, number] {
    const pick = [[2, 1], [0, 2], [0, 1]][axis];
    return [world[v * 3 + pick[0]] / tile, -world[v * 3 + pick[1]] / tile];
}

function expectBoxProjected(p: ReadPrimitive, tile: number, uvKey = 'TEXCOORD_0'): void {
    const uv = p.uvs[uvKey];
    expect(uv, `${p.nodeName} has ${uvKey}`).toBeDefined();
    expect(uv.length / 2, `${p.nodeName}: one UV per vertex`).toBe(p.localPositions.length / 3);
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
        const [a, b, c] = [p.indices[t], p.indices[t + 1], p.indices[t + 2]];
        const axis = dominantAxis(p.worldPositions, a, b, c);
        for (const v of [a, b, c]) {
            const [u0, v0] = expectedUv(p.worldPositions, v, axis, tile);
            expect(Math.abs(uv[v * 2] - u0), `${p.nodeName} tri ${t / 3} vertex ${v} u`).toBeLessThan(1e-4);
            expect(Math.abs(uv[v * 2 + 1] - v0), `${p.nodeName} tri ${t / 3} vertex ${v} v`).toBeLessThan(1e-4);
        }
    }
}

describe('box projection replaces the pass-through', () => {
    const input = twoPartScene();
    const inScene = readTexturedScene(input);

    it('returns a GLB that differs from the input and carries materials with all three textures and a REPEAT sampler', async () => {
        const res = await run(input);
        const out = res.glbBuffer!;
        expect(out.equals(input), 'output must not be the input').toBe(false);
        expect(out.length).not.toBe(input.length);
        const scene = readTexturedScene(out);
        expect(scene.json.images.length).toBe(3); // one set shared by both parts
        expect(scene.json.textures.length).toBe(3);
        expect(scene.json.materials.length).toBe(1);
        for (const p of scene.primitives) {
            const m = scene.material(p.materialIndex)!;
            expect(m, `${p.nodeName} has a material`).toBeDefined();
            expect(m.baseColor && m.normal && m.occlusion && m.metallicRoughness).toBeTruthy();
            expect(m.occlusion!.image.equals(m.metallicRoughness!.image), 'ORM is one image for occlusion and metallic-roughness').toBe(true);
            expect(m.baseColor!.image.equals(m.normal!.image)).toBe(false);
            expect(m.baseColor!.sampler.wrapS).toBe(10497);
            expect(m.baseColor!.sampler.wrapT).toBe(10497);
            expect(m.raw.pbrMetallicRoughness.metallicFactor).toBe(1);
        }
    });

    it('embeds PNG images of the requested resolution that are not flat fills', async () => {
        const scene = readTexturedScene((await run(input)).glbBuffer!);
        const m = scene.material(scene.primitives[0].materialIndex)!;
        for (const image of [m.baseColor!.image, m.normal!.image, m.occlusion!.image]) {
            expect(pngSize(image)).toEqual([PX, PX]);
            expect(pngLumaStdDev(image), 'image holds structure, not a fill').toBeGreaterThan(0.5);
        }
        expect(pngLumaStdDev(m.baseColor!.image)).toBeGreaterThan(1);
    });

    it('honours a resolution tier', async () => {
        const res = await AdaptiveUvOrchestrator.applyAdaptivePbr({ inputGlbBuffer: input, strategy: 'height_blended_triplanar', resolution: '1K', tileSizeMeters: TILE });
        const scene = readTexturedScene(res.glbBuffer!);
        expect(pngSize(scene.material(scene.primitives[0].materialIndex)!.baseColor!.image)).toEqual([1024, 1024]);
    });

    it('gives every projected primitive a TEXCOORD_0 with one UV per vertex, and keeps the node transforms', async () => {
        const out = readTexturedScene((await run(input)).glbBuffer!);
        expect(out.primitives.length).toBe(inScene.primitives.length);
        for (const p of out.primitives) expect(p.uvs.TEXCOORD_0.length / 2).toBe(p.localPositions.length / 3);
        expect(out.json.nodes).toEqual(inScene.json.nodes);
    });

    it('keeps every original triangle at the same position (compared as a set of position triples)', async () => {
        const out = readTexturedScene((await run(input)).glbBuffer!);
        for (const before of inScene.primitives) {
            const after = out.primitives.find(p => p.nodeName === before.nodeName)!;
            expect(after.uvs.TEXCOORD_0, 'the primitive was projected, not passed through').toBeDefined();
            expect(out.material(after.materialIndex)?.baseColor, 'and textured').toBeDefined();
            expect(triangleSet(after)).toEqual(triangleSet(before));
        }
    });

    it('puts every vertex UV where the dominant-axis projection of its world position / tile size says', async () => {
        const out = readTexturedScene((await run(input)).glbBuffer!);
        for (const p of out.primitives) expectBoxProjected(p, TILE);
    });

    it('splits vertices exactly where a triangle\'s axis differs from its neighbours (no more, no fewer)', async () => {
        const res = await run(input);
        const out = readTexturedScene(res.glbBuffer!);
        for (const before of inScene.primitives) {
            const after = out.primitives.find(p => p.nodeName === before.nodeName)!;
            const pairs = new Set<string>();
            for (let t = 0; t + 2 < before.indices.length; t += 3) {
                const axis = dominantAxis(before.worldPositions, before.indices[t], before.indices[t + 1], before.indices[t + 2]);
                for (let k = 0; k < 3; k++) pairs.add(`${before.indices[t + k]}:${axis}`);
            }
            expect(after.localPositions.length / 3, `${before.nodeName}: vertices = distinct (vertex, axis) pairs`).toBe(pairs.size);
        }
        const barrel = out.primitives.find(p => p.nodeName === 'barrel')!;
        expect(barrel.localPositions.length).toBeGreaterThan(inScene.primitives.find(p => p.nodeName === 'barrel')!.localPositions.length);
        expect(res.boxProjection!.report.verticesAfter).toBeGreaterThan(res.boxProjection!.report.verticesBefore);
    });

    it('removes the geometry it replaced instead of leaving orphans, and drops stale TANGENT / COLOR_0 by default', async () => {
        const res = await run(input);
        const scene = readTexturedScene(res.glbBuffer!);
        // barrel: POSITION, NORMAL (computed by the fixture reader? no: absent), TEXCOORD_0, indices; cube likewise
        const referenced = new Set<number>();
        scene.json.meshes.forEach((m: any) => m.primitives.forEach((p: any) => { Object.values(p.attributes).forEach((a: any) => referenced.add(a)); referenced.add(p.indices); }));
        expect(scene.json.accessors.length, 'every accessor is used').toBe(referenced.size);
        expect(res.boxProjection!.report.geometryCleanup.performed).toBe(true);
        expect(res.boxProjection!.report.geometryCleanup.removedAccessors).toBeGreaterThan(0);
        for (const p of scene.primitives) {
            expect(p.attributeKeys).not.toContain('COLOR_0');
            expect(p.attributeKeys).not.toContain('TANGENT');
        }
        expect(res.boxProjection!.report.droppedAttributes.COLOR_0).toBe(1);
        expect(scene.bin.length).toBeLessThan(input.length + 3 * 3 * PX * PX * 4);
    });

    it('keeps vertex colours when asked', async () => {
        const res = await run(input, { preserveVertexColors: true });
        const scene = readTexturedScene(res.glbBuffer!);
        const barrel = scene.primitives.find(p => p.nodeName === 'barrel')!;
        expect(scene.material(barrel.materialIndex)?.baseColor, 'the primitive was textured').toBeDefined();
        expect(barrel.uvs.TEXCOORD_0).toBeDefined();
        expect(barrel.attributeKeys).toContain('COLOR_0');
        const acc = scene.json.accessors[scene.json.meshes[0].primitives[0].attributes.COLOR_0];
        expect(acc.count).toBe(barrel.localPositions.length / 3);
    });

    it('replaces TEXCOORD_0 by default and keeps it (box UVs go to TEXCOORD_1) when asked', async () => {
        const block = inScene.primitives.find(p => p.nodeName === 'block')!;
        const replaced = readTexturedScene((await run(input)).glbBuffer!).primitives.find(p => p.nodeName === 'block')!;
        expect(Object.keys(replaced.uvs)).toEqual(['TEXCOORD_0']);
        expectBoxProjected(replaced, TILE);

        const res = await run(input, { preserveExistingUvs: true });
        const kept = readTexturedScene(res.glbBuffer!);
        const outBlock = kept.primitives.find(p => p.nodeName === 'block')!;
        expect(Object.keys(outBlock.uvs).sort()).toEqual(['TEXCOORD_0', 'TEXCOORD_1']);
        expectBoxProjected(outBlock, TILE, 'TEXCOORD_1');
        // every (position, original uv) pair of the input survives in TEXCOORD_0
        const pair = (p: ReadPrimitive, key: string, v: number) => `${p.localPositions.slice(v * 3, v * 3 + 3).join(',')}@${p.uvs[key].slice(v * 2, v * 2 + 2).join(',')}`;
        const before = new Set(Array.from({ length: block.localPositions.length / 3 }, (_, v) => pair(block, 'TEXCOORD_0', v)));
        const after = new Set(Array.from({ length: outBlock.localPositions.length / 3 }, (_, v) => pair(outBlock, 'TEXCOORD_0', v)));
        expect(after).toEqual(before);
        expect(kept.material(outBlock.materialIndex)!.baseColor!.texCoord).toBe(1);
        // the barrel had no UVs, so its box UVs are TEXCOORD_0
        expect(kept.material(kept.primitives.find(p => p.nodeName === 'barrel')!.materialIndex)!.baseColor!.texCoord).toBe(0);
        expect(res.boxProjection!.report.uvSets).toEqual({ TEXCOORD_0: 1, TEXCOORD_1: 1 });
    });

    it('keeps non-targeted data: root and node extras, non-triangle primitives (reported, untouched)', async () => {
        const meshes: SceneMeshSpec[] = [
            { name: 'barrel_mesh', primitives: [{ mesh: cylinderMesh(0.5, 2, 12, 4) }, { mesh: { positions: [0, 0, 0, 1, 1, 1], indices: [0, 1] }, mode: 1 }] }
        ];
        const glb = buildSceneGlb(meshes, [{ name: 'barrel', mesh: 0, extras: { owner: 'kept' } }], { rootExtras: { project: 'kept' } });
        const res = await run(glb);
        const scene = readTexturedScene(res.glbBuffer!);
        expect(scene.json.extras).toEqual({ project: 'kept' });
        expect(scene.json.nodes[0].extras).toEqual({ owner: 'kept' });
        const line = scene.primitives.find(p => p.mode === 1)!;
        expect(Array.from(line.localPositions)).toEqual([0, 0, 0, 1, 1, 1]);
        expect(line.materialIndex).toBeUndefined();
        expect(res.boxProjection!.report.skippedNonTrianglePrimitives).toEqual([{ nodeIndex: 0, nodeName: 'barrel', primitiveIndex: 1, mode: 1 }]);
        expect(res.boxProjection!.report.projectedPrimitives).toBe(1);
    });

    it('projects a mesh shared by two nodes in each node\'s own world placement', async () => {
        const glb = buildSceneGlb(
            [{ name: 'post', primitives: [{ mesh: cylinderMesh(0.3, 1, 12, 3) }] }],
            [{ name: 'left', mesh: 0, translation: [0, 0, 0] }, { name: 'right', mesh: 0, translation: [3.3, 0.7, 0], rotation: quat([0, 0, 1], 25) }]);
        const scene = readTexturedScene((await run(glb)).glbBuffer!);
        expect(scene.primitives.length).toBe(2);
        expect(scene.json.meshes.length, 'one mesh per placement, no unused original left behind').toBe(2);
        scene.primitives.forEach(p => expectBoxProjected(p, TILE));
    });

    it('records the tile size, texel density and method that actually ran', async () => {
        const res = await run(input);
        expect(res.appliedStrategy).toBe('height_blended_triplanar');
        expect(res.appliedMethod.method).toBe('box_projection_uv');
        expect(res.appliedMethod.differsFromStrategy).toBe(true);
        expect(res.appliedMethod.note).toMatch(/not implemented here/);
        const g = res.boxProjection!.groups[0];
        expect(g.tileSize).toMatchObject({ meters: TILE, source: 'request' });
        expect(g.tileSize.texelsPerMeter).toBeCloseTo(PX / TILE, 6);
    });

    it('labels a derived default tile size and the default material instead of passing them off as asked for', async () => {
        const res = await run(input, { tileSizeMeters: undefined });
        const g = res.boxProjection!.groups[0];
        expect(g.tileSize.source).toBe('derived');
        expect(g.tileSize.derivation!.formula).toMatch(/fissureScale/);
        expect(g.tileSize.meters).toBeGreaterThan(0);
        expect(res.boxProjection!.inferred.join('\n')).toMatch(/tile size .* is derived, not asked for/);
        expect(res.boxProjection!.inferred.join('\n')).toMatch(/no material was given, so the tool default indiana_limestone/);
        expect(res.boxProjection!.textureSets[0].materialSource).toBe('tool_default_indiana_limestone');
    });

    it('saves a software render of the textured result and of the input for comparison', async () => {
        const res = await run(twoPartScene(), { partMaterials: [{ nodes: ['barrel'], materialArchetype: 'polished_brass', tileSizeMeters: 0.25 }, { nodes: ['block'], materialArchetype: 'quartersawn_walnut', tileSizeMeters: 0.5 }] });
        const after = renderTexturedScene(readTexturedScene(res.glbBuffer!));
        const before = renderTexturedScene(readTexturedScene(input));
        saveTestScreenshot('adaptive_pbr_box_projection_two_parts_after', after.png, { dir: SHOTS });
        saveTestScreenshot('adaptive_pbr_box_projection_two_parts_before', before.png, { dir: SHOTS });
        expect(after.coveredPixels).toBeGreaterThan(8000);
        expect(after.png.equals(before.png), 'the textured render differs from the untextured one').toBe(false);
        expect(after.lumaStdDev, 'the textured render has structure').toBeGreaterThan(8);
    });
});

describe('per-part material assignment', () => {
    const input = twoPartScene();

    it('gives two parts two different materials with different texture images', async () => {
        const res = await run(input, { partMaterials: [{ nodes: ['barrel'], materialArchetype: 'polished_brass' }, { nodes: ['block'], materialArchetype: 'quartersawn_walnut' }] });
        const scene = readTexturedScene(res.glbBuffer!);
        const barrel = scene.primitives.find(p => p.nodeName === 'barrel')!, block = scene.primitives.find(p => p.nodeName === 'block')!;
        expect(barrel.materialIndex).not.toBe(block.materialIndex);
        expect(scene.json.materials.length).toBe(2);
        expect(scene.json.images.length).toBe(6);
        const mb = scene.material(barrel.materialIndex)!, mk = scene.material(block.materialIndex)!;
        expect(mb.baseColor!.image.equals(mk.baseColor!.image)).toBe(false);
        expect(mb.raw.extras.scratchbox.textureSet).toMatch(/^polished_brass/);
        expect(mk.raw.extras.scratchbox.textureSet).toMatch(/^quartersawn_walnut/);
        expect(res.boxProjection!.textureSets.map(s => s.archetypeKey)).toEqual(['polished_brass', 'quartersawn_walnut']);
        // brass is a metal, walnut is not: the packed ORM blue channel (metallic) says so in the embedded image
        const metallic = (png: Buffer) => decodePng(png).rgba[2];
        expect(metallic(mb.metallicRoughness!.image)).toBeGreaterThan(200);
        expect(metallic(mk.metallicRoughness!.image)).toBeLessThan(40);
    });

    it('shares one texture set between parts whose material is the same, each keeping its own tile size', async () => {
        const res = await run(input, { partMaterials: [
            { nodes: ['barrel'], materialArchetype: 'polished_brass', tileSizeMeters: 0.25 },
            { nodes: ['block'], materialArchetype: 'polished_brass', tileSizeMeters: 1 }
        ] });
        const scene = readTexturedScene(res.glbBuffer!);
        expect(scene.json.images.length).toBe(3);
        expect(scene.json.materials.length).toBe(1);
        expect(res.boxProjection!.textureSets.length).toBe(1);
        expect(res.boxProjection!.textureSets[0].usedByGroups.length).toBe(2);
        expectBoxProjected(scene.primitives.find(p => p.nodeName === 'barrel')!, 0.25);
        expectBoxProjected(scene.primitives.find(p => p.nodeName === 'block')!, 1);
    });

    it('selects by node name, mesh name, node index and the nearest named group, never by looser matching', async () => {
        const grouped = twoPartScene({ groupNode: true });
        const byMesh = await run(grouped, { partMaterials: [{ nodes: ['barrel_mesh'], materialArchetype: 'polished_brass' }, { nodes: [1], materialArchetype: 'wrought_iron' }] });
        expect(byMesh.boxProjection!.groups.map(g => [g.name, g.nodes.map(n => n.nodeName)])).toEqual([['partMaterials[0]', ['barrel']], ['partMaterials[1]', ['block']]]);

        // a group entry covers what is under it; the more specific entry wins for its own node
        const byGroup = await run(grouped, { partMaterials: [{ nodes: ['assembly'], materialArchetype: 'polished_brass' }, { nodes: ['block'], materialArchetype: 'wrought_iron' }] });
        const names = byGroup.boxProjection!.groups.map(g => [g.textureSet.split('_set')[0], g.nodes.map(n => n.nodeName)]);
        expect(names).toEqual([['polished_brass', ['barrel']], ['wrought_iron', ['block']]]);

        // exactness: case and substring differences do not match
        for (const wrong of ['Barrel', 'barre', 'barrel ']) {
            await expect(run(input, { partMaterials: [{ nodes: [wrong], materialArchetype: 'polished_brass' }] })).rejects.toBeInstanceOf(AdaptivePbrPartSelectionError);
        }
    });

    it('fails with the list of real names when an assignment names a node that does not exist', async () => {
        const err: any = await run(input, { partMaterials: [{ nodes: ['barrel', 'tube_housing'], materialArchetype: 'polished_brass' }] }).catch(e => e);
        expect(err).toBeInstanceOf(AdaptivePbrPartSelectionError);
        expect(err.message).toContain('"tube_housing"');
        expect(err.message).toContain('#0 node "barrel"');
        expect(err.message).toContain('#1 node "block"');
        expect(err.availableParts).toEqual([expect.stringContaining('"barrel"'), expect.stringContaining('"block"')]);
    });

    it('rejects two entries that name the same part, an empty entry, and an entry that selects nothing renderable', async () => {
        await expect(run(input, { partMaterials: [{ nodes: ['barrel'], materialArchetype: 'polished_brass' }, { nodes: ['barrel_mesh'], materialArchetype: 'wrought_iron' }] }))
            .rejects.toThrow(/both name node #0/);
        await expect(run(input, { partMaterials: [{ nodes: [], materialArchetype: 'polished_brass' }] })).rejects.toBeInstanceOf(AdaptivePbrPartSelectionError);
        await expect(run(twoPartScene({ groupNode: true }), { partMaterials: [{ nodes: ['assembly'], materialArchetype: 'polished_brass' }, { nodes: ['barrel'], materialArchetype: 'wrought_iron' }, { nodes: ['block'], materialArchetype: 'quartersawn_walnut' }, { nodes: [2] }] }))
            .rejects.toThrow(/nothing at or below it renders triangles/);
    });

    it('gives parts no entry names the request-level material, and says so', async () => {
        const res = await run(input, { materialArchetype: 'wrought_iron', partMaterials: [{ nodes: ['barrel'], materialArchetype: 'polished_brass' }] });
        const sets = res.boxProjection!.textureSets;
        expect(sets.map(s => s.archetypeKey)).toEqual(['polished_brass', 'wrought_iron']);
        expect(res.boxProjection!.groups.find(g => g.entryIndex === null)!.nodes.map(n => n.nodeName)).toEqual(['block']);
    });

    it('applies descriptor overrides over an archetype and a descriptor alone, and rejects what it cannot use', async () => {
        const over = await run(input, { partMaterials: [{ nodes: ['barrel'], materialArchetype: 'polished_brass', descriptor: { roughnessBaseline: 0.6 } }, { nodes: ['block'], descriptor: { albedoLinear: [0.1, 0.4, 0.9], conduction: 0.0, roughnessBaseline: 0.3 } }] });
        const [brass, custom] = over.boxProjection!.textureSets;
        expect(brass.materialSource).toBe('archetype_with_descriptor_overrides');
        expect(brass.descriptor.roughnessBaseline).toBe(0.6);
        expect(brass.descriptor.conduction).toBe(0.95);
        expect(custom.materialSource).toBe('descriptor');
        expect(custom.unspecifiedDescriptorFields).toContain('fissureScale');
        await expect(run(input, { partMaterials: [{ nodes: ['block'], descriptor: { albedoLinear: [0.1, 0.4, 0.9] } }] })).rejects.toThrow(/must give albedoLinear, conduction, roughnessBaseline; missing conduction, roughnessBaseline/);
        await expect(run(input, { partMaterials: [{ nodes: ['block'], materialArchetype: 'polished_brass', descriptor: { shininess: 3 } as any }] })).rejects.toThrow(/unknown field "shininess"/);
        await expect(run(input, { partMaterials: [{ nodes: ['block'], materialArchetype: 'polished_brass', descriptor: { conduction: 'high' } as any }] })).rejects.toBeInstanceOf(AdaptivePbrMaterialSpecError);
    });

    it('does not replace an unknown archetype by another material: it fails with the catalog keys', async () => {
        const err: any = await run(input, { materialArchetype: 'cor_ten_steel' }).catch(e => e);
        expect(err).toBeInstanceOf(AdaptivePbrMaterialSpecError);
        expect(err.message).toContain('corten_steel');
        expect(err.message).toContain('polished_brass');
        expect(NativeMaterialPbrService.prototype.findArchetype.call({}, 'nothing_like_this')).toBeUndefined();
    });
});

describe('caps are enforced and reported in the error', () => {
    const manyParts = (n: number) => buildSceneGlb(
        [{ name: 'plate', primitives: [{ mesh: uvCubeMesh(0.2) }] }],
        Array.from({ length: n }, (_, i) => ({ name: `part_${i}`, mesh: 0, translation: [i * 0.5, 0, 0] as [number, number, number] })));
    const distinct = (n: number) => Array.from({ length: n }, (_, i) => ({ nodes: [`part_${i}`], descriptor: { albedoLinear: [i / 20, 0.5, 0.5] as [number, number, number], conduction: 0.1, roughnessBaseline: 0.5 } }));

    it('fails above 12 distinct texture sets, and accepts 12', async () => {
        const err: any = await run(manyParts(13), { partMaterials: distinct(13) }).catch(e => e);
        expect(err).toBeInstanceOf(AdaptivePbrBudgetError);
        expect(err.message).toMatch(/13 distinct materials.*cap is 12/);
        expect(BOX_PROJECTION_CAPS.maxDistinctTextureSets).toBe(12);
        const ok = await run(manyParts(12), { partMaterials: distinct(12), resolutionPx: 32 });
        expect(ok.boxProjection!.textureSets.length).toBe(12);
    });

    it('fails above the per-set resolution cap instead of reducing it, for tiers and for pixel counts', async () => {
        for (const extra of [{ resolutionPx: 8192 }, { resolutionPx: undefined, resolution: '8K' }, { resolutionPx: undefined, resolution: '12K' }]) {
            const err: any = await run(twoPartScene(), extra).catch(e => e);
            expect(err, JSON.stringify(extra)).toBeInstanceOf(AdaptivePbrBudgetError);
            expect(err.message).toMatch(/cap of 4096px per set/);
        }
        await expect(run(twoPartScene(), { resolutionPx: undefined, resolution: '3K' })).rejects.toThrow(/Unknown resolution "3K"/);
    });

    it('fails above the total texel cap', async () => {
        const err: any = await run(manyParts(5), { partMaterials: distinct(5), resolutionPx: 4096 }).catch(e => e);
        expect(err).toBeInstanceOf(AdaptivePbrBudgetError);
        expect(err.message).toContain(String(BOX_PROJECTION_CAPS.maxTotalTexels));
    });
});

describe('failure modes are typed errors, never a pass-through', () => {
    it('no input path or buffer', async () => {
        await expect(AdaptiveUvOrchestrator.applyAdaptivePbr({} as any)).rejects.toBeInstanceOf(AdaptivePbrInputError);
        await expect(AdaptiveUvOrchestrator.applyAdaptivePbr({ inputGlbPath: path.join(work, 'missing.glb') })).rejects.toThrow(/Cannot read the input mesh/);
    });

    it('input that is not a GLB', async () => {
        await expect(run(Buffer.from('this is not a glb file at all, just text'))).rejects.toThrow(/not a binary glTF/);
    });

    it('a triangle primitive without a POSITION attribute', async () => {
        const glb = buildSceneGlb([{ name: 'broken', primitives: [{ mesh: cylinderMesh(0.5, 1, 8, 2), omitPosition: true }] }], [{ name: 'broken', mesh: 0 }]);
        const err: any = await run(glb).catch(e => e);
        expect(err).toBeInstanceOf(AdaptivePbrInputError);
        expect(err.message).toMatch(/no POSITION attribute/);
    });

    it('a mesh with nothing but lines has no triangles to texture', async () => {
        const glb = buildSceneGlb([{ primitives: [{ mesh: { positions: [0, 0, 0, 1, 0, 0], indices: [0, 1] }, mode: 1 }] }], [{ name: 'wire', mesh: 0 }]);
        await expect(run(glb)).rejects.toThrow(/renders no triangle primitives/);
    });

    it('a texture synthesis failure, and a truncated synthesis result, write nothing', async () => {
        const out = path.join(work, 'must_not_exist.glb');
        vi.spyOn(NativeMaterialPbrService.prototype, 'synthesizeContinuousManifoldPbr').mockRejectedValueOnce(new Error('clang++ not found'));
        const err: any = await run(twoPartScene(), { outputPath: out }).catch(e => e);
        expect(err).toBeInstanceOf(AdaptivePbrTextureSynthesisError);
        expect(err.message).toContain('clang++ not found');
        expect(fs.existsSync(out)).toBe(false);

        vi.restoreAllMocks();
        const real = NativeMaterialPbrService.prototype.synthesizeContinuousManifoldPbr;
        vi.spyOn(NativeMaterialPbrService.prototype, 'synthesizeContinuousManifoldPbr').mockImplementationOnce(async function (this: NativeMaterialPbrService, ...a: any[]) {
            const set: any = await (real as any).apply(this, a);
            return { ...set, normalRgba: set.normalRgba.subarray(0, 100) };
        });
        const truncated: any = await run(twoPartScene(), { outputPath: out }).catch(e => e);
        expect(truncated).toBeInstanceOf(AdaptivePbrTextureSynthesisError);
        expect(truncated.message).toMatch(/incomplete map/);
        expect(fs.existsSync(out)).toBe(false);
    });

    it('UVs that float32 cannot resolve at the texture size', async () => {
        const err: any = await run(twoPartScene(), { tileSizeMeters: 1e-6 }).catch(e => e);
        expect(err).toBeInstanceOf(AdaptivePbrInputError);
        expect(err.message).toMatch(/float32 resolves only/);
        await expect(run(twoPartScene(), { tileSizeMeters: -1 })).rejects.toThrow(/positive number of metres/);
    });

    it('MaterialX / USDZ are refused by the strategies that create no texture set', async () => {
        for (const strategy of ['recipe_hybrid', 'elevation_stratified_conformal']) {
            await expect(run(twoPartScene(), { strategy, formats: ['glb', 'materialx'], outputPath: path.join(work, 'x.glb') })).rejects.toBeInstanceOf(AdaptivePbrOutputError);
        }
    });

    it('an output that cannot be written', async () => {
        const blocker = path.join(work, 'a_file');
        fs.writeFileSync(blocker, 'x');
        await expect(run(twoPartScene(), { outputPath: path.join(blocker, 'nested', 'out.glb') })).rejects.toBeInstanceOf(AdaptivePbrOutputError);
    });
});

describe('MaterialX and USDZ outputs reference files that exist', () => {
    it('writes the Albedo / Normal / ORM PNGs beside the .mtlx and packs the same maps into the .usdz', async () => {
        const dir = fs.mkdtempSync(path.join(work, 'exports-'));
        const outputPath = path.join(dir, 'asset.glb');
        const res = await run(twoPartScene(), { outputPath, formats: ['glb', 'materialx', 'usdz'], materialArchetype: 'polished_brass' });
        for (const f of ['asset.glb', 'asset.mtlx', 'asset.usdz', 'asset_Albedo.png', 'asset_Normal.png', 'asset_ORM.png']) {
            expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
        }
        const mtlx = fs.readFileSync(path.join(dir, 'asset.mtlx'), 'utf8');
        for (const f of ['asset_Albedo.png', 'asset_Normal.png', 'asset_ORM.png']) {
            expect(mtlx, `the .mtlx references ${f}`).toContain(f);
            const png = fs.readFileSync(path.join(dir, f));
            expect(pngSize(png)).toEqual([PX, PX]);
        }
        const usdz = fs.readFileSync(path.join(dir, 'asset.usdz'));
        expect(usdz.toString('latin1', 0, 2)).toBe('PK');
        expect(usdz.toString('latin1')).toContain('textures/albedo.png');
        // the usdz carries real PNG bytes, not the raw RGB the old code handed it
        const albedo = fs.readFileSync(path.join(dir, 'asset_Albedo.png'));
        expect(usdz.includes(albedo)).toBe(true);
        expect(Object.keys(res.outputFiles).sort()).toEqual(['albedo', 'glb', 'materialx', 'normal', 'orm', 'usdz']);
        expect(res.materialxXml).toBe(mtlx);
    });

    it('writes one set of files per distinct texture set', async () => {
        const dir = fs.mkdtempSync(path.join(work, 'exports-multi-'));
        const res = await run(twoPartScene(), { outputPath: path.join(dir, 'asset.glb'), formats: ['glb', 'materialx'], partMaterials: [{ nodes: ['barrel'], materialArchetype: 'polished_brass' }, { nodes: ['block'], materialArchetype: 'quartersawn_walnut' }] });
        const files = fs.readdirSync(dir).sort();
        expect(files).toEqual([
            'asset.glb',
            'asset_polished_brass_set0.mtlx', 'asset_polished_brass_set0_Albedo.png', 'asset_polished_brass_set0_Normal.png', 'asset_polished_brass_set0_ORM.png',
            'asset_quartersawn_walnut_set1.mtlx', 'asset_quartersawn_walnut_set1_Albedo.png', 'asset_quartersawn_walnut_set1_Normal.png', 'asset_quartersawn_walnut_set1_ORM.png'
        ]);
        expect(res.outputFiles['materialx_quartersawn_walnut_set1']).toBe(path.join(dir, 'asset_quartersawn_walnut_set1.mtlx'));
    });
});

describe('pbr_synthesize_material on a mesh (the tool, end to end)', () => {
    const mesh = path.join(work, 'tool_input.glb');
    beforeAll(() => fs.writeFileSync(mesh, twoPartScene()));

    it('declares partMaterials with an item schema and the new options', () => {
        const props: any = PBR_MATERIAL_TOOL_DECLARATIONS.find(d => d.name === 'pbr_synthesize_material')!.parameters!.properties!;
        expect(props.partMaterials.type).toBe('ARRAY');
        expect(Object.keys(props.partMaterials.items.properties).sort()).toEqual(['descriptor', 'materialArchetype', 'nodes', 'tileSizeMeters']);
        expect(props.partMaterials.items.required).toEqual(['nodes']);
        expect(props.partMaterials.description).toMatch(/exact/i);
        expect(props.partMaterials.description).toMatch(/12 distinct sets/);
        for (const k of ['tileSizeMeters', 'preserveExistingUvs', 'preserveVertexColors']) expect(props[k], k).toBeDefined();
        expect(props.archetype.description).toContain('corten_steel');
    });

    it('returns a real GLB, names the method that ran, and does not claim the triplanar strategy was applied', async () => {
        const outDir = path.join(work, 'tool_out');
        const res = await pbrMaterialHandlers.pbr_synthesize_material({
            targetMeshPath: mesh, outputDir: outDir, resolution: '1K', uvTilingX: 4,
            partMaterials: [{ nodes: ['barrel'], materialArchetype: 'polished_brass' }, { nodes: ['block'], materialArchetype: 'quartersawn_walnut' }]
        }, {} as any) as any;
        const out = path.join(outDir, 'tool_input_adaptive_pbr.glb');
        expect(fs.existsSync(out)).toBe(true);
        expect(fs.readFileSync(out).equals(fs.readFileSync(mesh))).toBe(false);
        const scene = readTexturedScene(fs.readFileSync(out));
        expect(scene.json.images.length).toBe(6);
        expect(res.summaryResult).toMatch(/Method run: box_projection_uv/);
        expect(res.summaryResult).toMatch(/height_blended_triplanar.*was NOT run as such/);
        expect(res.summaryResult).not.toMatch(/Applied Adaptive PBR \[height_blended_triplanar\]/);
        expect(res.summaryResult).toMatch(/Not used by this method: uvTilingX/);
        expect(res.resultPayload.appliedMethod).toMatchObject({ method: 'box_projection_uv', differsFromStrategy: true });
        expect(res.resultPayload.recommendedSeamStrategy).toBeDefined();
        expect(res.resultPayload.seamStrategy).toBeUndefined();
        expect(res.resultPayload.boxProjection.textureSets.length).toBe(2);
        expect(res.resultPayload.ignoredOptions).toContain('uvTilingX');
        expect(res.resultPayload.outputBytes).toBe(fs.statSync(out).size);
        expect(JSON.stringify(res.resultPayload).length).toBeLessThan(60_000);
    });

    it('fails with a typed error, not a summary, when a named part is not in the scene', async () => {
        await expect(pbrMaterialHandlers.pbr_synthesize_material({
            targetMeshPath: mesh, outputDir: path.join(work, 'tool_out2'), resolution: '1K', partMaterials: [{ nodes: ['no_such_part'], materialArchetype: 'polished_brass' }]
        }, {} as any)).rejects.toBeInstanceOf(AdaptivePbrPartSelectionError);
        expect(fs.existsSync(path.join(work, 'tool_out2', 'tool_input_adaptive_pbr.glb'))).toBe(false);
    });

    it('passes the request-level archetype, descriptor, seed and non-square refusal through instead of ignoring them', async () => {
        const res = await pbrMaterialHandlers.pbr_synthesize_material({ targetMeshPath: mesh, outputDir: path.join(work, 'tool_out3'), resolution: '1K', archetype: 'wrought_iron', descriptor: { roughnessBaseline: 0.9 }, seed: 7, tileSizeMeters: 0.4 }, {} as any) as any;
        const set = res.resultPayload.boxProjection.textureSets[0];
        expect(set).toMatchObject({ archetypeKey: 'wrought_iron', materialSource: 'archetype_with_descriptor_overrides', seed: 7 });
        expect(set.descriptor.roughnessBaseline).toBe(0.9);
        expect(res.resultPayload.boxProjection.groups[0].tileSize).toMatchObject({ meters: 0.4, source: 'request' });
        await expect(pbrMaterialHandlers.pbr_synthesize_material({ targetMeshPath: mesh, outputDir: path.join(work, 'tool_out4'), width: 1024, height: 512 }, {} as any)).rejects.toBeInstanceOf(AdaptivePbrMaterialSpecError);
    });
});

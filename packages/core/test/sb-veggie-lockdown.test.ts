/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * SB-Veggie is the one vegetation generator of every 3D path (2026-10-22): an imagined scene's trees (sb.create_tree in
 * an sb Python script, the agent's default route for imagined scenes) are grown by the same native planting a staged
 * place's trees are (space colonisation, SB-Veggie leaf clusters, species and texture libraries, four levels of detail)
 * and written into the scene's GLB; the retired generators (bare space colonisation, L-system, plant presets, primitive
 * lollipops) are not reachable from scripts, generator code, viewport scripts, document morphs or object specs.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { python3DHandlers, sbVeggieOf } from '../src/node/gemini/tools/python-3d-tools';
import { typeCheckSbScript } from '../src/node/3d-engine/sb-script-typecheck';
import { cppVegetationViolations, scriptVegetationViolations, RETIRED_CPP_VEGETATION_SYMBOLS } from '../src/common/spatial/sb-veggie-lockdown';
import { generateDefaultCpp3DSource, natureWorldPythonSource, synthesizeContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { executeDynamicThreeScript } from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import { CORE_WORKSPACE_PACK, MESH_SURFACE_PACK } from '../src/node/gemini/domain-tool-packs';
import { ENTRY_TOOL_NAMES } from '../src/node/gemini/tool-catalog';
import { BOTANICAL_TREE_TOOL_DECLARATIONS } from '../src/node/gemini/tools/botanical-tree-tools';
import { validateObjectBuildSpec, type ObjectBuildSpec } from '../src/common/spatial/object-build-spec';
import { measureBuild } from '../src/node/3d-engine/reference-object-builder';
import { SB_PYTHON_SCRIPT_GUIDE, SPATIAL_INTENT_POLICY } from '../src/node/gemini/prompt-builder';
import { parseGlb } from './helpers/clay-glb-render';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/sb_veggie_lockdown');

function glbJson(buf: Buffer): any {
    expect(buf.subarray(0, 4).toString('latin1')).toBe('glTF');
    expect(buf.readUInt32LE(8)).toBe(buf.length);
    return parseGlb(buf).json;
}

/** Every SB-Veggie tree node (extras sbTree) of a GLB, with its level-of-detail children. */
function treeNodes(json: any): Array<{ node: any; levels: any[] }> {
    const nodes: any[] = json.nodes ?? [];
    return nodes.filter(n => n?.extras?.sbTree).map(node => ({ node, levels: (node.children ?? []).map((i: number) => nodes[i]) }));
}

const GROVE_SCRIPT = `
import scratchbox as sb

scene = sb.geometry.Mesh("Grove")
ground = sb.create_box(size=(30.0, 0.2, 30.0))
ground.translate(0.0, -0.1, 0.0)
scene.merge(ground)
scene.merge(sb.create_tree(position=(0.0, 0.0, 0.0), height=11.0, crown_radius=4.2, leaf_color="#4f6b2a", label="broad crown"))
scene.merge(sb.create_tree(position=(8.0, 0.0, 4.0), height=14.0, crown_radius=2.2, crown_widest_at=0.05, crown_top_exponent=1.0, crown_base_height=1.0, label="narrow cone"))
grove = sb.geometry.Mesh("Shrubs")
grove.merge(sb.create_vegetation(pos=(-6.0, 0.0, 5.0), height=2.2, crown_radius=1.3, clear_trunk_height=0.1))
grove.translate(0.0, 0.0, -1.0)
scene.merge(grove)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`;

describe('SB-Veggie is the vegetation generator of imagined scenes (sb Python)', () => {
    it('grows sb.create_tree descriptions natively into the scene GLB, with SB-Veggie extras, provenance and four levels of detail', async () => {
        const runner = NativePythonRunnerService.getInstance();
        const result = await runner.runScript(GROVE_SCRIPT, { timeoutMs: 240_000 });
        expect(result.stderr).not.toContain('Traceback');
        expect(result.success).toBe(true);
        const buf = fs.readFileSync(result.glbPath!);
        const json = glbJson(buf);

        // the scene's own geometry is still there, beside the trees layer
        expect(json.nodes.some((n: any) => n.name === 'sb_veggie_trees')).toBe(true);
        expect(json.nodes.filter((n: any) => !String(n.name ?? '').startsWith('sb_veggie')).length).toBeGreaterThan(0);

        // the root extras the viewport's tree levels of detail read (TreeLodController: scene extras sbTrees)
        const sceneExtras = json.scenes[json.scene ?? 0].extras;
        expect(sceneExtras.sbVeggie).toMatchObject({ trees: 3, generator: 'space colonisation' });
        expect(sceneExtras.sbTrees.schema).toBe('scratchbox.trees-lod/3');
        expect(sceneExtras.sbTrees.species.index).toBe('assets/vegetation/species/index.json');
        expect(sceneExtras.sbTrees.textures.index).toBe('assets/textures/trees/index.json');
        expect(json.extensionsUsed).toEqual(expect.arrayContaining(['KHR_mesh_quantization', 'EXT_mesh_gpu_instancing']));

        const trees = treeNodes(json);
        expect(trees).toHaveLength(3);
        for (const { node, levels } of trees) {
            // four levels: near (instanced SB-Veggie clusters), near-mid, mid, far
            expect(levels.map(l => l.extras.sbLod.level)).toEqual([0, 1, 2, 3]);
            expect(levels[0].extras.sbLod.instanced).toBe(true);
            expect(levels[3].extras.sbLod.maxDistM).toBeGreaterThan(1000);
            // honestly labelled: generated (no scan behind it), with a confidence
            expect(node.extras.crownOrigin).toBe('described');
            expect(node.extras.sbTree.label).toBe('generated');
            expect(node.extras.sb.provenance).toMatchObject({ label: 'generated', measuredGeometry: false });
            expect(node.extras.sb.provenance.confidence).toBeGreaterThan(0.7);
            expect(node.extras.sb.provenance.sources[0].kind).toBe('described');
            // grown with the species library and textures chosen by appearance
            expect(['library', 'unmatched']).toContain(node.extras.sbTree.species.provenance);
            expect(node.extras.sbTree.texture.leaves.provenance).toBe('library');
            expect(node.extras.crownSurfaceReached).toBeGreaterThan(0.7);
        }
        // the cone and the broad crown grow with different species proportions
        const species = trees.map(t => t.node.extras.sbTree.species?.entry);
        expect(new Set(species).size).toBeGreaterThan(1);
        // each trunk stands where it was described (the shrubs' mesh was moved 1 m: its tree moved with it)
        const stems = trees.map(t => t.node.extras.stem as number[]);
        expect(stems).toEqual(expect.arrayContaining([[0, 0], [8, 4], [-6, 4]]));
        const labels = trees.map(t => t.node.extras.label);
        expect(labels).toEqual(expect.arrayContaining(['broad crown', 'narrow cone']));

        const veg = sbVeggieOf(buf);
        expect(veg).toEqual({ generator: 'SB-Veggie', trees: 3, triangles: expect.any(Number), levelsOfDetail: true });
    }, 600_000);

    it('execute_3d_python_script reports the trees and keeps their leaf clusters out of the structure check', async () => {
        const outcome = await python3DHandlers.execute_3d_python_script({ script: GROVE_SCRIPT, timeoutMs: 240_000 }, {});
        expect(outcome.status).toBe('completed');
        const r: any = outcome.resultPayload;
        expect(r.vegetation).toMatchObject({ generator: 'SB-Veggie', trees: 3, levelsOfDetail: true });
        // only the modelled ground is checked for floating parts: the trees' thousands of leaf clusters are not parts
        expect(r.structureReport?.passed ?? true).toBe(true);
        // framed on the world bounds (quantised tree positions read through their node transforms)
        expect(r.overallBoundingBox.max[1]).toBeGreaterThan(12);
        expect(r.overallBoundingBox.max[1]).toBeLessThan(16);
        expect(r.overallBoundingBox.dimensions[0]).toBeLessThan(40);
    }, 600_000);

    it('the retired tree generators are gone from sb Python and refused by the script type check', async () => {
        const runner = NativePythonRunnerService.getInstance();
        const probe = await runner.runScript(`
import scratchbox as sb
import scratchbox_native as nat
print("NATIVE", hasattr(nat.nature, "generate_tree"), hasattr(nat.nature, "generate_lsystem_tree"), hasattr(nat.nature, "SpaceColonizationConfig"), hasattr(nat, "plant"), hasattr(nat.io, "write_botanical_glb"), hasattr(nat, "vegetation"))
print("SB", hasattr(sb, "PlantPreset"), hasattr(sb, "Flora"), hasattr(sb.nature, "generate_tree"), hasattr(sb.nature, "PlantPreset"))
try:
    sb.create_tree(attractor_count=120, crown_center=(0, 5, 0), crown_extents=(2.5, 3.5, 2.5))
    print("KNOBS accepted")
except TypeError as e:
    print("KNOBS refused", str(e)[:60])
t = sb.create_tree(crown_center=(1, 5, 2), crown_extents=(2.5, 3.0, 2.0))
print("LEGACY", t.height, t.crown_radii, t.crown_base_height)
try:
    t.subdivide()
except AttributeError as e:
    print("MESHOP refused")
m = sb.geometry.Mesh("x")
m.merge(t)
print("HELD", len(m._sb_veggie_trees))
sb.io.write_glb(OUTPUT_GLB_PATH, m)
`, { timeoutMs: 240_000 });
        expect(probe.success).toBe(true);
        expect(probe.stdout).toContain('NATIVE False False False False False True');
        expect(probe.stdout).toContain('SB False False False False');
        expect(probe.stdout).toContain('KNOBS refused');
        expect(probe.stdout).toContain('LEGACY 8.0 [2.5, 2.0] 2.0');
        expect(probe.stdout).toContain('MESHOP refused');
        expect(probe.stdout).toContain('HELD 1');

        const check = await typeCheckSbScript('import scratchbox as sb\np = sb.nature.PlantPreset.create_hero_redwood(height=28.0)\nm = sb.nature.generate_tree(sb.nature.SpaceColonizationConfig())\n');
        if (check.status !== 'unavailable') {
            expect(check.status).toBe('rejected');
            expect(check.errors.map(e => e.line)).toEqual(expect.arrayContaining([2, 3]));
        }
    }, 600_000);
});

describe('the other 3D paths reach SB-Veggie or no tree generator at all', () => {
    it('a C++ generator that grows trees outside SB-Veggie is refused before it compiles (comments do not count)', () => {
        expect(cppVegetationViolations('#include "scratchbox_engine.hpp"\nint main(){ LSystemTreeParams p; auto t = generateProceduralTree(Vec3(0,0,0), p); }'))
            .toEqual(['LSystemTreeParams', 'generateProceduralTree']);
        expect(cppVegetationViolations('auto m = SpaceColonizationTreeGenerator::generateTree(cfg);')).toEqual(['SpaceColonizationTreeGenerator']);
        expect(cppVegetationViolations('#include "scratchbox_plant_builder.hpp"\nauto r = PlantPresets::createHeroAncientRedwood(p, 28);')).toEqual(['PlantPresets', 'scratchbox_plant_builder.hpp']);
        expect(cppVegetationViolations('// generateProceduralTree was here\n/* SpaceColonizationTreeGenerator */ int main(){}')).toEqual([]);
        expect(cppVegetationViolations('int myGenerateProceduralTreeCount = 0;')).toEqual([]);
        for (const sym of RETIRED_CPP_VEGETATION_SYMBOLS) expect(sym).not.toMatch(/\s/);
    });

    it('a viewport script that calls the primitive tree helper is not run', () => {
        expect(scriptVegetationViolations('const t = generateProceduralThreeMeshFromPrompt("pine tree", THREE); scene.add(t.mesh);')).toEqual(['generateProceduralThreeMeshFromPrompt']);
        const res = executeDynamicThreeScript('const t = generateProceduralThreeMeshFromPrompt("oak", THREE);', { THREE: {}, scene: {}, camera: {}, renderer: {} } as any);
        expect(res.error).toContain('SB-Veggie');
        expect(res.error).toContain('sb.create_tree');
    });

    it('document-to-3D morphs plant SB-Veggie trees through sb Python and build no primitive stand-ins', () => {
        const cpp = generateDefaultCpp3DSource('nature_atmosphere', 'Ancient Monolith Forest');
        expect(cppVegetationViolations(cpp)).toEqual([]);
        const scene = synthesizeContextual3DScene('a misty forest plateau with an ancient monolith');
        expect(scene.cppGenerator).toBeUndefined();
        const py = scene.pythonGenerator?.sourceCode ?? '';
        expect(py).toContain('sb.create_tree(');
        expect(py).not.toMatch(/attractor_count|generate_tree|PlantPreset/);
        for (const mesh of scene.customMeshes ?? []) expect(String(mesh.id)).not.toMatch(/tree|conifer/);
        // every embedded script uses the SB-Veggie API
        for (const prompt of ['city skyline downtown with avenue trees', 'civic plaza architecture building with shade trees']) {
            const s = synthesizeContextual3DScene(prompt);
            const src = `${s.pythonGenerator?.sourceCode ?? ''}\n${s.cppGenerator?.sourceCode ?? ''}`;
            expect(src).not.toMatch(/attractor_count|generateProceduralTree|LSystemTreeParams/);
            for (const mesh of s.customMeshes ?? []) expect(String(mesh.id)).not.toMatch(/tree|conifer/);
        }
        expect(natureWorldPythonSource('X')).toContain('sb.io.write_glb(OUTPUT_GLB_PATH, world)');
    });

    it('the morph nature script runs and its trees are SB-Veggie trees on the terrain', async () => {
        const result = await NativePythonRunnerService.getInstance().runScript(natureWorldPythonSource('Verdant Plateau'), { timeoutMs: 240_000 });
        expect(result.success).toBe(true);
        const json = glbJson(fs.readFileSync(result.glbPath!));
        const trees = treeNodes(json);
        expect(trees).toHaveLength(5);
        expect(json.scenes[0].extras.sbVeggie.trees).toBe(5);
    }, 600_000);

    it('an object spec builds trees as crown parts grown by SB-Veggie, counted and measured as pieces', async () => {
        const crown = { trunkBaseMeters: [0, 0, 0], heightMeters: 3.2, crownRadiiMeters: [1.3, 1.1] };
        const spec: ObjectBuildSpec = {
            subject: 'small tree', observations: [], boundingMeters: [2.6, 3.2, 2.2], expectedBodies: 1,
            parts: [{ id: 'tree', label: 'tree', crown: crown as any, material: { baseColor: [0.06, 0.11, 0.04], roughness: 0.8, metalness: 0, transmission: 0 } }]
        };
        expect(validateObjectBuildSpec(spec, { requireMaterials: true })).toEqual([]);
        expect(validateObjectBuildSpec({ ...spec, parts: [{ ...spec.parts[0], parentId: 'x', attach: { u: 0, angleDeg: 0, normalOffsetMeters: 0 } }] }).join(' ')).toContain('a crown part is a root part');
        const withSeed = { ...spec, expectedBodies: 3, parts: [...spec.parts, { id: 'ring', label: 'ring', replicate: { seedPartId: 'tree', ring: { centerMeters: [0, 0, 0], axisDirection: [0, 1, 0], count: 3, spanDeg: 360, risePerCopyMeters: 0 } } }] };
        expect(validateObjectBuildSpec(withSeed).join(' ')).toContain('is a crown part');

        const script = `import scratchbox as sb, json\nSPEC = json.loads(${JSON.stringify(JSON.stringify(spec))})\nsb.io.write_glb(OUTPUT_GLB_PATH, sb.object_spec.build(SPEC))\n`;
        const result = await NativePythonRunnerService.getInstance().runScript(script, { timeoutMs: 240_000 });
        expect(result.success).toBe(true);
        const glb = fs.readFileSync(result.glbPath!);
        const trees = treeNodes(glbJson(glb));
        expect(trees).toHaveLength(1);
        expect(trees[0].node.extras.label).toBe('tree');
        // the trunk base rests on y = 0
        expect(trees[0].node.extras.supportY).toBe(0);
        const measured = await measureBuild(spec, glb);
        expect(measured.connectivity).toMatchObject({ passed: true, bodies: 1, expectedBodies: 1 });
        expect(measured.parts).toEqual([expect.objectContaining({ id: 'tree', built: true })]);
        expect(measured.builtBoundingMeters[1]).toBeGreaterThan(2.5);
    }, 600_000);
});

describe('the vegetation tool is offered wherever 3D scenes are, and the instructions name SB-Veggie', () => {
    it('botanical_synthesize_tree sits in the core pack and the entry set, and says it is the vegetation generator for any scene', () => {
        expect(CORE_WORKSPACE_PACK.toolNames).toContain('botanical_synthesize_tree');
        expect(MESH_SURFACE_PACK.toolNames).not.toContain('botanical_synthesize_tree');
        expect(ENTRY_TOOL_NAMES).toContain('botanical_synthesize_tree');
        const d = BOTANICAL_TREE_TOOL_DECLARATIONS[0].description!;
        expect(d).toContain('vegetation generator for any 3D scene');
        expect(d).toContain('sb.create_tree');
        expect((BOTANICAL_TREE_TOOL_DECLARATIONS[0].parameters as any).properties.trees.type).toBe('ARRAY');
    });

    it('the system prompt and the script guide route vegetation to SB-Veggie', () => {
        expect(SPATIAL_INTENT_POLICY).toContain('botanical_synthesize_tree');
        expect(SPATIAL_INTENT_POLICY).toContain('sb.create_tree');
        expect(SB_PYTHON_SCRIPT_GUIDE).toContain('sb.create_tree(position=');
        expect(SB_PYTHON_SCRIPT_GUIDE).toContain('only vegetation generator');
        expect(SB_PYTHON_SCRIPT_GUIDE).not.toMatch(/generate_tree|PlantPreset|sb\.plant\b/);
        fs.mkdirSync(SHOTS, { recursive: true });
    });
});

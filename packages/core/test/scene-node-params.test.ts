import { describe, expect, it } from 'vitest';
import { applySceneNodeParam, sceneNodeFields, VIEWPORT_SKYBOXES } from '../src/browser/generative-canvas/scene-node-params';
import { morphScene3DToNodeGraph } from '../src/browser/generative-canvas/primitive-transformer-engine';
import { displayFlagFor } from '../src/browser/generative-canvas/scene-display-flag';
import { toolParamField } from '../src/browser/generative-canvas/primitives/ToolNodeParts';
import { OTHER_TOOLS, taskGroupOf } from '../src/browser/generative-canvas/tool-task-groups';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { buildToolNodeCatalog } from '../src/node/gemini/tool-node-catalog';
import type { GraphNode, Scene3DData } from '../src/browser/generative-canvas/canvas-types';

const scene: Scene3DData = {
    title: 'Studio', renderMode: 'pbr',
    camera: { position: [0, 2, 6], target: [0, 0, 0], fov: 45 },
    environment: { skybox: 'my-custom-hdri', lighting: 'studio', ground: true },
    customMeshes: [{ id: 'seat', name: 'seat', position: [0, 0.4, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1], material: { color: 0xa0522d, roughness: 0.7 } }],
    objects: [{ id: 'tree-1', content: { type: '3d-model', durableUri: '/m/tree.glb', mimeType: 'model/gltf-binary', metadata: { name: 'Oak' } as any }, space: { spatial3d: { x: 3, y: 0, z: -2, yaw: 30 } } }]
} as any;
const graph = morphScene3DToNodeGraph(scene);
const node = (id: string) => graph.nodes.find(n => n.id === id)! as GraphNode;

describe('scene objects are nodes', () => {
    it('each object is a node that feeds the Output and can take the display flag', () => {
        expect(node('obj-tree-1')).toMatchObject({ label: 'Oak', subtitle: '3d-model', parameters: { objectId: 'tree-1' } });
        expect(graph.edges.some(e => e.source === 'obj-tree-1' && e.target === 'n-render')).toBe(true);
        expect(displayFlagFor(node('obj-tree-1'), scene)).toEqual({ nodeId: 'obj-tree-1', label: 'Oak', objectIds: ['tree-1'] });
        expect(graph.subtitle).toContain('1 object');
    });
});

describe('node parameters are typed controls over the scene', () => {
    it('the environment: dropdowns keep a custom value, a toggle for the ground, sliders with units', () => {
        const f = sceneNodeFields(node('n-env'), scene)!;
        const sky = f.find(x => x.key === 'skybox')!;
        expect(sky.control).toEqual({ kind: 'select', options: ['my-custom-hdri', ...VIEWPORT_SKYBOXES] });
        expect(f.find(x => x.key === 'ground')).toMatchObject({ control: { kind: 'toggle' }, value: true });
        expect(f.find(x => x.key === 'kelvinTemperature')!.control).toMatchObject({ kind: 'slider', unit: 'K' });
    });

    it('the sky is an explicit opt-in: the Atmosphere toggle writes features.atmosphericScattering', () => {
        const f = sceneNodeFields(node('n-env'), scene)!;
        expect(f[0]).toMatchObject({ key: 'atmosphere', control: { kind: 'toggle' }, value: false });
        expect(f.find(x => x.key === 'skybox')!.hint).toBe('Shown once Atmosphere is on');
        const on = applySceneNodeParam(scene, node('n-env'), 'atmosphere', true);
        expect(on.features?.atmosphericScattering).toBe(true);
        const tuned = { ...scene, features: { atmosphericScattering: { enabled: false, turbidity: 3 } } } as any;
        expect(applySceneNodeParam(tuned, node('n-env'), 'atmosphere', true).features!.atmosphericScattering).toEqual({ enabled: true, turbidity: 3 });
    });

    it('a camera, a mesh and an object read their live values (rotation shown in degrees)', () => {
        expect(sceneNodeFields(node('n-cam'), scene)!.map(f => [f.key, f.control.kind])).toEqual([['fov', 'slider'], ['position', 'vec3'], ['target', 'vec3']]);
        const mesh = sceneNodeFields(node('mesh-seat'), scene)!;
        expect(mesh.find(f => f.key === 'rotation')!.value).toEqual([0, 90, 0]);
        expect(mesh.find(f => f.key === 'color')!.value).toBe('#a0522d');
        const obj = sceneNodeFields(node('obj-tree-1'), scene)!;
        expect(obj.find(f => f.key === 'position')!.value).toEqual([3, 0, -2]);
        expect(obj.find(f => f.key === 'yaw')!.value).toBe(30);
        expect(sceneNodeFields(node('n-render'), scene)![0]).toMatchObject({ key: 'renderMode', control: { kind: 'select' }, value: 'pbr' });
    });

    it('a change writes back into the scene data, and nothing else changes', () => {
        const a = applySceneNodeParam(scene, node('n-env'), 'skybox', 'sunset');
        expect(a.environment).toEqual({ skybox: 'sunset', lighting: 'studio', ground: true });
        const b = applySceneNodeParam(scene, node('n-cam'), 'fov', 60);
        expect(b.camera).toMatchObject({ fov: 60, position: [0, 2, 6], keepPoseOnLoad: true });
        const c = applySceneNodeParam(scene, node('mesh-seat'), 'rotation', [0, 180, 0]);
        expect(c.customMeshes![0].rotation![1]).toBeCloseTo(Math.PI);
        const d = applySceneNodeParam(scene, node('obj-tree-1'), 'position', [1, 2, 3]);
        expect(d.objects![0].space.spatial3d).toEqual({ x: 1, y: 2, z: 3, yaw: 30 });
        const e = applySceneNodeParam(applySceneNodeParam(scene, node('obj-tree-1'), 'color', '#ff0000'), node('obj-tree-1'), 'color', '');
        expect(e.objects![0].material).toBeUndefined();
        expect(applySceneNodeParam(scene, node('n-render'), 'renderMode', 'clay').renderMode).toBe('clay');
        expect(scene.environment!.skybox).toBe('my-custom-hdri');
    });

    it('a staged scene\'s Output switches clay and textured', () => {
        const staged = { ...scene, stagedBuild: { materialMode: 'clay', layers: [], stages: [] } } as any;
        const out = { id: 'scene-output', label: 'Output', x: 0, y: 0, parameters: { output: true } } as GraphNode;
        expect(sceneNodeFields(out, staged)![0]).toMatchObject({ key: 'materialMode', value: 'clay' });
        expect((applySceneNodeParam(staged, out, 'materialMode', 'textured').stagedBuild as any).materialMode).toBe('textured');
    });

    it('stages and compiled-model parts have no editable parameters', () => {
        expect(sceneNodeFields({ id: 'stage-tiles', label: 't', x: 0, y: 0, parameters: { stage: 'tiles' } } as GraphNode, scene)).toBeUndefined();
        expect(sceneNodeFields({ id: 'glb-node-0', label: 'seat', x: 0, y: 0, parameters: { glbNodeIndex: 0 } } as GraphNode, scene)).toBeUndefined();
    });
});

describe('tool node parameters get controls from their declaration', () => {
    it('enum, boolean, number, file (from the description), object', () => {
        expect(toolParamField('mode', { type: 'STRING', enum: ['a', 'b'] }, undefined, false).control).toEqual({ kind: 'select', options: ['', 'a', 'b'] });
        expect(toolParamField('isolate', { type: 'BOOLEAN' }, true, false)).toMatchObject({ control: { kind: 'toggle' }, value: true });
        expect(toolParamField('n', { type: 'NUMBER' }, 3, true)).toMatchObject({ label: 'n *', control: { kind: 'number' } });
        expect(toolParamField('inputGlbPath', { type: 'STRING', description: 'Path to the .glb to measure.' }, undefined, true).control).toEqual({ kind: 'file', accept: ['.glb'] });
        expect(toolParamField('query', { type: 'STRING', description: 'A place name' }, 'x', true).control).toEqual({ kind: 'text' });
        expect(toolParamField('stations', { type: 'ARRAY' }, [], false).control).toEqual({ kind: 'json' });
    });

    it('every real tool pack has a task group in the 3D library', () => {
        const packs = [...new Set(buildToolNodeCatalog(createDefaultToolRegistry()).map(t => t.pack))];
        expect(packs.filter(p => taskGroupOf(p) === OTHER_TOOLS && p !== OTHER_TOOLS)).toEqual([]);
    });
});

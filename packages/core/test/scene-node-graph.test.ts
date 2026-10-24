import { describe, expect, it } from 'vitest';
import { companionNodeGraph, planCompanionGraphs, refreshSceneNodeGraph, sceneGraphKey } from '../src/browser/generative-canvas/scene-node-graph';
import { BUILD_NODE_ID } from '../src/common/staged-build-graph';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';

const art = (id: string, type: string, data: any, version = 1): CanvasArtifact => ({ id, type: type as any, title: id, summary: '', version, createdAt: '', data });
const mesh = (id: string) => ({ id, label: id, tier: 'primary', geometry: { type: 'box' } });
const studio = (id: string, meshes: string[], version = 1) => art(id, '3d-scene', { title: id, customMeshes: meshes.map(mesh), camera: { fov: 45 } }, version);
const staged = (updatedAtMs: number, grammar: 'pending' | 'committed') => art('scene-stg-02538de5', '3d-scene', {
    title: 'Haughwout', stagedBuild: {
        schema: 'scratchbox.staged-build/2', runId: '02538de5', artifactId: 'scene-stg-02538de5', runState: grammar === 'committed' ? 'finished' : 'running', updatedAtMs,
        place: { query: 'Haughwout Building', resolvedAddress: '488 Broadway', lat: 40.72, lng: -74 },
        stages: [
            { stage: 'tiles', order: 1, title: 'Google 3D Tiles', source: 's', status: 'committed', layerIds: [], timings: { startedAtMs: 1, cached: false }, degradationIds: [] },
            { stage: 'grammar', order: 2, title: 'Facade grammar', source: 's', status: grammar, layerIds: [], timings: { startedAtMs: 2, cached: false }, degradationIds: [] }
        ], layers: [], degradations: [], provenanceLegend: [], attribution: []
    }
});

describe('every new 3D scene gets a node graph', () => {
    it('a session seen for the first time records the scenes it has, and gives them none', () => {
        const plan = planCompanionGraphs([studio('old-scene', ['a'])], undefined);
        expect(plan.graphs).toEqual([]);
        expect(plan.done).toEqual(['old-scene']);
    });

    it('a new scene gets one graph, once; a scene already followed by a graph gets no second one', () => {
        const scene = studio('scene-1', ['a', 'b']);
        const first = planCompanionGraphs([scene], []);
        expect(first.graphs.map(g => [g.id, g.type])).toEqual([['art-graph-scene-1', 'node-graph']]);
        expect(first.done).toEqual(['scene-1']);
        // closed by the user, then the scene streams again: not made again
        expect(planCompanionGraphs([scene], first.done).graphs).toEqual([]);
        // a graph the user opened by hand already follows it
        const byHand = art('graph-x', 'node-graph', { title: 'x', nodes: [], edges: [], stageViewOf: { artifactId: 'scene-2', updatedAtMs: 0 } });
        expect(planCompanionGraphs([studio('scene-2', []), byHand], []).graphs).toEqual([]);
    });

    it('a staged scene gets its stage view; another scene gets its scene graph', () => {
        const stage = companionNodeGraph(staged(10, 'pending')).data as any;
        expect(stage.nodes[0].id).toBe(BUILD_NODE_ID);
        expect(stage.stageViewOf).toMatchObject({ artifactId: 'scene-stg-02538de5', updatedAtMs: 10 });
        const sceneGraph = companionNodeGraph(studio('scene-1', ['a', 'b'])).data as any;
        expect(sceneGraph.title).toBe('scene-1 — node graph');
        expect(sceneGraph.nodes.map((n: any) => n.id)).toEqual(expect.arrayContaining(['mesh-a', 'mesh-b']));
        expect(sceneGraph.stageViewOf.key).toBe(sceneGraphKey(studio('scene-1', ['a', 'b'])));
    });

    it('follows its scene: redrawn when it changes, positions kept, left alone when it does not', () => {
        const g = companionNodeGraph(studio('scene-1', ['a'])).data as any;
        const dragged = { ...g, nodes: g.nodes.map((n: any) => n.id === 'mesh-a' ? { ...n, x: 999, y: 5 } : n) };
        expect(refreshSceneNodeGraph(dragged, studio('scene-1', ['a']))).toBeUndefined();
        const next = refreshSceneNodeGraph(dragged, studio('scene-1', ['a', 'c'], 2))!;
        expect(next.nodes.find(n => n.id === 'mesh-a')).toMatchObject({ x: 999, y: 5 });
        expect(next.nodes.some(n => n.id === 'mesh-c')).toBe(true);
        // a staged view redraws from a newer run record only
        const sv = companionNodeGraph(staged(10, 'pending')).data as any;
        expect(refreshSceneNodeGraph(sv, staged(10, 'committed'))).toBeUndefined();
        const later = refreshSceneNodeGraph(sv, staged(20, 'committed'))!;
        expect(later.nodes.find(n => n.id === 'stage-grammar')!.status).toBe('completed');
        // a graph never follows another scene
        expect(refreshSceneNodeGraph(sv, studio('scene-1', ['a']))).toBeUndefined();
    });
});

describe('graphs drawn by an older version redraw once', () => {
    it('a stage view without the current version mark redraws (gaining the Output node), then stays', () => {
        const sv = companionNodeGraph(staged(10, 'pending')).data as any;
        const old = { ...sv, nodes: sv.nodes.filter((n: any) => n.id !== 'scene-output'), stageViewOf: { artifactId: 'scene-stg-02538de5', updatedAtMs: 10 } };
        const redrawn = refreshSceneNodeGraph(old, staged(10, 'pending'))!;
        expect(redrawn.nodes.some(n => n.id === 'scene-output')).toBe(true);
        expect(refreshSceneNodeGraph(redrawn, staged(10, 'pending'))).toBeUndefined();
    });
});

describe('a redraw from a saved scene copy', () => {
    it('keeps the compiled model\'s parts the graph has when the copy cannot read them', () => {
        const g = companionNodeGraph(studio('scene-1', ['a'])).data as any;
        const withParts = { ...g, nodes: [...g.nodes, { id: 'glb-node-0', label: 'seat', x: 5, y: 6, parameters: { glbNodeIndex: 0 } }], edges: [...g.edges, { id: 'e-glb', source: 'glb-node-0', target: 'n-render' }] };
        const next = refreshSceneNodeGraph(withParts, studio('scene-1', ['a', 'b'], 2))!;
        expect(next.nodes.find(n => n.id === 'glb-node-0')).toMatchObject({ label: 'seat', x: 5, y: 6 });
        expect(next.edges.some(e => e.id === 'e-glb')).toBe(true);
        expect(next.nodes.findIndex(n => n.id === 'glb-node-0')).toBeLessThan(next.nodes.findIndex(n => n.parameters?.output));
    });
});

describe('a scene the chat is still streaming', () => {
    it('waits under its temporary id, then gets one graph under its project id', () => {
        const streaming = studio('artifact-3d-1792875795087', ['a']);
        const first = planCompanionGraphs([streaming], []);
        expect(first).toEqual({ graphs: [], done: [] });
        const settled = studio('artifact-3d-scene-qdo8ct', ['a']);
        const next = planCompanionGraphs([settled], first.done);
        expect(next.graphs.map(g => (g.data as any).stageViewOf.artifactId)).toEqual(['artifact-3d-scene-qdo8ct']);
        expect(planCompanionGraphs([settled, ...next.graphs], next.done).graphs).toEqual([]);
    });
});

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OUTPUT_NODE_ID, finalLayers, stageLayerIds, stagedBuildToNodeGraph } from '../src/common/staged-build-graph';
import { displayFlagFor, withDisplayFlag } from '../src/browser/generative-canvas/scene-display-flag';
import { applyDisplayFlag } from '../src/browser/generative-canvas/primitives/scene3d/displayFlag';
import { morphScene3DToNodeGraph } from '../src/browser/generative-canvas/primitive-transformer-engine';
import type { CanvasArtifact, GraphNode, Scene3DData } from '../src/browser/generative-canvas/canvas-types';

const layer = (objectId: string, stage: string, supersedes: string[] = []) => ({ objectId, stage, layer: objectId, order: 1, url: `/m/${objectId}.glb`, bytes: 1, supersedes, revealAfter: supersedes });
const stage = (s: string, order: number, layerIds: string[], startS: number) => ({ stage: s, order, title: s, source: s, status: 'committed', layerIds, timings: { startedAtMs: startS, cached: false }, degradationIds: [] });
const sb: any = {
    schema: 'scratchbox.staged-build/2', runId: 'cef5da30', artifactId: 'scene-stg-02538de5', runState: 'finished', updatedAtMs: 9, materialMode: 'textured',
    place: { query: 'Haughwout', resolvedAddress: '488 Broadway', lat: 0, lng: 0 },
    stages: [stage('vector', 0, ['L-vector'], 1), stage('tiles', 1, ['L-tiles'], 2), stage('remesh', 2, ['L-remesh'], 3), stage('grammar', 2, [], 4)],
    layers: [layer('L-vector', 'vector'), layer('L-tiles', 'tiles', ['L-vector']), layer('L-remesh', 'remesh', ['L-tiles'])],
    degradations: [], provenanceLegend: [], attribution: []
};
const scene: Scene3DData = { title: 'Haughwout', stagedBuild: sb, objects: ['L-vector', 'L-tiles', 'L-remesh'].map(id => ({ id } as any)) } as any;

describe('the scene graph ends in an Output node', () => {
    it('a stage view: fed by the stages whose layers make the final scene', () => {
        expect(finalLayers(sb).map(l => l.objectId)).toEqual(['L-remesh']);
        const g = stagedBuildToNodeGraph(sb);
        const out = g.nodes.find(n => n.id === OUTPUT_NODE_ID)!;
        expect(out).toMatchObject({ label: 'Output: viewport', category: 'output', parameters: { output: true, finalObjectIds: ['L-remesh'] } });
        expect(out.subtitle).toBe('1 layer in the scene, textured');
        expect(g.edges.filter(e => e.target === OUTPUT_NODE_ID).map(e => e.source)).toEqual(['stage-remesh']);
        expect(Math.max(...g.nodes.filter(n => n.id !== OUTPUT_NODE_ID).map(n => n.x))).toBeLessThan(out.x);
    });

    it('a scene graph: its renderer is the Output', () => {
        const g = morphScene3DToNodeGraph({ title: 'Stool', customMeshes: [{ id: 'seat', geometry: {} } as any] } as any);
        expect(g.nodes.find(n => n.id === 'n-render')).toMatchObject({ label: 'Output: viewport', parameters: { output: true } });
    });
});

describe('the display flag', () => {
    const node = (n: Partial<GraphNode>) => ({ id: 'x', label: 'x', x: 0, y: 0, ...n } as GraphNode);

    it('a stage shows its own loaded layers, even ones a later stage replaced; the Output and the build take none', () => {
        expect(stageLayerIds(sb, 'tiles')).toEqual(['L-tiles']);
        expect(displayFlagFor(node({ id: 'stage-tiles', label: 'Google 3D Tiles', parameters: { stage: 'tiles' } }), scene)).toEqual({ nodeId: 'stage-tiles', label: 'Google 3D Tiles', objectIds: ['L-tiles'] });
        expect(displayFlagFor(node({ id: 'stage-grammar', parameters: { stage: 'grammar' } }), scene)).toBeUndefined();
        expect(displayFlagFor(node({ id: OUTPUT_NODE_ID, parameters: { output: true } }), scene)).toBeUndefined();
        expect(displayFlagFor(node({ id: 'staged-build', parameters: { toolName: 'google_3d_tiles_get_clay' } }), scene)).toBeUndefined();
    });

    it('a mesh node shows its mesh; a compiled-model part shows that part', () => {
        const meshScene = { title: 's', customMeshes: [{ id: 'seat' }] } as any;
        expect(displayFlagFor(node({ id: 'mesh-seat', label: 'seat' }), meshScene)).toMatchObject({ meshIds: ['seat'] });
        expect(displayFlagFor(node({ id: 'mesh-gone', label: 'gone' }), meshScene)).toBeUndefined();
        expect(displayFlagFor(node({ id: 'glb-3', label: 'leg_fr', parameters: { glbNodeIndex: 3 } }), meshScene)).toMatchObject({ partNames: ['leg_fr'] });
    });

    it('is set on and cleared from the scene record', () => {
        const art: CanvasArtifact = { id: 'scene-stg-02538de5', type: '3d-scene', title: 'H', summary: '', version: 1, createdAt: '', data: scene };
        const on = withDisplayFlag(art, { nodeId: 'stage-tiles', label: 'Google 3D Tiles', objectIds: ['L-tiles'] });
        expect((on.data as Scene3DData).displayFlag?.nodeId).toBe('stage-tiles');
        expect('displayFlag' in (withDisplayFlag(on, undefined).data as object)).toBe(false);
        expect((withDisplayFlag(on, undefined).data as Scene3DData).stagedBuild?.runId).toBe('cef5da30');
    });

    it('the viewport draws only the flagged things, and restores exactly what it hid', () => {
        const roots = new Map(['L-vector', 'L-tiles', 'L-remesh'].map(id => [id, Object.assign(new THREE.Group(), { name: id })]));
        roots.get('L-vector')!.visible = false; // hidden by the staged reveal, not by the flag
        const meshes = new Map([['seat', { mesh: new THREE.Mesh() }], ['leg', { mesh: new THREE.Mesh() }]]);
        const compiled = new THREE.Group();
        const seat = Object.assign(new THREE.Group(), { name: 'seat' }); seat.add(new THREE.Mesh());
        const leg = Object.assign(new THREE.Mesh(), { name: 'leg_fr' });
        compiled.add(seat, leg);
        const t = { objectRoots: roots, meshes, compiledRoot: compiled };

        applyDisplayFlag({ nodeId: 'stage-tiles', label: 'tiles', objectIds: ['L-tiles'] }, t);
        expect([...roots.values()].map(r => r.visible)).toEqual([false, true, false]);
        expect([...meshes.values()].map(m => m.mesh.visible)).toEqual([false, false]);
        expect(compiled.visible).toBe(false);

        applyDisplayFlag({ nodeId: 'glb-1', label: 'seat', partNames: ['seat'] }, t);
        expect(compiled.visible).toBe(true);
        expect([seat.children[0].visible, leg.visible]).toEqual([true, false]);

        applyDisplayFlag(undefined, t);
        // everything the flag hid is back; what the reveal hid stays hidden
        expect([...roots.values()].map(r => r.visible)).toEqual([false, true, true]);
        expect([...meshes.values()].map(m => m.mesh.visible)).toEqual([true, true]);
        expect([compiled.visible, seat.children[0].visible, leg.visible]).toEqual([true, true, true]);
    });
});

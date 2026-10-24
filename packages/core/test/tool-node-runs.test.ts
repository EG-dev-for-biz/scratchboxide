/**
 * The three sync rules found live on 2026-10-24 (docs/processes/canvas_tool_nodes_2026-10-24.md), each pinned here:
 * a node run outlives its graph leaving the stage; a streamed artifact or an off-stage result never takes the stage;
 * a graph edit keeps the graph's link to its scene.
 */
import { describe, expect, it } from 'vitest';
import { ToolNodeRunRegistry, artifactOnStage, patchGraphNode, sanitizeNodeGraph, upsertArtifact } from '../src/browser/generative-canvas/tool-node-runs';
import type { CanvasArtifact, NodeGraphData } from '../src/browser/generative-canvas/canvas-types';

const graphArt = (nodes: Array<{ id: string; status?: string }>): CanvasArtifact => ({
    id: 'artifact-node-graph-1', type: 'node-graph', title: 'Haughwout — build stages', summary: '', version: 1, createdAt: '',
    data: {
        title: 'Haughwout — build stages', nodes: nodes.map(n => ({ id: n.id, label: n.id, x: 0, y: 0, status: n.status as any })), edges: [],
        sourceArtifact: { type: '3d-scene', data: { title: 'Haughwout' } }, stageViewOf: { artifactId: 'scene-stg-02538de5', updatedAtMs: 1 }
    } as NodeGraphData
});
const scene = (runId: string): CanvasArtifact => ({ id: 'scene-stg-02538de5', type: '3d-scene', title: 'Haughwout (staged clay)', summary: '', version: 1, createdAt: '', data: { stagedBuild: { runId } } });

describe('a node run outlives its graph leaving the stage', () => {
    it('stays registered, abortable and visible to the graph when it comes back, until it finishes', () => {
        const runs = new ToolNodeRunRegistry();
        const started = runs.start('artifact-node-graph-1', 'staged-build', 'scene-stg-02538de5');
        expect('run' in started).toBe(true);
        // the graph unmounts here: nothing in the registry depends on it
        expect(runs.runningNodes('artifact-node-graph-1')).toEqual(['staged-build']);
        expect(runs.runningNodes('another-graph')).toEqual([]);
        const run = runs.get('artifact-node-graph-1', 'staged-build')!;
        expect(run.controller.signal.aborted).toBe(false);
        runs.stopGraph('artifact-node-graph-1');
        expect(run.controller.signal.aborted).toBe(true);
        runs.finish('artifact-node-graph-1', 'staged-build');
        expect(runs.runningNodes('artifact-node-graph-1')).toEqual([]);
    });

    it('refuses a second run into the same scene from any graph, and the same node twice', () => {
        const runs = new ToolNodeRunRegistry();
        runs.start('graph-a', 'staged-build', 'scene-stg-02538de5');
        expect(runs.start('graph-b', 'staged-build', 'scene-stg-02538de5')).toEqual({ refused: expect.stringContaining('already being built') });
        expect(runs.start('graph-a', 'staged-build')).toEqual({ refused: 'This node is already running' });
        expect('run' in runs.start('graph-b', 'mesh-inspect')).toBe(true);
        runs.finish('graph-a', 'staged-build');
        expect('run' in runs.start('graph-b', 'staged-build', 'scene-stg-02538de5')).toBe(true);
    });
});

describe('a streamed artifact or an off-stage result never takes the stage', () => {
    it('a streamed scene replaces its tab in place; the graph on stage stays on stage', () => {
        const history = [graphArt([]), scene('02538de5')];
        const next = upsertArtifact(history, scene('cef5da30'));
        expect(next.map(a => a.id)).toEqual(['artifact-node-graph-1', 'scene-stg-02538de5']);
        expect((next[1].data as any).stagedBuild.runId).toBe('cef5da30');
        expect(artifactOnStage(history[0], scene('cef5da30'))).toBe(history[0]);
        // when the scene is the one on stage, the stage shows its new version
        expect((artifactOnStage(history[1], scene('cef5da30'))!.data as any).stagedBuild.runId).toBe('cef5da30');
        expect(upsertArtifact(undefined, scene('x')).length).toBe(1);
    });

    it('a result that lands off stage is written into the saved graph, keeping its scene link', () => {
        const art = graphArt([{ id: 'staged-build', status: 'running' }, { id: 'stage-tiles', status: 'completed' }]);
        const patched = patchGraphNode(art, 'staged-build', { status: 'completed', executionDurationMs: 240_000 });
        const data = patched.data as NodeGraphData;
        expect(data.nodes.map(n => [n.id, n.status])).toEqual([['staged-build', 'completed'], ['stage-tiles', 'completed']]);
        expect(data.nodes[0].executionDurationMs).toBe(240_000);
        expect(data.stageViewOf).toEqual({ artifactId: 'scene-stg-02538de5', updatedAtMs: 1 });
        expect((art.data as NodeGraphData).nodes[0].status).toBe('running');
    });
});

describe('a graph edit keeps the graph\'s link to its scene', () => {
    it('keeps sourceArtifact, stageViewOf and the viewport, and fills missing lists', () => {
        const raw = { ...(graphArt([{ id: 'n' }]).data as NodeGraphData), viewport: { x: 1, y: 2, zoom: 0.5 } };
        const g = sanitizeNodeGraph(raw);
        expect(g.sourceArtifact?.type).toBe('3d-scene');
        expect(g.stageViewOf?.artifactId).toBe('scene-stg-02538de5');
        expect(g.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });
        expect(sanitizeNodeGraph({ title: '' } as NodeGraphData)).toMatchObject({ title: 'Interactive Node Graph', nodes: [], edges: [] });
    });
});

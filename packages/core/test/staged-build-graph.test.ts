import { describe, expect, it } from 'vitest';
import { BUILD_NODE_ID, refreshStageGraph, stagedBuildToNodeGraph } from '../src/common/staged-build-graph';
import { isToolNode, toolRunOrder } from '../src/common/tool-node-graph';
import { morphScene3DToNodeGraph } from '../src/browser/generative-canvas/primitive-transformer-engine';
import type { StagedBuildState, StageSummary, StagedLayer } from '../src/common/spatial/staged-location-contracts';

const t0 = 1_792_870_000_000;
const stage = (s: string, order: number, status: StageSummary['status'], startS: number, ms: number | undefined, layerIds: string[], extra: Partial<StageSummary> = {}): StageSummary => ({
    stage: s, order, title: s[0].toUpperCase() + s.slice(1), source: `${s}: source line`, status, layerIds,
    timings: { startedAtMs: t0 + startS * 1000, ms, cached: false }, degradationIds: [], ...extra
});
const layer = (objectId: string, s: string, order: number, revealAfter: string[] = [], supersedes: string[] = []): StagedLayer =>
    ({ objectId, stage: s, layer: objectId, order, url: `/m/${objectId}.glb`, bytes: 1, supersedes, revealAfter } as unknown as StagedLayer);

const build = {
    schema: 'scratchbox.staged-build/2', runId: 'e7b240fa', requestKey: 'k', artifactId: 'scene-stg-e7b240fa',
    place: { query: 'Haughwout Building, 488 Broadway, New York', resolvedAddress: '488 Broadway, New York, NY 10013', lat: 40.72181, lng: -73.99949 },
    structure: { buildingId: 'b1' },
    runState: 'finished', updatedAtMs: t0 + 600_000,
    stages: [
        stage('resolve', -1, 'committed', 0, 900, []),
        stage('tiles', 1, 'committed', 1, 95_000, ['stg-a-l1']),
        stage('vehicles', 1, 'committed', 96, 40_000, ['stg-b-l1v']),
        stage('remesh', 2, 'committed', 140, 60_000, ['stg-c-l2']),
        stage('grammar', 2, 'degraded', 200, 300_000, [], { reason: 'two facades read below the gate', degradationIds: ['d-1', 'd-2'] }),
        stage('trees', 5, 'failed', 500, 20_000, [], { reason: 'crown fit timed out' }),
        stage('massing', 2, 'skipped', 0, undefined, [], { outOfScope: true })
    ],
    layers: [
        layer('stg-a-l1', 'tiles', 1),
        layer('stg-b-l1v', 'vehicles', 1, ['stg-a-l1'], ['stg-a-l1']),
        layer('stg-c-l2', 'remesh', 2, ['stg-b-l1v'], ['stg-b-l1v'])
    ],
    degradations: [], provenanceLegend: [], attribution: []
} as unknown as StagedBuildState;

describe('staged build as a node graph', () => {
    const g = stagedBuildToNodeGraph(build);

    it('has one runnable tool node for the whole build, with the run\'s query and isolate', () => {
        const runnable = g.nodes.filter(isToolNode);
        expect(runnable.map(n => n.id)).toEqual([BUILD_NODE_ID]);
        expect(runnable[0].parameters).toEqual({ toolName: 'google_3d_tiles_get_clay', toolArgs: { query: 'Haughwout Building, 488 Broadway, New York', isolate: true, stageIntoActiveScene: true }, targetArtifactId: 'scene-stg-e7b240fa' });
        expect(g.stageViewOf).toEqual({ artifactId: 'scene-stg-e7b240fa', updatedAtMs: t0 + 600_000 });
        expect(toolRunOrder(g.nodes, g.edges).map(n => n.id)).toEqual([BUILD_NODE_ID]);
    });

    it('has a read-only node per in-scope stage, in start order, with its status, time and reason', () => {
        const stages = g.nodes.filter(n => !isToolNode(n) && !n.parameters.output);
        expect(stages.map(n => n.id)).toEqual(['stage-resolve', 'stage-tiles', 'stage-vehicles', 'stage-remesh', 'stage-grammar', 'stage-trees']);
        const grammar = stages.find(n => n.id === 'stage-grammar')!;
        expect(grammar.status).toBe('completed');
        expect(grammar.color).toBe('amber');
        expect(grammar.details).toContain('Degraded parts: 2');
        expect(grammar.details).toContain('Reason: two facades read below the gate');
        const trees = stages.find(n => n.id === 'stage-trees')!;
        expect(trees.status).toBe('error');
        expect(trees.errorMessage).toBe('crown fit timed out');
        expect(stages.every(n => n.parameters.readOnly === true)).toBe(true);
    });

    it('links stages by the recorded layer dependencies, and the build to every stage that builds on none', () => {
        const solid = g.edges.filter(e => e.style === 'solid' && e.target !== 'scene-output').map(e => [e.source, e.target, e.label]);
        expect(solid).toEqual([
            ['stage-tiles', 'stage-vehicles', 'builds on, replaces layer'],
            ['stage-vehicles', 'stage-remesh', 'builds on, replaces layer']
        ]);
        const fromBuild = g.edges.filter(e => e.source === BUILD_NODE_ID).map(e => e.target).sort();
        expect(fromBuild).toEqual(['stage-grammar', 'stage-resolve', 'stage-tiles', 'stage-trees']);
        expect(g.subtitle).toContain('6 stages');
    });

    it('is what View As > Node Graph shows for a staged scene', () => {
        const graph = morphScene3DToNodeGraph({ title: 'Haughwout', stagedBuild: build } as any);
        expect(graph.nodes[0].id).toBe(BUILD_NODE_ID);
        expect(graph.sourceArtifact?.type).toBe('3d-scene');
    });

    it('refreshes from a newer record, keeping dragged positions and the build node\'s own run', () => {
        const dragged = g.nodes.map(n => n.id === 'stage-tiles' ? { ...n, x: 999, y: 7 } : n.id === BUILD_NODE_ID ? { ...n, status: 'running' as const, outputData: { recorded: false } } : n);
        const later = { ...build, updatedAtMs: t0 + 700_000, stages: build.stages.map(s => s.stage === 'grammar' ? { ...s, status: 'committed' as const, reason: undefined, degradationIds: [] } : s) } as StagedBuildState;
        const r = refreshStageGraph(dragged, later);
        expect(r.nodes.find(n => n.id === 'stage-tiles')).toMatchObject({ x: 999, y: 7 });
        expect(r.nodes.find(n => n.id === 'stage-grammar')).toMatchObject({ color: 'emerald', status: 'completed' });
        expect(r.nodes.find(n => n.id === BUILD_NODE_ID)!.status).toBe('running');
        expect(r.stageViewOf.updatedAtMs).toBe(t0 + 700_000);
    });
});

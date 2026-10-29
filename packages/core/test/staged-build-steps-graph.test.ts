import { describe, expect, it } from 'vitest';
import { BUILD_NODE_ID, OUTPUT_NODE_ID, stagedBuildToNodeGraph } from '../src/common/staged-build-graph';
import { BUILD_STEPS } from '../src/common/staged-build-steps';
import { displayFlagFor } from '../src/browser/generative-canvas/scene-display-flag';
import type { StagedBuildState, StageStepSummary, StageSummary, StagedLayer } from '../src/common/spatial/staged-location-contracts';
import type { GraphNode, Scene3DData } from '../src/browser/generative-canvas/canvas-types';

const t0 = 1_792_870_000_000;
const stage = (s: string, status: StageSummary['status'], layerIds: string[] = []): StageSummary => ({
    stage: s, order: 0, title: s[0].toUpperCase() + s.slice(1), source: s, status, layerIds, timings: { startedAtMs: t0, ms: 1000, cached: false }, degradationIds: []
});
const step = (key: string, stage: string, status: StageStepSummary['status'] = 'done', snapshot?: StageStepSummary['snapshot']): StageStepSummary =>
    ({ key, stage, status, startedAtMs: t0, endedAtMs: t0 + 500, ms: 500, ...(snapshot ? { snapshot } : {}) });
const snap = (name: string) => ({ url: `/models/esb_step_${name}.glb`, bytes: 10, frameOf: ['stg-r-l2', 'stg-t-l1'] });

const build = {
    schema: 'scratchbox.staged-build/2', runId: 'a4366afc', requestKey: 'k', artifactId: 'scene-stg-a4366afc',
    place: { query: 'Empire State Building', resolvedAddress: '350 5th Ave', lat: 40.7485, lng: -73.9857 },
    runState: 'finished', updatedAtMs: t0 + 600_000,
    stages: [stage('resolve', 'committed'), stage('tiles', 'committed', ['stg-t-l1']), stage('survey', 'committed'), stage('trees-measure', 'skipped'),
        stage('remesh', 'committed', ['stg-r-l2']), stage('textures', 'committed', ['stg-r-l2t']), stage('vector', 'skipped')],
    steps: [
        step('remesh.tileRefine', 'remesh', 'done', snap('tileRefine')), step('remesh.pipelineK', 'remesh'), step('remesh.windowFit', 'remesh'),
        step('remesh.revealDepth', 'remesh'), step('remesh.polish', 'remesh'), step('polish.cleanup', 'remesh', 'done', snap('cleanup')),
        step('polish.lattice', 'remesh', 'done', snap('lattice')), step('polish.base', 'remesh', 'done', snap('base')), step('polish.orient', 'remesh', 'done', snap('orient')),
        step('remesh.visibleDefects', 'remesh'), step('textures.tileRefineTwins', 'textures'), step('twin.harmonize', 'textures'), step('twin.materials', 'textures', 'running'),
        step('textures.newThing', 'textures')
    ],
    layers: [
        { objectId: 'stg-t-l1', stage: 'tiles', layer: 'l1', supersedes: [], revealAfter: [] },
        { objectId: 'stg-r-l2', stage: 'remesh', layer: 'l2', supersedes: ['stg-t-l1'], revealAfter: [] },
        { objectId: 'stg-r-l2t', stage: 'textures', layer: 'l2t', supersedes: ['stg-r-l2'], revealAfter: [] }
    ] as unknown as StagedLayer[],
    degradations: [], provenanceLegend: [], attribution: []
} as unknown as StagedBuildState;

describe('a staged build drawn as its steps', () => {
    const g = stagedBuildToNodeGraph(build);
    const ids = g.nodes.map(n => n.id);
    const edge = (from: string, to: string) => g.edges.find(e => e.source === from && e.target === to);

    it('draws a stage with timed steps as those steps, other stages as themselves, skipped ones not at all', () => {
        expect(ids).toContain('stage-resolve');
        expect(ids).toContain('stage-tiles');
        expect(ids).not.toContain('stage-remesh');
        expect(ids).not.toContain('stage-textures');
        expect(ids).not.toContain('stage-trees-measure');
        expect(ids).not.toContain('stage-vector');
        expect(ids).toContain('step-polish.lattice');
        expect(ids).not.toContain('step-remesh.polish');
        // seal did not run: drawn off, so it can be switched on
        expect(ids).toContain('step-polish.seal');
        expect(ids).toContain('step-textures.newThing');
        expect(g.title).toContain('build steps');
    });

    it('wires each step to the step that made what it reads, labelled by the result', () => {
        expect(edge('stage-tiles', 'step-remesh.tileRefine')?.label).toBe('tile mesh');
        expect(edge('step-remesh.windowFit', 'step-polish.lattice')?.label).toBe('windows');
        expect(edge('step-remesh.revealDepth', 'step-polish.lattice')?.label).toBe('window depth');
        expect(edge('step-polish.cleanup', 'step-polish.lattice')?.label).toBe('cleaned scan');
        expect(edge('stage-survey', 'step-remesh.revealDepth')?.label).toBe('Street View photos');
        expect(edge('step-remesh.windowFit', 'step-twin.materials')?.label).toBe('windows');
        // orient reads the base (seal did not run, so nothing stands between them)
        expect(edge('step-polish.base', 'step-polish.orient')).toBeDefined();
        // an unlisted step is unwired but started by the build
        expect(edge(BUILD_NODE_ID, 'step-textures.newThing')).toBeDefined();
        expect(g.edges.filter(e => e.target === 'step-textures.newThing')).toHaveLength(1);
    });

    it('lays steps out by how many steps lie before them', () => {
        const x = (id: string) => g.nodes.find(n => n.id === id)!.x;
        expect(x('step-remesh.tileRefine')).toBeGreaterThan(x('stage-tiles'));
        expect(x('step-polish.lattice')).toBeGreaterThan(x('step-remesh.revealDepth'));
        expect(x('step-polish.orient')).toBeGreaterThan(x('step-polish.base'));
        expect(x(OUTPUT_NODE_ID)).toBeGreaterThan(Math.max(...g.nodes.filter(n => n.id !== OUTPUT_NODE_ID).map(n => n.x)));
    });

    it('carries each step\'s status, time and snapshot', () => {
        const lattice = g.nodes.find(n => n.id === 'step-polish.lattice')!;
        expect(lattice.status).toBe('completed');
        expect(lattice.executionDurationMs).toBe(500);
        expect(lattice.parameters.snapshot).toEqual(snap('lattice'));
        expect(g.nodes.find(n => n.id === 'step-twin.materials')!.status).toBe('running');
        expect(g.nodes.find(n => n.id === 'step-remesh.windowFit')!.parameters.snapshot).toBeUndefined();
    });

    it('feeds the output from the last step of each stage the scene shows', () => {
        expect(edge('step-textures.newThing', OUTPUT_NODE_ID)).toBeDefined();
    });

    it('lists every step a pipeline K run records', () => {
        const keys = new Set(BUILD_STEPS.map(b => b.key));
        for (const k of ['remesh.tileRefine', 'remesh.pipelineK', 'remesh.windowFit', 'remesh.revealDepth', 'polish.cleanup', 'polish.lattice', 'polish.base', 'polish.orient',
            'remesh.streetViewScore', 'remesh.visibleDefects', 'textures.tileRefineTwins', 'twin.harmonize', 'twin.materials', 'twin.partyWall']) expect(keys.has(k)).toBe(true);
        // every result a step reads is made by an earlier step
        BUILD_STEPS.forEach((b, i) => { for (const n of b.needs) expect(BUILD_STEPS.slice(0, i).some(o => o.makes.includes(n))).toBe(true); });
    });
});

describe('a step\'s display flag', () => {
    const scene = { title: 's', stagedBuild: build, objects: [{ id: 'stg-r-l2t' }, { id: 'stg-r-l2' }] } as unknown as Scene3DData;
    const node = (n: Partial<GraphNode>) => ({ x: 0, y: 0, label: 'n', ...n }) as GraphNode;
    const g = stagedBuildToNodeGraph(build);

    it('shows the snapshot alone for a step that changed the model', () => {
        const lattice = g.nodes.find(n => n.id === 'step-polish.lattice')! as unknown as GraphNode;
        expect(displayFlagFor(lattice, scene)).toEqual({ nodeId: 'step-polish.lattice', label: 'Facades rebuilt on the lattice', objectIds: [], snapshot: { url: '/models/esb_step_lattice.glb', frameOf: ['stg-r-l2', 'stg-t-l1'] } });
    });

    it('shows its stage\'s layers for a step without one', () => {
        const fit = g.nodes.find(n => n.id === 'step-remesh.windowFit')! as unknown as GraphNode;
        expect(displayFlagFor(fit, scene)?.objectIds).toEqual(['stg-r-l2']);
        expect(displayFlagFor(node({ id: 'x', parameters: { stage: 'remesh', snapshot: { url: 7 } } }), scene)?.snapshot).toBeUndefined();
    });
});

describe('step switches for the next build', () => {
    const edge = (g: ReturnType<typeof stagedBuildToNodeGraph>, from: string, to: string) => g.edges.find(e => e.source === from && e.target === to);
    const node = (g: ReturnType<typeof stagedBuildToNodeGraph>, id: string) => g.nodes.find(n => n.id === id)!;

    it('gives each toggleable step a switch, on as it ran, and none to the steps every later one needs', () => {
        const g = stagedBuildToNodeGraph(build);
        expect(node(g, 'step-polish.cleanup').parameters.toggle).toMatchObject({ key: 'polish.cleanup', on: true });
        expect(node(g, 'step-remesh.tileRefine').parameters.toggle).toBeUndefined();
        expect(node(g, 'stage-tiles').parameters.toggle).toBeUndefined();
        // a toggleable step the run never recorded (seal, off by default) is drawn off, so it can be turned on
        expect(node(g, 'step-polish.seal').parameters).toMatchObject({ off: true, toggle: { key: 'polish.seal', on: false } });
        expect(node(g, BUILD_NODE_ID).parameters.toolArgs).not.toHaveProperty('steps');
    });

    it('fades a step turned off and wires what read it to what it read, through chains of off steps', () => {
        const g = stagedBuildToNodeGraph(build, { 'polish.cleanup': false, 'remesh.windowFit': false });
        expect(node(g, 'step-polish.cleanup').parameters.off).toBe(true);
        expect(node(g, 'step-polish.cleanup').details).toContain('Off for the next build: the lattice works on the remesh as tile_refine left it');
        // cleanup off: the lattice reads tile_refine's remesh
        expect(edge(g, 'step-remesh.tileRefine', 'step-polish.lattice')).toMatchObject({ label: 'remeshed scan (Remesh cleanup off)', style: 'dashed' });
        expect(edge(g, 'step-polish.cleanup', 'step-polish.lattice')).toBeUndefined();
        // window fit off: the lattice and the materials read the straightened photos, and reveal depth too
        expect(edge(g, 'step-remesh.pipelineK', 'step-polish.lattice')?.label).toContain('straightened facade photos');
        expect(edge(g, 'step-remesh.windowFit', 'step-polish.lattice')).toBeUndefined();
        // (this recorded build predates the facade reader, so its readings fall through to the straightened photos too)
        expect(edge(g, 'step-remesh.pipelineK', 'step-twin.materials')?.label).toContain('straightened facade photos (Window fit off)');
        // the build node re-runs with the switches
        expect(node(g, BUILD_NODE_ID).parameters.toolArgs).toMatchObject({ steps: { 'polish.cleanup': false, 'remesh.windowFit': false } });
    });

    it('turns on a step that was off, and passes only known steps to the build', () => {
        const g = stagedBuildToNodeGraph(build, { 'polish.seal': true, 'remesh.tileRefine': false, 'made.up': false });
        expect(node(g, 'step-polish.seal').parameters.off).toBeUndefined();
        expect(edge(g, 'step-polish.base', 'step-polish.seal')).toBeDefined();
        expect(node(g, BUILD_NODE_ID).parameters.toolArgs).toMatchObject({ steps: { 'polish.seal': true } });
        expect((node(g, BUILD_NODE_ID).parameters.toolArgs as any).steps).not.toHaveProperty('remesh.tileRefine');
    });
});

describe('the build tool reads the switches', () => {
    it('keeps known step switches and drops the rest', async () => {
        const { parseStagedLocationArgs } = await import('../src/node/3d-engine/staged-location/staged-location-tool');
        const r = parseStagedLocationArgs('google_3d_tiles_get_clay', { query: 'Empire State Building', isolate: true, steps: { 'polish.orient': false, 'twin.materials': true, 'remesh.tileRefine': false, 'polish.base': 'no' } });
        expect(r.request.steps).toEqual({ 'polish.orient': false, 'twin.materials': true });
        expect(parseStagedLocationArgs('google_3d_tiles_get_clay', { query: 'x', isolate: true }).request.steps).toBeUndefined();
    });
});

describe('a switch saved on the scene', () => {
    it('merges into the scene\'s switches', async () => {
        const { withStepToggle } = await import('../src/browser/generative-canvas/scene-display-flag');
        const a = withStepToggle({ id: 's', type: '3d-scene', data: { title: 't', stagedStepToggles: { 'polish.cleanup': false } } } as any, 'polish.orient', false);
        expect((a.data as any).stagedStepToggles).toEqual({ 'polish.cleanup': false, 'polish.orient': false });
    });
});

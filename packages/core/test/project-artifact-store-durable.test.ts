/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The project graph in the durable store: every save keeps the graph in the database and appends the changes since
 * the last save to the project's log; a checkout without the file gets the project back from the database (its own
 * copy, else the newest copy from any checkout); the diff names what changed without carrying payloads.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectArtifactStore } from '../src/node/project-artifact-store';
import { DurableAssetStore } from '../src/node/asset-store/durable-asset-store';
import { createEmptyProjectGraph, ProjectArtifactGraphEngine, type ArtifactActor } from '../src/common/project-artifact-graph-protocol';
import { diffProjectGraphs } from '../src/common/project-graph-diff';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-project-store-')));
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

const actor: ArtifactActor = { id: 'user-1', kind: 'user', displayName: 'Eli' };
let n = 0;
const envelope = (projectId: string) => ({ commandId: `cmd-${++n}`, correlationId: `corr-${n}`, idempotencyKey: `key-${n}`, projectId, actor, capability: 'artifact.write' as const });

function graphWithScene(projectId: string) {
    const graph = createEmptyProjectGraph(projectId, { grants: (['artifact.write', 'artifact.link', 'artifact.select'] as const).map(capability => ({ capability, effect: 'allow' as const, actorId: 'user-1' })) });
    const engine = new ProjectArtifactGraphEngine(graph);
    const created = engine.dispatch({ ...envelope(projectId), type: 'artifact.create', artifact: { id: 'scene-1', kind: '3d-scene', title: 'Washington Square', payload: { objects: [1, 2, 3] } } } as never);
    return { graph, engine, created };
}

describe('diffProjectGraphs', () => {
    it('names created, revised, linked and selected artifacts without their payloads', () => {
        const { graph, engine } = graphWithScene('p');
        const first = JSON.parse(JSON.stringify(graph));
        expect(diffProjectGraphs(undefined, first).map(c => c.kind)).toEqual(['artifact.created']);
        engine.dispatch({ ...envelope('p'), type: 'artifact.update', artifactId: 'scene-1', expectedRevision: graph.heads['scene-1'], title: 'Washington Square (lit)', payload: { objects: [1, 2, 3, 4] } } as never);
        engine.dispatch({ ...envelope('p'), type: 'artifact.create', artifact: { id: 'doc-1', kind: 'document', title: 'Notes', payload: { text: 'x' } } } as never);
        engine.dispatch({ ...envelope('p'), capability: 'artifact.link', type: 'artifact.link', edge: { type: 'derives-from', source: { projectId: 'p', artifactId: 'doc-1' }, target: { projectId: 'p', artifactId: 'scene-1' } } } as never);
        engine.dispatch({ ...envelope('p'), capability: 'artifact.select', type: 'artifact.select', artifactId: 'doc-1' } as never);
        const changes = diffProjectGraphs(first, graph);
        expect(changes.map(c => c.kind)).toEqual(['artifact.created', 'artifact.revised', 'artifact.linked', 'artifact.selected']);
        const revised = changes.find(c => c.kind === 'artifact.revised')!;
        expect(revised).toMatchObject({ artifactId: 'scene-1', title: 'Washington Square (lit)', revision: { number: 2, author: actor } });
        expect(JSON.stringify(changes)).not.toContain('"objects"');
        expect(changes.find(c => c.kind === 'artifact.linked')?.edge).toMatchObject({ type: 'derives-from', source: { artifactId: 'doc-1' } });
    });
});

describe('ProjectArtifactStore with the durable store', () => {
    it('logs each save, and gives a checkout without the file the project back from the database', async () => {
        const durable = new DurableAssetStore(path.join(HOME, 'home-a'));
        const store = new ProjectArtifactStore(durable);
        const rootA = path.join(HOME, 'checkout-a');
        const rootB = path.join(HOME, 'checkout-b');
        fs.mkdirSync(rootA, { recursive: true });
        fs.mkdirSync(rootB, { recursive: true });

        const { graph, engine } = graphWithScene('default-project');
        await store.save(rootA, graph);
        engine.dispatch({ ...envelope('default-project'), type: 'artifact.update', artifactId: 'scene-1', expectedRevision: graph.heads['scene-1'], title: 'Washington Square (textured)', payload: { objects: [9] } } as never);
        await store.save(rootA, graph);

        const log = store.changeLog('default-project');
        expect(log.map(e => e.kind)).toEqual(['artifact.revised', 'artifact.created']);
        expect(log[0].detail).toMatchObject({ artifactId: 'scene-1', title: 'Washington Square (textured)', workspace: rootA, revision: { number: 2 } });
        expect(store.listProjects()).toMatchObject([{ projectId: 'default-project', workspace: rootA, artifacts: 1, revisions: 2 }]);

        // the file is still written as before
        expect(fs.existsSync(path.join(rootA, '.scratchbox', 'project-artifacts.json'))).toBe(true);

        // checkout A is deleted; checkout B has no file: the project comes back from the database, and says so
        fs.rmSync(rootA, { recursive: true, force: true });
        const restored = await store.load(rootB, 'default-project');
        expect(restored?.artifacts['scene-1']?.title).toBe('Washington Square (textured)');
        expect(restored?.revisions[restored.heads['scene-1']]?.title).toBe('Washington Square (textured)');
        expect(store.changeLog('default-project')[0]).toMatchObject({ kind: 'project.restored', detail: { workspace: rootB, from: rootA } });
        expect(store.listProjects().map(p => p.workspace).sort()).toEqual([rootA, rootB].sort());

        // a later save from B diffs against B's copy: one more revision, one more log entry
        const engineB = new ProjectArtifactGraphEngine(restored!);
        engineB.dispatch({ ...envelope('default-project'), type: 'artifact.update', artifactId: 'scene-1', expectedRevision: restored!.heads['scene-1'], title: 'Washington Square (dusk)', payload: {} } as never);
        await store.save(rootB, restored!);
        expect(store.changeLog('default-project').map(e => e.kind)).toEqual(['artifact.revised', 'project.restored', 'artifact.revised', 'artifact.created']);
        durable.close();
    });

    it('imports a checkout file the database has never seen, once', async () => {
        const durable = new DurableAssetStore(path.join(HOME, 'home-b'));
        const root = path.join(HOME, 'checkout-c');
        fs.mkdirSync(path.join(root, '.scratchbox'), { recursive: true });
        const { graph } = graphWithScene('legacy');
        fs.writeFileSync(path.join(root, '.scratchbox', 'project-artifacts.json'), JSON.stringify(graph));
        const store = new ProjectArtifactStore(durable);
        expect((await store.load(root, 'legacy'))?.artifacts['scene-1']?.kind).toBe('3d-scene');
        await store.load(root, 'legacy');
        expect(store.changeLog('legacy').map(e => e.kind)).toEqual(['project.imported']);
        durable.close();
    });

    it('works without a durable store (the file only)', async () => {
        const store = new ProjectArtifactStore(null);
        const root = path.join(HOME, 'checkout-d');
        const { graph } = graphWithScene('plain');
        await store.save(root, graph);
        expect((await store.load(root, 'plain'))?.project.id).toBe('plain');
        expect(store.changeLog('plain')).toEqual([]);
        fs.rmSync(path.join(root, '.scratchbox'), { recursive: true, force: true });
        expect(await store.load(root, 'plain')).toBeUndefined();
    });
});

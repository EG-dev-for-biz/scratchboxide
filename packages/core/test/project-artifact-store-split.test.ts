/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The project graph saved as a small index plus one file per revision, and saved by merge: a save sends only the
 * revisions the store lacks, so its size is the change, not the history, and a graph that lost its history cannot erase
 * the stored one.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectArtifactStore } from '../src/node/project-artifact-store';
import { createEmptyProjectGraph, ProjectArtifactGraphEngine, type ArtifactActor, type ProjectArtifactGraph } from '../src/common/project-artifact-graph-protocol';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-project-split-')));
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

const actor: ArtifactActor = { id: 'user-1', kind: 'user', displayName: 'Eli' };
let n = 0;
const envelope = (projectId: string) => ({ commandId: `cmd-${++n}`, correlationId: `corr-${n}`, idempotencyKey: `key-${n}`, projectId, actor, capability: 'artifact.write' as const });

/** A project with one scene revised `edits` times (each revision a ~50 KB payload, as a staged scene's is). */
function sceneWithEdits(projectId: string, edits: number) {
    const graph = createEmptyProjectGraph(projectId, { grants: (['artifact.write', 'artifact.link', 'artifact.select'] as const).map(capability => ({ capability, effect: 'allow' as const })) });
    const engine = new ProjectArtifactGraphEngine(graph);
    const big = (i: number) => ({ layers: Array.from({ length: 200 }, (_, k) => ({ id: `layer-${k}`, note: `edit ${i} `.repeat(30) })) });
    engine.dispatch({ ...envelope(projectId), type: 'artifact.create', artifact: { id: 'scene-1', kind: '3d-scene', title: 'Penn Station', payload: big(0) } } as never);
    for (let i = 1; i <= edits; i++) engine.dispatch({ ...envelope(projectId), type: 'artifact.update', artifactId: 'scene-1', expectedRevision: graph.heads['scene-1'], title: `Penn Station ${i}`, payload: big(i) } as never);
    return { graph, engine, big };
}
const withOnly = (g: ProjectArtifactGraph, ids: string[]): ProjectArtifactGraph => ({ ...g, revisions: Object.fromEntries(ids.map(id => [id, g.revisions[id]])) });

describe('the project graph split into an index and revision files', () => {
    it('writes each revision once and an index without their bodies, and loads the same graph back', async () => {
        const root = path.join(HOME, 'a');
        const { graph } = sceneWithEdits('proj-split', 20);
        const store = new ProjectArtifactStore(null);
        await store.save(root, graph);
        const index = path.join(root, '.scratchbox', 'project-artifacts.json');
        const revisionFiles = fs.readdirSync(path.join(root, '.scratchbox', 'project-revisions'));
        expect(revisionFiles).toHaveLength(21);
        // the index carries no revision body: a fraction of one revision, whatever the history
        expect(fs.statSync(index).size).toBeLessThan(20_000);
        const loaded = await store.load(root, 'proj-split');
        expect(Object.keys(loaded!.revisions).sort()).toEqual(Object.keys(graph.revisions).sort());
        expect(loaded!.revisions[loaded!.heads['scene-1']].title).toBe('Penn Station 20');
        expect(JSON.stringify(loaded!.revisions[graph.heads['scene-1']].payload)).toBe(JSON.stringify(graph.revisions[graph.heads['scene-1']].payload));
    });

    it('merges a save of only the new revisions, and never drops the stored history', async () => {
        const root = path.join(HOME, 'b');
        const { graph, engine, big } = sceneWithEdits('proj-merge', 5);
        const store = new ProjectArtifactStore(null);
        await store.save(root, graph);
        const before = Object.keys(graph.revisions);
        // one more edit: the save carries that revision alone
        engine.dispatch({ ...envelope('proj-merge'), type: 'artifact.update', artifactId: 'scene-1', expectedRevision: graph.heads['scene-1'], title: 'Penn Station 6', payload: big(6) } as never);
        const fresh = Object.keys(graph.revisions).filter(id => !before.includes(id));
        expect(fresh).toHaveLength(1);
        const part = withOnly(graph, fresh);
        expect(JSON.stringify(part).length).toBeLessThan(JSON.stringify(graph).length / 4);
        expect((await store.merge(root, part)).missingRevisions).toEqual([]);
        const loaded = await store.load(root, 'proj-merge');
        expect(Object.keys(loaded!.revisions)).toHaveLength(7);
        expect(loaded!.revisions[loaded!.heads['scene-1']].title).toBe('Penn Station 6');
    });

    it('refuses a merge whose heads name revisions it was never given, and writes nothing', async () => {
        const root = path.join(HOME, 'c');
        const { graph, engine, big } = sceneWithEdits('proj-missing', 2);
        const store = new ProjectArtifactStore(null);
        await store.save(root, graph);
        const indexBefore = fs.readFileSync(path.join(root, '.scratchbox', 'project-artifacts.json'), 'utf8');
        engine.dispatch({ ...envelope('proj-missing'), type: 'artifact.update', artifactId: 'scene-1', expectedRevision: graph.heads['scene-1'], title: 'lost', payload: big(9) } as never);
        // a client that thinks the server already holds the new revision
        const r = await store.merge(root, withOnly(graph, []));
        expect(r.missingRevisions).toEqual([graph.heads['scene-1']]);
        expect(fs.readFileSync(path.join(root, '.scratchbox', 'project-artifacts.json'), 'utf8')).toBe(indexBefore);
    });

    it('loads a whole graph file as before, and keeps its history when it is first merged into', async () => {
        const root = path.join(HOME, 'd');
        const { graph, engine, big } = sceneWithEdits('proj-legacy', 3);
        fs.mkdirSync(path.join(root, '.scratchbox'), { recursive: true });
        fs.writeFileSync(path.join(root, '.scratchbox', 'project-artifacts.json'), JSON.stringify(graph));
        const store = new ProjectArtifactStore(null);
        expect(Object.keys((await store.load(root, 'proj-legacy'))!.revisions)).toHaveLength(4);
        const before = Object.keys(graph.revisions);
        engine.dispatch({ ...envelope('proj-legacy'), type: 'artifact.update', artifactId: 'scene-1', expectedRevision: graph.heads['scene-1'], title: 'merged', payload: big(4) } as never);
        await store.merge(root, withOnly(graph, Object.keys(graph.revisions).filter(id => !before.includes(id))));
        const loaded = await store.load(root, 'proj-legacy');
        expect(Object.keys(loaded!.revisions)).toHaveLength(5);
        expect(fs.readdirSync(path.join(root, '.scratchbox', 'project-revisions'))).toHaveLength(5);
    });
});

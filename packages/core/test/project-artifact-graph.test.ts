import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import {
    ArtifactRef,
    ProjectArtifactGraphEngine,
    ProjectGraphConflictError,
    createEmptyProjectGraph,
    migrateCanvasSessions,
    parseProjectGraph,
    serializeProjectGraph
} from '../src/common/project-artifact-graph-protocol';
import { ProjectArtifactStore } from '../src/node/project-artifact-store';
import { CanvasArtifact, ChatSession } from '../src/browser/generative-canvas/canvas-types';
import { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import { BrowserProxyService } from '../src/node/browser-proxy-service';

const actor = { id: 'user-test', displayName: 'Test User', kind: 'user' as const };

async function runProjectArtifactGraphTests(): Promise<void> {
    console.log('🧪 Running Project Artifact Graph protocol and store tests...');

    const graph = createEmptyProjectGraph('project-test', {
        grants: [
            { capability: 'artifact.write', effect: 'allow' },
            { capability: 'artifact.link', effect: 'allow' },
            { capability: 'artifact.select', effect: 'allow' }
        ]
    });
    const engine = new ProjectArtifactGraphEngine(graph);

    const createResult = engine.dispatch({
        type: 'artifact.create',
        commandId: 'cmd-create-doc',
        correlationId: 'flow-doc-preview',
        idempotencyKey: 'create-doc-once',
        projectId: graph.project.id,
        actor,
        capability: 'artifact.write',
        artifact: {
            id: 'artifact-doc-stable',
            kind: 'markdown-document',
            title: 'Architecture',
            payload: { title: 'Architecture', sections: [] }
        }
    });
    assert.strictEqual(createResult.status, 'applied');
    assert.strictEqual(createResult.artifactRef.artifactId, 'artifact-doc-stable');
    const firstRevisionId = createResult.artifactRef.revisionId!;

    const duplicateCreate = engine.dispatch({
        type: 'artifact.create',
        commandId: 'cmd-create-doc-retry',
        correlationId: 'flow-doc-preview',
        idempotencyKey: 'create-doc-once',
        projectId: graph.project.id,
        actor,
        capability: 'artifact.write',
        artifact: {
            id: 'artifact-doc-stable',
            kind: 'markdown-document',
            title: 'Ignored duplicate',
            payload: { title: 'Ignored duplicate', sections: [] }
        }
    });
    assert.strictEqual(duplicateCreate.status, 'duplicate');
    assert.strictEqual(duplicateCreate.artifactRef.revisionId, firstRevisionId);

    const updateResult = engine.dispatch({
        type: 'artifact.update',
        commandId: 'cmd-update-doc',
        correlationId: 'flow-doc-preview',
        idempotencyKey: 'update-doc-v2',
        projectId: graph.project.id,
        actor,
        capability: 'artifact.write',
        artifactId: 'artifact-doc-stable',
        expectedRevision: firstRevisionId,
        title: 'Architecture v2',
        payload: { title: 'Architecture v2', sections: [{ id: 's1', type: 'paragraph', content: 'Canonical.' }] }
    });
    assert.notStrictEqual(updateResult.artifactRef.revisionId, firstRevisionId);
    assert.strictEqual(graph.revisions[firstRevisionId].title, 'Architecture');
    assert.strictEqual(graph.revisions[updateResult.artifactRef.revisionId!].parentRevisionId, firstRevisionId);

    assert.throws(() => engine.dispatch({
        type: 'artifact.update',
        commandId: 'cmd-stale-update',
        correlationId: 'flow-doc-preview',
        idempotencyKey: 'stale-update',
        projectId: graph.project.id,
        actor,
        capability: 'artifact.write',
        artifactId: 'artifact-doc-stable',
        expectedRevision: firstRevisionId,
        payload: { title: 'Stale write' }
    }), (error: unknown) => error instanceof ProjectGraphConflictError);

    const browserResult = engine.dispatch({
        type: 'artifact.create',
        commandId: 'cmd-create-browser',
        correlationId: 'flow-doc-preview',
        idempotencyKey: 'create-browser-once',
        projectId: graph.project.id,
        actor,
        capability: 'artifact.write',
        artifact: {
            id: 'artifact-browser-stable',
            kind: 'interactive-browser',
            title: 'Architecture source',
            payload: { url: 'https://example.com/architecture', title: 'Architecture source' }
        }
    });
    engine.dispatch({
        type: 'artifact.link',
        commandId: 'cmd-link-citation',
        correlationId: 'flow-doc-preview',
        idempotencyKey: 'link-citation-once',
        projectId: graph.project.id,
        actor,
        capability: 'artifact.link',
        edge: {
            type: 'cites',
            source: updateResult.artifactRef,
            target: browserResult.artifactRef,
            sourceAnchor: { type: 'section', sectionId: 's1' }
        }
    });

    const neighbors = engine.selectors.neighbors('artifact-doc-stable');
    const backlinks = engine.selectors.backlinks('artifact-browser-stable');
    assert.strictEqual(neighbors.length, 1);
    assert.strictEqual(neighbors[0].edge.type, 'cites');
    assert.strictEqual(backlinks[0].artifact.id, 'artifact-doc-stable');
    assert.strictEqual(engine.selectors.activeRevision('artifact-doc-stable')?.title, 'Architecture v2');

    const undone = engine.undo('cmd-update-doc', {
        commandId: 'cmd-undo-doc',
        correlationId: 'flow-doc-preview',
        idempotencyKey: 'undo-doc-once',
        actor,
        capability: 'artifact.write'
    });
    assert.strictEqual(undone.status, 'applied');
    assert.strictEqual(engine.selectors.activeRevision('artifact-doc-stable')?.title, 'Architecture');
    assert.strictEqual(Object.keys(graph.revisions).length, 4, 'Undo appends a compensating revision');
    assert.ok(engine.events.some(event => event.type === 'artifact.revised' && event.correlationId === 'flow-doc-preview'));

    const selected: ArtifactRef = engine.dispatch({
        type: 'artifact.select',
        commandId: 'cmd-select-browser',
        correlationId: 'flow-doc-preview',
        idempotencyKey: 'select-browser-once',
        projectId: graph.project.id,
        actor,
        capability: 'artifact.select',
        artifactId: 'artifact-browser-stable'
    }).artifactRef;
    assert.strictEqual(graph.selection?.artifactId, selected.artifactId);
    assert.throws(() => engine.dispatch({
        type: 'artifact.select',
        commandId: 'cmd-select-with-tool-capability',
        correlationId: 'capability-check',
        idempotencyKey: 'select-with-tool-capability',
        projectId: graph.project.id,
        actor,
        capability: 'tool.execute',
        artifactId: 'artifact-browser-stable'
    }), /Capability denied: tool.execute/);

    const serialized = serializeProjectGraph(graph);
    const reloaded = parseProjectGraph(serialized);
    const reloadEngine = new ProjectArtifactGraphEngine(reloaded);
    assert.deepStrictEqual(
        reloadEngine.selectors.relatedArtifacts('artifact-doc-stable').map(item => item.artifact.id),
        ['artifact-browser-stable']
    );

    const legacyArtifact: CanvasArtifact = {
        id: 'legacy-doc-1',
        type: 'markdown-document',
        title: 'Legacy spec',
        summary: 'Imported',
        version: 3,
        createdAt: '10:00 AM',
        data: { title: 'Legacy spec', sections: [] }
    };
    const sessions: ChatSession[] = [{
        id: 'session-1',
        title: 'Legacy session',
        dateCategory: 'Today',
        updatedAt: '10:00 AM',
        messages: [{ id: 'message-1', sender: 'assistant', text: 'See artifact', timestamp: '10:00 AM', artifacts: [legacyArtifact] }],
        activeArtifact: legacyArtifact,
        artifactHistory: [legacyArtifact]
    }];
    const migrated = migrateCanvasSessions(createEmptyProjectGraph('project-migration'), sessions, actor);
    const migratedAgain = migrateCanvasSessions(migrated, sessions, actor);
    assert.strictEqual(Object.keys(migrated.artifacts).length, 1);
    assert.strictEqual(Object.keys(migratedAgain.artifacts).length, 1, 'Session migration is idempotent');
    assert.strictEqual(migrated.artifacts['legacy-doc-1'].legacy?.canvasArtifactId, 'legacy-doc-1');
    assert.strictEqual(sessions[0].messages[0].artifactRefs?.[0].artifactId, 'legacy-doc-1');

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-project-graph-'));
    try {
        const store = new ProjectArtifactStore();
        await store.save(tempRoot, reloaded);
        const persisted = await store.load(tempRoot, graph.project.id);
        assert.ok(persisted);
        assert.strictEqual(persisted!.heads['artifact-doc-stable'], reloaded.heads['artifact-doc-stable']);
        assert.strictEqual(
            (await fs.pathExists(path.join(tempRoot, '.scratchbox', 'project-artifacts.json'))),
            true
        );
    } finally {
        await fs.remove(tempRoot);
    }

    const inMemoryClient = {
        load: async () => createEmptyProjectGraph('project-relations'),
        save: async () => 'backend' as const
    };
    const relationController = new ProjectArtifactController(
        'project-relations',
        actor,
        inMemoryClient as any
    );
    const relatedDocument = relationController.registerArtifact({
        id: 'document-relations',
        type: 'markdown-document',
        title: 'Grounded document',
        summary: 'Citations and generated media',
        version: 1,
        createdAt: 'Now',
        data: {
            title: 'Grounded document',
            sections: [{
                id: 'section-grounded',
                type: 'editorial-image',
                imageUrl: 'https://example.com/generated.png',
                imageTitle: 'Generated architecture',
                citationItems: [{
                    id: 'citation-example',
                    sourceTitle: 'Example source',
                    url: 'https://example.com/source'
                }]
            }]
        }
    }, 'relation-document');
    const documentRelations = relationController.related(relatedDocument.id);
    assert.ok(documentRelations.some(item => item.edge.type === 'cites' && item.artifact.kind === 'interactive-browser'));
    assert.ok(documentRelations.some(item => item.edge.type === 'embeds' && item.artifact.kind === 'image/media'));
    assert.ok(Object.values(relationController.graph.edges).some(edge =>
        edge.type === 'derives-from' && edge.target.artifactId === relatedDocument.id
    ));

    const browserRef = documentRelations.find(item => item.artifact.kind === 'interactive-browser')!.revision
        ? {
            projectId: 'project-relations',
            artifactId: documentRelations.find(item => item.artifact.kind === 'interactive-browser')!.artifact.id
        }
        : undefined;
    const codeArtifact = relationController.registerArtifact({
        id: 'sandbox-relations',
        type: 'live-code-sandbox',
        title: 'Previewed code',
        summary: 'Code with browser preview',
        version: 1,
        createdAt: 'Now',
        data: {
            title: 'Previewed code',
            files: [],
            previewArtifactRef: browserRef
        } as any
    }, 'relation-code-preview');
    assert.ok(relationController.related(codeArtifact.id).some(item => item.edge.type === 'previews'));

    const sceneArtifact = relationController.registerArtifact({
        id: 'scene-relations',
        type: '3d-scene',
        title: 'Grounded scene',
        summary: 'Map-grounded scene',
        version: 1,
        createdAt: 'Now',
        data: {
            title: 'Grounded scene',
            geoAnchor: { lat: 37.7749, lng: -122.4194, active: true },
            objects: [{
                id: 'spatial-image',
                content: { type: 'image', durableUri: 'blob:sha256:test', mimeType: 'image/png', metadata: {} },
                space: {},
                time: { startMs: 0, durationMs: 0 },
                lineage: { version: 1 }
            }]
        }
    }, 'relation-scene');
    const sceneRelations = relationController.related(sceneArtifact.id);
    assert.ok(sceneRelations.some(item => item.edge.type === 'derives-from' && item.artifact.kind === 'map'));
    assert.ok(sceneRelations.some(item => item.edge.type === 'embeds' && item.artifact.kind === 'spatial-media'));

    const proxy = new BrowserProxyService();
    await assert.rejects(
        () => proxy.validateTarget('http://169.254.169.254/latest/meta-data'),
        /metadata targets are blocked/
    );

    console.log('🎉 PROJECT ARTIFACT GRAPH TESTS PASSED');
}

test('project-artifact-graph.test', async () => {
    await runProjectArtifactGraphTests();
}, 180_000);

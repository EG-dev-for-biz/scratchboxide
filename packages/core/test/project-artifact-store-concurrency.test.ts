/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { test } from 'vitest';
import { ProjectArtifactStore } from '../src/node/project-artifact-store';
import { createEmptyProjectGraph } from '../src/common/project-artifact-graph-protocol';

/**
 * The renderer fires many `POST /workspace/project-artifacts` in quick succession
 * (one per artifact registration). Concurrent saves used to share one temp file
 * name (`<file>.<pid>.tmp`), so one writer's `rename` raced another's and failed
 * with ENOENT. Saves to the same root must serialise and every write must land.
 */
test('ProjectArtifactStore.save survives concurrent writers to the same workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-artifact-store-'));
    const store = new ProjectArtifactStore();
    try {
        const writers = Array.from({ length: 25 }, (_, i) => {
            const graph = createEmptyProjectGraph('proj-concurrent');
            graph.project.name = `write-${i}`;
            return store.save(root, graph);
        });
        await Promise.all(writers);

        const loaded = await store.load(root, 'proj-concurrent');
        assert.ok(loaded, 'graph must exist after concurrent saves');
        assert.strictEqual(loaded!.project.name, 'write-24', 'the last save in order must win');

        const leftovers = (await fs.readdir(path.join(root, '.scratchbox'))).filter(f => f.endsWith('.tmp'));
        assert.deepStrictEqual(leftovers, [], 'no temp files may be left behind');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ProjectArtifactStore.save to different roots does not block each other', async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-artifact-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-artifact-b-'));
    const store = new ProjectArtifactStore();
    try {
        await Promise.all([
            store.save(a, createEmptyProjectGraph('proj-a')),
            store.save(b, createEmptyProjectGraph('proj-b'))
        ]);
        assert.strictEqual((await store.load(a, 'proj-a'))!.project.id, 'proj-a');
        assert.strictEqual((await store.load(b, 'proj-b'))!.project.id, 'proj-b');
    } finally {
        fs.rmSync(a, { recursive: true, force: true });
        fs.rmSync(b, { recursive: true, force: true });
    }
});

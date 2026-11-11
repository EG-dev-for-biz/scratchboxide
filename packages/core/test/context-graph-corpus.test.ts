/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
/**
 * What the symbol index takes in: the workspace's own source, and nothing else. Before this, the walk read the first
 * 200 files it reached in `readdir` order with no `.gitignore` awareness, which on this repository meant 188 camera
 * pose JSON files inside `.claude/worktrees` and not one file from `packages/`.
 */
import { test } from 'vitest';
import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ProjectContextGraphService } from '../src/node/project-context-graph-service';

/** A workspace holding one real source file plus every kind of file the index must leave out. */
async function writeFixture(root: string): Promise<void> {
    await fs.ensureDir(path.join(root, 'src'));
    await fs.writeFile(
        path.join(root, 'src', 'billing.ts'),
        'export function chargeInvoice(amount: number): number { return amount * 2; }\n'
    );

    // Ignored by .gitignore, and by name in the directory walk.
    await fs.ensureDir(path.join(root, '.claude', 'worktrees', 'agent-1', 'stations'));
    for (let i = 0; i < 40; i++) {
        await fs.writeFile(path.join(root, '.claude', 'worktrees', 'agent-1', 'stations', `station_${i}.pose.json`), '{"yaw":0}');
        await fs.writeFile(path.join(root, '.claude', 'worktrees', 'agent-1', 'stations', `station_${i}.ts`), 'export const yaw = 0;\n');
    }

    // Dependencies and build output.
    await fs.ensureDir(path.join(root, 'node_modules', 'left-pad'));
    await fs.writeFile(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = function pad() {};\n');
    await fs.ensureDir(path.join(root, 'dist'));
    await fs.writeFile(path.join(root, 'dist', 'bundle.js'), 'export function bundled() {}\n');

    // Vendored, oversized, and data: excluded by directory, by size, and by extension.
    await fs.ensureDir(path.join(root, 'public'));
    await fs.writeFile(path.join(root, 'public', 'three.min.js'), 'export function vendored() {}\n');
    await fs.writeFile(path.join(root, 'src', 'generated.ts'), `export const blob = "${'x'.repeat(600 * 1024)}";\n`);
    await fs.writeFile(path.join(root, 'src', 'manifest.json'), '{"name":"chargeInvoice"}');

    await fs.writeFile(path.join(root, '.gitignore'), '.claude/\nnode_modules/\ndist/\n');
}

function indexedPaths(graph: ProjectContextGraphService): string[] {
    return graph.getGraph().nodes
        .filter(n => n.type === 'workspace-file')
        .map(n => n.path!)
        .sort();
}

test('context-graph-corpus: the index holds the workspace source and nothing else', async () => {
    const root = path.join(os.tmpdir(), `sb-corpus-git-${Date.now()}`);
    await writeFixture(root);

    let gitAvailable = true;
    try {
        execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    } catch {
        gitAvailable = false;
    }

    const graph = new ProjectContextGraphService();
    const count = await graph.indexWorkspaceDirectory(root);

    assert.deepStrictEqual(indexedPaths(graph), ['src/billing.ts'],
        'only the workspace source file is indexed: no pose JSON, no worktree, no node_modules, no dist, no vendored or oversized file');
    assert.strictEqual(count, 1, 'the reported count is the number of files actually indexed');
    assert.ok(graph.getAllSymbols().some(s => s.name === 'chargeInvoice'), 'its symbols are retrievable');
    assert.strictEqual(graph.retrieveSymbolGraph('charge invoice amount').matchingSymbols[0]?.name, 'chargeInvoice');

    // The git enumeration and the directory walk must agree on this fixture: one path either way.
    if (gitAvailable) {
        await fs.remove(path.join(root, '.git'));
        const walked = new ProjectContextGraphService();
        await walked.indexWorkspaceDirectory(root);
        assert.deepStrictEqual(indexedPaths(walked), ['src/billing.ts'],
            'the directory walk excludes the same files by name, size and extension when git cannot answer');
    }

    await fs.remove(root);
});

test('context-graph-corpus: re-indexing and removal leave no stale symbol behind', async () => {
    const root = path.join(os.tmpdir(), `sb-corpus-stale-${Date.now()}`);
    await fs.ensureDir(path.join(root, 'src'));
    const file = path.join(root, 'src', 'shipping.ts');
    await fs.writeFile(file, 'export function quoteFreight(kg: number): number { return kg; }\n');

    const graph = new ProjectContextGraphService();
    await graph.indexWorkspaceDirectory(root);
    assert.ok(graph.getAllSymbols().some(s => s.name === 'quoteFreight'));

    // A saved edit that renames the symbol: the old name must not survive in the symbols or the edges.
    graph.indexSourceFile('src/shipping.ts', 'export function quoteParcel(kg: number): number { return kg; }\n');
    const names = graph.getAllSymbols().map(s => s.name);
    assert.ok(names.includes('quoteParcel'), 'the new symbol is indexed');
    assert.ok(!names.includes('quoteFreight'), 'the old symbol is gone');
    assert.ok(
        !graph.retrieveSymbolGraph('quoteFreight').matchingSymbols.some(s => s.name === 'quoteFreight'),
        'and is not retrievable (the shared "quote" token still reaches the renamed symbol, which is correct)'
    );

    const edgeIds = new Set(graph.getGraph().edges.flatMap(e => [e.sourceId, e.targetId]));
    const liveIds = new Set([...graph.getAllSymbols().map(s => s.id), ...graph.getGraph().nodes.map(n => n.id)]);
    for (const id of edgeIds) {
        assert.ok(liveIds.has(id), `every edge endpoint still exists in the graph (${id})`);
    }

    // A deleted file leaves neither its symbols nor its file node.
    graph.removeSourceFile('src/shipping.ts');
    assert.strictEqual(graph.getAllSymbols().length, 0, 'no symbols remain');
    assert.strictEqual(indexedPaths(graph).length, 0, 'no file node remains');
    assert.strictEqual(graph.getGraph().edges.length, 0, 'no edges remain');

    await fs.remove(root);
});

test('context-graph-corpus: a name hundreds of symbols share wires no reference edges', async () => {
    const root = path.join(os.tmpdir(), `sb-corpus-fanout-${Date.now()}`);
    await fs.ensureDir(path.join(root, 'src'));

    // Twenty files each declaring `render`, then a caller depending on the name: linking it to all twenty would say
    // only that the name is common, so the resolver links none of them.
    for (let i = 0; i < 20; i++) {
        await fs.writeFile(path.join(root, 'src', `widget${i}.ts`), 'export function render(): void {}\n');
    }
    await fs.writeFile(
        path.join(root, 'src', 'caller.ts'),
        'export function draw(): void { render(); }\n'
    );

    const graph = new ProjectContextGraphService();
    await graph.indexWorkspaceDirectory(root);

    const drawId = graph.getAllSymbols().find(s => s.name === 'draw')?.id;
    assert.ok(drawId, 'the caller is indexed');
    const references = graph.getGraph().edges.filter(e => e.sourceId === drawId && e.relation === 'references');
    assert.strictEqual(references.length, 0, 'an ambiguous dependency name resolves to no symbol');

    // The same name declared in the caller's own file does resolve, because the file settles which one it is.
    graph.indexSourceFile('src/caller.ts', 'export function render(): void {}\nexport function draw(): void { render(); }\n');
    const localDrawId = graph.getAllSymbols().find(s => s.name === 'draw')?.id;
    const localRefs = graph.getGraph().edges.filter(e => e.sourceId === localDrawId && e.relation === 'references');
    assert.ok(localRefs.length > 0, 'a dependency declared in the same file resolves to it');
    assert.ok(
        localRefs.every(e => graph.getAllSymbols().find(s => s.id === e.targetId)?.filePath === 'src/caller.ts'),
        'and only to it'
    );

    await fs.remove(root);
});

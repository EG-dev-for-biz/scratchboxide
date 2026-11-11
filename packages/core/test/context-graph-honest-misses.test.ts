/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
/**
 * What the retrieval says when it finds nothing. A miss used to be dressed as context: the slice returned the first
 * twenty nodes in insertion order, and the search tools answered "Found 0 semantic match(es)" whether the index held
 * the whole codebase or 200 files of camera poses. Both now report what the index covers.
 */
import { test } from 'vitest';
import * as assert from 'node:assert';
import { ProjectContextGraphService } from '../src/node/project-context-graph-service';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';
import { LspDiagnosticFeedbackService } from '../src/node/lsp-diagnostic-feedback-service';
import { BrowserProxyService } from '../src/node/browser-proxy-service';
import { LensBridge } from '../src/node/gemini/lens-bridge';
import { createDefaultToolRegistry, type ToolContext } from '../src/node/gemini/tool-registry';

function contextWith(contextGraph: ProjectContextGraphService): ToolContext {
    return {
        request: { prompt: 'test', workspaceRoot: '/tmp/ws' },
        workspaceRoot: '/tmp/ws',
        sandbox: new ContainerSandboxService(),
        lsp: new LspDiagnosticFeedbackService(),
        contextGraph,
        browserProxy: new BrowserProxyService(),
        lens: new LensBridge()
    };
}

function graphWithOneFile(): ProjectContextGraphService {
    const graph = new ProjectContextGraphService();
    graph.indexSourceFile('src/billing.ts', 'export function chargeInvoice(amount: number): number { return amount; }\n');
    return graph;
}

test('context-graph-honest-misses: a slice that matched nothing says so, and names no node', () => {
    const graph = graphWithOneFile();
    const slice = graph.getContextSlice(undefined, { maxChars: 1500, query: 'quantum teleportation of parakeets' });

    assert.strictEqual(slice.nodes.length, 0, 'no node is presented as context for a request nothing matched');
    assert.ok(/nothing in the graph matched/i.test(slice.compressedPromptContext), 'the slice says it matched nothing');
    assert.ok(/1 file/.test(slice.compressedPromptContext), 'and how many files the index holds');
    assert.ok(!slice.compressedPromptContext.includes('billing.ts'), 'the unrelated file is not named');

    // A query that does match still gets its subgraph.
    const hit = graph.getContextSlice(undefined, { maxChars: 1500, query: 'charge invoice' });
    assert.ok(hit.nodes.length > 0, 'a matching query selects nodes');
    assert.ok(!/nothing in the graph matched/i.test(hit.compressedPromptContext));
});

test('context-graph-honest-misses: an empty index is distinguishable from a query that found nothing', () => {
    const empty = new ProjectContextGraphService();
    assert.deepStrictEqual(empty.getIndexCoverage(), { files: 0, symbols: 0 });
    const slice = empty.getContextSlice(undefined, { maxChars: 1500, query: 'charge invoice' });
    assert.ok(/0 symbols indexed from 0 file/.test(slice.compressedPromptContext),
        `an empty index reports itself as empty, not as a miss: ${slice.compressedPromptContext}`);

    const stocked = graphWithOneFile();
    const coverage = stocked.getIndexCoverage();
    assert.strictEqual(coverage.files, 1);
    assert.ok(coverage.symbols >= 1);

    // Removing the file leaves the coverage count honest, symbols or no symbols.
    stocked.removeSourceFile('src/billing.ts');
    assert.deepStrictEqual(stocked.getIndexCoverage(), { files: 0, symbols: 0 });
});

test('context-graph-honest-misses: the slice budget is characters, under either option name', () => {
    const graph = graphWithOneFile();
    for (let i = 0; i < 40; i++) {
        graph.indexSourceFile(`src/mod${i}.ts`, `export function chargeStep${i}(amount: number): number { return amount; }\n`);
    }

    const tight = graph.getContextSlice(undefined, { maxChars: 200, query: 'charge' });
    assert.ok(tight.compressedPromptContext.length <= 200 + '...[TRUNCATED]'.length,
        `maxChars bounds the rendering in characters (got ${tight.compressedPromptContext.length})`);

    // The old name meant characters all along, and still does, so existing callers are unchanged.
    const legacy = graph.getContextSlice(undefined, { maxTokens: 200, query: 'charge' });
    assert.strictEqual(legacy.compressedPromptContext, tight.compressedPromptContext);
});

test('context-graph-honest-misses: the search tools report what the index covers', async () => {
    const registry = createDefaultToolRegistry();
    const graph = graphWithOneFile();
    const ctx = contextWith(graph);

    // The model is handed the result payload, not the UI summary, so the payload carries the reach of the miss.
    const miss = await registry.dispatch('workspace_semantic_search', { query: 'quantum teleportation of parakeets' }, ctx);
    const missPayload = miss.resultPayload as { count: number; indexedFiles: number; indexedSymbols: number; note?: string };
    assert.strictEqual(missPayload.count, 0);
    assert.strictEqual(missPayload.indexedFiles, 1, 'a miss carries the number of files searched');
    assert.ok(missPayload.indexedSymbols >= 1, 'and the number of symbols searched');
    assert.ok(/covers \d+ symbols from 1 source file/.test(missPayload.note ?? ''), missPayload.note);
    assert.ok(/by word, not meaning/.test(missPayload.note ?? ''), 'and says what kind of match it ran');

    const hit = await registry.dispatch('workspace_semantic_search', { query: 'charge invoice' }, ctx);
    const hitPayload = hit.resultPayload as { count: number; matches: Array<{ name: string; matchWeight?: number }> };
    assert.ok(hitPayload.count >= 1);
    assert.strictEqual(hitPayload.matches[0].name, 'chargeInvoice');
    assert.strictEqual(typeof hitPayload.matches[0].matchWeight, 'number', 'the score is reported as a match weight');

    const symbolMiss = await registry.dispatch('workspace_find_symbols', { query: 'noSuchSymbolAnywhere' }, ctx);
    const symbolMissNote = (symbolMiss.resultPayload as { note?: string }).note ?? '';
    assert.ok(/covers \d+ symbols from 1 source file/.test(symbolMissNote), symbolMissNote);

    // An empty index says so, rather than letting a miss read as a fact about the codebase.
    const emptyCtx = contextWith(new ProjectContextGraphService());
    const onEmpty = await registry.dispatch('workspace_semantic_search', { query: 'charge invoice' }, emptyCtx);
    assert.ok(/it is empty, so this is not evidence about the codebase/.test((onEmpty.resultPayload as { note?: string }).note ?? ''),
        (onEmpty.resultPayload as { note?: string }).note);
});

test('context-graph-honest-misses: the tool descriptions claim only what the index does', () => {
    const registry = createDefaultToolRegistry();
    const declared = registry.declarations().find(d => d.name === 'workspace_semantic_search');
    assert.ok(declared, 'the tool is declared');
    const description = declared!.description;

    assert.ok(!/semantic vector|vector search|embedding search/i.test(description.replace(/not an embedding search/i, '')),
        `the description must not offer vector or embedding search: ${description}`);
    assert.ok(/word/i.test(description), 'it says the match is by word');
    assert.ok(/grep/i.test(description), 'and points at grep for text that is not a declaration');
});

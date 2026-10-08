import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    GeminiClient,
    DEFAULT_GEMINI_MODEL,
    FALLBACK_GEMINI_MODELS,
    isModelNotFoundError,
    isTransientError,
    maskEmail
} from '../src/node/gemini/gemini-client';
import {
    ToolRegistry,
    buildToolDeclarations,
    createDefaultToolRegistry,
    inferToolGroup,
    type ToolContext
} from '../src/node/gemini/tool-registry';
import { LensBridge } from '../src/node/gemini/lens-bridge';
import { McpBridge } from '../src/node/gemini/mcp-bridge';
import { mergeGroundingMetadata, parseSseDataLine } from '../src/node/gemini/streaming';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';
import { LspDiagnosticFeedbackService } from '../src/node/lsp-diagnostic-feedback-service';
import { ProjectContextGraphService } from '../src/node/project-context-graph-service';
import { BrowserProxyService } from '../src/node/browser-proxy-service';

function makeClient(): GeminiClient {
    // Point discovery at a non-existent path so the client never picks up real credentials.
    return new GeminiClient({
        serviceAccountCandidatePaths: [path.join(os.tmpdir(), 'scratchbox-no-such-service-account.json')],
        transientRetries: 1,
        retryBaseDelayMs: 1
    });
}

function makeToolContext(workspaceRoot: string): ToolContext {
    return {
        request: { prompt: 'test', workspaceRoot },
        workspaceRoot,
        sandbox: new ContainerSandboxService(),
        lsp: new LspDiagnosticFeedbackService(),
        contextGraph: new ProjectContextGraphService(),
        browserProxy: new BrowserProxyService(),
        lens: new LensBridge()
    };
}

test('GeminiClient model candidates, fallback and error classification', async () => {
    // `getStatus()` re-runs discovery, so keep inline credentials hidden for the whole test.
    const savedInlineCreds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    try {
        await runClientAssertions();
    } finally {
        if (savedInlineCreds !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_JSON = savedInlineCreds;
    }
});

async function runClientAssertions(): Promise<void> {
    const client = makeClient();
    assert.deepStrictEqual(client.getModelCandidates(), [DEFAULT_GEMINI_MODEL, ...FALLBACK_GEMINI_MODELS]);
    assert.deepStrictEqual(client.getModelCandidates('gemini-2.5-flash'), ['gemini-2.5-flash', 'gemini-2.5-pro']);
    assert.deepStrictEqual(client.getThinkingConfig({}), { thinkingBudget: 1024 });
    assert.deepStrictEqual(client.getThinkingConfig({ thinkingBudget: 42 }), { thinkingBudget: 42 });

    assert.ok(isModelNotFoundError(new Error('AI request failed (404): model not found')));
    assert.ok(!isModelNotFoundError(new Error('AI request failed (500): boom')));
    assert.ok(isTransientError(new Error('AI request failed (503): overloaded')));
    assert.ok(!isTransientError(new Error('AI request failed (400): bad request')));

    // 404 advances to the next candidate and the winner becomes preferred.
    const tried: string[] = [];
    const result = await client.withModelFallback(['a', 'b', 'c'], async model => {
        tried.push(model);
        if (model !== 'b') throw new Error(`(404) ${model} not found`);
        return `ok:${model}`;
    }, { onSuccess: model => { client.preferredModel = model; } });
    assert.strictEqual(result, 'ok:b');
    assert.deepStrictEqual(tried, ['a', 'b']);
    assert.strictEqual(client.preferredModel, 'b');

    // Non-404 errors propagate immediately (no further candidates tried).
    const tried2: string[] = [];
    await assert.rejects(
        client.withModelFallback(['a', 'b'], async model => { tried2.push(model); throw new Error('(400) bad request'); }),
        /400/
    );
    assert.deepStrictEqual(tried2, ['a']);

    // Transient errors are retried once with backoff, then succeed.
    let attempts = 0;
    const retried = await client.withModelFallback(['a'], async () => {
        attempts++;
        if (attempts === 1) throw new Error('(503) UNAVAILABLE');
        return 'recovered';
    });
    assert.strictEqual(retried, 'recovered');
    assert.strictEqual(attempts, 2);

    // Unauthenticated client (no SA, no API key) reports status without throwing.
    client.resolveApiKey = async () => undefined;
    const status = await client.getStatus();
    assert.strictEqual(status.connected, false);
    assert.strictEqual(status.authMethod, 'unauthenticated');
    assert.ok(!status.error?.includes('Downloads'));
    await assert.rejects(client.getAccessToken(), /not authenticated/);

    // API key fallback reports connected: true with authMethod: 'api-key'.
    client.resolveApiKey = async () => 'test-api-key-12345';
    const apiKeyStatus = await client.getStatus();
    assert.strictEqual(apiKeyStatus.connected, true);
    assert.strictEqual(apiKeyStatus.authMethod, 'api-key');

    assert.strictEqual(maskEmail('robot-account@project.iam.gserviceaccount.com'), 'rob***nt@project.iam.gserviceaccount.com');
}

test('ToolRegistry registers, declares and dispatches tools with ToolContext', async () => {
    const registry = new ToolRegistry();
    registry.register('workspace_echo', { name: 'workspace_echo', description: 'echo', parameters: { type: 'OBJECT', properties: {} } },
        (args, ctx) => ({ resultPayload: { status: 'success', echoed: args.value, root: ctx.workspaceRoot }, summaryResult: 'echoed' }));
    registry.register('lens_boom', { name: 'lens_boom', description: 'boom' }, () => { throw new Error('kaboom'); });

    assert.deepStrictEqual(registry.declarations(['workspace']).map(d => d.name), ['workspace_echo']);
    assert.deepStrictEqual(registry.declarations().map(d => d.name), ['workspace_echo', 'lens_boom']);
    assert.strictEqual(inferToolGroup('browser_click'), 'browser');
    assert.strictEqual(inferToolGroup('stripe_balance'), 'mcp');

    const ctx = makeToolContext('/tmp/ws');
    const ok = await registry.dispatch('workspace_echo', { value: 7 }, ctx);
    assert.strictEqual(ok.exec.status, 'completed');
    assert.strictEqual(ok.exec.mcpServerId, 'mcp-scratchbox-workspace');
    assert.deepStrictEqual(ok.resultPayload, { status: 'success', echoed: 7, root: '/tmp/ws' });

    const failed = await registry.dispatch('lens_boom', {}, ctx);
    assert.strictEqual(failed.exec.status, 'failed');
    assert.strictEqual(failed.exec.mcpServerId, 'mcp-scratchbox-lens');
    assert.deepStrictEqual(failed.resultPayload, { success: false, error: 'kaboom' });

    // Unknown names with a known prefix fail (workspace/lens/browser); others hit the fallback.
    const unknownWs = await registry.dispatch('workspace_nope', {}, ctx);
    assert.strictEqual(unknownWs.exec.status, 'failed');
    assert.match(String(unknownWs.resultPayload.error), /Unknown workspace tool/);
    const unknownBrowser = await registry.dispatch('browser_nope', {}, ctx);
    assert.strictEqual(unknownBrowser.exec.status, 'failed');

    let fallbackSeen = '';
    registry.setFallback(call => {
        fallbackSeen = call.name;
        return { exec: new McpBridge().synthesizeExecution(call, ctx.lens), resultPayload: { status: 'success' } };
    });
    const mcp = await registry.dispatch('stripe_balance', {}, ctx);
    assert.strictEqual(fallbackSeen, 'stripe_balance');
    assert.strictEqual(mcp.exec.mcpServerId, 'mcp-stripe');
});

test('default registry executes workspace file tools against a temp workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-tools-'));
    try {
        const registry = createDefaultToolRegistry();
        const ctx = makeToolContext(root);

        const write = await registry.dispatch('workspace_write_file', { filePath: 'notes/a.txt', content: 'alpha\nbeta\ngamma' }, ctx);
        assert.strictEqual(write.exec.status, 'completed');
        assert.strictEqual(write.resultPayload.bytesWritten, 16);

        const read = await registry.dispatch('workspace_read_file', { filePath: 'notes/a.txt', startLine: 2, endLine: 2 }, ctx);
        assert.strictEqual(read.resultPayload.content, 'beta');
        assert.strictEqual(read.resultPayload.totalLines, 3);

        const diff = await registry.dispatch('workspace_apply_diff', { filePath: 'notes/a.txt', targetContent: 'beta', replacementContent: 'BETA' }, ctx);
        assert.strictEqual(diff.exec.status, 'completed');
        assert.strictEqual(await fs.readFile(path.join(root, 'notes/a.txt'), 'utf-8'), 'alpha\nBETA\ngamma');

        const search = await registry.dispatch('workspace_search', { query: 'BETA' }, ctx);
        assert.strictEqual(search.resultPayload.matchesCount, 1);

        const list = await registry.dispatch('workspace_list_directory', { directoryPath: '.', recursive: true }, ctx);
        assert.ok((list.resultPayload.entries as unknown[]).length >= 2);

        const missing = await registry.dispatch('workspace_read_file', { filePath: 'nope.txt' }, ctx);
        assert.strictEqual(missing.exec.status, 'failed');
        assert.match(String(missing.resultPayload.error), /File not found/);

        // Request-driven declaration selection mirrors the pre-split behaviour.
        const tools = buildToolDeclarations({ prompt: 'edit this file and project it via lens', enableGoogleSearch: false }, registry, []);
        const fnDecls = tools?.find(t => 'functionDeclarations' in t);
        assert.ok(fnDecls && 'functionDeclarations' in fnDecls);
        const names = fnDecls.functionDeclarations.map(d => d.name);
        assert.ok(names.includes('workspace_read_file') && names.includes('lens_project') && !names.includes('browser_navigate'));
        assert.strictEqual(buildToolDeclarations({ prompt: 'hello', enableGoogleSearch: false, enableWorkspaceTools: false }, registry, []), undefined);
    } finally {
        await fs.remove(root);
    }
});

test('streaming helpers: SSE line parsing and grounding metadata merge', () => {
    assert.deepStrictEqual(parseSseDataLine('data: {"a":1}'), { a: 1 });
    assert.strictEqual(parseSseDataLine('data: [DONE]'), undefined);
    assert.strictEqual(parseSseDataLine('event: ping'), undefined);
    assert.strictEqual(parseSseDataLine('data: {"partial":'), undefined);

    const merged = mergeGroundingMetadata(
        { webSearchQueries: ['q1'], groundingChunks: [{ web: { uri: 'https://a', title: 'A' } }] },
        { webSearchQueries: ['q1', 'q2'], groundingChunks: [{ web: { uri: 'https://a' } }, { web: { uri: 'https://b' } }], searchEntryPoint: { renderedContent: '<x/>' } }
    );
    assert.deepStrictEqual(merged?.webSearchQueries, ['q1', 'q2']);
    assert.deepStrictEqual(merged?.groundingChunks?.map(c => c.web?.uri), ['https://a', 'https://b']);
    assert.strictEqual(merged?.searchEntryPoint?.renderedContent, '<x/>');
    assert.strictEqual(mergeGroundingMetadata(undefined, undefined), undefined);
});

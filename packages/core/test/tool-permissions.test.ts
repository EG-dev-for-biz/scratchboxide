import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { GeminiClient } from '../src/node/gemini/gemini-client';
import { buildToolDeclarations, createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { LensBridge } from '../src/node/gemini/lens-bridge';
import { McpBridge } from '../src/node/gemini/mcp-bridge';
import { StreamingEngine } from '../src/node/gemini/streaming';
import { READ_ONLY_TOOLS } from '../src/node/gemini/tool-permissions';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';
import { LspDiagnosticFeedbackService } from '../src/node/lsp-diagnostic-feedback-service';
import { ProjectContextGraphService } from '../src/node/project-context-graph-service';
import { BrowserProxyService } from '../src/node/browser-proxy-service';

function offeredNames(mode: string): string[] {
    const tools = buildToolDeclarations({ prompt: 'edit the file and build a 3d model', mode, enableWorkspaceTools: true } as any, createDefaultToolRegistry());
    return (tools || []).flatMap(t => ('functionDeclarations' in t ? (t as any).functionDeclarations.map((d: any) => d.name) : []));
}

function makeEngine(root: string): StreamingEngine {
    const registry = createDefaultToolRegistry();
    const lens = new LensBridge();
    return new StreamingEngine({
        client: new GeminiClient(),
        registry,
        mcp: new McpBridge(),
        lens,
        promptServices: () => ({}) as any,
        toolContext: request => ({
            request,
            workspaceRoot: root,
            sandbox: new ContainerSandboxService(),
            lsp: new LspDiagnosticFeedbackService(),
            contextGraph: new ProjectContextGraphService(),
            browserProxy: new BrowserProxyService(),
            lens
        }),
        executeSubagentTask: async () => ({ success: true, text: '' }) as any
    });
}

test('Plan and Ask are offered only read-only tools; Agent keeps write tools', () => {
    for (const mode of ['plan', 'ask']) {
        const names = offeredNames(mode);
        assert.ok(names.includes('workspace_read_file'), `${mode} should offer reads`);
        const writable = names.filter(n => !READ_ONLY_TOOLS.has(n));
        assert.deepStrictEqual(writable, [], `${mode} offered write tools: ${writable.join(', ')}`);
    }
    const agent = offeredNames('agent');
    assert.ok(agent.includes('workspace_write_file') && agent.includes('mount_canvas_primitive'));
});

test('a write tool called in Plan mode is refused and the file is untouched', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-perm-'));
    const engine = makeEngine(root);
    const result = await engine.executeToolCall(
        { name: 'workspace_write_file', args: { filePath: 'a.txt', content: 'x' } },
        { prompt: 'p', mode: 'plan', workspaceRoot: root } as any
    );
    assert.strictEqual(result.exec.status, 'failed');
    assert.match(String((result.resultPayload as any).error), /not available in Plan mode/);
    assert.strictEqual(await fs.pathExists(path.join(root, 'a.txt')), false);

    const write = await engine.executeToolCall(
        { name: 'workspace_write_file', args: { filePath: 'a.txt', content: 'x' } },
        { prompt: 'p', mode: 'agent', workspaceRoot: root } as any
    );
    assert.strictEqual(write.exec.status, 'completed');
});

test('an unconnected MCP tool reports failure instead of a made-up result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-mcp-'));
    const result = await makeEngine(root).executeToolCall(
        { name: 'stripe_balance', args: {} },
        { prompt: 'p', mode: 'agent', workspaceRoot: root } as any
    );
    assert.strictEqual(result.exec.status, 'failed');
    assert.strictEqual((result.resultPayload as any).success, false);
    assert.match(String((result.resultPayload as any).error), /nothing was executed/);
});

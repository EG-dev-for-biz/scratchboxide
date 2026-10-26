import { test } from 'vitest';
import * as assert from 'node:assert';
import * as os from 'node:os';
import { GeminiClient } from '../src/node/gemini/gemini-client';
import { buildToolDeclarations, createDefaultToolRegistry, registerTools, ToolRegistry } from '../src/node/gemini/tool-registry';
import { LensBridge } from '../src/node/gemini/lens-bridge';
import { McpBridge } from '../src/node/gemini/mcp-bridge';
import { StreamingEngine } from '../src/node/gemini/streaming';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';
import { LspDiagnosticFeedbackService } from '../src/node/lsp-diagnostic-feedback-service';
import { ProjectContextGraphService } from '../src/node/project-context-graph-service';
import { BrowserProxyService } from '../src/node/browser-proxy-service';

const offered = (tools: ReturnType<typeof buildToolDeclarations>): string[] =>
    (tools || []).flatMap(t => ('functionDeclarations' in t ? (t as any).functionDeclarations.map((d: any) => d.name) : []));

function makeEngine(): StreamingEngine {
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
            workspaceRoot: os.tmpdir(),
            sandbox: new ContainerSandboxService(),
            lsp: new LspDiagnosticFeedbackService(),
            contextGraph: new ProjectContextGraphService(),
            browserProxy: new BrowserProxyService(),
            lens
        }),
        executeSubagentTask: async () => ({ success: true, text: '' }) as any
    });
}

test('the default registry builds with every tool registered once and runnable', () => {
    const registry = createDefaultToolRegistry();
    const names = registry.names();
    assert.strictEqual(new Set(names).size, names.length);
    for (const n of names) assert.strictEqual(typeof registry.get(n)!.handler, 'function', `${n} has no handler`);
});

test('registerTools refuses a name registered twice and a declaration with no handler', () => {
    const registry = new ToolRegistry();
    const decl = { name: 'workspace_dup', description: 'd', parameters: { type: 'OBJECT', properties: {} } } as any;
    const handler = async () => ({ resultPayload: { status: 'success' } }) as any;
    registerTools(registry, [decl], { workspace_dup: handler }, 'workspace');
    assert.throws(() => registerTools(registry, [decl], { workspace_dup: handler }, 'workspace'), /workspace_dup.*registered twice/);
    assert.throws(() => registerTools(registry, [{ ...decl, name: 'workspace_nohandler' }], {}, 'workspace'), /workspace_nohandler.*no handler/);
});

test('tool packs never bring back a group the request switched off', () => {
    const registry = createDefaultToolRegistry();
    const off = offered(buildToolDeclarations({ prompt: 'x', enableWorkspaceTools: false, enableLensTools: false, enableBrowserTools: false, enableGoogleSearch: false, toolPacks: ['core_workspace', 'geospatial_3d'] } as any, registry));
    assert.deepStrictEqual(off, []);
    const on = offered(buildToolDeclarations({ prompt: 'x', enableGoogleSearch: false, toolPacks: ['geospatial_3d'] } as any, registry));
    assert.ok(on.length > 0 && on.every(n => registry.get(n)?.group === 'workspace' || registry.get(n)?.group === 'lens' || registry.get(n)?.group === 'browser'));
});

test('attached MCP tools are not offered, and calling one reports it is not connected whatever its name', async () => {
    const engine = makeEngine();
    const attachedMcpTools = [
        { id: 'a', serverName: 'reports', name: 'generate_report', humanTitle: 'Report', description: 'makes a report' },
        { id: 'b', serverName: 'crm', name: 'list-accounts', humanTitle: 'Accounts', description: 'lists accounts' }
    ];
    const request = { prompt: 'x', enableGoogleSearch: false, attachedMcpTools } as any;
    const names = offered(engine.buildToolDeclarations(request));
    assert.ok(!names.includes('generate_report') && !names.includes('list_accounts'));

    for (const name of ['generate_report', 'list_accounts']) {
        const result = await engine.executeToolCall({ name, args: {} } as any, request);
        assert.strictEqual(result.exec.status, 'failed', name);
        assert.match(String(result.resultPayload.error ?? result.exec.summaryResult), /not connected to a live MCP server/, name);
    }
    // A registered tool still runs even when an attached MCP tool shares the prefix.
    const real = await engine.executeToolCall({ name: 'workspace_list_directory', args: { path: '.' } } as any, request);
    assert.doesNotMatch(String(real.resultPayload.error ?? ''), /not connected to a live MCP server/);
});

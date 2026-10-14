import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    createDefaultToolRegistry,
    type ToolContext
} from '../src/node/gemini/tool-registry';
import { buildSystemInstruction } from '../src/node/gemini/prompt-builder';
import { AgentVerificationService } from '../src/node/gemini/agent-verification-service';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';
import { LspDiagnosticFeedbackService } from '../src/node/lsp-diagnostic-feedback-service';
import { ProjectContextGraphService } from '../src/node/project-context-graph-service';
import { BrowserProxyService } from '../src/node/browser-proxy-service';
import { LensBridge } from '../src/node/gemini/lens-bridge';

function createMockContext(workspaceRoot: string, mode: 'agent' | 'plan' | 'ask' | 'studio' = 'agent'): ToolContext {
    return {
        request: { prompt: 'test coding', workspaceRoot, mode },
        workspaceRoot,
        sandbox: new ContainerSandboxService(),
        lsp: new LspDiagnosticFeedbackService(),
        contextGraph: new ProjectContextGraphService(),
        browserProxy: new BrowserProxyService(),
        lens: new LensBridge(),
        executeSubagent: async req => ({
            success: true,
            result: `Subagent response for: ${req.prompt}`,
            modelUsed: 'gemini-2.5-pro'
        })
    };
}

test('Phase 1: Mode personas and instructions decouple coding from visual canvas JSON', async () => {
    const mockServices = {
        contextGraph: new ProjectContextGraphService(),
        lens: new LensBridge()
    };

    // Agent mode
    const agentText = await buildSystemInstruction({ prompt: 'Implement auth', mode: 'agent' }, mockServices);
    assert.ok(agentText.includes('elite autonomous pair-programming software engineer'), 'Agent persona must be present');
    assert.ok(agentText.includes('Test-Driven Verification & Self-Healing'), 'Agent verification principles must be present');
    assert.ok(!agentText.includes('ALWAYS output valid JSON inside a ```json``` codeblock'), 'Agent mode must NOT mandate visual canvas JSON');

    // Plan mode
    const planText = await buildSystemInstruction({ prompt: 'Design architecture', mode: 'plan' }, mockServices);
    assert.ok(planText.includes('Scratchbox AI in Planning Mode'), 'Planning persona must be present');
    assert.ok(planText.includes('Read-Only Exploration'), 'Planning read-only exploration rules must be present');
    assert.ok(planText.includes('User Alignment Gate'), 'User alignment gate must be present');

    // Ask mode
    const askText = await buildSystemInstruction({ prompt: 'Explain how X works', mode: 'ask' }, mockServices);
    assert.ok(askText.includes('Ask / Exploration Mode'), 'Ask exploration persona must be present');
    assert.ok(askText.includes('Do NOT modify workspace files'), 'Ask mode must restrict file modifications');
});

test('Phase 1 & 2: Plan mode write guards prevent modifications during planning', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-plan-guard-'));
    try {
        const filePath = path.join(tempDir, 'test.ts');
        await fs.writeFile(filePath, 'const a = 1;');

        const registry = createDefaultToolRegistry();
        const planCtx = createMockContext(tempDir, 'plan');

        // Test workspace_write_file in plan mode
        const writeRes = await registry.dispatch('workspace_write_file', { filePath: 'test.ts', content: 'const a = 2;' }, planCtx);
        assert.strictEqual(writeRes.resultPayload.status, 'failed');
        assert.ok(String(writeRes.resultPayload.error).includes('Planning Mode is active (read-only)'));

        // Test workspace_apply_diff in plan mode
        const diffRes = await registry.dispatch('workspace_apply_diff', {
            filePath: 'test.ts',
            targetContent: 'const a = 1;',
            replacementContent: 'const a = 2;'
        }, planCtx);
        assert.strictEqual(diffRes.resultPayload.status, 'failed');
        assert.ok(String(diffRes.resultPayload.error).includes('Planning Mode is active (read-only)'));
    } finally {
        await fs.remove(tempDir);
    }
});

test('Phase 2: Precision line-anchored patching and duplicate checks in workspace_apply_diff', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-diff-test-'));
    try {
        const sampleCode = [
            'function duplicate() {',
            '    return 1;',
            '}',
            '',
            'function duplicate() {',
            '    return 2;',
            '}'
        ].join('\n');

        const filePath = path.join(tempDir, 'sample.ts');
        await fs.writeFile(filePath, sampleCode);

        const registry = createDefaultToolRegistry();
        const ctx = createMockContext(tempDir, 'agent');

        // 1. Without line bounds, single occurrence should succeed
        const singleRes = await registry.dispatch('workspace_apply_diff', {
            filePath: 'sample.ts',
            targetContent: '    return 1;',
            replacementContent: '    return 10;'
        }, ctx);
        assert.strictEqual(singleRes.resultPayload.status, 'success');

        // Multiple occurrences of "function duplicate() {" without line bounds should error
        const multiRes = await registry.dispatch('workspace_apply_diff', {
            filePath: 'sample.ts',
            targetContent: 'function duplicate() {',
            replacementContent: 'function replaced() {'
        }, ctx);
        assert.strictEqual(multiRes.resultPayload.status, 'failed');
        assert.ok(String(multiRes.resultPayload.error).includes('Multiple occurrences (2)'));

        // 2. Line-anchored edit specifying startLine and endLine precisely targets the second occurrence
        const anchoredRes = await registry.dispatch('workspace_apply_diff', {
            filePath: 'sample.ts',
            startLine: 4,
            endLine: 7,
            targetContent: 'function duplicate() {',
            replacementContent: 'function secondDuplicate() {'
        }, ctx);
        assert.strictEqual(anchoredRes.resultPayload.status, 'success');

        const updatedFile = await fs.readFile(filePath, 'utf8');
        assert.ok(updatedFile.includes('function duplicate() {'), 'First occurrence should remain unchanged');
        assert.ok(updatedFile.includes('function secondDuplicate() {'), 'Second occurrence should be updated');
    } finally {
        await fs.remove(tempDir);
    }
});

test('Phase 2: Native search tools workspace_grep_search and workspace_find_by_name', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-search-test-'));
    try {
        const subDir = path.join(tempDir, 'src', 'components');
        await fs.ensureDir(subDir);
        await fs.writeFile(path.join(subDir, 'Button.tsx'), 'export const Button = () => <button>Click</button>;');
        await fs.writeFile(path.join(subDir, 'Modal.tsx'), 'export const Modal = () => <div>Modal content</div>;');

        const registry = createDefaultToolRegistry();
        const ctx = createMockContext(tempDir, 'agent');

        // Test workspace_find_by_name
        const findRes = await registry.dispatch('workspace_find_by_name', { pattern: '*.tsx' }, ctx);
        assert.strictEqual(findRes.resultPayload.status, 'success');
        const findMatches = findRes.resultPayload.matches as any[];
        assert.ok(findMatches.length >= 2, 'Should find at least 2 .tsx files');
        assert.ok(findMatches.some(m => m.path.includes('Button.tsx')));
        assert.ok(findMatches.some(m => m.path.includes('Modal.tsx')));

        // Test workspace_grep_search
        const grepRes = await registry.dispatch('workspace_grep_search', {
            query: 'Modal content',
            isRegex: false
        }, ctx);
        assert.strictEqual(grepRes.resultPayload.status, 'success');
        const grepMatches = grepRes.resultPayload.matches as any[];
        assert.strictEqual(grepMatches.length, 1);
        assert.strictEqual(grepMatches[0].line, 1);
        assert.ok(grepMatches[0].content.includes('<div>Modal content</div>'));
    } finally {
        await fs.remove(tempDir);
    }
});

test('Phase 3 & 4: Subagent delegation and AgentVerificationService self-healing checks', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-verify-test-'));
    try {
        const filePath = path.join(tempDir, 'calculator.ts');
        await fs.writeFile(filePath, 'export const add = (a: number, b: number) => a + b;');

        const registry = createDefaultToolRegistry();
        const ctx = createMockContext(tempDir, 'agent');

        // 1. Test invoke_subagent delegation
        const subagentRes = await registry.dispatch('invoke_subagent', {
            role: 'Code Reviewer',
            typeName: 'reviewer',
            prompt: 'Audit calculator.ts for bugs'
        }, ctx);
        assert.strictEqual(subagentRes.resultPayload.status, 'success');
        assert.ok(String(subagentRes.resultPayload.result).includes('Audit calculator.ts for bugs'));

        // 2. Verification typechecks the owning project; with no tsconfig it must not claim a typecheck ran
        const verifier = new AgentVerificationService(ctx.lsp, ctx.sandbox);
        const outcome = await verifier.verify({ workspaceRoot: tempDir, modifiedFiles: [filePath], runTests: false });
        assert.strictEqual(outcome.passed, true);
        assert.ok(outcome.summary?.includes('nothing was typechecked'));

        // 3. Diagnostics ingested from a compiler run feed the self-healing prompt
        const normalized = path.resolve(filePath).replace(/\\/g, '/');
        ctx.lsp.ingestDiagnostics(normalized, [
            {
                filePath: normalized,
                severity: 'error',
                message: "Type 'string' is not assignable to type 'number'.",
                range: { startLine: 1, startColumn: 10, endLine: 1, endColumn: 20 },
                code: 'TS2322'
            }
        ]);

        // 4. Test self-healing prompt synthesis
        const fixPrompt = ctx.lsp.synthesizeDiagnosticFixPrompt([normalized]);
        assert.strictEqual(fixPrompt.errorCount, 1);
        assert.ok(fixPrompt.promptContext.includes('TS2322'));
        assert.ok(fixPrompt.suggestedActions.some(a => a.includes('Fix type incompatibility')));
    } finally {
        await fs.remove(tempDir);
    }
});

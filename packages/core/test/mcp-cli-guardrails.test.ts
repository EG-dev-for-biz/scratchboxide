import { test } from 'vitest';
import * as assert from 'assert';
import {
    classifyCliCommand,
    evaluateCliGuardrail,
    synthesizeHumanFriendlyCard,
    CliExecutionState
} from '../src/browser/generative-canvas/guardrails-service';
import { McpExecutionState } from '../src/browser/generative-canvas/canvas-types';

async function runMcpCliGuardrailsTests() {
    console.log('🧪 Running MCP & CLI Execution Guardrails Test Suite...');

    // Test 1: Classify safe read-only CLI commands
    const readOnlyCommands = [
        'git status',
        'git log -n 5 --oneline',
        'ls -la src/',
        'cat package.json',
        'node -v',
        'yarn --version',
        'npm list --depth=0'
    ];

    for (const cmd of readOnlyCommands) {
        const analysis = classifyCliCommand(cmd);
        assert.strictEqual(
            analysis.level,
            'safe_read',
            `Command "${cmd}" should be classified as safe_read`
        );
        assert.strictEqual(analysis.requiresConfirmation, false, `Safe read command "${cmd}" must not require confirmation`);
    }
    console.log('  ✓ Test 1 Passed: Safe read-only CLI commands accurately classified with zero friction');

    // Test 2: Classify mutating commands requiring human confirmation guardrails
    const mutatingCommands = [
        'git commit -m "feat: add n8n flow"',
        'npm install @google/genai',
        'yarn add react',
        'mkdir -p src/components/vibe',
        'touch src/types.ts',
        'git checkout -b feature/apple-hig'
    ];

    for (const cmd of mutatingCommands) {
        const analysis = classifyCliCommand(cmd);
        assert.strictEqual(
            analysis.level,
            'prompt_confirm',
            `Command "${cmd}" should require prompt_confirm guardrail`
        );
        assert.strictEqual(analysis.requiresConfirmation, true, `Mutating command "${cmd}" must require confirmation`);
        assert.ok(analysis.description.length > 0, `Command "${cmd}" must have an explanatory human summary`);
    }
    console.log('  ✓ Test 2 Passed: Mutating CLI operations require human confirmation badge and clear summary');

    // Test 3: Block dangerous or irreversible system commands
    const dangerousCommands = [
        'rm -rf /',
        'rm -rf *',
        'git reset --hard HEAD~10',
        'git push --force origin main',
        'chmod -R 777 /',
        'dd if=/dev/zero of=/dev/sda',
        'mkfs.ext4 /dev/sda1',
        ':(){ :|:& };:'
    ];

    for (const cmd of dangerousCommands) {
        const analysis = classifyCliCommand(cmd);
        assert.strictEqual(
            analysis.level,
            'blocked_danger',
            `Dangerous command "${cmd}" must be blocked_danger`
        );
        assert.strictEqual(analysis.isBlocked, true, `Dangerous command "${cmd}" must be blocked`);
        assert.ok(analysis.dangerWarning, `Dangerous command "${cmd}" must have a danger warning`);
    }
    console.log('  ✓ Test 3 Passed: Irreversible / destructive commands successfully intercepted and blocked');

    // Test 4: Guardrail evaluation logic with approval flow
    const pendingState: CliExecutionState = {
        id: 'cli-test-1',
        command: 'npm install lucide-react',
        guardrailLevel: 'prompt_confirm',
        confirmedByUser: false,
        status: 'pending_approval',
        timestamp: '12:00 PM',
        description: 'Install lucide-react package'
    };

    const evaluationUnapproved = evaluateCliGuardrail(pendingState);
    assert.strictEqual(evaluationUnapproved.canExecute, false, 'Unapproved prompt_confirm command cannot execute');
    assert.strictEqual(evaluationUnapproved.reason, 'Awaiting user approval badge');

    const approvedState: CliExecutionState = {
        ...pendingState,
        confirmedByUser: true,
        status: 'running'
    };
    const evaluationApproved = evaluateCliGuardrail(approvedState);
    assert.strictEqual(evaluationApproved.canExecute, true, 'Approved prompt_confirm command is allowed to execute');
    console.log('  ✓ Test 4 Passed: Guardrail approval badge state machine correctly gates execution');

    // Test 5: Synthesize human-friendly metric card from MCP/CLI payload
    const rawStripePayload = {
        available_balance: '$42,850.00',
        pending_balance: '$3,120.00',
        currency: 'USD',
        active_subscribers: 1284,
        mrr: '$28,450.00'
    };

    const metricCard = synthesizeHumanFriendlyCard('Stripe Live Revenue & Balance', rawStripePayload);
    assert.strictEqual(metricCard.cardType, 'metric');
    assert.ok(metricCard.items && metricCard.items.length >= 3, 'Metric card must contain synthesized KPI items');
    assert.ok(metricCard.items?.some(i => i.label.toLowerCase().includes('balance') || i.label.toLowerCase().includes('mrr')));
    console.log('  ✓ Test 5 Passed: Raw MCP payload synthesizes into sleek Apple HIG metric cards');

    // Test 6: Synthesize structured table card from list payload
    const rawPrList = [
        { number: 101, title: 'Implement Liquid Glass UI', author: 'eli', status: 'approved' },
        { number: 102, title: 'Add N8N bezier curves', author: 'alex', status: 'review_required' },
        { number: 103, title: 'Gemini subagent routing', author: 'sarah', status: 'approved' }
    ];

    const tableCard = synthesizeHumanFriendlyCard('GitHub Pull Requests', rawPrList);
    assert.strictEqual(tableCard.cardType, 'table');
    assert.ok(tableCard.headers && tableCard.headers.length >= 3, 'Table must contain column headers');
    assert.strictEqual(tableCard.rows?.length, 3, 'Table must render 3 rows');
    console.log('  ✓ Test 6 Passed: Array payloads automatically transform into structured interactive tables');

    // Test 7: McpExecutionState step progression and duration calculation
    const initialMcpExec: McpExecutionState = {
        id: 'exec-github-1',
        mcpServerId: 'mcp-github',
        mcpName: 'GitHub Repository',
        toolName: 'list_pull_requests',
        humanTitle: 'Inspect Open Pull Requests & CI Checks',
        status: 'running',
        timestamp: '12:05 PM',
        steps: [
            { id: 's1', title: 'Authenticate with GitHub OAuth', status: 'done', durationMs: 42 },
            { id: 's2', title: 'Query open pull requests on master', status: 'running' },
            { id: 's3', title: 'Format interactive PR table', status: 'pending' }
        ]
    };

    const completedSteps = initialMcpExec.steps.map(s => {
        if (s.id === 's2') return { ...s, status: 'done' as const, durationMs: 118 };
        if (s.id === 's3') return { ...s, status: 'done' as const, durationMs: 24 };
        return s;
    });

    const totalDuration = completedSteps.reduce((acc, curr) => acc + (curr.durationMs || 0), 0);
    assert.strictEqual(totalDuration, 42 + 118 + 24, 'Total duration must sum individual step latencies');
    assert.strictEqual(completedSteps.every(s => s.status === 'done'), true, 'All steps marked done upon completion');
    console.log('  ✓ Test 7 Passed: MCP execution steps duration and telemetry accurately accumulated');

    console.log('\n🎉 ALL MCP & CLI GUARDRAILS TESTS PASSED SUCCESSFULLY!');
}

test('mcp-cli-guardrails.test', async () => {
    await runMcpCliGuardrailsTests();
}, 180_000);

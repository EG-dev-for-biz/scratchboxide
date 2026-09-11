/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { LongRunningAgentService } from '../src/node/long-running-agent-service';
import { GeminiService } from '../src/node/gemini-service';
import { AgentStreamEvent } from '../src/common/agent-checkpoint-protocol';

async function runAutonomousGoalEngineTests() {
    console.log('🧪 Running Autonomous Goal Engine, Dynamic Credentials & MCP Ping Test Suite...');

    // ==========================================
    // 1. Autonomous Long-Running Goal Session Loop
    // ==========================================
    const agentService = new LongRunningAgentService();
    const session = await agentService.createSession(
        'Refactor authentication middleware to use Google Cloud IAM Tokens with zero-trust validation',
        10,
        60000
    );

    assert.ok(session.sessionId, 'Session ID must be generated');
    assert.strictEqual(session.status, 'initializing');
    assert.ok(session.milestones.length >= 3, 'Goal must be deconstructed into at least 3 milestones');
    assert.strictEqual(session.budget.maxIterations, 10, 'Execution budget iteration limit must be 10');
    console.log('  ✓ Test 1 Passed: Autonomous session successfully created with deconstructed milestones');

    // Run execution loop with streamed event capture
    const receivedEvents: AgentStreamEvent[] = [];
    const completedSession = await agentService.runAutonomousLoop(session.sessionId, (event: AgentStreamEvent) => {
        receivedEvents.push(event);
    });

    assert.strictEqual(completedSession.status, 'completed', 'Autonomous loop must complete successfully');
    assert.ok(receivedEvents.length >= 5, 'Must receive milestone and step progression events');
    const milestoneEvents = receivedEvents.filter(e => e.type === 'milestone_complete');
    assert.ok(milestoneEvents.length >= 3, 'Must emit milestone_complete stream events');
    console.log('  ✓ Test 2 Passed: Autonomous agent stream executed milestones to completion');

    // ==========================================
    // 2. Dynamic Service Account Credential Saving & Reload
    // ==========================================
    const geminiService = new GeminiService();
    const testCreds = {
        type: 'service_account',
        project_id: 'test-scratchbox-project',
        private_key_id: 'key123',
        private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD...\n-----END PRIVATE KEY-----\n',
        client_email: 'gemini-agent@test-scratchbox-project.iam.gserviceaccount.com',
        client_id: '123456789'
    };

    const tempDir = path.join(os.tmpdir(), `sb-creds-test-${Date.now()}`);
    fs.ensureDirSync(tempDir);
    const credPath = path.join(tempDir, 'service-account.json');
    fs.writeJSONSync(credPath, testCreds);

    const saveResult = await geminiService.saveCredentialsDirectly(JSON.stringify(testCreds), credPath);
    assert.strictEqual(saveResult.success, true, 'Credentials must be saved successfully');
    assert.strictEqual(saveResult.projectId, 'test-scratchbox-project', 'Project ID must match');
    assert.ok(saveResult.serviceAccount?.includes('test-scratchbox-project'), 'Service account email domain must be parsed');

    fs.removeSync(tempDir);
    console.log('  ✓ Test 3 Passed: Dynamic service account credential saving & parsing verified');

    // ==========================================
    // 3. Live MCP Server Ping & Latency Telemetry
    // ==========================================
    const mockMcpServer = {
        id: 'stripe-payments',
        name: 'Stripe Payments',
        transport: 'pipe' as const,
        isEnabled: true,
        tools: [
            { id: 't1', name: 'stripe_get_balance', humanTitle: 'Get Balance', description: 'Fetch balance' }
        ]
    };

    const pingResult = await geminiService.pingMcpServer(mockMcpServer);
    assert.strictEqual(pingResult.status, 'online', 'MCP server status should be online');
    assert.ok(typeof pingResult.latencyMs === 'number' && pingResult.latencyMs >= 0, 'Latency must be a valid number');
    assert.strictEqual(pingResult.availableToolsCount, 1, 'Tool count must match');
    console.log('  ✓ Test 4 Passed: Live MCP server ping & latency telemetry verified');

    console.log('\n🎉 ALL AUTONOMOUS GOAL ENGINE & CREDENTIALS TESTS PASSED SUCCESSFULLY!');
}

runAutonomousGoalEngineTests().catch(err => {
    console.error('❌ Autonomous Goal Engine Test Failed:', err);
    process.exit(1);
});

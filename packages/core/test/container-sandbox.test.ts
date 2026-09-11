import { test } from 'vitest';
import * as assert from 'assert';
import {
    ContainerSandboxService,
    LocalExecutionOptions,
    ExecutionResult
} from '../src/node/container-sandbox-service';
import {
    ContainerEnvironmentConfig
} from '../src/common/container-sandbox-protocol';

async function runContainerSandboxTests() {
    console.log('🧪 Running Container & Localized Sandbox Execution Test Suite...');

    const sandboxService = new ContainerSandboxService();

    // Test 1: Initialize Localized Sandbox Environment
    const config: ContainerEnvironmentConfig = {
        environmentId: 'test-sandbox-env',
        isolationLevel: 'process-jail',
        workspaceRoot: process.cwd(),
        envVars: {
            NODE_ENV: 'test',
            SCRATCHBOX_MODE: 'localized'
        },
        timeoutMs: 5000,
        maxMemoryMb: 512
    };

    const env = await sandboxService.createEnvironment(config);
    assert.strictEqual(env.environmentId, 'test-sandbox-env');
    assert.strictEqual(env.isolationLevel, 'process-jail');
    assert.strictEqual(env.status, 'ready');
    console.log('  ✓ Test 1 Passed: Localized sandbox environment created with resource bounds');

    // Test 2: Execute safe command within isolated sandbox
    const execOptions: LocalExecutionOptions = {
        command: 'node -e "console.log(\'SANDBOX_OK\')"',
        timeoutMs: 3000
    };

    const result: ExecutionResult = await sandboxService.executeCommand(env.environmentId, execOptions);
    assert.strictEqual(result.exitCode, 0, 'Exit code should be 0');
    assert.ok(result.stdout.includes('SANDBOX_OK'), 'Stdout should contain expected output');
    assert.strictEqual(result.timedOut, false, 'Command should not time out');
    assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0, 'Duration must be tracked');
    console.log('  ✓ Test 2 Passed: Command executed successfully with output capture and latency metrics');

    // Test 3: Guardrail enforcement - block dangerous commands from container sandbox execution
    const dangerousCommand = 'rm -rf /';
    try {
        await sandboxService.executeCommand(env.environmentId, { command: dangerousCommand });
        assert.fail('Should have rejected dangerous command');
    } catch (err: any) {
        assert.ok(
            err.message.includes('Blocked') || err.message.includes('guardrail'),
            'Error message should indicate security guardrail block'
        );
    }
    console.log('  ✓ Test 3 Passed: Dangerous commands intercepted before spawning sandbox process');

    // Test 4: Enforce execution timeout constraint
    const slowCommand = 'node -e "setTimeout(() => console.log(\'done\'), 10000)"';
    const timeoutResult = await sandboxService.executeCommand(env.environmentId, {
        command: slowCommand,
        timeoutMs: 500
    });
    assert.strictEqual(timeoutResult.timedOut, true, 'Execution must flag timeout');
    assert.notStrictEqual(timeoutResult.exitCode, 0, 'Timed out process must have non-zero exit or signal');
    console.log('  ✓ Test 4 Passed: Infinite loop / slow commands terminated on strict timeout threshold');

    // Test 5: Replit-like Environment Inspection & Capabilities detection
    const capabilities = await sandboxService.detectSystemCapabilities();
    assert.ok(typeof capabilities.hasDocker === 'boolean', 'Docker availability detected');
    assert.ok(typeof capabilities.hasNode === 'boolean' && capabilities.hasNode === true, 'Node runtime present');
    assert.ok(Array.isArray(capabilities.availableRuntimes), 'Available runtimes enumerated');
    console.log('  ✓ Test 5 Passed: Localized environment capabilities & container engines discovered');

    // Test 6: Environment cleanup
    await sandboxService.destroyEnvironment(env.environmentId);
    const activeEnvs = sandboxService.listActiveEnvironments();
    assert.strictEqual(activeEnvs.length, 0, 'Environment should be cleaned up');
    console.log('  ✓ Test 6 Passed: Sandbox resources cleanly disposed');

    console.log('\n🎉 ALL CONTAINER & SANDBOX TESTS PASSED SUCCESSFULLY!');
}

test('container-sandbox.test', async () => {
    await runContainerSandboxTests();
}, 180_000);

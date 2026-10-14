import { test } from 'vitest';
import * as assert from 'assert';
import {
    DEFAULT_GEMINI_MODEL,
    FALLBACK_GEMINI_MODELS,
    DEFAULT_SUBAGENT_MODEL,
    FALLBACK_SUBAGENT_MODELS,
    GeminiService
} from '../src/node/gemini-service';
import { SubagentRequest } from '../src/common/gemini-protocol';

async function runTests() {
    console.log('🧪 Running Gemini 3.8 & Subagent (Gemini 3.5 Flash Lite / 3.1 Flash Lite) Test Suite...');

    // Test 1: Verify primary model constants
    assert.strictEqual(DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash', 'Primary model must be gemini-3.8-flash');
    assert.ok(Array.isArray(FALLBACK_GEMINI_MODELS), 'Fallback models must be an array');
    console.log('  ✓ Test 1 Passed: Primary model is gemini-3.8-flash');

    // Test 2: Verify subagent model constants
    assert.strictEqual(DEFAULT_SUBAGENT_MODEL, 'gemini-3.5-flash-lite', 'Primary subagent must be gemini-3.5-flash-lite');
    assert.ok(FALLBACK_SUBAGENT_MODELS.some(m => m.includes('3.1-flash-lite')), 'Fallback subagents must include gemini-3.1-flash-lite');
    console.log('  ✓ Test 2 Passed: Subagent models configured (gemini-3.5-flash-lite & gemini-3.1-flash-lite)');

    // Test 3: Verify GeminiService instance methods and status
    const service = new GeminiService();
    const status = await service.getStatus();

    assert.ok(status, 'Status must not be null');
    assert.strictEqual(status.activeModel, 'gemini-3.8-flash');
    assert.strictEqual(status.subagentModel, 'gemini-3.5-flash-lite');
    assert.ok(status.availableSubagentModels && status.availableSubagentModels.includes('gemini-3.5-flash-lite'));
    console.log('  ✓ Test 3 Passed: Service status correctly reports primary and subagent models');

    // Test 4: Verify Subagent Instruction Builder
    const subagentReq: SubagentRequest = {
        taskType: 'preprocess',
        prompt: 'Generate an executive summary of user retention metrics',
        context: 'User churn is 2.1% this quarter'
    };

    // Test buildSubagentInstruction
    const instruction = (service as any).buildSubagentInstruction(subagentReq);
    assert.ok(typeof instruction === 'string', 'Instruction must be a string');
    assert.ok(instruction.includes('Scratchbox AI Subagent'), 'Instruction must establish subagent persona');
    assert.ok(instruction.includes('preprocess'), 'Instruction must reflect the task type');
    console.log('  ✓ Test 4 Passed: Subagent system instruction successfully constructed');

    // Test 5: Verify Subagent candidate models list resolution
    const candidates = (service as any).getSubagentModelCandidates(undefined);
    assert.strictEqual(candidates[0], 'gemini-3.5-flash-lite', 'Top subagent candidate must be gemini-3.5-flash-lite');
    assert.ok(candidates.some((m: string) => m.includes('3.1-flash-lite')), 'Candidates must include 3.1-flash-lite');
    console.log('  ✓ Test 5 Passed: Subagent candidate resolution prioritizes 3.5-flash-lite with 3.1-flash-lite fallback');

    // Test 6: Verify Gemini Built-in Tools (Google Search and Code Execution) in buildToolDeclarations
    console.log('  Testing Test 6: Gemini Built-in Tools config...');
    
    // Since de5b493 ("domain tool packs, capability routing") the TaskCapabilityResolver runs before tool
    // selection and the core_workspace pack (workspace + canvas function declarations) is attached whenever
    // workspace tools are allowed and the task is natively solvable, which includes plain prompts. Built-in
    // tool behaviour is therefore isolated below with enableWorkspaceTools: false.
    const toolsWithWorkspace = (service as any).buildToolDeclarations({ prompt: 'test' });
    assert.ok(Array.isArray(toolsWithWorkspace), 'Should return an array');
    assert.strictEqual(toolsWithWorkspace.length, 2);
    assert.deepStrictEqual(toolsWithWorkspace[0], { googleSearch: {} }, 'Google Search stays first and enabled by default');
    const workspaceDecls = toolsWithWorkspace[1].functionDeclarations.map((d: any) => d.name);
    assert.ok(workspaceDecls.includes('workspace_read_file') && workspaceDecls.includes('mount_canvas_primitive'), 'Default request carries the core workspace + canvas declarations');

    // Case 6a: Default prompt with no options -> includes googleSearch by default
    const toolsDefault = (service as any).buildToolDeclarations({ prompt: 'test', enableWorkspaceTools: false });
    assert.ok(Array.isArray(toolsDefault), 'Should return an array with Google Search enabled by default');
    assert.strictEqual(toolsDefault.length, 1);
    assert.deepStrictEqual(toolsDefault[0], { googleSearch: {} });

    // Case 6b: Explicitly disabled Google Search, no other tools -> undefined
    const toolsDisabled = (service as any).buildToolDeclarations({ prompt: 'test', enableWorkspaceTools: false, enableGoogleSearch: false });
    assert.strictEqual(toolsDisabled, undefined, 'Should return undefined when Google Search is explicitly false and no other tools are set');

    // Case 6c: Google Search explicitly false, Code Execution enabled -> Code Execution only
    const toolsCodeOnly = (service as any).buildToolDeclarations({ prompt: 'test', enableWorkspaceTools: false, enableGoogleSearch: false, enableCodeExecution: true });
    assert.ok(Array.isArray(toolsCodeOnly), 'Should return an array');
    assert.strictEqual(toolsCodeOnly.length, 1);
    assert.deepStrictEqual(toolsCodeOnly[0], { codeExecution: {} });

    // Case 6d: Both built-in tools enabled
    const toolsBoth = (service as any).buildToolDeclarations({
        prompt: 'test',
        enableWorkspaceTools: false,
        enableGoogleSearch: true,
        enableCodeExecution: true
    });
    assert.ok(Array.isArray(toolsBoth), 'Should return an array');
    assert.strictEqual(toolsBoth.length, 2);
    assert.deepStrictEqual(toolsBoth[0], { googleSearch: {} });
    assert.deepStrictEqual(toolsBoth[1], { codeExecution: {} });

    // Case 6e: Built-in tools and MCP tools combined
    const dummyMcpTool = {
        id: 't1',
        serverName: 'mcp-test',
        name: 'test$tool$name',
        humanTitle: 'Test Tool Title',
        description: 'Test description'
    };
    const toolsAll = (service as any).buildToolDeclarations({
        prompt: 'test',
        enableWorkspaceTools: false,
        enableGoogleSearch: true,
        enableCodeExecution: true,
        attachedMcpTools: [dummyMcpTool]
    });
    assert.ok(Array.isArray(toolsAll), 'Should return an array');
    assert.strictEqual(toolsAll.length, 3);
    assert.deepStrictEqual(toolsAll[0], { googleSearch: {} });
    assert.deepStrictEqual(toolsAll[1], { codeExecution: {} });
    assert.ok(toolsAll[2].functionDeclarations, 'Third item should contain functionDeclarations');
    assert.strictEqual(toolsAll[2].functionDeclarations[0].name, 'test_tool_name'); // replacing invalid char '-' with '_'
    
    console.log('  ✓ Test 6 Passed: Gemini built-in tools and MCP tools correctly configured/appended');

    console.log('\n🎉 ALL SUBAGENT & MODEL TESTS PASSED SUCCESSFULLY!');
}

test('subagent-service.test', async () => {
    await runTests();
}, 180_000);

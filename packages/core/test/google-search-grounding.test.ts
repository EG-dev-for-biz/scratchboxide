import { test } from 'vitest';
import * as assert from 'assert';
import { GeminiService } from '../src/node/gemini-service';
import { GeminiGenerateRequest, GeminiStreamEvent } from '../src/common/gemini-protocol';

async function runGoogleSearchGroundingTests() {
    console.log('🧪 Running Gemini Google Search Grounding & Citations Test Suite...');

    const service = new GeminiService();

    // Mock GoogleAuth to avoid real credentials loading requirement in offline test mode
    (service as any).auth = {
        getClient: async () => ({
            getAccessToken: async () => ({ token: 'mock-token-grounding' })
        })
    };
    (service as any).cachedProjectId = 'mock-grounding-project-id';

    // Test 1: Verify tools array contains { googleSearch: {} } by default
    let capturedUrl = '';
    let capturedOptions: any = {};

    const mockSseWithGrounding = [
        'data: {"id": "gen-1", "candidates": [{"content": {"parts": [{"text": "Scratchbox IDE is powered by Gemini 3.8 Flash."}]}, "groundingMetadata": {"webSearchQueries": ["Scratchbox IDE release 2026", "Gemini 3.8 Flash features"], "groundingChunks": [{"web": {"uri": "https://scratchbox.ai/docs", "title": "Scratchbox IDE Documentation"}}, {"web": {"uri": "https://ai.google.dev/gemini", "title": "Google Gemini API"}}], "searchEntryPoint": {"renderedContent": "<div>Google Search Widget</div>"}}}]}',
        'data: [DONE]'
    ].join('\n');

    (globalThis as any).fetch = async (url: string, options: any) => {
        capturedUrl = url;
        capturedOptions = options;
        return {
            ok: true,
            text: async () => mockSseWithGrounding,
            body: null
        };
    };

    const streamEvents: GeminiStreamEvent[] = [];
    const handleEvent = (event: GeminiStreamEvent) => {
        streamEvents.push(event);
    };

    // Prompt without specifying enableGoogleSearch -> should default to TRUE
    const requestDefault: GeminiGenerateRequest = {
        prompt: 'What are the latest features of Scratchbox IDE and Gemini 3.8?'
    };

    const responseDefault = await service.streamGenerate(requestDefault, handleEvent);

    assert.ok(capturedOptions.body, 'Request body must be sent');
    const parsedBodyDefault = JSON.parse(capturedOptions.body);
    assert.ok(Array.isArray(parsedBodyDefault.tools), 'Payload tools must be an array by default');
    
    const hasGoogleSearchTool = parsedBodyDefault.tools.some((t: any) => t.googleSearch !== undefined);
    assert.strictEqual(hasGoogleSearchTool, true, 'Tools array must include { googleSearch: {} } by default');
    assert.ok(capturedUrl.includes('streamGenerateContent'), 'Captured URL must target streamGenerateContent endpoint');
    console.log('  ✓ Test 1 Passed: Google Search tool is automatically enabled by default on Gemini calls');

    // Test 2: Verify search grounding metadata is captured and emitted in stream and response
    assert.ok(responseDefault.groundingMetadata, 'Response must contain captured groundingMetadata');
    assert.deepStrictEqual(
        responseDefault.groundingMetadata?.webSearchQueries,
        ['Scratchbox IDE release 2026', 'Gemini 3.8 Flash features'],
        'Web search queries must be parsed accurately'
    );
    assert.strictEqual(
        responseDefault.groundingMetadata?.groundingChunks?.length,
        2,
        'Grounding chunks must contain 2 web citation sources'
    );
    assert.strictEqual(
        responseDefault.groundingMetadata?.groundingChunks?.[0]?.web?.uri,
        'https://scratchbox.ai/docs',
        'Grounding chunk URI must match'
    );
    assert.strictEqual(
        responseDefault.groundingMetadata?.searchEntryPoint?.renderedContent,
        '<div>Google Search Widget</div>',
        'Search entry point rendered content must match'
    );

    // Verify stream events emitted grounding & status
    const groundingEvents = streamEvents.filter(e => e.type === 'grounding');
    assert.ok(groundingEvents.length >= 1, 'Stream must emit at least 1 grounding event');
    assert.deepStrictEqual(groundingEvents[0].groundingMetadata?.webSearchQueries, ['Scratchbox IDE release 2026', 'Gemini 3.8 Flash features']);

    const searchStatusEvents = streamEvents.filter(e => e.type === 'status' && e.text?.includes('Google Search Grounding active'));
    assert.ok(searchStatusEvents.length >= 1, 'Stream must emit status notification for active Google search queries');

    console.log('  ✓ Test 2 Passed: Grounding metadata (webSearchQueries, chunks, entry points) captured and streamed');

    // Test 3: Verify document artifact synthesis enriches citation section with grounded web chunks
    assert.ok(responseDefault.artifact, 'Artifact must be generated');
    if (responseDefault.artifact && responseDefault.artifact.type === 'markdown-document') {
        const docData = responseDefault.artifact.data as any;
        const citationSec = docData.sections?.find((s: any) => s.type === 'citation');
        assert.ok(citationSec, 'Document artifact must contain a citation section');
        assert.ok(citationSec.citationItems?.length >= 2, 'Citation section must include grounded web items');
        const groundedItem = citationSec.citationItems?.find((c: any) => c.url === 'https://scratchbox.ai/docs');
        assert.ok(groundedItem, 'Citation items must contain https://scratchbox.ai/docs');
        assert.strictEqual(groundedItem.verified, true, 'Grounded citations must be flagged as verified');
    }
    console.log('  ✓ Test 3 Passed: Document artifacts automatically incorporate grounded web citation sources');

    // Test 4: Verify enableGoogleSearch: false explicitly disables the tool
    const requestDisabled: GeminiGenerateRequest = {
        prompt: 'Offline prompt',
        enableGoogleSearch: false
    };

    streamEvents.length = 0;
    await service.streamGenerate(requestDisabled, handleEvent);

    const parsedBodyDisabled = JSON.parse(capturedOptions.body);
    const hasGoogleSearchWhenDisabled = (parsedBodyDisabled.tools || []).some((t: any) => t.googleSearch !== undefined);
    assert.strictEqual(hasGoogleSearchWhenDisabled, false, 'Tools array must NOT include googleSearch when enableGoogleSearch is false');
    console.log('  ✓ Test 4 Passed: Setting enableGoogleSearch: false explicitly disables Google Search tool');

    // Test 5: Subagent background task includes googleSearch tool by default
    let capturedSubagentBody: any = null;
    (globalThis as any).fetch = async (url: string, options: any) => {
        capturedSubagentBody = JSON.parse(options.body);
        return {
            ok: true,
            json: async () => ({
                candidates: [
                    {
                        content: { parts: [{ text: 'Subagent research result' }] },
                        groundingMetadata: {
                            webSearchQueries: ['Subagent research query']
                        }
                    }
                ]
            })
        };
    };

    const subagentRes = await service.executeSubagentTask({
        taskType: 'research',
        prompt: 'Research latest web benchmarks'
    });

    assert.ok(capturedSubagentBody.tools, 'Subagent payload must include tools');
    assert.ok(
        capturedSubagentBody.tools.some((t: any) => t.googleSearch !== undefined),
        'Subagent must include googleSearch tool by default'
    );
    assert.strictEqual(subagentRes.success, true);
    assert.deepStrictEqual(subagentRes.groundingMetadata?.webSearchQueries, ['Subagent research query']);
    console.log('  ✓ Test 5 Passed: Subagent execution enables Google Search grounding by default and captures metadata');

    console.log('\n🎉 ALL GOOGLE SEARCH GROUNDING TESTS PASSED SUCCESSFULLY!');
}

test('google-search-grounding.test', async () => {
    await runGoogleSearchGroundingTests();
}, 180_000);

test('agent-mode requests keep googleSearch next to function tools on Gemini 3+, but not on Gemini 2.5', async () => {
    const service = new GeminiService();
    (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
    (service as any).cachedProjectId = 'mock-project';

    const firstBodyFor = async (model: string): Promise<any> => {
        let firstBody: any;
        (globalThis as any).fetch = async (_url: string, options: any) => {
            firstBody ??= JSON.parse(options.body);
            return { ok: true, text: async () => 'data: {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}\ndata: [DONE]', body: null };
        };
        // Mirrors the request useSendMessage.ts sends from the chat composer.
        await service.streamGenerate({ prompt: 'Who won the most recent World Cup?', model, mode: 'agent', enableWorkspaceTools: true, enableGoogleSearch: true }, () => undefined);
        return firstBody;
    };

    const hasSearch = (body: any) => (body.tools || []).some((t: any) => t.googleSearch !== undefined);
    const hasFunctions = (body: any) => (body.tools || []).some((t: any) => t.functionDeclarations?.length > 0);

    const gemini3 = await firstBodyFor('gemini-3.7-flash');
    assert.ok(hasFunctions(gemini3), 'agent mode must send function declarations');
    assert.ok(hasSearch(gemini3), 'Gemini 3 must keep googleSearch alongside function declarations');

    const gemini25 = await firstBodyFor('gemini-2.5-flash');
    assert.ok(hasFunctions(gemini25), 'agent mode must send function declarations');
    assert.ok(!hasSearch(gemini25), 'Gemini 2.5 rejects googleSearch mixed with function declarations');
}, 180_000);

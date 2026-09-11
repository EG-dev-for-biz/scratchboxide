import * as assert from 'assert';
import { GeminiService } from '../src/node/gemini-service';
import { GeminiGenerateRequest, GeminiStreamEvent } from '../src/common/gemini-protocol';

async function runTests() {
    console.log('🧪 Running Gemini GenAI Managed & Custom Agents Test Suite...');

    // Test 1: Verify protocol field compatibility
    const request: GeminiGenerateRequest = {
        prompt: 'test',
        agent: 'antigravity-preview-05-2026',
        environment: 'remote',
        previousInteractionId: 'inter-123'
    };

    assert.strictEqual(request.agent, 'antigravity-preview-05-2026', 'Agent property must be assignable');
    assert.strictEqual(request.environment, 'remote', 'Environment property must be assignable');
    assert.strictEqual(request.previousInteractionId, 'inter-123', 'Previous interaction ID must be assignable');
    console.log('  ✓ Test 1 Passed: Protocol definitions are correct and assignable');

    // Test 2: Verify executeVertexAgentInteraction with mock HTTP SSE response
    const service = new GeminiService();

    // Mock GoogleAuth to avoid real credentials loading requirement in offline test mode
    (service as any).auth = {
        getClient: async () => ({
            getAccessToken: async () => ({ token: 'mock-token' })
        })
    };
    (service as any).cachedProjectId = 'mock-project-id';

    const sseData = [
        'data: {"id": "inter-123", "environment_id": "env-456", "steps": [{"type": "thought", "summary": {"text": "Thinking deeply..."}}]}',
        'data: {"id": "inter-123", "environment_id": "env-456", "steps": [{"type": "google_search_call", "arguments": {"queries": ["test search query"]}}]}',
        'data: {"id": "inter-123", "environment_id": "env-456", "steps": [{"type": "code_execution_call", "arguments": {"code": "print(123)", "language": "python"}}]}',
        'data: {"id": "inter-123", "environment_id": "env-456", "steps": [{"type": "model_output", "content": [{"type": "text", "text": "Completed task successfully!"}]}]}'
    ].join('\n');

    let capturedUrl = '';
    let capturedOptions: any = {};

    // Mock global fetch
    const mockFetch = async (url: string, options: any) => {
        capturedUrl = url;
        capturedOptions = options;
        return {
            ok: true,
            text: async () => sseData,
            body: null // force fallback path in tests for simple line-by-line verification
        };
    };
    (globalThis as any).fetch = mockFetch;

    const streamEvents: GeminiStreamEvent[] = [];
    const handleEvent = (event: GeminiStreamEvent) => {
        streamEvents.push(event);
    };

    const result = await service.streamGenerate(request, handleEvent);

    // Assert URL composition
    assert.strictEqual(
        capturedUrl,
        'https://us-central1-aiplatform.googleapis.com/v1/projects/mock-project-id/locations/us-central1/publishers/google/agents/antigravity-preview-05-2026:interact?alt=sse',
        'Request must target the correct regional endpoint URL'
    );

    // Assert request options and headers
    assert.strictEqual(capturedOptions.method, 'POST', 'HTTP method must be POST');
    assert.strictEqual(capturedOptions.headers['Authorization'], 'Bearer mock-token', 'Authorization header must pass access token');
    assert.strictEqual(capturedOptions.headers['Api-Revision'], '2026-05-20', 'Api-Revision must match guidelines');

    const body = JSON.parse(capturedOptions.body);
    assert.strictEqual(body.input, 'test', 'Payload input must contain the prompt');
    assert.strictEqual(body.environment, 'remote', 'Payload environment must match request');
    assert.strictEqual(body.previous_interaction_id, 'inter-123', 'Payload previous_interaction_id must match request');

    // Assert result structure
    assert.ok(result.success, 'Response success must be true');
    assert.strictEqual(result.text, 'Completed task successfully!', 'Extracted text must match model output');
    assert.deepStrictEqual(result.thoughts, ['Thinking deeply...'], 'Extracted thoughts must match steps');
    assert.strictEqual(result.interactionId, 'inter-123', 'Extracted interactionId must match');
    assert.strictEqual(result.environmentId, 'env-456', 'Extracted environmentId must match');

    // Assert stream event routing and mapping
    const thoughts = streamEvents.filter(e => e.type === 'thought');
    assert.strictEqual(thoughts.length, 1);
    assert.strictEqual(thoughts[0].thought, 'Thinking deeply...');
    assert.strictEqual(thoughts[0].interactionId, 'inter-123');
    assert.strictEqual(thoughts[0].environmentId, 'env-456');

    const mcpCalls = streamEvents.filter(e => e.type === 'mcp_call');
    assert.strictEqual(mcpCalls.length, 2);
    assert.strictEqual(mcpCalls[0].toolCall?.name, 'google_search_call');
    assert.deepStrictEqual(mcpCalls[0].toolCall?.args, { queries: ['test search query'] });
    assert.strictEqual(mcpCalls[1].toolCall?.name, 'code_execution_call');
    assert.deepStrictEqual(mcpCalls[1].toolCall?.args, { code: 'print(123)', language: 'python' });

    const statuses = streamEvents.filter(e => e.type === 'status');
    // Including initial status, search call status, and code execution status
    assert.strictEqual(statuses.length, 3);
    assert.ok(statuses[1].text?.includes('Google Search active'));
    assert.ok(statuses[2].text?.includes('Code Execution active'));

    const deltas = streamEvents.filter(e => e.type === 'delta');
    assert.strictEqual(deltas.length, 1);
    assert.strictEqual(deltas[0].text, 'Completed task successfully!');

    console.log('  ✓ Test 2 Passed: executeVertexAgentInteraction correctly processes SSE events and maps types');

    // Test 3: Verify standard Gemini models include googleSearch tool by default
    let standardCaptureOptions: any = {};
    const mockSseStandard = [
        'data: {"id": "std-1", "candidates": [{"content": {"parts": [{"text": "Gemini response with search grounding."}]}, "groundingMetadata": {"webSearchQueries": ["Gemini 3.7 live specs"], "groundingChunks": [{"web": {"uri": "https://ai.google.dev", "title": "Google AI"}}]}}]}',
        'data: [DONE]'
    ].join('\n');

    (globalThis as any).fetch = async (_url: string, options: any) => {
        standardCaptureOptions = options;
        return {
            ok: true,
            text: async () => mockSseStandard,
            body: null
        };
    };

    const stdStreamEvents: GeminiStreamEvent[] = [];
    const stdResult = await service.streamGenerate(
        { prompt: 'Tell me about Gemini 3.7 features' },
        (e) => stdStreamEvents.push(e)
    );

    const stdBody = JSON.parse(standardCaptureOptions.body);
    assert.ok(stdBody.tools?.some((t: any) => t.googleSearch !== undefined), 'Standard model request must include { googleSearch: {} } by default');
    assert.ok(stdResult.groundingMetadata?.webSearchQueries?.includes('Gemini 3.7 live specs'), 'Result must include parsed webSearchQueries');
    assert.strictEqual(stdResult.groundingMetadata?.groundingChunks?.[0]?.web?.uri, 'https://ai.google.dev', 'Result must include parsed grounding chunk URI');
    console.log('  ✓ Test 3 Passed: Standard Gemini model generation enables Google Search tool by default and captures grounding metadata');

    console.log('\n🎉 ALL AGENT INTERACTION TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
});

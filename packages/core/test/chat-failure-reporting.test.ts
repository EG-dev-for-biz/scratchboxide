import { describe, it, expect } from 'vitest';
import { describeChatFailure } from '../src/browser/generative-canvas/hooks/chatFailureMessage';
import { GeminiService } from '../src/node/gemini-service';
import { describeEmptyModelReply } from '../src/node/gemini/streaming';
import type { GeminiStreamEvent } from '../src/common/gemini-protocol';

// Verbatim shape of the error a user saw labelled "Backend Service Offline" while the server was up.
const BLOCKED_KEY_ERROR = 'AI request failed (403): ' + JSON.stringify({
    error: {
        code: 403,
        message: 'Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.GenerativeService.StreamGenerateContent are blocked.',
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_SERVICE_BLOCKED' }]
    }
});

describe('describeChatFailure', () => {
    it('reports a Google rejection as an AI failure with its message and a fix, not as the server being offline', () => {
        const msg = describeChatFailure('ai', BLOCKED_KEY_ERROR);
        expect(msg.text).toContain('The AI request failed');
        expect(msg.text).toContain('StreamGenerateContent are blocked.');
        expect(msg.text).toContain('Settings → Models');
        expect(msg.text).not.toMatch(/offline|can't reach/i);
        expect(msg.text).not.toContain('"code"');
    });

    it('adds a quota hint for RESOURCE_EXHAUSTED and passes plain server messages through', () => {
        const quota = describeChatFailure('ai', 'AI request failed (429): {"error":{"code":429,"message":"Resource exhausted.","status":"RESOURCE_EXHAUSTED"}}');
        expect(quota.text).toContain('Resource exhausted.');
        expect(quota.text).toContain('rate limit or quota');
        const empty = describeChatFailure('ai', describeEmptyModelReply('MAX_TOKENS'));
        expect(empty.text).toContain('ran out of output space');
    });

    it('reduces an HTML error page to its text', () => {
        const html = 'AI request failed (404): <!DOCTYPE html> <html lang=en> <title>Error 404 (Not Found)!!1</title> <style> *{margin:0}body{padding:30px} </style> <p><b>404.</b> <ins>That’s an error.</ins> <p>The requested URL <code>/v1/models/x:streamGenerateContent</code> was not found on this server.';
        const msg = describeChatFailure('ai', html);
        expect(msg.text).toContain('404. That’s an error. The requested URL /v1/models/x:streamGenerateContent was not found on this server.');
        expect(msg.text).not.toMatch(/<\w|margin:0/);
    });

    it('keeps "unreachable" and server errors distinct', () => {
        expect(describeChatFailure('unreachable', 'Failed to fetch').text).toContain("Can't reach the Scratchbox server");
        const unauthorized = describeChatFailure('server', 'HTTP 401: Missing or invalid Scratchbox launch token', 401).text;
        expect(unauthorized).toContain('`?token=…`'); // a browser tab needs the printed launch link
        expect(unauthorized).toContain('In the desktop app, restart the app.');
        expect(describeChatFailure('server', 'HTTP 500: boom', 500).toast).toBe('Server error (500)');
    });
});

describe('streaming: a tool call that never returns', () => {
    it('reports the tool as failed after the time limit and lets the chat finish', async () => {
        process.env.SCRATCHBOX_TOOL_TIMEOUT_MS = '300';
        try {
            const service = new GeminiService();
            (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
            (service as any).cachedProjectId = 'mock-project';
            (service as any).toolRegistry.register('hang_forever', {
                name: 'hang_forever', description: 'never returns', parameters: { type: 'OBJECT', properties: {} }
            }, () => new Promise(() => undefined), 'workspace');

            const bodies: any[] = [];
            const turns = [
                'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"hang_forever","args":{}}}]},"finishReason":"STOP"}]}\ndata: [DONE]',
                'data: {"candidates":[{"content":{"parts":[{"text":"The tool timed out, continuing."}]},"finishReason":"STOP"}]}\ndata: [DONE]'
            ];
            (globalThis as any).fetch = async (_url: string, opts: any) => {
                bodies.push(JSON.parse(opts.body));
                return { ok: true, text: async () => turns[bodies.length - 1], body: null };
            };

            const events: GeminiStreamEvent[] = [];
            const started = Date.now();
            const response = await service.streamGenerate({ prompt: 'run the slow tool', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));

            expect(Date.now() - started).toBeLessThan(5000);
            expect(response.success).toBe(true);
            const toolResult = events.find(e => e.type === 'tool_result');
            expect(toolResult?.mcpExecution?.status).toBe('failed');
            expect(String((toolResult?.toolResult as any)?.result?.error)).toContain('did not finish within');
            const sentBack = JSON.stringify(bodies[1]?.contents?.at(-1));
            expect(sentBack).toContain('did not finish within');
            expect(events.some(e => e.type === 'done')).toBe(true);
        } finally {
            delete process.env.SCRATCHBOX_TOOL_TIMEOUT_MS;
        }
    });
});

describe('streaming: a prose answer in agent mode', () => {
    it('does not invent a canvas artifact from keywords in the prompt', async () => {
        const service = new GeminiService();
        (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
        (service as any).cachedProjectId = 'mock-project';
        (globalThis as any).fetch = async () => ({
            ok: true,
            text: async () => 'data: {"candidates":[{"content":{"parts":[{"text":"Spain won the 2026 FIFA World Cup, beating Argentina 1-0 after extra time."}]},"finishReason":"STOP"}]}\ndata: [DONE]',
            body: null
        });
        const events: GeminiStreamEvent[] = [];
        // "World Cup" used to match the creation-keyword pattern ("world") and produce a template document.
        const response = await service.streamGenerate(
            { prompt: 'Who won the most recent FIFA World Cup? Answer in two sentences and cite your source.', model: 'gemini-3.7-flash', mode: 'agent', enableWorkspaceTools: true },
            e => events.push(e)
        );
        expect(response.success).toBe(true);
        expect(response.text).toContain('Spain');
        expect(response.artifact).toBeUndefined();
        expect(events.some(e => e.artifact)).toBe(false);
    });
});

describe('streaming: a model turn that produces nothing', () => {
    const run = async (sse: string) => {
        const service = new GeminiService();
        (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
        (service as any).cachedProjectId = 'mock-project';
        (globalThis as any).fetch = async () => ({ ok: true, text: async () => sse, body: null });
        const events: GeminiStreamEvent[] = [];
        const response = await service.streamGenerate(
            { prompt: 'Build a small interactive tip calculator app', model: 'gemini-3.7-flash', mode: 'agent', enableWorkspaceTools: true },
            e => events.push(e)
        );
        return { response, events };
    };

    it('reports the finish reason instead of building a template artifact from the prompt', async () => {
        const { response, events } = await run('data: {"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]}\ndata: [DONE]');
        expect(response.success).toBe(false);
        expect(response.artifact).toBeUndefined();
        expect(events.some(e => e.artifact)).toBe(false);
        const error = events.find(e => e.type === 'error');
        expect(error?.error).toContain('ran out of output space');
        expect(error?.error).toContain('MAX_TOKENS');
    });

    it('still finishes normally when the model replies with text', async () => {
        const { response, events } = await run('data: {"candidates":[{"content":{"parts":[{"text":"Here is your calculator."}]},"finishReason":"STOP"}]}\ndata: [DONE]');
        expect(response.success).toBe(true);
        expect(events.some(e => e.type === 'error')).toBe(false);
        expect(events.some(e => e.type === 'done')).toBe(true);
    });
});

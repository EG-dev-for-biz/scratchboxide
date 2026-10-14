import { describe, it, expect, afterEach } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import type { GeminiStreamEvent } from '../src/common/gemini-protocol';

const realFetch = globalThis.fetch;
afterEach(() => { (globalThis as any).fetch = realFetch; });

function makeService(): GeminiService {
    const service = new GeminiService();
    (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
    (service as any).cachedProjectId = 'mock-project';
    return service;
}

const call = (name: string, args: Record<string, unknown>) =>
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;

describe('agent loop control', () => {
    it('stops and waits after asking the user a question', async () => {
        let requests = 0;
        (globalThis as any).fetch = async () => {
            requests++;
            return {
                ok: true,
                body: null,
                text: async () => call('ask_user_question', {
                    title: 'Scale',
                    questions: [{ id: 'q1', prompt: 'Tabletop or full size?', type: 'single', options: [{ id: 'a', label: 'Tabletop' }, { id: 'b', label: 'Full size' }] }]
                })
            };
        };
        const events: GeminiStreamEvent[] = [];
        const response = await makeService().streamGenerate({ prompt: 'build a telescope', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));

        expect(requests).toBe(1);
        expect(response.success).toBe(true);
        expect(response.questionCard?.questions[0].prompt).toBe('Tabletop or full size?');
        expect(events.some(e => e.type === 'status' && e.text === 'Waiting for your answer...')).toBe(true);
    });

    it('streams task list updates to the UI', async () => {
        const turns = [
            call('update_task_list', { tasks: [{ title: 'Read scene', status: 'in_progress' }, { title: 'Fix legs', status: 'pending' }] }),
            'data: {"candidates":[{"content":{"parts":[{"text":"Done."}]},"finishReason":"STOP"}]}\ndata: [DONE]'
        ];
        let i = 0;
        (globalThis as any).fetch = async () => ({ ok: true, body: null, text: async () => turns[i++] });
        const events: GeminiStreamEvent[] = [];
        await makeService().streamGenerate({ prompt: 'fix the stool', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));

        const update = events.find(e => e.type === 'task_list');
        expect(update?.taskList).toEqual([{ title: 'Read scene', status: 'in_progress' }, { title: 'Fix legs', status: 'pending' }]);
    });

    it('says so when it runs out of tool rounds instead of ending silently', async () => {
        let requests = 0;
        (globalThis as any).fetch = async () => {
            requests++;
            return { ok: true, body: null, text: async () => call('update_task_list', { tasks: [{ title: `step ${requests}`, status: 'in_progress' }] }) };
        };
        const response = await makeService().streamGenerate({ prompt: 'loop', model: 'gemini-3.7-flash', mode: 'agent', maxTurns: 3 }, () => undefined);

        expect(requests).toBe(3);
        expect(response.text).toContain('I stopped after 3 rounds of tool calls');
    });
});

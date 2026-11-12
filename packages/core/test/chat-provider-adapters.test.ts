/**
 * The chat on Claude and OpenAI models: the tool-schema translation, each adapter against constructed provider streams
 * (the SDKs' own stream parsers read them through an injected fetch, so nothing is billed), and the whole agent loop
 * (tool call, tool run, result back to the model, final answer) on each provider through GeminiService.
 */
import { describe, it, expect } from 'vitest';
import { toJsonSchema, toolInputSchema } from '../src/node/chat-agent/tool-schema';
import { AnthropicChatSession } from '../src/node/chat-agent/anthropic-session';
import { OpenAIChatSession } from '../src/node/chat-agent/openai-session';
import { ChatProviderError, type AgentToolCall, type TurnSink } from '../src/node/chat-agent/agent-turn';
import { withTurnContextMessage, type ChatPrompt } from '../src/node/chat-agent/chat-prompt';
import { providerForChatModel } from '../src/common/chat-models';
import { GeminiService } from '../src/node/gemini-service';
import type { GeminiStreamEvent } from '../src/common/gemini-protocol';
import type { ToolDeclaration } from '../src/node/gemini/tools/types';

// ---------------------------------------------------------------- fixtures

const sse = (events: Array<{ type: string; [k: string]: unknown }>) =>
    events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

interface Recorded { url: string; body: any; headers: Record<string, string> }

/** A fetch that answers each request with the next canned response and records what was sent. */
function cannedFetch(responses: Array<{ status?: number; body: string; contentType?: string }>, sent: Recorded[]): typeof fetch {
    let i = 0;
    return (async (input: any, init: any) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers || {}).forEach((v, k) => { headers[k] = v; });
        sent.push({ url: String(input), body: init?.body ? JSON.parse(init.body) : undefined, headers });
        const r = responses[Math.min(i++, responses.length - 1)];
        return new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': r.contentType ?? 'text/event-stream', 'request-id': `req_${i}` } });
    }) as typeof fetch;
}

const usage = { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };

function claudeStream(blocks: Array<{ type: 'thinking'; text: string; signature: string } | { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>, stopReason: string, extra: Record<string, unknown> = {}, model = 'claude-opus-5-5'): string {
    const events: Array<{ type: string; [k: string]: unknown }> = [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }
    ];
    blocks.forEach((b, index) => {
        if (b.type === 'thinking') {
            events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.text } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } });
        } else if (b.type === 'text') {
            events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
            for (const piece of b.text.match(/.{1,6}/gs) || []) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
        } else {
            const json = JSON.stringify(b.input);
            events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 8) } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(8) } });
        }
        events.push({ type: 'content_block_stop', index });
    });
    events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, ...extra }, usage: { output_tokens: 40 } });
    events.push({ type: 'message_stop' });
    return sse(events);
}

type OaItem =
    | { type: 'reasoning'; id: string; summary: string; encrypted: string }
    | { type: 'message'; id: string; text: string; refusal?: string }
    | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string };

function openaiStream(items: OaItem[], opts: { status?: 'completed' | 'incomplete'; reason?: string; model?: string } = {}): string {
    const model = opts.model || 'gpt-6-astra';
    const full = items.map(it => {
        if (it.type === 'reasoning') return { type: 'reasoning', id: it.id, summary: [{ type: 'summary_text', text: it.summary }], encrypted_content: it.encrypted, status: 'completed' };
        if (it.type === 'message') return { type: 'message', id: it.id, role: 'assistant', status: 'completed', content: it.refusal ? [{ type: 'refusal', refusal: it.refusal }] : [{ type: 'output_text', text: it.text, annotations: [] }] };
        return { type: 'function_call', id: it.id, call_id: it.call_id, name: it.name, arguments: it.arguments, status: 'completed' };
    });
    const base = { id: 'resp_1', object: 'response', created_at: 1, model, status: 'in_progress', output: [], parallel_tool_calls: true, tools: [], tool_choice: 'auto', usage: null, error: null, incomplete_details: null, instructions: null, metadata: {}, temperature: 1, top_p: 1 };
    const events: Array<{ type: string; [k: string]: unknown }> = [{ type: 'response.created', response: base }];
    items.forEach((it, i) => {
        if (it.type === 'reasoning') {
            events.push({ type: 'response.output_item.added', output_index: i, item: { type: 'reasoning', id: it.id, summary: [], status: 'in_progress' } });
            events.push({ type: 'response.reasoning_summary_part.added', output_index: i, item_id: it.id, summary_index: 0, part: { type: 'summary_text', text: '' } });
            events.push({ type: 'response.reasoning_summary_text.delta', output_index: i, item_id: it.id, summary_index: 0, delta: it.summary });
            events.push({ type: 'response.reasoning_summary_text.done', output_index: i, item_id: it.id, summary_index: 0, text: it.summary });
            events.push({ type: 'response.reasoning_summary_part.done', output_index: i, item_id: it.id, summary_index: 0, part: { type: 'summary_text', text: it.summary } });
        } else if (it.type === 'message') {
            events.push({ type: 'response.output_item.added', output_index: i, item: { type: 'message', id: it.id, role: 'assistant', status: 'in_progress', content: [] } });
            if (it.refusal) {
                events.push({ type: 'response.content_part.added', output_index: i, item_id: it.id, content_index: 0, part: { type: 'refusal', refusal: '' } });
                events.push({ type: 'response.refusal.delta', output_index: i, item_id: it.id, content_index: 0, delta: it.refusal });
                events.push({ type: 'response.refusal.done', output_index: i, item_id: it.id, content_index: 0, refusal: it.refusal });
                events.push({ type: 'response.content_part.done', output_index: i, item_id: it.id, content_index: 0, part: { type: 'refusal', refusal: it.refusal } });
            } else {
                events.push({ type: 'response.content_part.added', output_index: i, item_id: it.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
                events.push({ type: 'response.output_text.delta', output_index: i, item_id: it.id, content_index: 0, delta: it.text, logprobs: [] });
                events.push({ type: 'response.output_text.done', output_index: i, item_id: it.id, content_index: 0, text: it.text, logprobs: [] });
                events.push({ type: 'response.content_part.done', output_index: i, item_id: it.id, content_index: 0, part: { type: 'output_text', text: it.text, annotations: [] } });
            }
        } else {
            events.push({ type: 'response.output_item.added', output_index: i, item: { type: 'function_call', id: it.id, call_id: it.call_id, name: it.name, arguments: '', status: 'in_progress' } });
            events.push({ type: 'response.function_call_arguments.delta', output_index: i, item_id: it.id, delta: it.arguments });
            events.push({ type: 'response.function_call_arguments.done', output_index: i, item_id: it.id, arguments: it.arguments, name: it.name });
        }
        events.push({ type: 'response.output_item.done', output_index: i, item: full[i] });
    });
    const status = opts.status || 'completed';
    events.push({
        type: status === 'completed' ? 'response.completed' : 'response.incomplete',
        response: { ...base, status, output: full, incomplete_details: opts.reason ? { reason: opts.reason } : null, usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 700 }, output_tokens: 60, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 960 } }
    });
    return sse(events.map((e, n) => ({ ...e, sequence_number: n })));
}

function recordingSink() {
    const got = { text: '', thoughts: [] as string[], calls: [] as AgentToolCall[] };
    const sink: TurnSink = { text: d => { got.text += d; }, thought: d => { got.thoughts.push(d); }, toolCall: c => { got.calls.push(c); } };
    return { got, sink };
}

const prompt: ChatPrompt = {
    stable: 'You are Scratchbox AI.',
    turnContext: 'Workspace: /tmp/ws',
    messages: withTurnContextMessage([{ role: 'user', text: 'Build a stool.', images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }], 'Workspace: /tmp/ws')
};

const tools: ToolDeclaration[] = [
    { name: 'list_things', description: 'Lists things', parameters: { type: 'OBJECT', properties: { limit: { type: 'NUMBER' } } } },
    {
        name: 'execute_script',
        description: 'Runs a script',
        parameters: {
            type: 'OBJECT',
            properties: {
                code: { type: 'STRING', description: 'Python source' },
                tags: { type: 'ARRAY' },
                mode: { type: 'STRING', enum: ['clay', 'pbr'] },
                note: { type: 'STRING', nullable: true } as any
            },
            required: ['code', 'missing_prop']
        }
    }
];

// ---------------------------------------------------------------- schema

describe('tool schema translation', () => {
    it('writes Gemini declarations as JSON Schema: lowercase types, items on every array, nullable as a type union', () => {
        const schema = toolInputSchema(tools[1]);
        expect(schema).toEqual({
            type: 'object',
            properties: {
                code: { type: 'string', description: 'Python source' },
                tags: { type: 'array', items: {} },
                mode: { type: 'string', enum: ['clay', 'pbr'] },
                note: { type: ['string', 'null'] }
            },
            // a required name with no property is left out (both providers reject it)
            required: ['code']
        });
        expect(toJsonSchema({ type: 'ARRAY', items: { type: 'OBJECT', properties: { x: { type: 'NUMBER' } } } })).toEqual({ type: 'array', items: { type: 'object', properties: { x: { type: 'number' } } } });
        expect(toolInputSchema({ name: 'no_params', description: 'x' })).toEqual({ type: 'object', properties: {} });
    });

    it('reads the provider from the model id', () => {
        expect(providerForChatModel('claude-opus-5-5')).toBe('anthropic');
        expect(providerForChatModel('claude-some-future-model')).toBe('anthropic');
        expect(providerForChatModel('gpt-6-astra')).toBe('openai');
        expect(providerForChatModel('gpt-5.1-codex-max')).toBe('openai');
        expect(providerForChatModel('gemini-4-argon')).toBe('gemini');
        expect(providerForChatModel(undefined)).toBe('gemini');
    });
});

// ---------------------------------------------------------------- Claude

describe('Claude adapter (Messages API)', () => {
    const session = (fetchFn: typeof fetch, model = 'claude-opus-5-5') =>
        new AnthropicChatSession({ apiKey: 'sk-ant-test', model, prompt, tools: () => tools, effort: 'high', fetch: fetchFn });

    it('streams thoughts and text, hands over the tool call, and sends thinking blocks and tool results back', async () => {
        const sent: Recorded[] = [];
        const s = session(cannedFetch([
            { body: claudeStream([{ type: 'thinking', text: 'Plan the legs.', signature: 'sig-abc' }, { type: 'text', text: 'Building it now.' }, { type: 'tool_use', id: 'toolu_1', name: 'execute_script', input: { code: 'print(1)' } }], 'tool_use') },
            { body: claudeStream([{ type: 'text', text: 'Done.' }], 'end_turn') }
        ], sent));

        const first = recordingSink();
        const turn1 = await s.streamTurn(first.sink, undefined, 1);
        expect(first.got.thoughts.join('')).toBe('Plan the legs.');
        expect(first.got.text).toBe('Building it now.');
        expect(turn1.toolCalls).toEqual([{ id: 'toolu_1', name: 'execute_script', args: { code: 'print(1)' }, callModel: 'claude-opus-5-5' }]);
        expect(first.got.calls).toHaveLength(1);
        expect(turn1.finishReason).toBe('tool_use');
        expect(turn1.usage).toMatchObject({ promptTokenCount: 2200, cachedContentTokenCount: 1000, candidatesTokenCount: 40 });

        // the request: stable system prompt cached, request context in the user message, tools as JSON Schema
        const req = sent[0];
        expect(req.url).toContain('https://api.anthropic.com/v1/messages');
        // @anthropic-ai/sdk 1.x sends the key as a bearer token
        expect(req.headers['authorization']).toBe('Bearer sk-ant-test');
        expect(req.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
        expect(req.body.fallbacks).toBe('default');
        expect(req.body.system).toEqual([{ type: 'text', text: 'You are Scratchbox AI.', cache_control: { type: 'ephemeral' } }]);
        expect(req.body.cache_control).toEqual({ type: 'ephemeral' });
        expect(req.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(req.body.output_config).toEqual({ effort: 'high' });
        expect(req.body).not.toHaveProperty('temperature');
        expect(req.body.tools[1]).toMatchObject({ name: 'execute_script', input_schema: { type: 'object', required: ['code'] } });
        expect(req.body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
        expect(req.body.messages[0].content[1].text).toMatch(/^\[Context for this request[\s\S]*Workspace: \/tmp\/ws\n\nBuild a stool\.$/);

        s.addToolResults([{ call: turn1.toolCalls[0], content: { toolFailed: true, error: 'boom' }, isError: true, images: [{ mimeType: 'image/jpeg', data: '/9j/4AAQ', label: 'Image from execute_script: render (64 x 64 px)' }] }]);
        const second = recordingSink();
        const turn2 = await s.streamTurn(second.sink, undefined, 2);
        expect(turn2.text).toBe('Done.');
        expect(turn2.toolCalls).toEqual([]);

        const msgs = sent[1].body.messages;
        // the assistant turn verbatim: the thinking block keeps its signature
        expect(msgs[1].role).toBe('assistant');
        expect(msgs[1].content[0]).toMatchObject({ type: 'thinking', thinking: 'Plan the legs.', signature: 'sig-abc' });
        expect(msgs[1].content[2]).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'execute_script', input: { code: 'print(1)' } });
        // one user message with the tool_result, the error flagged, the tool's image inside it
        expect(msgs[2]).toEqual({
            role: 'user',
            content: [{
                type: 'tool_result', tool_use_id: 'toolu_1', is_error: true,
                content: [
                    { type: 'text', text: '{"toolFailed":true,"error":"boom"}' },
                    { type: 'text', text: 'Image from execute_script: render (64 x 64 px)' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } }
                ]
            }]
        });
    });

    it('ends the turn with a message when Claude declines, and runs nothing', async () => {
        const s = session(cannedFetch([{ body: claudeStream([], 'refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: 'Not allowed.' } }) }], []));
        const r = recordingSink();
        const turn = await s.streamTurn(r.sink, undefined, 1);
        expect(turn.toolCalls).toEqual([]);
        expect(r.got.calls).toEqual([]);
        expect(turn.stopNotice).toContain('Claude declined this request (category: cyber)');
    });

    it('does not run a tool call cut off at the output limit', async () => {
        const s = session(cannedFetch([{ body: claudeStream([{ type: 'tool_use', id: 'toolu_9', name: 'execute_script', input: { code: 'x' } }], 'max_tokens') }], []));
        const r = recordingSink();
        const turn = await s.streamTurn(r.sink, undefined, 1);
        expect(turn.toolCalls).toEqual([]);
        expect(turn.stopNotice).toContain('ran out of output space');
    });

    it('names the tool when Claude refuses a tool schema, and sends no fallback on Haiku', async () => {
        const sent: Recorded[] = [];
        const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'tools.1.custom.input_schema: JSON schema is invalid' } });
        const s = session(cannedFetch([{ status: 400, body, contentType: 'application/json' }], sent), 'claude-haiku-5-5');
        const err = await s.streamTurn(recordingSink().sink, undefined, 1).catch(e => e);
        expect(err).toBeInstanceOf(ChatProviderError);
        expect(err.rejectedTool).toBe('execute_script');
        expect(err.message).toContain('refused the schema of the tool execute_script');
        expect(sent[0].body).not.toHaveProperty('fallbacks');
    });
});

// ---------------------------------------------------------------- OpenAI

describe('OpenAI adapter (Responses API)', () => {
    const session = (fetchFn: typeof fetch) =>
        new OpenAIChatSession({ apiKey: 'sk-test', model: 'gpt-6-astra', prompt, tools: () => tools, effort: 'high', fetch: fetchFn });

    it('streams reasoning summaries and text, hands over function calls, and replays encrypted reasoning statelessly', async () => {
        const sent: Recorded[] = [];
        const s = session(cannedFetch([
            { body: openaiStream([
                { type: 'reasoning', id: 'rs_1', summary: 'Plan the legs.', encrypted: 'enc-xyz' },
                { type: 'message', id: 'msg_1', text: 'Building it now.' },
                { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'execute_script', arguments: '{"code":"print(1)"}' }
            ]) },
            { body: openaiStream([{ type: 'message', id: 'msg_2', text: 'Done.' }]) }
        ], sent));

        const first = recordingSink();
        const turn1 = await s.streamTurn(first.sink, undefined, 1);
        expect(first.got.thoughts.join('')).toBe('Plan the legs.');
        expect(first.got.text).toBe('Building it now.');
        expect(turn1.toolCalls).toEqual([{ id: 'call_1', name: 'execute_script', args: { code: 'print(1)' }, callModel: 'gpt-6-astra' }]);
        expect(turn1.usage).toMatchObject({ promptTokenCount: 900, cachedContentTokenCount: 700, thoughtsTokenCount: 20 });

        const req = sent[0];
        expect(req.url).toBe('https://api.openai.com/v1/responses');
        expect(req.headers['authorization']).toBe('Bearer sk-test');
        expect(req.body).toMatchObject({ model: 'gpt-6-astra', instructions: 'You are Scratchbox AI.', store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'high', summary: 'auto' }, stream: true });
        expect(req.body.tools[1]).toMatchObject({ type: 'function', name: 'execute_script', strict: false, parameters: { type: 'object', required: ['code'] } });
        expect(req.body.input[0].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' });

        s.addToolResults([{ call: turn1.toolCalls[0], content: { ok: true }, isError: false, images: [{ mimeType: 'image/jpeg', data: '/9j/4AAQ', label: 'Image from execute_script: render' }] }]);
        const turn2 = await s.streamTurn(recordingSink().sink, undefined, 2);
        expect(turn2.text).toBe('Done.');

        const input = sent[1].body.input;
        expect(input[1]).toMatchObject({ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-xyz' });
        // exactly the API's fields: the SDK helper's parsed_arguments / parsed are not sent back (the API answers 400)
        expect(input[2]).toEqual({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Building it now.', annotations: [] }] });
        expect(input[3]).toEqual({ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'execute_script', arguments: '{"code":"print(1)"}', status: 'completed' });
        expect(input[4]).toEqual({
            type: 'function_call_output', call_id: 'call_1',
            output: [
                { type: 'input_text', text: '{"ok":true}' },
                { type: 'input_text', text: 'Image from execute_script: render' },
                { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4AAQ', detail: 'auto' }
            ]
        });
    });

    it('marks arguments that are not JSON instead of running the tool on a guess', async () => {
        const s = session(cannedFetch([{ body: openaiStream([{ type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'execute_script', arguments: '{"code": "x"' }]) }], []));
        const turn = await s.streamTurn(recordingSink().sink, undefined, 1);
        expect(turn.toolCalls[0]).toMatchObject({ name: 'execute_script', args: {}, meta: { invalidArguments: '{"code": "x"' } });
    });

    it('ends the turn with a message on a refusal and on a function call cut off at the output limit', async () => {
        const refused = await session(cannedFetch([{ body: openaiStream([{ type: 'message', id: 'm', text: '', refusal: 'I cannot help with that.' }]) }], [])).streamTurn(recordingSink().sink, undefined, 1);
        expect(refused.stopNotice).toContain('I cannot help with that.');
        const cut = await session(cannedFetch([{ body: openaiStream([{ type: 'function_call', id: 'fc_3', call_id: 'call_3', name: 'execute_script', arguments: '{"code":"x"}' }], { status: 'incomplete', reason: 'max_output_tokens' }) }], [])).streamTurn(recordingSink().sink, undefined, 1);
        expect(cut.toolCalls).toEqual([]);
        expect(cut.stopNotice).toContain('max_output_tokens');
    });

    it('names the tool when OpenAI refuses a function schema', async () => {
        const body = JSON.stringify({ error: { message: "Invalid schema for function 'execute_script': array schema missing items.", type: 'invalid_request_error', param: 'tools[1].parameters', code: 'invalid_function_parameters' } });
        const err = await session(cannedFetch([{ status: 400, body, contentType: 'application/json' }], [])).streamTurn(recordingSink().sink, undefined, 1).catch(e => e);
        expect(err).toBeInstanceOf(ChatProviderError);
        expect(err.rejectedTool).toBe('execute_script');
    });
});

// ---------------------------------------------------------------- the agent loop on each provider

function serviceWith(fetchFn: typeof fetch, keys: Record<string, string | undefined>): GeminiService {
    const service = new GeminiService();
    const engine = (service as any).streaming;
    engine.providerFetch = fetchFn;
    engine.providerCredentials = { resolveKey: async (p: string) => keys[p] };
    return service;
}

const tasks = { tasks: [{ title: 'Block out the seat', status: 'in_progress' }, { title: 'Add legs', status: 'pending' }] };

describe('the chat agent loop on Claude and OpenAI', () => {
    it('runs a tool call on Claude and gives the result back to the model', async () => {
        const sent: Recorded[] = [];
        const service = serviceWith(cannedFetch([
            { body: claudeStream([{ type: 'text', text: 'Planning.' }, { type: 'tool_use', id: 'toolu_t', name: 'update_task_list', input: tasks }], 'tool_use', {}, 'claude-sonnet-5-5') },
            { body: claudeStream([{ type: 'text', text: 'The plan is up.' }], 'end_turn', {}, 'claude-sonnet-5-5') }
        ], sent), { anthropic: 'sk-ant-test' });
        const events: GeminiStreamEvent[] = [];
        const response = await service.streamGenerate({ prompt: 'plan a stool', model: 'claude-sonnet-5-5', mode: 'agent' }, e => events.push(e));

        expect(response.success).toBe(true);
        expect(response.text).toBe('Planning.The plan is up.');
        expect(events.find(e => e.type === 'task_list')?.taskList).toEqual(tasks.tasks);
        expect(events.some(e => e.type === 'tool_result' && e.toolResult?.name === 'update_task_list')).toBe(true);
        const done = events.find(e => e.type === 'done');
        expect(done?.modelProvenance).toMatchObject({ requestedModel: 'claude-sonnet-5-5', modelUsed: 'claude-sonnet-5-5', credential: 'anthropic-api-key' });
        expect(sent).toHaveLength(2);
        expect(sent[0].body.tools.some((t: any) => t.name === 'update_task_list')).toBe(true);
        // the real system prompt, the same one Gemini gets
        expect(sent[0].body.system[0].text.length).toBeGreaterThan(1000);
        const toolResult = sent[1].body.messages.at(-1).content[0];
        expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_t' });
    });

    it('runs a tool call on an OpenAI model and gives the result back to the model', async () => {
        const sent: Recorded[] = [];
        const service = serviceWith(cannedFetch([
            { body: openaiStream([{ type: 'reasoning', id: 'rs_9', summary: 'Plan first.', encrypted: 'enc' }, { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'update_task_list', arguments: JSON.stringify(tasks) }]) },
            { body: openaiStream([{ type: 'message', id: 'msg_9', text: 'The plan is up.' }]) }
        ], sent), { openai: 'sk-test' });
        const events: GeminiStreamEvent[] = [];
        const response = await service.streamGenerate({ prompt: 'plan a stool', model: 'gpt-6-astra', mode: 'agent' }, e => events.push(e));

        expect(response.success).toBe(true);
        expect(response.text).toBe('The plan is up.');
        expect(events.some(e => e.type === 'thought' && e.thought === 'Plan first.')).toBe(true);
        expect(events.find(e => e.type === 'task_list')?.taskList).toEqual(tasks.tasks);
        expect(events.find(e => e.type === 'done')?.modelProvenance).toMatchObject({ credential: 'openai-api-key', modelUsed: 'gpt-6-astra' });
        const output = sent[1].body.input.find((i: any) => i.type === 'function_call_output');
        expect(output.call_id).toBe('call_9');
        expect(JSON.parse(output.output)).toMatchObject({ status: 'task_list_updated' });
    });

    it("does not hand the chat's Claude model id to tools, whose own Google calls would ask Vertex for it", async () => {
        const service = serviceWith(cannedFetch([
            { body: claudeStream([{ type: 'tool_use', id: 'toolu_m', name: 'update_task_list', input: tasks }], 'tool_use', {}, 'claude-opus-5-5') },
            { body: claudeStream([{ type: 'text', text: 'Done.' }], 'end_turn', {}, 'claude-opus-5-5') }
        ], []), { anthropic: 'sk-ant-test' });
        const registry = (service as any).streaming.registry;
        const dispatch = registry.dispatch.bind(registry);
        const seen: Array<string | undefined> = [];
        registry.dispatch = (name: string, args: unknown, ctx: any) => { seen.push(ctx.request.model); return dispatch(name, args, ctx); };
        await service.streamGenerate({ prompt: 'plan', model: 'claude-opus-5-5', mode: 'agent', subagentModel: 'gemini-3.5-flash-lite' }, () => undefined);
        // the tool's context carries no chat model
        expect(seen).toEqual([undefined]);
    });

    it("says so when Claude's server-side fallback answered instead of the chat's model", async () => {
        const service = serviceWith(cannedFetch([{ body: claudeStream([{ type: 'text', text: 'Answered.' }], 'end_turn', {}, 'claude-sonnet-5') }], []), { anthropic: 'sk-ant-test' });
        const events: GeminiStreamEvent[] = [];
        await service.streamGenerate({ prompt: 'hi', model: 'claude-sonnet-5-5', mode: 'ask' }, e => events.push(e));
        expect(events.find(e => e.type === 'done')?.modelProvenance).toMatchObject({
            requestedModel: 'claude-sonnet-5-5',
            modelUsed: 'claude-sonnet-5',
            fallbackReason: expect.stringContaining('server-side fallback')
        });
    });

    it('fails the turn with a message naming the missing key, before any request', async () => {
        const sent: Recorded[] = [];
        const service = serviceWith(cannedFetch([{ body: '' }], sent), {});
        const err = await service.streamGenerate({ prompt: 'hi', model: 'claude-opus-5-5', mode: 'agent' }, () => undefined).catch(e => e);
        expect(err.message).toContain('No Anthropic Claude API key is configured, so claude-opus-5-5 cannot answer');
        expect(err.message).toContain('Settings > Models & AI');
        expect(err.modelProvenance).toMatchObject({ credential: 'anthropic-api-key', noModelAnswered: true });
        expect(sent).toHaveLength(0);
    });

    it('turns a provider error into the turn error', async () => {
        const body = JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
        const service = serviceWith(cannedFetch([{ status: 401, body, contentType: 'application/json' }], []), { openai: 'sk-bad' });
        const err = await service.streamGenerate({ prompt: 'hi', model: 'gpt-6.1-sol', mode: 'agent' }, () => undefined).catch(e => e);
        expect(err.message).toContain('OpenAI rejected the API key (401)');
        expect(err.modelProvenance).toMatchObject({ credential: 'openai-api-key', noModelAnswered: true });
    });
});

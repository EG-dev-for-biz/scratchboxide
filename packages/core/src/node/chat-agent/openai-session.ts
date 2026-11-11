/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The chat on OpenAI models (GPT and Codex): the Responses API with function calling, streamed (openai SDK).
 * - Stateless: `store: false`, so OpenAI keeps no conversation; each call sends the whole input, and the model's
 *   reasoning items come back encrypted (`include: reasoning.encrypted_content`) and are sent back verbatim, as the
 *   API needs for function calling with reasoning.
 * - Reasoning depth from Settings' thinking budget as `reasoning.effort`; reasoning summaries are shown as thoughts.
 * - Images go as data-URL input_image parts; a tool's images go inside its function_call_output.
 * - Prompt caching is automatic on OpenAI; the stable instructions and tools come first, the request's context in the
 *   last user message (chat-prompt.ts), and prompt_cache_key keeps one chat's calls on one cache.
 */

import OpenAI, { APIError } from 'openai';
import type {
    FunctionTool,
    Response as OpenAIResponse,
    ResponseCreateParamsStreaming,
    ResponseFunctionCallOutputItemList,
    ResponseInputItem,
    ResponseUsage
} from 'openai/resources/responses/responses';
import * as crypto from 'crypto';
import type { ToolDeclaration } from '../gemini/tools/types';
import { ChatProviderError, type AgentToolCall, type AgentToolResult, type AgentUsage, type ChatSession, type TurnOutcome, type TurnSink } from './agent-turn';
import type { ChatPrompt, PromptMessage } from './chat-prompt';
import { toolInputSchema } from './tool-schema';

export const OPENAI_API_BASE = 'https://api.openai.com/v1';
const MAX_OUTPUT_TOKENS = 64_000;

function dataUrl(mimeType: string, data: string): string {
    return `data:${mimeType || 'image/png'};base64,${data}`;
}

function inputMessage(m: PromptMessage): ResponseInputItem {
    if (m.role === 'assistant') {
        return { role: 'assistant', content: m.text } as ResponseInputItem;
    }
    return {
        role: 'user',
        content: [
            ...(m.text ? [{ type: 'input_text' as const, text: m.text }] : []),
            ...m.images.map(img => ({ type: 'input_image' as const, image_url: dataUrl(img.mimeType, img.data), detail: 'auto' as const }))
        ]
    } as ResponseInputItem;
}

export function openaiTools(declarations: ToolDeclaration[]): FunctionTool[] {
    // strict: false — strict mode needs every property required and no extra keys, which the declarations do not promise.
    return declarations.map(d => ({ type: 'function', name: d.name, description: d.description || d.name, parameters: toolInputSchema(d), strict: false }));
}

export function openaiUsage(usage: ResponseUsage | undefined | null): AgentUsage | undefined {
    if (!usage) return undefined;
    return {
        promptTokenCount: usage.input_tokens,
        candidatesTokenCount: usage.output_tokens,
        totalTokenCount: usage.total_tokens,
        cachedContentTokenCount: usage.input_tokens_details?.cached_tokens ?? 0,
        thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens ?? 0
    };
}

/** What to tell the user for a failed OpenAI request; names the tool when OpenAI refused a tool's schema. */
export function describeOpenAIError(err: unknown, model: string, tools: ToolDeclaration[]): ChatProviderError {
    if (err instanceof APIError) {
        const body = err.error as { message?: string } | undefined;
        const detail = body?.message || err.message;
        const byName = /function '([^']+)'/.exec(detail || '')?.[1];
        const byIndex = /tools\[(\d+)\]/.exec(`${err.param || ''} ${detail || ''}`)?.[1];
        const rejectedTool = byName || (byIndex !== undefined ? tools[Number(byIndex)]?.name : undefined);
        if (rejectedTool) {
            return new ChatProviderError(`OpenAI (${model}) refused the schema of the tool ${rejectedTool}, so the request was not run: ${detail}`, 'openai', err.status, rejectedTool);
        }
        if (err.status === 401) return new ChatProviderError(`OpenAI rejected the API key (401): ${detail}. Check the key in Settings > Models & AI.`, 'openai', 401);
        if (err.status === 404) return new ChatProviderError(`OpenAI does not serve the model ${model} to this key (404): ${detail}`, 'openai', 404);
        return new ChatProviderError(`OpenAI request failed (${err.status ?? 'no status'}): ${detail}`, 'openai', err.status);
    }
    return new ChatProviderError(`OpenAI request failed: ${err instanceof Error ? err.message : String(err)}`, 'openai');
}

export interface OpenAISessionOptions {
    apiKey: string;
    model: string;
    prompt: ChatPrompt;
    /** The tools to offer, read again when load_tools adds some (refreshTools). */
    tools: () => ToolDeclaration[];
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    fetch?: typeof fetch;
    baseURL?: string;
}

export class OpenAIChatSession implements ChatSession {
    readonly provider = 'openai' as const;
    readonly model: string;
    private readonly client: OpenAI;
    private readonly instructions: string;
    private readonly input: ResponseInputItem[];
    private tools: ToolDeclaration[];
    private readonly toolSource: () => ToolDeclaration[];
    private readonly effort: OpenAISessionOptions['effort'];
    private readonly cacheKey: string;

    constructor(options: OpenAISessionOptions) {
        this.model = options.model;
        this.effort = options.effort;
        this.toolSource = options.tools;
        this.tools = options.tools();
        // Explicit base URL and no organization/project from the environment: only the key the app was given.
        this.client = new OpenAI({
            apiKey: options.apiKey,
            organization: null,
            project: null,
            baseURL: options.baseURL || process.env.SCRATCHBOX_OPENAI_BASE_URL || OPENAI_API_BASE,
            maxRetries: 2,
            ...(options.fetch ? { fetch: options.fetch } : {})
        });
        this.instructions = options.prompt.stable;
        this.input = options.prompt.messages.map(inputMessage);
        this.cacheKey = `scratchbox-chat-${crypto.createHash('sha256').update(options.prompt.stable).digest('hex').slice(0, 16)}`;
    }

    buildParams(): ResponseCreateParamsStreaming {
        return {
            model: this.model,
            instructions: this.instructions,
            input: this.input,
            ...(this.tools.length > 0 ? { tools: openaiTools(this.tools), parallel_tool_calls: true } : {}),
            reasoning: { effort: this.effort, summary: 'auto' },
            include: ['reasoning.encrypted_content'],
            store: false,
            max_output_tokens: MAX_OUTPUT_TOKENS,
            prompt_cache_key: this.cacheKey,
            stream: true
        } as ResponseCreateParamsStreaming;
    }

    async streamTurn(sink: TurnSink, signal: AbortSignal | undefined): Promise<TurnOutcome> {
        const params = this.buildParams();
        let final: OpenAIResponse;
        try {
            const stream = this.client.responses.stream(params, { signal });
            for await (const event of stream) {
                if (event.type === 'response.output_text.delta') sink.text(event.delta, this.model);
                else if (event.type === 'response.reasoning_summary_text.delta' && event.delta) sink.thought(event.delta, this.model);
            }
            final = await stream.finalResponse();
        } catch (err) {
            if (signal?.aborted) throw err;
            throw describeOpenAIError(err, this.model, this.tools);
        }

        const usage = openaiUsage(final.usage);
        if (final.status === 'failed') {
            throw new ChatProviderError(`OpenAI (${this.model}) failed the request: ${final.error?.message || 'no reason given'}`, 'openai');
        }
        let text = '';
        let refusal = '';
        const calls: Array<{ call_id: string; name: string; arguments: string }> = [];
        for (const item of final.output || []) {
            if (item.type === 'message') {
                for (const part of item.content || []) {
                    if (part.type === 'output_text') text += part.text;
                    else if (part.type === 'refusal') refusal += part.refusal;
                }
            } else if (item.type === 'function_call') {
                calls.push({ call_id: item.call_id, name: item.name, arguments: item.arguments });
            }
        }
        if (refusal) {
            return { text, toolCalls: [], finishReason: 'refusal', usage, stopNotice: `The OpenAI model declined this request: ${refusal}` };
        }
        const incomplete = final.status === 'incomplete' ? final.incomplete_details?.reason || 'incomplete' : undefined;
        if (incomplete && calls.length > 0) {
            return { text, toolCalls: [], finishReason: incomplete === 'max_output_tokens' ? 'MAX_TOKENS' : incomplete, usage, stopNotice: `The OpenAI response ended early (${incomplete}) while writing a call to ${calls[calls.length - 1].name}, so it was not run.` };
        }
        // Every output item goes back as it came (reasoning items with their encrypted content included).
        this.input.push(...(final.output as unknown as ResponseInputItem[]));
        const toolCalls: AgentToolCall[] = calls.map(c => {
            let args: Record<string, unknown> = {};
            let invalid: string | undefined;
            try {
                const parsed = c.arguments ? JSON.parse(c.arguments) : {};
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
                else invalid = c.arguments;
            } catch {
                invalid = c.arguments;
            }
            return { id: c.call_id, name: c.name, args, callModel: this.model, ...(invalid !== undefined ? { meta: { invalidArguments: invalid } } : {}) };
        });
        for (const call of toolCalls) sink.toolCall(call);
        const finishReason = incomplete === 'max_output_tokens' ? 'MAX_TOKENS' : incomplete || (toolCalls.length ? 'function_call' : 'completed');
        return { text, toolCalls, finishReason, usage, servedBy: final.model && !final.model.startsWith(this.model) ? final.model : undefined };
    }

    addToolResults(results: AgentToolResult[]): void {
        for (const r of results) {
            const json = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? null);
            const output: string | ResponseFunctionCallOutputItemList = r.images.length === 0 ? json : [
                { type: 'input_text', text: json },
                ...r.images.flatMap(img => [
                    { type: 'input_text' as const, text: img.label },
                    { type: 'input_image' as const, image_url: dataUrl(img.mimeType, img.data), detail: 'auto' as const }
                ])
            ];
            this.input.push({ type: 'function_call_output', call_id: r.call.id, output } as ResponseInputItem);
        }
    }

    addUserText(text: string): void {
        this.input.push({ role: 'user', content: [{ type: 'input_text', text }] } as ResponseInputItem);
    }

    addAssistantText(text: string): void {
        if (text.trim()) this.input.push({ role: 'assistant', content: text } as ResponseInputItem);
    }

    refreshTools(): void {
        this.tools = this.toolSource();
    }

    describe(): Record<string, unknown> {
        return { provider: this.provider, model: this.model, effort: this.effort, toolCount: this.tools.length, inputItems: this.input.length };
    }
}

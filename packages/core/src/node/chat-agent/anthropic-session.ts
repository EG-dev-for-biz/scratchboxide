/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The chat on Claude: the Messages API with tool use, streamed (@anthropic-ai/sdk).
 * - Adaptive thinking, shown in the chat as summarized thoughts; depth from Settings' thinking budget as `effort`.
 * - Prompt caching: a breakpoint after the tools and the stable system prompt (the same for every request in a mode),
 *   and automatic caching of the growing conversation, so each call of a tool loop reads the earlier calls' prefix.
 * - Each assistant turn's content (thinking blocks with their signatures, tool_use blocks, fallback blocks) is sent
 *   back verbatim, as the API requires for tool use with thinking.
 * - Images (attached by the user, or shown by a tool) go as base64 image blocks; a tool's images sit inside its
 *   tool_result.
 * - Server-side refusal fallbacks on the models that take them, so a declined turn is re-run on the fallback model
 *   in the same call; a refusal that stands ends the turn with a message saying so.
 * - Tool inputs are buffered by the API (no eager_input_streaming), so the API validates them as JSON before they
 *   reach a handler; the chat does not show partial tool inputs, so streaming them would gain nothing.
 */

import Anthropic, { APIError } from '@anthropic-ai/sdk';
import type {
    BetaContentBlockParam,
    BetaImageBlockParam,
    BetaMessage,
    BetaMessageParam,
    BetaTextBlockParam,
    BetaToolResultBlockParam,
    BetaToolUnion,
    MessageCreateParamsStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ToolDeclaration } from '../gemini/tools/types';
import { ChatProviderError, type AgentToolCall, type AgentToolResult, type AgentUsage, type ChatSession, type TurnOutcome, type TurnSink } from './agent-turn';
import type { ChatPrompt, PromptMessage } from './chat-prompt';
import { toolInputSchema } from './tool-schema';

export const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
/** Room for a tool call that carries a whole script or app (streamed, so no HTTP timeout). */
const MAX_OUTPUT_TOKENS = 64_000;
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Models that take server-side refusal fallbacks (`fallbacks: "default"`); Haiku has none. */
function takesServerFallback(model: string): boolean {
    return /^claude-(opus-5|sonnet-5-5|fable-5|mythos-5)/.test(model);
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function imageBlock(mimeType: string, data: string): BetaImageBlockParam {
    const mediaType = (IMAGE_TYPES.has(mimeType) ? mimeType : 'image/png') as ImageMediaType;
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

function messageParam(m: PromptMessage): BetaMessageParam {
    const content: BetaContentBlockParam[] = [
        ...m.images.map(img => imageBlock(img.mimeType, img.data)),
        ...(m.text ? [{ type: 'text', text: m.text } as BetaTextBlockParam] : [])
    ];
    return { role: m.role, content };
}

export function anthropicTools(declarations: ToolDeclaration[]): BetaToolUnion[] {
    return declarations.map(d => ({ name: d.name, description: d.description || d.name, input_schema: toolInputSchema(d) }) as BetaToolUnion);
}

/** Claude's usage in the usageMetadata shape the chat's token meter reads. */
export function anthropicUsage(usage: BetaMessage['usage'] | undefined): AgentUsage | undefined {
    if (!usage) return undefined;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const prompt = (usage.input_tokens ?? 0) + cacheRead + cacheWrite;
    return {
        promptTokenCount: prompt,
        candidatesTokenCount: usage.output_tokens ?? 0,
        totalTokenCount: prompt + (usage.output_tokens ?? 0),
        cachedContentTokenCount: cacheRead,
        cacheCreationInputTokens: cacheWrite
    };
}

/** What to tell the user for a failed Claude request; names the tool when Claude refused a tool's schema. */
export function describeAnthropicError(err: unknown, model: string, tools: ToolDeclaration[]): ChatProviderError {
    if (err instanceof APIError) {
        const body = err.error as { error?: { message?: string } } | undefined;
        const detail = body?.error?.message || err.message;
        const toolIndex = /tools\.(\d+)/.exec(detail || '')?.[1];
        const rejectedTool = toolIndex !== undefined ? tools[Number(toolIndex)]?.name : undefined;
        if (rejectedTool) {
            return new ChatProviderError(`Claude (${model}) refused the schema of the tool ${rejectedTool}, so the request was not run: ${detail}`, 'anthropic', err.status, rejectedTool);
        }
        if (err.status === 401) return new ChatProviderError(`Anthropic rejected the API key (401): ${detail}. Check the key in Settings > Models & AI.`, 'anthropic', 401);
        if (err.status === 404) return new ChatProviderError(`Anthropic does not serve the model ${model} to this key (404): ${detail}`, 'anthropic', 404);
        return new ChatProviderError(`Claude request failed (${err.status ?? 'no status'}): ${detail}`, 'anthropic', err.status);
    }
    return new ChatProviderError(`Claude request failed: ${err instanceof Error ? err.message : String(err)}`, 'anthropic');
}

export interface AnthropicSessionOptions {
    apiKey: string;
    model: string;
    prompt: ChatPrompt;
    /** The tools to offer, read again when load_tools adds some (refreshTools). */
    tools: () => ToolDeclaration[];
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Test hook: the fetch the SDK uses (recorded streams). */
    fetch?: typeof fetch;
    baseURL?: string;
}

export class AnthropicChatSession implements ChatSession {
    readonly provider = 'anthropic' as const;
    readonly model: string;
    private readonly client: Anthropic;
    private readonly system: BetaTextBlockParam[];
    private readonly messages: BetaMessageParam[];
    private tools: ToolDeclaration[];
    private readonly toolSource: () => ToolDeclaration[];
    private readonly effort: AnthropicSessionOptions['effort'];

    constructor(options: AnthropicSessionOptions) {
        this.model = options.model;
        this.effort = options.effort;
        this.toolSource = options.tools;
        this.tools = options.tools();
        // The base URL is set explicitly: ANTHROPIC_BASE_URL in the environment belongs to whatever launched the app.
        this.client = new Anthropic({
            apiKey: options.apiKey,
            authToken: null,
            baseURL: options.baseURL || process.env.SCRATCHBOX_ANTHROPIC_BASE_URL || ANTHROPIC_API_BASE,
            maxRetries: 2,
            ...(options.fetch ? { fetch: options.fetch } : {})
        });
        // The request's context is already in the last user message (chat-prompt.ts): the system prompt is the stable part.
        this.system = [{ type: 'text', text: options.prompt.stable, cache_control: { type: 'ephemeral' } }];
        this.messages = options.prompt.messages.map(messageParam);
        // The conversation must open with a user message.
        if (this.messages[0]?.role === 'assistant') this.messages.unshift({ role: 'user', content: '(The conversation so far.)' });
    }

    /** The request body of the next call (exposed for tests and the request-shape log). */
    buildParams(): MessageCreateParamsStreaming {
        const fallback = takesServerFallback(this.model);
        return {
            model: this.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            stream: true,
            system: this.system,
            messages: this.messages,
            ...(this.tools.length > 0 ? { tools: anthropicTools(this.tools) } : {}),
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: this.effort },
            // Caches the conversation up to its last block, so the next call of the tool loop reads it.
            cache_control: { type: 'ephemeral' },
            ...(fallback ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const } : {})
        };
    }

    async streamTurn(sink: TurnSink, signal: AbortSignal | undefined): Promise<TurnOutcome> {
        const params = this.buildParams();
        let final: BetaMessage;
        try {
            const stream = this.client.beta.messages.stream(params, { signal });
            for await (const event of stream) {
                if (event.type === 'content_block_delta') {
                    if (event.delta.type === 'text_delta') sink.text(event.delta.text, this.model);
                    else if (event.delta.type === 'thinking_delta' && event.delta.thinking) sink.thought(event.delta.thinking, this.model);
                }
            }
            final = await stream.finalMessage();
        } catch (err) {
            if (signal?.aborted) throw err;
            throw describeAnthropicError(err, this.model, this.tools);
        }

        const text = final.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
        const usage = anthropicUsage(final.usage);
        const servedBy = final.model && final.model !== this.model ? final.model : undefined;
        if (final.stop_reason === 'refusal') {
            const details = final.stop_details as { category?: string | null; explanation?: string | null } | null;
            const category = details?.category ? ` (category: ${details.category})` : '';
            const why = details?.explanation ? `: ${details.explanation}` : '.';
            return { text, toolCalls: [], finishReason: 'refusal', usage, servedBy, stopNotice: `Claude declined this request${category}${why}` };
        }
        const toolUses = final.content.filter(b => b.type === 'tool_use') as Array<{ id: string; name: string; input: unknown }>;
        if (final.stop_reason === 'max_tokens' && toolUses.length > 0) {
            // A tool input cut off at the output limit can still parse; it is not run.
            return { text, toolCalls: [], finishReason: 'MAX_TOKENS', usage, servedBy, stopNotice: `Claude ran out of output space (${MAX_OUTPUT_TOKENS} tokens) while writing a call to ${toolUses[toolUses.length - 1].name}, so it was not run. Try a smaller step.` };
        }
        // The assistant turn as the API returned it: thinking and fallback blocks must be sent back unchanged.
        this.messages.push({ role: 'assistant', content: final.content as unknown as BetaContentBlockParam[] });
        const toolCalls: AgentToolCall[] = toolUses.map(b => ({
            id: b.id,
            name: b.name,
            args: b.input && typeof b.input === 'object' ? b.input as Record<string, unknown> : {},
            callModel: this.model
        }));
        for (const call of toolCalls) sink.toolCall(call);
        return { text, toolCalls, finishReason: final.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : final.stop_reason || undefined, usage, servedBy };
    }

    addToolResults(results: AgentToolResult[]): void {
        // Every result of the turn in one user message (splitting them teaches the model to stop calling in parallel).
        const content: BetaToolResultBlockParam[] = results.map(r => ({
            type: 'tool_result',
            tool_use_id: r.call.id,
            ...(r.isError ? { is_error: true } : {}),
            content: [
                { type: 'text', text: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? null) },
                ...r.images.flatMap(img => [{ type: 'text', text: img.label } as BetaTextBlockParam, imageBlock(img.mimeType, img.data)])
            ]
        }));
        this.messages.push({ role: 'user', content });
    }

    addUserText(text: string): void {
        this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    }

    addAssistantText(text: string): void {
        if (text.trim()) this.messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
    }

    refreshTools(): void {
        this.tools = this.toolSource();
    }

    describe(): Record<string, unknown> {
        return { provider: this.provider, model: this.model, effort: this.effort, toolCount: this.tools.length, messages: this.messages.length };
    }
}

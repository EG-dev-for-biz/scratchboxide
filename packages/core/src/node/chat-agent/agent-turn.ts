/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What the chat's agent loop (gemini/streaming.ts) speaks with whichever provider answers the turn. The loop runs
 * tools, shows cards, verifies and builds artifacts; a ChatSession only makes model calls. Each session keeps its own
 * provider-native transcript (Gemini contents with thought signatures, Claude content blocks with thinking blocks,
 * OpenAI input items with encrypted reasoning), so what a provider needs replayed is replayed verbatim.
 */

import type { ChatProviderId } from '../../common/chat-models';
import type { GroundingMetadata } from '../../common/gemini-protocol';

/** One tool call a model made. */
export interface AgentToolCall {
    /** The provider's call id (Claude tool_use id, OpenAI call_id); Gemini may give none. */
    id: string;
    name: string;
    args: Record<string, unknown>;
    /** The model that wrote the call (the Gemini router may write the first one). */
    callModel?: string;
    /** Provider-private data the session needs to replay the call (a Gemini thought signature). */
    meta?: Record<string, unknown>;
}

/** An image a tool shows the model (base64, already scaled by model-image.ts). */
export interface AgentImage {
    mimeType: string;
    data: string;
    /** Said to the model just before the image. */
    label: string;
}

/** A tool call's result, as the model receives it. */
export interface AgentToolResult {
    call: AgentToolCall;
    /** The JSON the model reads (toolResultForModel's output). */
    content: unknown;
    isError: boolean;
    images: AgentImage[];
}

/** Usage in the Gemini usageMetadata shape the chat's token meter reads, whatever the provider. */
export interface AgentUsage {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    [key: string]: unknown;
}

/** Where a turn's stream goes while it runs. */
export interface TurnSink {
    text(delta: string, model: string): void;
    thought(delta: string, model: string): void;
    /** A complete tool call; the loop may start it at once (Gemini) or the session emits them when the turn ends. */
    toolCall(call: AgentToolCall): void;
    grounding?(metadata: GroundingMetadata, model: string): void;
    status?(text: string, model: string): void;
}

export interface TurnOutcome {
    /** The turn's reply text. */
    text: string;
    toolCalls: AgentToolCall[];
    /** The provider's stop reason, in the provider's words (STOP, end_turn, tool_use, MAX_TOKENS, ...). */
    finishReason?: string;
    usage?: AgentUsage;
    /**
     * Set when the turn must end here with this message to the user: the model declined (a refusal), or a tool call
     * was cut off at the output limit and cannot be run.
     */
    stopNotice?: string;
    /** The model that actually served the turn when the provider moved to another (a server-side fallback). */
    servedBy?: string;
    /** Set when another model took part in the turn's first call (the Gemini fast router): who decided, and why. */
    routing?: string;
}

export interface ChatSession {
    readonly provider: ChatProviderId;
    readonly model: string;
    /**
     * One model call. Text, thoughts and tool calls go to `sink` as they arrive; the assistant turn (with whatever
     * the provider needs replayed) is added to the session's transcript before it resolves.
     */
    streamTurn(sink: TurnSink, signal: AbortSignal | undefined, turn: number): Promise<TurnOutcome>;
    /** The results of the last turn's tool calls, in the order the calls were made. */
    addToolResults(results: AgentToolResult[]): void;
    /** A user message the app adds (automated verification feedback). */
    addUserText(text: string): void;
    /** An assistant message the app adds (the turn's text when the provider's own turn came back empty). */
    addAssistantText(text: string): void;
    /** Re-reads the tools to offer from the next call on (load_tools adds some during a request). */
    refreshTools(): void;
    /** A tool of the current turn has started (the Gemini [chat-turn] timings count it). */
    onToolStarted?(): void;
    /** Shape of the request (tests, logs). */
    describe?(): Record<string, unknown>;
}

/** A provider request that failed: the status and the provider's own message, plus what to tell the user. */
export class ChatProviderError extends Error {
    constructor(
        message: string,
        readonly provider: ChatProviderId,
        readonly status?: number,
        /** Set when the provider rejected a tool's schema: that tool's name. */
        readonly rejectedTool?: string
    ) {
        super(message);
        this.name = 'ChatProviderError';
    }
}

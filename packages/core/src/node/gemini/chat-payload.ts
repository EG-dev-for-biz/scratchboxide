/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import type { Content } from '@google/genai';
import type { GeminiGenerateRequest } from '../../common/gemini-protocol';
import type { GeminiThinkingConfig } from './thinking-config';
import type { GeminiToolConfig } from './tool-registry';
import type { ChatTurnShape } from './chat-turn-telemetry';
import { buildContents, buildSystemInstructionParts, type PromptContextServices } from './prompt-builder';
import { openArtifactUpdateRule } from './artifact-synthesis';
import { geminiMajorVersion } from './thinking-config';

/** The streamGenerateContent body of a chat call. */
export interface VertexStreamPayload {
    contents: Content[];
    /** Absent when `cachedContent` holds it. */
    systemInstruction?: Content;
    generationConfig: {
        temperature: number;
        maxOutputTokens: number;
        thinkingConfig: GeminiThinkingConfig;
    };
    /** Absent when `cachedContent` holds them. */
    tools?: GeminiToolConfig[];
    /** An explicit context cache (projects/.../cachedContents/...) holding the system instruction and tools. */
    cachedContent?: string;
}

/**
 * Where the per-request context goes for the chat model. By default at the end of the system instruction, after
 * the stable sections: measured 2026-10-20 on gemini-4-argon with a 5.8k-character workspace context, the routing
 * call at LOW took a median 4.9 s there against 5.9 s with the context in the request (and 7.3 s against 9.7 s at
 * MEDIUM), and gemini-4-argon gains nothing from a byte-identical system instruction (it refuses explicit caches and
 * its implicit cache hit about one call in six). SCRATCHBOX_CHAT_STABLE_PREFIX=1 sends the context with the request
 * instead. A call that reads the prefix from an explicit cache (a router model, context-cache.ts) always uses the
 * cacheable layout (`cacheable`), whatever this says.
 */
export function stablePrefixEnabled(): boolean {
    return process.env.SCRATCHBOX_CHAT_STABLE_PREFIX === '1';
}

/** The heading of the per-request context block sent with the request (see SystemInstructionParts). */
export const TURN_CONTEXT_HEADING = '[Context for this request from the workspace and canvas (not written by the user); the system instruction applies to it]';

/**
 * Adds this request's context to the request itself (the last user message), as a part ahead of the user's words,
 * so everything before it (system instruction, tools, earlier messages) is a prefix the prompt cache can reuse.
 */
export function withTurnContext(contents: Content[], turnContext: string): Content[] {
    if (!turnContext.trim() || contents.length === 0) return contents;
    const last = contents[contents.length - 1];
    const parts = [{ text: `${TURN_CONTEXT_HEADING}\n${turnContext.trim()}` }, ...(last.parts || [])];
    return [...contents.slice(0, -1), { ...last, parts }];
}

/** The tools a model takes: Gemini 3+ accepts googleSearch with function declarations, earlier models do not. */
export function toolsForModel(tools: GeminiToolConfig[] | undefined, model: string, requireGoogleSearch?: boolean): GeminiToolConfig[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    const hasFunctionDeclarations = tools.some(t => 'functionDeclarations' in t && Array.isArray(t.functionDeclarations) && t.functionDeclarations.length > 0);
    if (hasFunctionDeclarations && geminiMajorVersion(model) < 3) {
        if (requireGoogleSearch) {
            throw new Error(`@web needs Google Search grounding, but ${model} cannot take the search tool together with function tools; choose a Gemini 3 model or remove @web`);
        }
        return tools.filter(t => 'functionDeclarations' in t);
    }
    return tools;
}

export function functionDeclarationCount(tools: GeminiToolConfig[] | undefined): number {
    return (tools || []).reduce((n, t) => n + ('functionDeclarations' in t && Array.isArray(t.functionDeclarations) ? t.functionDeclarations.length : 0), 0);
}

export interface BuiltChatPayload {
    payload: VertexStreamPayload;
    /** The same call with the system instruction holding only the stable sections (for an explicit context cache). */
    cacheable: VertexStreamPayload;
    /** The stable system instruction (the cacheable prefix with the tools). */
    stableSystem: string;
    /** This request's context, sent in the contents. */
    turnContext: string;
    shape: Omit<ChatTurnShape, 'contentsBytes'>;
}

/**
 * The first call's body for a chat request: the stable system instruction, then the tools, then the contents with
 * this request's context (open-artifact rule, attached skills, matched symbols, diagnostics, ...) in the last user
 * message. Built the same way for every model that answers the turn.
 */
export async function buildChatPayload(
    request: GeminiGenerateRequest,
    services: Partial<PromptContextServices>,
    tools: GeminiToolConfig[] | undefined,
    model: string,
    thinkingConfig: GeminiThinkingConfig
): Promise<BuiltChatPayload> {
    const { stable, turnContext: promptContext } = await buildSystemInstructionParts(request, services);
    // While an artifact is open, the model is told how to continue it or start a new one (the reply's tag or
    // envelope is read that way by artifact synthesis).
    const rule = openArtifactUpdateRule(request.activeArtifact);
    const turnContext = [promptContext, rule].filter(Boolean).join('\n\n');
    const modelTools = toolsForModel(tools, model, request.requireGoogleSearch);
    const split = stablePrefixEnabled();
    const systemText = split ? stable : [stable, turnContext].filter(Boolean).join('\n\n');
    const payload: VertexStreamPayload = {
        contents: split ? withTurnContext(buildContents(request), turnContext) : buildContents(request),
        systemInstruction: { role: 'system', parts: [{ text: systemText }] },
        generationConfig: {
            temperature: request.temperature !== undefined ? request.temperature : 0.7,
            // Tool calls that carry a whole generated app run ~5k tokens; at 8192 they were cut off (MAX_TOKENS).
            maxOutputTokens: 32768,
            thinkingConfig
        }
    };
    if (modelTools) payload.tools = modelTools;
    const cacheable: VertexStreamPayload = split ? payload : {
        ...payload,
        contents: withTurnContext(buildContents(request), turnContext),
        systemInstruction: { role: 'system', parts: [{ text: stable }] }
    };
    return {
        payload,
        cacheable,
        stableSystem: stable,
        turnContext,
        shape: {
            systemChars: systemText.length,
            staticSystemChars: split ? stable.length : 0,
            turnContextChars: split ? turnContext.length : 0,
            toolCount: functionDeclarationCount(modelTools),
            toolBytes: modelTools ? JSON.stringify(modelTools).length : 0
        }
    };
}

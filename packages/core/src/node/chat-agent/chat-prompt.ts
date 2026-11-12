/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The system prompt and opening messages of a chat request, provider-neutral: the same text every provider is given
 * (prompt-builder.ts), split into the stable part (cacheable with the tools) and this request's context.
 */

import type { Content } from '@google/genai';
import type { GeminiGenerateRequest } from '../../common/gemini-protocol';
import { buildContents, buildSystemInstructionParts, type PromptContextServices } from '../gemini/prompt-builder';
import { openArtifactUpdateRule } from '../gemini/artifact-synthesis';
import { TURN_CONTEXT_HEADING } from '../gemini/chat-payload';

export interface PromptImage {
    mimeType: string;
    data: string;
}

export interface PromptMessage {
    role: 'user' | 'assistant';
    text: string;
    images: PromptImage[];
}

export interface ChatPrompt {
    /** The system prompt's stable sections (the same for every request in a mode): cacheable with the tools. */
    stable: string;
    /** This request's context (workspace, canvas, attached skills, open-artifact rule). */
    turnContext: string;
    /**
     * The conversation, its last user message opening with this request's context under TURN_CONTEXT_HEADING (as
     * Gemini's stable-prefix layout sends it: chat-payload.ts). The context holds workspace text, so it goes in a
     * user message marked as not written by the user, never in an operator (system / developer) message; and the
     * system prompt, tools and earlier messages stay a prefix the provider's prompt cache can reuse.
     */
    messages: PromptMessage[];
}

/** Gemini contents (text and inline-image parts, as buildContents writes them) as provider-neutral messages. */
export function promptMessagesFromContents(contents: Content[]): PromptMessage[] {
    return contents.map(c => ({
        role: c.role === 'model' ? 'assistant' as const : 'user' as const,
        text: (c.parts || []).map(p => p.text || '').filter(Boolean).join('\n'),
        images: (c.parts || [])
            .filter(p => p.inlineData?.data)
            .map(p => ({ mimeType: p.inlineData!.mimeType || 'image/png', data: p.inlineData!.data! }))
    })).filter(m => m.text || m.images.length > 0);
}

export async function buildChatPrompt(request: GeminiGenerateRequest, services: Partial<PromptContextServices>): Promise<ChatPrompt> {
    const { stable, turnContext: promptContext } = await buildSystemInstructionParts(request, services);
    const rule = openArtifactUpdateRule(request.activeArtifact);
    const turnContext = [promptContext, rule].filter(Boolean).join('\n\n');
    return { stable, turnContext, messages: withTurnContextMessage(promptMessagesFromContents(buildContents(request)), turnContext) };
}

/** `messages` with the last user message opening with `turnContext` (unchanged when there is none). */
export function withTurnContextMessage(messages: PromptMessage[], turnContext: string): PromptMessage[] {
    if (!turnContext.trim()) return messages;
    let last = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { last = i; break; }
    }
    if (last < 0) return [...messages, { role: 'user', text: `${TURN_CONTEXT_HEADING}\n${turnContext.trim()}`, images: [] }];
    return messages.map((m, i) => i === last ? { ...m, text: `${TURN_CONTEXT_HEADING}\n${turnContext.trim()}\n\n${m.text}` } : m);
}

/**
 * The reasoning depth for a thinking budget from Settings (the same thresholds Gemini 4's levels use:
 * thinking-config.ts), as the effort words Claude and OpenAI take. Agentic tool loops gain from depth, so the
 * default budget (1,024) maps to 'high'.
 */
export function effortForThinkingBudget(budget: number | undefined): 'low' | 'medium' | 'high' | 'xhigh' {
    const b = budget ?? 1024;
    if (b < 1024) return 'medium';
    if (b < 2048) return 'high';
    return 'xhigh';
}

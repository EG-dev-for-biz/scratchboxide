/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The thinking configuration a Gemini model takes for a token budget. Gemini 4 and later take a thinking level, and
 * the budget is mapped onto one (under 1,024 tokens LOW, under 2,048 MEDIUM, else HIGH); earlier models take the
 * budget itself. One function, so the chat (GeminiClient.getThinkingConfig) and the vision calls that pick a model at
 * call time (vision-model-chain: a fallback can change the model family) map it the same way.
 */

export type GeminiThinkingConfig = { thinkingBudget: number } | { thinkingLevel: 'LOW' | 'MEDIUM' | 'HIGH' };

/** The major version in a Gemini model id ("gemini-4-argon" -> 4, "gemini-3.8-flash" -> 3); 0 when it names none. */
export function geminiMajorVersion(model: string | undefined): number {
    return Number(/^gemini-(\d+)/.exec(model ?? '')?.[1] ?? 0);
}

/** The thinking config `model` takes for `budget` thinking tokens. */
export function thinkingConfigFor(model: string | undefined, budget: number): GeminiThinkingConfig {
    if (geminiMajorVersion(model) >= 4) {
        return { thinkingLevel: budget < 1024 ? 'LOW' : budget < 2048 ? 'MEDIUM' : 'HIGH' };
    }
    return { thinkingBudget: budget };
}

/** As a VisionModelUse records it: { level } for a level, { budget } for a token budget. */
export function describeThinking(config: GeminiThinkingConfig): { level: 'LOW' | 'MEDIUM' | 'HIGH' } | { budget: number } {
    return 'thinkingLevel' in config ? { level: config.thinkingLevel } : { budget: config.thinkingBudget };
}

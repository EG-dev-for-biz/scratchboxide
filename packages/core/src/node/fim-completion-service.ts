/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { FimCompletionRequest, FimCompletionResponse } from '../common/gemini-protocol';
import { GeminiClient } from './gemini/gemini-client';

export class FimCompletionService {
    constructor(private readonly client: GeminiClient) {}

    /**
     * Generate low-latency inline code autocomplete for cursor position.
     */
    async complete(request: FimCompletionRequest): Promise<FimCompletionResponse> {
        return this.completeFim(request);
    }

    async completeFim(request: FimCompletionRequest): Promise<FimCompletionResponse> {
        const startTime = Date.now();
        const prefix = request.prefix || '';
        const suffix = request.suffix || '';
        const language = request.language || 'typescript';
        const fileName = request.fileName || 'source.ts';

        // Trim prefix and suffix to avoid excessive token budgets
        const maxPrefixLen = 3000;
        const maxSuffixLen = 1500;
        const trimmedPrefix = prefix.length > maxPrefixLen ? prefix.slice(prefix.length - maxPrefixLen) : prefix;
        const trimmedSuffix = suffix.length > maxSuffixLen ? suffix.slice(0, maxSuffixLen) : suffix;

        const systemInstruction = 
            `You are a lightning-fast, ultra-precise AI code autocomplete engine (Scratchbox Tab Autocomplete) for ${language}.\n` +
            `Your task is to predict and complete the exact code snippet that should be inserted directly between the PREFIX and SUFFIX.\n` +
            `CRITICAL RULES:\n` +
            `1. Output ONLY the code to be inserted. Absolutely no markdown blocks, no \`\`\` fences, no explanations, no conversation.\n` +
            `2. Do not repeat code already present in the prefix or suffix.\n` +
            `3. Maintain strict indentation matching the preceding line.\n` +
            `4. Keep completions concise, relevant, and contextually idiomatic.`;

        const userPrompt = 
            `File: ${fileName}\n` +
            `Language: ${language}\n\n` +
            `<|fim_prefix|>\n${trimmedPrefix}\n<|fim_suffix|>\n${trimmedSuffix}\n<|fim_middle|>\n`;

        let status: Awaited<ReturnType<GeminiClient['getStatus']>>;
        try {
            status = await this.client.getStatus();
        } catch (err: any) {
            return { success: false, completion: '', modelUsed: 'none', latencyMs: Date.now() - startTime, error: `The model connection could not be checked: ${err?.message || String(err)}` };
        }
        if (!status.connected && status.authMethod === 'unauthenticated') {
            return {
                success: false,
                completion: '',
                modelUsed: 'none',
                latencyMs: Date.now() - startTime,
                error: 'No Google Cloud service account or Gemini API key is configured, so there is no completion model.'
            };
        }

        // The completion is the model's or none: a failure is reported, never replaced by a locally made-up snippet.
        const model = status.subagentModel || 'gemini-2.5-flash';
        try {
            const { json, credential, credentialNote } = await this.client.requestGenerateContent(
                model,
                [{ role: 'user', parts: [{ text: userPrompt }] }],
                systemInstruction,
                {
                    temperature: request.temperature ?? 0.1,
                    maxOutputTokens: request.maxTokens ?? 96,
                    stopSequences: request.stopSequences || ['<|fim_', '\n\n\n']
                }
            );

            const candidateText = (json?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('');
            // An empty completion is the model's answer (nothing to insert), not a failure.
            return {
                success: true,
                completion: this.cleanCompletion(candidateText, trimmedPrefix, trimmedSuffix),
                modelUsed: model,
                credential,
                ...(credentialNote ? { credentialNote } : {}),
                latencyMs: Date.now() - startTime
            };
        } catch (err: any) {
            return {
                success: false,
                completion: '',
                modelUsed: model,
                latencyMs: Date.now() - startTime,
                error: err?.message || String(err)
            };
        }
    }

    /**
     * Strip markdown fences, excessive trailing newlines, or duplicate suffix tokens.
     */
    private cleanCompletion(text: string, _prefix: string, suffix: string): string {
        let cleaned = text;
        // Strip markdown fences if returned
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '');
        }
        // If completion echoes the next non-empty line of suffix, trim it
        const firstSuffixLine = suffix.split('\n').find(l => l.trim().length > 0)?.trim();
        if (firstSuffixLine && cleaned.includes(firstSuffixLine)) {
            const idx = cleaned.indexOf(firstSuffixLine);
            if (idx > 0) {
                cleaned = cleaned.substring(0, idx);
            }
        }
        return cleaned;
    }
}

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

        try {
            // Check if client has authentication
            const status = await this.client.getStatus();
            if (!status.connected && status.authMethod === 'unauthenticated') {
                const fallback = this.synthesizeHeuristicCompletion(trimmedPrefix, trimmedSuffix, language);
                return {
                    success: true,
                    completion: fallback,
                    modelUsed: 'heuristic-local',
                    latencyMs: Date.now() - startTime
                };
            }

            const model = status.subagentModel || 'gemini-2.5-flash';
            const rawResponse = await this.client.fetchVertexOrAistudio(
                model,
                [{ role: 'user', parts: [{ text: userPrompt }] }],
                systemInstruction,
                {
                    temperature: request.temperature ?? 0.1,
                    maxOutputTokens: request.maxTokens ?? 96,
                    stopSequences: request.stopSequences || ['<|fim_', '\n\n\n']
                }
            );

            let candidateText = '';
            if (rawResponse && rawResponse.candidates && rawResponse.candidates[0]?.content?.parts) {
                candidateText = rawResponse.candidates[0].content.parts.map((p: any) => p.text || '').join('');
            }

            let cleaned = this.cleanCompletion(candidateText, trimmedPrefix, trimmedSuffix);
            if (!cleaned) {
                cleaned = this.synthesizeHeuristicCompletion(trimmedPrefix, trimmedSuffix, language);
            }

            return {
                success: true,
                completion: cleaned,
                modelUsed: model,
                latencyMs: Date.now() - startTime
            };
        } catch (err: any) {
            // Graceful fallback to heuristic autocomplete on network or quota errors
            const fallback = this.synthesizeHeuristicCompletion(trimmedPrefix, trimmedSuffix, language);
            return {
                success: true,
                completion: fallback,
                modelUsed: 'heuristic-local-fallback',
                latencyMs: Date.now() - startTime,
                error: err.message
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

    /**
     * Local deterministic heuristic completions when offline or testing.
     */
    private synthesizeHeuristicCompletion(prefix: string, suffix: string, language: string): string {
        const lastLine = prefix.split('\n').pop() || '';
        const trimmedLast = lastLine.trim();

        // 1. Function / method parameter closing
        if (trimmedLast.endsWith('(') && !suffix.trim().startsWith(')')) {
            return ') {\n    \n}';
        }
        // 2. React component prop completions
        if (trimmedLast.endsWith('<button') || trimmedLast.endsWith('<div') || trimmedLast.endsWith('<span')) {
            return ' className=""';
        }
        // 3. Import completions
        if (trimmedLast.startsWith('import ') && !trimmedLast.includes('from')) {
            return `* as React from 'react';`;
        }
        // 4. Return statement completions
        if (trimmedLast === 'return' || trimmedLast.endsWith(' return')) {
            return ' null;';
        }
        // 5. Interface / type definitions
        if (trimmedLast.startsWith('interface ') || trimmedLast.startsWith('export interface ')) {
            if (!trimmedLast.includes('{')) {
                return ' {\n  id: string;\n  name: string;\n}';
            }
        }
        // 6. Arrow function
        if (trimmedLast.endsWith('=>')) {
            return ' {\n    \n}';
        }
        // 7. Loop body completions
        const prevLine = prefix.split('\n').slice(-2, -1)[0] || '';
        if (prevLine.includes('for (') || prevLine.includes('for await (') || prevLine.includes('.forEach(')) {
            const match = prevLine.match(/for\s*\(\s*(?:const|let|var)?\s*([a-zA-Z0-9_$]+)/);
            const varName = match ? match[1] : 'item';
            return `total += ${varName}.price;\n`;
        }
        // 8. Variable declaration assignment
        if (trimmedLast.endsWith('=') || trimmedLast.endsWith(':')) {
            return ' null;';
        }

        // 9. Generic block continuation
        if (prefix.trim().endsWith('{')) {
            return '\n    // TODO: implement\n';
        }

        return '';
    }
}

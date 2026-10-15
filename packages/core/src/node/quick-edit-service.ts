/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { QuickEditRequest, QuickEditResponse } from '../common/gemini-protocol';
import { GeminiClient } from './gemini/gemini-client';
import { computeLineDiff } from '../browser/generative-canvas/multi-file-diff-engine';

/** Output tokens for a whole-file quick edit: room for the rewritten file twice over, within 8k..64k. */
export function quickEditOutputBudget(originalCode: string): number {
    return Math.min(65536, Math.max(8192, Math.ceil(originalCode.length / 4) * 2 + 4096));
}

export class QuickEditService {
    constructor(private readonly client: GeminiClient) {}

    /**
     * Transform code based on user prompt (Scratchbox ⌘K Inline Refactor).
     */
    async quickEdit(request: QuickEditRequest): Promise<QuickEditResponse> {
        return this.executeQuickEdit(request);
    }

    async executeQuickEdit(request: QuickEditRequest): Promise<QuickEditResponse> {
        const originalCode = request.originalCode || '';
        const instruction = request.instruction?.trim() || '';
        const language = request.language || 'typescript';
        const fileName = request.fileName || 'source.ts';

        if (!instruction) {
            return {
                success: true,
                proposedCode: originalCode,
                additions: 0,
                deletions: 0,
                diffSummary: 'No changes (empty instruction)'
            };
        }

        const systemInstruction = 
            `You are an expert software engineer and code transformation engine (Scratchbox ⌘K Studio Inline Refactor) for ${language}.\n` +
            `Your task is to rewrite, refactor, or edit the provided code according to the user's instruction.\n` +
            `CRITICAL RULES:\n` +
            `1. Output ONLY the resulting modified code. Do NOT wrap your output in markdown code fences (\`\`\`).\n` +
            `2. Do NOT output conversational prose, explanations, or warnings.\n` +
            `3. Maintain the original code's style, indentation, and structure except where the instruction asks for changes.\n` +
            `4. Preserve all unaffected functionality, imports, and exports.`;

        const userPrompt = 
            `File: ${fileName}\n` +
            `Language: ${language}\n` +
            (request.selection ? `Target Selection Lines: ${request.selection.startLine}-${request.selection.endLine}\n` : '') +
            `Instruction: ${instruction}\n\n` +
            `Current Code:\n${originalCode}\n`;

        let status: Awaited<ReturnType<GeminiClient['getStatus']>>;
        try {
            status = await this.client.getStatus();
        } catch (err: any) {
            return { success: false, proposedCode: originalCode, additions: 0, deletions: 0, error: `The model connection could not be checked: ${err?.message || String(err)}` };
        }
        if (!status.connected && status.authMethod === 'unauthenticated') {
            return {
                success: false,
                proposedCode: originalCode,
                additions: 0,
                deletions: 0,
                error: 'No Google Cloud service account or Gemini API key is configured, so no model can make this edit.'
            };
        }

        // The edit is the model's or nothing: a failure is reported, never replaced by a locally made-up edit.
        const model = status.activeModel || 'gemini-3.8-flash';
        try {
            const { json, credential, credentialNote } = await this.client.requestGenerateContent(
                model,
                [{ role: 'user', parts: [{ text: userPrompt }] }],
                systemInstruction,
                {
                    temperature: 0.2,
                    // The reply is the whole file, so the budget scales with it (about 4 characters a token, doubled
                    // for the edit and any thinking) up to the models' output limit.
                    maxOutputTokens: quickEditOutputBudget(originalCode)
                }
            );
            const answeredWith = { modelUsed: model, credential, ...(credentialNote ? { credentialNote } : {}) };

            // A reply the model did not finish (cut off at the token limit, blocked, ...) is not an edit: written into
            // the file it would replace the rest of the file with nothing.
            const finishReason = json?.candidates?.[0]?.finishReason;
            if (finishReason && finishReason !== 'STOP') {
                const why = finishReason === 'MAX_TOKENS'
                    ? `${model} stopped at its output limit before finishing ${fileName}`
                    : `${model} stopped before finishing the edit (finish reason: ${finishReason})`;
                return { success: false, proposedCode: originalCode, additions: 0, deletions: 0, error: `${why}, so the file was not changed.`, ...answeredWith };
            }

            const candidateText = (json?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('');
            const proposedCode = this.cleanGeneratedCode(candidateText);
            if (!proposedCode.trim()) {
                return { success: false, proposedCode: originalCode, additions: 0, deletions: 0, error: `${model} returned no code for this edit.`, ...answeredWith };
            }

            const diff = computeLineDiff(originalCode, proposedCode);
            return {
                success: true,
                proposedCode,
                additions: diff.additions,
                deletions: diff.deletions,
                diffSummary: `Modified ${fileName}: +${diff.additions}/-${diff.deletions} lines`,
                ...answeredWith
            };
        } catch (err: any) {
            return {
                success: false,
                proposedCode: originalCode,
                additions: 0,
                deletions: 0,
                modelUsed: model,
                error: `The edit failed: ${err?.message || String(err)}`
            };
        }
    }

    private cleanGeneratedCode(text: string): string {
        let cleaned = text.trim();
        // Remove markdown backticks if present
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '');
        }
        return cleaned;
    }
}

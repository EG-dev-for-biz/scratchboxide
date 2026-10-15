/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    computeLineDiff,
    extractHunksFromDiffLines,
    applySelectedHunks
} from '../src/browser/generative-canvas/multi-file-diff-engine';
import { FimCompletionService } from '../src/node/fim-completion-service';
import { QuickEditService } from '../src/node/quick-edit-service';
import { ProjectContextGraphService } from '../src/node/project-context-graph-service';

describe('Advanced LLM Capabilities (Cursor / Antigravity / Claude Parity)', () => {

    describe('Track 1: Fill-In-The-Middle (FIM) Completion Engine', () => {
        const prefix = 'function calculateTotal(items: CartItem[]) {\n    let total = 0;\n    for (const item of items) {\n        ';
        const suffix = '\n    }\n    return total;\n}';

        it('without model credentials there is no completion and the reason is given (no made-up snippet)', async () => {
            const offline = { getStatus: async () => ({ connected: false, authMethod: 'unauthenticated' }) } as any;
            const result = await new FimCompletionService(offline).completeFim({ prefix, suffix, language: 'typescript', fileName: 'cart.ts' });
            expect(result.success).toBe(false);
            expect(result.completion).toBe('');
            expect(result.error).toContain('No Google Cloud service account or Gemini API key');
        });

        it('returns the model\'s completion and which credential answered; a failed request is a failure', async () => {
            const calls: string[] = [];
            const client = {
                getStatus: async () => ({ connected: true, authMethod: 'api-key', subagentModel: 'gemini-3.1-flash-lite' }),
                requestGenerateContent: async (model: string) => {
                    calls.push(model);
                    return { json: { candidates: [{ content: { parts: [{ text: 'total += item.price * item.quantity;' }] } }] }, credential: 'api-key', credentialNote: 'the Vertex AI service account could not get an access token (expired)' };
                }
            } as any;
            const result = await new FimCompletionService(client).completeFim({ prefix, suffix, language: 'typescript', fileName: 'cart.ts' });
            expect(calls).toEqual(['gemini-3.1-flash-lite']);
            expect(result).toMatchObject({ success: true, completion: 'total += item.price * item.quantity;', modelUsed: 'gemini-3.1-flash-lite', credential: 'api-key', credentialNote: expect.stringContaining('expired') });

            const failing = { ...client, requestGenerateContent: async () => { throw new Error('Vertex AI error (400): INVALID_ARGUMENT'); } };
            const failed = await new FimCompletionService(failing).completeFim({ prefix, suffix, language: 'typescript', fileName: 'cart.ts' });
            expect(failed).toMatchObject({ success: false, completion: '', error: 'Vertex AI error (400): INVALID_ARGUMENT' });
        });

        it('cleans redundant prefix/suffix markdown block artifacts from model completions', () => {
            const service = new FimCompletionService({} as any);
            const raw = '```typescript\n        total += item.price * item.quantity;\n```';
            const cleaned = (service as any).cleanCompletion(raw, '        ', '\n    }');
            expect(cleaned).toContain('total += item.price * item.quantity;');
            expect(cleaned).not.toContain('```');
        });
    });

    describe('Track 2: Prompt-to-Code ⌘K Inline Edit Engine', () => {
        const originalCode = 'function greet(name: string) {\n    console.log("Hello " + name);\n}';
        const instruction = 'Add TypeScript return type and use template literal';

        it('a Vertex error fails the edit with that error (no locally made-up edit as success)', async () => {
            const client = {
                getStatus: async () => ({ connected: true, authMethod: 'service-account', activeModel: 'gemini-3.8-flash' }),
                requestGenerateContent: async () => { throw new Error('Vertex AI error (400): INVALID_ARGUMENT'); }
            } as any;
            const result = await new QuickEditService(client).quickEdit({ originalCode, instruction, language: 'typescript', fileName: 'greeter.ts' });
            expect(result.success).toBe(false);
            expect(result.proposedCode).toBe(originalCode);
            expect(result.error).toContain('Vertex AI error (400): INVALID_ARGUMENT');
            expect(result.modelUsed).toBe('gemini-3.8-flash');
            expect(result.proposedCode).not.toContain('Auto-documented');
        });

        it('without model credentials the edit fails with the reason', async () => {
            const offline = { getStatus: async () => ({ connected: false, authMethod: 'unauthenticated' }) } as any;
            const result = await new QuickEditService(offline).quickEdit({ originalCode, instruction, language: 'typescript', fileName: 'greeter.ts' });
            expect(result).toMatchObject({ success: false, proposedCode: originalCode, error: expect.stringContaining('No Google Cloud service account or Gemini API key') });
        });

        it('returns the model\'s edit as a diff, with the model and credential that answered', async () => {
            const edited = 'function greet(name: string): void {\n    console.log(`Hello ${name}`);\n}';
            const client = {
                getStatus: async () => ({ connected: true, authMethod: 'service-account', activeModel: 'gemini-3.8-flash' }),
                requestGenerateContent: async () => ({ json: { candidates: [{ content: { parts: [{ text: '```ts\n' + edited + '\n```' }] } }] }, credential: 'vertex' })
            } as any;
            const result = await new QuickEditService(client).quickEdit({ originalCode, instruction, language: 'typescript', fileName: 'greeter.ts' });
            expect(result).toMatchObject({ success: true, proposedCode: edited, modelUsed: 'gemini-3.8-flash', credential: 'vertex' });
            expect(result.diffSummary).toContain('greeter.ts');
            const empty = await new QuickEditService({ ...client, requestGenerateContent: async () => ({ json: { candidates: [] }, credential: 'vertex' }) } as any)
                .quickEdit({ originalCode, instruction, language: 'typescript', fileName: 'greeter.ts' });
            expect(empty).toMatchObject({ success: false, error: 'gemini-3.8-flash returned no code for this edit.' });
        });
    });

    describe('Track 3 & 4: Hunk-by-Hunk Review & Selective Application', () => {
        it('computes line diffs and extracts structured hunk blocks with stable IDs', () => {
            const oldText = 'const x = 1;\nconst y = 2;\nconst a = 4;\n\nconsole.log(x);\nreturn true;';
            const newText = 'const x = 1;\nconst y = 20;\nconst z = 30;\nconst a = 4;\n\nconsole.log(x);\nconsole.log(z);\nreturn true;';

            const diff = computeLineDiff(oldText, newText);
            expect(diff.lines.length).toBeGreaterThan(0);
            expect(diff.additions).toBeGreaterThan(0);

            const hunks = extractHunksFromDiffLines(diff.lines);
            expect(hunks.length).toBeGreaterThan(0);
            expect(hunks[0].id).toBe('hunk-0');
            expect(hunks[0].header).toContain('@@');
        });

        it('selectively applies accepted hunks while safely omitting rejected hunks', () => {
            const oldContent = 'line 1\nline 2\nline 3';
            const newContent = 'line 1\nline 2 MODIFIED\nline 3';

            const diff = computeLineDiff(oldContent, newContent);
            const hunks = extractHunksFromDiffLines(diff.lines);
            expect(hunks.length).toBe(1);

            // When accepted:
            const appliedAccepted = applySelectedHunks(oldContent, hunks, [hunks[0].id]);
            expect(appliedAccepted).toBe(newContent);

            // When rejected:
            const appliedRejected = applySelectedHunks(oldContent, hunks, []);
            expect(appliedRejected).toBe(oldContent);
        });
    });

    describe('Track 5: Semantic Codebase Context Graph Search', () => {
        it('retrieves relevant symbols and topological neighbors with relevance scoring', () => {
            const graph = new ProjectContextGraphService();
            graph.ingestSandboxTabs([
                {
                    id: 'tab-1',
                    name: 'token-service.ts',
                    path: 'src/auth/token-service.ts',
                    language: 'typescript',
                    content: `
                        export class TokenRefreshService {
                            async refreshAuthToken(refreshToken: string): Promise<string> {
                                return 'refreshed-jwt-token';
                            }
                        }
                    `
                }
            ]);

            const result = graph.retrieveSymbolGraph({
                query: 'TokenRefreshService',
                minRelevanceScore: 0.01,
                maxSymbols: 5
            });

            expect(result).toBeDefined();
            expect(result.matchingSymbols.length).toBeGreaterThan(0);
            expect(result.matchingSymbols[0].name).toBe('TokenRefreshService');
            expect(result.matchingSymbols[0].kind).toBe('class');
        });
    });
});

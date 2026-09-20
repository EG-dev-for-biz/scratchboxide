/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
        it('synthesizes high-quality heuristic autocomplete when offline or low latency needed', async () => {
            const service = new FimCompletionService();
            const prefix = 'function calculateTotal(items: CartItem[]) {\n    let total = 0;\n    for (const item of items) {\n        ';
            const suffix = '\n    }\n    return total;\n}';

            const result = await service.completeFim({
                prefix,
                suffix,
                language: 'typescript',
                fileName: 'cart.ts'
            });

            expect(result.success).toBe(true);
            expect(result.completion).toBeDefined();
            expect(typeof result.completion).toBe('string');
            expect(result.completion.length).toBeGreaterThan(0);
        });

        it('cleans redundant prefix/suffix markdown block artifacts from model completions', () => {
            const service = new FimCompletionService();
            const raw = '```typescript\n        total += item.price * item.quantity;\n```';
            const cleaned = (service as any).cleanCompletion(raw, '        ', '\n    }');
            expect(cleaned).toContain('total += item.price * item.quantity;');
            expect(cleaned).not.toContain('```');
        });
    });

    describe('Track 2: Prompt-to-Code ⌘K Inline Edit Engine', () => {
        it('synthesizes instructions into unified diffs when offline / heuristic', async () => {
            const service = new QuickEditService();
            const originalCode = 'function greet(name: string) {\n    console.log("Hello " + name);\n}';
            const instruction = 'Add TypeScript return type and use template literal';

            const result = await service.quickEdit({
                originalCode,
                instruction,
                language: 'typescript',
                fileName: 'greeter.ts'
            });

            expect(result.success).toBe(true);
            expect(result.proposedCode).toBeDefined();
            expect(result.diffSummary).toBeDefined();
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

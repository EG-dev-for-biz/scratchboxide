/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type {
    AttemptDetail,
    ExecutionTrace,
    LearnedInsight,
    TddFeedbackLoopResult,
    TddIterationRecord,
    TitansContextualMemoryItem,
    TitansMemoryQuery,
    TitansMemorySnapshot,
    TitansPersistentMemoryItem
} from '../common/self-improvement-protocol';

export type {
    ExecutionTrace,
    LearnedInsight,
    AttemptDetail,
    TddFeedbackLoopResult,
    TddIterationRecord,
    TitansContextualMemoryItem,
    TitansMemoryQuery,
    TitansMemorySnapshot,
    TitansPersistentMemoryItem
};

export class SelfImprovementService {
    private traces: ExecutionTrace[] = [];
    private insights: Map<string, LearnedInsight> = new Map();
    private persistentMemories: Map<string, TitansPersistentMemoryItem> = new Map();
    private contextualMemories: Map<string, TitansContextualMemoryItem> = new Map();

    /**
     * Record an end-to-end execution trace for an AI agent action.
     */
    async recordTrace(trace: ExecutionTrace): Promise<void> {
        this.traces.push({
            ...trace,
            timestamp: trace.timestamp || Date.now()
        });

        // Automatically synthesize insights from failed attempts that were subsequently resolved
        if (trace.finalStatus === 'resolved' && trace.attempts.length > 1) {
            this.autoDistillInsightFromTrace(trace);
        }
    }

    /**
     * Retrieve past execution traces matching a prompt keyword.
     */
    getTracesForPrompt(promptQuery: string): ExecutionTrace[] {
        const lower = promptQuery.toLowerCase();
        return this.traces.filter(t =>
            t.taskPrompt.toLowerCase().includes(lower) ||
            t.traceId.toLowerCase().includes(lower)
        );
    }

    /**
     * Save or update a learned insight rule in memory.
     */
    async saveLearnedInsight(insight: LearnedInsight): Promise<void> {
        this.insights.set(insight.id, {
            ...insight,
            lastUpdated: Date.now()
        });
    }

    // =========================================================================
    // Titans / MIRAS 3-Tier Neural Memory System (Google NeurIPS 2025 Architecture)
    // =========================================================================

    /**
     * Register an immutable architectural invariant into persistent memory.
     * (Tier 3: Persistent Memory - never decays across sessions).
     */
    addPersistentMemory(item: TitansPersistentMemoryItem): void {
        this.persistentMemories.set(item.id, item);
    }

    /**
     * Record a test-time contextual memory event with surprise score and dynamic associative weight.
     * (Tier 2: Contextual Memory - updates dynamically at test-time on unexpected feedback).
     */
    recordContextualMemory(item: TitansContextualMemoryItem): void {
        const existing = this.contextualMemories.get(item.id);
        if (existing) {
            // Associative delta update: boost weight and increment access count on reinforcement
            this.contextualMemories.set(item.id, {
                ...item,
                decayWeight: Math.min(1.0, existing.decayWeight * 0.8 + item.decayWeight * 0.2 + 0.1),
                accessCount: existing.accessCount + 1,
                lastUpdated: Date.now()
            });
        } else {
            this.contextualMemories.set(item.id, {
                ...item,
                accessCount: 1,
                lastUpdated: Date.now()
            });
        }
    }

    /**
     * Apply associative state decay across contextual memories.
     * w_t update: St = St-1 * (1 - decayRate)
     */
    applyMemoryDecay(decayRate = 0.05): void {
        for (const [id, item] of this.contextualMemories.entries()) {
            const updatedWeight = Math.max(0.01, item.decayWeight * (1 - decayRate));
            this.contextualMemories.set(id, {
                ...item,
                decayWeight: updatedWeight
            });
        }
    }

    /**
     * Retrieve a blended Titans 3-tier memory snapshot for agent execution.
     * Combines Tier 1 (Core Working Window), Tier 2 (Contextual Surprise Memory), and Tier 3 (Persistent Rules).
     */
    retrieveTitansMemory(query: TitansMemoryQuery): TitansMemorySnapshot {
        const queryLower = query.query.toLowerCase();
        const minSurprise = query.minSurpriseScore ?? 0.1;
        const minDecay = query.minDecayWeight ?? 0.05;

        // 1. Core Working Memory (Tier 1)
        const coreWorkingMemory = query.workingContext ? [...query.workingContext] : [];

        // 2. Contextual Surprise Memories (Tier 2) - Filtered by trigger match and score
        const queryTokens = queryLower.split(/[\s,.:;()\/\[\]"']+/).filter(t => t.length >= 3);
        const matchedContextual: TitansContextualMemoryItem[] = [];
        for (const mem of this.contextualMemories.values()) {
            const keyLower = mem.triggerKey.toLowerCase();
            const keyTokens = keyLower.split(/[\s,.:;()\/\[\]"']+/).filter(t => t.length >= 3);

            // Substring or token overlap match
            const hasSubstring = queryLower.includes(keyLower) || keyLower.includes(queryLower);
            const tokenOverlap = keyTokens.some(kt => queryTokens.includes(kt));
            const ctxOverlap = query.workingContext && query.workingContext.some(ctx => {
                const ctxLower = ctx.toLowerCase();
                return ctxLower.includes(keyLower) || keyTokens.some(kt => ctxLower.includes(kt));
            });

            const matchesQuery = hasSubstring || tokenOverlap || ctxOverlap;

            if (matchesQuery && mem.surpriseScore >= minSurprise && mem.decayWeight >= minDecay) {
                matchedContextual.push(mem);
            }
        }

        // Sort contextual memories by effective relevance: surpriseScore * decayWeight
        matchedContextual.sort((a, b) => (b.surpriseScore * b.decayWeight) - (a.surpriseScore * a.decayWeight));

        // 3. Persistent Invariants (Tier 3)
        const persistentList = Array.from(this.persistentMemories.values());

        // Compose formatted prompt injection block
        const injectionLines: string[] = [
            '--- [Titans Long-Term Memory] ---',
            '### 1. Persistent Architectural Invariants:',
            ...persistentList.map(p => `- [${p.category}] **${p.title}**: ${p.content}`),
            '',
            '### 2. Test-Time Contextual Learnings & Dynamic Fixes:'
        ];

        if (matchedContextual.length > 0) {
            for (const ctx of matchedContextual) {
                injectionLines.push(`- **Trigger**: "${ctx.triggerKey}" -> **Resolution**: ${ctx.resolutionValue} (Surprise: ${ctx.surpriseScore.toFixed(2)}, Confidence: ${ctx.decayWeight.toFixed(2)})`);
            }
        } else {
            injectionLines.push('- (No active contextual error patterns triggered)');
        }

        if (coreWorkingMemory.length > 0) {
            injectionLines.push('');
            injectionLines.push('### 3. Active Working State:');
            for (const work of coreWorkingMemory) {
                injectionLines.push(`- ${work}`);
            }
        }

        return {
            coreWorkingMemory,
            contextualMemories: matchedContextual,
            persistentMemories: persistentList,
            promptInjectionText: injectionLines.join('\n')
        };
    }

    /**
     * Search learned insights for matches against an error message or compiler stack trace.
     */
    findMatchingInsights(errorText: string): LearnedInsight[] {
        const matches: LearnedInsight[] = [];

        for (const insight of this.insights.values()) {
            try {
                const regex = new RegExp(insight.triggerPattern, 'i');
                if (regex.test(errorText)) {
                    matches.push(insight);
                }
            } catch {
                if (errorText.toLowerCase().includes(insight.triggerPattern.toLowerCase())) {
                    matches.push(insight);
                }
            }
        }

        // Sort by confidence score descending
        return matches.sort((a, b) => b.confidenceScore - a.confidenceScore);
    }

    /**
     * Construct a grounded TDD self-correction prompt for Google Gemini 3.8 / 3.5.
     */
    buildTddCorrectionPrompt(context: {
        testName: string;
        failingFile: string;
        sourceFile: string;
        errorOutput: string;
        currentCode?: string;
    }): string {
        const matchedInsights = this.findMatchingInsights(context.errorOutput);
        const insightNotes = matchedInsights.length > 0
            ? `\n### Relevant Learned Project Guidance:\n` +
              matchedInsights.map(i => `- **${i.title}**: ${i.resolutionGuidance}`).join('\n')
            : '';

        return `[TDD_SELF_CORRECTION_DIRECTIVE]
The test "${context.testName}" in \`${context.failingFile}\` failed during execution.

### Exact Failure Diagnostic & Stack Trace:
\`\`\`
${context.errorOutput.trim()}
\`\`\`

### Target Source File to Repair:
\`${context.sourceFile}\`
${insightNotes}

### Instructions for Gemini:
1. Analyze the stack trace above without guessing or hallucinating missing parameters.
2. Provide the exact minimal code change in \`${context.sourceFile}\` required to turn this test green.
3. Preserve all existing interface contracts and adhere to project standards.`;
    }

    /**
     * Evaluate whether an iterative TDD feedback loop has converged.
     */
    evaluateLoopConvergence(iterations: TddIterationRecord[]): TddFeedbackLoopResult {
        if (!iterations || iterations.length === 0) {
            return {
                converged: false,
                totalIterations: 0,
                finalStatus: 'red',
                passRate: 0,
                history: []
            };
        }

        const lastRecord = iterations[iterations.length - 1];
        const isConverged = lastRecord.status === 'passed' && lastRecord.testsPassed === lastRecord.testsTotal;
        const passRate = lastRecord.testsTotal > 0 ? (lastRecord.testsPassed / lastRecord.testsTotal) : 0;

        return {
            converged: isConverged,
            totalIterations: iterations.length,
            finalStatus: isConverged ? 'green' : 'red',
            passRate,
            history: iterations
        };
    }

    /**
     * Export all learned insights into structured text suitable for Gemini system instructions.
     */
    exportSystemInstructionMemory(): string {
        if (this.insights.size === 0) {
            return 'No specialized project learnings recorded yet.';
        }

        const lines: string[] = ['### Project Learned Rules & Anti-Patterns:'];
        for (const insight of this.insights.values()) {
            lines.push(`- [${insight.id}] ${insight.title}: ${insight.resolutionGuidance} (Confidence: ${(insight.confidenceScore * 100).toFixed(0)}%)`);
        }
        return lines.join('\n');
    }

    /**
     * Internal heuristic to derive insights from resolved multi-attempt traces.
     */
    private autoDistillInsightFromTrace(trace: ExecutionTrace): void {
        const failedAttempts = trace.attempts.filter(a => a.outcome === 'failure');
        const successAttempt = trace.attempts.find(a => a.outcome === 'success');

        if (failedAttempts.length > 0 && successAttempt && successAttempt.resolutionNotes) {
            const firstFail = failedAttempts[0];
            const insightId = `auto-insight-${Date.now().toString(36)}`;

            const triggerPattern = firstFail.errorMessage
                ? firstFail.errorMessage.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '.*')
                : 'error';

            this.insights.set(insightId, {
                id: insightId,
                category: 'runtime_exception',
                title: `Auto-Learned: Fix for "${trace.taskPrompt.slice(0, 30)}..."`,
                triggerPattern,
                resolutionGuidance: successAttempt.resolutionNotes,
                confidenceScore: 0.85,
                occurrencesCount: 1,
                lastUpdated: Date.now()
            });
        }
    }
}

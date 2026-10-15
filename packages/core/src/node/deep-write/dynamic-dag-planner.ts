/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import type { GeminiService } from '../gemini-service';
import { DynamicAgentStage, DiscoveredGoalPlan } from '../../common/deep-write/deep-write-protocol';
import { CodebasePatternEngine } from '../codebase-pattern-engine';
import { ProjectContextGraphService } from '../project-context-graph-service';
import type { ModelAnswerProvenance } from '../../common/gemini-protocol';
import { describeHelperProvenance } from '../gemini/streaming';

/**
 * Runs the stages of a deep-write plan with the model. (It used to also plan 3D scenes by matching prompt words to
 * themes and filling in a template C++ scene and meshes for each; 3D scenes are built by the model with the 3D tools.)
 */
export class DynamicDagPlanner {
    private fallbackPatternEngine = new CodebasePatternEngine();
    private fallbackContextGraph = new ProjectContextGraphService();

    constructor(
        protected readonly geminiService?: GeminiService,
        protected readonly patternEngine?: CodebasePatternEngine,
        protected readonly contextGraphService?: ProjectContextGraphService
    ) {}

    public getPatternEngine(): CodebasePatternEngine {
        return this.patternEngine || this.fallbackPatternEngine;
    }

    public getContextGraphService(): ProjectContextGraphService {
        return this.contextGraphService || this.fallbackContextGraph;
    }

    // ========================================================================
    // General Dynamic Agent Stage Execution (Existing Multi-Agent Deep-Write)
    // ========================================================================

    /**
     * Executes a single dynamic stage of the multi-agent planning DAG.
     */
    public async executeStage(
        goalPlan: DiscoveredGoalPlan,
        stage: DynamicAgentStage,
        previousContext: Record<string, any>,
        userFeedback?: string
    ): Promise<{
        success: boolean;
        output: {
            description: string;
            content: string;
            files?: Record<string, string>;
            artifacts?: Array<{ type: string; title: string; data: any }>;
        };
        error?: string;
        /** Which model and credential answered the stage. */
        modelProvenance?: ModelAnswerProvenance;
        /** Set when the stage was not answered by the requested model or by the service account: what answered and why. */
        modelNote?: string;
    }> {
        // Incorporate codebase patterns & conventions
        let patternPrompt = '';
        try {
            const patternAnalysis = this.getPatternEngine().analyzeFilesPatterns([]);
            if (patternAnalysis && patternAnalysis.summaryPromptContext) {
                patternPrompt = `\n\nWorkspace Conventions:\n${patternAnalysis.summaryPromptContext}`;
            }
        } catch {
            // Ignore pattern analysis errors
        }

        // Incorporate symbol graph context for relevant stage targets
        let symbolPrompt = '';
        try {
            const symResult = this.getContextGraphService().retrieveSymbolGraph({
                query: `${stage.name} ${goalPlan.goal}`,
                maxSymbols: 8
            });
            if (symResult && symResult.matchingSymbols.length > 0) {
                symbolPrompt = `\n\nRelevant Symbols Subgraph:\n${symResult.compressedPromptContext}`;
            }
        } catch {
            // Ignore symbol graph errors
        }

        const systemInstruction = `You are a highly specialized Deep-Planning agent representing the role: "${stage.assignedAgentRole}".
Your current task is: "${stage.name}" - ${stage.description}.

Global Project Goal: "${goalPlan.goal}"
Target Platform Domains: ${goalPlan.domains.join(', ')}
Target Primitives & Canvas Elements: ${goalPlan.deliverables.primitives.join(', ')}
${patternPrompt}${symbolPrompt}

In your output, you MUST address and generate the expected deliverables and files.
Target Files to create or update:
${goalPlan.deliverables.filePaths.map(p => `- ${p}`).join('\n')}

Previous Plan History and Stage Outputs:
${JSON.stringify(previousContext, null, 2)}
${userFeedback ? `\nUser Correction / Feedback for this Stage:\n"${userFeedback}"` : ''}

You MUST produce a comprehensive, exhaustive output. Do NOT write placeholders, truncated snippets, or "insert code here". Write complete implementations, full type contracts, actual shader algorithms, and fully populated specs.

You MUST respond with a single valid JSON object containing no markdown wrapping, matching this exact structure:
{
  "description": "Brief executive summary of what was accomplished, planned, or authored in this stage.",
  "content": "Fully-formed Markdown or HTML documenting the specifications, designs, or mathematical models of this stage.",
  "files": {
    "src/file1.cpp": "// Complete, non-truncated file contents here...",
    "shaders/custom.wgsl": "..."
  },
  "artifacts": [
    {
      "type": "markdown-document",
      "title": "Stage Deliverable Specification",
      "data": { ... }
    }
  ]
}
`;

        // A stage is the model's work or a failure: with no model there is nothing to run it, and it is not reported done.
        if (!this.geminiService) {
            return {
                success: false,
                output: { description: '', content: '' },
                error: `Stage "${stage.name}" was not run: no model service is connected to the planner.`
            };
        }

        let accumulatedText = '';
        let modelProvenance: ModelAnswerProvenance | undefined;
        let streamError: string | undefined;
        try {
            const response = await this.geminiService.streamGenerate(
                {
                    prompt: `Execute stage "${stage.id}" within the global goal plan. Respond with your structured stage JSON output.`,
                    systemInstruction,
                    model: 'gemini-3.8-flash',
                    temperature: 0.2,
                    thinkingBudget: 1024
                },
                event => {
                    if (event.text) {
                        accumulatedText += event.text;
                    }
                    if (event.modelProvenance) modelProvenance = event.modelProvenance;
                    if (event.type === 'error' && event.error) streamError = event.error;
                }
            );
            modelProvenance = response?.modelProvenance ?? modelProvenance;
        } catch (err: any) {
            console.error(`[DynamicDagPlanner] Failed to execute stage ${stage.id}:`, err);
            const failedProvenance = (err as { modelProvenance?: ModelAnswerProvenance })?.modelProvenance ?? modelProvenance;
            return {
                success: false,
                output: { description: '', content: '' },
                error: err.message || 'Error occurred during dynamic stage execution.',
                ...this.provenanceFields(stage, failedProvenance)
            };
        }
        const answered = this.provenanceFields(stage, modelProvenance);
        if (streamError && !accumulatedText.trim()) {
            return { success: false, output: { description: '', content: '' }, error: `Stage "${stage.name}" failed: ${streamError}`, ...answered };
        }

        const cleaned = accumulatedText.trim();
        let jsonStr = cleaned;
        const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1].trim();
        } else {
            const objectMatch = cleaned.match(/\{[\s\S]*\}/);
            if (objectMatch) {
                jsonStr = objectMatch[0].trim();
            }
        }

        try {
            const result = JSON.parse(jsonStr);
            return {
                success: true,
                output: result,
                ...answered
            };
        } catch (parseErr: any) {
            // The stage's files come only from its JSON; a reply that is not JSON produced none, so the stage failed.
            const excerpt = cleaned.slice(0, 200);
            return {
                success: false,
                output: { description: '', content: accumulatedText },
                error: `Stage "${stage.name}" did not return its stage JSON (${parseErr?.message || 'not JSON'})${excerpt ? `; the reply began: ${excerpt}` : '; the reply was empty'}.`,
                ...answered
            };
        }
    }

    /** The stage's provenance, and a note when another model or the API key answered it (the fallback is kept, not hidden). */
    private provenanceFields(stage: DynamicAgentStage, p: ModelAnswerProvenance | undefined): { modelProvenance?: ModelAnswerProvenance; modelNote?: string } {
        if (!p) return {};
        const note = describeHelperProvenance(`Stage "${stage.name}"`, p);
        return { modelProvenance: p, ...(note ? { modelNote: note } : {}) };
    }
}

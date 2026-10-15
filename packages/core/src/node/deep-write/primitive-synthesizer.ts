/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import { DiscoveredGoalPlan, MultiArtifactPlanBundle } from '../../common/deep-write/deep-write-protocol';
import { CodeFileTab, LiveCodeSandboxData, PrimitiveType, SandboxLanguage } from '../../browser/generative-canvas/canvas-types';

/**
 * Builds the deep-write bundle from what the pipeline produced: its stage outputs, its files and its plan. A primitive
 * the plan asked for that the pipeline produced nothing for is left out and named in the summary; no template scene
 * or app picked from words in the project name stands in for it.
 */
export class PrimitiveSynthesizer {
    /**
     * Synthesize and bundle multiple coordinated Scratchbox Canvas Primitives from the planning/code results.
     */
    public synthesizeBundle(
        projectName: string,
        plan: DiscoveredGoalPlan,
        stageHistory: Record<string, any>,
        files: Record<string, string>
    ): MultiArtifactPlanBundle {
        const artifacts: Array<{ type: PrimitiveType; title: string; data: any }> = [];
        const primitivesToCreate = plan.deliverables.primitives;

        // 1. Synthesize Technical Specifications (Markdown Doc)
        if (primitivesToCreate.includes('markdown-document')) {
            artifacts.push({
                type: 'markdown-document',
                title: `${projectName} Comprehensive Spec`,
                data: this.synthesizeSpecsDocument(projectName, plan, stageHistory)
            });
        }

        const notMade: string[] = [];

        // 2. The pipeline writes code and documents, not scene geometry: a 3D scene is not made up for it (a keyword
        // template scene used to be mounted as the project's viewport).
        if (primitivesToCreate.includes('3d-scene')) {
            notMade.push('a 3D scene (the pipeline produced no scene geometry)');
        }

        // 3. The files the pipeline wrote, in a sandbox; with no files there is no sandbox (a template app was used).
        if (primitivesToCreate.includes('live-code-sandbox')) {
            const sandbox = this.synthesizeSandbox(projectName, files);
            if (sandbox) {
                artifacts.push({ type: 'live-code-sandbox', title: `${projectName} Runtime Sandbox`, data: sandbox });
            } else {
                notMade.push('a runtime sandbox (the pipeline wrote no files)');
            }
        }

        // 4. Synthesize Module Dependency Node Graph
        if (primitivesToCreate.includes('node-graph')) {
            artifacts.push({
                type: 'node-graph',
                title: `${projectName} Architecture Map`,
                data: this.synthesizeNodeGraph(projectName, plan)
            });
        }

        // 5. Synthesize Sprints Kanban Board
        if (primitivesToCreate.includes('kanban-board')) {
            artifacts.push({
                type: 'kanban-board',
                title: `${projectName} Implementation Roadmap`,
                data: this.synthesizeKanban(projectName, plan)
            });
        }

        return {
            title: projectName,
            summary: `Deliverables for the goal "${plan.goal}".${notMade.length > 0 ? ` Not made: ${notMade.join('; ')}.` : ''}`,
            artifacts,
            files
        };
    }

    private synthesizeSpecsDocument(projectName: string, plan: DiscoveredGoalPlan, history: Record<string, any>): any {
        const sections: any[] = [
            {
                id: 'sec-summary',
                type: 'callout',
                calloutTitle: projectName,
                calloutType: 'info',
                content: `Goal: ${plan.goal}`
            }
        ];

        // Hydrate from stage outputs
        for (const [stageId, output] of Object.entries(history)) {
            sections.push({
                id: `sec-${stageId}`,
                type: 'text',
                content: `### ${stageId.toUpperCase().replace(/_/g, ' ')}\n\n${(output as any).description || ''}\n\n${(output as any).content || ''}`
            });
        }

        // The planned files with the plan's platforms and toolchain (no role is made up for each file).
        sections.push({
            id: 'sec-comparison',
            type: 'table',
            tableHeaders: ['File', 'Build Platform', 'Toolchain'],
            tableRows: plan.deliverables.filePaths.map(p => [
                p,
                plan.deliverables.config.platforms.join(', '),
                plan.deliverables.config.toolchain.toUpperCase()
            ])
        });

        return {
            title: `${projectName} Technical Specification`,
            subtitle: `Strategic multi-platform architecture & code specifications`,
            author: 'Scratchbox Deep-Write Engine',
            sections,
            tags: ['deep-write', ...plan.domains]
        };
    }

    /** The pipeline's files as sandbox tabs; undefined when it wrote none. */
    private synthesizeSandbox(projectName: string, files: Record<string, string>): LiveCodeSandboxData | undefined {
        const entries = Object.entries(files);
        if (entries.length === 0) return undefined;
        const LANGUAGE_BY_EXT: Record<string, SandboxLanguage> = {
            cpp: 'cpp', hpp: 'cpp', cc: 'cpp', h: 'c', c: 'c', ts: 'typescript', tsx: 'typescript', js: 'javascript',
            jsx: 'javascript', py: 'python', css: 'css', html: 'html', json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml', wasm: 'wasm'
        };
        const tabs: CodeFileTab[] = entries.map(([filePath, content], idx) => {
            const ext = (filePath.split('.').pop() || '').toLowerCase();
            return {
                id: `file-${idx}`,
                name: filePath.split('/').pop() || filePath,
                path: filePath,
                // A file type the sandbox has no name for keeps its own extension as its label.
                language: LANGUAGE_BY_EXT[ext] ?? (ext as SandboxLanguage),
                content,
                isEntry: idx === 0
            };
        });
        return {
            title: `${projectName} Sandbox`,
            files: tabs,
            activeFileId: tabs[0].id,
            // The pipeline's files are shown as code; nothing is run as an app they were not written as.
            viewMode: 'code'
        };
    }

    private synthesizeNodeGraph(projectName: string, plan: DiscoveredGoalPlan): any {
        const nodes = plan.stages.map((stage, idx) => ({
            id: stage.id,
            label: stage.name,
            type: 'agent-role',
            position: { x: 100 + idx * 220, y: 150 },
            data: {
                role: stage.assignedAgentRole,
                description: stage.description,
                checkpoint: stage.isCheckpoint
            }
        }));

        const edges = plan.stages.slice(0, -1).map((stage, idx) => ({
            id: `edge-${stage.id}-${plan.stages[idx + 1].id}`,
            source: stage.id,
            target: plan.stages[idx + 1].id,
            type: 'flow'
        }));

        return {
            nodes,
            edges
        };
    }

    private synthesizeKanban(projectName: string, plan: DiscoveredGoalPlan): any {
        const columns = [
            { id: 'col-todo', title: 'Sprint backlog', cardIds: [] as string[] },
            { id: 'col-inprogress', title: 'Active development', cardIds: [] as string[] },
            { id: 'col-done', title: 'Completed', cardIds: [] as string[] }
        ];

        const cards = plan.stages.map((stage, idx) => ({
            id: `card-${stage.id}`,
            title: stage.name,
            description: stage.description,
            priority: stage.isCheckpoint ? 'high' : 'medium',
            tag: stage.assignedAgentRole,
            tagColor: 'indigo'
        }));

        // Assign card IDs to backlog column
        columns[0].cardIds = cards.map(c => c.id);

        return {
            columns,
            cards
        };
    }
}

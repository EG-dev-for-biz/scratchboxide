/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import { DiscoveredGoalPlan, MultiArtifactPlanBundle } from '../../common/deep-write/deep-write-protocol';
import { PrimitiveType } from '../../browser/generative-canvas/canvas-types';
import { synthesizeContextual3DScene } from '../../browser/generative-canvas/procedural-3d-synthesizer';
import { synthesizeVibeToolSandbox } from '../../browser/generative-canvas/vibe-tool-synthesizer';

@injectable()
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

        // 2. Synthesize 3D Scene Viewport
        if (primitivesToCreate.includes('3d-scene')) {
            artifacts.push({
                type: '3d-scene',
                title: `${projectName} Graphics Viewport`,
                data: this.synthesize3DScene(projectName, stageHistory)
            });
        }

        // 3. Synthesize Live Runnable Sandbox
        if (primitivesToCreate.includes('live-code-sandbox')) {
            artifacts.push({
                type: 'live-code-sandbox',
                title: `${projectName} Runtime Sandbox`,
                data: this.synthesizeSandbox(projectName, files)
            });
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
            summary: `Autonomous multi-primitive deliverable bundle compiled for goal: "${plan.goal}".`,
            artifacts,
            files
        };
    }

    private synthesizeSpecsDocument(projectName: string, plan: DiscoveredGoalPlan, history: Record<string, any>): any {
        const sections: any[] = [
            {
                id: 'sec-summary',
                type: 'callout',
                calloutTitle: 'Executive Summary',
                calloutType: 'info',
                content: `Exhaustive planning spec autonomously compiled for "${projectName}". Includes architectural patterns, platform scopes, and comprehensive deliverables.`
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

        // Add comparison matrix
        sections.push({
            id: 'sec-comparison',
            type: 'table',
            tableHeaders: ['Module / Asset', 'Expressive Target', 'Build Platform', 'Toolchain Status'],
            tableRows: plan.deliverables.filePaths.map((p, idx) => [
                p,
                idx === 0 ? 'Core controller logic' : 'Simulation interface module',
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

    private synthesize3DScene(projectName: string, history: Record<string, any>): any {
        const historyContext = Object.values(history).map((h: any) => `${h.description || ''} ${h.content || ''}`).join(' ');
        return synthesizeContextual3DScene(projectName, {
            docTitle: projectName,
            docContent: historyContext
        });
    }

    public synthesizeStudioTool(toolName: string, prompt?: string): any {
        return synthesizeVibeToolSandbox(prompt || toolName, toolName);
    }

    private synthesizeSandbox(projectName: string, files: Record<string, string>): any {
        if (Object.keys(files).length === 0 || /tool|studio|blocking|pre-viz|editor/i.test(projectName)) {
            return synthesizeVibeToolSandbox(projectName, `${projectName} Studio`);
        }
        const tabs = Object.entries(files).map(([filePath, content], idx) => {
            const ext = filePath.split('.').pop() || 'js';
            let language = 'javascript';
            if (ext === 'cpp' || ext === 'hpp') language = 'cpp';
            if (ext === 'rs') language = 'rust';
            if (ext === 'wgsl') language = 'wgsl';
            if (ext === 'glsl') language = 'glsl';
            if (ext === 'ts' || ext === 'tsx') language = 'typescript';

            return {
                name: filePath,
                path: filePath,
                content,
                language,
                isActive: idx === 0
            };
        });

        return {
            title: `${projectName} Sandbox`,
            template: 'webassembly',
            tabs,
            activeTabId: tabs[0]?.path || ''
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

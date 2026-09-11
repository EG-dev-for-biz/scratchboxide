/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    CodebaseLens,
    LensContext,
    LensProjectionResult,
    LensUnprojectionResult,
    computeMultiFileHash
} from '../../../common/codebase-lens-protocol';
import {
    GraphEdge,
    GraphNode,
    NodeGraphData,
    PrimitiveType
} from '../canvas-types';

export class NodeGraphWorkflowLens implements CodebaseLens<NodeGraphData> {
    readonly primitiveType: PrimitiveType = 'node-graph';

    canHandle(filePathOrFiles: string | Record<string, string>): boolean {
        if (typeof filePathOrFiles === 'string') {
            const lower = filePathOrFiles.toLowerCase();
            return (
                lower.endsWith('.automation') ||
                lower.endsWith('.automation.json') ||
                lower.endsWith('.workflow.json') ||
                lower.endsWith('.pipeline.json') ||
                lower.endsWith('.flow.json') ||
                lower.startsWith('workflows/') ||
                lower.includes('/workflows/') ||
                lower.startsWith('automations/') ||
                lower.includes('/automations/')
            );
        }
        return Object.keys(filePathOrFiles).some(p => this.canHandle(p));
    }

    project(
        sourceContent: Record<string, string> | string,
        context?: LensContext
    ): LensProjectionResult<NodeGraphData> {
        const rawText = typeof sourceContent === 'string'
            ? sourceContent
            : Object.values(sourceContent)[0] || '';

        try {
            const parsed = JSON.parse(rawText);
            const nodes: GraphNode[] = Array.isArray(parsed.nodes) ? parsed.nodes : [];
            const edges: GraphEdge[] = Array.isArray(parsed.edges) ? parsed.edges : [];

            const data: NodeGraphData = {
                title: parsed.title || 'Executable Workflow Pipeline',
                subtitle: parsed.subtitle || 'Node graph pipeline definition',
                nodes,
                edges,
                viewport: parsed.viewport || { x: 0, y: 0, zoom: 1 }
            };

            return {
                data,
                contentHash: computeMultiFileHash(rawText)
            };
        } catch (error) {
            // Fallback for empty or newly created workflow definitions
            const data: NodeGraphData = {
                title: 'New Workflow Pipeline',
                subtitle: 'Generated from disk template',
                nodes: [
                    { id: 'node-start', label: 'Trigger Event', category: 'input', x: 100, y: 150, status: 'pending' },
                    { id: 'node-process', label: 'Transform Data', category: 'process', x: 340, y: 150, status: 'pending' },
                    { id: 'node-end', label: 'Output Result', category: 'output', x: 580, y: 150, status: 'pending' }
                ],
                edges: [
                    { id: 'edge-start-process', source: 'node-start', target: 'node-process', style: 'solid' },
                    { id: 'edge-process-end', source: 'node-process', target: 'node-end', style: 'solid' }
                ]
            };
            return {
                data,
                contentHash: computeMultiFileHash(rawText || JSON.stringify(data))
            };
        }
    }

    unproject(
        primitiveData: NodeGraphData,
        currentDiskContent: Record<string, string> | string,
        context?: LensContext
    ): LensUnprojectionResult {
        const primaryFileName = typeof currentDiskContent === 'object' && Object.keys(currentDiskContent).length > 0
            ? Object.keys(currentDiskContent)[0]
            : 'workflow.json';

        const serialized = JSON.stringify({
            title: primitiveData.title,
            subtitle: primitiveData.subtitle,
            nodes: primitiveData.nodes,
            edges: primitiveData.edges,
            viewport: primitiveData.viewport
        }, null, 2) + '\n';

        const files: Record<string, string> = {
            [primaryFileName]: serialized
        };

        return {
            files,
            contentHash: computeMultiFileHash(files),
            modifiedFilePaths: [primaryFileName],
            changeSummary: `Unprojected workflow DAG with ${primitiveData.nodes?.length || 0} nodes`
        };
    }
}

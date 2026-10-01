/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { CodebaseLens } from '../../../common/codebase-lens-protocol';
import { PrimitiveType } from '../canvas-types';
import { MarkdownDocumentLens } from './MarkdownDocumentLens';
import { LiveCodeSandboxLens } from './LiveCodeSandboxLens';
import { KanbanTaskLens } from './KanbanTaskLens';
import { NodeGraphWorkflowLens } from './NodeGraphWorkflowLens';
import { Scene3DWorldLens } from './Scene3DWorldLens';
import { MetricDashboardLens } from './MetricDashboardLens';
import { InteractiveBrowserLens } from './InteractiveBrowserLens';

export class CodebaseLensRegistry {
    private lenses: Map<PrimitiveType, CodebaseLens> = new Map();
    private orderedLenses: CodebaseLens[] = [];

    static createDefaultRegistry(): CodebaseLensRegistry {
        const registry = new CodebaseLensRegistry();
        registry.registerDefaults();
        return registry;
    }

    registerDefaults(): void {
        // Base generic text/code lenses
        this.register(new MarkdownDocumentLens());
        this.register(new LiveCodeSandboxLens());
        // Specialized lenses registered after so resolveByPath checks them first
        this.register(new KanbanTaskLens());
        this.register(new NodeGraphWorkflowLens());
        this.register(new Scene3DWorldLens());
        this.register(new MetricDashboardLens());
        this.register(new InteractiveBrowserLens());
    }

    register(lens: CodebaseLens): void {
        this.lenses.set(lens.primitiveType, lens);
        this.orderedLenses = this.orderedLenses.filter(l => l.primitiveType !== lens.primitiveType);
        this.orderedLenses.push(lens);
    }

    resolveByType(type: PrimitiveType): CodebaseLens | undefined {
        return this.lenses.get(type);
    }

    resolveByPath(filePathOrFiles: string | Record<string, string>): CodebaseLens | undefined {
        // Check specialized lenses in reverse registration order
        for (let i = this.orderedLenses.length - 1; i >= 0; i--) {
            const candidate = this.orderedLenses[i];
            if (candidate.canHandle(filePathOrFiles)) {
                return candidate;
            }
        }
        return undefined;
    }

    getAll(): CodebaseLens[] {
        return [...this.orderedLenses];
    }
}

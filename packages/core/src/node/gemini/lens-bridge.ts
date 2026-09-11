/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import * as fs from 'fs-extra';
import type { CanvasArtifact } from '../../browser/generative-canvas/canvas-types';
import {
    CodebaseLensRegistry,
    CodebaseLensController,
    type CodebaseLensBinding,
    type LensContext,
    type LensSyncMode,
    type LensUnprojectionResult
} from '../../browser/generative-canvas/lenses';
import { errorMessage } from './gemini-client';

export type { LensContext, LensSyncMode };
export type LensSourceContent = Record<string, string> | string;

export interface LensProjectOptions {
    artifactId?: string;
    syncMode?: LensSyncMode;
    context?: LensContext;
}

export interface LensProjectResult {
    success: boolean;
    binding: CodebaseLensBinding;
    artifact: CanvasArtifact;
    error?: string;
}

export interface LensUnprojectResult {
    success: boolean;
    unprojection?: LensUnprojectionResult;
    error?: string;
}

export interface LensSyncPayload {
    diskContent?: LensSourceContent;
    primitiveData?: unknown;
}

export type LensSyncResult = ReturnType<CodebaseLensController['sync']>;

/**
 * Owns the Codebase Lens registry/controller pair and exposes the four lens operations
 * (project / unproject / list bindings / sync) used by both the public GeminiService API
 * and the `lens_*` function-calling tools.
 */
export class LensBridge {
    readonly registry: CodebaseLensRegistry;
    readonly controller: CodebaseLensController;

    constructor(registry?: CodebaseLensRegistry, controller?: CodebaseLensController) {
        this.registry = registry || CodebaseLensRegistry.createDefaultRegistry();
        this.controller = controller || new CodebaseLensController(this.registry);
    }

    /** Project a disk file (or provided content) into a visual canvas primitive artifact. */
    async executeLensProject(
        filePath: string,
        sourceContent?: LensSourceContent,
        options?: LensProjectOptions
    ): Promise<LensProjectResult> {
        try {
            let content = sourceContent;
            if (content === undefined) {
                content = (await fs.pathExists(filePath)) ? await fs.readFile(filePath, 'utf-8') : '';
            }

            const lens = this.registry.resolveByPath(typeof content === 'object' ? content : filePath)
                || this.registry.resolveByType('markdown-document')!;

            const projection = lens.project(content, options?.context);
            const artifactId = options?.artifactId || `art-lens-${Date.now()}`;

            const binding = this.controller.createBinding({
                artifactId,
                lensType: lens.primitiveType,
                primaryFilePath: filePath,
                syncMode: options?.syncMode || 'live-bidirectional',
                initialContent: content,
                metadata: options?.context?.metadata
            });

            const projectedData = projection.data as { title?: string };
            const artifact: CanvasArtifact = {
                id: artifactId,
                type: lens.primitiveType,
                title: projectedData.title || filePath.split('/').pop() || 'Projected Artifact',
                summary: `Projected from ${filePath} via ${lens.primitiveType}`,
                data: projection.data,
                createdAt: new Date().toISOString(),
                version: 1
            };

            return { success: true, binding, artifact };
        } catch (err: unknown) {
            return {
                success: false,
                binding: null as unknown as CodebaseLensBinding,
                artifact: null as unknown as CanvasArtifact,
                error: errorMessage(err)
            };
        }
    }

    /** Unproject visual canvas primitive data back into exact disk files. */
    async executeLensUnproject(
        artifactId: string,
        primitiveData: unknown,
        currentDiskContent?: LensSourceContent,
        context?: LensContext
    ): Promise<LensUnprojectResult> {
        try {
            const binding = this.controller.getBinding(artifactId);
            if (!binding) {
                return { success: false, error: `Binding ${artifactId} not found` };
            }

            const unproj = this.controller.unprojectUiChanges(artifactId, primitiveData, currentDiskContent || {}, context);
            if (!unproj) {
                return { success: false, error: binding.errorMessage || 'Unprojection failed' };
            }

            return { success: true, unprojection: unproj };
        } catch (err: unknown) {
            return { success: false, error: errorMessage(err) };
        }
    }

    /** List all active codebase lens bindings. */
    executeLensListBindings(): CodebaseLensBinding[] {
        return this.controller.getAllBindings();
    }

    /** Force bidirectional synchronization on a binding. */
    executeLensSync(
        artifactId: string,
        direction: 'in' | 'out',
        payload: LensSyncPayload,
        context?: LensContext
    ): LensSyncResult {
        return this.controller.sync(artifactId, direction, payload, context);
    }
}

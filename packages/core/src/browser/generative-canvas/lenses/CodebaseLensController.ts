/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    CodebaseLensBinding,
    LensContext,
    LensProjectionResult,
    LensSyncMode,
    LensSyncStatus,
    LensUnprojectionResult,
    computeMultiFileHash
} from '../../../common/codebase-lens-protocol';
import { PrimitiveType } from '../canvas-types';
import { CodebaseLensRegistry } from './CodebaseLensRegistry';

export class CodebaseLensController {
    private bindings: Map<string, CodebaseLensBinding> = new Map();
    private knownInternalHashes: Map<string, number> = new Map();
    private static readonly HASH_TTL_MS = 15000;

    constructor(private readonly registry: CodebaseLensRegistry) {}

    getRegistry(): CodebaseLensRegistry {
        return this.registry;
    }

    createBinding(options: {
        artifactId: string;
        lensType: PrimitiveType;
        primaryFilePath: string;
        associatedFilePaths?: string[];
        syncMode?: LensSyncMode;
        initialContent: Record<string, string> | string;
        metadata?: Record<string, any>;
    }): CodebaseLensBinding {
        const hash = computeMultiFileHash(options.initialContent);
        const binding: CodebaseLensBinding = {
            artifactId: options.artifactId,
            lensType: options.lensType,
            primaryFilePath: options.primaryFilePath,
            associatedFilePaths: options.associatedFilePaths || [],
            syncMode: options.syncMode || 'live-bidirectional',
            lastSyncHash: hash,
            lastSyncTimestamp: Date.now(),
            status: 'synced',
            metadata: options.metadata
        };

        this.bindings.set(options.artifactId, binding);
        this.registerKnownInternalHash(hash);
        return binding;
    }

    getBinding(artifactId: string): CodebaseLensBinding | undefined {
        return this.bindings.get(artifactId);
    }

    getBindingByPath(filePath: string): CodebaseLensBinding | undefined {
        for (const binding of this.bindings.values()) {
            if (binding.primaryFilePath === filePath || binding.associatedFilePaths?.includes(filePath)) {
                return binding;
            }
        }
        return undefined;
    }

    getAllBindings(): CodebaseLensBinding[] {
        return Array.from(this.bindings.values());
    }

    removeBinding(artifactId: string): void {
        this.bindings.delete(artifactId);
    }

    markDirty(artifactId: string, dirtySource: 'ui' | 'disk'): CodebaseLensBinding | undefined {
        const binding = this.bindings.get(artifactId);
        if (!binding) return undefined;
        binding.status = dirtySource === 'ui' ? 'dirty-ui' : 'dirty-disk';
        return binding;
    }

    updateBindingStatus(artifactId: string, status: LensSyncStatus, errorMessage?: string): CodebaseLensBinding | undefined {
        const binding = this.bindings.get(artifactId);
        if (!binding) return undefined;
        binding.status = status;
        if (errorMessage !== undefined) {
            binding.errorMessage = errorMessage;
        }
        return binding;
    }

    registerKnownInternalHash(hash: string): void {
        this.knownInternalHashes.set(hash, Date.now());
        this.cleanupStaleHashes();
    }

    isKnownInternalHash(hash: string): boolean {
        this.cleanupStaleHashes();
        return this.knownInternalHashes.has(hash);
    }

    private cleanupStaleHashes(): void {
        const now = Date.now();
        for (const [hash, timestamp] of this.knownInternalHashes.entries()) {
            if (now - timestamp > CodebaseLensController.HASH_TTL_MS) {
                this.knownInternalHashes.delete(hash);
            }
        }
    }

    /**
     * Ingests UI changes from a canvas primitive, applies the lens unprojection,
     * registers the resulting hash for echo loopback suppression, and updates binding status.
     */
    unprojectUiChanges(
        artifactId: string,
        primitiveData: any,
        currentDiskContent: Record<string, string> | string,
        context?: LensContext
    ): LensUnprojectionResult | undefined {
        const binding = this.bindings.get(artifactId);
        if (!binding) return undefined;

        const lens = this.registry.resolveByType(binding.lensType);
        if (!lens) {
            binding.status = 'error';
            binding.errorMessage = `No lens registered for type "${binding.lensType}"`;
            return undefined;
        }

        const unprojResult = lens.unproject(primitiveData, currentDiskContent, context);
        binding.lastSyncHash = unprojResult.contentHash;
        binding.lastSyncTimestamp = Date.now();
        binding.status = 'synced';
        binding.errorMessage = undefined;

        // Register hash to prevent watcher echo loops
        this.registerKnownInternalHash(unprojResult.contentHash);

        return unprojResult;
    }

    /**
     * Ingests live disk file content changes, applies the lens projection,
     * and returns the updated primitive data.
     */
    projectDiskChanges(
        artifactId: string,
        diskContent: Record<string, string> | string,
        context?: LensContext
    ): LensProjectionResult<any> | undefined {
        const binding = this.bindings.get(artifactId);
        if (!binding) return undefined;

        const lens = this.registry.resolveByType(binding.lensType);
        if (!lens) {
            binding.status = 'error';
            binding.errorMessage = `No lens registered for type "${binding.lensType}"`;
            return undefined;
        }

        const projResult = lens.project(diskContent, context);
        binding.lastSyncHash = projResult.contentHash;
        binding.lastSyncTimestamp = Date.now();
        binding.status = 'synced';
        binding.errorMessage = undefined;

        return projResult;
    }

    /**
     * Synchronizes a binding in the specified direction ('in' = disk -> UI, 'out' = UI -> disk).
     */
    sync(
        artifactId: string,
        direction: 'in' | 'out',
        payload: {
            diskContent?: Record<string, string> | string;
            primitiveData?: any;
        },
        context?: LensContext
    ): { success: boolean; result?: any; error?: string } {
        const binding = this.bindings.get(artifactId);
        if (!binding) {
            return { success: false, error: `Binding ${artifactId} not found` };
        }

        if (direction === 'in') {
            if (!payload.diskContent) {
                return { success: false, error: 'diskContent required for direction "in"' };
            }
            const proj = this.projectDiskChanges(artifactId, payload.diskContent, context);
            return proj ? { success: true, result: proj } : { success: false, error: binding.errorMessage };
        } else if (direction === 'out') {
            if (!payload.primitiveData) {
                return { success: false, error: 'primitiveData required for direction "out"' };
            }
            const unproj = this.unprojectUiChanges(
                artifactId,
                payload.primitiveData,
                payload.diskContent || {},
                context
            );
            return unproj ? { success: true, result: unproj } : { success: false, error: binding.errorMessage };
        }

        return { success: false, error: `Invalid direction "${direction}"` };
    }
}

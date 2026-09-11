/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { PrimitiveType } from '../browser/generative-canvas/canvas-types';

export type LensSyncMode = 'live-bidirectional' | 'manual' | 'read-only';
export type LensSyncStatus = 'synced' | 'dirty-ui' | 'dirty-disk' | 'conflict' | 'error';

export interface CodebaseLensBinding {
    artifactId: string;
    lensType: PrimitiveType;
    primaryFilePath: string;
    associatedFilePaths?: string[];
    syncMode: LensSyncMode;
    lastSyncHash: string;
    lastSyncTimestamp: number;
    status: LensSyncStatus;
    errorMessage?: string;
    metadata?: Record<string, any>;
}

export interface LensContext {
    workspaceRoot?: string;
    preserveFormatting?: boolean;
    targetSubdirectory?: string;
    metadata?: Record<string, any>;
}

export interface LensProjectionResult<TPrimitiveData> {
    data: TPrimitiveData;
    contentHash: string;
    metadata?: Record<string, any>;
}

export interface LensUnprojectionResult {
    files: Record<string, string>;
    contentHash: string;
    modifiedFilePaths: string[];
    changeSummary?: string;
}

/**
 * Contract for a Bi-Directional Codebase Lens.
 * A Lens projects raw disk files into rich, interactive primitive schemas,
 * and unprojects UI changes back into precise, AST/syntax-preserving disk files.
 */
export interface CodebaseLens<TPrimitiveData = any> {
    readonly primitiveType: PrimitiveType;

    /**
     * Determines whether this lens can project the given file path or set of files.
     */
    canHandle(filePathOrFiles: string | Record<string, string>): boolean;

    /**
     * Project live disk file content into the primitive's visual data model.
     * @param sourceContent Single file content string or a map of { relativeFilePath: content }
     * @param context Context options for projection
     */
    project(sourceContent: Record<string, string> | string, context?: LensContext): LensProjectionResult<TPrimitiveData>;

    /**
     * Unprojects modified primitive data back into disk files.
     * Preserves formatting, comments, and unedited AST nodes.
     * @param primitiveData The interactive visual data from the canvas primitive
     * @param currentDiskContent The baseline/existing disk content map or string
     * @param context Context options for unprojection
     */
    unproject(
        primitiveData: TPrimitiveData,
        currentDiskContent: Record<string, string> | string,
        context?: LensContext
    ): LensUnprojectionResult;
}

/**
 * Computes a fast deterministic SHA-like content hash for single strings or file maps.
 */
export function computeMultiFileHash(files: Record<string, string> | string): string {
    if (typeof files === 'string') {
        let hash = 5381;
        for (let i = 0; i < files.length; i++) {
            hash = (hash * 33) ^ files.charCodeAt(i);
        }
        return `h_${(hash >>> 0).toString(16).padStart(8, '0')}_${files.length}`;
    }

    const sortedKeys = Object.keys(files).sort();
    let combined = '';
    for (const key of sortedKeys) {
        combined += `${key}:${files[key]};`;
    }

    let hash = 5381;
    for (let i = 0; i < combined.length; i++) {
        hash = (hash * 33) ^ combined.charCodeAt(i);
    }
    return `h_${(hash >>> 0).toString(16).padStart(8, '0')}_${combined.length}`;
}

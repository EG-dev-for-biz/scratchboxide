/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as crypto from 'crypto';

export type FileChangeType = 'create' | 'update' | 'delete' | 'rename' | 'change';

export interface WorkspaceFileChangeEvent {
    path: string;
    changeType: FileChangeType;
    hash?: string;
    previousHash?: string;
    timestamp: number;
    content?: string;
    isExternal?: boolean;
    source?: 'external' | 'internal' | 'ide';
}

export interface WorkspaceSyncStreamEvent {
    id?: string;
    event: 'file-change' | 'sync-status' | 'ping' | 'error';
    data: WorkspaceFileChangeEvent | { status: string; timestamp: number } | { error: string };
    timestamp: number;
}

export interface WorkspaceWatchedPathConfig {
    patterns: string[];
    ignoredPatterns?: string[];
    debounceMs?: number;
}

export const DEFAULT_WATCHED_PATTERNS = [
    'src/components/**/*',
    'docs/**/*',
    'workflows/**/*',
    '.scratchbox/**/*'
];

/**
 * Fast deterministic hash calculation for file contents to detect mutations
 * and suppress self-induced echo loopbacks.
 */
export function createFileChangeHash(content: string | Buffer): string {
    if (!content) {
        return 'empty-hash-0000';
    }
    const normalized = typeof content === 'string' ? content : content.toString('utf-8');
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

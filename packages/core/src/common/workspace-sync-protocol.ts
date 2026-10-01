/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export type FileChangeType = 'create' | 'update' | 'delete' | 'rename' | 'change';

export interface FileTreeNode {
    name: string;
    path: string;
    isFolder: boolean;
    children?: FileTreeNode[];
}

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
    try {
        if (typeof window === 'undefined') {
            const nodeCrypto = require('crypto');
            if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
                return nodeCrypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
            }
        }
    } catch {
        // Fallback for non-node environments
    }
    // Fast deterministic FNV-1a hash for browser contexts
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 16);
}

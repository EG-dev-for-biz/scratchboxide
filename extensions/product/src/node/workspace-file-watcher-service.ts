/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable, optional, inject } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    FileChangeType,
    WorkspaceFileChangeEvent,
    createFileChangeHash,
    DEFAULT_WATCHED_PATTERNS
} from '../common/workspace-sync-protocol';

export type FileChangeCallback = (event: WorkspaceFileChangeEvent) => void;

interface SSEClientConnection {
    res: any;
    id: string;
}

@injectable()
export class WorkspaceFileWatcherService {
    @inject(ILogger) @optional()
    protected readonly logger?: ILogger;

    private activeWatchers: fs.FSWatcher[] = [];
    private knownFileHashes: Map<string, string> = new Map();
    private registeredInternalHashes: Map<string, { hash: string; expiresAt: number }> = new Map();
    private sseClients: SSEClientConnection[] = [];
    private changeListeners: Set<FileChangeCallback> = new Set();
    private currentWorkspaceRoot?: string;
    private watchedPatterns: string[] = [...DEFAULT_WATCHED_PATTERNS];
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

    /**
     * Get list of currently watched glob patterns.
     */
    getWatchedPatterns(): string[] {
        return [...this.watchedPatterns];
    }

    /**
     * Start watching key workspace directories (src/components, docs, workflows, .scratchbox).
     */
    startWatching(workspaceRoot: string, patterns?: string[]): void {
        this.stopWatching();
        this.currentWorkspaceRoot = workspaceRoot;
        if (patterns && patterns.length > 0) {
            this.watchedPatterns = patterns;
        }

        const candidateDirs = [
            path.join(workspaceRoot, 'src', 'components'),
            path.join(workspaceRoot, 'docs'),
            path.join(workspaceRoot, 'workflows'),
            path.join(workspaceRoot, '.scratchbox'),
            path.join(workspaceRoot, 'src')
        ];

        for (const dir of candidateDirs) {
            try {
                if (fs.existsSync(dir)) {
                    this.watchDirectory(dir);
                }
            } catch (err: any) {
                this.logWarn(`Could not initialize watcher on ${dir}: ${err.message}`);
            }
        }
    }

    /**
     * Stop all active filesystem watchers.
     */
    stopWatching(): void {
        for (const watcher of this.activeWatchers) {
            try {
                watcher.close();
            } catch (err) {
                // Ignore watcher close errors
            }
        }
        this.activeWatchers = [];
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
    }

    /**
     * Recursively watches a directory for filesystem mutations.
     */
    private watchDirectory(dirPath: string): void {
        try {
            const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
                if (!filename) { return; }
                const fullPath = path.isAbsolute(filename) ? filename : path.join(dirPath, filename);
                this.handleDebouncedFsEvent(fullPath, eventType === 'rename' ? 'change' : 'update');
            });
            this.activeWatchers.push(watcher);
        } catch (err: any) {
            this.logWarn(`Failed to watch directory ${dirPath}: ${err.message}`);
        }
    }

    private handleDebouncedFsEvent(filePath: string, eventType: FileChangeType): void {
        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
            this.debounceTimers.delete(filePath);
            try {
                let content: string | undefined;
                let changeType: FileChangeType = eventType;

                if (await fs.pathExists(filePath)) {
                    const stat = await fs.stat(filePath);
                    if (stat.isFile()) {
                        content = await fs.readFile(filePath, 'utf-8');
                        changeType = 'update';
                    } else {
                        return; // Ignore directory modifications
                    }
                } else {
                    changeType = 'delete';
                }

                this.processFileChange(filePath, changeType, content);
            } catch (err: any) {
                this.logWarn(`Error reading file on change: ${filePath} (${err.message})`);
            }
        }, 150);

        this.debounceTimers.set(filePath, timer);
    }

    /**
     * Register a known hash generated internally (e.g. from IDE save/sync actions).
     * Suppresses echoing back self-induced changes within 10 seconds.
     */
    registerKnownHash(filePath: string, hash: string): void {
        const normalizedPath = path.normalize(filePath);
        this.registeredInternalHashes.set(normalizedPath, {
            hash,
            expiresAt: Date.now() + 10000
        });
        this.knownFileHashes.set(normalizedPath, hash);
    }

    /**
     * Checks if the given file hash was registered internally to prevent loopbacks.
     */
    isKnownHash(filePath: string, hash: string): boolean {
        const normalizedPath = path.normalize(filePath);
        const entry = this.registeredInternalHashes.get(normalizedPath);
        if (!entry) {
            return false;
        }
        if (Date.now() > entry.expiresAt) {
            this.registeredInternalHashes.delete(normalizedPath);
            return false;
        }
        return entry.hash === hash;
    }

    /**
     * Process a file change. If the change matches an internally registered hash,
     * it is identified as a loopback and suppressed (returns true).
     * Otherwise, an external change event is created and broadcasted (returns false).
     */
    processFileChange(filePath: string, changeType: FileChangeType, content?: string): boolean {
        const normalizedPath = path.normalize(filePath);
        const currentHash = content !== undefined ? createFileChangeHash(content) : undefined;
        const previousHash = this.knownFileHashes.get(normalizedPath);

        // Check if this matches a registered internal write
        if (currentHash && this.isKnownHash(normalizedPath, currentHash)) {
            // Clean up the registered hash since it was processed
            this.registeredInternalHashes.delete(normalizedPath);
            return true; // Loopback suppressed
        }

        // If content and hash did not actually change from last known state, suppress
        if (currentHash && previousHash === currentHash && changeType === 'update') {
            return true;
        }

        if (currentHash) {
            this.knownFileHashes.set(normalizedPath, currentHash);
        } else if (changeType === 'delete') {
            this.knownFileHashes.delete(normalizedPath);
        }

        const relativePath = this.currentWorkspaceRoot
            ? path.relative(this.currentWorkspaceRoot, normalizedPath)
            : normalizedPath;

        const event: WorkspaceFileChangeEvent = {
            path: relativePath,
            changeType,
            hash: currentHash,
            previousHash,
            timestamp: Date.now(),
            content,
            isExternal: true,
            source: 'external'
        };

        this.broadcastEvent(event);
        return false;
    }

    /**
     * Broadcasts event to all SSE stream clients and programmatic listeners.
     */
    broadcastEvent(event: WorkspaceFileChangeEvent): void {
        // Notify programmatic listeners
        for (const listener of this.changeListeners) {
            try {
                listener(event);
            } catch (err: any) {
                this.logWarn(`Error in file change listener: ${err.message}`);
            }
        }

        // Stream via SSE to connected browser clients
        const ssePayload = `event: file-change\ndata: ${JSON.stringify(event)}\n\n`;
        this.sseClients = this.sseClients.filter(client => {
            try {
                client.res.write(ssePayload);
                return true;
            } catch (err) {
                return false;
            }
        });
    }

    /**
     * Attach an active HTTP response as an SSE client.
     */
    addSSEClient(res: any): void {
        const clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        this.sseClients.push({ res, id: clientId });

        // Send initial connection handshake
        try {
            res.write(`event: sync-status\ndata: ${JSON.stringify({ status: 'connected', timestamp: Date.now() })}\n\n`);
        } catch (err) {
            // Client closed immediately
        }
    }

    /**
     * Detach an SSE client on disconnect.
     */
    removeSSEClient(res: any): void {
        this.sseClients = this.sseClients.filter(c => c.res !== res);
    }

    /**
     * Subscribe to programmatic file change events.
     */
    onFileChange(callback: FileChangeCallback): () => void {
        this.changeListeners.add(callback);
        return () => this.changeListeners.delete(callback);
    }

    private logWarn(msg: string): void {
        if (this.logger) {
            this.logger.warn(msg);
        }
    }
}

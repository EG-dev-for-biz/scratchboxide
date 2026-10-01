/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'dirty' | 'error';

export interface BufferDirtyRecord {
    id: string;
    originalHash: string;
    currentHash: string;
    isDirty: boolean;
    saveStatus: SaveStatus;
    lastSavedTimestamp?: number;
}

/**
 * Fast deterministic string hashing for buffer contents.
 */
export function computeContentHash(content: string): string {
    if (!content) {
        return 'h_00000000';
    }
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
        hash = (hash * 33) ^ content.charCodeAt(i);
    }
    // Convert to unsigned 32-bit hex
    const hex = (hash >>> 0).toString(16).padStart(8, '0');
    return `h_${hex}_${content.length}`;
}

export class DirtyStateManager {
    private buffers: Map<string, BufferDirtyRecord> = new Map();
    private autoSaveTimers: Map<string, any> = new Map();

    /**
     * Start tracking a buffer baseline with its initial pristine content.
     */
    trackBuffer(id: string, initialContent: string): void {
        const hash = computeContentHash(initialContent);
        this.buffers.set(id, {
            id,
            originalHash: hash,
            currentHash: hash,
            isDirty: false,
            saveStatus: 'saved',
            lastSavedTimestamp: Date.now()
        });
    }

    /**
     * Update buffer with new content and re-calculate dirty status.
     * Returns true if dirty state changed, false otherwise.
     */
    updateBuffer(id: string, currentContent: string): boolean {
        const currentHash = computeContentHash(currentContent);
        const record = this.buffers.get(id);

        if (!record) {
            // Automatically start tracking if not previously tracked
            this.buffers.set(id, {
                id,
                originalHash: currentHash,
                currentHash,
                isDirty: false,
                saveStatus: 'saved',
                lastSavedTimestamp: Date.now()
            });
            return false;
        }

        const wasDirty = record.isDirty;
        const isDirty = currentHash !== record.originalHash;
        record.currentHash = currentHash;
        record.isDirty = isDirty;
        record.saveStatus = isDirty ? 'dirty' : 'saved';

        return wasDirty !== isDirty;
    }

    /**
     * Mark a buffer as saved, updating its baseline hash to current content.
     */
    markSaved(id: string, savedContent?: string): void {
        const record = this.buffers.get(id);
        if (!record) {
            if (savedContent !== undefined) {
                this.trackBuffer(id, savedContent);
            }
            return;
        }

        if (savedContent !== undefined) {
            const hash = computeContentHash(savedContent);
            record.originalHash = hash;
            record.currentHash = hash;
        } else {
            record.originalHash = record.currentHash;
        }

        record.isDirty = false;
        record.saveStatus = 'saved';
        record.lastSavedTimestamp = Date.now();
        this.cancelAutoSave(id);
    }

    /**
     * Check if a buffer is currently dirty against its baseline.
     */
    isDirty(id: string, currentContent?: string): boolean {
        const record = this.buffers.get(id);
        if (!record) {
            return false;
        }
        if (currentContent !== undefined) {
            const hash = computeContentHash(currentContent);
            return hash !== record.originalHash;
        }
        return record.isDirty;
    }

    /**
     * Get IDs of all currently dirty buffers.
     */
    getDirtyIds(): string[] {
        const dirtyIds: string[] = [];
        for (const [id, record] of this.buffers.entries()) {
            if (record.isDirty) {
                dirtyIds.push(id);
            }
        }
        return dirtyIds;
    }

    /**
     * Get the current save status of a buffer.
     */
    getSaveStatus(id: string): SaveStatus {
        const record = this.buffers.get(id);
        return record ? record.saveStatus : 'idle';
    }

    /**
     * Update save status for a buffer.
     */
    setSaveStatus(id: string, status: SaveStatus): void {
        const record = this.buffers.get(id);
        if (record) {
            record.saveStatus = status;
        }
    }

    /**
     * Schedule a debounced auto-save callback for a specific buffer.
     */
    scheduleDebouncedAutoSave(
        id: string,
        saveFn: () => Promise<void> | void,
        delayMs: number = 1500
    ): void {
        this.cancelAutoSave(id);
        this.setSaveStatus(id, 'saving');

        const timer = setTimeout(async () => {
            this.autoSaveTimers.delete(id);
            try {
                await saveFn();
                this.markSaved(id);
            } catch (err) {
                this.setSaveStatus(id, 'error');
            }
        }, delayMs);

        this.autoSaveTimers.set(id, timer);
    }

    /**
     * Cancel any scheduled auto-save for a buffer.
     */
    cancelAutoSave(id: string): void {
        const timer = this.autoSaveTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.autoSaveTimers.delete(id);
        }
    }

    /**
     * Reset all tracked buffers and timers.
     */
    reset(): void {
        for (const timer of this.autoSaveTimers.values()) {
            clearTimeout(timer);
        }
        this.autoSaveTimers.clear();
        this.buffers.clear();
    }
}

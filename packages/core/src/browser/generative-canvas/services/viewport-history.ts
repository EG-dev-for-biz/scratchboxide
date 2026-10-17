/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One ordered undo/redo timeline for a 3D viewport.
 *
 * Every user-visible edit (a gizmo drag, a sculpt stroke, a material change, a delete, an agent tool
 * call, ...) is one entry: a free-text label plus a generic apply / revert pair. The timeline knows
 * nothing about what an entry does, so a tool nobody has written yet needs no change here.
 *
 * This module has no React and no Three.js dependency; the viewport, the operator engine and the
 * tests all share it.
 */

export interface HistoryReplayInfo {
    direction: 'undo' | 'redo';
    label: string;
}

export interface HistoryEntry {
    /** Free text shown in the toolbar tooltip ("Move Box 1"). */
    label: string;
    /** Approximate retained memory (bytes) of what the entry holds; drives the memory cap. */
    bytes: number;
    /** Re-applies the edit. Returns false when its target is gone (the entry is then dropped). */
    apply(info: HistoryReplayInfo): boolean | void;
    /** Reverses the edit. Returns false when its target is gone (the entry is then dropped). */
    revert(info: HistoryReplayInfo): boolean | void;
    /**
     * Folds a later entry into this one (repeated tweaks of one property: a slider drag). Returns the
     * combined entry, or null when the two are not the same edit.
     */
    merge?(later: HistoryEntry): HistoryEntry | null;
    /** Releases resources the entry holds (GPU geometry) once it can never run again. */
    dispose?(): void;
    /** Selection (free-text object id) to restore after undo / redo; `undefined` leaves it alone. */
    selection?: { undo?: string | null; redo?: string | null };
    /** Set by the history when the entry is recorded. */
    at?: number;
}

export interface ViewportHistoryOptions {
    maxEntries?: number;
    /** Soft cap on the summed `bytes` of retained entries; the newest entry is always kept. */
    maxBytes?: number;
    /** Two merge-able entries closer than this (ms) are one edit. */
    coalesceWindowMs?: number;
    now?: () => number;
    onRestoreSelection?: (id: string | null) => void;
}

export interface ViewportHistorySnapshot {
    canUndo: boolean;
    canRedo: boolean;
    undoLabel: string | null;
    redoLabel: string | null;
    undoCount: number;
    redoCount: number;
    bytes: number;
    version: number;
}

export const DEFAULT_HISTORY_MAX_ENTRIES = 200;
export const DEFAULT_HISTORY_MAX_BYTES = 96 * 1024 * 1024;
export const DEFAULT_COALESCE_WINDOW_MS = 750;

export class ViewportHistory {
    private undoStack: HistoryEntry[] = [];
    private redoStack: HistoryEntry[] = [];
    private listeners = new Set<() => void>();
    private version = 0;
    private cached: ViewportHistorySnapshot | null = null;
    private replaying = false;
    private lastRecordAt = 0;
    private readonly maxEntries: number;
    private readonly maxBytes: number;
    private readonly coalesceWindowMs: number;
    private readonly now: () => number;
    private readonly onRestoreSelection?: (id: string | null) => void;

    constructor(options: ViewportHistoryOptions = {}) {
        this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_HISTORY_MAX_ENTRIES);
        this.maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_HISTORY_MAX_BYTES);
        this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
        this.now = options.now ?? (() => Date.now());
        this.onRestoreSelection = options.onRestoreSelection;
    }

    /** True while an undo / redo is running: edits made by the replay itself are not new history. */
    get isReplaying(): boolean {
        return this.replaying;
    }

    /** Records a finished edit. Clears redo (a new edit forks the timeline). */
    record(entry: HistoryEntry): void {
        if (this.replaying) {
            entry.dispose?.();
            return;
        }
        const at = this.now();
        entry.at = at;
        this.discardRedo();

        const top = this.undoStack[this.undoStack.length - 1];
        if (top?.merge && at - this.lastRecordAt <= this.coalesceWindowMs) {
            const merged = top.merge(entry);
            if (merged) {
                merged.at = at;
                merged.selection = top.selection ?? merged.selection;
                this.undoStack[this.undoStack.length - 1] = merged;
                this.lastRecordAt = at;
                this.touch();
                return;
            }
        }
        this.undoStack.push(entry);
        this.lastRecordAt = at;
        this.enforceCaps();
        this.touch();
    }

    undo(): HistoryEntry | null {
        while (this.undoStack.length > 0) {
            const entry = this.undoStack.pop()!;
            const ok = this.run(() => entry.revert({ direction: 'undo', label: entry.label }));
            if (ok === false) {
                entry.dispose?.();
                continue;
            }
            this.redoStack.push(entry);
            this.restoreSelection(entry.selection?.undo);
            this.lastRecordAt = 0;
            this.touch();
            return entry;
        }
        this.touch();
        return null;
    }

    redo(): HistoryEntry | null {
        while (this.redoStack.length > 0) {
            const entry = this.redoStack.pop()!;
            const ok = this.run(() => entry.apply({ direction: 'redo', label: entry.label }));
            if (ok === false) {
                entry.dispose?.();
                continue;
            }
            this.undoStack.push(entry);
            this.restoreSelection(entry.selection?.redo);
            this.lastRecordAt = 0;
            this.touch();
            return entry;
        }
        this.touch();
        return null;
    }

    canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    /** Scene loaded / rebuilt: nothing recorded against the old content can run any more. */
    clear(): void {
        for (const e of this.undoStack) e.dispose?.();
        this.discardRedo();
        this.undoStack = [];
        this.lastRecordAt = 0;
        this.touch();
    }

    /** Oldest-first labels, for diagnostics and the agent-facing history note. */
    labels(): { undo: string[]; redo: string[] } {
        return { undo: this.undoStack.map(e => e.label), redo: this.redoStack.map(e => e.label).reverse() };
    }

    getSnapshot = (): ViewportHistorySnapshot => {
        if (!this.cached || this.cached.version !== this.version) {
            const topUndo = this.undoStack[this.undoStack.length - 1];
            const topRedo = this.redoStack[this.redoStack.length - 1];
            this.cached = {
                canUndo: this.undoStack.length > 0,
                canRedo: this.redoStack.length > 0,
                undoLabel: topUndo ? topUndo.label : null,
                redoLabel: topRedo ? topRedo.label : null,
                undoCount: this.undoStack.length,
                redoCount: this.redoStack.length,
                bytes: this.totalBytes(),
                version: this.version
            };
        }
        return this.cached;
    };

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    private run<T>(fn: () => T): T {
        this.replaying = true;
        try {
            return fn();
        } finally {
            this.replaying = false;
        }
    }

    private restoreSelection(id: string | null | undefined): void {
        if (id === undefined) return;
        this.onRestoreSelection?.(id);
    }

    private totalBytes(): number {
        let sum = 0;
        for (const e of this.undoStack) sum += e.bytes;
        for (const e of this.redoStack) sum += e.bytes;
        return sum;
    }

    private discardRedo(): void {
        for (const e of this.redoStack) e.dispose?.();
        this.redoStack = [];
    }

    private enforceCaps(): void {
        let bytes = this.totalBytes();
        while (this.undoStack.length > 1 && (this.undoStack.length > this.maxEntries || bytes > this.maxBytes)) {
            const dropped = this.undoStack.shift()!;
            bytes -= dropped.bytes;
            dropped.dispose?.();
        }
    }

    private touch(): void {
        this.version++;
        this.cached = null;
        for (const l of Array.from(this.listeners)) l();
    }
}

/** Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z and Ctrl/Cmd+Y; null for any other key or while typing in a field. */
export function resolveHistoryShortcut(
    e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
    active: { tagName?: string; isContentEditable?: boolean } | null | undefined
): 'undo' | 'redo' | null {
    const tag = (active?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || active?.isContentEditable) return null;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
    const key = e.key.toLowerCase();
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && !e.shiftKey) return 'redo';
    return null;
}

/**
 * Installs the undo / redo keyboard shortcuts on `target` (the window). Returns the detach function.
 * `getActive` defaults to the focused element so typing in a field never triggers an undo.
 */
export function attachHistoryShortcuts(
    target: EventTarget,
    handlers: { undo: () => unknown; redo: () => unknown },
    getActive: () => { tagName?: string; isContentEditable?: boolean } | null | undefined =
        () => (typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null)
): () => void {
    const onKeyDown = (event: Event) => {
        const e = event as KeyboardEvent;
        const action = resolveHistoryShortcut(e, getActive());
        if (!action) return;
        e.preventDefault();
        if (action === 'redo') handlers.redo();
        else handlers.undo();
    };
    target.addEventListener('keydown', onKeyDown);
    return () => target.removeEventListener('keydown', onKeyDown);
}

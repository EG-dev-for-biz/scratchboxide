/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';

/**
 * A value computed from files, kept per process and computed again only when one of the files changed (path, size
 * or mtime) or appeared/disappeared. For results that cost a full read and parse (motion tracks, PLY splats) that
 * several tool calls ask for in a row.
 */
export class FileStatCache<T> {
    private readonly entries = new Map<string, { signature: string; value: T }>();

    constructor(private readonly maxEntries = 64) {}

    get(key: string, files: string[], compute: () => T): T {
        const signature = files.map(f => {
            try {
                const st = fs.statSync(f);
                return `${f}|${st.size}|${st.mtimeMs}`;
            } catch {
                return `${f}|-`;
            }
        }).join('\n');
        const held = this.entries.get(key);
        if (held && held.signature === signature) {
            this.entries.delete(key);
            this.entries.set(key, held);
            return held.value;
        }
        const value = compute();
        this.entries.set(key, { signature, value });
        if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
        return value;
    }

    clear(): void {
        this.entries.clear();
    }
}

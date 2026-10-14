/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Combine disk and browser-cache sessions: one entry per id, keeping whichever copy has more messages. */
export function mergeChatSessions<T extends { id: string; messages?: unknown[] }>(disk: T[], cached: T[]): T[] {
    const byId = new Map<string, T>();
    for (const s of [...disk, ...cached]) {
        const existing = byId.get(s.id);
        if (!existing || (s.messages?.length || 0) > (existing.messages?.length || 0)) byId.set(s.id, s);
    }
    const order = [...cached.map(s => s.id), ...disk.map(s => s.id)];
    return [...new Set(order)].map(id => byId.get(id)!);
}

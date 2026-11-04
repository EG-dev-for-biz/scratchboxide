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

/**
 * The open chat's messages once its copy on disk has been read, or undefined when the open copy already holds every
 * message disk does. The browser cache can hold an older copy of a chat than disk (a new browser profile, a cleared
 * cache, another window), and the open chat is written back whole, so a save of the older copy would drop what only
 * disk held. Disk's messages come first, then any the open copy holds that disk does not (said since, or before the
 * read arrived); with none of those, the result is disk's own array.
 */
export function openChatMessagesAfterDiskRead<M extends { id: string }>(open: M[], disk: M[]): M[] | undefined {
    const openIds = new Set(open.map(m => m.id));
    if (disk.every(m => openIds.has(m.id))) return undefined;
    const diskIds = new Set(disk.map(m => m.id));
    const onlyOpen = open.filter(m => !diskIds.has(m.id));
    return onlyOpen.length > 0 ? [...disk, ...onlyOpen] : disk;
}

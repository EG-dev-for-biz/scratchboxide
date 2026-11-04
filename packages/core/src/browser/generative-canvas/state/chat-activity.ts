/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What a chat holds and when it last changed. Opening a chat to look at it, or showing one of its artifacts, is not
 * a change: the chat is not written to disk, its age is kept and its artifacts are not sent to the (paid) background
 * visual check. A new message, or an artifact version it did not hold before, is.
 */

interface VersionedArtifact {
    id: string;
    version?: number;
}

/** One artifact version: its id and version number. */
export function artifactVersionKey(artifact: VersionedArtifact): string {
    return `${artifact.id}-v${artifact.version || 1}`;
}

/** Every artifact version a chat holds: in its messages, its artifact history and the artifact on stage. */
export function chatArtifactVersionKeys(
    messages: ReadonlyArray<{ artifacts?: VersionedArtifact[] }>,
    activeArtifact: VersionedArtifact | undefined,
    artifactHistory: ReadonlyArray<VersionedArtifact> | undefined
): Set<string> {
    const keys = new Set<string>();
    for (const m of messages) for (const a of m.artifacts ?? []) keys.add(artifactVersionKey(a));
    for (const a of artifactHistory ?? []) keys.add(artifactVersionKey(a));
    if (activeArtifact) keys.add(artifactVersionKey(activeArtifact));
    return keys;
}

interface ChatContent {
    messages: ReadonlyArray<{ artifacts?: VersionedArtifact[] }>;
    activeArtifact?: VersionedArtifact;
    artifactHistory?: ReadonlyArray<VersionedArtifact>;
}

/** The open chat as its next change is measured against: as opened, as disk holds it once read, or as last written. */
export interface ChatBaseline {
    id: string;
    /** How many times a saved chat had been opened (GenerativeCanvasStudio `chatOpenCountRef`). */
    opens: number;
    /** The workspace whose disk copy of the chats had been read; undefined before that read. */
    root?: string;
    messages: ChatContent['messages'];
    artifactKeys: Set<string>;
}

export type OpenChat = ChatContent & { id: string; opens: number; root?: string };

export function chatBaseline(open: OpenChat): ChatBaseline {
    return { id: open.id, opens: open.opens, root: open.root, messages: open.messages, artifactKeys: chatArtifactVersionKeys(open.messages, open.activeArtifact, open.artifactHistory) };
}

/**
 * Whether the open chat changed since `baseline` (a new message, or an artifact version it did not hold), and the
 * baseline to measure its next change against. A chat just opened is measured against itself: opening it is not a
 * change. Once disk's copy is read (`open.root` set; `onDisk`, what disk holds of this chat), it is measured against
 * that copy: the read is not a change, but an open copy holding what disk lacks (a demo launched before the read, a
 * message the last write missed) is.
 */
export function chatChangeSince(baseline: ChatBaseline | undefined, open: OpenChat, onDisk?: ChatContent): { changed: boolean; baseline: ChatBaseline } {
    const now = chatBaseline(open);
    let from = !baseline || baseline.id !== open.id || baseline.opens !== open.opens ? now : baseline;
    if (open.root !== undefined && from.root !== open.root) {
        from = onDisk
            ? { ...from, root: open.root, messages: onDisk.messages || [], artifactKeys: chatArtifactVersionKeys(onDisk.messages || [], onDisk.activeArtifact, onDisk.artifactHistory) }
            : { ...from, root: open.root };
    }
    const changed = now.messages.length > 0 && (now.messages !== from.messages || [...now.artifactKeys].some(k => !from.artifactKeys.has(k)));
    return { changed, baseline: from };
}

/**
 * Artifact versions that came from a saved chat as it was opened in this page (useArtifactSync notes them). A scene
 * among them is being looked at: the viewport restores its lost files from the asset store only and offers "Rebuild
 * this location" rather than rebuilding on its own (user decision, 2026-11-02). One set per page, like the asset
 * recovery client it steers.
 */
const openedChatVersions = new Set<string>();

export function noteOpenedChatArtifacts(keys: Iterable<string>): void {
    for (const key of keys) openedChatVersions.add(key);
}

/** Whether `artifact` is a version a saved chat held when it was opened (not made or edited in this page). */
export function isFromOpenedChat(artifact: VersionedArtifact | undefined): boolean {
    return !!artifact && openedChatVersions.has(artifactVersionKey(artifact));
}

/**
 * When a chat last changed, in ms since the epoch. `updatedAt` holds that time (ISO) once the chat has changed in this
 * version of the app; chats saved before hold the literal 'Just now', so their time is read from their newest message
 * id (`msg-<sender>-<Date.now()>`), else from when the file was last written (`savedAt`). Undefined for a chat with
 * none of these (an untouched new chat).
 */
export function chatUpdatedAtMs(session: { updatedAt?: string; savedAt?: number; messages?: ReadonlyArray<{ id?: string }> }): number | undefined {
    const stamped = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
    if (Number.isFinite(stamped)) return stamped;
    let newest: number | undefined;
    for (const m of session.messages ?? []) {
        const time = /-(\d{13})(?:-|$)/.exec(m?.id ?? '');
        if (time) newest = Math.max(newest ?? 0, Number(time[1]));
    }
    if (newest !== undefined) return newest;
    return typeof session.savedAt === 'number' && session.savedAt > 0 ? session.savedAt : undefined;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A chat's age for the chat list: "now", "5m", "3h", "2d", "3w", then its date ("Oct 12"; with the year when not this year). */
export function formatChatAge(updatedAtMs: number | undefined, nowMs: number = Date.now()): string {
    if (updatedAtMs === undefined) return '';
    const age = Math.max(0, nowMs - updatedAtMs);
    if (age < MINUTE) return 'now';
    if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
    if (age < DAY) return `${Math.floor(age / HOUR)}h`;
    if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`;
    if (age < 28 * DAY) return `${Math.floor(age / (7 * DAY))}w`;
    const date = new Date(updatedAtMs);
    const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

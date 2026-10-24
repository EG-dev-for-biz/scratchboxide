/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CloudBucket } from './cloud-store/cloud-bucket';
export { mergeChatSessions } from '../common/chat-session-merge';

/** A chat session as the studio stores it; the store only needs its id. */
export type StoredChatSession = { id: string; savedAt?: number; [key: string]: unknown };

export interface RecentProject {
    id: string;
    name: string;
    path: string;
    lastActive?: string;
    [key: string]: unknown;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Durable chat history: one JSON file per session in `<workspace>/.scratchbox/sessions/`, plus the
 * user's recent-project list in `~/.scratchbox-ide/projects.json`. Browser storage is only a cache.
 * With a cloud bucket, the bucket holds the main copy (`sessions/<workspace key>/<id>.json`): every save is
 * uploaded and every list brings both sides up to date, the newer `savedAt` winning.
 */
export class ChatSessionStore {
    private readonly uploads = new Map<string, { running: Promise<void>; again: boolean }>();

    constructor(private readonly homeDir: string = os.homedir(), private readonly bucket?: CloudBucket) {}

    private remotePrefix(workspaceRoot: string): string {
        const root = path.resolve(workspaceRoot || process.cwd());
        return `sessions/${crypto.createHash('sha256').update(root).digest('hex').slice(0, 16)}/`;
    }

    private sessionsDir(workspaceRoot: string): string {
        return path.join(path.resolve(workspaceRoot || process.cwd()), '.scratchbox', 'sessions');
    }

    private sessionFile(workspaceRoot: string, id: string): string {
        if (!SAFE_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
        return path.join(this.sessionsDir(workspaceRoot), `${id}.json`);
    }

    async list(workspaceRoot: string): Promise<StoredChatSession[]> {
        if (this.bucket) {
            await this.syncWithBucket(workspaceRoot).catch(err =>
                console.warn(`[cloud-store] chats not synced with ${this.bucket!.label}; showing this machine's copy: ${(err as Error).message}`));
        }
        const dir = this.sessionsDir(workspaceRoot);
        if (!(await fs.pathExists(dir))) return [];
        const sessions: StoredChatSession[] = [];
        for (const name of await fs.readdir(dir)) {
            if (!name.endsWith('.json')) continue;
            try {
                const session = await fs.readJson(path.join(dir, name));
                if (session && typeof session.id === 'string') sessions.push(session);
            } catch (err) {
                console.warn(`[ChatSessionStore] Skipping unreadable session ${name}`, err);
            }
        }
        return sessions.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    }

    async save(workspaceRoot: string, session: StoredChatSession): Promise<StoredChatSession> {
        if (!session || typeof session.id !== 'string') throw new Error('session.id is required');
        const file = this.sessionFile(workspaceRoot, session.id);
        const stored = { ...session, savedAt: Date.now() };
        await fs.ensureDir(path.dirname(file));
        // Write then rename so a crash mid-write never leaves a truncated session.
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeJson(tmp, stored);
        await fs.move(tmp, file, { overwrite: true });
        if (this.bucket) {
            await this.upload(workspaceRoot, session.id).catch(err =>
                console.warn(`[cloud-store] chat ${session.id} saved on this machine, not yet in ${this.bucket!.label} (retried on the next list): ${(err as Error).message}`));
        }
        return stored;
    }

    async remove(workspaceRoot: string, id: string): Promise<void> {
        await fs.remove(this.sessionFile(workspaceRoot, id));
        if (this.bucket) await this.bucket.remove(`${this.remotePrefix(workspaceRoot)}${id}.json`);
    }

    /** Downloads sessions the bucket has newer, uploads sessions this machine has newer. */
    private async syncWithBucket(workspaceRoot: string): Promise<void> {
        const bucket = this.bucket!;
        const dir = this.sessionsDir(workspaceRoot);
        const prefix = this.remotePrefix(workspaceRoot);
        const remote = new Map<string, number>();
        for (const obj of await bucket.list(prefix)) {
            const id = obj.key.slice(prefix.length).replace(/\.json$/, '');
            if (obj.key.endsWith('.json') && SAFE_ID.test(id)) remote.set(id, Number(obj.metadata.savedAt) || 0);
        }
        const local = new Map<string, number>();
        if (await fs.pathExists(dir)) {
            for (const name of await fs.readdir(dir)) {
                const id = name.replace(/\.json$/, '');
                if (!name.endsWith('.json') || !SAFE_ID.test(id)) continue;
                const session = await fs.readJson(path.join(dir, name)).catch(() => undefined);
                if (session && typeof session.id === 'string') local.set(id, Number(session.savedAt) || 0);
            }
        }
        for (const [id, remoteSavedAt] of remote) {
            const localSavedAt = local.get(id);
            if (localSavedAt !== undefined && localSavedAt >= remoteSavedAt) continue;
            const file = this.sessionFile(workspaceRoot, id);
            await fs.ensureDir(dir);
            const tmp = `${file}.${process.pid}.download.tmp`;
            try {
                if (!(await bucket.download(`${prefix}${id}.json`, tmp))) continue;
                const session = await fs.readJson(tmp);
                if (session?.id !== id) throw new Error(`downloaded chat ${id} holds id ${JSON.stringify(session?.id)}`);
                await fs.move(tmp, file, { overwrite: true });
            } finally {
                await fs.remove(tmp);
            }
        }
        for (const [id, localSavedAt] of local) {
            const remoteSavedAt = remote.get(id);
            if (remoteSavedAt === undefined || localSavedAt > remoteSavedAt) await this.upload(workspaceRoot, id);
        }
    }

    /** Uploads the session file as it is now; saves that land while an upload runs are folded into one more upload. */
    private upload(workspaceRoot: string, id: string): Promise<void> {
        const key = `${this.remotePrefix(workspaceRoot)}${id}.json`;
        const pending = this.uploads.get(key);
        if (pending) {
            pending.again = true;
            return pending.running;
        }
        const entry = { running: Promise.resolve(), again: false };
        entry.running = (async () => {
            try {
                do {
                    entry.again = false;
                    const file = this.sessionFile(workspaceRoot, id);
                    if (!(await fs.pathExists(file))) return;
                    const { savedAt } = await fs.readJson(file);
                    await this.bucket!.putFile(key, file, {
                        contentType: 'application/json',
                        metadata: { savedAt: String(Number(savedAt) || 0), workspaceRoot: path.resolve(workspaceRoot || process.cwd()) }
                    });
                } while (entry.again);
            } finally {
                this.uploads.delete(key);
            }
        })();
        this.uploads.set(key, entry);
        return entry.running;
    }

    private projectsFile(): string {
        return path.join(this.homeDir, '.scratchbox-ide', 'projects.json');
    }

    async listProjects(): Promise<RecentProject[]> {
        try {
            const data = await fs.readJson(this.projectsFile());
            return Array.isArray(data) ? data.filter(p => p && typeof p.id === 'string' && typeof p.path === 'string') : [];
        } catch {
            return [];
        }
    }

    async saveProjects(projects: RecentProject[]): Promise<void> {
        await fs.ensureDir(path.dirname(this.projectsFile()));
        await fs.writeJson(this.projectsFile(), projects.slice(0, 50), { spaces: 2 });
    }
}

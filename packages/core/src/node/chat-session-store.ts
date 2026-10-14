/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
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
 */
export class ChatSessionStore {
    constructor(private readonly homeDir: string = os.homedir()) {}

    private sessionsDir(workspaceRoot: string): string {
        return path.join(path.resolve(workspaceRoot || process.cwd()), '.scratchbox', 'sessions');
    }

    private sessionFile(workspaceRoot: string, id: string): string {
        if (!SAFE_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
        return path.join(this.sessionsDir(workspaceRoot), `${id}.json`);
    }

    async list(workspaceRoot: string): Promise<StoredChatSession[]> {
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
        return stored;
    }

    async remove(workspaceRoot: string, id: string): Promise<void> {
        await fs.remove(this.sessionFile(workspaceRoot, id));
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

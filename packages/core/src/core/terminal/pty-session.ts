/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Emitter, Event, IDisposable } from '../events';

export interface IPTYSessionOptions {
    id: string;
    title?: string;
    cwd?: string;
    shellPath?: string;
    shellArgs?: string[];
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    scrollbackLimit?: number;
}

export interface IPTYSession extends IDisposable {
    readonly id: string;
    readonly title: string;
    readonly cols: number;
    readonly rows: number;
    readonly onData: Event<string>;
    readonly onExit: Event<number>;
    readonly onResize: Event<{ cols: number; rows: number }>;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    getScrollbackBuffer(): string[];
    clear(): void;
}

export class PTYSession implements IPTYSession {
    readonly id: string;
    title: string;
    cols: number;
    rows: number;
    private readonly _scrollbackLimit: number;
    private readonly _scrollback: string[] = [];

    private readonly _onData = new Emitter<string>();
    private readonly _onExit = new Emitter<number>();
    private readonly _onResize = new Emitter<{ cols: number; rows: number }>();
    private _disposed = false;

    readonly onData: Event<string> = this._onData.event;
    readonly onExit: Event<number> = this._onExit.event;
    readonly onResize: Event<{ cols: number; rows: number }> = this._onResize.event;

    constructor(options: IPTYSessionOptions) {
        this.id = options.id;
        this.title = options.title || `Terminal ${options.id}`;
        this.cols = options.cols || 80;
        this.rows = options.rows || 24;
        this._scrollbackLimit = options.scrollbackLimit || 1000;
    }

    write(data: string): void {
        if (this._disposed) {
            return;
        }
        // Append to scrollback
        const lines = data.split('\n');
        for (const line of lines) {
            this._scrollback.push(line);
            if (this._scrollback.length > this._scrollbackLimit) {
                this._scrollback.shift();
            }
        }
        this._onData.fire(data);
    }

    resize(cols: number, rows: number): void {
        if (this._disposed) {
            return;
        }
        this.cols = cols;
        this.rows = rows;
        this._onResize.fire({ cols, rows });
    }

    getScrollbackBuffer(): string[] {
        return [...this._scrollback];
    }

    clear(): void {
        this._scrollback.length = 0;
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._onExit.fire(0);
        this._onData.dispose();
        this._onExit.dispose();
        this._onResize.dispose();
    }
}

export class PTYSessionManager implements IDisposable {
    private readonly _sessions = new Map<string, IPTYSession>();
    private readonly _onDidCreateSession = new Emitter<IPTYSession>();
    private readonly _onDidCloseSession = new Emitter<string>();

    readonly onDidCreateSession: Event<IPTYSession> = this._onDidCreateSession.event;
    readonly onDidCloseSession: Event<string> = this._onDidCloseSession.event;

    createSession(options: IPTYSessionOptions): IPTYSession {
        if (this._sessions.has(options.id)) {
            return this._sessions.get(options.id)!;
        }

        const session = new PTYSession(options);
        this._sessions.set(session.id, session);
        this._onDidCreateSession.fire(session);

        session.onExit(() => {
            this.closeSession(session.id);
        });

        return session;
    }

    getSession(id: string): IPTYSession | undefined {
        return this._sessions.get(id);
    }

    getSessions(): IPTYSession[] {
        return Array.from(this._sessions.values());
    }

    closeSession(id: string): void {
        const session = this._sessions.get(id);
        if (session) {
            this._sessions.delete(id);
            session.dispose();
            this._onDidCloseSession.fire(id);
        }
    }

    dispose(): void {
        for (const session of this._sessions.values()) {
            session.dispose();
        }
        this._sessions.clear();
        this._onDidCreateSession.dispose();
        this._onDidCloseSession.dispose();
    }
}

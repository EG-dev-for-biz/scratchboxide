/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The asset database: one SQLite file (Node's built-in node:sqlite, no native package) that indexes the durable asset
 * store. File bytes never go in it; it holds what each served path points at, where each file came from (its recipe),
 * and a log of every change, so a missing file can be found again or rebuilt and a project's history can be read back.
 *
 * Several app processes (worktrees, agents) share one database: WAL mode and a busy timeout make their writes queue
 * instead of fail.
 */

import * as fs from 'fs';
import * as path from 'path';
/** The part of node:sqlite this module uses (declared here: the installed Node types may predate the module). */
interface SqliteStatement {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
}
interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqliteStatement;
    close(): void;
}
type DatabaseSync = SqliteDatabase;
type StatementSync = SqliteStatement;

/**
 * node:sqlite is loaded at runtime, not imported: the bundlers in front of this code (Vite in tests, the renderer
 * build's dependency scan) do not know it as a built-in module yet. Node 22.13+ ships it without a flag.
 */
function loadSqlite(): { DatabaseSync: new (file: string) => DatabaseSync } {
    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const mod = typeof getBuiltin === 'function' ? getBuiltin.call(process, 'node:sqlite') : undefined;
    if (!mod) throw new Error(`node:sqlite is not available in this Node (${process.version}); the asset database needs Node 22.13 or newer`);
    return mod as { DatabaseSync: new (file: string) => DatabaseSync };
}

export const ASSET_DB_SCHEMA_VERSION = 1;

/** A file in the store, by content. */
export interface BlobRow {
    sha256: string;
    bytes: number;
    mime: string | null;
    storedAtMs: number;
}

/** A served path (the URL path the app hands out, e.g. /models/x.glb) and the blob it points at. */
export interface ServedRow {
    path: string;
    sha256: string;
    bytes: number;
    mime: string | null;
    /** The workspace that produced it (a checkout path); informative only. */
    workspace: string | null;
    /** Which part of the app recorded it (an open label: 'staged-location', 'generate_image', 'backfill', ...). */
    origin: string;
    recipeId: string | null;
    /** The path was pointed at a rebuilt file after the original was lost. */
    rebuilt: boolean;
    recordedAtMs: number;
}

/** How a file was made, enough to make it again. `body` is the producer's own JSON (a staged request, a prompt, ...). */
export interface RecipeRow {
    id: string;
    kind: string;
    workspace: string | null;
    body: unknown;
    createdAtMs: number;
}

export interface EventRow {
    id: number;
    atMs: number;
    kind: string;
    subject: string | null;
    sha256: string | null;
    detail: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (
    sha256 TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL,
    mime TEXT,
    stored_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS served (
    path TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL REFERENCES blobs(sha256),
    workspace TEXT,
    origin TEXT NOT NULL,
    recipe_id TEXT,
    rebuilt INTEGER NOT NULL DEFAULT 0,
    recorded_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS served_by_recipe ON served(recipe_id);
CREATE INDEX IF NOT EXISTS served_by_sha ON served(sha256);
CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    workspace TEXT,
    body TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT,
    sha256 TEXT,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS events_by_subject ON events(subject, id);
CREATE TABLE IF NOT EXISTS scanned (
    file TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    graph TEXT NOT NULL,
    artifacts INTEGER NOT NULL,
    revisions INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, workspace)
);
`;

/** A project graph as kept in the database: the whole graph JSON, keyed by project and the checkout that saved it. */
export interface ProjectRow {
    projectId: string;
    workspace: string;
    graph: string;
    artifacts: number;
    revisions: number;
    updatedAtMs: number;
}

export class AssetDb {
    readonly file: string;
    private readonly db: DatabaseSync;
    private readonly statements = new Map<string, StatementSync>();

    constructor(file: string) {
        this.file = path.resolve(file);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.db = new (loadSqlite().DatabaseSync)(this.file);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA busy_timeout = 5000');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec(SCHEMA);
        this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(ASSET_DB_SCHEMA_VERSION));
    }

    private stmt(sql: string): StatementSync {
        let s = this.statements.get(sql);
        if (!s) {
            s = this.db.prepare(sql);
            this.statements.set(sql, s);
        }
        return s;
    }

    /** Runs `fn` in one transaction; nothing is written when it throws. */
    transaction<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const out = fn();
            this.db.exec('COMMIT');
            return out;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    upsertBlob(row: Omit<BlobRow, 'storedAtMs'> & { storedAtMs?: number }): void {
        this.stmt('INSERT INTO blobs (sha256, bytes, mime, stored_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET mime = COALESCE(excluded.mime, blobs.mime)')
            .run(row.sha256, row.bytes, row.mime, row.storedAtMs ?? Date.now());
    }

    blob(sha256: string): BlobRow | undefined {
        const r = this.stmt('SELECT sha256, bytes, mime, stored_at_ms AS storedAtMs FROM blobs WHERE sha256 = ?').get(sha256) as Record<string, unknown> | undefined;
        return r ? { sha256: r.sha256 as string, bytes: Number(r.bytes), mime: (r.mime as string) ?? null, storedAtMs: Number(r.storedAtMs) } : undefined;
    }

    upsertServed(row: Omit<ServedRow, 'bytes' | 'mime' | 'recordedAtMs'> & { recordedAtMs?: number }): void {
        this.stmt('INSERT INTO served (path, sha256, workspace, origin, recipe_id, rebuilt, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?) '
            + 'ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, workspace = excluded.workspace, origin = excluded.origin, '
            + 'recipe_id = COALESCE(excluded.recipe_id, served.recipe_id), rebuilt = excluded.rebuilt, recorded_at_ms = excluded.recorded_at_ms')
            .run(row.path, row.sha256, row.workspace, row.origin, row.recipeId, row.rebuilt ? 1 : 0, row.recordedAtMs ?? Date.now());
    }

    served(servedPath: string): ServedRow | undefined {
        const r = this.stmt('SELECT s.path, s.sha256, b.bytes, b.mime, s.workspace, s.origin, s.recipe_id AS recipeId, s.rebuilt, s.recorded_at_ms AS recordedAtMs '
            + 'FROM served s JOIN blobs b ON b.sha256 = s.sha256 WHERE s.path = ?').get(servedPath) as Record<string, unknown> | undefined;
        return r ? toServed(r) : undefined;
    }

    servedByRecipe(recipeId: string): ServedRow[] {
        const rows = this.stmt('SELECT s.path, s.sha256, b.bytes, b.mime, s.workspace, s.origin, s.recipe_id AS recipeId, s.rebuilt, s.recorded_at_ms AS recordedAtMs '
            + 'FROM served s JOIN blobs b ON b.sha256 = s.sha256 WHERE s.recipe_id = ? ORDER BY s.path').all(recipeId) as Record<string, unknown>[];
        return rows.map(toServed);
    }

    countServed(): number {
        return Number((this.stmt('SELECT COUNT(*) AS n FROM served').get() as { n: number }).n);
    }

    upsertRecipe(row: Omit<RecipeRow, 'createdAtMs'> & { createdAtMs?: number }): void {
        this.stmt('INSERT INTO recipes (id, kind, workspace, body, created_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, workspace = excluded.workspace, body = excluded.body')
            .run(row.id, row.kind, row.workspace, JSON.stringify(row.body), row.createdAtMs ?? Date.now());
    }

    recipe(id: string): RecipeRow | undefined {
        const r = this.stmt('SELECT id, kind, workspace, body, created_at_ms AS createdAtMs FROM recipes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return r ? { id: r.id as string, kind: r.kind as string, workspace: (r.workspace as string) ?? null, body: JSON.parse(r.body as string), createdAtMs: Number(r.createdAtMs) } : undefined;
    }

    addEvent(kind: string, subject: string | null, sha256: string | null, detail?: unknown, atMs = Date.now()): void {
        this.stmt('INSERT INTO events (at_ms, kind, subject, sha256, detail) VALUES (?, ?, ?, ?, ?)')
            .run(atMs, kind, subject, sha256, detail === undefined ? null : JSON.stringify(detail));
    }

    events(opts: { subject?: string; limit?: number } = {}): EventRow[] {
        const limit = Math.max(1, Math.min(10_000, opts.limit ?? 200));
        const rows = (opts.subject !== undefined
            ? this.stmt('SELECT id, at_ms AS atMs, kind, subject, sha256, detail FROM events WHERE subject = ? ORDER BY id DESC LIMIT ?').all(opts.subject, limit)
            : this.stmt('SELECT id, at_ms AS atMs, kind, subject, sha256, detail FROM events ORDER BY id DESC LIMIT ?').all(limit)) as Record<string, unknown>[];
        return rows.map(r => ({
            id: Number(r.id), atMs: Number(r.atMs), kind: r.kind as string, subject: (r.subject as string) ?? null, sha256: (r.sha256 as string) ?? null,
            detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : null
        }));
    }

    /** The recorded hash of a file seen by a sweep, valid while its size and mtime are unchanged. */
    scanned(file: string, bytes: number, mtimeMs: number): string | undefined {
        const r = this.stmt('SELECT sha256 FROM scanned WHERE file = ? AND bytes = ? AND mtime_ms = ?').get(file, bytes, Math.floor(mtimeMs)) as { sha256: string } | undefined;
        return r?.sha256;
    }

    rememberScanned(file: string, bytes: number, mtimeMs: number, sha256: string): void {
        this.stmt('INSERT INTO scanned (file, bytes, mtime_ms, sha256) VALUES (?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET bytes = excluded.bytes, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256')
            .run(file, bytes, Math.floor(mtimeMs), sha256);
    }

    upsertProject(row: Omit<ProjectRow, 'updatedAtMs'> & { updatedAtMs?: number }): void {
        this.stmt('INSERT INTO projects (project_id, workspace, graph, artifacts, revisions, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?) '
            + 'ON CONFLICT(project_id, workspace) DO UPDATE SET graph = excluded.graph, artifacts = excluded.artifacts, revisions = excluded.revisions, updated_at_ms = excluded.updated_at_ms')
            .run(row.projectId, row.workspace, row.graph, row.artifacts, row.revisions, row.updatedAtMs ?? Date.now());
    }

    project(projectId: string, workspace: string): ProjectRow | undefined {
        const r = this.stmt('SELECT project_id AS projectId, workspace, graph, artifacts, revisions, updated_at_ms AS updatedAtMs FROM projects WHERE project_id = ? AND workspace = ?')
            .get(projectId, workspace) as Record<string, unknown> | undefined;
        return r ? toProject(r) : undefined;
    }

    /** The most recently saved copy of a project from any checkout. */
    latestProject(projectId: string): ProjectRow | undefined {
        const r = this.stmt('SELECT project_id AS projectId, workspace, graph, artifacts, revisions, updated_at_ms AS updatedAtMs FROM projects WHERE project_id = ? ORDER BY updated_at_ms DESC LIMIT 1')
            .get(projectId) as Record<string, unknown> | undefined;
        return r ? toProject(r) : undefined;
    }

    listProjects(): Array<Omit<ProjectRow, 'graph'>> {
        const rows = this.stmt('SELECT project_id AS projectId, workspace, artifacts, revisions, updated_at_ms AS updatedAtMs FROM projects ORDER BY updated_at_ms DESC').all() as Record<string, unknown>[];
        return rows.map(r => ({ projectId: r.projectId as string, workspace: r.workspace as string, artifacts: Number(r.artifacts), revisions: Number(r.revisions), updatedAtMs: Number(r.updatedAtMs) }));
    }

    close(): void {
        this.statements.clear();
        this.db.close();
    }
}

function toProject(r: Record<string, unknown>): ProjectRow {
    return { projectId: r.projectId as string, workspace: r.workspace as string, graph: r.graph as string, artifacts: Number(r.artifacts), revisions: Number(r.revisions), updatedAtMs: Number(r.updatedAtMs) };
}

function toServed(r: Record<string, unknown>): ServedRow {
    return {
        path: r.path as string, sha256: r.sha256 as string, bytes: Number(r.bytes), mime: (r.mime as string) ?? null,
        workspace: (r.workspace as string) ?? null, origin: r.origin as string, recipeId: (r.recipeId as string) ?? null,
        rebuilt: Number(r.rebuilt) === 1, recordedAtMs: Number(r.recordedAtMs)
    };
}

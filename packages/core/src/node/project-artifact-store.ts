/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The project graph on disk and in the durable store. Each save writes <workspace>/.scratchbox/project-artifacts.json
 * as before, and also keeps the graph in the asset database under the user's Scratchbox home (asset-store), with every
 * change between saves appended to the project's change log (events with subject "project:<id>"). A load reads the
 * checkout's file when it has one; otherwise the database copy for this checkout; otherwise the most recent copy from
 * any checkout, so a project follows the user when the checkout that made it is gone.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    ProjectArtifactGraph,
    createEmptyProjectGraph,
    parseProjectGraph,
    projectGraphFromObject,
    serializeProjectGraph
} from '../common/project-artifact-graph-protocol';
import { diffProjectGraphs, type ProjectChange } from '../common/project-graph-diff';
import { defaultDurableAssetStore, DurableAssetStore } from './asset-store/durable-asset-store';
import type { EventRow } from './asset-store/asset-db';

const GRAPH_FILE = 'project-artifacts.json';
/**
 * The graph file holds everything but the revisions' bodies (layout SPLIT_LAYOUT: `revisions` empty, `revisionIds` the
 * graph's revisions); each revision is its own file under REVISIONS_DIR, written once (a revision never changes). A save
 * then writes the small index and the new revisions only, instead of the whole history. A file without the layout (every
 * revision inside it) still loads, and is split at its next save.
 */
const SPLIT_LAYOUT = 'split/1';
const REVISIONS_DIR = 'project-revisions';

type GraphIndex = Omit<ProjectArtifactGraph, 'revisions'> & { revisions: Record<string, never>; layout: typeof SPLIT_LAYOUT; revisionIds: string[] };

let tempCounter = 0;

export function projectLogSubject(projectId: string): string {
    return `project:${projectId}`;
}

export class ProjectArtifactStore {
    /** Pending write per graph file; saves to the same file are chained so renames never race. */
    private readonly writeQueues = new Map<string, Promise<void>>();
    /** The last graph saved per file in this process, so a save's change log is diffed without re-reading the database. */
    private readonly lastSaved = new Map<string, ProjectArtifactGraph>();

    /** `durable` is the asset store; `null` runs without one (the file only). */
    constructor(private readonly durable: DurableAssetStore | null | undefined = undefined) {}

    private store(): DurableAssetStore | undefined {
        return this.durable === undefined ? defaultDurableAssetStore() : this.durable ?? undefined;
    }

    async load(workspaceRoot: string, projectId: string): Promise<ProjectArtifactGraph | undefined> {
        const root = this.resolveRoot(workspaceRoot);
        const filePath = this.resolvePath(workspaceRoot);
        if (await fs.pathExists(filePath)) {
            const graph = await this.readGraph(filePath);
            if (graph.project.id !== projectId) {
                throw new Error(`Stored graph belongs to ${graph.project.id}, not ${projectId}`);
            }
            this.importIfUnknown(root, graph);
            return graph;
        }
        const store = this.store();
        if (!store) return undefined;
        const own = store.db.project(projectId, root);
        if (own) return parseProjectGraph(own.graph);
        const latest = store.db.latestProject(projectId);
        if (!latest) return undefined;
        // the project follows the user: this checkout has no copy, another one saved it last
        const graph = parseProjectGraph(latest.graph);
        store.db.transaction(() => {
            store.db.upsertProject({ projectId, workspace: root, graph: latest.graph, artifacts: latest.artifacts, revisions: latest.revisions });
            store.db.addEvent('project.restored', projectLogSubject(projectId), null, { workspace: root, from: latest.workspace, artifacts: latest.artifacts, revisions: latest.revisions });
        });
        return graph;
    }

    async loadOrCreate(workspaceRoot: string, projectId: string): Promise<ProjectArtifactGraph> {
        return (await this.load(workspaceRoot, projectId)) || createEmptyProjectGraph(projectId);
    }

    /**
     * Atomically replaces the graph file and records the save in the durable store. Concurrent saves to the same
     * workspace are serialised in call order (last caller wins) and each write uses a unique temp file, so two writers
     * can never clobber each other's temp or rename.
     */
    save(workspaceRoot: string, graph: ProjectArtifactGraph): Promise<void> {
        const filePath = this.resolvePath(workspaceRoot);
        const root = this.resolveRoot(workspaceRoot);
        return this.queue(filePath, async () => {
            await this.writeSplit(filePath, graph, Object.keys(graph.revisions ?? {}));
            this.recordSave(root, filePath, graph);
        });
    }

    /**
     * A save of what changed: `part` is the graph with only the revisions the store does not hold yet (every other field
     * whole: artifacts, edges, heads, selection, commands). Its revisions are added to the stored ones and the rest
     * replaces the index, so a client never sends, nor can drop, the history it already saved. When a head names a
     * revision the store has neither held nor been sent, nothing is written and those revisions are returned (the client
     * sends them and saves again).
     */
    merge(workspaceRoot: string, part: ProjectArtifactGraph): Promise<{ missingRevisions: string[] }> {
        const filePath = this.resolvePath(workspaceRoot);
        const root = this.resolveRoot(workspaceRoot);
        return this.queue(filePath, async () => {
            const stored = await this.storedRevisionIds(filePath, part.project.id);
            const ids = new Set([...stored, ...Object.keys(part.revisions ?? {})]);
            const missingRevisions = [...new Set(Object.values(part.heads ?? {}))].filter(id => !ids.has(id));
            if (missingRevisions.length) return { missingRevisions };
            await this.writeSplit(filePath, part, [...ids]);
            if (this.store()) this.recordSave(root, filePath, await this.readGraph(filePath));
            return { missingRevisions };
        });
    }

    /** Saves to one graph file run one after another, in call order (last caller wins); a failure never blocks the next. */
    private queue<R>(filePath: string, work: () => Promise<R>): Promise<R> {
        const previous = this.writeQueues.get(filePath) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined) // a failed predecessor must not poison the queue
            .then(work);
        this.writeQueues.set(filePath, next as Promise<unknown> as Promise<void>);
        next.finally(() => {
            if (this.writeQueues.get(filePath) === next) {
                this.writeQueues.delete(filePath);
            }
        }).catch(() => undefined);
        return next;
    }

    /** The project's change log, newest first. */
    changeLog(projectId: string, limit = 200): EventRow[] {
        return this.store()?.events({ subject: projectLogSubject(projectId), limit }) ?? [];
    }

    /** Every project copy the durable store holds, newest first. */
    listProjects(): Array<{ projectId: string; workspace: string; artifacts: number; revisions: number; updatedAtMs: number }> {
        return this.store()?.db.listProjects() ?? [];
    }

    /** The graph in the database and the changes since the last save, in one transaction; a failure here never undoes the file write. */
    private recordSave(root: string, filePath: string, graph: ProjectArtifactGraph): void {
        const store = this.store();
        if (!store) return;
        try {
            const serialized = serializeProjectGraph(graph);
            const projectId = graph.project.id;
            const before = this.lastSaved.get(filePath) ?? this.previousGraph(store, projectId, root);
            const changes = diffProjectGraphs(before, graph);
            store.db.transaction(() => {
                store.db.upsertProject({ projectId, workspace: root, graph: serialized, artifacts: Object.keys(graph.artifacts ?? {}).length, revisions: Object.keys(graph.revisions ?? {}).length });
                for (const change of changes) store.db.addEvent(change.kind, projectLogSubject(projectId), null, withWorkspace(change, root));
            });
            // a copy: the caller keeps mutating its graph, and the next diff must see this save as it was
            this.lastSaved.set(filePath, parseProjectGraph(serialized));
        } catch (err) {
            console.warn(`[project-artifact-store] the save was written to ${filePath} but not recorded in the asset store: ${(err as Error).message}`);
        }
    }

    private previousGraph(store: DurableAssetStore, projectId: string, root: string): ProjectArtifactGraph | undefined {
        const row = store.db.project(projectId, root);
        if (!row) return undefined;
        try {
            return parseProjectGraph(row.graph);
        } catch {
            return undefined;
        }
    }

    /** A graph read from a checkout's file that the database has never seen is imported as it is (one event, no diff). */
    private importIfUnknown(root: string, graph: ProjectArtifactGraph): void {
        const store = this.store();
        if (!store) return;
        try {
            const projectId = graph.project.id;
            if (store.db.project(projectId, root)) return;
            const serialized = serializeProjectGraph(graph);
            store.db.transaction(() => {
                store.db.upsertProject({ projectId, workspace: root, graph: serialized, artifacts: Object.keys(graph.artifacts ?? {}).length, revisions: Object.keys(graph.revisions ?? {}).length });
                store.db.addEvent('project.imported', projectLogSubject(projectId), null, { workspace: root, artifacts: Object.keys(graph.artifacts ?? {}).length, revisions: Object.keys(graph.revisions ?? {}).length });
            });
            this.lastSaved.set(path.join(root, '.scratchbox', GRAPH_FILE), parseProjectGraph(serialized));
        } catch (err) {
            console.warn(`[project-artifact-store] ${graph.project.id} was read but not recorded in the asset store: ${(err as Error).message}`);
        }
    }

    /** The graph in a graph file, either layout: a split file's revisions read from their own files. */
    private async readGraph(filePath: string): Promise<ProjectArtifactGraph> {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (raw?.layout !== SPLIT_LAYOUT) return projectGraphFromObject(raw);
        const dir = path.join(path.dirname(filePath), REVISIONS_DIR);
        const revisions: Record<string, unknown> = {};
        for (const id of (raw.revisionIds ?? []) as string[]) {
            const file = path.join(dir, revisionFileName(id));
            try { revisions[id] = JSON.parse(await fs.readFile(file, 'utf8')); }
            catch { console.warn(`[project-artifact-store] revision ${id} is listed in ${filePath} but ${file} cannot be read`); }
        }
        delete raw.layout;
        delete raw.revisionIds;
        return projectGraphFromObject({ ...raw, revisions });
    }

    /** The revisions a graph file holds, without reading their bodies when it is split (a whole file is read once and split). */
    private async storedRevisionIds(filePath: string, projectId: string): Promise<string[]> {
        if (!(await fs.pathExists(filePath))) return [];
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (raw?.project?.id !== projectId) throw new Error(`Stored graph belongs to ${raw?.project?.id}, not ${projectId}`);
        if (raw.layout === SPLIT_LAYOUT) return raw.revisionIds ?? [];
        // a whole file (every revision inside it): its revisions go to their own files now, so they are not lost to the merge
        const whole = projectGraphFromObject(raw);
        const ids = Object.keys(whole.revisions);
        await this.writeSplit(filePath, whole, ids);
        return ids;
    }

    /**
     * Writes `graph` as the split layout listing `revisionIds`: each of `graph`'s revisions that has no file yet gets one
     * (a revision never changes, so an existing file is kept), then the small index replaces the graph file.
     */
    private async writeSplit(filePath: string, graph: ProjectArtifactGraph, revisionIds: string[]): Promise<void> {
        const dir = path.join(path.dirname(filePath), REVISIONS_DIR);
        await fs.ensureDir(dir);
        for (const [id, revision] of Object.entries(graph.revisions ?? {})) {
            const file = path.join(dir, revisionFileName(id));
            if (!(await fs.pathExists(file))) await this.writeAtomic(file, JSON.stringify(revision));
        }
        const index: GraphIndex = { ...graph, revisions: {}, layout: SPLIT_LAYOUT, revisionIds };
        await this.writeAtomic(filePath, JSON.stringify(index, undefined, 2));
    }

    private async writeAtomic(filePath: string, content: string): Promise<void> {
        await fs.ensureDir(path.dirname(filePath));
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`;
        try {
            await fs.writeFile(temporaryPath, content, 'utf8');
            await fs.rename(temporaryPath, filePath);
        } catch (err) {
            await fs.remove(temporaryPath).catch(() => undefined);
            throw err;
        }
    }

    private resolveRoot(workspaceRoot: string): string {
        return path.resolve(workspaceRoot || process.cwd());
    }

    private resolvePath(workspaceRoot: string): string {
        return path.join(this.resolveRoot(workspaceRoot), '.scratchbox', GRAPH_FILE);
    }
}

/** A revision's file name: its id hashed (ids are not safe path parts). */
function revisionFileName(id: string): string {
    return `${crypto.createHash('sha1').update(id).digest('hex')}.json`;
}

function withWorkspace(change: ProjectChange, workspace: string): ProjectChange & { workspace: string } {
    return { ...change, workspace };
}

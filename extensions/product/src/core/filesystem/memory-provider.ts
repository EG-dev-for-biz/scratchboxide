/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, Event, IDisposable, toDisposable } from '../events';
import { FileChangeEvent, FileChangeType, FileStat, FileSystemError, FileType, IFileSystemProvider } from './filesystem';
import { URI } from './uri';

interface MemoryNode {
    type: FileType;
    ctime: number;
    mtime: number;
    content?: Uint8Array;
    children?: Map<string, MemoryNode>;
}

export class InMemoryFileSystemProvider implements IFileSystemProvider, IDisposable {
    private readonly _root: MemoryNode = {
        type: FileType.Directory,
        ctime: Date.now(),
        mtime: Date.now(),
        children: new Map<string, MemoryNode>()
    };

    private readonly _onDidChangeFile = new Emitter<FileChangeEvent[]>();
    readonly onDidChangeFile: Event<FileChangeEvent[]> = this._onDidChangeFile.event;

    watch(_uri: URI, _options: { recursive: boolean; excludes: string[] }): IDisposable {
        return toDisposable(() => { });
    }

    private _lookup(uri: URI, silent: boolean = false): { node: MemoryNode; name: string; parent?: MemoryNode } | undefined {
        const segments = uri.path.split('/').filter(Boolean);
        let curr = this._root;
        let parent: MemoryNode | undefined = undefined;
        let name = '';

        for (let i = 0; i < segments.length; i++) {
            name = segments[i];
            if (curr.type !== FileType.Directory || !curr.children) {
                if (silent) return undefined;
                throw FileSystemError.FileNotADirectory(uri);
            }
            parent = curr;
            const child = curr.children.get(name);
            if (!child) {
                if (silent) return undefined;
                throw FileSystemError.FileNotFound(uri);
            }
            curr = child;
        }

        return { node: curr, name, parent };
    }

    async stat(uri: URI): Promise<FileStat> {
        const entry = this._lookup(uri);
        if (!entry) {
            throw FileSystemError.FileNotFound(uri);
        }
        return {
            type: entry.node.type,
            ctime: entry.node.ctime,
            mtime: entry.node.mtime,
            size: entry.node.content ? entry.node.content.byteLength : 0
        };
    }

    async exists(uri: URI): Promise<boolean> {
        return this._lookup(uri, true) !== undefined;
    }

    async readDirectory(uri: URI): Promise<[string, FileType][]> {
        const entry = this._lookup(uri);
        if (!entry || entry.node.type !== FileType.Directory || !entry.node.children) {
            throw FileSystemError.FileNotADirectory(uri);
        }
        const results: [string, FileType][] = [];
        for (const [name, child] of entry.node.children.entries()) {
            results.push([name, child.type]);
        }
        return results;
    }

    async createDirectory(uri: URI): Promise<void> {
        const segments = uri.path.split('/').filter(Boolean);
        let curr = this._root;

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (!curr.children) {
                curr.children = new Map();
            }
            let child = curr.children.get(seg);
            if (!child) {
                child = {
                    type: FileType.Directory,
                    ctime: Date.now(),
                    mtime: Date.now(),
                    children: new Map()
                };
                curr.children.set(seg, child);
            } else if (child.type !== FileType.Directory) {
                throw FileSystemError.FileNotADirectory(uri);
            }
            curr = child;
        }

        this._onDidChangeFile.fire([{ type: FileChangeType.Created, uri }]);
    }

    async readFile(uri: URI): Promise<Uint8Array> {
        const entry = this._lookup(uri);
        if (!entry || entry.node.type !== FileType.File || !entry.node.content) {
            if (entry && entry.node.type === FileType.Directory) {
                throw FileSystemError.FileIsADirectory(uri);
            }
            throw FileSystemError.FileNotFound(uri);
        }
        return entry.node.content;
    }

    async writeFile(uri: URI, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        const segments = uri.path.split('/').filter(Boolean);
        if (segments.length === 0) {
            throw FileSystemError.FileIsADirectory(uri);
        }

        const fileName = segments[segments.length - 1];
        const parentUri = uri.with({ path: '/' + segments.slice(0, -1).join('/') });

        let parentEntry = this._lookup(parentUri, true);
        if (!parentEntry) {
            if (options.create) {
                await this.createDirectory(parentUri);
                parentEntry = this._lookup(parentUri, false)!;
            } else {
                throw FileSystemError.FileNotFound(parentUri);
            }
        }

        if (parentEntry.node.type !== FileType.Directory || !parentEntry.node.children) {
            throw FileSystemError.FileNotADirectory(parentUri);
        }

        const existing = parentEntry.node.children.get(fileName);
        const now = Date.now();

        if (existing) {
            if (!options.overwrite) {
                throw FileSystemError.FileExists(uri);
            }
            if (existing.type === FileType.Directory) {
                throw FileSystemError.FileIsADirectory(uri);
            }
            existing.content = content;
            existing.mtime = now;
            this._onDidChangeFile.fire([{ type: FileChangeType.Changed, uri }]);
        } else {
            if (!options.create) {
                throw FileSystemError.FileNotFound(uri);
            }
            parentEntry.node.children.set(fileName, {
                type: FileType.File,
                ctime: now,
                mtime: now,
                content: content
            });
            this._onDidChangeFile.fire([{ type: FileChangeType.Created, uri }]);
        }
    }

    async delete(uri: URI, options?: { recursive?: boolean }): Promise<void> {
        const entry = this._lookup(uri);
        if (!entry || !entry.parent || !entry.parent.children) {
            throw FileSystemError.FileNotFound(uri);
        }

        if (entry.node.type === FileType.Directory && entry.node.children && entry.node.children.size > 0 && !options?.recursive) {
            throw new Error(`Directory not empty: ${uri.toString()}`);
        }

        entry.parent.children.delete(entry.name);
        this._onDidChangeFile.fire([{ type: FileChangeType.Deleted, uri }]);
    }

    async rename(oldUri: URI, newUri: URI, options: { overwrite: boolean }): Promise<void> {
        const oldEntry = this._lookup(oldUri);
        if (!oldEntry || !oldEntry.parent || !oldEntry.parent.children) {
            throw FileSystemError.FileNotFound(oldUri);
        }

        const newEntry = this._lookup(newUri, true);
        if (newEntry && !options.overwrite) {
            throw FileSystemError.FileExists(newUri);
        }

        const newSegments = newUri.path.split('/').filter(Boolean);
        const newName = newSegments[newSegments.length - 1];
        const newParentUri = newUri.with({ path: '/' + newSegments.slice(0, -1).join('/') });
        let newParentEntry = this._lookup(newParentUri, true);

        if (!newParentEntry) {
            await this.createDirectory(newParentUri);
            newParentEntry = this._lookup(newParentUri, false)!;
        }

        if (newParentEntry.node.type !== FileType.Directory || !newParentEntry.node.children) {
            throw FileSystemError.FileNotADirectory(newParentUri);
        }

        oldEntry.parent.children.delete(oldEntry.name);
        newParentEntry.node.children.set(newName, oldEntry.node);

        this._onDidChangeFile.fire([
            { type: FileChangeType.Deleted, uri: oldUri },
            { type: FileChangeType.Created, uri: newUri }
        ]);
    }

    dispose(): void {
        this._onDidChangeFile.dispose();
        this._root.children?.clear();
    }
}

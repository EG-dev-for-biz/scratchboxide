/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Emitter, Event, IDisposable, toDisposable } from '../events';
import { FileChangeEvent, FileChangeType, FileStat, FileSystemError, FileType, IFileSystemProvider } from './filesystem';
import { URI } from './uri';
import { DiskFileSystemProvider } from './disk-provider';
import { InMemoryFileSystemProvider } from './memory-provider';

export interface IWorkspaceFolder {
    readonly uri: URI;
    readonly name: string;
    readonly index: number;
}

export class WorkspaceManager implements IDisposable {
    private readonly _providers = new Map<string, IFileSystemProvider>();
    private readonly _providerDisposables = new Map<string, IDisposable>();
    private readonly _folders: IWorkspaceFolder[] = [];

    private readonly _onDidChangeWorkspaceFolders = new Emitter<{ added: IWorkspaceFolder[]; removed: IWorkspaceFolder[] }>();
    private readonly _onDidChangeFile = new Emitter<FileChangeEvent[]>();
    private readonly _onDidCreateFile = new Emitter<URI>();
    private readonly _onDidDeleteFile = new Emitter<URI>();

    readonly onDidChangeWorkspaceFolders: Event<{ added: IWorkspaceFolder[]; removed: IWorkspaceFolder[] }> = this._onDidChangeWorkspaceFolders.event;
    readonly onDidChangeFile: Event<FileChangeEvent[]> = this._onDidChangeFile.event;
    readonly onDidCreateFile: Event<URI> = this._onDidCreateFile.event;
    readonly onDidDeleteFile: Event<URI> = this._onDidDeleteFile.event;

    constructor() {
        // Register default providers
        this.registerProvider('file', new DiskFileSystemProvider());
        this.registerProvider('memory', new InMemoryFileSystemProvider());
    }

    registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable {
        const lowerScheme = scheme.toLowerCase();
        this._providers.set(lowerScheme, provider);

        const sub = provider.onDidChangeFile(events => {
            this._onDidChangeFile.fire(events);
            for (const e of events) {
                if (e.type === FileChangeType.Created) {
                    this._onDidCreateFile.fire(e.uri);
                } else if (e.type === FileChangeType.Deleted) {
                    this._onDidDeleteFile.fire(e.uri);
                }
            }
        });
        this._providerDisposables.set(lowerScheme, sub);

        return toDisposable(() => {
            if (this._providers.get(lowerScheme) === provider) {
                this._providers.delete(lowerScheme);
                const disp = this._providerDisposables.get(lowerScheme);
                if (disp) {
                    disp.dispose();
                    this._providerDisposables.delete(lowerScheme);
                }
            }
        });
    }

    getProvider(scheme: string): IFileSystemProvider | undefined {
        return this._providers.get(scheme.toLowerCase());
    }

    private _resolveProvider(uri: URI): IFileSystemProvider {
        const provider = this._providers.get(uri.scheme.toLowerCase());
        if (!provider) {
            throw FileSystemError.Unavailable(`No file system provider registered for scheme '${uri.scheme}'`);
        }
        return provider;
    }

    // Workspace Folder Management
    addFolder(folder: { uri: URI; name?: string }): void {
        const exists = this._folders.some(f => f.uri.toString() === folder.uri.toString());
        if (exists) {
            return;
        }

        const newFolder: IWorkspaceFolder = {
            uri: folder.uri,
            name: folder.name || folder.uri.path.split('/').filter(Boolean).pop() || 'Workspace',
            index: this._folders.length
        };

        this._folders.push(newFolder);
        this._onDidChangeWorkspaceFolders.fire({ added: [newFolder], removed: [] });
    }

    removeFolder(uri: URI): void {
        const idx = this._folders.findIndex(f => f.uri.toString() === uri.toString());
        if (idx !== -1) {
            const removed = this._folders.splice(idx, 1);
            // Re-index remaining folders
            this._folders.forEach((f, i) => {
                (f as any).index = i;
            });
            this._onDidChangeWorkspaceFolders.fire({ added: [], removed });
        }
    }

    getFolders(): IWorkspaceFolder[] {
        return [...this._folders];
    }

    getWorkspaceFolder(uri: URI): IWorkspaceFolder | undefined {
        const uriStr = uri.toString();
        // Find folder that is a prefix of uri
        return this._folders.find(f => uriStr.startsWith(f.uri.toString()));
    }

    // File Operations Facade
    async stat(uri: URI): Promise<FileStat> {
        return this._resolveProvider(uri).stat(uri);
    }

    async exists(uri: URI): Promise<boolean> {
        const provider = this._resolveProvider(uri);
        if (provider.exists) {
            return provider.exists(uri);
        }
        try {
            await provider.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    async readDirectory(uri: URI): Promise<[string, FileType][]> {
        return this._resolveProvider(uri).readDirectory(uri);
    }

    async createDirectory(uri: URI): Promise<void> {
        return this._resolveProvider(uri).createDirectory(uri);
    }

    async readFile(uri: URI): Promise<Uint8Array> {
        return this._resolveProvider(uri).readFile(uri);
    }

    async writeFile(uri: URI, content: Uint8Array, options?: { create?: boolean; overwrite?: boolean }): Promise<void> {
        return this._resolveProvider(uri).writeFile(uri, content, {
            create: options?.create ?? true,
            overwrite: options?.overwrite ?? true
        });
    }

    async delete(uri: URI, options?: { recursive?: boolean }): Promise<void> {
        return this._resolveProvider(uri).delete(uri, options);
    }

    async rename(oldUri: URI, newUri: URI, options?: { overwrite?: boolean }): Promise<void> {
        return this._resolveProvider(oldUri).rename(oldUri, newUri, {
            overwrite: options?.overwrite ?? false
        });
    }

    dispose(): void {
        for (const disp of this._providerDisposables.values()) {
            disp.dispose();
        }
        this._providerDisposables.clear();
        for (const provider of this._providers.values()) {
            if (typeof (provider as any).dispose === 'function') {
                (provider as any).dispose();
            }
        }
        this._providers.clear();
        this._folders.length = 0;
        this._onDidChangeWorkspaceFolders.dispose();
        this._onDidChangeFile.dispose();
        this._onDidCreateFile.dispose();
        this._onDidDeleteFile.dispose();
    }
}

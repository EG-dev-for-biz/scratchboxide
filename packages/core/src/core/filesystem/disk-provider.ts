/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { Emitter, Event, IDisposable, toDisposable } from '../events';
import { FileChangeEvent, FileChangeType, FileStat, FileSystemError, FileType, IFileSystemProvider } from './filesystem';
import { URI } from './uri';

export class DiskFileSystemProvider implements IFileSystemProvider, IDisposable {
    private readonly _onDidChangeFile = new Emitter<FileChangeEvent[]>();
    private readonly _watchers = new Map<string, fs.FSWatcher>();

    readonly onDidChangeFile: Event<FileChangeEvent[]> = this._onDidChangeFile.event;

    watch(uri: URI, options: { recursive: boolean; excludes: string[] }): IDisposable {
        const filePath = uri.fsPath;
        try {
            const watcher = fs.watch(filePath, { recursive: options.recursive }, (eventType, filename) => {
                if (filename) {
                    const changedPath = path.join(filePath, filename);
                    const changeType = eventType === 'rename'
                        ? (fs.existsSync(changedPath) ? FileChangeType.Created : FileChangeType.Deleted)
                        : FileChangeType.Changed;

                    this._onDidChangeFile.fire([{
                        type: changeType,
                        uri: URI.file(changedPath)
                    }]);
                }
            });
            this._watchers.set(filePath, watcher);

            return toDisposable(() => {
                watcher.close();
                this._watchers.delete(filePath);
            });
        } catch {
            return toDisposable(() => { });
        }
    }

    async stat(uri: URI): Promise<FileStat> {
        try {
            const stat = await fs.promises.stat(uri.fsPath);
            let type = FileType.Unknown;
            if (stat.isFile()) {
                type = FileType.File;
            } else if (stat.isDirectory()) {
                type = FileType.Directory;
            } else if (stat.isSymbolicLink()) {
                type = FileType.SymbolicLink;
            }

            return {
                type,
                ctime: stat.ctimeMs,
                mtime: stat.mtimeMs,
                size: stat.size,
                permissions: stat.mode
            };
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                throw FileSystemError.FileNotFound(uri);
            }
            throw new FileSystemError(err.message, err.code || 'Unknown');
        }
    }

    async exists(uri: URI): Promise<boolean> {
        try {
            await fs.promises.access(uri.fsPath);
            return true;
        } catch {
            return false;
        }
    }

    async readDirectory(uri: URI): Promise<[string, FileType][]> {
        try {
            const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
            return entries.map(entry => {
                let type = FileType.Unknown;
                if (entry.isFile()) {
                    type = FileType.File;
                } else if (entry.isDirectory()) {
                    type = FileType.Directory;
                } else if (entry.isSymbolicLink()) {
                    type = FileType.SymbolicLink;
                }
                return [entry.name, type];
            });
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                throw FileSystemError.FileNotFound(uri);
            }
            throw new FileSystemError(err.message, err.code || 'Unknown');
        }
    }

    async createDirectory(uri: URI): Promise<void> {
        try {
            await fs.promises.mkdir(uri.fsPath, { recursive: true });
            this._onDidChangeFile.fire([{ type: FileChangeType.Created, uri }]);
        } catch (err: any) {
            throw new FileSystemError(err.message, err.code || 'Unknown');
        }
    }

    async readFile(uri: URI): Promise<Uint8Array> {
        try {
            const buffer = await fs.promises.readFile(uri.fsPath);
            return new Uint8Array(buffer);
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                throw FileSystemError.FileNotFound(uri);
            }
            throw new FileSystemError(err.message, err.code || 'Unknown');
        }
    }

    async writeFile(uri: URI, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        const filePath = uri.fsPath;
        const exists = await this.exists(uri);

        if (exists && !options.overwrite) {
            throw FileSystemError.FileExists(uri);
        }
        if (!exists && !options.create) {
            throw FileSystemError.FileNotFound(uri);
        }

        try {
            const dir = path.dirname(filePath);
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(filePath, Buffer.from(content));

            this._onDidChangeFile.fire([{
                type: exists ? FileChangeType.Changed : FileChangeType.Created,
                uri
            }]);
        } catch (err: any) {
            throw new FileSystemError(err.message, err.code || 'Unknown');
        }
    }

    async delete(uri: URI, options?: { recursive?: boolean }): Promise<void> {
        try {
            const stat = await this.stat(uri);
            if (stat.type === FileType.Directory) {
                await fs.promises.rm(uri.fsPath, { recursive: options?.recursive ?? true, force: true });
            } else {
                await fs.promises.unlink(uri.fsPath);
            }
            this._onDidChangeFile.fire([{ type: FileChangeType.Deleted, uri }]);
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                throw FileSystemError.FileNotFound(uri);
            }
            throw new FileSystemError(err.message, err.code || 'Unknown');
        }
    }

    async rename(oldUri: URI, newUri: URI, options: { overwrite: boolean }): Promise<void> {
        const newExists = await this.exists(newUri);
        if (newExists && !options.overwrite) {
            throw FileSystemError.FileExists(newUri);
        }

        try {
            const newDir = path.dirname(newUri.fsPath);
            await fs.promises.mkdir(newDir, { recursive: true });
            await fs.promises.rename(oldUri.fsPath, newUri.fsPath);

            this._onDidChangeFile.fire([
                { type: FileChangeType.Deleted, uri: oldUri },
                { type: FileChangeType.Created, uri: newUri }
            ]);
        } catch (err: any) {
            throw new FileSystemError(err.message, err.code || 'Unknown');
        }
    }

    dispose(): void {
        for (const watcher of this._watchers.values()) {
            watcher.close();
        }
        this._watchers.clear();
        this._onDidChangeFile.dispose();
    }
}

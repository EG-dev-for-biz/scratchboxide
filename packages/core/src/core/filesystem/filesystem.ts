/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Event, IDisposable } from '../events';
import { URI } from './uri';

export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64
}

export enum FileChangeType {
    Changed = 1,
    Created = 2,
    Deleted = 3
}

export interface FileStat {
    type: FileType;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: number;
}

export interface FileChangeEvent {
    type: FileChangeType;
    uri: URI;
}

export interface IFileSystemProvider {
    readonly capabilities?: number;
    readonly onDidChangeFile: Event<FileChangeEvent[]>;
    watch(uri: URI, options: { recursive: boolean; excludes: string[] }): IDisposable;
    stat(uri: URI): Promise<FileStat>;
    readDirectory(uri: URI): Promise<[string, FileType][]>;
    createDirectory(uri: URI): Promise<void>;
    readFile(uri: URI): Promise<Uint8Array>;
    writeFile(uri: URI, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void>;
    delete(uri: URI, options?: { recursive?: boolean }): Promise<void>;
    rename(oldUri: URI, newUri: URI, options: { overwrite: boolean }): Promise<void>;
    exists?(uri: URI): Promise<boolean>;
    copy?(source: URI, destination: URI, options: { overwrite: boolean }): Promise<void>;
}

export class FileSystemError extends Error {
    static FileNotFound(uriOrMessage?: URI | string): FileSystemError {
        return new FileSystemError(`File not found: ${uriOrMessage ? (typeof uriOrMessage === 'string' ? uriOrMessage : uriOrMessage.toString()) : ''}`, 'FileNotFound');
    }

    static FileExists(uriOrMessage?: URI | string): FileSystemError {
        return new FileSystemError(`File already exists: ${uriOrMessage ? (typeof uriOrMessage === 'string' ? uriOrMessage : uriOrMessage.toString()) : ''}`, 'FileExists');
    }

    static FileNotADirectory(uriOrMessage?: URI | string): FileSystemError {
        return new FileSystemError(`File is not a directory: ${uriOrMessage ? (typeof uriOrMessage === 'string' ? uriOrMessage : uriOrMessage.toString()) : ''}`, 'FileNotADirectory');
    }

    static FileIsADirectory(uriOrMessage?: URI | string): FileSystemError {
        return new FileSystemError(`File is a directory: ${uriOrMessage ? (typeof uriOrMessage === 'string' ? uriOrMessage : uriOrMessage.toString()) : ''}`, 'FileIsADirectory');
    }

    static NoPermissions(uriOrMessage?: URI | string): FileSystemError {
        return new FileSystemError(`No permissions: ${uriOrMessage ? (typeof uriOrMessage === 'string' ? uriOrMessage : uriOrMessage.toString()) : ''}`, 'NoPermissions');
    }

    static Unavailable(uriOrMessage?: URI | string): FileSystemError {
        return new FileSystemError(`File system unavailable: ${uriOrMessage ? (typeof uriOrMessage === 'string' ? uriOrMessage : uriOrMessage.toString()) : ''}`, 'Unavailable');
    }

    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'FileSystemError';
    }
}

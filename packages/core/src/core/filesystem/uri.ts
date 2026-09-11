/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as path from 'path';

export interface URIComponents {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
}

export class URI implements URIComponents {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;

    constructor(scheme: string, authority?: string, uriPath?: string, query?: string, fragment?: string) {
        this.scheme = scheme || 'file';
        this.authority = authority || '';
        this.path = URI._normalizePath(uriPath || '');
        this.query = query || '';
        this.fragment = fragment || '';
    }

    static isURI(thing: any): thing is URI {
        return thing instanceof URI || (Boolean(thing) && typeof thing === 'object' && typeof thing.scheme === 'string' && typeof thing.path === 'string');
    }

    static parse(value: string): URI {
        if (!value) {
            return new URI('file', '', '/');
        }

        // Match scheme://authority/path?query#fragment or scheme:/path
        const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
        if (match) {
            const scheme = match[1].toLowerCase();
            const authority = match[2] || '';
            const rawPath = match[3] || '/';
            const query = match[4] || '';
            const fragment = match[5] || '';
            return new URI(scheme, authority, rawPath, query, fragment);
        }

        // Default to file URI
        return URI.file(value);
    }

    static file(filePath: string): URI {
        let authority = '';
        let normalized = filePath.replace(/\\/g, '/');
        if (normalized.startsWith('//')) {
            const idx = normalized.indexOf('/', 2);
            if (idx === -1) {
                authority = normalized.substring(2);
                normalized = '/';
            } else {
                authority = normalized.substring(2, idx);
                normalized = normalized.substring(idx);
            }
        }
        if (!normalized.startsWith('/')) {
            normalized = '/' + normalized;
        }
        return new URI('file', authority, normalized);
    }

    static from(components: URIComponents): URI {
        return new URI(
            components.scheme,
            components.authority,
            components.path,
            components.query,
            components.fragment
        );
    }

    get fsPath(): string {
        if (this.scheme === 'file') {
            if (process.platform === 'win32') {
                let p = this.path;
                if (p.startsWith('/') && /^[a-zA-Z]:/.test(p.substring(1))) {
                    p = p.substring(1);
                }
                return p.replace(/\//g, '\\');
            }
            return this.path;
        }
        return this.path;
    }

    with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): URI {
        return new URI(
            change.scheme !== undefined ? change.scheme : this.scheme,
            change.authority !== undefined ? change.authority : this.authority,
            change.path !== undefined ? change.path : this.path,
            change.query !== undefined ? change.query : this.query,
            change.fragment !== undefined ? change.fragment : this.fragment
        );
    }

    joinPath(...pathSegments: string[]): URI {
        if (pathSegments.length === 0) {
            return this;
        }
        const joined = path.posix.join(this.path, ...pathSegments.map(s => s.replace(/\\/g, '/')));
        return this.with({ path: joined });
    }

    toString(_skipEncoding: boolean = false): string {
        let res = `${this.scheme}:`;
        if (this.authority || this.scheme === 'file' || this.scheme === 'memory' || this.scheme === 'scratchbox') {
            res += `//${this.authority}`;
        }
        if (this.path) {
            if (!this.path.startsWith('/') && (this.authority || this.scheme === 'file' || this.scheme === 'memory' || this.scheme === 'scratchbox')) {
                res += '/' + this.path;
            } else {
                res += this.path;
            }
        }
        if (this.query) {
            res += `?${this.query}`;
        }
        if (this.fragment) {
            res += `#${this.fragment}`;
        }
        return res;
    }

    toJSON(): URIComponents {
        return {
            scheme: this.scheme,
            authority: this.authority,
            path: this.path,
            query: this.query,
            fragment: this.fragment
        };
    }

    private static _normalizePath(p: string): string {
        let normalized = p.replace(/\\/g, '/');
        if (!normalized.startsWith('/')) {
            normalized = '/' + normalized;
        }
        return path.posix.normalize(normalized);
    }
}

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

export class PathTraversalError extends Error {
    readonly code = 'path_traversal';
    constructor(message: string, readonly root?: string, readonly candidate?: string) {
        super(message);
        this.name = 'PathTraversalError';
    }
}

/**
 * Canonicalizes `target` by resolving symlinks on the longest existing prefix
 * and appending the (non-existent) remainder. This lets us confine paths that
 * have not been created yet while still catching symlinked escapes.
 */
function canonicalize(target: string): string {
    const absolute = path.resolve(target);
    let existing = absolute;
    const remainder: string[] = [];

    // Walk up until we find a path that exists (fs.realpathSync requires existence).
    while (true) {
        try {
            const real = fs.realpathSync.native ? fs.realpathSync.native(existing) : fs.realpathSync(existing);
            return remainder.length ? path.join(real, ...remainder.reverse()) : real;
        } catch {
            const parent = path.dirname(existing);
            if (parent === existing) {
                // Reached filesystem root without finding anything that exists.
                return absolute;
            }
            remainder.push(path.basename(existing));
            existing = parent;
        }
    }
}

function isInside(root: string, candidate: string): boolean {
    if (candidate === root) {
        return true;
    }
    const rel = path.relative(root, candidate);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolves `candidate` (relative or absolute) against `root` and returns the
 * absolute path, throwing {@link PathTraversalError} if the canonical result
 * (following symlinks where the path exists) escapes `root`.
 */
export function resolveWithinRoot(root: string, candidate: string): string {
    if (typeof root !== 'string' || !root.trim()) {
        throw new PathTraversalError('A workspace root is required', root, candidate);
    }
    const raw = typeof candidate === 'string' ? candidate : '';
    if (raw.includes('\0')) {
        throw new PathTraversalError('Path contains a NUL byte', root, candidate);
    }

    const canonicalRoot = canonicalize(root);
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(canonicalRoot, raw);
    const canonicalTarget = canonicalize(resolved);

    if (!isInside(canonicalRoot, canonicalTarget)) {
        throw new PathTraversalError(
            `Path "${raw}" resolves outside the workspace root`,
            root,
            candidate
        );
    }

    // Return a path anchored at the canonical root so downstream `path.join` stays inside.
    const rel = path.relative(canonicalRoot, canonicalTarget);
    return rel ? path.join(canonicalRoot, rel) : canonicalRoot;
}

/**
 * Ensures `root` is (or is nested under) one of `allowedRoots`. Returns the
 * canonical absolute root on success.
 */
export function assertWorkspaceRoot(root: string, allowedRoots: string[]): string {
    if (typeof root !== 'string' || !root.trim()) {
        throw new PathTraversalError('A workspace root is required', root);
    }
    if (root.includes('\0')) {
        throw new PathTraversalError('Workspace root contains a NUL byte', root);
    }
    const canonicalRoot = canonicalize(root);
    for (const allowed of allowedRoots) {
        if (!allowed) continue;
        const canonicalAllowed = canonicalize(allowed);
        if (isInside(canonicalAllowed, canonicalRoot)) {
            return canonicalRoot;
        }
    }
    throw new PathTraversalError(`Workspace root "${root}" is not in the allowed roots list`, root);
}

/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';

/**
 * Candidate locations of the Vite renderer build (`desktop-app/dist`) relative
 * to the directory the *calling module* lives in. The server/electron code is
 * emitted with `rootDir` = repo root, so at runtime it lives under
 * `desktop-app/dist-electron/desktop-app/{server,electron}` — three levels
 * below `desktop-app/`. Under ts-node (dev) it runs from `desktop-app/{server,electron}`.
 */
const RELATIVE_CANDIDATES = ['../dist', '../../../dist'];

function isRendererDist(dir: string): boolean {
    try {
        return fs.statSync(path.join(dir, 'index.html')).isFile();
    } catch {
        return false;
    }
}

/**
 * Resolve the directory holding the built renderer (`index.html` + assets).
 *
 * Resolution order:
 * 1. `SCRATCHBOX_STATIC_DIR` (explicit override, e.g. in containers)
 * 2. `../dist` then `../../../dist` relative to `fromDir`
 *
 * Returns `undefined` when nothing usable exists so callers can run API-only.
 */
export function resolveRendererDist(fromDir: string): string | undefined {
    const override = process.env.SCRATCHBOX_STATIC_DIR;
    if (override) {
        const resolved = path.resolve(override);
        return isRendererDist(resolved) ? resolved : undefined;
    }
    for (const candidate of RELATIVE_CANDIDATES) {
        const resolved = path.resolve(fromDir, candidate);
        if (isRendererDist(resolved)) {
            return resolved;
        }
    }
    return undefined;
}

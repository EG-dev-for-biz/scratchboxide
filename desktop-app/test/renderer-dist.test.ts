/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, test } from 'vitest';
import { resolveRendererDist } from '../server/renderer-dist';

let tmp: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-renderer-dist-'));
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.SCRATCHBOX_STATIC_DIR;
});

function mkdirp(...segments: string[]): string {
    const dir = path.join(tmp, ...segments);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

test('resolves ../dist for the ts-node/dev layout (desktop-app/server -> desktop-app/dist)', () => {
    const serverDir = mkdirp('desktop-app', 'server');
    const dist = mkdirp('desktop-app', 'dist');
    fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
    assert.strictEqual(resolveRendererDist(serverDir), dist);
});

test('resolves the rootDir-emitted layout (dist-electron/desktop-app/server -> desktop-app/dist)', () => {
    const serverDir = mkdirp('desktop-app', 'dist-electron', 'desktop-app', 'server');
    const dist = mkdirp('desktop-app', 'dist');
    fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
    assert.strictEqual(resolveRendererDist(serverDir), dist);
});

test('SCRATCHBOX_STATIC_DIR overrides layout detection', () => {
    const serverDir = mkdirp('anywhere');
    const custom = mkdirp('custom-static');
    fs.writeFileSync(path.join(custom, 'index.html'), '<html></html>');
    process.env.SCRATCHBOX_STATIC_DIR = custom;
    assert.strictEqual(resolveRendererDist(serverDir), custom);
});

test('returns undefined when no built renderer exists (API-only mode)', () => {
    const serverDir = mkdirp('desktop-app', 'dist-electron', 'desktop-app', 'server');
    assert.strictEqual(resolveRendererDist(serverDir), undefined);
});

test('ignores a dist directory that has no index.html', () => {
    const serverDir = mkdirp('desktop-app', 'server');
    mkdirp('desktop-app', 'dist');
    assert.strictEqual(resolveRendererDist(serverDir), undefined);
});

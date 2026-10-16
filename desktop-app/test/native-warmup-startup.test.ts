/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Where the native warm-up starts: after the API server's listen callback in the standalone server and in the Electron
 * main process, and never from createStandaloneServer, which tests construct.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { createStandaloneServer } from '../server/app';
import { TileVegetationService } from '../../packages/core/src/node/3d-engine/tile-vegetation-service';
import { TileRefineService } from '../../packages/core/src/node/3d-engine/tile-refine-service';
import { NativePythonRunnerService } from '../../packages/core/src/node/3d-engine/native-python-runner-service';
import * as nativeBuild from '../../packages/core/src/node/3d-engine/native-build';

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock('../server/app'); vi.doUnmock('../../packages/core/src/node/3d-engine/native-warmup'); });

describe('native warm-up placement', () => {
    it('constructing the standalone app starts no native build', async () => {
        const tv = vi.spyOn(TileVegetationService.prototype, 'ensureBinary');
        const tr = vi.spyOn(TileRefineService.prototype, 'ensureBinary');
        const py = vi.spyOn(NativePythonRunnerService.prototype, 'ensureNativeModule');
        const build = vi.spyOn(nativeBuild, 'buildNativeIfStale');
        const app = createStandaloneServer({ port: 0, toolsPort: 3998 });
        expect(app).toBeTruthy();
        await new Promise(r => setTimeout(r, 50));
        expect(tv).not.toHaveBeenCalled();
        expect(tr).not.toHaveBeenCalled();
        expect(py).not.toHaveBeenCalled();
        expect(build).not.toHaveBeenCalled();
    });

    it('the standalone server starts the warm-up once, after the API server is listening', async () => {
        const order: string[] = [];
        const fakeServer = () => Object.assign(new EventEmitter(), { close: vi.fn() });
        vi.doMock('../server/app', () => ({
            createStandaloneServer: () => ({
                locals: { launchToken: 'test-token', exportedToolsStore: {} },
                listen: (_port: number, _host: string, cb: () => void) => { order.push('api listening'); cb(); return fakeServer(); }
            }),
            createToolsServer: () => ({ listen: (_p: number, _h: string, cb: () => void) => { cb(); return fakeServer(); } }),
            resolveLaunchToken: () => 'test-token'
        }));
        vi.doMock('../../packages/core/src/node/3d-engine/native-warmup', () => ({ warmNativeEngine: vi.fn(async () => { order.push('warm-up'); return { steps: [] }; }) }));
        const savedEnv = { PORT: process.env.PORT, TOOLS: process.env.SCRATCHBOX_TOOLS_PORT };
        process.env.PORT = '0';
        process.env.SCRATCHBOX_TOOLS_PORT = '0';
        const handlersBefore = { rejection: process.listeners('unhandledRejection'), exception: process.listeners('uncaughtException') };
        try {
            await import('../server/index');
            expect(order).toEqual(['api listening', 'warm-up']);
        } finally {
            // the entry point installs process-wide handlers; leave the test process as it was
            for (const l of process.listeners('unhandledRejection')) if (!handlersBefore.rejection.includes(l)) process.removeListener('unhandledRejection', l);
            for (const l of process.listeners('uncaughtException')) if (!handlersBefore.exception.includes(l)) process.removeListener('uncaughtException', l);
            if (savedEnv.PORT === undefined) delete process.env.PORT; else process.env.PORT = savedEnv.PORT;
            if (savedEnv.TOOLS === undefined) delete process.env.SCRATCHBOX_TOOLS_PORT; else process.env.SCRATCHBOX_TOOLS_PORT = savedEnv.TOOLS;
        }
    });

    it('the Electron main process starts it inside the API server\'s listen callback, and imports it from the same module', () => {
        const source = fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8');
        expect(source).toMatch(/import \{ warmNativeEngine \} from '\.\.\/\.\.\/packages\/core\/src\/node\/3d-engine\/native-warmup'/);
        const listen = source.indexOf('serverApp.listen(BACKEND_PORT');
        const callbackEnd = source.indexOf('});', listen);
        const callback = source.slice(listen, callbackEnd);
        expect(callback).toContain('void warmNativeEngine();');
        // after the server is marked up, so the window does not wait for a compiler
        expect(callback.indexOf('markDone();')).toBeLessThan(callback.indexOf('void warmNativeEngine();'));
        expect(source.match(/warmNativeEngine\(/g)).toHaveLength(1);
    });
});

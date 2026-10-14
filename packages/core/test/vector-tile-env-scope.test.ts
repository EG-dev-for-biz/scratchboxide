/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Importing GoogleVectorTileService loads the Maps keys it needs from .env, and nothing else: it used to copy every
 * variable (including a stale GEMINI_API_KEY) into the environment at import time, ahead of the server's own secrets
 * handling, so a Gemini key saved in Settings lost to the .env one after every restart.
 */
import { test, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const NAMES = ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'MAP_TILES_API_KEY', 'GOOGLE_MAPS_API_KEY', 'SOME_OTHER_SECRET'];

test('import-time .env loading only sets the Maps keys', async () => {
    const saved = Object.fromEntries(NAMES.map(n => [n, process.env[n]]));
    const cwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-env-'));
    fs.writeFileSync(path.join(dir, '.env'), [
        'GEMINI_API_KEY=from-dotenv-gemini',
        'GOOGLE_AI_API_KEY=from-dotenv-google-ai',
        'SOME_OTHER_SECRET=from-dotenv-other',
        'MAP_TILES_API_KEY="from-dotenv-map-tiles"'
    ].join('\n'));
    try {
        for (const n of NAMES) delete process.env[n];
        process.chdir(dir);
        vi.resetModules();
        const mod = await import('../src/node/spatial/GoogleVectorTileService');
        expect(process.env.MAP_TILES_API_KEY).toBe('from-dotenv-map-tiles');
        expect(mod.DEFAULT_GOOGLE_MAPS_API_KEY).toBe('from-dotenv-map-tiles');
        expect(process.env.GEMINI_API_KEY).toBeUndefined();
        expect(process.env.GOOGLE_AI_API_KEY).toBeUndefined();
        expect(process.env.SOME_OTHER_SECRET).toBeUndefined();
    } finally {
        process.chdir(cwd);
        for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** The dev launcher's token (desktop-app/scripts/launch-token.js): kept for 30 days across launches, then replaced. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const req = createRequire(__filename);
const { persistentLaunchToken, launchTokenFile, LAUNCH_TOKEN_MAX_AGE_DAYS } = req('../../../desktop-app/scripts/launch-token.js');

describe('dev launch token', () => {
    it('is kept across launches for 30 days, user-readable only, then replaced', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-home-'));
        const env = { SCRATCHBOX_HOME: home };
        const t0 = Date.parse('2026-10-23T12:00:00Z');
        const a = persistentLaunchToken({ env, now: t0 });
        expect(a.source).toBe('new');
        expect(a.token).toMatch(/^[0-9a-f]{64}$/);
        expect(LAUNCH_TOKEN_MAX_AGE_DAYS).toBe(30);
        expect(fs.statSync(launchTokenFile(env)).mode & 0o777).toBe(0o600);
        const b = persistentLaunchToken({ env, now: t0 + 29 * 86_400_000 });
        expect(b).toMatchObject({ token: a.token, source: 'file', expiresAtMs: t0 + 30 * 86_400_000 });
        const c = persistentLaunchToken({ env, now: t0 + 30 * 86_400_000 + 1 });
        expect(c.source).toBe('new');
        expect(c.token).not.toBe(a.token);
    });

    it('takes SCRATCHBOX_LAUNCH_TOKEN when set, and replaces an unreadable file', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-home-'));
        expect(persistentLaunchToken({ env: { SCRATCHBOX_HOME: home, SCRATCHBOX_LAUNCH_TOKEN: ' given ' } })).toEqual({ token: 'given', source: 'env' });
        fs.writeFileSync(path.join(home, 'launch-token.json'), 'not json');
        expect(persistentLaunchToken({ env: { SCRATCHBOX_HOME: home } }).source).toBe('new');
    });
});

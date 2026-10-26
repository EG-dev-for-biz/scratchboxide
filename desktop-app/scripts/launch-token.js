/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The dev launcher's API token, kept across restarts for LAUNCH_TOKEN_MAX_AGE_DAYS (user decision 2026-10-23: 30 days)
 * instead of a fresh one every launch, so an open tab and a bookmarked token URL keep working after the dev server
 * restarts. Stored in <SCRATCHBOX_HOME or ~/.scratchbox>/launch-token.json, readable only by the user (0600); a token
 * older than the limit, or a file that cannot be read, is replaced by a new random one. SCRATCHBOX_LAUNCH_TOKEN still
 * wins when it is set.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LAUNCH_TOKEN_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

function launchTokenFile(env = process.env) {
    const home = (env.SCRATCHBOX_HOME || '').trim() || path.join(os.homedir(), '.scratchbox');
    return path.join(home, 'launch-token.json');
}

/** The persisted token when it is younger than maxAgeDays, else a new one written in its place. */
function persistentLaunchToken({ env = process.env, now = Date.now(), maxAgeDays = LAUNCH_TOKEN_MAX_AGE_DAYS } = {}) {
    const fromEnv = (env.SCRATCHBOX_LAUNCH_TOKEN || '').trim();
    if (fromEnv) return { token: fromEnv, source: 'env' };
    const file = launchTokenFile(env);
    try {
        const held = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof held.token === 'string' && /^[0-9a-f]{64}$/.test(held.token) && Number.isFinite(held.createdAtMs) && now - held.createdAtMs < maxAgeDays * DAY_MS && held.createdAtMs <= now) {
            return { token: held.token, source: 'file', expiresAtMs: held.createdAtMs + maxAgeDays * DAY_MS };
        }
    } catch { /* missing or unreadable: a new one below */ }
    const token = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ token, createdAtMs: now }), { mode: 0o600 });
        fs.chmodSync(file, 0o600);
    } catch (err) {
        // not persisted: this launch still has its token, the next one mints another
        process.stderr.write(`[launch-token] could not keep the token in ${file} (${err.message}); it lasts until this launch ends\n`);
        return { token, source: 'new' };
    }
    return { token, source: 'new', expiresAtMs: now + maxAgeDays * DAY_MS };
}

module.exports = { persistentLaunchToken, launchTokenFile, LAUNCH_TOKEN_MAX_AGE_DAYS };

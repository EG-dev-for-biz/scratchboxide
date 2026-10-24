#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Before the dev server starts (root `predev`): when SCRATCHBOX_DEV_FOLLOW_MAIN=1, this checkout is moved to the newest
 * origin/main and the core package is built, so whatever agent starts the user's app (the `scratchbox-dev` launch entry,
 * user decision 2026-10-23) serves the latest main. Without the flag it does nothing: a feature worktree's own launch
 * entry serves its own branch.
 *
 *  - On branch `main`: `git merge --ff-only origin/main`. Local edits are kept; when they touch a file main changed,
 *    the fast-forward is refused and the app starts on the commit it has, with the reason printed.
 *  - Detached (a copy kept at main, e.g. .claude/worktrees/latest-main) with no tracked edits: checked out at origin/main.
 *  - Any other branch: left alone (a branch is never moved to main behind its owner's back).
 *  - package-lock.json changed: `npm ci`. HEAD changed or no core build: `npm --prefix packages/core run build`
 *    (`tsc` writes its output even when another package's type errors fail the check; those are printed, not fatal).
 *
 * Never fails the start: the app always comes up, on the newest main it could reach.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.env.SCRATCHBOX_DEV_FOLLOW_MAIN !== '1') process.exit(0);

const root = path.resolve(__dirname, '..', '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const say = m => console.log(`[follow-main] ${m}`);

try {
    git('fetch', '-q', 'origin', 'main');
} catch (err) {
    say(`could not fetch origin/main (${String(err.stderr || err.message).trim().split('\n')[0]}); starting on the commit this checkout has`);
}

let before, branch;
try {
    before = git('rev-parse', 'HEAD');
    branch = git('rev-parse', '--abbrev-ref', 'HEAD');
} catch (err) {
    say(`not a git checkout (${err.message}); starting as is`);
    process.exit(0);
}
const lockBefore = (() => { try { return git('rev-parse', 'HEAD:package-lock.json'); } catch { return 'none'; } })();

try {
    if (branch === 'main') {
        git('merge', '--ff-only', '-q', 'origin/main');
    } else if (branch === 'HEAD') {
        const edits = git('status', '--porcelain', '--untracked-files=no');
        if (edits) say(`detached with tracked edits (${edits.split('\n').length} file(s)); not moved`);
        else git('checkout', '-q', '--detach', 'origin/main');
    } else {
        say(`on branch ${branch}, not main: not moved`);
    }
} catch (err) {
    say(`could not move to origin/main (${String(err.stderr || err.message).trim().split('\n').slice(0, 3).join(' / ')}); starting on ${before.slice(0, 8)}`);
}

const after = git('rev-parse', 'HEAD');
const lockAfter = (() => { try { return git('rev-parse', 'HEAD:package-lock.json'); } catch { return 'none'; } })();
if (lockAfter !== lockBefore || !fs.existsSync(path.join(root, 'node_modules'))) {
    say('package-lock.json changed: installing packages');
    spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
}

const stamp = path.join(root, 'packages', 'core', 'dist', '.built-from');
const builtFrom = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '';
const hasBuild = fs.existsSync(path.join(root, 'packages', 'core', 'dist', 'node.js'));
if (after !== builtFrom || !hasBuild) {
    say(`building packages/core at ${after.slice(0, 8)}`);
    const t0 = Date.now();
    const r = spawnSync('npm', ['--prefix', 'packages/core', 'run', 'build', '--silent'], { cwd: root, encoding: 'utf8' });
    const errors = `${r.stdout || ''}${r.stderr || ''}`.split('\n').filter(l => /error TS\d+/.test(l));
    if (errors.length) say(`core built with ${errors.length} type error(s) from the source (output written all the same), first: ${errors[0].slice(0, 200)}`);
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, `${after}\n`);
    say(`core built in ${Math.round((Date.now() - t0) / 1000)} s`);
}

let behind = '?';
try { behind = git('rev-list', '--count', 'HEAD..origin/main'); } catch { /* no origin/main */ }
say(`serving ${git('log', '-1', '--format=%h %s', 'HEAD').slice(0, 120)}${before !== after ? ` (moved from ${before.slice(0, 8)})` : ''}; ${behind === '0' ? 'up to date with origin/main' : `${behind} commit(s) behind origin/main`}`);

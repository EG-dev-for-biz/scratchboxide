#!/usr/bin/env node
/**
 * Refreshes vitest.shard-durations.json, the per-file test times the CI's Ubuntu shards are split by
 * (vitest.shard-sequencer.ts), from the logs of CI runs: each file's time as vitest's default reporter printed it
 * ("✓ packages/core/test/x.test.ts (12 tests) 3456ms") in the "Test (ubuntu-24.04, ...)" jobs. A file a run measured
 * takes its new time, a file no run measured keeps its old one, and a file no longer in the repository is dropped.
 * Needs the GitHub CLI, signed in to the repository.
 *
 * Usage:
 *   node scripts/update_shard_durations.mjs <run-id> [<run-id> ...]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLE_PATH = path.join(REPO_ROOT, 'vitest.shard-durations.json');
const SHARD_JOB = /^Test \(ubuntu-24\.04\b/;
const ANSI = /(\x1b|\^\[)\[[0-9;]*m/g;
const FILE_LINE = /\s[✓❯↓×] ((?:packages|desktop-app)\/\S+\.test\.ts) \(\d+ tests?[^)]*\) (\d+)ms/;

const runIds = process.argv.slice(2);
if (!runIds.length || runIds.some(id => !/^\d+$/.test(id))) {
    console.error('Usage: node scripts/update_shard_durations.mjs <run-id> [<run-id> ...]');
    process.exit(1);
}

const gh = (...args) => execFileSync('gh', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 30 });

const measured = new Map();
for (const runId of runIds) {
    const { jobs } = JSON.parse(gh('run', 'view', runId, '--json', 'jobs'));
    for (const job of jobs.filter(j => SHARD_JOB.test(j.name))) {
        let files = 0;
        for (const line of gh('run', 'view', runId, '--log', '--job', String(job.databaseId)).split('\n')) {
            const match = FILE_LINE.exec(line.replace(ANSI, ''));
            if (!match) continue;
            measured.set(match[1], Math.round(Number(match[2]) / 100) / 10);
            files++;
        }
        console.log(`${runId} ${job.name}: ${files} files (${job.conclusion})`);
    }
}

const table = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8'));
const updated = {};
for (const file of [...new Set([...Object.keys(table), ...measured.keys()])].sort()) {
    if (!fs.existsSync(path.join(REPO_ROOT, file))) continue;
    updated[file] = measured.get(file) ?? table[file];
}
fs.writeFileSync(TABLE_PATH, JSON.stringify(updated, null, 4) + '\n');
const total = Object.values(updated).reduce((sum, s) => sum + s, 0);
console.log(`${measured.size} files measured; ${Object.keys(updated).length} in the table, ${Math.round(total / 60)} min in all.`);

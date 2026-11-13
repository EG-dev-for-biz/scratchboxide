/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Sends the local run ledger's rows to the cloud, and reads back what every machine has (run-ledger-sync.ts).
 *
 *   npm run ledger:sync                   # roll up this machine's rows by UTC day and bring each day's object up to date
 *   npm run ledger:sync -- --dry-run      # say what it would add, write nothing
 *   npm run ledger:sync -- --pull         # after syncing, report the rows of every machine in the bucket
 *   npm run ledger:sync -- --dir <path>   # a ledger somewhere other than <workspace>/.scratchbox/ledger
 *
 * It is safe to run again at any time: the objects are keyed by machine and day and union-merged, so nothing is
 * duplicated and no machine can clobber another's rows. SCRATCHBOX_LEDGER_BUCKET=off turns the cloud copy off.
 */

import {
    describeLedgerSync, fetchAllLedgerRows, ledgerHostKey, LEDGER_KINDS, relativisePaths, resolveLedgerBucketName,
    rowDate, rowIdentity, syncLedger, type LedgerKind
} from '../packages/core/src/node/3d-engine/staged-location/run-ledger-sync';
import { ledgerDir, readBuildRows, readJudgeRows, type LedgerRow } from '../packages/core/src/node/3d-engine/staged-location/run-ledger';
import { stagedWorkspaceRoot } from '../packages/core/src/node/3d-engine/staged-location/stage-cache';

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

/** What a sync would add, without touching the bucket: the local rows grouped the way they would be stored. */
function dryRun(dir: string, host: string, root: string): void {
    const bucket = resolveLedgerBucketName();
    console.log(`ledger ${dir} as ${host} -> ${bucket ? `gs://${bucket}` : 'NO BUCKET CONFIGURED (would stay local)'}  [dry run, nothing written]`);
    for (const kind of LEDGER_KINDS) {
        const rows: LedgerRow[] = kind === 'builds' ? readBuildRows(dir).rows : readJudgeRows(dir).rows;
        const byDate = new Map<string, LedgerRow[]>();
        for (const r of rows) byDate.set(rowDate(r), [...(byDate.get(rowDate(r)) ?? []), r]);
        if (!rows.length) { console.log(`  ${kind}: no local rows`); continue; }
        for (const date of [...byDate.keys()].sort()) {
            const day = byDate.get(date)!;
            console.log(`  ${kind}: ledger/${kind}/${host}/${date}.jsonl  ${day.length} row${day.length === 1 ? '' : 's'}`);
            for (const r of day) {
                const out = relativisePaths(r, root);
                console.log(`      ${rowIdentity(r)}  ${JSON.stringify(out).length} bytes`);
            }
        }
    }
}

/** Every machine's rows for one kind, as the bucket holds them. */
async function pull(kind: LedgerKind): Promise<void> {
    const got = await fetchAllLedgerRows(kind);
    console.log(`  ${kind}: ${got.rows.length} row${got.rows.length === 1 ? '' : 's'} in ${got.objects} object${got.objects === 1 ? '' : 's'} from ${got.hosts.length} machine${got.hosts.length === 1 ? '' : 's'}${got.hosts.length ? ` (${got.hosts.join(', ')})` : ''}`);
}

async function main(): Promise<void> {
    const dir = option('dir') ?? ledgerDir();
    const host = ledgerHostKey();
    const root = stagedWorkspaceRoot();

    if (flag('dry-run')) {
        dryRun(dir, host, root);
        return;
    }

    const report = await syncLedger({ dir, host, workspaceRoot: root });
    console.log(describeLedgerSync(report));

    if (flag('pull')) {
        console.log('in the bucket, every machine:');
        for (const kind of LEDGER_KINDS) await pull(kind);
    }
    // a bucket that could not be reached is reported, not thrown: the ledger is a record, never a gate
    if (report.skipped && !report.bucket) process.exitCode = 0;
}

main().catch(err => {
    console.error(`ledger sync failed: ${(err as Error)?.message ?? String(err)}`);
    process.exitCode = 1;
});

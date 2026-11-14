/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The run ledger's cloud copy (run-ledger.ts holds the local append): the rows of each machine rolled up by the UTC day
 * they were written and kept in Google Cloud Storage, so the lanes' rows meet in one place and one laptop's disk is not
 * the only copy of the dataset.
 *
 * It is deliberately NOT in a build's finish path. The local append stays the write path — synchronous, fast, and
 * unable to fail a build — and this runs afterwards, from `npm run ledger:sync` or an explicit call. A sync that cannot
 * reach the bucket reports that and changes nothing.
 *
 * Three properties make it safe to run again at any time:
 *   - **Keyed by machine and day** (`ledger/<kind>/<host>/<date>.jsonl`): two lanes on two machines never write the
 *     same object, so neither can clobber the other.
 *   - **Union-merged, never overwritten.** GCS objects cannot be appended to, so a day's object is read back, indexed
 *     by row identity (a build row by runId and the instant it was written, a judgement by its evalId) and rewritten
 *     only with the rows it did not already hold. A local file that was truncated or cleared therefore cannot shrink
 *     the cloud copy, and an object is left untouched when it already holds every local row.
 *   - **Workspace-relative paths.** A row's proof paths are absolute on the machine that wrote them and meaningless
 *     anywhere else, so every string under the workspace root is rewritten relative to it on the way out. The local
 *     rows keep their absolute paths, which is what makes them useful locally.
 *
 * Nothing new is collected for the cloud: a row holds numbers and paths, never image bytes, model replies or
 * credentials (run-ledger.ts), so the object is the local line with its paths shortened.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GoogleMediaCredentialsService } from '../../google-media-credentials-service';
import { GcsCloudBucket, type CloudBucket } from '../../cloud-store/cloud-bucket';
import { scratchboxHome } from '../../asset-store/scratchbox-home';
import { stagedWorkspaceRoot } from './stage-cache';
import { ledgerDir, readBuildRows, readJudgeRows, type BuildLedgerRow, type JudgeLedgerRow, type LedgerRow } from './run-ledger';

/** The two kinds of row, and the key segment each is stored under. */
export const LEDGER_KINDS = ['builds', 'judgements'] as const;
export type LedgerKind = typeof LEDGER_KINDS[number];

/**
 * The ledger's bucket: SCRATCHBOX_LEDGER_BUCKET (`off` disables), else `trainingBucket` in cloud-store.json — the
 * bucket this evidence belongs in. The generic `bucket` key is not used: a machine may have one without meaning the
 * ledger to leave it.
 */
export function resolveLedgerBucketName(env: NodeJS.ProcessEnv = process.env, home = scratchboxHome()): string | undefined {
    const fromEnv = env.SCRATCHBOX_LEDGER_BUCKET?.trim();
    if (fromEnv) return fromEnv === 'off' ? undefined : fromEnv;
    try {
        const name = JSON.parse(fs.readFileSync(path.join(home, 'cloud-store.json'), 'utf8'))?.trainingBucket;
        return typeof name === 'string' && name.trim() ? name.trim() : undefined;
    } catch {
        return undefined;
    }
}

let shared: { name: string; bucket: CloudBucket } | undefined;

/** The process-wide ledger bucket, or undefined when none is configured (the ledger then stays local). */
export function defaultLedgerBucket(): CloudBucket | undefined {
    const name = resolveLedgerBucketName();
    if (!name) return undefined;
    if (shared?.name !== name) {
        const storage = new GoogleMediaCredentialsService().createStorageClient();
        shared = { name, bucket: new GcsCloudBucket(storage.bucket(name)) };
    }
    return shared.bucket;
}

/**
 * The machine a row came from, as one key segment: SCRATCHBOX_LEDGER_HOST, else this host's name, reduced to the
 * characters a bucket key takes. Two lanes on one machine share it on purpose — they share the local ledger too.
 */
export function ledgerHostKey(env: NodeJS.ProcessEnv = process.env, hostname: () => string = os.hostname): string {
    const asked = (env.SCRATCHBOX_LEDGER_HOST ?? '').trim();
    const raw = asked || hostname() || 'unknown-host';
    const clean = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
    return clean || 'unknown-host';
}

/** `ledger/<kind>/<host>/<date>.jsonl`, the object holding one machine's rows of one kind for one UTC day. */
export function ledgerKey(kind: LedgerKind, host: string, date: string): string {
    return `ledger/${kind}/${host}/${date}.jsonl`;
}

/** The UTC day a row was written, from its own timestamp; rows with an unusable one are grouped under the epoch. */
export function rowDate(row: LedgerRow): string {
    const iso = typeof row.atIso === 'string' && row.atIso.length >= 10 ? row.atIso
        : Number.isFinite(row.atMs) ? new Date(row.atMs).toISOString() : '1970-01-01';
    return iso.slice(0, 10);
}

/**
 * What makes two rows the same row, so a re-sync adds nothing twice: a build by its run and the instant it was
 * recorded (a retry of the same run is a second row), a judgement by its evalId (one per judgement, by construction).
 */
export function rowIdentity(row: LedgerRow): string {
    if (row.schema === 'scratchbox.run-ledger.judge/1') return `judge:${(row as JudgeLedgerRow).evalId}`;
    const b = row as BuildLedgerRow;
    return `build:${b.runId}:${b.atMs}`;
}

/**
 * Every string under `root` rewritten relative to it, through the whole row: a proof path is absolute on the machine
 * that wrote it and dead anywhere else. Paths outside the workspace (a volume, a temp dir) are left alone — shortening
 * them would say something untrue about where the file is.
 */
export function relativisePaths<T>(value: T, root: string): T {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return v.startsWith(prefix) ? v.slice(prefix.length) : v;
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
            return out;
        }
        return v;
    };
    return walk(value) as T;
}

export interface LedgerSyncDayReport {
    kind: LedgerKind;
    key: string;
    date: string;
    /** Rows this machine holds locally for that day. */
    local: number;
    /** Rows the object already held. */
    remote: number;
    /** Rows this sync added. */
    added: number;
    /** 'uploaded' when the object was written, 'unchanged' when it already held every local row. */
    state: 'uploaded' | 'unchanged';
}

export interface LedgerSyncReport {
    /** The bucket, e.g. gs://scoutscan-building-training; absent when none is configured. */
    bucket?: string;
    host: string;
    ledgerDir: string;
    /** Set when nothing could be synced, with the reason. */
    skipped?: string;
    days: LedgerSyncDayReport[];
    rowsAdded: number;
    objectsUploaded: number;
}

/** The rows of one kind, from the local ledger. */
function localRows(kind: LedgerKind, dir: string): LedgerRow[] {
    return kind === 'builds' ? readBuildRows(dir).rows : readJudgeRows(dir).rows;
}

/** The rows an object already holds; a line that will not parse is skipped, as when reading a local file. */
function parseRows(text: string): LedgerRow[] {
    const out: LedgerRow[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as LedgerRow); } catch { /* a torn line costs one row, never the object */ }
    }
    return out;
}

/**
 * Rolls the local ledger up by machine and UTC day and brings each day's object up to date, adding only the rows it
 * does not already hold. Returns what it did; it never throws for a bucket it cannot reach or a day it cannot read.
 */
export async function syncLedger(opts: {
    bucket?: CloudBucket;
    dir?: string;
    host?: string;
    workspaceRoot?: string;
    /** Work directory for the files uploaded; a temp directory by default. */
    tmpDir?: string;
    kinds?: readonly LedgerKind[];
} = {}): Promise<LedgerSyncReport> {
    const dir = opts.dir ?? ledgerDir();
    const host = opts.host ?? ledgerHostKey();
    const root = opts.workspaceRoot ?? stagedWorkspaceRoot();
    const report: LedgerSyncReport = { host, ledgerDir: dir, days: [], rowsAdded: 0, objectsUploaded: 0 };

    const bucket = opts.bucket ?? defaultLedgerBucket();
    if (!bucket) {
        report.skipped = 'no ledger bucket is configured (SCRATCHBOX_LEDGER_BUCKET, or trainingBucket in cloud-store.json); the ledger stays local';
        return report;
    }
    report.bucket = bucket.label;

    const tmpDir = opts.tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ledger-sync-'));
    fs.mkdirSync(tmpDir, { recursive: true });

    for (const kind of opts.kinds ?? LEDGER_KINDS) {
        const byDate = new Map<string, LedgerRow[]>();
        for (const row of localRows(kind, dir)) {
            const d = rowDate(row);
            const list = byDate.get(d) ?? [];
            list.push(row);
            byDate.set(d, list);
        }
        for (const date of [...byDate.keys()].sort()) {
            const rows = byDate.get(date)!;
            const key = ledgerKey(kind, host, date);
            const scratch = path.join(tmpDir, `${kind}-${date}-${crypto.randomBytes(4).toString('hex')}.jsonl`);
            let remote: LedgerRow[] = [];
            try {
                if (await bucket.download(key, scratch)) remote = parseRows(fs.readFileSync(scratch, 'utf8'));
            } catch (err) {
                report.days.push({ kind, key, date, local: rows.length, remote: 0, added: 0, state: 'unchanged' });
                report.skipped = `${report.skipped ? `${report.skipped}; ` : ''}${key}: could not be read (${(err as Error)?.message ?? String(err)})`;
                continue;
            }
            const seen = new Set(remote.map(rowIdentity));
            const added = rows.filter(r => !seen.has(rowIdentity(r)));
            if (!added.length) {
                report.days.push({ kind, key, date, local: rows.length, remote: remote.length, added: 0, state: 'unchanged' });
                continue;
            }
            // the object is the union, each row's paths made workspace-relative on the way out
            const merged = [...remote, ...added.map(r => relativisePaths(r, root))].sort((a, b) => a.atMs - b.atMs);
            fs.writeFileSync(scratch, merged.map(r => `${JSON.stringify(r)}\n`).join(''));
            try {
                await bucket.putFile(key, scratch, {
                    contentType: 'application/x-ndjson',
                    metadata: { kind, host, date, rows: String(merged.length) }
                });
            } catch (err) {
                report.days.push({ kind, key, date, local: rows.length, remote: remote.length, added: 0, state: 'unchanged' });
                report.skipped = `${report.skipped ? `${report.skipped}; ` : ''}${key}: could not be written (${(err as Error)?.message ?? String(err)})`;
                continue;
            }
            report.days.push({ kind, key, date, local: rows.length, remote: remote.length, added: added.length, state: 'uploaded' });
            report.rowsAdded += added.length;
            report.objectsUploaded += 1;
        }
    }
    return report;
}

/** The sync's result in one line per day, for a script's output or a run note. */
export function describeLedgerSync(report: LedgerSyncReport): string {
    const head = report.bucket
        ? `ledger ${report.ledgerDir} -> ${report.bucket} as ${report.host}: ${report.rowsAdded} row${report.rowsAdded === 1 ? '' : 's'} added across ${report.objectsUploaded} object${report.objectsUploaded === 1 ? '' : 's'}`
        : `ledger ${report.ledgerDir}: not synced`;
    const lines = report.days.map(d => `  ${d.state === 'uploaded' ? '+' : '='} ${d.key}  local ${d.local}, had ${d.remote}, added ${d.added}`);
    return [head, ...lines, ...(report.skipped ? [`  ! ${report.skipped}`] : [])].join('\n');
}

/** Every row of every machine for one kind, newest last: the table a later calibration reads out of the cloud. */
export async function fetchAllLedgerRows(kind: LedgerKind, opts: { bucket?: CloudBucket; tmpDir?: string } = {}): Promise<{ rows: LedgerRow[]; objects: number; hosts: string[] }> {
    const bucket = opts.bucket ?? defaultLedgerBucket();
    if (!bucket) return { rows: [], objects: 0, hosts: [] };
    const tmpDir = opts.tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ledger-fetch-'));
    fs.mkdirSync(tmpDir, { recursive: true });
    const objects = await bucket.list(`ledger/${kind}/`);
    const rows: LedgerRow[] = [];
    const hosts = new Set<string>();
    for (const o of objects) {
        const parts = o.key.split('/');
        if (parts.length >= 3) hosts.add(parts[2]);
        const scratch = path.join(tmpDir, `${crypto.randomBytes(6).toString('hex')}.jsonl`);
        if (await bucket.download(o.key, scratch)) rows.push(...parseRows(fs.readFileSync(scratch, 'utf8')));
    }
    rows.sort((a, b) => a.atMs - b.atMs);
    return { rows, objects: objects.length, hosts: [...hosts].sort() };
}

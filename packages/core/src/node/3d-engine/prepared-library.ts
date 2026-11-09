/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The prepared texture library: each library set's maps as pipeline K's material regions take them (the engine's
 * prepare_material_maps at 256 px: a normal PNG and an occlusion-roughness-metalness PNG, pipeline-k/material-sets.ts)
 * and each set's publisher previews, kept once in GCS for every machine and read by key.
 *
 * A build's empty disk otherwise downloads each chosen set's full maps (up to 8K, ~0.5 GB a set: 65 GB across Penn
 * Station's district and ~212 s a building, 2026-11-08) and prepares them again. The records are the same bytes a build
 * would have made (the same files chosen by fetchLibrarySets, the same engine call), so a build that takes one draws
 * exactly what it would have drawn; `npm run library:prepare` (scripts/library_prepare.ts) fills it, and a build that
 * prepares a set itself adds it. It is library data, not a cached build: it is read in a fresh build too.
 *
 * Where: SCRATCHBOX_PREPARED_LIBRARY (`gs://bucket/prefix`; `off` disables it), else `library-prepared/` in the training
 * bucket. Off under a test runner unless set. Every read and write is best effort and never fails a build.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GcsCloudBucket, type CloudBucket } from '../cloud-store/cloud-bucket';
import { defaultTrainingBucket } from '../cloud-store/training-pair-capture';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';

export interface PreparedLibraryRecord { normal: string; orm: string }

export interface PreparedLibrary {
    readonly label: string;
    getMaps(version: string, size: number, id: string): Promise<PreparedLibraryRecord | undefined>;
    putMaps(version: string, size: number, id: string, rec: PreparedLibraryRecord): Promise<void>;
    getPreview(role: string, id: string): Promise<Uint8Array | undefined>;
    putPreview(role: string, id: string, bytes: Uint8Array): Promise<void>;
}

const SAFE = /^[A-Za-z0-9._-]{1,200}$/;

export function preparedMapsKey(prefix: string, version: string, size: number, id: string): string {
    if (!SAFE.test(id)) throw new Error(`not a library set id: ${id}`);
    return `${prefix}/maps/${version.replace(/[^A-Za-z0-9._-]/g, '_')}/${size}/${id}.json`;
}

export function preparedPreviewKey(prefix: string, role: string, id: string): string {
    if (!SAFE.test(id) || !SAFE.test(role)) throw new Error(`not a library set id or role: ${id} ${role}`);
    return `${prefix}/previews/${role}/${id}.jpg`;
}

/** The prepared library over a bucket and a prefix in it. */
export function bucketPreparedLibrary(bucket: CloudBucket, prefix: string): PreparedLibrary {
    const p = prefix.replace(/^\/+|\/+$/g, '');
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-library-'));
    const read = async (key: string): Promise<Buffer | undefined> => {
        const dir = tmp();
        try {
            const file = path.join(dir, 'o');
            return (await bucket.download(key, file)) ? fs.readFileSync(file) : undefined;
        } catch { return undefined; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    const write = async (key: string, bytes: Uint8Array, contentType: string): Promise<void> => {
        const dir = tmp();
        try {
            const file = path.join(dir, 'o');
            fs.writeFileSync(file, bytes);
            await bucket.putFile(key, file, { contentType, onlyIfAbsent: true });
        } catch { /* best effort */ } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    return {
        label: `${bucket.label}/${p}`,
        getMaps: async (version, size, id) => {
            const b = await read(preparedMapsKey(p, version, size, id));
            if (!b) return undefined;
            try { const r = JSON.parse(b.toString('utf8')) as PreparedLibraryRecord; return r.normal && r.orm ? r : undefined; } catch { return undefined; }
        },
        putMaps: (version, size, id, rec) => write(preparedMapsKey(p, version, size, id), Buffer.from(JSON.stringify(rec)), 'application/json'),
        getPreview: async (role, id) => { const b = await read(preparedPreviewKey(p, role, id)); return b ? new Uint8Array(b) : undefined; },
        putPreview: (role, id, bytes) => write(preparedPreviewKey(p, role, id), bytes, 'image/jpeg')
    };
}

let shared: { spec: string; lib: PreparedLibrary | undefined } | undefined;

/** The prepared library the environment names (see the file comment), or none. */
export function preparedLibrary(env: NodeJS.ProcessEnv = process.env): PreparedLibrary | undefined {
    const spec = env.SCRATCHBOX_PREPARED_LIBRARY?.trim() ?? '';
    if (shared?.spec === spec) return shared.lib;
    let lib: PreparedLibrary | undefined;
    if (spec === 'off' || (!spec && (env.VITEST || env.NODE_ENV === 'test'))) lib = undefined;
    else {
        try {
            const m = /^gs:\/\/([^/]+)\/(.+?)\/?$/.exec(spec);
            if (m) {
                lib = bucketPreparedLibrary(new GcsCloudBucket(new GoogleMediaCredentialsService().createStorageClient().bucket(m[1])), m[2]);
            } else if (!spec) {
                const b = defaultTrainingBucket();
                lib = b ? bucketPreparedLibrary(b, 'library-prepared') : undefined;
            }
        } catch { lib = undefined; }
    }
    shared = { spec, lib };
    return lib;
}

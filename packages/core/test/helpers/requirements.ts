/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Explicit test prerequisites.
 *
 * Some suites exercise real assets, real system tools, or real network services that are not
 * part of a clean checkout. Those suites must SKIP with a reason (never pass vacuously, never
 * fail with ENOENT). Every such skip goes through this module so the reasons stay consistent
 * and greppable:
 *
 *   const glb = requireFile('public/models/foo.glb', HOW_TO.hydrate);
 *   describe.skipIf(!glb.ok)(withReason('Foo mesh pipeline', glb), () => { ... });
 *
 * `withReason` appends `[skipped: <reason>]` to the title only when the requirement is unmet,
 * so the reason shows up in the vitest reporter and in `--reporter=json` output.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const REPO_ROOT = path.resolve(__dirname, '../../../..');

export interface Requirement {
    readonly ok: boolean;
    /** Empty when ok; otherwise a one-line explanation of what is missing and how to get it. */
    readonly reason: string;
}

/** Standard "how to obtain" hints, so the same missing asset class always gets the same advice. */
export const HOW_TO = {
    /** Large binary demo assets are gitignored (see .gitignore "Media assets"). */
    gitignoredAsset: 'gitignored local asset; copy it from a machine that has it or regenerate it with the pipeline that produces it',
    hydrate: 'gitignored demo asset listed in manifests/demos_asset_manifest.json; `npm run hydrate` downloads it when a mirror is reachable (its offline placeholders do not count), or copy it from a machine that has it',
    performerAvatars: 'gitignored performer capture under models/; produce it with the performer capture / 3DGS avatar pipeline',
    ffmpeg: 'install ffmpeg (macOS: `brew install ffmpeg`; Ubuntu: `apt-get install ffmpeg`)',
    cwebp: 'install the WebP tools (macOS: `brew install webp`; Ubuntu: `apt-get install webp`)'
} as const;

function resolveRepoPath(p: string): string {
    return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

function display(p: string): string {
    const abs = resolveRepoPath(p);
    const rel = path.relative(REPO_ROOT, abs);
    return rel.startsWith('..') ? abs : rel;
}

/** Requires a file (or directory) to exist. Relative paths resolve against the repo root. */
export function requireFile(p: string, howToObtain: string = HOW_TO.gitignoredAsset): Requirement {
    const ok = fs.existsSync(resolveRepoPath(p));
    return { ok, reason: ok ? '' : `missing ${display(p)} (${howToObtain})` };
}

let manifestSizes: Map<string, number> | null = null;

/** manifests/demos_asset_manifest.json: repo-relative path -> declared size in bytes (0 when undeclared). */
function demoManifest(): Map<string, number> {
    if (manifestSizes) return manifestSizes;
    manifestSizes = new Map();
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifests/demos_asset_manifest.json'), 'utf-8'));
        for (const a of manifest.assets ?? []) {
            if (typeof a.path === 'string') manifestSizes.set(a.path, typeof a.sizeBytes === 'number' ? a.sizeBytes : 0);
        }
    } catch { /* no manifest: every asset gets the generic hint */ }
    return manifestSizes;
}

// Byte-exact stand-ins scripts/hydrate_demo_assets.cjs writes when it cannot download an asset.
const HYDRATOR_STUBS = [
    'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAB5tZGF0AAAC' +
    'AAAAAAAPAAACAAAAAAAPAAACAAAAAAAPAAAApG1vb3YAAABsbXZoZAAAAAB2bU5ydm1O' +
    'cgAA+gAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAIAAAACJ0cmFrAAAAXHRraGQAAAAHd21OcnZtTnIAAAABAA' +
    'AAAAEAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAABAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAEAAAAAEAAAAA',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
].map(b => Buffer.from(b, 'base64'));

/**
 * True when the file is an offline stand-in written by `npm run hydrate` (scripts/hydrate_demo_assets.cjs)
 * rather than the real asset: a GLB/JSON tagged with the hydrator generator name, one of its byte-exact
 * MP4/PNG stubs, or a manifest asset far smaller than its declared size (procedural splats, test-pattern videos).
 */
export function isHydratorPlaceholder(p: string): boolean {
    const abs = resolveRepoPath(p);
    let head: Buffer;
    let size: number;
    try {
        const st = fs.statSync(abs);
        if (!st.isFile()) return false;
        size = st.size;
        const fd = fs.openSync(abs, 'r');
        try {
            const buf = Buffer.alloc(4096);
            head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return false;
    }
    const text = head.toString('latin1');
    if (text.includes('Scratchbox Procedural Hydrator') || text.includes('Scratchbox Demo Hydrator')) return true;
    if (HYDRATOR_STUBS.some(stub => stub.equals(head))) return true;
    const declared = demoManifest().get(display(p)) ?? 0;
    return declared > 0 && size < declared / 2;
}

/**
 * Requires gitignored binary assets (models, splats, video plates, captures). An `npm run hydrate`
 * offline stand-in counts as missing. The hint says `npm run hydrate` when the asset is listed in
 * manifests/demos_asset_manifest.json, and otherwise names `producer` (the script/pipeline that
 * generates it) when given.
 */
export function requireAssets(paths: readonly string[], producer?: string): Requirement {
    const missing = paths.filter(p => !fs.existsSync(resolveRepoPath(p)));
    const stubs = paths.filter(p => !missing.includes(p) && isHydratorPlaceholder(p));
    if (missing.length === 0 && stubs.length === 0) return { ok: true, reason: '' };
    const unmet = [...missing, ...stubs];
    const inManifest = unmet.every(p => demoManifest().has(display(p)));
    const hint = inManifest
        ? HOW_TO.hydrate
        : producer
            ? `gitignored; regenerate with ${producer} or copy it from a machine that has it`
            : HOW_TO.gitignoredAsset;
    const parts: string[] = [];
    if (missing.length) parts.push(`missing ${missing.map(display).join(', ')}`);
    if (stubs.length) parts.push(`${stubs.map(display).join(', ')} is only an \`npm run hydrate\` offline placeholder`);
    return { ok: false, reason: `${parts.join('; ')} (${hint})` };
}

export function requireAsset(p: string, producer?: string): Requirement {
    return requireAssets([p], producer);
}

/** Requires every listed file to exist; the reason names all missing ones. */
export function requireFiles(paths: readonly string[], howToObtain: string = HOW_TO.gitignoredAsset): Requirement {
    const missing = paths.filter(p => !fs.existsSync(resolveRepoPath(p)));
    if (missing.length === 0) return { ok: true, reason: '' };
    return { ok: false, reason: `missing ${missing.map(display).join(', ')} (${howToObtain})` };
}

const binaryCache = new Map<string, string | null>();

/** Returns the absolute path of an executable on PATH, or null. */
export function findBinary(name: string): string | null {
    if (binaryCache.has(name)) return binaryCache.get(name)!;
    let found: string | null = null;
    if (path.isAbsolute(name)) {
        found = fs.existsSync(name) ? name : null;
    } else {
        const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE').split(';') : [''];
        for (const dir of (process.env.PATH || '').split(path.delimiter)) {
            if (!dir) continue;
            for (const ext of exts) {
                const candidate = path.join(dir, name + ext);
                try {
                    fs.accessSync(candidate, fs.constants.X_OK);
                    found = candidate;
                    break;
                } catch { /* keep looking */ }
            }
            if (found) break;
        }
    }
    binaryCache.set(name, found);
    return found;
}

/** Requires an executable on PATH. */
export function requireBinary(name: string, howToObtain: string = `install \`${name}\``): Requirement {
    const ok = findBinary(name) !== null;
    return { ok, reason: ok ? '' : `\`${name}\` not found on PATH (${howToObtain})` };
}

/**
 * Requires a binary on PATH that also accepts `probeArgs` with exit code 0
 * (for example an encoder that must be compiled with a specific codec).
 */
export function requireWorkingBinary(name: string, probeArgs: readonly string[], howToObtain: string): Requirement {
    const bin = findBinary(name);
    if (!bin) return { ok: false, reason: `\`${name}\` not found on PATH (${howToObtain})` };
    try {
        execFileSync(bin, probeArgs as string[], { stdio: 'ignore', timeout: 15_000 });
        return { ok: true, reason: '' };
    } catch {
        return { ok: false, reason: `\`${name} ${probeArgs.join(' ')}\` failed (${howToObtain})` };
    }
}

/** Requires `python` (a path or a name on PATH) to import every listed module. */
export function requirePythonModules(python: string, modules: readonly string[]): Requirement {
    const bin = findBinary(python);
    if (!bin) return { ok: false, reason: `\`${python}\` not found` };
    try {
        execFileSync(bin, ['-c', modules.map(m => `import ${m}`).join('; ')], { stdio: 'ignore', timeout: 30_000 });
        return { ok: true, reason: '' };
    } catch {
        return { ok: false, reason: `${display(bin)} cannot import ${modules.join(', ')} (\`${python} -m pip install ${modules.join(' ')}\`)` };
    }
}

/** Requires every listed environment variable to be set and non-empty. */
export function requireEnv(names: string | readonly string[], purpose?: string): Requirement {
    const list = typeof names === 'string' ? [names] : names;
    const missing = list.filter(n => !process.env[n]);
    if (missing.length === 0) return { ok: true, reason: '' };
    return { ok: false, reason: `env ${missing.join(', ')} not set${purpose ? ` (${purpose})` : ''}` };
}

/** Requires at least one of the listed environment variables to be set. */
export function requireAnyEnv(names: readonly string[], purpose?: string): Requirement {
    const ok = names.some(n => !!process.env[n]);
    return { ok, reason: ok ? '' : `none of env ${names.join(' / ')} set${purpose ? ` (${purpose})` : ''}` };
}

/** Combines requirements; unmet when any is unmet, with all reasons joined. */
export function requireAll(...reqs: Requirement[]): Requirement {
    const unmet = reqs.filter(r => !r.ok);
    return unmet.length === 0 ? { ok: true, reason: '' } : { ok: false, reason: unmet.map(r => r.reason).join('; ') };
}

/** Appends the skip reason to a describe/it title when the requirement is unmet. */
export function withReason(title: string, req: Requirement): string {
    return req.ok ? title : `${title} [skipped: ${req.reason}]`;
}

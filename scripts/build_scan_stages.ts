/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Builds the scan pipeline stages from a real 3D tile. The scan is kept throughout: no procedural
 * replacement, no synthetic textures.
 *
 *   Stage 1: the raw scan as studio clay (identity pass through the patcher, crease-split normals).
 *   Stage 2: the rectified scan. Applies the SBRX sidecar written by the native rectifier
 *            (build/3d-native/run_scan_rectifier) and writes
 *              <work>/stage2_textured_base.glb  positions patched, hidden triangles dropped,
 *                                               images / UVs / materials byte-identical
 *              <work>/stage2_clay.glb           the same geometry as studio clay
 *
 * Every gate is measured by scan-geometry-metrics.ts from the files written to disk, never from
 * the editing code's own counters. Public outputs are written only when all gates pass, and the
 * existing public stage files are backed up to .scratchbox/backup/ first.
 *
 * Usage:
 *   npx vite-node scripts/build_scan_stages.ts --tile <tile.glb> --work <dir> --stage 1|2|all
 *     [--sidecar <path>]          default <work>/stage2.rectify.bin
 *     [--run-rectifier]           run the native rectifier first (writes the sidecar)
 *     [--rectifier-bin <path>]    default build/3d-native/run_scan_rectifier
 *     [--rectifier-args "<args>"] arguments passed to the rectifier (default: CANONICAL_RECTIFIER_ARGS)
 *     [--anchor lat,lng,h]        geodetic anchor of the tile frame, recorded as provenance
 *     [--crease-deg 30]           clay normal crease angle
 *     [--public-dir public/models]
 *     [--stage1-name omnispatial_stage1_real_clay_tile.glb]
 *     [--stage2-name omnispatial_stage2_vector_refined.glb]
 *     [--backup-dir .scratchbox/backup]
 *     [--metrics-frame <json>]    optional MetricsFrameSpec for site-level gates
 *     [--no-publish]              write work-dir outputs and reports only
 *     [--publish-on-gate-failure] publish even when a gate fails (reported loudly)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import {
    applyRectification,
    createIdentitySidecar,
    parseGlb,
    readSbrxSidecar,
    serializeGlb,
    toClay,
    encodeSbrxSidecar
} from '../packages/core/src/node/3d-engine/glb-geometry-patcher';
import {
    measureClayStage,
    measureRectifiedStage,
    type GateResult,
    type MetricsFrameSpec
} from '../packages/core/src/node/3d-engine/scan-geometry-metrics';

/**
 * Rectifier arguments of the published chain: plan G's tolerances plus the optional D10 denoise of steep
 * unclassified surfaces (plan D10 has it off by default; the published chain turns it on because the 15-45 degree
 * spurious-crease gate needs it once chunk seams are kept closed, thin walls keep their order and piers keep their
 * relief). Everything else (relief sheets, opposed-sheet and fold guards, guard restore, local tier support,
 * kept collapse slivers, nadir visibility) is the kernel's default. All of them are continuous metric
 * tolerances; nothing is scene-specific.
 */
export const CANONICAL_RECTIFIER_ARGS = [
    '--rays', '192', '--rig-cams', '48', '--tau-wall', '0.5', '--tau-roof', '0.4', '--tau-corner', '0.7', '--offset-tol', '0.3',
    '--family-snap-deg', '1.5', '--min-wall-area', '15', '--denoise'
];

/** Public stage files the pipeline owns (all three are backed up before any publish). */
const PUBLIC_STAGE_FILES = [
    'omnispatial_stage1_real_clay_tile.glb',
    'omnispatial_stage2_vector_refined.glb',
    'omnispatial_real_stage3_streetview_pbr.glb'
];

interface CliArgs {
    tile: string;
    work: string;
    stage: '1' | '2' | 'all';
    sidecar?: string;
    runRectifier: boolean;
    rectifierBin: string;
    rectifierArgs: string[];
    anchor: { lat: number; lng: number; h: number } | null;
    creaseDeg: number;
    publicDir: string;
    stage1Name: string;
    stage2Name: string;
    backupDir: string;
    metricsFrame?: MetricsFrameSpec;
    publish: boolean;
    publishOnGateFailure: boolean;
}

function parseArgs(argv: string[]): CliArgs {
    const get = (name: string): string | undefined => {
        const i = argv.indexOf(name);
        return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
    };
    const has = (name: string): boolean => argv.includes(name);
    const tile = get('--tile');
    const work = get('--work');
    const stage = get('--stage') ?? 'all';
    if (!tile || !work) throw new Error('usage: build_scan_stages.ts --tile <tile.glb> --work <dir> --stage 1|2|all [options]');
    if (stage !== '1' && stage !== '2' && stage !== 'all') throw new Error(`--stage must be 1, 2 or all (got ${stage})`);
    let anchor: CliArgs['anchor'] = null;
    const a = get('--anchor');
    if (a) {
        const [lat, lng, h] = a.split(',').map(Number);
        if (![lat, lng].every(Number.isFinite)) throw new Error(`--anchor must be lat,lng[,h] (got ${a})`);
        anchor = { lat, lng, h: Number.isFinite(h) ? h : 0 };
    }
    const frameFile = get('--metrics-frame');
    return {
        tile: path.resolve(tile),
        work: path.resolve(work),
        stage,
        sidecar: get('--sidecar') ? path.resolve(get('--sidecar')!) : undefined,
        runRectifier: has('--run-rectifier'),
        rectifierBin: path.resolve(get('--rectifier-bin') ?? 'build/3d-native/run_scan_rectifier'),
        rectifierArgs: get('--rectifier-args') !== undefined ? get('--rectifier-args')!.split(/\s+/).filter(Boolean) : [...CANONICAL_RECTIFIER_ARGS],
        anchor,
        creaseDeg: Number(get('--crease-deg') ?? 30),
        publicDir: path.resolve(get('--public-dir') ?? 'public/models'),
        stage1Name: get('--stage1-name') ?? PUBLIC_STAGE_FILES[0],
        stage2Name: get('--stage2-name') ?? PUBLIC_STAGE_FILES[1],
        backupDir: path.resolve(get('--backup-dir') ?? '.scratchbox/backup'),
        metricsFrame: frameFile ? (JSON.parse(fs.readFileSync(frameFile, 'utf8')) as MetricsFrameSpec) : undefined,
        publish: !has('--no-publish'),
        publishOnGateFailure: has('--publish-on-gate-failure')
    };
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const rel = (p: string): string => path.relative(process.cwd(), p) || p;

function writeAtomic(file: string, data: Buffer | string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

/**
 * Copies each existing public stage file to <backupDir>/<name>.<sha12>.glb unless that exact
 * content is already backed up, and appends to a manifest. Never overwrites a backup.
 */
function backupPublicStages(args: CliArgs): Array<{ file: string; backup: string; sha256: string; skipped: boolean }> {
    fs.mkdirSync(args.backupDir, { recursive: true });
    const done: Array<{ file: string; backup: string; sha256: string; skipped: boolean }> = [];
    const names = new Set([...PUBLIC_STAGE_FILES, args.stage1Name, args.stage2Name]);
    for (const name of names) {
        const file = path.join(args.publicDir, name);
        if (!fs.existsSync(file)) continue;
        const bytes = fs.readFileSync(fs.realpathSync(file));
        const digest = sha256(bytes);
        const backup = path.join(args.backupDir, `${path.basename(name, '.glb')}.${digest.slice(0, 12)}.glb`);
        const skipped = fs.existsSync(backup);
        if (!skipped) fs.writeFileSync(backup, bytes);
        done.push({ file: rel(file), backup: rel(backup), sha256: digest, skipped });
    }
    const manifestPath = path.join(args.backupDir, 'scan_stages_backup_manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];
    manifest.push({ at: new Date().toISOString(), entries: done });
    writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));
    return done;
}

function printGates(title: string, gates: GateResult[]): void {
    console.log(`\n${title}`);
    for (const g of gates) {
        const v = typeof g.value === 'number' ? Number(g.value.toPrecision(6)) : g.value;
        console.log(`  [${g.pass ? 'PASS' : 'FAIL'}] ${g.name}: ${v} (${g.limit})`);
    }
}

function provenance(args: CliArgs, tileBytes: Buffer, stage: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        scratchboxScanStage: {
            stage,
            sourceTile: rel(args.tile),
            sourceTileSha256: sha256(tileBytes),
            anchor: args.anchor,
            creaseAngleDeg: args.creaseDeg,
            generatedAt: new Date().toISOString(),
            ...extra
        }
    };
}

function publish(args: CliArgs, source: string, name: string, pass: boolean, backedUp: { value: boolean }): string | null {
    if (!args.publish) return null;
    if (!pass && !args.publishOnGateFailure) {
        console.log(`  not publishing ${name}: gates failed (use --publish-on-gate-failure to override)`);
        return null;
    }
    if (!backedUp.value) {
        for (const b of backupPublicStages(args)) console.log(`  backup ${b.file} -> ${b.backup}${b.skipped ? ' (already present)' : ''}`);
        backedUp.value = true;
    }
    const target = path.join(args.publicDir, name);
    writeAtomic(target, fs.readFileSync(source));
    console.log(`  published ${rel(target)}${pass ? '' : '  (GATES FAILED, published on request)'}`);
    return rel(target);
}

function runStage1(args: CliArgs, tileBytes: Buffer, backedUp: { value: boolean }): boolean {
    const t0 = Date.now();
    console.log(`\n== Stage 1: raw scan, studio clay (${rel(args.tile)}) ==`);
    const doc = parseGlb(tileBytes);
    const identity = createIdentitySidecar(doc);
    const sidecarPath = path.join(args.work, 'stage1.identity.sbrx');
    writeAtomic(sidecarPath, encodeSbrxSidecar(identity));
    const patched = applyRectification(doc, identity);
    const clay = toClay(patched.doc, {
        creaseAngleDeg: args.creaseDeg,
        meshName: 'ScanStage1_RawScan_StudioGreyClay',
        extras: provenance(args, tileBytes, 1, { description: 'raw scan, identity pass, studio clay' })
    });
    const clayPath = path.join(args.work, 'stage1_clay.glb');
    writeAtomic(clayPath, serializeGlb(clay.doc));

    const measured = measureClayStage(tileBytes, fs.readFileSync(clayPath), { creaseAngleDeg: args.creaseDeg });
    printGates('Stage 1 gates (measured from the written file)', measured.gates);
    const published = publish(args, clayPath, args.stage1Name, measured.pass, backedUp);
    writeAtomic(path.join(args.work, 'stage1.gates.json'), JSON.stringify({
        stage: 1, tile: rel(args.tile), output: rel(clayPath), published, elapsedMs: Date.now() - t0,
        patcherReport: patched.report, clayReport: clay.report, measurement: measured
    }, null, 2));
    console.log(`  stage 1 ${measured.pass ? 'PASSED' : 'FAILED'} in ${Date.now() - t0} ms; ${measured.clay.triangles} tris, ${(measured.clay.bytes / 1e6).toFixed(2)} MB`);
    return measured.pass;
}

function ensureSidecar(args: CliArgs): string {
    const sidecar = args.sidecar ?? path.join(args.work, 'stage2.rectify.bin');
    if (args.runRectifier) {
        if (!fs.existsSync(args.rectifierBin)) {
            throw new Error(`rectifier binary not found at ${rel(args.rectifierBin)}; build it with:\n  clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include scripts/run_scan_rectifier.cpp -o build/3d-native/run_scan_rectifier -lz`);
        }
        fs.mkdirSync(path.dirname(sidecar), { recursive: true });
        const cmd = [args.rectifierBin, '--input', args.tile, '--out', sidecar, ...args.rectifierArgs];
        console.log(`  running ${cmd.map(rel).join(' ')}`);
        const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
        if (r.status !== 0) throw new Error(`rectifier exited with ${r.status ?? r.signal}`);
    }
    if (!fs.existsSync(sidecar)) {
        throw new Error(`no rectification sidecar at ${rel(sidecar)}. Run the native rectifier first, e.g.\n`
            + `  build/3d-native/run_scan_rectifier --input ${rel(args.tile)} --out ${rel(sidecar)}\n`
            + 'or pass --run-rectifier / --sidecar <path>.');
    }
    return sidecar;
}

function runStage2(args: CliArgs, tileBytes: Buffer, backedUp: { value: boolean }): boolean {
    const t0 = Date.now();
    console.log(`\n== Stage 2: rectified scan (${rel(args.tile)}) ==`);
    const sidecarPath = ensureSidecar(args);
    const sidecarBytes = fs.readFileSync(sidecarPath);
    const sidecar = readSbrxSidecar(sidecarBytes);
    const patched = applyRectification(parseGlb(tileBytes), sidecar);
    const basePath = path.join(args.work, 'stage2_textured_base.glb');
    const baseBytes = serializeGlb(patched.doc);
    writeAtomic(basePath, baseBytes);
    const clay = toClay(patched.doc, {
        creaseAngleDeg: args.creaseDeg,
        meshName: 'ScanStage2_RectifiedScan_StudioGreyClay',
        extras: provenance(args, tileBytes, 2, {
            description: 'rectified scan (hidden shells culled, plane-snapped), studio clay',
            sidecar: rel(sidecarPath),
            sidecarSha256: sha256(sidecarBytes)
        })
    });
    const clayPath = path.join(args.work, 'stage2_clay.glb');
    writeAtomic(clayPath, serializeGlb(clay.doc));

    const writtenBase = fs.readFileSync(basePath);
    const rect = measureRectifiedStage(tileBytes, writtenBase, { frame: args.metricsFrame });
    const clayM = measureClayStage(writtenBase, fs.readFileSync(clayPath), { creaseAngleDeg: args.creaseDeg });
    printGates('Stage 2 textured-base gates (measured from the written files)', rect.gates);
    printGates('Stage 2 clay gates', clayM.gates);
    const pass = rect.pass && clayM.pass;
    const published = publish(args, clayPath, args.stage2Name, pass, backedUp);
    writeAtomic(path.join(args.work, 'stage2.gates.json'), JSON.stringify({
        stage: 2, tile: rel(args.tile), sidecar: rel(sidecarPath), texturedBase: rel(basePath), clay: rel(clayPath),
        published, elapsedMs: Date.now() - t0, patcherReport: patched.report, clayReport: clay.report,
        measurement: rect, clayMeasurement: clayM
    }, null, 2));
    console.log(`  stage 2 ${pass ? 'PASSED' : 'FAILED'} in ${Date.now() - t0} ms; base ${(writtenBase.length / 1e6).toFixed(2)} MB, `
        + `${rect.output.triangles} of ${rect.input.triangles} tris kept`);
    return pass;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(args.tile)) throw new Error(`tile not found: ${args.tile}`);
    fs.mkdirSync(args.work, { recursive: true });
    const tileBytes = fs.readFileSync(args.tile);
    const backedUp = { value: false };
    let ok = true;
    if (args.stage === '1' || args.stage === 'all') ok = runStage1(args, tileBytes, backedUp) && ok;
    if (args.stage === '2' || args.stage === 'all') ok = runStage2(args, tileBytes, backedUp) && ok;
    process.exitCode = ok ? 0 : 1;
}

try {
    main();
} catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
}

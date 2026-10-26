/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A carrier program: elements of the universal operators placed directly in the tile frame (sweeps of a profile along a
 * carrier, solids of revolution, replicators at a pitch along a carrier), built natively by scripts/carrier_program.cpp on
 * the ornament builder's operators (scratchbox_ornament.hpp). The program is continuous numbers and opaque ids; nothing
 * here or there branches on what an element is called. Each element carries its own provenance (label, confidence,
 * method, the real reason when it is a fill) into the GLB the caller writes.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from '../native-build-cache';
import { findTileRefineRepoRoot } from '../tile-refine-service';

export const CARRIER_PROGRAM_VERSION = 'carrier-program/1';

const CLI_SOURCE = path.join('scripts', 'carrier_program.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');

export type Vec2 = [number, number];

export interface ElementProvenance {
    label: 'measured' | 'vector-modelled' | 'photo-inferred' | 'generated';
    confidence: number;
    method: string;
    /** Why the element is estimated rather than measured, when it is. */
    reason?: string;
}

export interface SweepElement {
    op: 'sweep';
    /** Carrier points (tile frame). */
    carrier: Vec3[];
    /** The section's v direction (made square to the travel); u = v x t. */
    ref: Vec3;
    profile: { outer: Vec2[]; holes?: Vec2[][] };
    caps?: boolean;
    scale?: Vec2[];
    twistDeg?: Vec2[];
}

export interface RevolveElement {
    op: 'revolve';
    /** Meridian (r, z), z along the axis. */
    profile: Vec2[];
    axis?: Vec3;
    lobes?: number; amplitude?: number; helixTurns?: number; segments?: number; startDeg?: number; sweepDeg?: number;
    /** One solid per point (absent inside a replicator's seed). */
    at?: Vec3[];
}

export interface ReplicateElement {
    op: 'replicate';
    carrier: Vec3[];
    pitch: number;
    start?: number;
    end?: number;
    /** A revolve stands at each place; a sweep's carrier and ref are in the place's frame (along, across, up). */
    seed: Omit<RevolveElement, 'at'> | SweepElement;
}

export type CarrierElement = (SweepElement | RevolveElement | ReplicateElement) & {
    id: string;
    provenance: ElementProvenance;
    /** Opaque group the caller collects elements by (one GLB node per group); default the id. */
    group?: string;
    /** sRGB 0..255 the element is drawn in when it has no photo (generated colour; its provenance says so). */
    colourSrgb?: Vec3;
};

export interface CarrierProgram { elements: CarrierElement[]; maxTriangles?: number }

export interface BuiltElement {
    id: string; group: string; op: string; provenance: ElementProvenance; colourSrgb?: Vec3;
    instances: number; positions: Float32Array; indices: Uint32Array;
}

export interface CarrierProgramResult { built: BuiltElement[]; dropped: Array<{ id: string; reason: string }>; triangles: number; ms: number }

let building: Promise<string> | undefined;

/** Builds the CLI through the native build cache (rebuilt when its source or a header changes; a failed build throws). */
export function ensureCarrierProgramBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_CARRIER_PROGRAM_BIN) return Promise.resolve(process.env.SCRATCHBOX_CARRIER_PROGRAM_BIN);
    building ??= (async () => {
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), name: 'carrier_program', timeoutMs: 300_000 });
            return built.binaryPath;
        } catch (err) {
            throw new Error(`could not build carrier_program: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** Runs the program natively in `dir` (created); throws with the tool's own error. Dropped elements are listed with why. */
export async function runCarrierProgram(program: CarrierProgram, dir: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CarrierProgramResult> {
    const binary = await ensureCarrierProgramBinary();
    fs.mkdirSync(dir, { recursive: true });
    const specPath = path.join(dir, 'program.json');
    fs.writeFileSync(specPath, JSON.stringify({ elements: program.elements.map(({ provenance, group, colourSrgb, ...e }) => e), ...(program.maxTriangles ? { maxTriangles: program.maxTriangles } : {}) }));
    const t0 = Date.now();
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile(binary, [specPath, dir], { timeout: opts.timeoutMs ?? 300_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, ...(opts.signal ? { signal: opts.signal } : {}) }, (err, out) => {
            if (err) {
                let msg = String(out || err.message).trim().split('\n').pop() ?? err.message;
                try { msg = JSON.parse(msg).error ?? msg; } catch { /* the raw line */ }
                reject(new Error(`carrier_program failed: ${msg}`));
            } else resolve(out);
        });
    });
    const head = JSON.parse(stdout.trim().split('\n').pop()!);
    if (!head.ok) throw new Error(`carrier_program failed: ${head.error}`);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as { elements: Array<{ id: string; op: string; dropped?: string; instances?: number; vertices?: number; triangles?: number; positionsOffset?: number; indicesOffset?: number }>; triangles: number };
    const bin = fs.readFileSync(path.join(dir, 'mesh.bin'));
    const built: BuiltElement[] = [], dropped: Array<{ id: string; reason: string }> = [];
    report.elements.forEach((r, k) => {
        const e = program.elements[k];
        if (r.dropped !== undefined) { dropped.push({ id: r.id, reason: r.dropped }); return; }
        const positions = new Float32Array(r.vertices! * 3), indices = new Uint32Array(r.triangles! * 3);
        for (let i = 0; i < positions.length; i++) positions[i] = bin.readFloatLE(r.positionsOffset! + i * 4);
        for (let i = 0; i < indices.length; i++) indices[i] = bin.readUInt32LE(r.indicesOffset! + i * 4);
        built.push({ id: r.id, group: e.group ?? e.id, op: r.op, provenance: e.provenance, ...(e.colourSrgb ? { colourSrgb: e.colourSrgb } : {}), instances: r.instances!, positions, indices });
    });
    return { built, dropped, triangles: report.triangles, ms: Date.now() - t0 };
}

/** The built elements merged per group (one mesh each, in program order). */
export function mergeGroups(built: BuiltElement[]): Array<{ group: string; elements: BuiltElement[]; positions: Float32Array; indices: Uint32Array }> {
    const groups = new Map<string, BuiltElement[]>();
    for (const b of built) { const g = groups.get(b.group); if (g) g.push(b); else groups.set(b.group, [b]); }
    return [...groups].map(([group, elements]) => {
        const nv = elements.reduce((s, e) => s + e.positions.length, 0), ni = elements.reduce((s, e) => s + e.indices.length, 0);
        const positions = new Float32Array(nv), indices = new Uint32Array(ni);
        let pv = 0, pi = 0;
        for (const e of elements) {
            positions.set(e.positions, pv);
            for (let i = 0; i < e.indices.length; i++) indices[pi + i] = e.indices[i] + pv / 3;
            pv += e.positions.length; pi += e.indices.length;
        }
        return { group, elements, positions, indices };
    });
}

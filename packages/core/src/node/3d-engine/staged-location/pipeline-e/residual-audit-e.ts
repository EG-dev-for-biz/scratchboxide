/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The residual audit (../residual-audit.ts) on a pipeline E native run: the clean solid is the run's walls, roofs, bases
 * and modelled facets (not its openings, sweeps or residual), the candidates are its residual nodes with their tile photos.
 * Afterwards the residual nodes hold only what the audit keeps: real objects as scanned (provenance "as-scanned"), unsure
 * clusters in their own nodes ("as-scanned:unsure", labelled), and the scan artefacts are gone.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import { auditResidual, removedTriangleIds, verdictByTriangle, writeAuditResult, trianglePhoto, type AuditSource, type ResidualAuditResult } from '../residual-audit';
import type { MassingNode, MassingRun } from './native-massing';

/** The provenance token of residual kept although the audit could not decide. */
export const UNSURE_PROVENANCE = 'as-scanned:unsure';

const SOLID_KINDS = (k: string) => k !== 'residual' && k !== 'opening' && k !== 'sweep' && k !== 'facesweep';

function soup(n: MassingNode, tris?: number[]): Float32Array {
    const list = tris ?? Array.from({ length: n.indices.length / 3 }, (_, t) => t);
    const out = new Float32Array(list.length * 9);
    list.forEach((t, k) => { for (let j = 0; j < 3; j++) { const v = n.indices[t * 3 + j]; out.set(n.positions.subarray(v * 3, v * 3 + 3), k * 9 + j * 3); } });
    return out;
}

/** The ground apron's height: residual triangles wholly this close above the ground are the apron the massing stands on (not audited). */
export const APRON_HEIGHT_M = 0.85;

/** The tile photos of a run, decoded once. */
function tileImages(run: MassingRun): Map<number, RgbaImage8> {
    const out = new Map<number, RgbaImage8>();
    for (const im of run.report.images) {
        const f = path.join(run.dir, im.file);
        if (!fs.existsSync(f)) continue;
        try { out.set(im.image, decodeImageInMemory(fs.readFileSync(f))); } catch { /* an undecodable photo leaves its triangles without one */ }
    }
    return out;
}

/** Audits `run`'s residual and rewrites its residual nodes in place; returns the result (also written to run.dir/residual_audit.json). */
/** `outDir` (default the run's directory) takes the audit's files, so a run read from elsewhere is not written to. */
export async function auditMassingRun(run: MassingRun, opts: { groundY?: number; signal?: AbortSignal; outDir?: string } = {}): Promise<ResidualAuditResult> {
    const solidNodes = run.nodes.filter(n => SOLID_KINDS(n.kind));
    const solidParts = solidNodes.map(n => soup(n));
    const solid = new Float32Array(solidParts.reduce((s, a) => s + a.length, 0));
    let o = 0;
    for (const a of solidParts) { solid.set(a, o); o += a.length; }
    const residual = run.nodes.filter(n => n.kind === 'residual');
    const images = tileImages(run);
    const groundY = opts.groundY ?? (run.report.parts.length ? Math.min(...run.report.parts.map(p => p.baseY)) : undefined);
    let apron = 0;
    const sources: AuditSource[] = residual.map(n => {
        const photo: AuditSource['photo'] = [];
        const tris: number[] = [];
        for (let t = 0; t < n.indices.length / 3; t++) {
            const v = [n.indices[t * 3], n.indices[t * 3 + 1], n.indices[t * 3 + 2]];
            if (groundY !== undefined && Math.max(...v.map(i => n.positions[i * 3 + 1])) <= groundY + APRON_HEIGHT_M) { apron++; continue; }
            tris.push(t);
            const img = images.get(-n.ref[v[0]] - 2);
            photo.push(img ? trianglePhoto(img, v.map(i => [n.st[2 * i], n.st[2 * i + 1]] as [number, number])) : undefined);
        }
        return { node: n.name, triangles: soup(n, tris), photo, localTriangles: tris };
    });
    const result = await auditResidual({ solid, sources, ...(groundY !== undefined ? { groundY } : {}), dir: path.join(opts.outDir ?? run.dir, 'residual_audit'), ...(opts.signal ? { signal: opts.signal } : {}), idPrefix: `${path.basename(run.dir)}/residual` });
    if (apron) result.notes.splice(1, 0, `${apron} ground-apron triangles (wholly within ${APRON_HEIGHT_M} m of the ground) kept as scanned, not audited`);
    writeAuditResult(path.join(opts.outDir ?? run.dir, 'residual_audit.json'), result);
    applyAudit(run, result);
    return result;
}

/** Rewrites the run's residual nodes: artefact triangles dropped, unsure triangles moved to their own labelled nodes. */
export function applyAudit(run: MassingRun, result: ResidualAuditResult): void {
    const removed = removedTriangleIds(result), byTri = verdictByTriangle(result);
    const out: MassingNode[] = [];
    for (const n of run.nodes) {
        if (n.kind !== 'residual') { out.push(n); continue; }
        const src = result.sources.find(s => s.node === n.name);
        if (!src) { out.push(n); continue; }
        const keep: number[] = [], unsure: number[] = [];
        const idOf = new Map<number, number>();
        (src.localTriangles ?? Array.from({ length: src.triangles }, (_, t) => t)).forEach((t, k) => idOf.set(t, src.firstTriangle + k));
        for (let t = 0; t < n.indices.length / 3; t++) {
            const id = idOf.get(t);
            if (id === undefined) { keep.push(t); continue; }
            if (removed.has(id)) continue;
            (byTri.get(id)?.verdict === 'unsure' ? unsure : keep).push(t);
        }
        const take = (tris: number[], name: string, provenance: string): MassingNode => {
            const verts = new Map<number, number>();
            const idx: number[] = [];
            for (const t of tris) for (let k = 0; k < 3; k++) { const v = n.indices[t * 3 + k]; if (!verts.has(v)) verts.set(v, verts.size); idx.push(verts.get(v)!); }
            const order = [...verts.keys()];
            const pick = (a: Float32Array | Int32Array, w: number) => { const r = new (a.constructor as Float32ArrayConstructor)(order.length * w); order.forEach((v, i) => r.set(a.subarray(v * w, v * w + w), i * w)); return r; };
            return { ...n, name, provenance, positions: pick(n.positions, 3), normals: pick(n.normals, 3), ref: pick(n.ref, 1) as unknown as Int32Array, st: pick(n.st, 2), indices: Uint32Array.from(idx) };
        };
        if (keep.length) out.push(keep.length === n.indices.length / 3 ? n : take(keep, n.name, n.provenance));
        if (unsure.length) out.push(take(unsure, `${n.name}:unsure`, UNSURE_PROVENANCE));
    }
    run.nodes = out;
}

/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scan-led massing of a staged structure (sb.massing: scratchbox_scan_massing.hpp, scratchbox_roof_objects.hpp), run
 * from the run note 'structure_scan' the orchestrator writes after isolation. Candidates, simplest first: the footprint
 * raised with its walls on the scanned walls (block); the block with the objects standing on its roof (outlines from the
 * photo straight down, heights from the scan); a stack of tiers, one per setback; lofted sections. The first that explains
 * the scan height band by height band wins.
 *
 * Two callers: the chat tool structure_massing (the chosen mesh as a GLB) and pipeline H, which builds its facades on the
 * chosen massing (asMassingParts: the block or the tiers as parts with flat walls to survey, the raised roof objects as
 * parts, the revolved ones and the post rows as solids). A lofted winner has no flat walls for a facade to sit on;
 * asMassingParts says so instead of pretending.
 */

import * as fs from 'fs';
import { NativePythonRunnerService } from '../native-python-runner-service';
import { insetRing, type MassingMesh, type MassingPart } from './pipeline-e/massing-spec';
import { encodePng } from './png-encode';
import { readTileTriangles } from './tile-texture-transfer';
import { renderTopDownPhoto } from './top-down-photo';

/** The run note 'structure_scan' (orchestrator.ts, after the isolation check): the structure's scan and its footprint, in the tile frame. */
export interface StructureScanNote { scanGlb: string; districtGlb?: string; groundY: number; plan: Array<Array<[number, number]>>; planSource?: string; place?: string }

/** The photo straight down over the structure's plan (cached beside the scan with its frame), for the roof objects' outlines. */
export function roofPhotoFor(note: StructureScanNote): { path: string; frame: { x0: number; z0: number; texel: number } } | undefined {
    if (!note.districtGlb || !fs.existsSync(note.districtGlb) || !note.plan?.[0]?.length) return undefined;
    const xs = note.plan.flat().map(p => p[0]), zs = note.plan.flat().map(p => p[1]);
    const x0 = Math.floor(Math.min(...xs) - 5), z0 = Math.floor(Math.min(...zs) - 5);
    const texel = 0.06;
    const out = note.scanGlb.replace(/\.glb$/i, `_roof_photo_${x0}_${z0}.png`);
    const frameFile = out.replace(/\.png$/, '.json');
    if (!fs.existsSync(out) || !fs.existsSync(frameFile)) {
        const frame = { x0, z0, widthM: Math.ceil(Math.max(...xs) + 5) - x0, heightM: Math.ceil(Math.max(...zs) + 5) - z0 };
        const photo = renderTopDownPhoto(readTileTriangles(fs.readFileSync(note.districtGlb)), frame, { texelM: texel, maxPx: 2000 });
        fs.writeFileSync(out, encodePng(photo.width, photo.height, photo.rgba, 4));
        // the texel the renderer used (it grows past `texel` to stay under maxPx)
        fs.writeFileSync(frameFile, JSON.stringify({ x0, z0, texel: photo.texelM }));
    }
    return { path: out, frame: JSON.parse(fs.readFileSync(frameFile, 'utf8')) };
}

/** The SCAN_* environment sb.massing.Scan.from_scene() reads, with the roof photo when one can be rendered. */
export function scanEnv(note: StructureScanNote): Record<string, string> {
    const env: Record<string, string> = { SCAN_GLB_PATH: note.scanGlb, SCAN_GROUND_Y: String(note.groundY), SCAN_PLAN: JSON.stringify(note.plan) };
    if (note.districtGlb && fs.existsSync(note.districtGlb)) env.SCAN_DISTRICT_GLB_PATH = note.districtGlb;
    try {
        const roof = roofPhotoFor(note);
        if (roof) { env.SCAN_ROOF_PHOTO_PATH = roof.path; env.SCAN_ROOF_PHOTO_FRAME = JSON.stringify(roof.frame); }
    } catch (err) {
        console.warn(`[scan-massing] no roof photo: ${(err as Error).message}`);
    }
    return env;
}

export interface ScanMassingOptions { relief?: number; minCoverage?: number; minPrecision?: number; candidate?: string; timeoutMs?: number; signal?: AbortSignal }

export interface ScanMassingRoofObject {
    chosen: string; why: string; outlineSource: string; heightSource: string;
    outline: Array<[number, number]>; baseY: number; topY: number; areaM2: number;
    /** The fitted solid of an object that is not its outline raised (a solid of revolution, a row of posts). */
    mesh?: { v: Array<[number, number, number]>; i: number[] };
}

export interface ScanMassingResult {
    chosen: string; forced: boolean; explains: boolean; why: string;
    candidates: Array<{ label: string; coverage: number; precision: number; accepted: boolean; triangles: number; reason: string }>;
    groundY: number; roofY: number; top: number; samples: number;
    /** The footprint with its walls snapped onto the scanned walls. */
    block: Array<[number, number]>;
    tiers: Array<{ outline: Array<[number, number]>; y0: number; y1: number; area: number }>;
    roof: { photo: boolean; objects: ScanMassingRoofObject[] } | null;
    /** The chosen candidate's mesh as written (the GLB). */
    glbPath: string;
    /** The lofted candidate's mesh, when it is the one chosen. */
    loft?: { v: Array<[number, number, number]>; i: number[] };
}

const SCRIPT = `
import json, os
import scratchbox as sb
args = json.loads(os.environ["SB_MASSING_ARGS"])
scan = sb.massing.Scan.from_scene()
cands = scan.candidates()
choice = sb.massing.choose(scan, cands, args["minCoverage"], args["minPrecision"], args["relief"])
chosen = choice.candidate
if args.get("candidate"):
    forced = [c for c in cands if c.label == args["candidate"]]
    if not forced:
        raise SystemExit("no candidate named %r (candidates: %s)" % (args["candidate"], ", ".join(c.label for c in cands)))
    chosen = forced[0]
if chosen is None:
    raise SystemExit("no candidate could be scored against the scan: " + choice.why)
def mesh_of(m):
    return {"v": [[v.position.x, v.position.y, v.position.z] for v in m.vertices], "i": list(m.indices)}
roof = next((c.roof for c in cands if c.roof), None)
tiers = next((c.tiers for c in cands if c.tiers), None)
scene = sb.Scene()
scene.add_mesh(chosen.mesh)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
report = {
    "chosen": chosen.label, "forced": bool(args.get("candidate")), "explains": choice.explains, "why": choice.why,
    "candidates": [dict(r) for r in choice.rows], "groundY": scan.ground_y, "roofY": scan.roof_y(), "top": scan.top(), "samples": len(scan.samples),
    "block": [list(p) for p in scan.snapped_plan()],
    "tiers": [] if tiers is None else [{"outline": [list(p) for p in t.outline], "y0": t.y0, "y1": t.y1, "area": t.area} for t in tiers],
    "roof": None if roof is None else {"photo": bool(roof["photo"]), "objects": [
        {"chosen": o["chosen"], "why": o["why"], "outlineSource": o["outline_source"], "heightSource": o["height_source"],
         "outline": [list(p) for p in o["outline"]], "baseY": o["base_y"], "topY": o["top_y"], "areaM2": o["area"],
         **({"mesh": mesh_of(o["mesh"])} if o["chosen"] != "outline raised" and o["mesh"] is not None and o["mesh"].indices else {})}
        for o in roof["objects"]]},
}
if chosen.label == "lofted sections":
    report["loft"] = mesh_of(chosen.mesh)
json.dump(report, open(os.environ["SB_MASSING_REPORT_PATH"], "w"))
`;

/** Runs the choice on the structure's scan: the report, and the chosen mesh written as a GLB. */
export async function runScanMassing(note: StructureScanNote, opts: ScanMassingOptions = {}): Promise<ScanMassingResult> {
    const args = { relief: opts.relief ?? 2.5, minCoverage: opts.minCoverage ?? 0.9, minPrecision: opts.minPrecision ?? 0.85, ...(opts.candidate ? { candidate: opts.candidate } : {}) };
    const reportPath = note.scanGlb.replace(/\.glb$/i, `_massing_${process.pid}_${Date.now()}.json`);
    const env = { ...process.env, ...scanEnv(note), SB_MASSING_ARGS: JSON.stringify(args), SB_MASSING_REPORT_PATH: reportPath } as Record<string, string>;
    const result = await NativePythonRunnerService.getInstance().runScript(SCRIPT, { timeoutMs: opts.timeoutMs ?? 240_000, env, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!result.success || !fs.existsSync(reportPath) || !result.glbPath || !fs.existsSync(result.glbPath)) {
        throw new Error(`the scan massing could not be built: ${String(result.errorDetails || result.stderr || 'no report').slice(-1200)}`);
    }
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Omit<ScanMassingResult, 'glbPath'>;
    fs.rmSync(reportPath, { force: true });
    return { ...report, glbPath: result.glbPath };
}

/** The provenance token of the scan-led massing's parts and solids (passed through to their nodes). */
export const SCAN_MASSING_PROVENANCE = 'scan-massing';
/**
 * A roof object's outline is kept this far inside the block's walls: an outline touching a wall makes the native tool
 * split that wall where the object meets it (the Haughwout block came out as 64 wall slivers instead of 7 walls), and
 * nothing is built past the footprint.
 */
export const ROOF_WALL_CLEARANCE_M = 0.15;

function insideRing(ring: Array<[number, number]>, x: number, z: number): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i], [xj, zj] = ring[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/** `outline` with every point outside `ring` moved onto its nearest point of `ring`; how many moved. */
export function clampInto(outline: Array<[number, number]>, ring: Array<[number, number]>): { outline: Array<[number, number]>; moved: number } {
    let moved = 0;
    const out = outline.map(([x, z]): [number, number] => {
        if (insideRing(ring, x, z)) return [x, z];
        moved++;
        let best: [number, number] = [x, z], bd = Infinity;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [ax, az] = ring[j], [bx, bz] = ring[i];
            const L2 = (bx - ax) ** 2 + (bz - az) ** 2;
            const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / L2)) : 0;
            const px = ax + t * (bx - ax), pz = az + t * (bz - az), d = Math.hypot(x - px, z - pz);
            if (d < bd) { bd = d; best = [px, pz]; }
        }
        return best;
    });
    return { outline: out, moved };
}

/** Corners sharper than this are spikes: an outline doubling back on itself (wall snapping turned the Haughwout plan's 0.5 m jog into a 2.1 m sliver). */
export const SPIKE_DEG = 25;

/** `ring` without its spikes: each vertex whose two edges meet at under `minDeg` is dropped, until none is left. */
export function dropSpikes(ring: Array<[number, number]>, minDeg = SPIKE_DEG): { ring: Array<[number, number]>; dropped: number } {
    const r = ring.map(p => [p[0], p[1]] as [number, number]);
    let dropped = 0;
    for (let changed = true; changed && r.length > 3;) {
        changed = false;
        for (let i = 0; i < r.length && r.length > 3; i++) {
            const a = r[(i - 1 + r.length) % r.length], b = r[i], c = r[(i + 1) % r.length];
            const ux = a[0] - b[0], uz = a[1] - b[1], vx = c[0] - b[0], vz = c[1] - b[1];
            const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
            const deg = lu && lv ? (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / (lu * lv)))) * 180) / Math.PI : 0;
            if (deg < minDeg) { r.splice(i, 1); dropped++; changed = true; break; }
        }
    }
    return { ring: r, dropped };
}

function ringArea(r: Array<[number, number]>): number {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return Math.abs(a) / 2;
}

/**
 * The chosen massing as parts the native tool builds facades on: the block (with its raised roof objects as parts and its
 * revolved and repeated ones as solids) or the tiers. A lofted winner has no flat walls to read a facade onto: `reason`
 * says so and nothing is returned.
 */
export function asMassingParts(r: ScanMassingResult): { parts: MassingPart[]; meshes: MassingMesh[]; notes: string[] } | { reason: string } {
    const part = (id: string, loop: Array<[number, number]>, baseY: number, topY: number, note: string): MassingPart => ({
        id, baseY, topY, loops: [loop.map(([x, z]) => [x, z] as [number, number])], planes: [], heightSource: 'scan', heights: { scanY: topY }, provenance: SCAN_MASSING_PROVENANCE, roof: { source: 'scan', note }
    });
    if (r.chosen === 'block' || r.chosen === 'block + roof objects') {
        if (r.block.length < 3) return { reason: 'the block has no outline' };
        const block = dropSpikes(r.block);
        const parts = [part('scan-block', block.ring, r.groundY, r.roofY, `the roof at the median of the scan's cell tops (${r.roofY.toFixed(2)} m)`)];
        const meshes: MassingMesh[] = [];
        const notes = [`block: walls snapped onto the scanned walls, roof at ${r.roofY.toFixed(2)} m${block.dropped ? `; ${block.dropped} spike corner${block.dropped === 1 ? '' : 's'} (under ${SPIKE_DEG} degrees) taken out` : ''}`];
        const clear = (insetRing(block.ring, ROOF_WALL_CLEARANCE_M) as Array<[number, number]> | undefined) ?? block.ring;
        if (r.chosen === 'block + roof objects') for (const [k, o] of (r.roof?.objects ?? []).entries()) {
            let kept = '';
            if (o.mesh) meshes.push({ id: `scan-roof-${k}`, vertices: o.mesh.v, indices: o.mesh.i, provenance: SCAN_MASSING_PROVENANCE });
            else if (o.outline.length >= 3 && o.topY > o.baseY) {
                const c = clampInto(o.outline, clear);
                if (ringArea(c.outline) < 0.25) { notes.push(`roof object ${k}: ${o.chosen} dropped (under 0.25 m2 left ${ROOF_WALL_CLEARANCE_M} m inside the walls)`); continue; }
                if (c.moved) kept = `; ${c.moved} of ${o.outline.length} outline points brought ${ROOF_WALL_CLEARANCE_M} m inside the walls`;
                parts.push(part(`scan-roof-${k}`, c.outline, o.baseY, o.topY, `${o.why} (outline: ${o.outlineSource}, height: ${o.heightSource})`));
            } else continue;
            notes.push(`roof object ${k}: ${o.chosen}, +${(o.topY - o.baseY).toFixed(2)} m (outline ${o.outlineSource}, height ${o.heightSource})${kept}`);
        }
        return { parts, meshes, notes };
    }
    if (r.chosen === 'tiers') {
        const tiers = r.tiers.filter(t => t.outline.length >= 3 && t.y1 > t.y0);
        if (!tiers.length) return { reason: 'no tier has an outline' };
        return { parts: tiers.map((t, k) => part(`scan-tier-${k}`, dropSpikes(t.outline).ring, t.y0, t.y1, `tier ${k}: ${t.y0.toFixed(1)}-${t.y1.toFixed(1)} m`)), meshes: [], notes: tiers.map((t, k) => `tier ${k}: ${t.y0.toFixed(1)}-${t.y1.toFixed(1)} m, ${t.area.toFixed(0)} m2`) };
    }
    return { reason: `the scan chose ${r.chosen}, which has no flat walls for a facade to be read onto` };
}

/** The candidate table as one line ('block 0.68/0.67; block + roof objects 0.93/0.91 (chosen); ...'). */
export function candidateLine(r: Pick<ScanMassingResult, 'candidates' | 'chosen'>): string {
    return r.candidates.map(c => `${c.label} ${c.coverage.toFixed(2)}/${c.precision.toFixed(2)}${c.label === r.chosen ? ' (chosen)' : ''}`).join('; ');
}

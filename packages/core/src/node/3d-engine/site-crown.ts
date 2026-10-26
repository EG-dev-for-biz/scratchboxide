/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The crown of a real building (spire, mast, lantern, drums, fins: whatever stands above its last full-plan tier), fitted
 * from the place's 3D tiles for a procedural script (sb.site_crown builds it).
 *
 *   1. The tile mesh of the structure above the crown's base is cut out and handed to the shape program (pipeline-e
 *      shape-stage, mode program): the vision model writes the crown as continuous operators (prisms, revolves with a side
 *      count and lobes, sweeps, repeats) and the native fit snaps their sizes to the crop's height grid and its oblique
 *      views. Hard edges stay hard: a prism or a 4- or 8-sided revolve, not a smoothed radius.
 *   2. Detail finer than the tiles (about 0.5-1 m up there) comes from an AI-Beautified close-up of the crown, shown with
 *      the contact sheet: the model may take counts and proportions from it, never sizes.
 *   3. The fit reports its silhouette disagreement against the tiles (1 - IoU, mean over the views): the check.
 * Sizes the fit moved are labelled measured (from the tiles); counts, side numbers and anything the fit could not move
 * are generated. The geometry is the native tool's, in the tile frame, handed over as triangles with y above the street.
 */

import * as fs from 'fs';
import * as path from 'path';
import { IMAGE_MODEL_PRIORITY } from '../../common/media-generation-protocol';
import { buildBeautifyPrompt } from '../../browser/generative-canvas/services/location-beautify-service';
import { VisionModelChain } from '../gemini/vision-model-chain';
import { prepareSurveySite } from '../gemini/tools/location-evidence/streetview-survey';
import { createStagedLocationDeps } from './staged-location/staged-location-tool';
import { stagedReplyCache, stagedWorkspaceRoot } from './staged-location/stage-cache';
import { readTileTriangles } from './staged-location/tile-texture-transfer';
import { renderTriangles } from './staged-location/photo-match-eval';
import { encodePng } from './staged-location/png-encode';
import { genAiEnhanceClient } from './staged-location/texture-enhance';
import { runShapeStage } from './staged-location/pipeline-e/shape-stage';
import { lookAt } from './site-facade';
import type { SiteMassing } from './site-massing';

/** The crown starts above the last tier holding at least this share of the footprint. */
export const CROWN_TIER_SHARE = 0.2;
/** A fit leaving more silhouette disagreement than this is reported as a poor match (still returned, labelled). */
export const CROWN_SILHOUETTE_OK = 0.15;
export const SITE_CROWN_VERSION = 'site-crown/v3';

export interface CrownPiece {
    id: string;
    /** The operator the piece was built by (prism, revolve, sweep, relief): for people, nothing branches on it. */
    operator: string;
    label: string;
    /** Flat triangle list: positions [x, y, z]* in metres, x east, z south from the place point, y above the street. */
    positions: number[];
    indices: number[];
    provenance: 'measured' | 'generated';
    confidence: number;
    /** Which parameters the fit moved (measured) and which it could not (generated). */
    measured: string[];
    generated: string[];
}

export interface SiteCrown {
    version: string;
    fromM: number;
    toM: number;
    pieces: CrownPiece[];
    /** Mean silhouette disagreement against the tiles' views after the fit (0 = identical outlines). */
    silhouette: number;
    heightError: number;
    silhouetteBefore: number;
    matched: boolean;
    model?: string;
    pictures: string[];
    notes: string[];
}

/** A position-only GLB of triangles (the shape program's scan reads geometry only). */
export function writeTrianglesGlb(file: string, positions: Float32Array, indices: Uint32Array): void {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], positions[i + k]); hi[k] = Math.max(hi[k], positions[i + k]); }
    const pb = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength), ib = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
    const bin = Buffer.concat([pb, ib]);
    const json = JSON.stringify({
        asset: { version: '2.0', generator: 'scratchbox site-crown crop' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        buffers: [{ byteLength: bin.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pb.length, target: 34962 }, { buffer: 0, byteOffset: pb.length, byteLength: ib.length, target: 34963 }],
        accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: lo, max: hi }, { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' }]
    });
    const jb = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
    const bb = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jb.length + 8 + bb.length, 8);
    const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
    fs.writeFileSync(file, Buffer.concat([header, ch(jb.length, 0x4e4f534a), jb, ch(bb.length, 0x004e4942), bb]));
}

/** A closed prism over a loop between two heights (tile frame), as triangles with flat faces. */
function prismTriangles(loop: Array<[number, number]>, y0: number, y1: number): { positions: number[]; indices: number[] } {
    const positions: number[] = [], indices: number[] = [];
    const n = loop.length;
    const tri = (a: number[], b: number[], c: number[]) => { const k = positions.length / 3; positions.push(...a, ...b, ...c); indices.push(k, k + 1, k + 2); };
    for (let i = 0; i < n; i++) {
        const [ax, az] = loop[i], [bx, bz] = loop[(i + 1) % n];
        tri([ax, y0, az], [bx, y0, bz], [bx, y1, bz]);
        tri([ax, y0, az], [bx, y1, bz], [ax, y1, az]);
    }
    // caps: a fan (crown prism plans are convex or near enough; the shape program writes simple outlines)
    for (let i = 1; i + 1 < n; i++) {
        tri([loop[0][0], y1, loop[0][1]], [loop[i][0], y1, loop[i][1]], [loop[i + 1][0], y1, loop[i + 1][1]]);
        tri([loop[0][0], y0, loop[0][1]], [loop[i + 1][0], y0, loop[i + 1][1]], [loop[i][0], y0, loop[i][1]]);
    }
    return { positions, indices };
}

/** Fits the crown of the building whose massing is `massing` from its 3D tiles. Throws when there is no crown or nothing fits. */
export async function fitSiteCrown(massing: SiteMassing, opts: { workspaceRoot: string; signal?: AbortSignal; progress?: (m: string) => void }): Promise<SiteCrown> {
    const progress = opts.progress ?? (() => undefined);
    const notes: string[] = [];
    const base = Math.max(0, ...massing.tiers.filter(t => t.areaM2 >= CROWN_TIER_SHARE * massing.footprintAreaM2).map(t => t.topM));
    const top = Math.max(massing.topM ?? 0, ...massing.tiers.map(t => t.topM));
    if (top - base < 3) throw new Error(`no crown: the building's last full tier reaches ${base.toFixed(1)} m and nothing stands more than 3 m above it`);
    const outDir = path.join(opts.workspaceRoot, 'build', 'site-crown', `${massing.place.lat.toFixed(5)}_${massing.place.lng.toFixed(5)}`);
    fs.mkdirSync(outDir, { recursive: true });
    const cacheFile = path.join(outDir, 'crown.json');
    try {
        const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as SiteCrown & { builtAtMs: number };
        if (c.version === SITE_CROWN_VERSION && Date.now() - c.builtAtMs < 7 * 24 * 3600 * 1000 && Math.abs(c.fromM - base) < 0.5) {
            return { ...c, notes: [...c.notes, `crown fit reused from ${new Date(c.builtAtMs).toISOString().slice(0, 10)} (cached 7 days)`] };
        }
    } catch { /* no cache yet */ }

    const deps = await createStagedLocationDeps(stagedWorkspaceRoot(), opts.signal ? { signal: opts.signal } : {});
    if (!deps.vision || !('client' in deps.vision)) throw new Error('no vision model is configured to write the crown\'s shape program');
    const vision = deps.vision;
    progress('crown: preparing the place (3D tiles extraction, cached for 7 days)');
    const site = await prepareSurveySite({ lat: massing.place.lat, lng: massing.place.lng, query: massing.place.resolvedAs }, deps, { ...(opts.signal ? { signal: opts.signal } : {}), onProgress: progress });
    const groundY = site.structure.groundY;

    // 1. the crop: the structure's tile triangles wholly above the crown's base
    const sv = site.structureMesh.vertices, si = site.structureMesh.indices;
    const cutY = groundY + base - 0.3;
    const keep: number[] = [];
    for (let t = 0; t + 2 < si.length; t += 3) {
        const a = si[t], b = si[t + 1], c = si[t + 2];
        if (sv[a * 3 + 1] >= cutY && sv[b * 3 + 1] >= cutY && sv[c * 3 + 1] >= cutY) keep.push(a, b, c);
    }
    if (keep.length < 300) throw new Error(`the 3D tiles hold only ${keep.length / 3} triangles of the crown above ${base.toFixed(1)} m: too few to fit`);
    const remap = new Map<number, number>();
    const pos: number[] = [];
    const idx = new Uint32Array(keep.map(v => { let k = remap.get(v); if (k === undefined) { k = remap.size; remap.set(v, k); pos.push(sv[v * 3], sv[v * 3 + 1], sv[v * 3 + 2]); } return k; }));
    const cropGlb = path.join(outDir, 'crown_crop.glb');
    writeTrianglesGlb(cropGlb, new Float32Array(pos), idx);
    let cx = 0, cz = 0;
    for (let i = 0; i < pos.length; i += 3) { cx += pos[i]; cz += pos[i + 2]; }
    cx /= pos.length / 3; cz /= pos.length / 3;
    notes.push(`crown crop: ${idx.length / 3} tile triangles above ${base.toFixed(1)} m (the top of the last tier holding ${Math.round(CROWN_TIER_SHARE * 100)}% of the footprint)`);

    // 2. a close-up of the crown, AI-Beautified, for counts of detail the tiles melt
    const pictures: string[] = [];
    const references: Array<{ mimeType: string; bytes: Uint8Array; caption: string }> = [];
    try {
        progress('crown: AI Beautify close-up for detail finer than the tiles');
        const tile = readTileTriangles(fs.readFileSync(site.extraction.texturedGlb));
        const W = 768, H = 1024, hfov = 30, span = top - base;
        const vfov = 2 * Math.atan(Math.tan((hfov * Math.PI) / 360) * H / W);
        const d = (span / 2) / Math.tan(vfov / 2) * 1.2;
        const heading = site.structure.facadeHeadingsDeg[0] ?? 180;
        const hr = (heading * Math.PI) / 180, nx = Math.sin(hr), nz = -Math.cos(hr);
        const midY = groundY + base + span / 2;
        const cam = lookAt([cx + nx * d, midY, cz + nz * d], [cx, midY, cz], W, H, hfov);
        const r = renderTriangles([tile], cam, { supersample: 1 });
        const png = encodePng(r.width, r.height, r.rgba, 4);
        fs.writeFileSync(path.join(outDir, 'crown_render.png'), png);
        pictures.push(path.join(outDir, 'crown_render.png'));
        const prompt = buildBeautifyPrompt({ locationName: massing.place.resolvedAs, coords: { lat: massing.place.lat, lng: massing.place.lng }, heading, pitch: 0, fovDegrees: hfov, pitchDegrees: 0, cameraHeightMeters: base + span / 2, aspectRatio: '3:4' });
        const answer = await genAiEnhanceClient(vision.client)({ label: 'site-crown', models: IMAGE_MODEL_PRIORITY, prompt, image: { mimeType: 'image/png', bytes: png, width: W, height: H }, references: [], ...(opts.signal ? { signal: opts.signal } : {}) });
        const file = path.join(outDir, `crown_beautified.${answer.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`);
        fs.writeFileSync(file, answer.bytes);
        pictures.push(file);
        references.push({ mimeType: answer.mimeType, bytes: answer.bytes, caption: `an image model's photographic redraw of a render of the 3D tiles of this crown (from ${base.toFixed(0)} m to ${top.toFixed(0)} m above the street, seen from compass ${Math.round((heading + 180) % 360)} deg); its sharp detail is the image model's.` });
    } catch (err) {
        notes.push(`no AI Beautify close-up (${err instanceof Error ? err.message : String(err)}): the program is written from the tiles alone`);
    }

    // 3. the shape program and its fit to the crop
    progress('crown: writing and fitting the shape program to the 3D tiles');
    const chain = new VisionModelChain<string>({ client: vision.client, candidates: vision.candidates, ...(opts.signal ? { signal: opts.signal } : {}), hedgeAfterMs: 25_000, replyCache: stagedReplyCache(deps.cache) });
    const scanTop = (x: number, z: number) => { const i = site.ground.cellIndex(x, z); return i < 0 ? NaN : site.unmaskedTop[i]; };
    const sr = await runShapeStage({
        // the crown's base stands in for the street: the scan's height grid and its views then frame the crown alone (from
        // the street up, a 120 m crown is a sliver in each view and its silhouette check sees no detail); the geometry
        // comes back in absolute tile heights all the same
        mode: 'program', isolateGlb: cropGlb, groundY: cutY, footprintLoops: [], scanTop, cells: site.structure.cells,
        place: `the crown of ${massing.place.resolvedAs} (heights in this sheet are from the crown's base, ${base.toFixed(0)} m above the street)`, vision: chain, outDir: path.join(outDir, 'shape'),
        ...(opts.signal ? { signal: opts.signal } : {}), referenceImages: references
    });
    if (!sr.program) throw new Error(`the shape program gave no fitted program (${sr.notes.join('; ')})`);
    const fit = sr.program.fit as { before: { silhouette: number }; after: { silhouette: number; height: number } };
    const silhouette = fit.after.silhouette, matched = silhouette <= CROWN_SILHOUETTE_OK;
    notes.push(...sr.notes);

    // 4. the pieces: the native tool's fitted geometry (tile frame) with y above the street
    // the fit the stage kept: its correction when the correction lowered the loss, else the first
    const fitDir = path.join(outDir, 'shape', (sr.program.correction as { kept?: boolean } | undefined)?.kept ? 'fit_correction' : 'fit');
    const geom = JSON.parse(fs.readFileSync(path.join(fitDir, 'geometry.json'), 'utf8')) as {
        parts: Array<{ elem: number; id: string; baseY: number; topY: number; loops: Array<Array<[number, number]>> }>;
        meshes: Array<{ id: string; elem: number; vertices: Array<[number, number, number]>; indices: number[] }>;
    };
    const params = sr.program.parameters;
    const elements = sr.program.fitted.elements;
    const labelOf = (elem: number) => {
        const e = elements[elem];
        const op = e ? (e.prism ? 'prism' : e.revolve ? 'revolve' : e.sweep ? 'sweep' : 'relief') : 'solid';
        const own = params.filter(p => p.element === elem);
        const moved = own.filter(p => p.provenance === 'measured' && Math.abs(p.after - p.before) > 1e-6).map(p => p.name);
        const fixed = own.filter(p => !(p.provenance === 'measured' && Math.abs(p.after - p.before) > 1e-6)).map(p => p.name);
        const counts = e?.revolve ? [`sides ${e.revolve.sides}`, `lobes ${e.revolve.lobes ?? 0}`] : [];
        if (e?.repeat && e.repeat.count > 1) counts.push(`repeat ${e.repeat.count}`);
        return { op, label: e?.label ?? '', moved, generated: [...fixed, ...counts] };
    };
    const pieces: CrownPiece[] = [];
    for (const p of geom.parts) {
        const l = labelOf(p.elem);
        const t = prismTriangles(p.loops[0], p.baseY - groundY, p.topY - groundY);
        pieces.push({ id: p.id, operator: l.op, label: l.label, positions: t.positions, indices: t.indices, provenance: l.moved.length && matched ? 'measured' : 'generated', confidence: matched ? Math.max(0.3, 1 - silhouette * 3) : 0.3, measured: l.moved, generated: l.generated });
    }
    for (const m of geom.meshes) {
        const l = labelOf(m.elem);
        const positions = m.vertices.flatMap(v => [v[0], v[1] - groundY, v[2]]);
        pieces.push({ id: m.id, operator: l.op, label: l.label, positions, indices: m.indices, provenance: l.moved.length && matched ? 'measured' : 'generated', confidence: matched ? Math.max(0.3, 1 - silhouette * 3) : 0.3, measured: l.moved, generated: l.generated });
    }
    if (!pieces.length) throw new Error('the fitted crown has no closed pieces');
    if (!matched) notes.push(`the fitted crown's outline still differs from the tiles by ${(silhouette * 100).toFixed(0)}% (limit ${CROWN_SILHOUETTE_OK * 100}%): every piece is labelled generated`);
    const crown: SiteCrown = {
        version: SITE_CROWN_VERSION, fromM: base, toM: top, pieces, silhouette, heightError: fit.after.height, silhouetteBefore: fit.before.silhouette, matched,
        ...(sr.program.model ? { model: sr.program.model } : {}), pictures: [...pictures, ...Object.values(sr.files).filter(f => /overlay/.test(f))], notes
    };
    fs.writeFileSync(cacheFile, JSON.stringify({ ...crown, builtAtMs: Date.now() }));
    return crown;
}

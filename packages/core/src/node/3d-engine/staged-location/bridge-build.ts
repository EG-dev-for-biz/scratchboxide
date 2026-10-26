/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The bridges and the water of a procedural district, as the massing stage builds them (orchestrator.ts):
 *   1. every crossing of a Google road or rail line over Google's water is measured on the tree-stripped scan
 *      (procedural-bridges.ts measureBridges: deck level, width, the elevation probed on both faces);
 *   2. its side elevation is rendered from a focused leaf-LOD extraction of the tiles around it (the caller's `focus`;
 *      the district's own tile photo otherwise) and read by the vision model (openings, springing and crown, fascia,
 *      parapet, repeats, colour): photo-inferred;
 *   3. the detail the scan cannot resolve (what stands on the parapet, how the parapet is made, the supports' noses and
 *      caps, the band round each arch) is read from search-grounded reference images (bridge-references.ts): generated,
 *      taken only where independent references agree and the scan does not contradict them;
 *   4. the bridge is a carrier program of the universal operators (procedural-bridges.ts bridgeProgram) built natively
 *      (carrier-program.ts) and written to bridges.glb, one node per bridge and group, every node labelled;
 *   5. the water is one sheet at its measured level over Google's water areas (procedural-ground.ts buildWaterSurface),
 *      in the measured colour of the tile photo over it, written to water.glb.
 * The result also says where the ground must not be drawn (under every deck) and where the streets ride a deck.
 * Nothing here names a bridge type; the reading's words are labels only.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Vec2, Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { GroundModel, ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { agreeBridgeDetail, bridgeDetailPrompt, bridgeReferenceSubject, parseBridgeDetail, type AgreedBridgeDetail, type BridgeDetailReading } from './bridge-references';
import { runCarrierProgram, type BuiltElement, type ElementProvenance } from './carrier-program';
import { encodePng } from './png-encode';
import {
    applyBridgeReading, BRIDGE_PARAMS, bridgeFacts, bridgeProgram, bridgeReadingPrompt, bridgeSpans, measureBridges, parseBridgeReading, renderBridgeElevation, ScanProbe, underDeck,
    type Bridge, type BridgeReading
} from './procedural-bridges';
import { buildWaterSurface, groundHeightAt, measureWaterLevel, waterTexture } from './procedural-ground';
import { writeStagedGlbFile, type StagedGlbNode } from './staged-glb-writer';
import { litColour, type MeasuredColour } from './surface-materials';
import type { TileTriangles } from './tile-texture-transfer';
import { renderTopDownPhoto } from './top-down-photo';

export const BRIDGE_BUILD_VERSION = 'bridge-build/1';

/** Off with SCRATCHBOX_STAGED_BRIDGES=0 (a procedural district then keeps draping its ground over the water and the decks). */
export function proceduralBridgesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_BRIDGES !== '0';
}

export interface BridgeReference { image: Buffer; mimeType: string; model: string; account?: string }

export interface BridgeBuildInput {
    scan: ScanMesh;
    ground: Pick<GroundModel, 'groundAt' | 'topAt' | 'cellMeters'>;
    waterAt: (x: number, z: number) => boolean;
    /** Road and rail centrelines (tile frame). */
    lines: Vec2[][];
    within: (x: number, z: number) => boolean;
    bounds: { x0: number; z0: number; x1: number; z1: number };
    /** The district's tile photo (the elevation's source when no focused extraction comes). */
    tile: () => TileTriangles;
    /** Where the bridges' files go (bridges/<i>/... under it). */
    dir: string;
    /** A focused leaf-LOD extraction around the bridge, in the district's frame. */
    focus?: (b: Bridge, index: number) => Promise<TileTriangles | undefined>;
    /** The vision model: the reply text to an image and a prompt (JSON asked for); undefined when it gave none. */
    read?: (image: Buffer, mimeType: string, prompt: string, stage: 'bridge-read' | 'bridge-detail') => Promise<string | undefined>;
    /** Search-grounded references of the bridge (generated, never measurements). */
    references?: (req: { subject: string; lat: number; lng: number }, index: number) => Promise<BridgeReference[]>;
    /** Tile-frame (x, z) to geodetic, for the reference request. */
    toGeodetic?: (x: number, z: number) => { lat: number; lng: number };
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

export interface BridgeRecord {
    id: string;
    lengthM: number; widthM: number; waterY: number; deckAboveWaterM: number; parapetM: number;
    openings: number; supports: number; posts: number;
    /** The elevation reading: which side it was read on and what it said; absent when the model gave none (the probed soffits stand). */
    reading?: BridgeReading & { side: 1 | -1; focused: boolean; texelM: number };
    /** What the references agreed on (and rejected, with why). */
    detail?: AgreedBridgeDetail;
    referenceImages: number;
    colourSrgb?: Vec3;
    elevationPng?: string;
    triangles: number;
    dropped: Array<{ id: string; reason: string }>;
    notes: string[];
    /** The node names this bridge wrote (bridge/<i>/<group>), with each group's provenance. */
    nodes: Array<{ name: string; group: string; provenance: ElementProvenance; elements: string[]; triangles: number }>;
}

export interface BridgeBuildResult {
    bridges: Array<{ bridge: Bridge; record: BridgeRecord }>;
    /** bridges.glb; absent when no bridge was found. */
    file?: string;
    waterY?: number;
    /** Whether (x, z) lies under a rebuilt deck (the ground is not drawn there). */
    underDeck: (x: number, z: number) => boolean;
    /** The deck's level over (x, z), where a deck stands (the streets ride it). */
    deckYAt: (x: number, z: number) => number | undefined;
    stats: { bridges: number; openings: number; triangles: number; read: number; referenced: number; focused: number; ms: number };
    notes: string[];
    /** The named nodes' vertex colours are generated (measured where the reading gave the structure's colour). */
    version: string;
}

const BACKGROUND: Vec3 = [200, 210, 220];

/** The colour the elevation shows of the bridge, lit texels only (the render's background left out). */
export function elevationColour(e: { rgba: Uint8Array; width: number; height: number }): MeasuredColour | undefined {
    const keep = (i: number) => { const o = i * 4; return !(e.rgba[o] === BACKGROUND[0] && e.rgba[o + 1] === BACKGROUND[1] && e.rgba[o + 2] === BACKGROUND[2]); };
    return litColour(e.rgba, { keep, minTexels: 200 });
}

const srgb = (lin: [number, number, number]): Vec3 => lin.map(v => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055))) as Vec3;
const linear = (c: Vec3): [number, number, number] => c.map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }) as [number, number, number];

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

/** The lowest label and confidence over a group's elements (its node's provenance). */
function groupProvenance(elements: BuiltElement[]): ElementProvenance {
    const rank: Record<ElementProvenance['label'], number> = { measured: 0, 'vector-modelled': 1, 'photo-inferred': 2, generated: 3 };
    const worst = elements.reduce((w, e) => (rank[e.provenance.label] > rank[w.provenance.label] ? e : w), elements[0]);
    const methods = [...new Set(elements.map(e => e.provenance.method))];
    const reasons = [...new Set(elements.map(e => e.provenance.reason).filter((r): r is string => !!r))];
    return { label: worst.provenance.label, confidence: Math.min(...elements.map(e => e.provenance.confidence)), method: methods.join('; '), ...(reasons.length ? { reason: reasons.join('; ') } : {}) };
}

/** One mesh per group with each element's colour on its vertices (generated: sRGB from the reading or the references). */
function groupNode(name: string, elements: BuiltElement[], fallback: Vec3): StagedGlbNode & { triangles: number } {
    const nv = elements.reduce((s, e) => s + e.positions.length, 0), ni = elements.reduce((s, e) => s + e.indices.length, 0);
    const positions = new Float32Array(nv), colors = new Float32Array(nv), indices = new Uint32Array(ni);
    let pv = 0, pi = 0;
    for (const e of elements) {
        positions.set(e.positions, pv);
        const c = linear(e.colourSrgb ?? fallback);
        for (let i = 0; i < e.positions.length; i += 3) { colors[pv + i] = c[0]; colors[pv + i + 1] = c[1]; colors[pv + i + 2] = c[2]; }
        for (let i = 0; i < e.indices.length; i++) indices[pi + i] = e.indices[i] + pv / 3;
        pv += e.positions.length; pi += e.indices.length;
    }
    const provenance = groupProvenance(elements);
    return { name, positions, indices, colors, triangles: ni / 3, extras: { sbBridge: { group: elements[0].group, provenance, elements: elements.map(e => ({ id: e.id, op: e.op, instances: e.instances, provenance: e.provenance })) } } };
}

/**
 * Measures, reads, details and builds every bridge of the district (see the file header), writing `<dir>/bridges.glb`.
 * A bridge whose reading or references fail keeps what the scan measured (noted); a bridge whose native build fails is
 * left out with the error (noted): nothing here stops the massing stage.
 */
export async function buildBridgesLayer(input: BridgeBuildInput): Promise<BridgeBuildResult> {
    const t0 = Date.now();
    const say = input.onProgress ?? (() => undefined);
    const notes: string[] = [];
    const none = (why: string): BridgeBuildResult => ({ bridges: [], underDeck: () => false, deckYAt: () => undefined, stats: { bridges: 0, openings: 0, triangles: 0, read: 0, referenced: 0, focused: 0, ms: Date.now() - t0 }, notes: [...notes, why], version: BRIDGE_BUILD_VERSION });
    const waterY = measureWaterLevel(input.waterAt, input.ground.topAt, input.within, input.bounds);
    if (waterY === undefined) return none('no water level: the scan holds too little of the water areas');
    const probe = new ScanProbe(input.scan);
    const bridges = measureBridges({ lines: input.lines, waterAt: input.waterAt, topAt: input.ground.topAt, groundAt: (x, z) => groundHeightAt(input.ground, x, z).y, within: input.within, waterY, probe });
    if (!bridges.length) return { ...none('no crossing of a road or rail line over the water stands clear of it in the scan'), waterY };
    say(`${bridges.length} bridge${bridges.length === 1 ? '' : 's'} measured over the water (level ${waterY.toFixed(1)} m)`);

    const districtTile = (() => { let t: TileTriangles | undefined; return () => (t ??= input.tile()); })();
    const nodes: Array<StagedGlbNode & { triangles: number }> = [];
    const out: BridgeBuildResult['bridges'] = [];
    let read = 0, referenced = 0, focused = 0, triangles = 0, openings = 0;
    for (const [i, measured] of bridges.entries()) {
        const bdir = path.join(input.dir, 'bridges', String(i));
        fs.mkdirSync(bdir, { recursive: true });
        const bnotes: string[] = [];
        let b = measured;
        // the elevation, from the focused extraction when it comes
        let tile: TileTriangles | undefined, isFocused = false;
        if (input.focus) {
            say(`bridge ${i + 1}: extracting the tiles around it at leaf LOD`);
            try { tile = await input.focus(b, i); isFocused = !!tile; if (tile) focused++; } catch (err) { if (isAbort(err)) throw err; bnotes.push(`no focused extraction (${(err as Error).message}); the district's tile photo read instead`); }
        }
        tile ??= districtTile();
        const sides: Array<1 | -1> = [1, -1];
        const elevations = sides.map(side => renderBridgeElevation(tile!, b, side, 0.04));
        const pngs = elevations.map((e, k) => { const png = encodePng(e.width, e.height, Buffer.from(e.rgba), 4); fs.writeFileSync(path.join(bdir, `elevation_${k === 0 ? 'left' : 'right'}.png`), png); return png; });
        const colour = elevationColour(elevations[0]) ?? elevationColour(elevations[1]);
        // the references, asked for alongside the reading
        const facts0 = bridgeFacts(b, BRIDGE_PARAMS.parapetM);
        const geo = input.toGeodetic?.(b.stations[b.stations.length >> 1].x, b.stations[b.stations.length >> 1].z);
        const refsPromise: Promise<BridgeReference[]> = input.references && geo
            ? input.references({ subject: bridgeReferenceSubject({ ...facts0, lat: geo.lat, lng: geo.lng }), lat: geo.lat, lng: geo.lng }, i).catch(err => { if (isAbort(err)) throw err; bnotes.push(`no references (${(err as Error).message})`); return []; })
            : Promise.resolve([]);
        // the reading, both sides; the one that saw more openings stands
        let reading: BridgeRecord['reading'];
        if (input.read) {
            say(`bridge ${i + 1}: reading its elevation (${elevations[0].width} x ${elevations[0].height} px, ${(1 / elevations[0].texelM).toFixed(0)} px/m)`);
            const texts = await Promise.all(elevations.map((e, k) => input.read!(pngs[k], 'image/png', bridgeReadingPrompt(e), 'bridge-read').catch(err => { if (isAbort(err)) throw err; bnotes.push(`the ${k === 0 ? 'left' : 'right'} elevation could not be read (${(err as Error).message})`); return undefined; })));
            const parsed = texts.map((t, k) => ({ k, r: t ? parseBridgeReading(t) : undefined })).filter((p): p is { k: number; r: BridgeReading } => !!p.r);
            const best = parsed.sort((p, q) => q.r.openings.length - p.r.openings.length)[0];
            if (best) {
                const e = elevations[best.k];
                b = applyBridgeReading(b, best.r, e);
                reading = { ...best.r, side: sides[best.k], focused: isFocused, texelM: e.texelM };
                read++;
                fs.writeFileSync(path.join(bdir, 'reading.json'), JSON.stringify({ side: sides[best.k], reading: best.r, elevation: { width: e.width, height: e.height, texelM: e.texelM, waterRow: e.waterRow, reversed: e.reversed } }, null, 1));
            } else bnotes.push('the vision model read no opening on either elevation: the soffits stand as the scan probes them');
        } else bnotes.push('no vision model: the soffits stand as the scan probes them');
        const parapetM = reading?.parapetTopM !== undefined && reading.fasciaTopM !== undefined ? Math.max(0.5, Math.min(2, reading.parapetTopM - reading.fasciaTopM)) : BRIDGE_PARAMS.parapetM;
        // the detail from the references
        const refs = await refsPromise;
        let detail: AgreedBridgeDetail | undefined;
        if (refs.length && input.read) {
            say(`bridge ${i + 1}: reading ${refs.length} search-grounded reference${refs.length === 1 ? '' : 's'} for the detail the scan cannot resolve`);
            const facts = bridgeFacts(b, parapetM);
            const readings: BridgeDetailReading[] = [];
            for (const [k, r] of refs.entries()) {
                fs.writeFileSync(path.join(bdir, `reference_${k}_${r.model}.${r.mimeType.includes('jpeg') ? 'jpg' : 'png'}`), r.image);
                try {
                    const t = await input.read(r.image, r.mimeType, bridgeDetailPrompt(facts), 'bridge-detail');
                    const d = t ? parseBridgeDetail(t) : undefined;
                    if (d) readings.push(d); else bnotes.push(`reference ${k} (${r.model}) could not be read`);
                } catch (err) { if (isAbort(err)) throw err; bnotes.push(`reference ${k} (${r.model}) could not be read (${(err as Error).message})`); }
            }
            detail = agreeBridgeDetail(readings);
            referenced += readings.length;
            fs.writeFileSync(path.join(bdir, 'references.json'), JSON.stringify({ references: refs.map(r => ({ model: r.model, account: r.account })), readings, agreed: detail }, null, 1));
        } else if (!refs.length) bnotes.push('no reference images: the parapet is a plain wall, the supports plain noses, nothing stands on the parapet (generated fills)');
        // the program, built natively
        const bodyColourSrgb = reading?.colourSrgb ?? (colour ? srgb(colour.linearRgb) : undefined);
        const scanRises = (x: number, z: number, yAbove: number, yDeck: number): boolean | undefined => (probe.near(x, yAbove, z, 0.7) ? true : probe.near(x, yDeck, z, 0.7) ? false : undefined);
        const prog = bridgeProgram(b, { parapetM, ...(detail ? { detail } : {}), ...(bodyColourSrgb ? { bodyColourSrgb } : {}), scanRises });
        bnotes.push(...prog.notes);
        let built: Awaited<ReturnType<typeof runCarrierProgram>>;
        try {
            built = await runCarrierProgram(prog.program, path.join(bdir, 'native'), { ...(input.signal ? { signal: input.signal } : {}) });
        } catch (err) {
            if (isAbort(err)) throw err;
            notes.push(`bridge ${i + 1} (${b.id}) left out: ${(err as Error).message}`);
            continue;
        }
        const groups = new Map<string, BuiltElement[]>();
        for (const e of built.built) { const g = groups.get(e.group); if (g) g.push(e); else groups.set(e.group, [e]); }
        const fallback: Vec3 = bodyColourSrgb ?? [150, 150, 150];
        const recordNodes: BridgeRecord['nodes'] = [];
        for (const [group, els] of groups) {
            const node = groupNode(`bridge/${i}/${group}`, els, fallback);
            nodes.push(node);
            recordNodes.push({ name: node.name!, group, provenance: (node.extras as { sbBridge: { provenance: ElementProvenance } }).sbBridge.provenance, elements: els.map(e => e.id), triangles: node.triangles });
        }
        triangles += built.triangles;
        openings += prog.openings;
        const record: BridgeRecord = {
            id: b.id, lengthM: Math.round(b.lengthM * 10) / 10, widthM: Math.round(b.widthM * 10) / 10, waterY: Math.round(waterY * 100) / 100, deckAboveWaterM: Math.round(bridgeFacts(b, parapetM).deckAboveWaterM * 100) / 100, parapetM: Math.round(parapetM * 100) / 100,
            openings: prog.openings, supports: prog.supports, posts: prog.posts, ...(reading ? { reading } : {}), ...(detail ? { detail } : {}), referenceImages: refs.length,
            ...(bodyColourSrgb ? { colourSrgb: bodyColourSrgb } : {}), elevationPng: path.relative(input.dir, path.join(bdir, 'elevation_left.png')),
            triangles: built.triangles, dropped: built.dropped, notes: bnotes, nodes: recordNodes
        };
        out.push({ bridge: b, record });
        say(`bridge ${i + 1}: ${prog.openings} openings, ${prog.supports} supports, ${prog.posts} posts; ${built.triangles.toLocaleString('en-US')} triangles${built.dropped.length ? `; ${built.dropped.length} element(s) dropped` : ''}`);
    }
    const file = path.join(input.dir, 'bridges.glb');
    const records = out.map(o => o.record);
    if (nodes.length) {
        writeStagedGlbFile(file, nodes.map(({ triangles: _t, ...n }) => n), {
            rootExtras: { sbBridges: { version: BRIDGE_BUILD_VERSION, waterY, bridges: records, method: 'each crossing measured on the scan (deck level, width, elevation probed), its openings read from the tile photo elevation (photo-inferred), its parapet, supports\' noses and caps, arch rings and posts from search-grounded references where they agree and the scan does not contradict them (generated); built natively as sweeps, solids of revolution and replicators; vertex colours generated from the measured structure colour' } },
            generator: 'scratchbox staged-location bridge-build', copyright: 'Google'
        });
    }
    fs.writeFileSync(path.join(input.dir, 'bridges.json'), JSON.stringify({ version: BRIDGE_BUILD_VERSION, waterY, bridges: records, notes }, null, 1));
    const under = out.map(o => underDeck(o.bridge, 0.5));
    const deckYAt = (x: number, z: number): number | undefined => {
        for (const [k, o] of out.entries()) {
            if (!under[k](x, z)) continue;
            let best = o.bridge.stations[0], bd = Infinity;
            for (const s of o.bridge.stations) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s; } }
            return best.deckY;
        }
        return undefined;
    };
    return {
        bridges: out, ...(nodes.length ? { file } : {}), waterY,
        underDeck: (x, z) => under.some(u => u(x, z)), deckYAt,
        stats: { bridges: out.length, openings, triangles, read, referenced, focused, ms: Date.now() - t0 }, notes, version: BRIDGE_BUILD_VERSION
    };
}

/** How many openings a built bridge shows (the stations' soffit runs over the water). */
export function bridgeOpenings(b: Bridge): number { return bridgeSpans(b).openings.length; }

// ------------------------------------------------------------------------------------------------ the water

export const WATER_VERSION = 'water-layer/1';

/** The median colour of the tile photo over the water (sRGB), or undefined when too little of it is in the photo. */
export function measureWaterColour(tile: Uint8Array | TileTriangles, waterAt: (x: number, z: number) => boolean, within: (x: number, z: number) => boolean, bounds: { x0: number; z0: number; x1: number; z1: number }, texelM = 1): { colourSrgb: Vec3; texels: number } | undefined {
    const frame = { x0: bounds.x0, z0: bounds.z0, widthM: bounds.x1 - bounds.x0, heightM: bounds.z1 - bounds.z0 };
    const photo = renderTopDownPhoto(tile, frame, { texelM, maxPx: 2048 });
    const ch: [number[], number[], number[]] = [[], [], []];
    const sx = frame.widthM / photo.width, sz = frame.heightM / photo.height;
    for (let py = 0; py < photo.height; py++) for (let px = 0; px < photo.width; px++) {
        const x = frame.x0 + (px + 0.5) * sx, z = frame.z0 + (py + 0.5) * sz;
        if (!within(x, z) || !waterAt(x, z)) continue;
        const o = (py * photo.width + px) * 4;
        if (photo.rgba[o + 3] === 0) continue;
        ch[0].push(photo.rgba[o]); ch[1].push(photo.rgba[o + 1]); ch[2].push(photo.rgba[o + 2]);
    }
    if (ch[0].length < 50) return undefined;
    const med = (a: number[]) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    return { colourSrgb: [med(ch[0]), med(ch[1]), med(ch[2])], texels: ch[0].length };
}

/**
 * The water sheet at its measured level in the tile photo's measured colour, with a generated ripple texture, written to
 * `file`. Labelled: the level and the colour measured, the sheet and its ripples generated (the scan shows no water
 * surface a photogrammetry can hold).
 */
export function writeWaterGlb(file: string, input: { waterAt: (x: number, z: number) => boolean; within: (x: number, z: number) => boolean; bounds: { x0: number; z0: number; x1: number; z1: number }; levelY: number; colourSrgb?: Vec3; colourTexels?: number }): { path: string; bytes: number; cells: number; triangles: number } {
    const sheet = buildWaterSurface({ waterAt: input.waterAt, within: input.within, bounds: input.bounds, levelY: input.levelY });
    const colour: Vec3 = input.colourSrgb ?? [58, 68, 74];
    const tex = waterTexture(colour, 256);
    const png = encodePng(256, 256, Buffer.from(tex), 4);
    const extras = {
        sbWater: {
            version: WATER_VERSION, levelY: input.levelY, cells: sheet.cells, colourSrgb: colour, colourMeasured: !!input.colourSrgb, colourTexels: input.colourTexels ?? 0,
            provenance: { label: 'generated', confidence: 0.6, method: 'one flat sheet at the water level measured on the scan (a low percentile of its surface over Google\'s water areas), in the median colour of the tile photo over the water, with generated ripples', reason: 'photogrammetry holds no water surface: the sheet is drawn, its level and colour measured' }
        }
    };
    const out = writeStagedGlbFile(file, [{ name: 'water', positions: sheet.positions, indices: sheet.indices, uv: sheet.uv, extras }], {
        rootExtras: extras, generator: 'scratchbox staged-location water', copyright: 'Google',
        texture: { bytes: png, mimeType: 'image/png' }, textureMaterial: { roughness: 0.12, metallic: 0, repeat: true }
    });
    return { ...out, cells: sheet.cells, triangles: sheet.indices.length / 3 };
}

/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A chunked district shows each building's best version (step 3 of the district run-over-run plan,
 * docs/research/2026-11-03-district-run-over-run-plan.md). After the join and the audit (place-store-district.ts), a
 * building whose new version the object store would reject as worse (worseMeasures against its current version; the
 * place's current versions were pulled in before the build, place-store.ts pullPlace) is shown from its current stored
 * version instead, when that version can stand where the new one stands:
 *
 *   - the same frame: the same object key (the district's ENU origin to the centimetre), and its stored box holding the
 *     footprint's centre (grown by PLACE_BEST_PARAMS.frameSlackM in plan: a cut takes whole scan triangles and a margin,
 *     so its box may stand well past the footprint's own);
 *   - the same footprint (the vector footprint's sha256, kept in the object's inputs);
 *   - its main part in the same layer, and every other part this run cut of the building stored by the run its main
 *     part's current version came from (that run's version of the part, whatever its current one: a part carries no
 *     measures, so its current version is always the newest);
 *   - the same look code (kdLookCode: the twin's de-light, roof-shadow, harmonise and material versions, and the switches
 *     that change them).
 *
 * Otherwise the new version is shown and the reason recorded. Each layer holding a substituted building is put together
 * again without its triangles and with its stored parts (glb-subset.ts), the clay variant cut by the footprint the same
 * way and its stored parts drawn in the layer's clay material, and committed superseding the layer as built. Every node of
 * a stored part is labelled in its extras (`sb.storedVersion`: object key, version, run, reason; its provenance label the
 * stored one with "· from an earlier run", so the provenance view gives it a row of its own, its method and note saying
 * the version, run and reason). Nothing stored becomes measured: the labels and the layer's measured-geometry flag stay as
 * they were. The run's own versions are still kept: the superseding layer carries the layer's manifest, so the worse
 * version is stored as rejected history. SCRATCHBOX_OBJECT_REUSE=0 shows every building as built.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProvenanceRecord, StagedLayer, StagedNodeExtras } from '../../../common/spatial/staged-location-contracts';
import type { DurableAssetStore } from '../../asset-store/durable-asset-store';
import { locationHashOf, objectKeyOf, SceneObjectStore, worseMeasures, type ObjectFrame, type ObjectRecord } from '../../asset-store/scene-object-store';
import { cutLayerByFootprints } from './district-completeness-audit';
import { parseGlbBytes, type ParsedGlb } from './glb-bytes';
import { checkGlbBytes } from './glb-integrity';
import { composeGlb, sceneRoots, type ComposeSelection, type ComposeSource } from './glb-subset';
import type { DistrictFootprint } from './pipeline-k/district-buildings';
import { MATERIAL_CHOICE_VERSION } from './pipeline-k/material-choice';
import { MATERIAL_REGIONS_VERSION } from './pipeline-k/material-regions';
import { ROOF_SHADOW_VERSION } from './pipeline-k/roof-shadow';
import { SKY_DELIGHT_VERSION } from './pipeline-k/sky-delight';
import { TEXTURE_HARMONIZE_VERSION } from './pipeline-k/texture-harmonize';
import { objectReuseEnabled, objectStoreEnabled, type LayerObject, type LayerObjectManifest } from './scene-objects';
import { TILE_REFINE_TWIN_VERSION } from './tile-refine-twin';

export const PLACE_BEST_VERSION = 'place-best/1';

export const PLACE_BEST_PARAMS = {
    /** How far past a stored version's box (in plan) its footprint's centre may lie and the two still be one frame (m). */
    frameSlackM: 3
};

/** The environment switches that change a K twin's look (the textures stage); a geometry switch is not one. */
const LOOK_SWITCHES = [
    'SCRATCHBOX_K_SKY_DELIGHT', 'SCRATCHBOX_K_ROOF_SHADOW', 'SCRATCHBOX_K_MATERIAL_REGIONS', 'SCRATCHBOX_K_MATERIAL_PICK', 'SCRATCHBOX_K_FACADE_READ',
    'SCRATCHBOX_K_VIEW_RELIGHT', 'SCRATCHBOX_K_DETAIL_BAKE', 'SCRATCHBOX_K_PARTY_WALL_TEXTURE', 'SCRATCHBOX_KD_UPWARD_LIFT'
];

/**
 * The code that sets a K twin's look: the twin's versions (de-light, sky de-light, roof shadow, harmonise, material
 * regions and choice) and the switches set that change them, from the environment and the request's own steps (`twin.*`).
 */
export function kdLookCode(env: NodeJS.ProcessEnv = process.env, steps?: Record<string, unknown>): Record<string, string> {
    const code: Record<string, string> = {
        twin: TILE_REFINE_TWIN_VERSION, skyDelight: SKY_DELIGHT_VERSION, roofShadow: ROOF_SHADOW_VERSION, harmonize: TEXTURE_HARMONIZE_VERSION,
        materialRegions: MATERIAL_REGIONS_VERSION, materialChoice: MATERIAL_CHOICE_VERSION
    };
    for (const name of LOOK_SWITCHES) { const v = env[name]?.trim(); if (v) code[name] = v; }
    for (const [k, v] of Object.entries(steps ?? {})) if (k.startsWith('twin.') || k === 'remesh.facadeRead') code[`steps.${k}`] = String(v);
    return code;
}

const sameCode = (a: unknown, b: Record<string, string>): string[] => {
    const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    return [...new Set([...Object.keys(x), ...Object.keys(b)])].filter(k => String(x[k] ?? '') !== String(b[k] ?? '')).sort();
};

export interface BestVersionsInput {
    runId: string;
    /** The district's object frame (scene-objects.ts objectFrameOf), as the run's objects are kept in. */
    frame: ObjectFrame;
    layers: StagedLayer[];
    /** The run's layer-objects manifests (place-store-district.ts at the join): each building's parts, cuts and measures. */
    manifests: Map<string, LayerObjectManifest>;
    footprints: DistrictFootprint[];
    /** The object store's asset store, the place's versions pulled in. */
    store?: DurableAssetStore;
    /** This run's look code (kdLookCode). */
    look: Record<string, string>;
    modelsDir: string;
    /** Where the layers put together again are written before they are published. */
    outDir: string;
    publish: (file: string, name: string) => { url: string; bytes: number };
    now?: () => number;
    env?: NodeJS.ProcessEnv;
}

export interface BestVersionsReport {
    version: typeof PLACE_BEST_VERSION;
    /** Set when no building was looked at, with why. */
    skipped?: string;
    /** Each building shown from a stored version: which, from which run, why, and the layers it stands in. */
    substituted: Array<{ id: string; objectKey: string; version: number; runId?: string; reason: string; layers: string[] }>;
    /** Each building whose new version is worse but is shown as built, with why. */
    keptNew: Array<{ id: string; why: string }>;
    /** Each layer put together again, and the layer that supersedes it. */
    layers: Array<{ objectId: string; by: string; buildings: number; triangles: number }>;
    errors: string[];
    ms: number;
}

interface Part { layerId: string; object: LayerObject; manifest: LayerObjectManifest }

/**
 * The building a part belongs to: its inputs name it (place-store-district.ts); else its identity is the building's
 * own (a main part). A Google vector feature id holds '/' itself, so the id is never cut out of a part's identity.
 */
const buildingOf = (o: LayerObject): string => (o.inputs as { building?: string } | undefined)?.building ?? o.identity;
interface Swap { objectKey: string; version: number; runId?: string; reason: string; glbFile: string; record: ObjectRecord; object: LayerObject }

/** The triangles of a node's mesh, as glb-subset.ts numbers them (its TRIANGLES primitives in order). */
function trianglesOf(json: any, node: number): number {
    const n = json.nodes[node];
    if (n?.mesh === undefined) return 0;
    let count = 0;
    for (const p of json.meshes[n.mesh].primitives) {
        if ((p.mode ?? 4) !== 4) continue;
        const a = json.accessors[p.indices ?? p.attributes.POSITION];
        count += Math.floor(a.count / 3);
    }
    return count;
}

/** Every mesh node of `glb`, less the triangles `remove` names per node (an instanced node is copied whole). */
function without(glb: ParsedGlb, remove: Map<number, Set<number>>): ComposeSelection[] {
    const nodes = glb.json.nodes ?? [];
    const whole = new Set<number>();
    const under = (i: number, seen = new Set<number>()): void => { for (const c of nodes[i].children ?? []) if (!seen.has(c)) { seen.add(c); whole.add(c); under(c, seen); } };
    const out: ComposeSelection[] = [];
    nodes.forEach((n: any, i: number) => {
        if (whole.has(i) || n.mesh === undefined) return;
        if (n.extensions?.EXT_mesh_gpu_instancing) { out.push({ node: i }); under(i); return; }
        const count = trianglesOf(glb.json, i), r = remove.get(i);
        const keep: number[] = [];
        for (let t = 0; t < count; t++) if (!r?.has(t)) keep.push(t);
        if (keep.length) out.push({ node: i, triangles: keep });
    });
    return out;
}

/** The stored part's nodes labelled (see the module doc); with `clay`, every primitive drawn in that material, its textures dropped. */
function labelled(bytes: Buffer, swap: Swap, base: ProvenanceRecord, stage: string, clay?: unknown): ParsedGlb {
    const glb = parseGlbBytes(bytes);
    const json = JSON.parse(JSON.stringify(glb.json));
    if (clay !== undefined) {
        json.materials = [clay];
        json.textures = []; json.images = []; json.samplers = [];
        for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) p.material = 0;
    }
    const label = `${swap.record.provenance.labels[0] ?? String(base.label)} · from an earlier run`;
    const provenance: ProvenanceRecord = {
        ...base, label,
        method: `${base.method}; this building is version ${swap.version} of ${swap.objectKey}${swap.runId ? `, from run ${swap.runId}` : ''}, shown in place of this run's`,
        sources: [...(base.sources ?? []), { kind: 'stored-object', id: `${swap.objectKey}#v${swap.version}`, ...(swap.runId ? { note: `run ${swap.runId}` } : {}) }],
        note: swap.reason
    };
    (json.nodes ?? []).forEach((n: any, i: number) => {
        if (n.mesh === undefined) return;
        const vertices = (json.meshes[n.mesh].primitives as any[]).reduce((a, p) => a + (json.accessors[p.attributes.POSITION]?.count ?? 0), 0);
        const sb: StagedNodeExtras['sb'] = {
            schema: 'scratchbox.staged-node/2', stage, provenance, buildOrder: 0, buildCount: 1, revealKind: 'appear',
            reveal: { attribute: null, displacement: null, durationShare: 1 }, ids: {}, counts: { vertices, triangles: trianglesOf(json, i) },
            storedVersion: { objectKey: swap.objectKey, version: swap.version, ...(swap.runId ? { runId: swap.runId } : {}), reason: swap.reason }
        };
        n.extras = { ...(n.extras ?? {}), sb };
    });
    return { json, bin: glb.bin };
}

/** The layer put together again: `glb` without `remove`, and the stored parts. */
function rebuilt(glb: ParsedGlb, remove: Map<number, Set<number>>, parts: ParsedGlb[], rootName: string): Buffer {
    const sources: ComposeSource[] = [
        { glb, select: without(glb, remove), keepPlacement: true },
        ...parts.map(p => ({ glb: p, select: sceneRoots(p.json).map(node => ({ node })), keepPlacement: true }))
    ];
    const rootExtras = glb.json.nodes?.[sceneRoots(glb.json)[0]]?.extras;
    const out = composeGlb(sources, { name: rootName, ...(rootExtras ? { rootExtras } : {}), generator: `scratchbox ${PLACE_BEST_VERSION} (stored buildings shown in place of worse ones)` });
    const check = checkGlbBytes(out);
    if (!check.ok) throw new Error(`the layer put together again is not a valid GLB (${check.errors.slice(0, 3).join('; ')})`);
    return out;
}

const add = (m: Map<number, Set<number>>, node: number, tris: ArrayLike<number>) => { let s = m.get(node); if (!s) m.set(node, s = new Set()); for (let k = 0; k < tris.length; k++) s.add(tris[k]); };

/**
 * The district's buildings each shown at their best (see the module doc): the layers to commit in place of those holding
 * a substituted building, and the report. Never throws for one building or layer: what went wrong is in the report.
 */
export function showBestVersions(input: BestVersionsInput, P = PLACE_BEST_PARAMS): { report: BestVersionsReport; layers: Array<{ original: StagedLayer; layer: StagedLayer; manifest: LayerObjectManifest }> } {
    const now = input.now ?? Date.now, t0 = now(), env = input.env ?? process.env;
    const report: BestVersionsReport = { version: PLACE_BEST_VERSION, substituted: [], keptNew: [], layers: [], errors: [], ms: 0 };
    const out: Array<{ original: StagedLayer; layer: StagedLayer; manifest: LayerObjectManifest }> = [];
    const done = (skipped?: string) => ({ report: { ...report, ...(skipped ? { skipped } : {}), ms: now() - t0 }, layers: out });
    if (!objectStoreEnabled(env)) return done('the scene object store is off (SCRATCHBOX_OBJECT_STORE=0)');
    if (!objectReuseEnabled(env)) return done('SCRATCHBOX_OBJECT_REUSE=0: every building is shown as built');
    if (!input.store) return done('this machine has no object store');
    const objects = new SceneObjectStore(input.store), locationHash = locationHashOf(input.frame);
    // each building's parts as this run cut them: its main part carries the measures
    const parts = new Map<string, Part[]>();
    for (const [layerId, manifest] of input.manifests) for (const object of manifest.objects) {
        if (object.kind !== 'building') continue;
        const id = buildingOf(object);
        const list = parts.get(id) ?? [];
        list.push({ layerId, object, manifest });
        parts.set(id, list);
    }
    const footprintOf = new Map(input.footprints.map(f => [f.id, f]));
    const swaps = new Map<string, Swap[]>(); // by layer
    for (const [id, list] of parts) {
        const main = list.find(p => p.object.measures);
        if (!main) continue;
        try {
            const objectKey = objectKeyOf('building', id, locationHash), cur = objects.current(objectKey);
            if (!cur || cur.inputHash === main.object.inputHash) continue;
            const rec = objects.recordOf(cur);
            if (!rec) continue;
            const worse = worseMeasures(rec.measures ?? {}, main.object.measures!);
            if (!worse.length) continue;
            const reason = `this run's version is worse than version ${cur.version}${rec.runId ? ` (run ${rec.runId})` : ''}: ${worse.join('; ')}`;
            const keep = (why: string) => report.keptNew.push({ id, why: `${reason}; shown as built: ${why}` });
            const look = sameCode((rec.inputs as { look?: unknown } | undefined)?.look, input.look);
            if (look.length) { keep(`version ${cur.version} was made with other look code (${look.join(', ')})`); continue; }
            const fpStored = (rec.inputs as { footprintSha256?: string } | undefined)?.footprintSha256, fpNew = (main.object.inputs as { footprintSha256?: string } | undefined)?.footprintSha256;
            if (!fpStored || fpStored !== fpNew) { keep(fpStored ? 'its footprint changed since' : 'its stored version records no footprint'); continue; }
            const layerStored = (rec.inputs as { layer?: string } | undefined)?.layer, layerNew = (main.object.inputs as { layer?: string } | undefined)?.layer;
            if (layerStored !== layerNew) { keep(`its stored version stands in layer ${layerStored ?? '?'}, this run's in ${layerNew ?? '?'}`); continue; }
            const fp = footprintOf.get(id);
            if (!fp) { keep('its footprint is not among the district\'s'); continue; }
            const pts = fp.loops.flat(), cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
            const b = rec.location.bboxEnu, g = P.frameSlackM;
            const off = Math.max(b.min[0] - g - cx, cx - b.max[0] - g, b.min[2] - g - cz, cz - b.max[2] - g, 0);
            if (off > 0) { keep(`its footprint's centre lies ${off.toFixed(1)} m past its stored box (the frames do not match)`); continue; }
            // every part: the version the main part's run stored of it (the main part's own is its current one)
            const plan: Array<{ part: Part; swap: Swap }> = [];
            let missing: string | undefined;
            for (const part of list) {
                const key = objectKeyOf('building', part.object.identity, locationHash);
                const pc = key === objectKey ? cur : objects.versions(key).filter(v => v.runId === rec.runId).pop();
                const pr = pc ? objects.recordOf(pc) : undefined, file = pc ? objects.read(key, pc.version)?.glbFile : undefined;
                if (!pc || !pr || !file || pr.runId !== rec.runId) { missing = part.object.identity; break; }
                plan.push({ part, swap: { objectKey: key, version: pc.version, ...(pr.runId ? { runId: pr.runId } : {}), reason, glbFile: file, record: pr, object: part.object } });
            }
            if (missing) { keep(`its part ${missing} has no stored version from run ${rec.runId ?? '?'}`); continue; }
            for (const { part, swap } of plan) swaps.set(part.layerId, [...(swaps.get(part.layerId) ?? []), swap]);
            report.substituted.push({ id, objectKey, version: cur.version, ...(rec.runId ? { runId: rec.runId } : {}), reason, layers: [...new Set(plan.map(p => p.part.layerId))] });
        } catch (err) {
            report.errors.push(`${id}: ${(err as Error).message}`);
        }
    }
    // each layer put together again, its clay variant too
    fs.mkdirSync(input.outDir, { recursive: true });
    for (const [layerId, list] of swaps) {
        const layer = input.layers.find(l => l.objectId === layerId), manifest = input.manifests.get(layerId);
        if (!layer || !manifest) continue;
        try {
            const tag = `${input.runId}_${layerId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
            const write = (name: string, bytes: Buffer) => { const file = path.join(input.outDir, name); fs.writeFileSync(file, bytes); return input.publish(file, name); };
            const source = manifest.sourceFile;
            if (!source) throw new Error('its manifest names no file');
            const drawn = parseGlbBytes(fs.readFileSync(source));
            const remove = new Map<number, Set<number>>();
            for (const s of list) for (const c of s.object.cuts ?? []) add(remove, c.node, c.triangles);
            const storedParts = list.map(s => labelled(fs.readFileSync(s.glbFile), s, layer.provenance, layer.stage));
            const drawnBytes = rebuilt(drawn, remove, storedParts, 'staged');
            const ids = new Set(list.map(s => buildingOf(s.object)));
            const clayFile = path.join(input.modelsDir, path.basename(layer.url));
            const drawnIsClay = path.resolve(clayFile) === path.resolve(source);
            let clayPub: { url: string; bytes: number }, texPub: { url: string; bytes: number } | undefined;
            if (layer.textured && !drawnIsClay && fs.existsSync(clayFile)) {
                const clayBytesIn = fs.readFileSync(clayFile), clayGlb = parseGlbBytes(clayBytesIn);
                const cut = cutLayerByFootprints(clayBytesIn, input.footprints.filter(f => ids.has(f.id)));
                const clayRemove = new Map<number, Set<number>>();
                for (const id of ids) for (const [node, tris] of cut.get(id) ?? []) add(clayRemove, node, [...tris]);
                const clayMat = clayGlb.json.materials?.[0] ? { ...clayGlb.json.materials[0], extras: undefined } : { name: 'clay', pbrMetallicRoughness: { baseColorFactor: [0.72, 0.72, 0.72, 1], metallicFactor: 0, roughnessFactor: 0.9 } };
                const clayParts = list.map(s => labelled(fs.readFileSync(s.glbFile), s, layer.provenance, layer.stage, clayMat));
                clayPub = write(`${path.basename(layer.url, '.glb')}_best_${tag}.glb`, rebuilt(clayGlb, clayRemove, clayParts, 'staged'));
                texPub = write(`${path.basename(layer.textured.url, '.glb')}_best_${tag}.glb`, drawnBytes);
            } else {
                clayPub = write(`${path.basename(layer.url, '.glb')}_best_${tag}.glb`, drawnBytes);
            }
            const triangles = trianglesIn(parseGlbBytes(drawnBytes));
            const names = list.filter(s => s.object.measures).map(s => `${s.object.identity} (version ${s.version}${s.runId ? `, run ${s.runId}` : ''})`);
            const note = `${names.length} building${names.length === 1 ? '' : 's'} shown from an earlier run, this run's version being worse (${PLACE_BEST_VERSION}): ${names.join(', ')}`;
            const next: StagedLayer = {
                ...layer, objectId: `${layer.objectId}-best`, url: clayPub.url, bytes: clayPub.bytes, counts: { ...layer.counts, triangles },
                supersedes: [layer.objectId], revealAfter: [], reveal: { ...layer.reveal, durationMs: 600, stagger: 0, crossfadeFrom: [layer.objectId] },
                ...(layer.textured && texPub ? { textured: { ...layer.textured, url: texPub.url, bytes: texPub.bytes } } : {}),
                provenance: { ...layer.provenance, note: `${layer.provenance.note ? `${layer.provenance.note}; ` : ''}${note}` }, cached: false, builtAtMs: now()
            };
            out.push({ original: layer, layer: next, manifest });
            report.layers.push({ objectId: layer.objectId, by: next.objectId, buildings: names.length, triangles });
        } catch (err) {
            report.errors.push(`layer ${layerId}: ${(err as Error).message}`);
            // a layer that could not be put together again shows as built: its buildings are not substituted
            for (const s of list) {
                const id = buildingOf(s.object);
                const i = report.substituted.findIndex(x => x.id === id);
                if (i >= 0) { report.keptNew.push({ id, why: `${report.substituted[i].reason}; shown as built: layer ${layerId} could not be put together again (${(err as Error).message})` }); report.substituted.splice(i, 1); }
            }
        }
    }
    return done();
}

function trianglesIn(glb: ParsedGlb): number {
    return (glb.json.nodes ?? []).reduce((a: number, _n: unknown, i: number) => a + trianglesOf(glb.json, i), 0);
}

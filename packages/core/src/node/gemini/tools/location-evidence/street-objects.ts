/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_street_objects: the street objects of a staged district (bollards, posts, lamps, planters, benches, signs,
 * kiosks, shelters: whatever the district residual audit found standing on the street) rebuilt as clean procedural
 * objects, Street View saying what each one looks like and the scan where it stands and how tall it is
 * (staged-location/street-objects/run.ts). Report-only: the rebuilds and the report are written, the build is not
 * changed (the splice into a build is a later step, behind its own switch).
 *
 * Street View through the permitted route only: discovery on the free metadata endpoint (the Maps key), images from the
 * Maps Imagery Grounding API (the service account), held in memory and never written. Both credentials are needed; the
 * tool says which is missing.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome } from '../types';
import { createStagedLocationDeps } from '../../../3d-engine/staged-location/staged-location-tool';
import { stagedReplyCache, stagedWorkspaceRoot } from '../../../3d-engine/staged-location/stage-cache';
import { missingCredentials } from '../../../3d-engine/staged-location/streetview-evidence';
import { VISION_HEDGE_AFTER_MS } from '../../../3d-engine/staged-location/orchestrator';
import { rebuildStreetObjects } from '../../../3d-engine/staged-location/street-objects/run';
import type { ResidualAuditResult } from '../../../3d-engine/staged-location/residual-audit';
import { VisionModelChain } from '../../vision-model-chain';
import { BLOB_READ_PARAMS, readBlobs, type BlobReadReport } from '../../../3d-engine/staged-location/street-objects/blob-reader';
import { evidenceLookup } from '../../../3d-engine/staged-location/vector-footprints';
import { fileReadingStore, modelReadingsDir } from '../../../3d-engine/staged-location/pipeline-k/model-readings';
import { readTileTriangles } from '../../../3d-engine/staged-location/tile-texture-transfer';

export const STREET_OBJECTS_TOOL_NAME = 'location_street_objects';
export const STREET_OBJECTS_DIR = path.join('build', 'street-objects');

export class StreetObjectsToolError extends Error {
    constructor(readonly code: 'no_input' | 'not_found' | 'credentials' | 'no_vision' | (string & {}), message: string) { super(message); this.name = 'StreetObjectsToolError'; }
}

const abs = (p: string, root: string) => (path.isAbsolute(p) ? p : path.resolve(root, p));

/** The audit in a file: a district_audit.json (its `audit`) or a residual audit result itself. */
export function readAudit(file: string): ResidualAuditResult {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { audit?: ResidualAuditResult } & Partial<ResidualAuditResult>;
    const a = (j.audit ?? j) as ResidualAuditResult;
    if (!Array.isArray(a.clusters) || !Array.isArray(a.sources)) throw new StreetObjectsToolError('no_input', `${file} is not a residual audit (no clusters and sources)`);
    return a;
}

export const STREET_OBJECTS_TOOL_DECLARATION: ToolDeclaration = {
    name: STREET_OBJECTS_TOOL_NAME,
    description: 'Rebuilds the street objects of a staged district (the bollards, posts, lamps, planters, benches, signs, kiosks and shelters the scan melts) as clean procedural objects. ' +
        'First, every blob of the audit is read from cheap evidence, with no Street View: the scan\'s measures, where it stands against Google\'s vector data (building line, road centreline, carriageway; a blob inside or touching a building footprint is left out as a building\'s part) and its top-down tile photo, on contact sheets read by the vision model in batches, each blob given an open label and a confidence (photo-inferred; the answers kept in the model readings store, so a rerun reads the same). Street View is asked only for the blobs that read leaves unsure. ' +
        'The district residual audit says where each object stands and how tall it is (measured); alike objects repeating along a line at a steady pitch are one family, built once and placed at every member. ' +
        'Registered Google Street View views that see each family clear (the Maps Imagery Grounding API; images held in memory, never written) are read once by the vision model: what it is, its colours and finishes, ' +
        'its masks; its profile along the height is measured from those silhouettes and scaled to the scan\'s height (photo-inferred), then built natively from solids of revolution or vertical sweeps and panels. ' +
        'Each rebuild and the scan\'s blob are drawn at the photos\' poses and scored against the photos (silhouette IoU and colour); the rebuild is kept only where it beats the blob on both, otherwise the scan stays, with both scores. ' +
        'Report-only: writes the rebuilt GLBs, one GLB with the kept ones placed at their members, and a report (per object: what Street View saw, the IoU and colour numbers, the provenance of every number); the build itself is not changed. ' +
        'Give auditJson (the scene_inventory run note\'s audit: district_audit.json), scanGlb (the tree-stripped scan it read), tileGlb (the full textured tile) and lat, lng (the build\'s anchor).',
    parameters: {
        type: 'OBJECT',
        properties: {
            auditJson: { type: 'STRING', description: 'Path to the district audit (district_audit.json, the scene_inventory run note\'s `audit`) or a residual audit result.' },
            scanGlb: { type: 'STRING', description: 'The tree-stripped scan the audit read (tile_vegetation devegetated.glb): its triangles are the clusters\'.' },
            tileGlb: { type: 'STRING', description: 'The full textured tile extraction (trees in: they block a photo too), for the views\' registration and occlusion.' },
            lat: { type: 'NUMBER', description: 'Latitude of the build\'s anchor (its geoAnchor): the tile frame\'s origin.' },
            lng: { type: 'NUMBER', description: 'Longitude of the build\'s anchor.' },
            maxFamilies: { type: 'NUMBER', description: 'At most this many families, the largest first (default: all).' },
            only: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Only these families (report ids such as "row/12" or "one/40") or cluster ids.' },
            maxImages: { type: 'NUMBER', description: 'The image budget for the district (default 400).' },
            freshRead: { type: 'BOOLEAN', description: 'Ask the model again for the cheap read, past the readings store and the reply cache, and keep nothing (to measure how far two reads agree). Default false.' },
            streetView: { type: 'BOOLEAN', description: 'Ask Street View for the blobs the cheap read (scan measures, map, tile photo) leaves unsure (default true). False: the cheap read only.' },
            overlays: { type: 'BOOLEAN', description: 'Write per checked view a PNG of the tile\'s own render at the view\'s registered pose with three outlines: what Street View showed of the object (green), the scan\'s blob (red), the rebuild (cyan). No photo pixel is written. Default true.' }
        },
        required: ['auditJson', 'scanGlb', 'tileGlb', 'lat', 'lng']
    }
};

export const streetObjectsHandler: ToolHandler = async (args, ctx): Promise<ToolHandlerOutcome> => {
    try {
        const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');
        const auditJson = s('auditJson'), scanGlb = s('scanGlb'), tileGlb = s('tileGlb');
        const lat = Number(args.lat), lng = Number(args.lng);
        if (!auditJson || !scanGlb || !tileGlb) throw new StreetObjectsToolError('no_input', 'give auditJson, scanGlb and tileGlb');
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new StreetObjectsToolError('no_input', 'give lat and lng (the build\'s anchor)');
        const files = { audit: abs(auditJson, ctx.workspaceRoot), scan: abs(scanGlb, ctx.workspaceRoot), tile: abs(tileGlb, ctx.workspaceRoot) };
        for (const [k, f] of Object.entries(files)) if (!fs.existsSync(f)) throw new StreetObjectsToolError('not_found', `no ${k} file at ${f}`);
        const audit = readAudit(files.audit);
        const deps = await createStagedLocationDeps(stagedWorkspaceRoot(), { signal: ctx.signal });
        const sv = deps.streetView ?? {};
        const missing = missingCredentials(sv);
        if (missing) throw new StreetObjectsToolError('credentials', missing);
        const vision = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
        if (!vision) throw new StreetObjectsToolError('no_vision', 'no vision model is configured: the objects cannot be read from Street View');
        const chain = new VisionModelChain<string>({ client: vision.client, candidates: vision.candidates, signal: ctx.signal, hedgeAfterMs: VISION_HEDGE_AFTER_MS, replyCache: stagedReplyCache(deps.cache) });
        const asked = Array.isArray(args.only) ? (args.only as unknown[]).map(String).map(x => (/^\d+$/.test(x) ? Number(x) : x)) : undefined;
        const key = crypto.createHash('sha256').update(JSON.stringify([files, lat, lng, asked ?? null, args.maxFamilies ?? null, args.maxImages ?? null, args.streetView ?? true, args.freshRead === true])).digest('hex').slice(0, 12);
        const outDir = path.join(ctx.workspaceRoot, STREET_OBJECTS_DIR, key);
        fs.mkdirSync(outDir, { recursive: true });
        // 1. every blob read from the cheap evidence first (blob-reader.ts): the scan's measures, the map, the tile's own photo
        if (!deps.vectorEvidence) throw new StreetObjectsToolError('no_vector', 'Google\'s vector data is not available: the blobs cannot be placed against the map');
        const radiusM = Math.max(30, ...audit.clusters.map(c => Math.hypot((c.lo[0] + c.hi[0]) / 2, (c.lo[2] + c.hi[2]) / 2))) + 30;
        const vector = await deps.vectorEvidence({ lat, lng, radiusM });
        const look = evidenceLookup(vector, radiusM);
        // freshRead: the model asked again, past the readings store and the reply cache (to measure how far two reads agree)
        const fresh = args.freshRead === true;
        const store = fresh ? undefined : fileReadingStore(modelReadingsDir(deps.cache.dir));
        const blobChain = fresh ? new VisionModelChain<string>({ client: vision.client, candidates: vision.candidates, signal: ctx.signal, hedgeAfterMs: VISION_HEDGE_AFTER_MS }) : chain;
        const blobs: BlobReadReport = await readBlobs({
            audit, look, vector, tile: readTileTriangles(fs.readFileSync(files.tile)), vision: blobChain, ...(store ? { store } : {}),
            onSheet: (i, jpeg) => fs.writeFileSync(path.join(outDir, `blob_sheet_${String(i).padStart(3, '0')}.jpg`), jpeg),
            ...(ctx.signal ? { signal: ctx.signal } : {}), onProgress: m => ctx.reportProgress?.(m)
        });
        fs.writeFileSync(path.join(outDir, 'blob_read.json'), JSON.stringify(blobs));
        // 2. Street View only for the blobs the cheap read leaves unsure that stand up off the ground and look like things
        const labelled = new Set(blobs.labels.map(l => l.clusterId));
        const unsure = [...blobs.labels.filter(l => l.confidence < BLOB_READ_PARAMS.confidentAt && l.standing >= 0.5 && l.scanFault < 0.5).map(l => l.clusterId),
            ...blobs.evidence.filter(e => !labelled.has(e.clusterId) && !blobs.leftOut.some(o => o.clusterId === e.clusterId)).map(e => e.clusterId)];
        const only = asked ?? unsure;
        if (args.streetView === false || !only.length) {
            const st = blobs.stats;
            return {
                status: 'completed', summaryResult: `${STREET_OBJECTS_TOOL_NAME}: ${st.clusters} blobs; ${st.read} read from the scan, the map and the tile photo (${st.visionCalls} vision calls, ${st.storeHits} answers from the readings store), ${st.confident} labelled with confidence, ${st.unsure} unsure; ${st.inFootprint} building parts and ${st.artefacts} scan artefacts left out. Street View not asked. Report: ${path.relative(ctx.workspaceRoot, path.join(outDir, 'blob_read.json'))}.`,
                resultPayload: { status: 'success', blobRead: path.relative(ctx.workspaceRoot, path.join(outDir, 'blob_read.json')), blobStats: st }
            };
        }
        const walkable = (x: number, z: number) => look.buildingAt(x, z) <= 0 && !look.roadAt(x, z);
        const report = await rebuildStreetObjects({
            walkable,
            origin: { lat, lng, heightMeters: 0 }, audit, scanGlb: files.scan, tileGlb: files.tile, streetView: { ...sv, refusedPanos: sv.refusedPanos ?? new Map<string, string>() }, vision: chain, outDir,
            ...(typeof args.maxFamilies === 'number' ? { maxFamilies: args.maxFamilies } : {}), ...(only?.length ? { only } : {}),
            ...(typeof args.maxImages === 'number' ? { see: { maxImages: args.maxImages } } : {}), overlays: args.overlays !== false,
            ...(ctx.signal ? { signal: ctx.signal } : {}), onProgress: m => ctx.reportProgress?.(m)
        });
        const st = report.stats;
        const rel = (p: string) => path.relative(ctx.workspaceRoot, p);
        const summary = `${STREET_OBJECTS_TOOL_NAME}: ${st.families} street object families (${st.rows} rows, ${st.members} objects); ${st.seen} read from Street View (${st.fetched} of ${st.images} images, ${st.registered} panos registered, ${st.visionCalls} vision calls); ` +
            `${st.rebuilt} rebuilt and kept, ${st.scanKept} kept as scanned, ${st.temporary} temporary (not rebuilt), ${st.notSeen} not seen. Report-only: the build is unchanged. Report: ${rel(path.join(outDir, 'street_objects.json'))}.`;
        return {
            status: 'completed', summaryResult: `${summary} Before it, ${blobs.stats.read} blobs were read from the scan, the map and the tile photo: ${blobs.stats.confident} labelled with confidence, ${blobs.stats.unsure} unsure (Street View asked for ${only.length}).`,
            resultPayload: {
                status: 'success', blobRead: rel(path.join(outDir, 'blob_read.json')), blobStats: blobs.stats, report: rel(path.join(outDir, 'street_objects.json')), ...(report.layerGlb ? { layerGlb: rel(report.layerGlb) } : {}), stats: st, notes: report.notes,
                families: report.families.map(f => ({
                    id: f.id, members: f.members.length, decision: f.decision, reason: f.decisionReason, seen: f.seen?.description, ...(f.check ? { iouRebuild: f.check.iouRebuild, iouScan: f.check.iouScan, deltaERebuild: f.check.deltaERebuild, deltaEScan: f.check.deltaEScan } : {}),
                    ...(f.spec ? { operator: f.spec.operator, provenance: f.spec.provenance.map(p => `${p.field}: ${p.label}`) } : {}), ...(f.glb ? { glb: rel(f.glb) } : {}), ...(f.overlays ? { overlays: f.overlays.map(rel) } : {}), ...(f.era ? { era: f.era } : {})
                }))
            }
        };
    } catch (err) {
        const code = err instanceof StreetObjectsToolError ? err.code : 'street_objects_failed';
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'failed', summaryResult: `${STREET_OBJECTS_TOOL_NAME} (${code}): ${msg}`, resultPayload: { status: 'error', code, error: msg } };
    }
};

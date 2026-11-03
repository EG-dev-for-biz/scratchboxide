/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A chunked district (pipeline K-D), once its chunks have joined, audited (district-completeness-audit.ts) and offered to
 * the place store (place-store.ts) as the place's next version: one record per building of the plan, and per neighbour
 * whose footprint reaches into the district (a building the edge cuts), keyed by Google's vector feature id; one per
 * separate scan component standing in no footprint; one for the ground and one for the trees. Each record's version
 * holds the files of the layers that draw it (clay and textured twin), its provenance shares by area, the audit's
 * measures and failures, and the switches and code that built it; the store keeps it only when no measure is worse.
 *
 * The orchestrator calls this behind SCRATCHBOX_PLACE_STORE=1, after the chunks' seams are closed. It never fails the
 * build (only a stopped build's stop passes through): what it did, and which store it used, is its report (the run note
 * `place_store`).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StagedLayer } from '../../../common/spatial/staged-location-contracts';
import type { CloudBucket } from '../../cloud-store/cloud-bucket';
import { auditDistrict, DISTRICT_AUDIT_VERSION, type AuditLayer, type DistrictAudit, type SurfaceAudit } from './district-completeness-audit';
import { districtFootprints, type DistrictFootprint } from './pipeline-k/district-buildings';
import type { DistrictChunkPlan } from './pipeline-k/district-chunks';
import { DISTRICT_SEAMS_VERSION } from './pipeline-k/district-seams';
import {
    commitPlaceRun, openPlaceStore, placeCodeVersion, placeKey, PLACE_STORE_SCHEMA,
    type PlaceCommitReport, type PlaceMeasures, type PlaceOffer, type PlaceStoreLocation
} from './place-store';
import type { VectorEvidence } from './vector-footprints';

export { placeStoreEnabled } from './place-store';
import { selectPaintBuildings } from './vector-first-paint';

/** How far past the district's radius neighbours' footprints are read (m): as far as an extraction may grow to keep a building whole (orchestrator.ts DISTRICT_CONTAINMENT_MAX_GROWTH_M). */
const NEIGHBOUR_REACH_M = 100;

/** Environment switches that never go into a record: anything that may hold a secret. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

export interface DistrictPlaceInput {
    runId: string;
    place: { lat: number; lng: number; formattedAddress?: string };
    /** The district frame's ellipsoidal height at the anchor (the tiles' origin). */
    originEllipsoidalHeightM?: number;
    plan: DistrictChunkPlan;
    /** The run's layers as committed (retired and superseded ones are left out here). */
    layers: StagedLayer[];
    modelsDir: string;
    workspaceRoot: string;
    /** The request's own switches (pipeline, district, model service, ...): string, number and boolean fields are kept. */
    request: object;
    vectorEvidence?: (req: { lat: number; lng: number; radiusM: number }) => Promise<VectorEvidence>;
    signal?: AbortSignal;
    progress?: (message: string) => void;
    /** Where the store is (tests): a bucket (null: none) and the fallback root. */
    store?: { bucket?: CloudBucket | null; fallbackRoot?: string; tmpDir?: string };
    env?: NodeJS.ProcessEnv;
}

export interface DistrictPlaceReport {
    where: PlaceStoreLocation;
    key: string;
    /** Set when nothing was audited or committed, with why. */
    skipped?: string;
    audit?: {
        version: string; ms: number; buildings: number; failing: number; trees: number; treesCut: number;
        layers: DistrictAudit['layers']; neighbours: number | string;
    };
    commit?: PlaceCommitReport;
    error?: string;
    ms: number;
}

/** The measures of a record from its audit: each with the way that is better and the change within which it is noise. */
export function auditMeasures(s: SurfaceAudit): PlaceMeasures {
    const lower = (value: number, tol = 0) => ({ value, better: 'lower' as const, tol });
    return {
        // a version that loses part of the surface is worse, whatever else it improves
        areaM2: { value: s.areaM2, better: 'higher', tol: s.areaM2 * 0.05 },
        ...(s.edge ? { straddlesEdge: lower(s.edge.state === 'straddles' ? 1 : 0) } : {}),
        ...(s.kind !== 'ground' ? { cutAtEdgeM: lower(s.cutAtEdgeM, 0.1) } : {}),
        openEdgeM: lower(s.openEdgeM, Math.max(0.5, s.openEdgeM * 0.02)),
        nonManifoldEdges: lower(s.nonManifoldEdges, Math.max(2, s.nonManifoldEdges * 0.02)),
        holes: lower(s.holes),
        holePerimeterM: lower(s.holePerimeterM, 0.5),
        blackShare: lower(s.blackShare, 0.001),
        untexturedShare: lower(s.untexturedShare, 0.002),
        overlapAreaM2: lower(s.overlapAreaM2, 0.1),
        floatingPieces: lower(s.floatingPieces),
        floatingAreaM2: lower(s.floatingAreaM2, 0.05),
        auditFailures: lower(s.failures.length)
    };
}

/** The switches that built the run: the request's own fields and every SCRATCHBOX_ setting that cannot hold a secret. */
export function buildSwitches(request: object, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(request)) if (k !== 'query' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) out[`request.${k}`] = String(v);
    for (const [k, v] of Object.entries(env)) if (k.startsWith('SCRATCHBOX_') && v !== undefined && !SECRET_NAME.test(k)) out[k] = v;
    return out;
}

/** Audits the joined district and commits it to the place store. Throws only when the build is stopped. */
export async function recordDistrictInPlaceStore(input: DistrictPlaceInput): Promise<DistrictPlaceReport> {
    const t0 = Date.now();
    const key = placeKey(input.place);
    const store = await openPlaceStore({ key, ...(input.store ?? {}), ...(input.env ? { env: input.env } : {}) });
    const report: DistrictPlaceReport = { where: store.where, key, ms: 0 };
    const done = (r: Partial<DistrictPlaceReport> = {}) => ({ ...report, ...r, ms: Date.now() - t0 });
    input.progress?.(store.where.kind === 'none' ? `place store: none (${store.where.reason})` : `place store: ${store.where.label}${store.where.reason ? ` (the fallback: ${store.where.reason})` : ''}`);
    if (!store.bucket) return done({ skipped: store.where.reason ?? 'no place store' });
    try {
        // the layers as drawn: neither retired nor hidden by another, each its textured twin where it has one
        const shown = input.layers.filter(l => !l.retired);
        const hidden = new Set(shown.flatMap(l => l.supersedes));
        const fileOf = (url: string) => path.join(input.modelsDir, path.basename(url));
        const filesOf = new Map<string, Array<{ role: string; path: string }>>();
        const layers: AuditLayer[] = [];
        for (const l of shown) {
            if (hidden.has(l.objectId)) continue;
            const clay = fileOf(l.url), textured = l.textured ? fileOf(l.textured.url) : undefined;
            const drawn = textured && fs.existsSync(textured) ? textured : clay;
            if (!fs.existsSync(drawn)) continue;
            filesOf.set(l.objectId, [{ role: 'clay', path: clay }, ...(textured ? [{ role: 'textured', path: textured }] : [])]);
            // the trees stage's pieces are kept whole by the chunks' join (district-chunks.ts joinChunkGlb), so they are audited as trees
            layers.push({ id: l.objectId, read: () => fs.readFileSync(drawn), label: l.provenance.label, wholePieces: l.stage === 'trees' });
        }
        // the neighbours' footprints: a building past the radius that reaches into it is one the edge cuts
        const planned = new Map<string, DistrictFootprint>(input.plan.footprints.map(f => [f.id, { id: f.id, loops: f.loops }]));
        let neighbours: number | string = 'no vector data';
        const buildings: DistrictFootprint[] = [...planned.values()];
        if (input.vectorEvidence) {
            try {
                const reach = input.plan.radiusM + NEIGHBOUR_REACH_M;
                const ev = await input.vectorEvidence({ lat: input.place.lat, lng: input.place.lng, radiusM: reach });
                const extra = districtFootprints(selectPaintBuildings(ev, reach).buildings).filter(f => !planned.has(f.id));
                buildings.push(...extra);
                neighbours = extra.length;
            } catch (err) {
                neighbours = `the neighbours' footprints could not be read (${errorMessage(err)})`;
            }
        }
        const audit = await auditDistrict({
            layers, buildings, edge: { radiusM: input.plan.radiusM, grownBy: [...planned.values()] },
            ...(input.signal ? { signal: input.signal } : {}), ...(input.progress ? { progress: input.progress } : {})
        });
        const filesFor = (ids: string[]) => ids.flatMap(id => filesOf.get(id) ?? []);
        const offers: PlaceOffer[] = [];
        for (const s of audit.surfaces) {
            // a neighbour with nothing in the district is not part of it
            if (s.kind === 'building' && !planned.has(s.id) && !s.triangles) continue;
            offers.push({
                id: s.id, idSource: s.kind === 'building' ? 'google-vector-feature' : s.kind,
                ...(s.kind === 'building' ? { footprint: (planned.get(s.id) ?? buildings.find(b => b.id === s.id))?.loops ?? [] } : {}),
                files: filesFor(s.layers), provenance: s.provenance, measures: auditMeasures(s),
                defects: s.failures.map(f => ({ kind: f.check, detail: f.detail, source: DISTRICT_AUDIT_VERSION, ...(s.centre ? { at: [s.centre[0], 0, s.centre[1]] as [number, number, number] } : {}) })),
                audit: s
            });
        }
        if (audit.trees.count) {
            offers.push({
                id: 'trees', idSource: 'trees', files: filesFor(layers.filter(l => l.wholePieces).map(l => l.id)), provenance: {},
                measures: { trees: { value: audit.trees.count, better: 'higher', tol: audit.trees.count * 0.02 }, treesCut: { value: audit.trees.cut, better: 'lower', tol: 0 } },
                defects: audit.trees.list.filter(t => !t.whole).map(t => ({ kind: 'crown-cut', detail: `the crown stops at the district's edge (${t.reachOutM.toFixed(1)} m of the ${t.expectedOutM.toFixed(1)} m it reaches out)`, source: DISTRICT_AUDIT_VERSION, at: [t.centre[0], 0, t.centre[1]] as [number, number, number] })),
                audit: audit.trees
            });
        }
        const codeVersion = placeCodeVersion(input.workspaceRoot, { 'district-chunks': input.plan.version, 'district-seams': DISTRICT_SEAMS_VERSION, audit: DISTRICT_AUDIT_VERSION, store: PLACE_STORE_SCHEMA }, input.env);
        input.progress?.(`place store: committing ${offers.length} records`);
        const commit = await commitPlaceRun(store, {
            runId: input.runId,
            anchor: { lat: input.place.lat, lng: input.place.lng, ...(input.originEllipsoidalHeightM !== undefined ? { originEllipsoidalHeightM: input.originEllipsoidalHeightM } : {}), ...(input.place.formattedAddress ? { address: input.place.formattedAddress } : {}) },
            radiusM: input.plan.radiusM,
            edge: { radiusM: input.plan.radiusM, grownBy: [...planned.keys()] },
            chunks: { version: input.plan.version, cellM: input.plan.cellM, cells: input.plan.chunks.map(c => ({ index: c.index, cx: c.cx, cz: c.cz, half: c.half, rect: c.rect, centre: c.centre, buildings: c.buildings })) },
            codeVersion, switches: buildSwitches(input.request, input.env), offers, workspaceRoot: input.workspaceRoot
        });
        const buildingAudits = audit.surfaces.filter(s => s.kind === 'building' && (planned.has(s.id) || s.triangles));
        return done({
            audit: {
                version: audit.version, ms: audit.ms, buildings: buildingAudits.length, failing: buildingAudits.filter(s => s.failures.length).length,
                trees: audit.trees.count, treesCut: audit.trees.cut, layers: audit.layers, neighbours
            },
            commit
        });
    } catch (err) {
        // a stopped build stops here too; anything else is this step's own failure, reported
        if (input.signal?.aborted) throw err;
        return done({ error: errorMessage(err) });
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

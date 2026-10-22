/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scene inventory of a district: one sb-feature/1 entity for every thing the sources know of inside the extraction,
 * before anything is rebuilt. Each entity lists the sources that saw it, its measured geometry and its relations, so later
 * steps (Street View identification, district massing, object rebuilds) read one table instead of the raw scan.
 *
 * - every Google vector building, measured against the scan's surface inside its footprint (height percentiles, coverage);
 * - every Google road, rail and water feature that reaches the extraction;
 * - every crown tile_vegetation measured, whatever became of it;
 * - every cluster of the district's street audit (district-residual-audit.ts), with its verdict, and its nearest building,
 *   nearest track and the crown it stands under.
 *
 * Type codes are labels (Google's codes as Google gives them, ours from sb-feature-types.ts); nothing here selects geometry.
 * The checks are the inventory's own gate: every source item in exactly once, ids unique.
 */

import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { SB_FEATURE_PREFIX, typesFromLabels, type SbFeature } from '../../../common/spatial/sb-feature-types';
import type { EvidenceLookup, VectorEvidence } from './vector-footprints';
import { measureRailLines, type DistrictAuditResult } from './district-residual-audit';

export const SCENE_INVENTORY_VERSION = 'scene-inventory/1';
const FRAME = 'tile (x east, y up, z south), metres';
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The crown fields the inventory reads (tile_vegetation's crowns.json). */
export interface InventoryCrown { id: number; status: string; apex: [number, number, number]; stem: [number, number]; supportY: number; sectorRadii: number[]; areaM2: number; apexAboveSupport: number }

export interface SceneInventoryCheck { name: string; ok: boolean; detail: string }

export interface SceneInventory {
    schema: 'scratchbox.scene-inventory/1';
    version: string;
    frame: string;
    entities: SbFeature[];
    /** Entities per source family (by id prefix) and per most specific type. */
    counts: { byFamily: Record<string, number>; byType: Record<string, number> };
    /** Vector buildings the vector fetch returned that have no footprint cell inside the extraction (not inventoried). */
    outsideExtraction: { buildings: number; roads: number; rails: number; water: number };
    checks: SceneInventoryCheck[];
}

const percentile = (a: number[], q: number) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };

function bboxOfPoints(pts: Vec2[], yAt: (x: number, z: number) => number): { lo: [number, number, number]; hi: [number, number, number] } {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, z] of pts) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        const y = yAt(x, z);
        if (Number.isFinite(y)) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    if (!Number.isFinite(y0)) { y0 = 0; y1 = 0; }
    return { lo: [r2(x0), r2(y0), r2(z0)], hi: [r2(x1), r2(y1), r2(z1)] };
}

/** The nearest vector building cell to (x, z) within `maxM`: its building index and the distance, or undefined. */
function nearestBuilding(look: EvidenceLookup, x: number, z: number, maxM = 12): { index: number; distanceM: number } | undefined {
    let best: { index: number; distanceM: number } | undefined;
    const r = Math.ceil(maxM);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dz);
        if (d > maxM || (best && d >= best.distanceM)) continue;
        const b = look.buildingAt(x + dx, z + dz);
        if (b > 0) best = { index: b - 1, distanceM: d };
    }
    return best;
}

export function buildSceneInventory(input: {
    vector: VectorEvidence; look: EvidenceLookup; ground: GroundModel; within: (x: number, z: number) => boolean;
    audit: DistrictAuditResult; crowns: InventoryCrown[];
    /** Crowns in tile_vegetation's file, before any without geometry was set aside: the gate counts against this. */
    crownsInFile?: number;
    sourceIds: { extraction: string; vector: string; trees: string; audit: string };
}): SceneInventory {
    const { vector, look, ground, within, audit, crowns, sourceIds } = input;
    const crownsInFile = input.crownsInFile ?? crowns.length;
    const entities: SbFeature[] = [];
    const ids = { building: (i: number) => `building/${vector.buildings[i].id}`, road: (i: number) => `road/${i}`, rail: (i: number) => `rail/${i}`, water: (i: number) => `water/${i}`, tree: (id: number) => `tree/${id}`, cluster: (id: number) => `cluster/${id}` };
    const groundAt = (x: number, z: number) => ground.groundAt(x, z);

    // ---- buildings: one pass over the footprint raster, the scan's surface measured in each footprint
    const g = look.grid, raster = look.raster.building;
    const acc = new Map<number, { cells: number; heights: number[]; x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }>();
    for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
        const b = raster[k * g.nx + i] - 1;
        if (b < 0) continue;
        const x = g.x0 + (i + 0.5) * g.cellMeters, z = g.z0 + (k + 0.5) * g.cellMeters;
        if (!within(x, z)) continue;
        const a = acc.get(b) ?? { cells: 0, heights: [], x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity };
        a.cells++;
        a.x0 = Math.min(a.x0, x - g.cellMeters / 2); a.x1 = Math.max(a.x1, x + g.cellMeters / 2); a.z0 = Math.min(a.z0, z - g.cellMeters / 2); a.z1 = Math.max(a.z1, z + g.cellMeters / 2);
        const top = ground.topAt(x, z), gr = ground.groundAt(x, z);
        if (Number.isFinite(gr)) a.y0 = Math.min(a.y0, gr);
        if (Number.isFinite(top) && Number.isFinite(gr)) { a.heights.push(top - gr); a.y1 = Math.max(a.y1, top); }
        acc.set(b, a);
    }
    for (const [b, a] of [...acc].sort((p, q) => p[0] - q[0])) {
        const vb = vector.buildings[b];
        const coverage = a.heights.length / a.cells;
        const p50 = percentile(a.heights, 0.5), p90 = percentile(a.heights, 0.9);
        const measured = coverage >= 0.5;
        entities.push({
            schema: 'sb-feature/1', id: ids.building(b), types: ['FEATURE_TYPE_BUILDING'], typeLabels: [{ code: 'FEATURE_TYPE_BUILDING', confidence: 1, by: 'google vector tiles' }],
            description: `a building footprint from Google vector data, ${Math.round(a.cells * g.cellMeters ** 2)} m2 inside the extraction${Number.isFinite(p90) ? `; the scan's surface stands ${r2(p50)} m (median) to ${r2(p90)} m (90th percentile) over the ground in it` : '; the scan shows no surface in it'}${vb.heightM ? `, Google gives ${r2(vb.heightM)} m` : ''}`,
            geometry: { boundingBox: { lo: [r2(a.x0), r2(Number.isFinite(a.y0) ? a.y0 : 0), r2(a.z0)], hi: [r2(a.x1), r2(Number.isFinite(a.y1) ? a.y1 : 0), r2(a.z1)], frame: FRAME }, footprintParts: vb.parts.length },
            measurements: {
                footprintM2: r2(a.cells * g.cellMeters ** 2), vectorHeightM: vb.heightM !== undefined ? r2(vb.heightM) : null,
                scanHeightP50M: Number.isFinite(p50) ? r2(p50) : null, scanHeightP90M: Number.isFinite(p90) ? r2(p90) : null, scanCoverage: r2(coverage),
                heightDeltaM: vb.heightM !== undefined && Number.isFinite(p90) ? r2(p90 - vb.heightM) : null
            },
            provenance: {
                label: measured ? 'measured' : 'vector-modelled', confidence: r2(measured ? coverage : 0.5),
                sources: [{ kind: 'vector-tiles', id: sourceIds.vector }, ...(a.heights.length ? [{ kind: 'tile-extraction', id: sourceIds.extraction }] : [])],
                method: `${SCENE_INVENTORY_VERSION}: footprint rasterised at ${g.cellMeters} m; the scan's highest surface over the measured ground in each cell`
            }
        });
    }
    const buildingsOutside = vector.buildings.length - acc.size;

    // ---- roads, rails, water: those reaching the extraction
    const reaches = (pts: Vec2[]) => pts.some(([x, z]) => within(x, z));
    let roadsOut = 0, railsOut = 0, waterOut = 0;
    vector.roads.forEach((pts, i) => {
        if (!reaches(pts)) { roadsOut++; return; }
        const len = pts.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]), 0);
        entities.push({
            schema: 'sb-feature/1', id: ids.road(i), types: ['FEATURE_TYPE_ROAD'], typeLabels: [{ code: 'FEATURE_TYPE_ROAD', confidence: 1, by: 'google vector tiles' }],
            description: `a road centreline from Google vector data, ${Math.round(len)} m`, geometry: { boundingBox: { ...bboxOfPoints(pts, groundAt), frame: FRAME }, centreline: pts.map(([x, z]) => [r2(x), r2(z)]) },
            measurements: { lengthM: r2(len) }, provenance: { label: 'vector-modelled', confidence: 1, sources: [{ kind: 'vector-tiles', id: sourceIds.vector }] }
        });
    });
    const lines = measureRailLines(vector.rails ?? [], vector.roads);
    for (const l of lines) {
        if (!reaches(l.points)) { railsOut++; continue; }
        entities.push({
            schema: 'sb-feature/1', id: ids.rail(l.index), types: ['FEATURE_TYPE_RAIL'], typeLabels: [{ code: 'FEATURE_TYPE_RAIL', confidence: 1, by: 'google vector tiles' }],
            description: `a rail centreline from Google vector data, ${Math.round(l.lengthM)} m, ${Math.round(l.streetRunningShare * 100)}% of it along a road`,
            geometry: { boundingBox: { ...bboxOfPoints(l.points, groundAt), frame: FRAME }, centreline: l.points.map(([x, z]) => [r2(x), r2(z)]) },
            measurements: { lengthM: r2(l.lengthM), streetRunningShare: r2(l.streetRunningShare) },
            provenance: { label: 'vector-modelled', confidence: 1, sources: [{ kind: 'vector-tiles', id: sourceIds.vector }, { kind: 'measurement', id: 'rail-along-road' }] }
        });
    }
    vector.water.forEach((loops, i) => {
        const pts = loops.flat();
        if (!reaches(pts)) { waterOut++; return; }
        entities.push({
            schema: 'sb-feature/1', id: ids.water(i), types: ['FEATURE_TYPE_WATER'], typeLabels: [{ code: 'FEATURE_TYPE_WATER', confidence: 1, by: 'google vector tiles' }],
            description: 'a water area from Google vector data', geometry: { boundingBox: { ...bboxOfPoints(pts, groundAt), frame: FRAME } },
            provenance: { label: 'vector-modelled', confidence: 1, sources: [{ kind: 'vector-tiles', id: sourceIds.vector }] }
        });
    });

    // ---- crowns: every one tile_vegetation measured
    const crownR = (c: InventoryCrown) => c.sectorRadii.reduce((a, b) => a + b, 0) / Math.max(1, c.sectorRadii.length);
    for (const c of crowns) {
        const rMax = Math.max(...c.sectorRadii, 0);
        const conf = c.status === 'tree' ? 1 : c.status.startsWith('cut_at_boundary') ? 0.4 : 0.3;
        entities.push({
            schema: 'sb-feature/1', id: ids.tree(c.id), types: typesFromLabels([{ code: SB_FEATURE_PREFIX + 'TREE', confidence: conf }]), typeLabels: [{ code: SB_FEATURE_PREFIX + 'TREE', confidence: conf, by: 'tile_vegetation measures' }],
            description: `a crown measured in the photo tiles (${c.status}): ${r2(c.apexAboveSupport)} m tall, ${Math.round(c.areaM2)} m2`,
            geometry: { boundingBox: { lo: [r2(c.stem[0] - rMax), r2(c.supportY), r2(c.stem[1] - rMax)], hi: [r2(c.stem[0] + rMax), r2(c.apex[1]), r2(c.stem[1] + rMax)], frame: FRAME } },
            measurements: { heightM: r2(c.apexAboveSupport), crownAreaM2: r2(c.areaM2), crownMeanRadiusM: r2(crownR(c)) },
            provenance: { label: 'measured', confidence: conf, sources: [{ kind: 'tile-extraction', id: sourceIds.extraction }, { kind: 'tile-vegetation', id: sourceIds.trees }], method: `tile_vegetation crown, status ${c.status}` }
        });
    }

    // ---- the street audit's clusters, with their relations
    for (const c of audit.audit.clusters) {
        const cx = (c.lo[0] + c.hi[0]) / 2, cz = (c.lo[2] + c.hi[2]) / 2;
        const relations: NonNullable<SbFeature['relations']> = [];
        const nb = nearestBuilding(look, cx, cz);
        if (nb && acc.has(nb.index)) relations.push({ kind: 'NEAR', target: ids.building(nb.index), confidence: r2(1 - nb.distanceM / 12) });
        const rail = audit.railContexts[c.id];
        if (rail && lines[rail.line]) relations.push({ kind: 'NEAR', target: ids.rail(lines[rail.line].index), confidence: r2(1 - rail.distanceM / 6) });
        for (const t of crowns) if (Math.hypot(cx - t.stem[0], cz - t.stem[1]) <= crownR(t) && c.lo[1] < t.apex[1]) relations.push({ kind: 'UNDER', target: ids.tree(t.id), confidence: 0.5 });
        const { feature } = c;
        entities.push({
            ...feature, id: ids.cluster(c.id),
            measurements: { ...feature.measurements, ...(nb ? { nearestBuildingM: nb.distanceM } : {}) },
            provenance: { ...feature.provenance, sources: [{ kind: 'tile-extraction', id: sourceIds.extraction }, { kind: 'residual-audit', id: sourceIds.audit }, ...(rail ? [{ kind: 'vector-tiles', id: sourceIds.vector }] : [])] },
            relations: [...(feature.relations ?? []), ...relations], description: feature.description ?? c.reason,
            frame: { ...(feature.frame ?? {}), verdict: c.verdict }
        });
    }

    // ---- the gate
    const idCount = new Map<string, number>();
    for (const e of entities) idCount.set(e.id, (idCount.get(e.id) ?? 0) + 1);
    const dup = [...idCount].filter(([, n]) => n > 1).map(([id]) => id);
    const family = (prefix: string) => entities.filter(e => e.id.startsWith(prefix + '/')).length;
    const noSources = entities.filter(e => !e.provenance.sources.length).map(e => e.id);
    const checks: SceneInventoryCheck[] = [
        { name: 'ids unique', ok: dup.length === 0, detail: dup.length ? `repeated: ${dup.slice(0, 5).join(', ')}` : `${entities.length} entities` },
        { name: 'every vector building reaching the extraction once', ok: family('building') === acc.size && acc.size + buildingsOutside === vector.buildings.length, detail: `${acc.size} inside, ${buildingsOutside} wholly outside, of ${vector.buildings.length}` },
        { name: 'every audit cluster once', ok: family('cluster') === audit.audit.clusters.length, detail: `${family('cluster')} of ${audit.audit.clusters.length}` },
        { name: 'every measured crown once', ok: family('tree') === crownsInFile, detail: `${family('tree')} of ${crownsInFile}${crownsInFile > crowns.length ? ` (${crownsInFile - crowns.length} without a stem, apex or sector radii)` : ''}` },
        { name: 'every entity lists its sources', ok: noSources.length === 0, detail: noSources.length ? `none on ${noSources.slice(0, 5).join(', ')}` : 'all' }
    ];
    const byFamily: Record<string, number> = {}, byType: Record<string, number> = {};
    for (const e of entities) {
        const f = e.id.split('/')[0];
        byFamily[f] = (byFamily[f] ?? 0) + 1;
        const t = e.types[e.types.length - 1] ?? SB_FEATURE_PREFIX + 'OBJECT';
        byType[t] = (byType[t] ?? 0) + 1;
    }
    return { schema: 'scratchbox.scene-inventory/1', version: SCENE_INVENTORY_VERSION, frame: FRAME, entities, counts: { byFamily, byType }, outsideExtraction: { buildings: buildingsOutside, roads: roadsOut, rails: railsOut, water: waterOut }, checks };
}

export interface SceneInventorySummary {
    counts: SceneInventory['counts'];
    outsideExtraction: SceneInventory['outsideExtraction'];
    checks: SceneInventoryCheck[];
    /** The inventory's buildings for the object catalog (the trees and the street clusters are catalogued by their own steps). */
    buildings: Array<{ id: string; type: string; description: string; confidence: number; lo: [number, number, number]; hi: [number, number, number] }>;
}

export function sceneInventorySummary(inv: SceneInventory): SceneInventorySummary {
    return {
        counts: inv.counts, outsideExtraction: inv.outsideExtraction, checks: inv.checks,
        buildings: inv.entities.filter(e => e.id.startsWith('building/')).map(e => {
            const bb = e.geometry.boundingBox as { lo: [number, number, number]; hi: [number, number, number] };
            return { id: e.id, type: e.types[e.types.length - 1], description: e.description ?? '', confidence: e.provenance.confidence, lo: bb.lo, hi: bb.hi };
        })
    };
}

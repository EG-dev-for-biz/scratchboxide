/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Synthetic worlds with known truth for the staged-location tests (ground, closed building boxes, tree crowns), and
 * stand-ins for the native stages that do what the real ones do to such a world: strip removes the crowns it measures
 * (and copies the rest unchanged), tile_refine "remeshes" (isolates the structure at the anchor and labels per-vertex
 * provenance), plant writes one mesh per measured crown. Each records its requests; each can be told to fail.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeStagedGlbFile } from '../../src/node/3d-engine/staged-location/staged-glb-writer';
import { TileVegetationError, type TileVegetationPlantRequest, type TileVegetationPlantResult, type TileVegetationStripRequest, type TileVegetationStripResult } from '../../src/node/3d-engine/tile-vegetation-service';
import type { TileRefineRequest, TileRefineResult } from '../../src/node/3d-engine/tile-refine-service';
import type { StagedExtraction } from '../../src/node/3d-engine/staged-location/orchestrator';
import { readGlbScene } from '../../src/node/spatial/StreetViewPoseRegistrar';

/** Every triangle of a GLB, world space. */
export function readTris(file: string): Tri[] {
    return readGlbScene(file).flatMap(p => {
        const o: Tri[] = [];
        for (let t = 0; t < p.indices.length; t += 3) o.push([0, 1, 2].flatMap(j => [p.positions[p.indices[t + j] * 3], p.positions[p.indices[t + j] * 3 + 1], p.positions[p.indices[t + j] * 3 + 2]]) as Tri);
        return o;
    });
}

export type Tri = [number, number, number, number, number, number, number, number, number];

function quad(a: number[], b: number[], c: number[], d: number[]): Tri[] {
    return [[...a, ...b, ...c] as Tri, [...a, ...c, ...d] as Tri];
}

export function building(x0: number, x1: number, z0: number, z1: number, h: number): Tri[] {
    const out: Tri[] = [];
    const wall = (ax: number, az: number, bx: number, bz: number) => {
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
        for (let i = 0; i < n; i++) {
            const p = ax + ((bx - ax) * i) / n, q = az + ((bz - az) * i) / n, r = ax + ((bx - ax) * (i + 1)) / n, s = az + ((bz - az) * (i + 1)) / n;
            for (let y = 0; y < h; y += 2) out.push(...quad([p, y, q], [r, y, s], [r, Math.min(h, y + 2), s], [p, Math.min(h, y + 2), q]));
        }
    };
    wall(x0, z0, x1, z0); wall(x1, z0, x1, z1); wall(x1, z1, x0, z1); wall(x0, z1, x0, z0);
    for (let x = x0; x < x1; x += 2) for (let z = z0; z < z1; z += 2) out.push(...quad([x, h, z], [Math.min(x1, x + 2), h, z], [Math.min(x1, x + 2), h, Math.min(z1, z + 2)], [x, h, Math.min(z1, z + 2)]));
    return out;
}

export function crown(cx: number, cz: number, r: number, h: number): Tri[] {
    const out: Tri[] = [];
    const y = (x: number, z: number) => { const d = Math.hypot(x - cx, z - cz); return d >= r ? 0.2 : 2 + h * Math.sqrt(1 - (d / r) ** 2); };
    for (let x = cx - r; x < cx + r; x += 1) for (let z = cz - r; z < cz + r; z += 1) {
        if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) > r) continue;
        out.push(...quad([x, y(x, z), z], [x + 1, y(x + 1, z), z], [x + 1, y(x + 1, z + 1), z + 1], [x, y(x, z + 1), z + 1]));
    }
    return out;
}

export function groundGrid(half: number, step = 4): Tri[] {
    const out: Tri[] = [];
    for (let x = -half; x < half; x += step) for (let z = -half; z < half; z += step) out.push(...quad([x, 0, z], [x + step, 0, z], [x + step, 0, z + step], [x, 0, z + step]));
    return out;
}

export function writeTris(file: string, tris: Tri[], attributes?: (positions: Float32Array) => Record<string, Float32Array>): string {
    const positions = Float32Array.from(tris.flat());
    writeStagedGlbFile(file, [{ positions, ...(attributes ? { attributes: attributes(positions) } : {}) }]);
    return file;
}

const within = (t: Tri, reach: number) => Math.abs((t[0] + t[3] + t[6]) / 3) <= reach && Math.abs((t[2] + t[5] + t[8]) / 3) <= reach;

export interface WorldSpec {
    ground: number;
    buildings: Array<[number, number, number, number, number]>;
    trees: Array<{ x: number; z: number; r: number; h: number; id: number }>;
}

/** The world as triangles, with each tree's triangles known. */
export function world(spec: WorldSpec): { all: Tri[]; trees: Map<number, Tri[]>; buildings: Tri[][] } {
    const trees = new Map(spec.trees.map(t => [t.id, crown(t.x, t.z, t.r, t.h)]));
    const buildings = spec.buildings.map(b => building(...b));
    return { all: [...groundGrid(spec.ground), ...buildings.flat(), ...[...trees.values()].flat()], trees, buildings };
}

export interface FakeNative {
    extractCalls: number[];
    stripCalls: Array<TileVegetationStripRequest & { roi?: unknown }>;
    refineCalls: TileRefineRequest[];
    plantCalls: TileVegetationPlantRequest[];
    deps: {
        extract(req: { lat: number; lng: number; radiusM: number; outDir: string }): Promise<StagedExtraction>;
        vegetation: { strip(req: TileVegetationStripRequest): Promise<TileVegetationStripResult>; plant(req: TileVegetationPlantRequest): Promise<TileVegetationPlantResult> };
        refine: { refine(req: TileRefineRequest): Promise<TileRefineResult> };
    };
}

export interface FakeOptions {
    stripFails?: Error;
    refineFails?: Error;
    plantFails?: Error;
    /** Delay inside plant (ms). */
    plantDelayMs?: number;
    refineDelayMs?: number;
    /** tile_refine isolates the structure at this point instead of the anchor (an isolate mismatch). */
    isolateAt?: { x: number; z: number };
}

const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

/** Native stand-ins over a synthetic world, writing their outputs under `root`. */
export function fakeNative(root: string, spec: WorldSpec, opts: FakeOptions = {}): FakeNative {
    const w = world(spec);
    const out: FakeNative = { extractCalls: [], stripCalls: [], refineCalls: [], plantCalls: [], deps: undefined as any };
    const removedIds = new Set(spec.trees.map(t => t.id));
    out.deps = {
        extract: async req => {
            out.extractCalls.push(req.radiusM);
            const reach = req.radiusM + 10;
            const kept = w.all.filter(t => within(t, reach));
            const textured = writeTris(path.join(req.outDir, 'textured.glb'), kept);
            const geometry = writeTris(path.join(req.outDir, 'geometry.glb'), kept);
            return {
                texturedGlb: textured, geometryGlb: geometry, downloadOrder: { leafA: 0, leafB: 1 }, leafIds: ['leafA', 'leafB'], copyrights: ['Google'],
                fetchedAt: '2026-10-15T12:00:00.000Z', radiusM: req.radiusM, coveredRadiusM: req.radiusM, truncated: false, leafTiles: 2,
                leafGeometricErrorM: 2.0064, originEllipsoidalHeightM: -23.5, geoAnchor: { lat: req.lat, lng: req.lng, elevation: 9.2 }
            };
        },
        vegetation: {
            strip: async req => {
                out.stripCalls.push(req as any);
                if (opts.stripFails) throw opts.stripFails;
                const input = String(req.tilePath);
                const key = sha(`strip:${sha(fs.readFileSync(input))}`);
                const dir = path.join(root, 'strip', key);
                fs.mkdirSync(dir, { recursive: true });
                // the input's own triangles: those over a measured crown's disc (above the ground) are removed, the rest
                // are copied unchanged, as strip does
                const raw = readTris(input);
                const inCrown = (t: Tri) => {
                    const cx = (t[0] + t[3] + t[6]) / 3, cy = (t[1] + t[4] + t[7]) / 3, cz = (t[2] + t[5] + t[8]) / 3;
                    return cy > 0.1 && spec.trees.some(tr => removedIds.has(tr.id) && Math.hypot(cx - tr.x, cz - tr.z) <= tr.r + 0.5);
                };
                const treeTris = raw.filter(inCrown);
                const devegetated = raw.filter(t => !inCrown(t));
                writeTris(path.join(dir, 'devegetated.glb'), devegetated);
                const crowns = spec.trees.map(t => ({ id: t.id, status: 'tree', areaM2: Math.round(Math.PI * t.r * t.r), stem: [t.x, t.z], apex: [t.x, t.h, t.z], supportY: 0, apexAboveSupport: t.h, sectorRadii: new Array(16).fill(t.r), footprint: Array.from({ length: 12 }, (_, k) => [t.x + (t.r + 0.8) * Math.cos((k * Math.PI) / 6), t.z + (t.r + 0.8) * Math.sin((k * Math.PI) / 6)]) }));
                fs.writeFileSync(path.join(dir, 'crowns.json'), JSON.stringify({ version: 1, crowns }));
                return {
                    devegetatedGlb: path.join(dir, 'devegetated.glb'), crownsJson: path.join(dir, 'crowns.json'), tileSha256: sha(fs.readFileSync(input)), cached: false, ms: 40, cacheKey: key,
                    stats: { canopyAreaM2: 200, treeCanopyAreaM2: 150, triangles: { input: raw.length, removed: treeTris.length, cap: 0, skirt: 0 } }
                };
            },
            plant: async req => {
                out.plantCalls.push(req);
                if (opts.plantDelayMs) await new Promise(r => setTimeout(r, opts.plantDelayMs));
                if (opts.plantFails) throw opts.plantFails;
                const key = sha(`plant:${req.crownsPath}:${req.supportMeshPath ?? ''}:${req.groundMeshPath ?? ''}`);
                const dir = path.join(root, 'plant', key);
                fs.mkdirSync(dir, { recursive: true });
                const crowns = JSON.parse(fs.readFileSync(req.crownsPath, 'utf8')).crowns;
                const tris = crowns.flatMap((c: any) => building(c.footprint[0][0] - 1, c.footprint[0][0], c.footprint[0][1] - 1, c.footprint[0][1], 6));
                writeTris(path.join(dir, 'trees.glb'), tris);
                return {
                    treesGlb: path.join(dir, 'trees.glb'), cached: false, ms: 30, cacheKey: key,
                    stats: { trees: crowns.length, triangles: tris.length, triangleBudget: 23_500, triangleBudgetSource: 'crown_targets', targetTriangles: 23_500, skipped: [], inferred: { crownBaseRatio: 0.35, trunkRadiusPerHeight: 0.016 }, perTree: crowns.map((c: any) => ({ crownId: c.id, crownSurfaceReached: 0.95 })) }
                };
            }
        },
        refine: {
            refine: async req => {
                out.refineCalls.push(req);
                if (opts.refineDelayMs) await new Promise(r => setTimeout(r, opts.refineDelayMs));
                if (opts.refineFails) throw opts.refineFails;
                const input = String(req.tilePath);
                const key = sha(`refine:${sha(fs.readFileSync(input))}:${JSON.stringify({ i: req.isolate, a: req.anchor, r: req.relief })}`);
                const dir = path.join(root, 'refine', key);
                fs.mkdirSync(dir, { recursive: true });
                const tris = readTris(input);
                // isolate: the building nearest the anchor (or isolateAt) and a ground apron
                const at = opts.isolateAt ?? (req.anchor && !Array.isArray(req.anchor) ? req.anchor : { x: 0, z: 0 });
                const target = spec.buildings.map(b => ({ b, d: Math.hypot((b[0] + b[1]) / 2 - at.x, (b[2] + b[3]) / 2 - at.z) })).sort((a, b) => a.d - b.d)[0]?.b;
                const isolated = req.isolate && target
                    ? tris.filter(t => { const cx = (t[0] + t[3] + t[6]) / 3, cz = (t[2] + t[5] + t[8]) / 3; return cx >= target[0] - 4 && cx <= target[1] + 4 && cz >= target[2] - 4 && cz <= target[3] + 4; })
                    : tris;
                const disp = (pos: Float32Array) => ({ _RECTIFY_DISPLACEMENT: Float32Array.from({ length: pos.length / 3 }, (_, i) => (i % 5 === 0 ? 0.03 : 0.0004)), _PROUD_BLOCK: new Float32Array(pos.length / 3) });
                writeTris(path.join(dir, 'clay.glb'), isolated, disp);
                writeTris(path.join(dir, 'textured.glb'), isolated);
                if (req.isolate) writeTris(path.join(dir, 'raw_clay.glb'), isolated);
                return {
                    texturedGlb: path.join(dir, 'textured.glb'), clayGlb: path.join(dir, 'clay.glb'), ...(req.isolate ? { rawClayGlb: path.join(dir, 'raw_clay.glb') } : {}),
                    stats: { triangles: { input: tris.length, kept: isolated.length }, outputs: { triangles: isolated.length }, ...(req.isolate ? { isolate: { enabled: true, triangles: { closure: 12 }, groundPatch: { area_m2: 120 } } } : {}) },
                    cached: false, ms: 25, cacheKey: key, binary: { path: 'fake', built: false }
                } as TileRefineResult;
            }
        }
    };
    return out;
}

export function budgetError(): TileVegetationError {
    return new TileVegetationError('budget_too_small', 'a triangle budget of 10 cannot hold 3 trees at 120 triangles each (they need at least 360)');
}

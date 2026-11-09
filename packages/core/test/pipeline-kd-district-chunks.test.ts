/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

// chunkCpuShare sizes its builds by this machine's memory; a test sets the memory it describes (0: the real figure)
const machine = vi.hoisted(() => ({ totalMem: 0 }));
vi.mock('os', async importOriginal => {
    const real = await importOriginal<typeof import('os')>();
    return { ...real, totalmem: () => machine.totalMem || real.totalmem() };
});

import { chunkCpuShare, chunkOwner, chunkParallel, chunkSteps, chunkTerritory, DISTRICT_CHUNKS_PARAMS, fastChunkIndices, frameTransform, isCellChunk, kdFastChunks, joinChunkGlb, kdBand, kdChunkUnit, KD_GROUND_CELL_STEPS, KD_SHOWN_STEPS, planDistrictChunks } from '../src/node/3d-engine/staged-location/pipeline-k/district-chunks';
import { nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from '../src/node/3d-engine/staged-location/glb-bytes';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { withoutModels } from '../src/node/3d-engine/staged-location/orchestrator';
import { cellLines, solveSeamGains } from '../src/node/3d-engine/staged-location/pipeline-k/district-seams';
import { scanToGeodetic } from '../src/node/spatial/StreetViewSurveyPlanner';
import { GoogleTileDistrictCrawler } from '../src/node/spatial/GoogleTileDistrictCrawler';

const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

describe('pipeline K-D: a district in chunks', () => {
    it('cuts the radius into cells, every building whole in the cell of its middle, each chunk reaching its buildings', () => {
        // a long block straddling the line between the centre cell and its east neighbour (x = 60), its middle at x = 50
        const block = { id: 'block', centroid: [50, 0] as [number, number], loops: [rect(20, -10, 80, 10)] };
        const east = { id: 'east', centroid: [130, 0] as [number, number], loops: [rect(110, -10, 150, 10)] };
        const far = { id: 'far', centroid: [500, 0] as [number, number], loops: [rect(490, -10, 510, 10)] };
        const plan = planDistrictChunks(350, [block, east, far])!;
        expect(plan.chunks.length).toBeGreaterThan(20);
        const centre = plan.chunks.find(c => c.centre)!;
        expect(centre.buildings).toEqual(['block']);
        // the centre chunk reaches the block's far end (80 m), past its own cell, with the margin
        // its rectangle: the cell (x -60..60) grown to the block's far end (80) and the margin, not a circle around it
        expect(centre.rect).toEqual({ x0: -68, z0: -68, x1: 88, z1: 68 });
        expect(centre.radiusM).toBe(Math.ceil(Math.hypot(88, 68)));
        expect(plan.chunks.find(c => c.buildings.includes('east'))!.cx).toBe(120);
        // a building past the radius belongs to no chunk
        expect(plan.chunks.some(c => c.buildings.includes('far'))).toBe(false);
        // ownership: the block's east end (in the east cell) is still the centre's; the street beside it the east cell's
        const owner = chunkOwner(plan);
        expect(owner(75, 0)).toBe(centre.index);
        expect(owner(75, 30)).toBe(plan.chunks.find(c => c.cx === 120 && c.cz === 0)!.index);
        expect(owner(400, 0)).toBe(-1);
        // the band: the centre keeps 3 m of street past its east edge (x 60-63), never into the east cell's building
        const band = chunkTerritory(plan, centre.index, 3), own = chunkTerritory(plan, centre.index);
        expect(band(62, 40)).toBe(true);
        expect(own(62, 40)).toBe(false);
        expect(band(65, 40)).toBe(false);
        expect(band(112, 0)).toBe(false);
        // a small district is one build
        expect(planDistrictChunks(120, [block])).toBeUndefined();
    });

    it('with a task per building, gives each building a chunk of its own, whole, and leaves the cells the ground', () => {
        const block = { id: 'block', centroid: [50, 0] as [number, number], loops: [rect(20, -10, 80, 10)] };
        const east = { id: 'east', centroid: [130, 0] as [number, number], loops: [rect(110, -10, 150, 10)] };
        const cellPlan = planDistrictChunks(350, [block, east])!;
        const plan = planDistrictChunks(350, [block, east], DISTRICT_CHUNKS_PARAMS, 'building')!;
        expect(plan.unit).toBe('building');
        expect(plan.version).toBe(`${cellPlan.version}+building`);
        // the same cells, in the same order, each its plain square plus the margin: no cell grows to a building
        const cells = plan.chunks.filter(isCellChunk);
        expect(cells.map(c => [c.index, c.cx, c.cz])).toEqual(cellPlan.chunks.map(c => [c.index, c.cx, c.cz]));
        const centre = plan.chunks.find(c => c.centre)!;
        expect(centre.rect).toEqual({ x0: -68, z0: -68, x1: 68, z1: 68 });
        expect(cells.every(c => c.buildings.length === 0)).toBe(true);
        // a task per building after the cells: its box grown by the reach and the margin, every building in exactly one
        const tasks = plan.chunks.filter(c => !isCellChunk(c));
        expect(tasks.map(t => t.buildings)).toEqual([['block'], ['east']]);
        expect(tasks[0].index).toBe(cells.length);
        const g = DISTRICT_CHUNKS_PARAMS.marginM + DISTRICT_CHUNKS_PARAMS.buildingReachM;
        expect(tasks[0].rect).toEqual({ x0: 20 - g, z0: -10 - g, x1: 80 + g, z1: 10 + g });
        expect(tasks[0].radiusM).toBe(Math.ceil(Math.hypot(30 + g, 10 + g)));
        expect(plan.footprints.map(f => f.chunk)).toEqual([tasks[0].index, tasks[1].index]);
        // ownership: the block, the reach past its outline (a wall scanned 0.5 m out), the street past that the cell's
        const owner = chunkOwner(plan);
        expect(owner(75, 0)).toBe(tasks[0].index);
        expect(owner(75, 10.5)).toBe(tasks[0].index);
        expect(owner(75, 12)).toBe(plan.chunks.find(c => c.cx === 120 && c.cz === 0)!.index);
        expect(owner(30, 12)).toBe(centre.index);
        expect(owner(400, 0)).toBe(-1);
        // a building's task keeps no band past its edge; a cell keeps its band, never into a building
        const blockKeeps = chunkTerritory(plan, tasks[0].index, 3);
        expect(blockKeeps(75, 0)).toBe(true);
        expect(blockKeeps(75, 12)).toBe(false);
        expect(chunkTerritory(plan, centre.index, 3)(62, 40)).toBe(true);
        expect(chunkTerritory(plan, centre.index, 3)(70, 0)).toBe(false);
        // the seam stage's lines are the cells' alone, and only cells are levelled against each other
        expect(cellLines(plan)).toEqual(cellLines(cellPlan));
        const s = new Map<number, Float32Array>([[1, Float32Array.from([0, 0.5, 0.5, 0.5])]]);
        const solved = solveSeamGains(new Map([[centre.index, s], [tasks[0].index, new Map([[1, Float32Array.from([0, 0.9, 0.9, 0.9])]])]]), plan);
        expect(solved.gains.get(tasks[0].index)).toEqual([1, 1, 1]);
        // a building with no outline (a centroid only) has no box: it stays with its cell, no task with a NaN place
        const bare = planDistrictChunks(350, [block, { id: 'bare', centroid: [10, 130] as [number, number], loops: [] }], DISTRICT_CHUNKS_PARAMS, 'building')!;
        expect(bare.chunks.filter(c => !isCellChunk(c)).map(t => t.buildings)).toEqual([['block']]);
        expect(bare.chunks.find(c => c.cx === 0 && c.cz === 120)!.buildings).toEqual(['bare']);
        expect(bare.chunks.every(c => [c.cx, c.cz, c.rect.x0, c.rect.z1, c.radiusM].every(Number.isFinite))).toBe(true)
        // the fast VMs take the largest building tasks (never a cell): the block before the east building
        expect([...fastChunkIndices(plan, 1)]).toEqual([tasks[0].index]);
        expect([...fastChunkIndices(plan, 5)].sort()).toEqual([tasks[0].index, tasks[1].index].sort());
        expect(fastChunkIndices(cellPlan, 3).size).toBe(0);
        expect(kdFastChunks({ SCRATCHBOX_KD_FAST_CHUNKS: '6' })).toBe(6);
        expect(kdFastChunks({})).toBe(0);
        // the switch
        expect(kdChunkUnit({ SCRATCHBOX_KD_CHUNK_UNIT: 'building' })).toBe('building');
        expect(kdChunkUnit({})).toBe('cell');
    });

    it('asks each chunk for its steps: the ground steps in a building plan\'s cells, and in the shown band no model at all', () => {
        const block = { id: 'block', centroid: [50, 0] as [number, number], loops: [rect(20, -10, 80, 10)] };
        const cells = planDistrictChunks(350, [block])!, tasks = planDistrictChunks(350, [block], DISTRICT_CHUNKS_PARAMS, 'building')!;
        const cell = tasks.chunks.find(c => c.centre)!, building = tasks.chunks.find(c => !isCellChunk(c))!;
        const asked = { 'remesh.facadeRead': true, 'polish.base': false };
        // the full band of a cell plan: the district's own steps, untouched
        expect(chunkSteps(cells, cells.chunks[0], asked, 'full')).toBe(asked);
        expect(chunkSteps(cells, cells.chunks[0], undefined, 'full')).toBeUndefined();
        // a building plan's cell: its ground steps over the district's; its building task: the district's
        expect(chunkSteps(tasks, cell, asked, 'full')).toEqual({ ...asked, ...KD_GROUND_CELL_STEPS });
        expect(chunkSteps(tasks, building, asked, 'full')).toBe(asked);
        // the shown band: no model, no material sets, no upscale, everywhere, over anything asked
        expect(chunkSteps(tasks, building, asked, 'shown')).toEqual({ ...asked, ...KD_SHOWN_STEPS, 'remesh.facadeRead': true });
        expect(chunkSteps(tasks, building, { models: true }, 'shown')!.models).toBe(false);
        expect(chunkSteps(tasks, cell, undefined, 'shown')).toEqual({ ...KD_GROUND_CELL_STEPS, ...KD_SHOWN_STEPS });
        expect(kdBand({ SCRATCHBOX_KD_BAND: 'shown' })).toBe('shown');
        expect(kdBand({})).toBe('full');
        // models off: every model client gone, the rest of the deps kept
        const deps = { cache: {}, vision: { client: {}, candidates: ['m'] }, groundedReferences: async () => ({}), pipelineI: {}, textures: { enhance: {}, lighting: {}, maxSide: 4096 }, elevations: async () => [] } as never;
        const off = withoutModels(deps) as unknown as Record<string, unknown>;
        expect(off.vision).toMatchObject({ unavailable: expect.stringContaining('models off') });
        expect(off.groundedReferences).toBeUndefined();
        expect(off.pipelineI).toBeUndefined();
        expect(off.textures).toEqual({ maxSide: 4096 });
        expect(off.cache).toBe((deps as unknown as Record<string, unknown>).cache);
        expect(off.elevations).toBe((deps as unknown as Record<string, unknown>).elevations);
    });

    it('plans whole every building the circle reaches, its middle past it or not, and leaves out one reaching too far', () => {
        // across the 350 m line: its middle at x 375, it reaches in to x 330 and out to 420
        const edge = { id: 'edge', centroid: [375, 0] as [number, number], loops: [rect(330, -10, 420, 10)] };
        // a rail yard reaching in to x 340 but out to 700: more than edgeGrowthM past the line
        const yard = { id: 'yard', centroid: [520, 30] as [number, number], loops: [rect(340, 20, 700, 40)] };
        // past the line altogether
        const far = { id: 'far', centroid: [500, 0] as [number, number], loops: [rect(490, -10, 510, 10)] };
        const plan = planDistrictChunks(350, [edge, yard, far])!;
        // the edge building is owned whole by the cell its nearest point (x 330) lies in, whose rectangle reaches its far end
        const cell = plan.chunks.find(c => c.cx === 360 && c.cz === 0)!;
        expect(cell.buildings).toEqual(['edge']);
        expect(cell.rect.x1).toBe(420 + DISTRICT_CHUNKS_PARAMS.marginM);
        const owner = chunkOwner(plan);
        expect(owner(400, 0)).toBe(cell.index);
        expect(owner(345, 0)).toBe(cell.index);
        // the yard is left out whole, with its reason: no chunk owns any of it, inside the circle or out
        expect(plan.chunks.some(c => c.buildings.includes('yard'))).toBe(false);
        expect(plan.leftOut?.map(b => b.id)).toEqual(['yard']);
        expect(plan.leftOut![0].reason).toMatch(/reaches 701 m from the centre, more than 100 m past the district's 350 m edge/);
        expect(owner(345, 30)).toBe(-1);
        expect(owner(345, 50)).toBe(plan.chunks.find(c => c.cx === 360 && c.cz === 0)!.index);
        // the far building is neither planned nor left out
        expect(plan.footprints.some(f => f.id === 'far')).toBe(false);
        expect(plan.leftOut!.some(f => f.id === 'far')).toBe(false);
    });

    it("places a chunk's frame in the district's exactly: a point of one is the same place on Earth in the other", () => {
        const here = { lat: 35.6595, lng: 139.7005, originEllipsoidalHeightM: 76.2 };
        // a chunk 240 m east and 120 m south of the centre, its own origin a little higher
        const g = scanToGeodetic({ lat: here.lat, lng: here.lng, heightMeters: here.originEllipsoidalHeightM }, 240, 0, 120);
        const chunk = { lat: g.lat, lng: g.lng, originEllipsoidalHeightM: 78.9 };
        const m = frameTransform(chunk, here);
        // the chunk's origin lands 240 m east, 120 m south, and about 2.7 m up (less the Earth's curve, a few millimetres)
        const o = transformPoint(m, 0, 0, 0);
        expect(o[0]).toBeCloseTo(240, 1);
        expect(o[2]).toBeCloseTo(120, 1);
        expect(o[1]).toBeCloseTo(2.7, 1);
        // there and back is where it started
        const back = frameTransform(here, chunk), p = transformPoint(m, 13, 5, -40), q = transformPoint(back, p[0], p[1], p[2]);
        expect(q[0]).toBeCloseTo(13, 6); expect(q[1]).toBeCloseTo(5, 6); expect(q[2]).toBeCloseTo(-40, 6);
    });

    it("joins a chunk's layer: placed in the district's frame and cut to what it owns, trees kept whole", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-join-'));
        // a 20 x 20 m ground of 1 m quads from x 0 to 20, and a "tree" (two triangles sharing an edge) straddling x = 10
        const ground: number[] = [];
        for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) ground.push(x, 0, z, x + 1, 0, z, x + 1, 0, z + 1, x, 0, z, x + 1, 0, z + 1, x, 0, z + 1);
        const g = path.join(dir, 'g.glb'), t = path.join(dir, 't.glb');
        writeStagedGlbFile(g, [{ name: 'ground', positions: Float32Array.from(ground), indices: Uint32Array.from({ length: ground.length / 3 }, (_, i) => i) }], {});
        writeStagedGlbFile(t, [{ name: 'tree', positions: Float32Array.from([9, 0, 5, 10.6, 0, 5, 10.6, 5, 5, 9, 5, 5]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) }], {});
        // the chunk sits 100 m east of the district's origin; the district keeps it only where x < 110
        const shift = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1]);
        const keep = (x: number) => x < 110;
        const r = joinChunkGlb(fs.readFileSync(g), shift, x => keep(x));
        expect(r.keptTriangles).toBe(10 * 20 * 2);
        expect(r.removedTriangles).toBe(10 * 20 * 2);
        // every kept triangle lies at x < 110 in the district's frame
        const out = parseGlbBytes(r.glb), world = nodeWorldMatrices(out.json);
        const ni = out.json.nodes.findIndex((n: any) => n.mesh !== undefined), prim = out.json.meshes[out.json.nodes[ni].mesh].primitives[0];
        const pos = readAccessor(out, prim.attributes.POSITION).data, idx = readAccessor(out, prim.indices).data;
        let maxX = -Infinity;
        for (let k = 0; k < idx.length; k++) maxX = Math.max(maxX, transformPoint(world[ni], pos[idx[k] * 3], pos[idx[k] * 3 + 1], pos[idx[k] * 3 + 2])[0]);
        expect(maxX).toBeLessThanOrEqual(110.0001);
        // baked: the vertices themselves are in the district's frame (the seam weld reads positions, not node transforms)
        expect(out.json.nodes.some((n: any) => n.matrix || n.translation)).toBe(false);
        expect(out.json.accessors[prim.attributes.POSITION].min[0]).toBeGreaterThanOrEqual(100);
        expect(maxX).toBeGreaterThan(109);
        // the tree's middle (x 9.8 + 100) is the chunk's: kept whole, though one corner reaches past x = 110
        const tree = joinChunkGlb(fs.readFileSync(t), shift, x => keep(x), { whole: true });
        expect(tree.keptTriangles).toBe(2);
        expect(tree.pieces).toEqual({ kept: 1, removed: 0 });
    });

    it('shares the machine between the builds running side by side, their limits scaled to match', () => {
        // 16 cores and memory for all: the centre and three chunks, four threads each, four times the time
        const big = 128 * 1024 ** 3;
        expect(chunkParallel(DISTRICT_CHUNKS_PARAMS, big)).toBe(3);
        try {
            machine.totalMem = big;
            expect(chunkCpuShare(16, DISTRICT_CHUNKS_PARAMS)).toMatchObject({ builds: 4, threads: 4, slowdown: 4 });
            // short of memory: fewer chunks at once, never none, and each build gets more of the cores
            expect(chunkParallel(DISTRICT_CHUNKS_PARAMS, 48 * 1024 ** 3)).toBe(1);
            expect(chunkParallel(DISTRICT_CHUNKS_PARAMS, 8 * 1024 ** 3)).toBe(1);
            machine.totalMem = 8 * 1024 ** 3;
            expect(chunkCpuShare(16, DISTRICT_CHUNKS_PARAMS)).toMatchObject({ builds: 2, threads: 8, slowdown: 2 });
            // never fewer than two threads a build
            expect(chunkCpuShare(4, DISTRICT_CHUNKS_PARAMS).threads).toBeGreaterThanOrEqual(2);
        } finally {
            machine.totalMem = 0;
        }
    });

    it("keeps the leaf tiles touching a chunk's rectangle, not those beside it", () => {
        const f = GoogleTileDistrictCrawler.localFrame(35.6595, 139.7005, 40);
        // a 20 m leaf box centred 50 m east and 30 m south (z south = -north) of the origin
        const box = (east: number, south: number) => {
            const c = [0, 1, 2].map(k => f.origin[k] + east * f.east[k] - south * f.north[k] + 5 * f.up[k]);
            return [...c, ...f.east.map(v => v * 10), ...f.north.map(v => v * 10), ...f.up.map(v => v * 10)];
        };
        const rect = { x0: 0, z0: 0, x1: 45, z1: 40 };
        expect(GoogleTileDistrictCrawler.footprintIntersectsRect(box(50, 30), f, rect)).toBe(true);
        expect(GoogleTileDistrictCrawler.footprintIntersectsRect(box(60, 30), f, rect)).toBe(false);
        expect(GoogleTileDistrictCrawler.footprintIntersectsRect(box(20, -15), f, rect)).toBe(false);
    });
});

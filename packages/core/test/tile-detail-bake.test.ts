/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tile detail bake (tile-detail-bake.ts) and its tool on the synthetic scan (helpers/synthetic-material-scan.ts):
 * the matching facade's atlas is replaced and labelled generated, the unmatched roof and every geometry buffer stay byte
 * for byte, a staged twin's provenance gains the entry, and an empty library changes nothing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { bakeTileDetail, detailBakeProvenance, TILE_DETAIL_BAKE_VERSION, type TileDetailBakeReport } from '../src/node/spatial/tile-detail-bake';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { createTileDetailBakeHandler, TILE_DETAIL_BAKE_TOOL_DECLARATION } from '../src/node/gemini/tools/surface-material-tools';
import { BUILD_STEPS, TOGGLEABLE_STEPS } from '../src/common/staged-build-steps';
import { syntheticMaterialScan } from './helpers/synthetic-material-scan';
import { buildPlaneClusters, loadBaseScan, mergeCoplanarClusters } from '../src/node/spatial/MaterialDetailBaker';
import { GltfBinaryPacker } from '../src/node/3d-engine/gltf-binary-packer';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-detailbake-'));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function view(glb: Buffer, index: number): Buffer {
    const { json, bin } = AlgorithmicUvEngine.parseGlb(glb);
    const v = json.bufferViews[index];
    return Buffer.from(bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength));
}
const imageView = (glb: Buffer, image: number) => AlgorithmicUvEngine.parseGlb(glb).json.images[image].bufferView as number;

describe('tile detail bake', () => {
    let scan: { glbPath: string; libraryPath: string };
    let out: { glb: Buffer; report: TileDetailBakeReport };
    const twinProvenance = [{ source: 'tile-refine', label: 'photo-inferred', method: 'de-lit photo', coverage: 1 }];
    let twin: { glb: Buffer; report: TileDetailBakeReport };

    beforeAll(async () => {
        scan = await syntheticMaterialScan(path.join(WORK, 'plain'));
        out = await bakeTileDetail({ glb: scan.glbPath, libraryPath: scan.libraryPath, workDir: path.join(WORK, 'plain', 'bake') });
        const t = await syntheticMaterialScan(path.join(WORK, 'twin'), { sbTexture: { schema: 'scratchbox.staged-texture/1', provenance: twinProvenance } });
        twin = await bakeTileDetail({ glb: fs.readFileSync(t.glbPath), libraryPath: t.libraryPath, workDir: path.join(WORK, 'twin', 'bake') });
    }, 170_000);

    it('replaces the matching facade atlas only and labels it generated', () => {
        expect(out.report.version).toBe(TILE_DETAIL_BAKE_VERSION);
        expect(out.report.replaced).toBe(1);
        const facade = out.report.perImage.find(i => i.image === 0)!;
        expect(facade.replaced).toBe(true);
        expect(facade.scale).toBeGreaterThanOrEqual(2);
        expect(facade.sharpnessRatio!).toBeGreaterThan(1.1);
        expect(out.report.coverage).toBeGreaterThan(0.2);
        expect(out.report.coverage).toBeLessThanOrEqual(1);
        const { json } = AlgorithmicUvEngine.parseGlb(out.glb);
        expect(json.images[0].extras.sbDetailBake).toMatchObject({ label: 'generated', version: TILE_DETAIL_BAKE_VERSION });
        expect(json.images[0].extras.sbDetailBake.materials).toContain('synthetic ashlar');
        expect(json.images[1].extras?.sbDetailBake).toBeUndefined();
        expect(json.asset.extras.sbDetailBake).toMatchObject({ label: 'generated', images: [0] });
    });

    it('keeps the roof atlas and every geometry buffer byte for byte', () => {
        const before = fs.readFileSync(scan.glbPath);
        expect(sha(view(out.glb, imageView(out.glb, 1)))).toBe(sha(view(before, imageView(before, 1))));
        const { json } = AlgorithmicUvEngine.parseGlb(before);
        for (const a of json.accessors) expect(sha(view(out.glb, a.bufferView))).toBe(sha(view(before, a.bufferView)));
        // the facade atlas grew (2x or 4x)
        expect(view(out.glb, imageView(out.glb, 0)).length).not.toBe(view(before, imageView(before, 0)).length);
    });

    it('adds the bake to a staged twin\'s texture provenance', () => {
        const prov = AlgorithmicUvEngine.parseGlb(twin.glb).json.asset.extras.sbTexture.provenance;
        expect(prov).toHaveLength(2);
        expect(prov[0]).toEqual(twinProvenance[0]);
        expect(prov[1]).toMatchObject({ source: 'tile-detail-bake', label: 'generated' });
        expect(prov[1].coverage).toBeCloseTo(twin.report.coverage, 3);
        expect(detailBakeProvenance(twin.report)).toMatchObject(prov[1]);
    });

    it('changes nothing when the library holds no swatch', async () => {
        const empty = path.join(WORK, 'empty_library.json');
        fs.writeFileSync(empty, JSON.stringify({ version: 1, createdAt: '', segmentation: { model: 'none', promptVersion: 1 }, samples: [], rejected: [] }));
        const r = await bakeTileDetail({ glb: scan.glbPath, libraryPath: empty });
        expect(sha(r.glb)).toBe(sha(fs.readFileSync(scan.glbPath)));
        expect(r.report.replaced).toBe(0);
        expect(r.report.skipped).toMatch(/no usable swatch/);
    });

    it('the tool bakes a given library and publishes the result under /models', async () => {
        const modelsDir = path.join(WORK, 'models');
        const handler = createTileDetailBakeHandler({ modelsDir });
        const r: any = await handler({ glbPath: scan.glbPath, libraryPath: scan.libraryPath, outputDir: path.join(WORK, 'tool') }, {} as never);
        expect(r.resultPayload.report.replaced).toBe(1);
        expect(r.resultPayload.provenance.label).toBe('generated');
        expect(r.resultPayload.published.url).toMatch(/^\/models\/base_detail_\d+\.glb$/);
        const published = fs.readFileSync(r.resultPayload.published.path);
        expect(published.readUInt32LE(0)).toBe(0x46546c67); // glTF magic
        expect(AlgorithmicUvEngine.parseGlb(published).json.images[0].extras.sbDetailBake.label).toBe('generated');
        expect(r.summaryResult).toMatch(/1 of 2 atlases/);
        expect(TILE_DETAIL_BAKE_TOOL_DECLARATION.parameters.required).toEqual(['glbPath']);
    }, 120_000);

    it('is a switchable step of the textures stage', () => {
        expect(BUILD_STEPS.find(s => s.key === 'twin.detailBake')?.stage).toBe('textures');
        expect(TOGGLEABLE_STEPS.has('twin.detailBake')).toBe(true);
    });

    it('joins coplanar fragments of one wall across a gap, never a wall facing another way', () => {
        // three quads: two on z = 0 a metre apart (one wall broken by a scan gap) and one on x = 0 (a side wall)
        const quads = [[[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]], [[5, 0, 0.05], [9, 0, 0.05], [9, 4, 0.05], [5, 4, 0.05]], [[0, 0, 0], [0, 0, -4], [0, 4, -4], [0, 4, 0]]];
        const positions = quads.flat(2), indices = quads.flatMap((_, q) => [0, 1, 2, 0, 2, 3].map(i => i + q * 4));
        const pos = Buffer.from(new Float32Array(positions).buffer), idx = Buffer.from(new Uint32Array(indices).buffer);
        const glb = GltfBinaryPacker.packGlb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 12, type: 'VEC3', min: [0, 0, -4], max: [9, 4, 0.05] }, { bufferView: 1, componentType: 5125, count: 18, type: 'SCALAR' }],
            bufferViews: [{ buffer: 0 }, { buffer: 0 }] }, [pos, idx], true).glbBuffer;
        const p = path.join(WORK, 'walls.glb');
        fs.writeFileSync(p, glb);
        const grown = buildPlaneClusters(loadBaseScan(p));
        expect(grown.clusters).toHaveLength(3);
        const m = mergeCoplanarClusters(grown.triCluster, grown.clusters);
        expect(m.clusters).toHaveLength(2);
        expect(m.merged).toBe(1);
        expect(m.triCluster[0]).toBe(m.triCluster[2]); // the two halves of the broken wall
        expect(m.triCluster[4]).not.toBe(m.triCluster[0]); // the side wall
        const wall = m.clusters[m.triCluster[0]];
        expect(wall.area).toBeCloseTo(32, 3);
        expect(Math.abs(wall.normal[2])).toBeCloseTo(1, 3);
    });

    it('keeps an atlas whose detail would cover less than the minimum share of it', async () => {
        const r = await bakeTileDetail({ glb: scan.glbPath, libraryPath: scan.libraryPath, workDir: path.join(WORK, 'mincov'), bake: { minCoverageFraction: 0.99 } });
        expect(r.report.replaced).toBe(0);
        expect(r.report.perImage.find(i => i.image === 0)?.reason).toMatch(/detail covers .*% of the atlas/);
        expect(sha(r.glb)).toBe(sha(fs.readFileSync(scan.glbPath)));
    }, 120_000);

    it('refuses to harvest swatches from untextured tiles before any model call', async () => {
        const { subjectSwatchLibrary } = await import('../src/node/spatial/tile-detail-bake');
        const clay = path.join(WORK, 'clay.glb');
        fs.writeFileSync(clay, GltfBinaryPacker.packGlb({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }, [], true).glbBuffer);
        let called = 0;
        const services = { segmenter: () => { called++; return async () => ({ materials: [], quads: [] }) as never; } };
        await expect(subjectSwatchLibrary({ tilesGlb: clay, lat: 0, lng: 0, place: 'x', workDir: path.join(WORK, 'clayharvest'), services })).rejects.toThrow(/no photo textures/);
        expect(called).toBe(0);
    });
});


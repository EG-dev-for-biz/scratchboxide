/**
 * The texture pass's degrade ladder for one layer (texture-pass.ts textureLayer), end to end on a clay facade GLB with
 * a fitted chart: Street View projection -> tile photo transfer -> (model enhancement) -> measured palette -> clay, each
 * source killed in turn. No network, no model: views are rendered analytically, the tile is a synthetic photo GLB, the
 * model client is a stub. Every texel is labelled (provenance covers 100 percent), nothing is made up, and the
 * textured twin is a valid GLB with TEXCOORD_0 on every vertex.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import { TEXTURE_LADDER_RUNGS, TEXTURE_RUNG_CLAY, type ProjectionView } from '../src/common/spatial/texture-pass-contracts';
import { writeStagedGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { textureLayer, type PaletteFace, type TexturePassSources } from '../src/node/3d-engine/staged-location/texture-pass';
import { loadTileSurface } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import type { EnhanceModelClient } from '../src/node/3d-engine/staged-location/texture-enhance';
import { FACADE, facadeViews } from './helpers/texture-pass-fixtures';
import { buildTileGlb, facadeTileSheet } from './helpers/tile-photo-glb';

/** The facade as a clay layer: a 10 x 6 grid facing -z, one node on chart s00. */
function clayFacade(): { glb: Buffer; surfaces: Array<{ id: string; chart: any }> } {
    const nx = 10, ny = 6, pos: number[] = [], idx: number[] = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) pos.push((FACADE.widthM * i) / nx, (FACADE.heightM * j) / ny, 0);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx.push(a, c, b, b, c, d); // wound to face -z
    }
    const glb = writeStagedGlb([{ name: 's00', positions: Float32Array.from(pos), indices: Uint32Array.from(idx), extras: { sb: { schema: 'scratchbox.staged-node/2', stage: 'fit', ids: { surfaceId: 's00' } } } }], { rootExtras: { sb: { stage: 'fit' } } });
    const surfaces = [{ id: 's00', chart: { plane: { origin: FACADE.origin, u: FACADE.u, v: FACADE.v, normal: FACADE.normal, extentUv: [[0, 0], [FACADE.widthM, 0], [FACADE.widthM, FACADE.heightM], [0, FACADE.heightM]] } } }];
    return { glb, surfaces };
}

const occluder = () => {
    // the facade itself, as a render mesh
    const nx = 10, ny = 6, v: number[] = [], i: number[] = [];
    for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) v.push((FACADE.widthM * x) / nx, (FACADE.heightM * y) / ny, 0);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const a = y * (nx + 1) + x; i.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2); }
    return { vertices: Float32Array.from(v), indices: Uint32Array.from(i) };
};

const views = (): ProjectionView[] => facadeViews().map(v => ({ ...v, poseQuality: 1, poseSigmaPx: 0 }));
const PALETTE: PaletteFace[] = [{ headingDeg: 180, colours: [{ srgb: [182, 170, 150] as Vec3, share: 0.7 }, { srgb: [90, 80, 70] as Vec3, share: 0.3 }] }];

function sources(over: Partial<TexturePassSources> = {}): TexturePassSources {
    return {
        views: views(), occluder: occluder(), tile: loadTileSurface(buildTileGlb([facadeTileSheet(0.05)])), palette: PALETTE,
        densityTexelsPerMeter: 8, maxSide: 256, ...over
    };
}

function checkTwin(glb: Buffer): void {
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    const g = parseGlbBytes(glb);
    for (const mesh of g.json.meshes) for (const p of mesh.primitives) {
        expect(p.attributes.TEXCOORD_0).toBeDefined();
        expect(g.json.accessors[p.attributes.TEXCOORD_0].count).toBe(g.json.accessors[p.attributes.POSITION].count);
    }
    expect(g.json.images.length).toBeGreaterThanOrEqual(2);
}

function checkLabels(out: Awaited<ReturnType<typeof textureLayer>>): void {
    // every texel labelled: provenance coverage and rung shares each sum to 1
    expect(out.bundle.provenance.reduce((a, p) => a + p.coverage, 0)).toBeCloseTo(1, 6);
    expect(out.rungShares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(out.rungShares.length).toBe(TEXTURE_LADDER_RUNGS.length);
    for (const p of out.bundle.provenance) {
        expect(p.label).not.toBe('');
        if (p.source !== 'clay') expect(p.label).toBe('photo-inferred');
        expect(p.source).not.toBe('generated-pbr');
    }
}

describe('texture pass ladder (one layer)', () => {
    it('all sources: Street View projects most texels (multi-view first), the tile fills the rest, labelled photo-inferred', async () => {
        const c = clayFacade();
        const out = await textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, sources());
        checkTwin(out.glb);
        checkLabels(out);
        // the three views see 84 percent of the facade (two corners are out of frame); the tile colours the rest
        expect(out.rungShares[0] + out.rungShares[1]).toBeGreaterThan(0.8);
        expect(out.rungShares[0]).toBeGreaterThan(0.7);
        expect(out.rungShares[2]).toBeGreaterThan(0.1);
        expect(out.rungShares[TEXTURE_RUNG_CLAY]).toBe(0);
        expect(out.bundle.ladderRung).toBe(2); // the worst rung above 10 percent
        expect(out.degradations.find(d => d.reasonCode === 'no_view_sees_texel')).toBeDefined();
        expect(out.projection!.maxSeamDeltaE).toBeLessThan(3);
        expect(out.projection!.views).toBe(3);
        // the cache record carries the bake report the live findings read: output seam, region blend, alignment, timings
        expect(out.projection!.outputSeam.samples).toBeGreaterThanOrEqual(0);
        expect(out.projection!.timingsMs.total).toBeGreaterThan(0);
        expect(out.projection!.alignment?.nccAfter ?? 0).toBeGreaterThanOrEqual(-1);
        expect(out.degradations.some(d => d.reasonCode === 'generated_pbr_not_available')).toBe(false);
        expect(out.degradations.find(d => d.reasonCode === 'enhance_not_run')).toBeUndefined(); // not asked for here
    });

    it('no Street View: the de-lit tile photo transfer takes the layer (rung 2), with the real reason recorded', async () => {
        const c = clayFacade();
        const out = await textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, sources({ views: [], viewsUnavailable: 'the Street View stage was skipped' }));
        checkTwin(out.glb);
        checkLabels(out);
        expect(out.rungShares[2]).toBeGreaterThan(0.95);
        expect(out.bundle.ladderRung).toBe(2);
        const d = out.degradations.find(x => x.reasonCode === 'no_street_view')!;
        expect(d.reason).toContain('the Street View stage was skipped');
        expect(out.bundle.provenance.find(p => p.coverage > 0.5)!.source).toBe('tile-photo-transfer');
    });

    it('no Street View, no tile: the flat measured palette colour (rung 4); generated PBR is recorded as not available', async () => {
        const c = clayFacade();
        const out = await textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, sources({ views: [], tile: undefined, tileUnavailable: 'tile fetch failed (HTTP 503)' }));
        checkTwin(out.glb);
        checkLabels(out);
        expect(out.rungShares[3]).toBe(0); // no real texels exist to detect a repeat from
        expect(out.rungShares[4]).toBeCloseTo(1, 6);
        expect(out.rungShares[5]).toBe(0); // the generated rung is never used
        expect(out.degradations.find(x => x.reasonCode === 'no_tile_photo')!.reason).toContain('HTTP 503');
        const pbr = out.degradations.find(x => x.reasonCode === 'generated_pbr_not_available')!;
        expect(pbr).toMatchObject({ fromRung: 5, toRung: 4 });
        expect(pbr.texelShare).toBeCloseTo(1, 6);
        expect(pbr.reason).toMatch(/pbr_synthesize_material is not used/);
        // the colour is the measured palette's top colour of the face it looks toward 
        const p = out.bundle.provenance.find(x => x.source === 'measured-palette')!;
        expect(p.label).toBe('photo-inferred');
        expect(p.coverage).toBeCloseTo(1, 6);
    });

    it('no source at all: clay (the floor rung), labelled clay, never invented', async () => {
        const c = clayFacade();
        const out = await textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, sources({ views: [], tile: undefined, palette: [] }));
        checkTwin(out.glb);
        checkLabels(out);
        expect(out.rungShares[TEXTURE_RUNG_CLAY]).toBeCloseTo(1, 6);
        expect(out.bundle.ladderRung).toBe(TEXTURE_RUNG_CLAY);
        expect(out.degradations.find(x => x.reasonCode === 'no_palette')).toBeDefined();
        expect(out.bundle.provenance.filter(p => p.coverage > 0).map(p => p.source)).toEqual(['clay']);
    });

    it('a failing projection drops to the tile; a throwing model leaves the tile transfer unenhanced', async () => {
        const c = clayFacade();
        const broken = views().map(v => ({ ...v, image: { ...v.image, rgba: new Uint8Array(4) } })); // the image is not its size
        let calls = 0;
        const throwing: EnhanceModelClient = async () => { calls++; throw new Error('model quota exceeded'); };
        const out = await textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, sources({ views: broken, enhance: { client: throwing, models: ['stub-image-model'] } }));
        checkTwin(out.glb);
        checkLabels(out);
        // every view's image is rejected (never sampled out of bounds); the tile holds the layer
        expect(out.degradations.filter(d => d.reasonCode === 'pano_image_invalid').length).toBe(3);
        expect(out.rungShares[2]).toBeGreaterThan(0.95);
        expect(calls).toBeGreaterThan(0);
        expect(out.bundle.provenance.some(p => p.source === 'tile-photo-enhanced' && p.coverage > 0)).toBe(false);
        expect(out.degradations.some(d => d.stage === 'enhance')).toBe(true);
        expect(out.modelsUsed).toEqual([]);
    });
});

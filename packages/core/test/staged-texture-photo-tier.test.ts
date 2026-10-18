/**
 * Photo tier A (photo-tier-rectify.ts + python/photo_tier/face_rectify.py) on a synthetic planar facade with a repeated
 * coursing, a statue standing proud of it and a van in front: photos ray cast through the grounding camera (fx = 960 /
 * tan(fov/2) at the delivered crop) from the true poses, handed over with the registration residual the joint registration
 * leaves (a few cm, a few hundredths of a degree). Checks: every view is placed by its registered pose (one pose set); the
 * rectified texels sit on the true texture within one texel; the van seen by one view at a time is dropped by the median;
 * the statue (1.2 m proud) is left to the rungs below with its deviation measured; provenance; the held-out score; single-pano
 * pixels that look like sky, foliage or not like the tile are not written; the tier is de-lit and matched in exposure to the
 * ladder below; its single-pano texels never replace the projection's; the cache makes a re-run cheap; the fallbacks (an
 * unmatched old pano, no worker, no planar face). No network, no model.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import type { BakedTexturePlanes, ProjectionView } from '../src/common/spatial/texture-pass-contracts';
import { createPhotoTierCache, mergePhotoTier, rectifyPhotoTier, PHOTO_TIER_SOURCE, type PhotoTierResult } from '../src/node/3d-engine/staged-location/photo-tier-rectify';
import { packConfidenceTexel, unpackConfidenceTexel } from '../src/common/spatial/texture-pass-contracts';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { writeStagedGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { textureLayer } from '../src/node/3d-engine/staged-location/texture-pass';
import {
    blurredTile, OLD_PANO, PANOS, panoViews, sceneMesh, STATUE, VAN, VAN_RGB, WALL, WALL_SURFACES, wallAlbedoBox, wallAtlas, type RenderedView
} from './helpers/photo-tier-fixtures';

const DENSITY = 30;
const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots');

let cache: { rendered: RenderedView[]; old: RenderedView[] } | undefined;
function scene() {
    if (!cache) cache = { rendered: PANOS.flatMap(p => panoViews(p, { van: true })), old: panoViews(OLD_PANO, { van: true }) };
    return cache;
}

/** The ladder below as it would be from a misregistered projection: the true texture shifted 0.25 m right and 0.12 m up. */
function previousPlanes(atlas: ReturnType<typeof wallAtlas>): BakedTexturePlanes {
    const n = atlas.width * atlas.height, albedo = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        const p = atlas.texels.position;
        const c = wallAlbedoBox(p[i * 3] - WALL.x0 - 0.25, p[i * 3 + 1] - WALL.y0 - 0.12, 1 / DENSITY);
        albedo.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], i * 4);
    }
    return { layerKey: 'l3b', width: atlas.width, height: atlas.height, albedo, confidence: { width: atlas.width, height: atlas.height, data: new Uint8Array(n * 4) }, provenance: [], degradations: [] };
}

function savePlanes(name: string, atlas: ReturnType<typeof wallAtlas>, planes: BakedTexturePlanes): void {
    fs.mkdirSync(SHOTS, { recursive: true });
    const rgba = Buffer.from(planes.albedo);
    for (let i = 0; i < atlas.width * atlas.height; i++) if (!rgba[i * 4 + 3]) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255; }
    fs.writeFileSync(path.join(SHOTS, `staged_texture_photo_tier_${name}.png`), encodePng(atlas.width, atlas.height, rgba, 4));
}

/** Texel -> wall coordinates. */
const wallAB = (atlas: ReturnType<typeof wallAtlas>, i: number): [number, number] => [atlas.texels.position[i * 3] - WALL.x0, atlas.texels.position[i * 3 + 1] - WALL.y0];

/** Best in-plane shift (m) of the written texels against the true texture, and the mean abs error at it. */
function registration(atlas: ReturnType<typeof wallAtlas>, planes: BakedTexturePlanes, keep: (a: number, b: number) => boolean): { du: number; dv: number; err: number; samples: number } {
    const picks: number[] = [];
    for (let i = 0; i < atlas.width * atlas.height; i += 7) {
        if (!planes.albedo[i * 4 + 3]) continue;
        const [a, b] = wallAB(atlas, i);
        if (a < 0.3 || a > 11.7 || b < 0.3 || b > 8.7 || !keep(a, b)) continue;
        picks.push(i);
    }
    const s = 1 / DENSITY;
    const errAt = (du: number, dv: number) => {
        let e = 0;
        for (const i of picks) {
            const [a, b] = wallAB(atlas, i); const t = wallAlbedoBox(a + du, b + dv, s);
            e += Math.abs(planes.albedo[i * 4] - t[0]) + Math.abs(planes.albedo[i * 4 + 1] - t[1]) + Math.abs(planes.albedo[i * 4 + 2] - t[2]);
        }
        return e / (3 * Math.max(1, picks.length));
    };
    let best = { du: 0, dv: 0, err: Infinity };
    for (let du = -3 * s; du <= 3 * s + 1e-9; du += s / 4) for (let dv = -3 * s; dv <= 3 * s + 1e-9; dv += s / 4) {
        const e = errAt(du, dv); if (e < best.err) best = { du, dv, err: e };
    }
    return { ...best, samples: picks.length };
}

const inStatue = (a: number, b: number, m = 0.25) => a + WALL.x0 > STATUE.x0 - m && a + WALL.x0 < STATUE.x1 + m && b < STATUE.y1 + m;

let main: PhotoTierResult | undefined;
async function runMain(): Promise<{ res: PhotoTierResult; atlas: ReturnType<typeof wallAtlas>; views: ProjectionView[] }> {
    const atlas = wallAtlas(DENSITY);
    const s = scene();
    const views = [...s.rendered, ...s.old].map(r => r.view);
    if (!main) {
        main = await rectifyPhotoTier({ atlas, surfaces: WALL_SURFACES, views, context: sceneMesh(), previous: previousPlanes(atlas), tile: blurredTile(), densityTexelsPerMeter: DENSITY });
        savePlanes('main', atlas, main.planes);
        if (process.env.PT_DEBUG) { const t = previousPlanes(atlas); for (let i = 0; i < atlas.width * atlas.height; i++) { const [a, b] = wallAB(atlas, i); const c = wallAlbedoBox(a, b, 1 / DENSITY); t.albedo.set([c[0], c[1], c[2], 255].map(Math.round), i * 4); } savePlanes('truth', atlas, t); }
        if (process.env.PT_DEBUG) fs.writeFileSync(process.env.PT_DEBUG + '.cams.json', JSON.stringify([...s.rendered, ...s.old].map(r => r.trueCamera)));
        if (process.env.PT_DEBUG) fs.writeFileSync(process.env.PT_DEBUG, JSON.stringify({ facades: main.worker!.facades, record: main.record, charts: main.worker!.charts, reg: registration(atlas, main.planes, (a, b) => !inStatue(a, b, 1)), degradations: main.degradations }, null, 1));
    }
    return { res: main, atlas, views };
}

describe('photo tier A: rectified Street View on fitted planar faces', () => {
    it('places every view by its registered pose (one pose set with the projection), the reference pano the one with most views', async () => {
        const { res } = await runMain();
        const f = res.worker!.facades[0];
        expect(f.skipped).toBeUndefined();
        expect(PANOS.map(p => p.panoId)).toContain(f.reference!);
        const placements = Object.values(f.views).map(v => v.placement);
        expect(placements.length).toBeGreaterThanOrEqual(PANOS.length * 3);
        for (const p of placements) expect(p).toBe('registered pose');
        // nothing re-anchors a view on its own: no outline anchor, no cross-pano homography
        expect(res.degradations.some(d => /anchor/.test(d.reasonCode))).toBe(false);
    }, 240_000);

    it('puts the rectified texels on the true texture within one texel', async () => {
        const { res, atlas } = await runMain();
        expect(res.record.texelShare).toBeGreaterThan(0.75);
        expect(res.record.multiViewShare).toBeGreaterThan(0.6);
        const r = registration(atlas, res.planes, (a, b) => !inStatue(a, b, 1));
        expect(r.samples).toBeGreaterThan(1000);
        expect(Math.hypot(r.du, r.dv)).toBeLessThanOrEqual(1 / DENSITY + 1e-9);
        expect(r.err).toBeLessThan(18);
    }, 240_000);

    it('drops the van, which each view sees in front of a different part of the wall (per-pixel median)', async () => {
        const { res, atlas } = await runMain();
        // the van is in the photos (it hides the lower left of the wall from each view)
        const wide = scene().rendered.filter(r => r.kind === 'wide');
        const vanPx = wide.map(r => { let c = 0; const g = r.view.image.rgba; for (let i = 0; i < g.length; i += 4) if (Math.abs(g[i] - VAN_RGB[0]) + Math.abs(g[i + 1] - VAN_RGB[1]) + Math.abs(g[i + 2] - VAN_RGB[2]) < 30) c++; return c; });
        expect(vanPx.every(c => c > 500)).toBe(true);
        let written = 0, van = 0;
        for (let i = 0; i < atlas.width * atlas.height; i++) {
            const [a, b] = wallAB(atlas, i);
            if (b > 1.4 || a + WALL.x0 > 1 || !res.planes.albedo[i * 4 + 3]) continue;
            written++;
            const d = Math.abs(res.planes.albedo[i * 4] - VAN_RGB[0]) + Math.abs(res.planes.albedo[i * 4 + 1] - VAN_RGB[1]) + Math.abs(res.planes.albedo[i * 4 + 2] - VAN_RGB[2]);
            if (d < 60) van++;
        }
        expect(written).toBeGreaterThan(2000);
        expect(van / written).toBeLessThan(0.01);
        void VAN;
    }, 240_000);

    it('leaves the statue (1.2 m proud of the face) to the rungs below and records the measured deviation', async () => {
        const { res, atlas } = await runMain();
        let inside = 0, writtenInside = 0;
        for (let i = 0; i < atlas.width * atlas.height; i++) {
            const [a, b] = wallAB(atlas, i);
            if (!inStatue(a, b, -0.05)) continue;
            inside++; if (res.planes.albedo[i * 4 + 3]) writtenInside++;
        }
        expect(inside).toBeGreaterThan(2000);
        expect(writtenInside).toBe(0);
        const d = res.degradations.find(x => x.reasonCode === 'photo_tier_non_planar');
        expect(d).toBeDefined();
        expect(d!.reason).toMatch(/non-planar region: photo tier needs better geometry/);
        expect(res.record.nonPlanar!.p90DeviationM).toBeGreaterThan(1.0);
        expect(res.record.nonPlanar!.maxDeviationM).toBeLessThan(1.4);
        expect(res.record.nonPlanar!.texelShare).toBeGreaterThan(0.03);
    }, 240_000);

    it('labels every texel it writes street-view-rectified, photo-inferred, with pano ids and capture dates', async () => {
        const { res, atlas } = await runMain();
        expect(res.planes.provenance.length).toBeGreaterThan(0);
        for (const p of res.planes.provenance) {
            expect(p.source).toBe(PHOTO_TIER_SOURCE);
            expect(p.label).toBe('photo-inferred');
            expect(p.panoIds!.length).toBeGreaterThan(1);
            expect(p.captureDates!.length).toBe(p.panoIds!.length);
        }
        const all = new Set(res.planes.provenance.flatMap(p => p.panoIds!));
        for (const p of PANOS) expect(all.has(p.panoId)).toBe(true);
        let written = 0;
        for (let i = 0; i < atlas.width * atlas.height; i++) if (res.planes.albedo[i * 4 + 3]) { written++; const r = res.planes.confidence.data[i * 4 + 2]; expect(r === 0 || r === 1).toBe(true); }
        expect(res.planes.provenance.reduce((s, p) => s + p.coverage, 0)).toBeCloseTo(written / (atlas.width * atlas.height), 6);
    }, 240_000);

    it('scores tile, previous ladder and photo tier A against a held-out pano on the same pixels', async () => {
        const { res } = await runMain();
        const ho = res.record.heldOut!;
        expect(ho).toBeDefined();
        expect(ho.panoIds.length).toBeGreaterThan(0);
        const { tile, previous, photoA } = ho.methods;
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'staged_texture_photo_tier_held_out.json'), JSON.stringify(ho, null, 1));
        expect(photoA.pixels).toBeGreaterThan(5000);
        expect(photoA.pixels).toBe(previous.pixels);
        expect(photoA.heldOutGradNcc!).toBeGreaterThan(0.3);
        expect(photoA.heldOutGradNcc!).toBeGreaterThan(previous.heldOutGradNcc! + 0.2);
        // the synthetic tile is the true texture blurred, exactly in place: its few edges are the strongest joints, on the held-out
        // photo's own (median 0 px); the tier's many edges lie within a pixel of the photo's
        expect(photoA.heldOutChamferMedianPx!).toBeLessThanOrEqual(tile.heldOutChamferMedianPx! + 1);
        expect(photoA.geoChamferMedianPx!).toBeLessThanOrEqual(tile.geoChamferMedianPx!);
        expect(photoA.heldOutChamferMedianPx!).toBeLessThanOrEqual(previous.heldOutChamferMedianPx!);
        expect(photoA.laplacianVar!).toBeGreaterThan(tile.laplacianVar!);
    }, 240_000);

    it('outvotes an old pano whose stones do not match: the texels it would change stay on the current stones', async () => {
        const { res, atlas } = await runMain();
        // placed by its pose, its warp lines up with the others' coursing; its different stones are a minority at every pixel
        const without = await rectifyPhotoTier({ atlas, surfaces: WALL_SURFACES, views: scene().rendered.map(r => r.view), context: sceneMesh(), previous: previousPlanes(atlas), tile: blurredTile(), densityTexelsPerMeter: DENSITY, heldOut: false });
        let d = 0, c = 0;
        for (let i = 0; i < atlas.width * atlas.height; i++) {
            if (!res.planes.albedo[i * 4 + 3] || !without.planes.albedo[i * 4 + 3]) continue;
            const [a, b] = wallAB(atlas, i);
            if (inStatue(a, b, 1)) continue;
            for (let k = 0; k < 3; k++) d += Math.abs(res.planes.albedo[i * 4 + k] - without.planes.albedo[i * 4 + k]);
            c += 3;
        }
        expect(c).toBeGreaterThan(30_000);
        expect(d / c).toBeLessThan(4);
        const r = registration(atlas, res.planes, (a, b) => !inStatue(a, b, 1));
        expect(r.err).toBeLessThan(18);
    }, 240_000);

    it('degrades when the worker cannot run or the layer has no planar face', async () => {
        const atlas = wallAtlas(DENSITY);
        const views = scene().rendered.map(r => r.view);
        const noWorker = await rectifyPhotoTier({ atlas, surfaces: WALL_SURFACES, views, context: sceneMesh(), densityTexelsPerMeter: DENSITY, pythonExecutable: '/nonexistent/python3' });
        expect(noWorker.degradations.some(d => d.reasonCode === 'photo_tier_failed')).toBe(true);
        expect(noWorker.planes.albedo.some((v, i) => i % 4 === 3 && v > 0)).toBe(false);
        const noPlane = await rectifyPhotoTier({ atlas, surfaces: [], views, context: sceneMesh(), densityTexelsPerMeter: DENSITY });
        expect(noPlane.degradations.some(d => d.reasonCode === 'photo_tier_no_planar_face')).toBe(true);
    }, 240_000);
});

describe('photo tier A: single-pano texels, de-light and exposure, merge, cache', () => {
    const FOLIAGE: Vec3 = [62, 104, 40], SKYPATCH: Vec3 = [120, 168, 230], PALE: Vec3 = [236, 236, 236];
    const patches = [
        { a0: 1.0, a1: 3.0, b0: 4.0, b1: 6.5, rgb: FOLIAGE },
        { a0: 5.0, a1: 6.6, b0: 6.0, b1: 8.0, rgb: SKYPATCH },
        { a0: 8.0, a1: 9.6, b0: 4.0, b1: 6.0, rgb: PALE }
    ];
    const inPatch = (a: number, b: number, m = 0.2) => patches.some(q => a > q.a0 - m && a < q.a1 + m && b > q.b0 - m && b < q.b1 + m);

    it('writes single-pano pixels only where they look like the face: not sky, not foliage, not off the tile', async () => {
        const atlas = wallAtlas(DENSITY);
        // one pano: nothing can outvote what stands in front of the face in its photos
        const views = panoViews(PANOS[1], { paint: patches }).map(r => r.view);
        const res = await rectifyPhotoTier({ atlas, surfaces: WALL_SURFACES, views, context: sceneMesh({ statue: false }), tile: blurredTile(), densityTexelsPerMeter: DENSITY, heldOut: false });
        savePlanes('single_pano_occluders', atlas, res.planes);
        const occ = res.record.occluderCheck!;
        expect(occ.singlePx).toBeGreaterThan(10_000);
        expect(occ.vegetation).toBeGreaterThan(500);
        expect(occ.sky).toBeGreaterThan(500);
        expect(occ.tile).toBeGreaterThan(500);
        let patchTexels = 0, patchWritten = 0, clean = 0, cleanWritten = 0;
        for (let i = 0; i < atlas.width * atlas.height; i++) {
            const [a, b] = wallAB(atlas, i);
            if (a < 0.4 || a > 11.6 || b < 0.4 || b > 8.6) continue;
            const w = res.planes.albedo[i * 4 + 3] > 0;
            if (inPatch(a, b, -0.05)) { patchTexels++; if (w) patchWritten++; } else if (!inPatch(a, b, 0.6)) { clean++; if (w) cleanWritten++; }
        }
        expect(patchWritten / patchTexels).toBeLessThan(0.02);
        expect(cleanWritten / clean).toBeGreaterThan(0.6);
        for (let i = 0; i < atlas.width * atlas.height; i++) if (res.planes.albedo[i * 4 + 3]) expect(res.planes.confidence.data[i * 4 + 2]).toBe(1);
        expect(res.degradations.some(d => d.reasonCode === 'photo_tier_occluder_rejected')).toBe(true);
    }, 240_000);

    it('de-lights its texels and matches each chart\'s exposure to the ladder below', async () => {
        const atlas = wallAtlas(DENSITY);
        // photos half a stop under the ladder's exposure
        const views = PANOS.flatMap(p => panoViews(p, { exposure: 0.72 })).map(r => r.view);
        const below = previousPlanes(atlas);
        const res = await rectifyPhotoTier({ atlas, surfaces: WALL_SURFACES, views, context: sceneMesh(), previous: below, tile: blurredTile(), densityTexelsPerMeter: DENSITY, heldOut: false });
        expect(res.record.delight!.texels).toBeGreaterThan(50_000);
        expect(res.record.exposure!.charts).toBe(1);
        expect(res.record.exposure!.meanAbsLogGain).toBeGreaterThan(0.2);
        const lum = (p: Uint8Array, i: number) => 0.2126 * p[i * 4] + 0.7152 * p[i * 4 + 1] + 0.0722 * p[i * 4 + 2];
        let sa = 0, sb = 0, raw = 0, n = 0;
        for (let i = 0; i < atlas.width * atlas.height; i += 3) {
            if (!res.planes.albedo[i * 4 + 3]) continue;
            sa += lum(res.planes.albedo, i); sb += lum(below.albedo, i); n++;
        }
        for (const v of views.slice(0, 1)) { const g = v.image.rgba; let s2 = 0, c = 0; for (let i = 0; i < g.length; i += 4 * 9) { s2 += 0.2126 * g[i] + 0.7152 * g[i + 1] + 0.0722 * g[i + 2]; c++; } raw = s2 / c; }
        expect(n).toBeGreaterThan(10_000);
        // within 6 percent of the ladder's mean luminance (the raw photos are about 30 percent darker)
        expect(Math.abs(sa / sb - 1)).toBeLessThan(0.06);
        expect(raw).toBeLessThan(0.8 * (sb / n));
    }, 240_000);

    it('puts rung 0 over anything below, and single-pano texels only where the projection has nothing', () => {
        const W = 8, H = 1, n = W * H;
        const planes = (fill: (i: number) => { rgb: [number, number, number]; rung: number } | null) => {
            const p = { layerKey: 'l', width: W, height: H, albedo: new Uint8Array(n * 4), confidence: { width: W, height: H, data: new Uint8Array(n * 4) }, provenance: [{ source: 'x', label: 'measured' as const, method: 'm', coverage: 0 }], degradations: [] };
            for (let i = 0; i < n; i++) { const f = fill(i); if (!f) continue; p.albedo.set([...f.rgb, 255], i * 4); packConfidenceTexel(p.confidence, i, 0, 0.8, f.rung); }
            return p;
        };
        // below: texels 0-1 projection multi-view, 2-3 projection single view, 4-5 tile, 6-7 nothing
        const below = planes(i => (i < 6 ? { rgb: [10, 10, 10], rung: i < 2 ? 0 : i < 4 ? 1 : 2 } : null));
        // tier: even texels rung 0, odd texels rung 1
        const tier = planes(() => ({ rgb: [200, 200, 200], rung: 0 }));
        for (let i = 1; i < n; i += 2) packConfidenceTexel(tier.confidence, i, 0, 0.6, 1);
        tier.provenance[0].coverage = 1;
        const m = mergePhotoTier(below, tier);
        const fromTier = [...Array(n).keys()].map(i => m.planes.albedo[i * 4] === 200);
        expect(fromTier).toEqual([true, false, true, false, true, true, true, true]);
        expect(m.rung0Texels).toBe(4); expect(m.rung1Texels).toBe(2); expect(m.rung1KeptBelowTexels).toBe(2);
        for (let i = 0; i < n; i++) if (fromTier[i]) expect(unpackConfidenceTexel(m.planes.confidence, i).rung).toBe(i % 2);
        // the tier's provenance coverage shrinks with the texels it did not write
        expect(m.planes.provenance[m.planes.provenance.length - 1].coverage).toBeCloseTo(6 / 8, 6);
    });

    it('caches the geometry and the warps: a re-run of the layer is cheaper and writes the same texels', async () => {
        const atlas = wallAtlas(DENSITY);
        const views = scene().rendered.map(r => r.view);
        const cache = createPhotoTierCache();
        try {
            const t1 = Date.now();
            const a = await rectifyPhotoTier({ atlas, surfaces: WALL_SURFACES, views, context: sceneMesh(), tile: blurredTile(), densityTexelsPerMeter: DENSITY, heldOut: false, cache });
            const ms1 = Date.now() - t1, t2 = Date.now();
            const b = await rectifyPhotoTier({ atlas, surfaces: WALL_SURFACES, views, context: sceneMesh(), tile: blurredTile(), densityTexelsPerMeter: DENSITY, heldOut: false, cache });
            const ms2 = Date.now() - t2;
            expect(b.record.timingsMs!.setup).toBe(0);
            expect(a.record.timingsMs!.setup).toBeGreaterThan(0);
            expect(b.record.timingsMs!.workerCharts).toBeLessThan(a.record.timingsMs!.workerCharts);
            expect(ms2).toBeLessThan(ms1);
            expect(Buffer.from(b.planes.albedo).equals(Buffer.from(a.planes.albedo))).toBe(true);
            fs.mkdirSync(SHOTS, { recursive: true });
            fs.writeFileSync(path.join(SHOTS, 'staged_texture_photo_tier_cache_timings.json'), JSON.stringify({ coldMs: ms1, warmMs: ms2, cold: a.record.timingsMs, warm: b.record.timingsMs }, null, 1));
        } finally { cache.dispose(); }
    }, 240_000);
});

describe('photo tier A in the texture ladder (texture-pass.ts)', () => {
    it('takes rung 0 on the flat wall over the projection; the statue stays with the rungs below; every texel labelled', async () => {
        const nx = 12, ny = 9, pos: number[] = [], idx: number[] = [];
        for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) pos.push(WALL.x0 + i, WALL.y0 + j, WALL.z);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
        const clayGlb = writeStagedGlb([{ name: 's00', positions: Float32Array.from(pos), indices: Uint32Array.from(idx), extras: { sb: { schema: 'scratchbox.staged-node/2', stage: 'fit', ids: { surfaceId: 's00' } } } }], { rootExtras: { sb: { stage: 'fit' } } });
        const views = scene().rendered.map(r => r.view);
        const wallOnly = sceneMesh({ statue: false });
        const out = await textureLayer({ layerKey: 'l3b', clayGlb, surfaces: WALL_SURFACES as any }, {
            views, occluder: wallOnly, context: sceneMesh(), palette: [{ headingDeg: 180, colours: [{ srgb: [180, 176, 170] as Vec3, share: 1 }] }],
            densityTexelsPerMeter: 20, maxSide: 512
        });
        const rect = out.bundle.provenance.find(p => p.source === PHOTO_TIER_SOURCE);
        expect(rect).toBeDefined();
        expect(rect!.coverage).toBeGreaterThan(0.7);
        expect(out.photoTier!.texelShare).toBeGreaterThan(0.7);
        expect(out.bundle.photoTier!.heldOut === undefined || out.bundle.photoTier!.heldOut.methods.photoA.pixels > 0).toBe(true);
        expect(out.rungShares[0]).toBeGreaterThan(0.7);
        // the statue's texels (about 4 percent of the wall) come from the projection or below, not from the rectified tier
        expect(out.degradations.some(d => d.reasonCode === 'photo_tier_non_planar')).toBe(true);
        expect(out.bundle.provenance.some(p => p.source !== PHOTO_TIER_SOURCE && p.coverage > 0.01)).toBe(true);
        expect(out.bundle.provenance.reduce((a, p) => a + p.coverage, 0)).toBeCloseTo(1, 6);
        expect(out.timingsMs.photoTier).toBeGreaterThan(0);
    }, 300_000);
});

void ([] as Vec3[]);

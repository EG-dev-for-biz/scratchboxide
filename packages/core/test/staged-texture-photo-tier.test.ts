/**
 * Photo tier A (photo-tier-rectify.ts + python/photo_tier/face_rectify.py) on a synthetic planar facade with a repeated
 * coursing, a statue standing proud of it and a van in front: photos ray cast through the grounding camera (fx = 960 /
 * tan(fov/2) at the delivered crop) from the true poses, handed over with registration errors of 0.3-0.6 deg and up to
 * 0.5 m. Checks: the wide views anchor on the outline, narrow views map to them by rotation, other panos by features; the
 * rectified texels sit on the true texture within one texel; the van seen by one view at a time is dropped by the median;
 * the statue (1.2 m proud) is left to the rungs below with its deviation measured; provenance; the held-out score; the
 * fallbacks (no outline, an unmatched old pano, no worker). No network, no model.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import type { BakedTexturePlanes, ProjectionView } from '../src/common/spatial/texture-pass-contracts';
import { rectifyPhotoTier, PHOTO_TIER_SOURCE, type PhotoTierResult } from '../src/node/3d-engine/staged-location/photo-tier-rectify';
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
    it('anchors the wide views on the tile outline, narrow views by rotation, other panos by features', async () => {
        const { res } = await runMain();
        const f = res.worker!.facades[0];
        expect(f.skipped).toBeUndefined();
        for (const p of PANOS) {
            expect(f.panos[p.panoId].anchor).toBe('outline');
            // the outline chamfer improves on the registered pose
            expect(f.panos[p.panoId].chamferPx!).toBeLessThan(f.panos[p.panoId].chamferPosePx!);
        }
        const viewsOf = (pid: string) => Object.entries(f.views).filter(([k]) => res.worker && keyPano(k) === pid).map(([, v]) => v);
        const keyPano = (k: string) => scene().rendered.concat(scene().old)[Number(k.slice(1))]?.view.panoId;
        const ref = f.reference!;
        expect(PANOS.map(p => p.panoId)).toContain(ref);
        // the reference is the pano the others' anchors agree with (a coursed wall can trap one anchor on a course line)
        expect(f.consensus!.agreeing[ref]).toBeGreaterThanOrEqual(1);
        for (const p of PANOS) if (f.panos[p.panoId].anchorDisagrees) expect(res.degradations.some(d => d.reasonCode === 'photo_tier_anchor_outvoted' && d.reason.includes(p.panoId.slice(0, 6)))).toBe(true);
        const refViews = viewsOf(ref);
        const rot = refViews.filter(v => v.placement === 'rotation to its wide view');
        expect(rot.length).toBe(2);
        for (const v of rot) { expect(v.inliers!).toBeGreaterThan(200); expect(v.residualPx!).toBeLessThan(1); }
        const others = PANOS.filter(p => p.panoId !== ref).flatMap(p => viewsOf(p.panoId));
        expect(others.filter(v => v.placement === 'feature homography to the reference pano').length).toBeGreaterThanOrEqual(6);
    }, 240_000);

    it('puts the rectified texels on the true texture within one texel', async () => {
        const { res, atlas } = await runMain();
        expect(res.record.texelShare).toBeGreaterThan(0.75);
        expect(res.record.multiViewShare).toBeGreaterThan(0.6);
        const r = registration(atlas, res.planes, (a, b) => !inStatue(a, b, 1));
        expect(r.samples).toBeGreaterThan(1000);
        expect(Math.hypot(r.du, r.dv)).toBeLessThanOrEqual(1 / DENSITY + 1e-9);
        expect(r.err).toBeLessThan(18);
        // the same photos placed by the registered poses alone are off by several texels (the chain is what aligns them)
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
        expect(photoA.pixels).toBeGreaterThan(5000);
        expect(photoA.pixels).toBe(previous.pixels);
        expect(photoA.heldOutGradNcc!).toBeGreaterThan(0.3);
        expect(photoA.heldOutGradNcc!).toBeGreaterThan(previous.heldOutGradNcc! + 0.2);
        // the synthetic tile is the true texture blurred, exactly in place: coarse gradients agree as well as the photos', the
        // fine edges do not
        expect(photoA.heldOutChamferMedianPx!).toBeLessThanOrEqual(tile.heldOutChamferMedianPx!);
        expect(photoA.geoChamferMedianPx!).toBeLessThanOrEqual(tile.geoChamferMedianPx!);
        expect(photoA.heldOutChamferMedianPx!).toBeLessThanOrEqual(previous.heldOutChamferMedianPx!);
        expect(photoA.laplacianVar!).toBeGreaterThan(tile.laplacianVar!);
    }, 240_000);

    it('does not use an old pano whose stones do not match and whose only view lacks the outline', async () => {
        const { res } = await runMain();
        const used = new Set(res.planes.provenance.flatMap(p => p.panoIds!));
        expect(used.has(OLD_PANO.panoId)).toBe(false);
        // its only view has no outline, and its stones match the others only by the repeated coursing: either it is not placed,
        // or its warp fails the cross-view agreement check
        const d = res.degradations.find(x => (x.reasonCode === 'photo_tier_pano_unplaced' || x.reasonCode === 'photo_tier_view_disagrees') && x.reason.includes(OLD_PANO.panoId.slice(0, 6)));
        expect(d).toBeDefined();
    }, 240_000);

    it('skips a facade whose tile mesh shows no outline, and degrades when the worker cannot run', async () => {
        const atlas = wallAtlas(DENSITY);
        const views = scene().rendered.map(r => r.view);
        const noOutline = await rectifyPhotoTier({ atlas, surfaces: WALL_SURFACES, views, context: sceneMesh({ huge: true }), densityTexelsPerMeter: DENSITY, heldOut: false });
        expect(noOutline.degradations.some(d => d.reasonCode === 'photo_tier_no_outline')).toBe(true);
        expect(noOutline.record.texelShare).toBe(0);
        const noWorker = await rectifyPhotoTier({ atlas, surfaces: WALL_SURFACES, views, context: sceneMesh(), densityTexelsPerMeter: DENSITY, pythonExecutable: '/nonexistent/python3' });
        expect(noWorker.degradations.some(d => d.reasonCode === 'photo_tier_failed')).toBe(true);
        expect(noWorker.planes.albedo.some((v, i) => i % 4 === 3 && v > 0)).toBe(false);
        const noPlane = await rectifyPhotoTier({ atlas, surfaces: [], views, context: sceneMesh(), densityTexelsPerMeter: DENSITY });
        expect(noPlane.degradations.some(d => d.reasonCode === 'photo_tier_no_planar_face')).toBe(true);
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

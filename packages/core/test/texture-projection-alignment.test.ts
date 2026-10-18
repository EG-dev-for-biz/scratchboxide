/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Per-view, per-chart image alignment and one view per region (texture-alignment.ts, texture-seams.ts) on an analytic
 * facade with carved detail, seen by three cameras. The bake is given registered poses that are off by a fraction of a
 * degree (as the live arch's ~1.2 m residual is), so a plain weighted blend draws every joint twice. Measured against the
 * analytic albedo: the alignment brings the views' gradients into agreement and the bake's detail back onto the facade;
 * with exact poses it moves nothing. Screenshots: test-results/screenshots/texture_bake/alignment_*.png (gitignored).
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import type { DecodedImage, DepthMap, PinholeCamera, ProjectionView, UvAtlas } from '../src/common/spatial/texture-pass-contracts';
import { bakeStreetViewProjection, type ProjectionBakeOptions } from '../src/node/3d-engine/staged-location/texture-projection';
import { encodePng } from '../src/node/texture-processing';
import { facadeAtlas, lookAtCamera } from './helpers/texture-pass-fixtures';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/texture_bake');
const W = 10, H = 6;

/** Carved ashlar: staggered courses with dark joints, plus a few deterministic dark rosettes (not periodic). */
function carved(u: number, v: number): number {
    const course = Math.floor(v / 0.55), off = course % 2 ? 0.45 : 0;
    const jx = ((u + off) % 0.9 + 0.9) % 0.9, jy = v - course * 0.55;
    let l = 185 + 25 * Math.sin(u * 0.7) * Math.cos(v * 0.9);
    if (jx < 0.05 || jy < 0.05) l = 70;
    for (const [cu, cv, r] of [[2.2, 4.1, 0.35], [6.7, 1.6, 0.45], [8.1, 4.6, 0.3], [4.3, 2.4, 0.25]]) if (Math.hypot(u - cu, v - cv) < r) l = 60 + 60 * (Math.hypot(u - cu, v - cv) / r);
    return l;
}

function render(cam: PinholeCamera): DecodedImage {
    const rgba = new Uint8Array(cam.width * cam.height * 4);
    for (let py = 0; py < cam.height; py++) for (let px = 0; px < cam.width; px++) {
        const sx = (px + 0.5 - cam.cx) / cam.fx, sy = (py + 0.5 - cam.cy) / cam.fy;
        const d: Vec3 = [cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1], cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]];
        const t = -cam.eye[2] / d[2];
        const o = (py * cam.width + px) * 4;
        let l = 128;
        if (t > 0) { const u = cam.eye[0] + t * d[0], v = cam.eye[1] + t * d[1]; if (u >= 0 && u <= W && v >= 0 && v <= H) l = carved(u, v); }
        rgba[o] = rgba[o + 1] = rgba[o + 2] = Math.round(l); rgba[o + 3] = 255;
    }
    return { width: cam.width, height: cam.height, rgba };
}

/** The camera turned by `yawDeg` about its up axis and `pitchDeg` about its right axis (a registration error). */
function turned(cam: PinholeCamera, yawDeg: number, pitchDeg: number): PinholeCamera {
    const rot = (v: Vec3, k: Vec3, a: number): Vec3 => {
        const c = Math.cos(a), s = Math.sin(a), d = v[0] * k[0] + v[1] * k[1] + v[2] * k[2];
        const x: Vec3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
        return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)];
    };
    const y = (yawDeg * Math.PI) / 180, p = (pitchDeg * Math.PI) / 180;
    let { fwd, right, up } = cam;
    fwd = rot(fwd, up, y); right = rot(right, up, y);
    fwd = rot(fwd, right, p); up = rot(up, right, p);
    return { ...cam, fwd, right, up };
}

function depthOf(cam: PinholeCamera): DepthMap {
    const depthM = new Float32Array(cam.width * cam.height).fill(Infinity);
    for (let py = 0; py < cam.height; py++) for (let px = 0; px < cam.width; px++) {
        const sx = (px + 0.5 - cam.cx) / cam.fx, sy = (py + 0.5 - cam.cy) / cam.fy;
        const dz = cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2], dx = cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], dy = cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1];
        const t = -cam.eye[2] / dz;
        if (!(t > 0)) continue;
        const u = cam.eye[0] + t * dx, v = cam.eye[1] + t * dy;
        if (u >= 0 && u <= W && v >= 0 && v <= H) depthM[py * cam.width + px] = t; // t along a ray whose fwd component is 1
    }
    return { width: cam.width, height: cam.height, depthM };
}

/** Three views (true images); the poses handed to the bake carry the given errors (yaw, pitch degrees). */
function views(errors: Array<[number, number]>): ProjectionView[] {
    const eyes: Array<[string, Vec3]> = [['front', [5, 1.7, -13]], ['left', [-2, 1.7, -11]], ['right', [12, 1.7, -11]]];
    return eyes.map(([panoId, eye], k) => {
        const truth = lookAtCamera(eye, [5, 3, 0], 480, 288, 60);
        return { panoId, camera: turned(truth, errors[k][0], errors[k][1]), image: render(truth), poseQuality: 1, poseSigmaPx: 160 };
    });
}

/** Normalised correlation of the bake's luminance gradients with the analytic albedo's (at texel centres, or with `box` its mean over each texel), over the atlas. */
function gradAgreement(atlas: UvAtlas, albedo: Uint8Array, box = false): number {
    const S = atlas.width, P = atlas.texels.position;
    const truth = new Float64Array(S * S), bake = new Float64Array(S * S);
    for (let i = 0; i < S * S; i++) {
        if (box) { const s = atlas.texels.sizeM[i]; let a = 0; for (let p = 0; p < 8; p++) for (let q = 0; q < 8; q++) a += carved(P[i * 3] + ((p + 0.5) / 8 - 0.5) * s, P[i * 3 + 1] + ((q + 0.5) / 8 - 0.5) * s); truth[i] = a / 64; }
        else truth[i] = carved(P[i * 3], P[i * 3 + 1]);
        bake[i] = albedo[i * 4 + 3] ? albedo[i * 4] : NaN;
    }
    let ab = 0, aa = 0, bb = 0;
    for (let y = 0; y + 1 < S; y++) for (let x = 0; x + 1 < S; x++) {
        const i = y * S + x;
        for (const j of [i + 1, i + S]) {
            const a = truth[j] - truth[i], b = bake[j] - bake[i];
            if (!Number.isFinite(b)) continue;
            ab += a * b; aa += a * a; bb += b * b;
        }
    }
    return ab / Math.sqrt(aa * bb);
}

async function bake(atlas: UvAtlas, v: ProjectionView[], options: ProjectionBakeOptions) {
    return bakeStreetViewProjection({ atlas, views: v, depthFor: view => depthOf(view.camera), options: { bandSigmasTexels: [1, 2, 4], ...options } });
}

describe('Street View projection: per-chart image alignment', () => {
    const atlas = facadeAtlas(160);

    it('brings misregistered views into agreement and the carved detail back onto the facade', async () => {
        const v = views([[0.6, -0.3], [-0.5, 0.4], [0.3, 0.5]]);
        // the agreement exactly registered views reach (the views differ in resolution and angle, so it is below 1)
        const exact = (await bake(atlas, views([[0, 0], [0, 0], [0, 0]]), { regionSelect: false })).report.alignment!.interViewGradNccBefore;
        const plain = await bake(atlas, v, { align: false, regionSelect: false });
        // the geometry-registered reference: the albedo as a 15 cm tile photo sees it (box-averaged), linear
        const tile = (P: Vec3): Vec3 => {
            let l = 0;
            for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) l += carved(P[0] + a * 0.03, P[1] + b * 0.03) / 25;
            const lin = (l / 255) ** 2.2;
            return [lin, lin, lin];
        };
        const aligned = await bake(atlas, v, { regionSelect: false, alignReference: tile });
        const rep = aligned.report.alignment!;
        expect(rep, "the alignment ran").toBeDefined();
        expect(rep.kept.aligned ?? 0).toBeGreaterThanOrEqual(2);
        expect(rep.interViewGradNccAfter).toBeGreaterThan(rep.interViewGradNccBefore + 0.2);
        expect(rep.interViewGradNccAfter, `exactly registered: ${exact.toFixed(3)}`).toBeGreaterThan(0.85 * exact);
        const before = gradAgreement(atlas, plain.albedo), after = gradAgreement(atlas, aligned.albedo);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'alignment_report.json'), JSON.stringify({ exactInterViewNcc: exact, interViewNcc: [rep.interViewGradNccBefore, rep.interViewGradNccAfter], bakeVsTruthGradNcc: [before, after], kept: rep.kept }));
        expect(after, `bake vs truth gradient NCC ${before.toFixed(3)} -> ${after.toFixed(3)}`).toBeGreaterThan(before + 0.1);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'alignment_plain_blend.png'), encodePng(atlas.width, atlas.height, Buffer.from(plain.albedo)));
        fs.writeFileSync(path.join(SHOTS, 'alignment_aligned.png'), encodePng(atlas.width, atlas.height, Buffer.from(aligned.albedo)));
    }, 120_000);

    it('without a reference it still brings the views into agreement with each other (the gauge stays the first view)', async () => {
        const v = views([[0.6, -0.3], [-0.5, 0.4], [0.3, 0.5]]);
        const rep = (await bake(atlas, v, { regionSelect: false })).report.alignment!;
        expect(rep.interViewGradNccAfter).toBeGreaterThan(rep.interViewGradNccBefore + 0.2);
    }, 120_000);

    it('moves nothing when the poses are right', async () => {
        const v = views([[0, 0], [0, 0], [0, 0]]);
        const res = await bake(atlas, v, { regionSelect: false });
        for (const s of res.report.alignment!.perView) {
            expect(Math.abs(s.medianDx)).toBeLessThan(1);
            expect(Math.abs(s.medianDy)).toBeLessThan(1);
        }
        // a texel holds its footprint's mean (footprint sampling), so the truth is the albedo's mean over the texel
        // (measured: 0.962; point-sampled 0.899, against the albedo at texel centres 0.929 and 0.886)
        expect(gradAgreement(atlas, res.albedo, true)).toBeGreaterThan(0.9);
    }, 120_000);
});

/** Mean absolute luminance gradient of the bake over the atlas (a double image halves the contrast of every joint). */
function sharpness(atlas: UvAtlas, albedo: Uint8Array): number {
    const S = atlas.width;
    let s = 0, n = 0;
    for (let y = 0; y + 1 < S; y++) for (let x = 0; x + 1 < S; x++) {
        const i = y * S + x;
        if (!albedo[i * 4 + 3] || !albedo[(i + 1) * 4 + 3] || !albedo[(i + S) * 4 + 3]) continue;
        s += Math.abs(albedo[(i + 1) * 4] - albedo[i * 4]) + Math.abs(albedo[(i + S) * 4] - albedo[i * 4]); n++;
    }
    return s / n;
}

describe('Street View projection: one view per region', () => {
    const atlas = facadeAtlas(160);

    it('draws each region from one view, so misregistered views do not double the detail, and blends where they meet', async () => {
        const v = views([[0.6, -0.3], [-0.5, 0.4], [0.3, 0.5]]);
        const truthSharp = sharpness(atlas, (await bake(atlas, views([[0, 0], [0, 0], [0, 0]]), { align: false, regionSelect: false })).albedo);
        const blend = await bake(atlas, v, { align: false, regionSelect: false });
        const regions = await bake(atlas, v, { align: false, bandSigmasTexels: [1, 2, 4, 12, 32] });
        const sb = sharpness(atlas, blend.albedo), sr = sharpness(atlas, regions.albedo);
        expect(regions.report.regions, 'the region selection ran').toBeDefined();
        // the weighted blend of shifted views loses joint contrast; one view per region keeps it near a registered bake
        expect(sr, `sharpness: blend ${sb.toFixed(2)}, regions ${sr.toFixed(2)}, registered ${truthSharp.toFixed(2)}`).toBeGreaterThan(1.2 * sb);
        expect(sr).toBeGreaterThan(0.85 * truthSharp);
        // where regions meet, the output step is no larger than the texture's own contrast inside a region
        const seam = regions.report.outputSeam;
        expect(seam.p95DeltaE, JSON.stringify(seam)).toBeLessThanOrEqual(seam.interiorP95DeltaE + 2);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'regions_blend.png'), encodePng(atlas.width, atlas.height, Buffer.from(blend.albedo)));
        fs.writeFileSync(path.join(SHOTS, 'regions_selected.png'), encodePng(atlas.width, atlas.height, Buffer.from(regions.albedo)));
        fs.writeFileSync(path.join(SHOTS, 'regions_report.json'), JSON.stringify({ sharpness: { blend: sb, regions: sr, registered: truthSharp }, seam, regions: regions.report.regions }));
    }, 120_000);
});

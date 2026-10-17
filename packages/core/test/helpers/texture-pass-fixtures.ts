/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Replay fixtures for the texture pass (tasks B, C, D). Everything is synthesised in code, deterministically: no image
 * bytes are committed (Street View grounding imagery is Google's), no network, no billed call. The rig is one planar
 * facade with an analytic albedo and several pinhole views rendered from it by exact ray-plane intersection, so a
 * projected texel has a ground truth (`facadeAlbedo(u, v)`) the bake must reproduce to 1/255 on unoccluded texels.
 */

import type {
    ConfidencePlane, DecodedImage, PinholeCamera, TexelProvenance, TextureLayerBundle, TexturePassRecord, UvAtlas
} from '../../src/common/spatial/texture-pass-contracts';
import type { Vec3 } from '../../src/common/spatial/staged-location-contracts';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

/** The facade: a plane through `origin` spanned by unit `u` (east) and `v` (up), facing -z toward the street at z < 0. 10 m wide, 6 m high. */
export const FACADE = { origin: [0, 0, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3, normal: [0, 0, -1] as Vec3, widthM: 10, heightM: 6 };

/** Smooth, non-periodic albedo (RGB, inside 0..255 on the facade) of the facade at metric (u, v). */
export function facadeAlbedo(u: number, v: number): Vec3 {
    return [30 + 12 * u + 8 * v, 200 - 10 * u + 5 * v, 60 + 6 * u + 15 * v];
}

/** A pinhole camera at `eye` looking at `target`, image y down. */
export function lookAtCamera(eye: Vec3, target: Vec3, width: number, height: number, horizontalFovDeg: number): PinholeCamera {
    const fwd = norm(sub(target, eye));
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    const fx = (width / 2) / Math.tan((horizontalFovDeg * Math.PI) / 360);
    return { eye, right, up, fwd, fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

/** Projects a world point: pixel coordinates and depth along `fwd`; depth <= 0 is behind the camera. */
export function projectPoint(cam: PinholeCamera, p: Vec3): { x: number; y: number; depth: number } {
    const d = sub(p, cam.eye);
    const z = dot(d, cam.fwd);
    return { x: cam.cx + (cam.fx * dot(d, cam.right)) / z, y: cam.cy - (cam.fy * dot(d, cam.up)) / z, depth: z };
}

/** Renders the facade from `cam`: exact ray-plane intersection per pixel; pixels that miss the facade rectangle are mid-grey sky. */
export function renderFacadeView(cam: PinholeCamera): DecodedImage {
    const rgba = new Uint8Array(cam.width * cam.height * 4);
    const nDotO = dot(sub(FACADE.origin, cam.eye), FACADE.normal);
    for (let py = 0; py < cam.height; py++) {
        for (let px = 0; px < cam.width; px++) {
            const sx = (px + 0.5 - cam.cx) / cam.fx, sy = (py + 0.5 - cam.cy) / cam.fy;
            const dir: Vec3 = [
                cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0],
                cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1],
                cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]
            ];
            const o = (py * cam.width + px) * 4;
            const denom = dot(dir, FACADE.normal);
            const t = Math.abs(denom) < 1e-9 ? -1 : nDotO / denom;
            let rgb: Vec3 = [128, 128, 128];
            if (t > 0) {
                const hit: Vec3 = [cam.eye[0] + t * dir[0], cam.eye[1] + t * dir[1], cam.eye[2] + t * dir[2]];
                const u = hit[0] - FACADE.origin[0], v = hit[1] - FACADE.origin[1];
                if (u >= 0 && u <= FACADE.widthM && v >= 0 && v <= FACADE.heightM) rgb = facadeAlbedo(u, v);
            }
            rgba[o] = Math.round(rgb[0]); rgba[o + 1] = Math.round(rgb[1]); rgba[o + 2] = Math.round(rgb[2]); rgba[o + 3] = 255;
        }
    }
    return { width: cam.width, height: cam.height, rgba };
}

/** Three views of the facade at known poses (frontal, left oblique, right oblique), 160 x 96 px. */
export function facadeViews(): Array<{ panoId: string; camera: PinholeCamera; image: DecodedImage }> {
    const target: Vec3 = [5, 3, 0];
    return ([['pano-front', [5, 1.7, -14]], ['pano-left', [-3, 1.7, -12]], ['pano-right', [13, 1.7, -12]]] as Array<[string, Vec3]>)
        .map(([panoId, eye]) => {
            const camera = lookAtCamera(eye, target, 160, 96, 70);
            return { panoId, camera, image: renderFacadeView(camera) };
        });
}

/** An atlas of the facade alone: `side` x `side` texels over the 10 m x 6 m rectangle, covered everywhere, no gutter. */
export function facadeAtlas(side = 32): UvAtlas {
    const n = side * side;
    const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), sizeM = new Float32Array(n);
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
            const i = y * side + x;
            const u = ((x + 0.5) / side) * FACADE.widthM, v = (1 - (y + 0.5) / side) * FACADE.heightM;
            position.set([FACADE.origin[0] + u, FACADE.origin[1] + v, FACADE.origin[2]], i * 3);
            normal.set(FACADE.normal, i * 3);
            sizeM[i] = FACADE.widthM / side;
        }
    }
    return {
        layerKey: 'fit', width: side, height: side,
        maps: [{ nodeName: 'facade', kind: 'chart-plane', texelsPerMeter: side / FACADE.widthM, atlasRect: [0, 0, 1, 1], chartId: 's00' }],
        texels: { covered: new Uint8Array(n).fill(1), gutter: new Uint8Array(n), mapIndex: new Uint16Array(n), position, normal, sizeM }
    };
}

/** An empty confidence plane. */
export function emptyConfidencePlane(width: number, height: number): ConfidencePlane {
    return { width, height, data: new Uint8Array(width * height * 4) };
}

export function texelProvenance(): TexelProvenance[] {
    return [
        { source: 'street-view-projection', label: 'photo-inferred', method: 'weighted linear-RGB mean, 3 views', panoIds: ['pano-front', 'pano-left', 'pano-right'], coverage: 0.8 },
        { source: 'tile-photo-transfer', label: 'photo-inferred', method: 'nearest tile surface, de-lit, confidence capped at 0.5', coverage: 0.15 },
        { source: 'generated-pbr', label: 'generated', method: 'tileable set from the measured palette (no real data)', coverage: 0.05 }
    ];
}

export function textureLayerBundle(): TextureLayerBundle {
    return {
        layerKey: 'fit', maps: { albedo: 'tex/fit_albedo.png', normal: 'tex/fit_normal.png' },
        uv: facadeAtlas(8).maps, provenance: texelProvenance(), ladderRung: 0, confidence: 'tex/fit_confidence.png'
    };
}

export function texturePassRecord(): TexturePassRecord {
    return {
        passVersion: 'texture-pass/1', layers: [textureLayerBundle()],
        degradations: [{
            stage: 'bake-projection', reasonCode: 'pano_set_aside', layerKey: 'fit', fromRung: 0, toRung: 1, texelShare: 0.12,
            reason: 'One pano was set aside by the registration, so 12 percent of the facade has one view instead of two.'
        }],
        costUsd: 0, timingsMs: { uv: 1800, 'bake-projection': 14200 }
    };
}

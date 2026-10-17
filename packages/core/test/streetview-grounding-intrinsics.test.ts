/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The Maps Imagery Grounding API's camera: the requested fov is the horizontal fov of a 1920 x 1280 frame and every aspect ratio
 * is a centred crop of it at the same focal length, fx = 960 / tan(fov / 2) at the delivered size (measured live with rotated
 * and re-cropped views of one pano). The grounding cameras (castCamera, viewCamera) must use it for every aspect, keep the
 * principal point at the crop's centre, and scale with a downscaled image.
 */

import { describe, expect, it } from 'vitest';
import { groundingFocalPx, groundingHorizontalFovDeg, groundingRequestFovDeg } from '../src/node/spatial/StreetViewPoseRegistrar';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { viewCamera } from '../src/node/3d-engine/staged-location/slot-projection';

const CROPS: Array<[string, number, number]> = [['16:9', 1920, 1080], ['4:3', 1707, 1280], ['1:1', 1280, 1280], ['9:16', 720, 1280]];

describe('grounding image intrinsics', () => {
    for (const fov of [20, 40, 60, 75]) {
        for (const [name, w, h] of CROPS) {
            it(`fx = 960 / tan(${fov}/2) and the centre of the ${name} crop`, () => {
                const fx = 960 / Math.tan((fov * Math.PI) / 360);
                expect(groundingFocalPx(fov, w, h)).toBeCloseTo(fx, 6);
                const view = { eye: [0, 1.7, 0] as [number, number, number], headingDeg: 30, pitchDeg: 5, fovDeg: fov, widthPx: w, heightPx: h };
                for (const cam of [castCamera(view), viewCamera(view)]) {
                    expect(cam.fx).toBeCloseTo(fx, 4);
                    expect(cam.fy).toBeCloseTo(fx, 4);
                    expect(cam.cx).toBeCloseTo(w / 2, 6);
                    expect(cam.cy).toBeCloseTo(h / 2, 6);
                }
                // a downscaled copy of the crop: the focal length scales with it
                const s = 0.375, ds = castCamera({ ...view, widthPx: Math.round(w * s), heightPx: Math.round(h * s) });
                expect(ds.fx).toBeCloseTo(fx * Math.round(w * s) / w, 0);
                // the fov to request for a wanted true horizontal fov inverts the conversion
                const hfov = groundingHorizontalFovDeg(fov, w, h);
                expect(groundingRequestFovDeg(hfov, w / h)).toBeCloseTo(fov, 6);
            });
        }
    }
    it('is not the width-based pinhole: 11 % longer for 4:3, 50 % for 1:1', () => {
        const fov = 60, t = Math.tan((fov * Math.PI) / 360);
        expect(groundingFocalPx(fov, 1707, 1280) / (1707 / (2 * t))).toBeCloseTo(1920 / 1707, 6);
        expect(groundingFocalPx(fov, 1280, 1280) / (1280 / (2 * t))).toBeCloseTo(1.5, 6);
    });
});

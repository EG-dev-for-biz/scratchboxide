/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ImageColorTransferService,
    transferImageColor
} from '../src/node/image/ImageColorTransferService';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import { decodePng, encodePng } from '../src/node/texture-processing';

/** A w x h PNG filled with one colour. */
function solid(w: number, h: number, rgb: [number, number, number]): Buffer {
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255; }
    return encodePng(w, h, rgba);
}

/** A horizontal grey ramp, so the target has structure the transfer must keep in place. */
function ramp(w: number, h: number): Buffer {
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, v = Math.round(40 + (x / (w - 1)) * 160);
        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
    return encodePng(w, h, rgba);
}

describe('ImageColorTransferService (2D image-to-image colour transfer)', () => {
    it('measures both images and moves the target toward the reference colours, pixel for pixel in place', async () => {
        const result = await transferImageColor({
            referenceImage: solid(48, 32, [200, 90, 40]),
            targetImage: ramp(96, 40),
            outputFormat: 'png',
            preserveSkinTones: false
        });
        expect(result.success).toBe(true);
        expect(result.telemetry.mode).toBe('local-cielab');
        expect(result.telemetry.dimensions).toEqual({ width: 96, height: 40 });
        // The reference is orange: positive a* and b* means; the grey target's are near zero.
        expect(result.referenceStatistics.mean[1]).toBeGreaterThan(20);
        expect(result.referenceStatistics.mean[2]).toBeGreaterThan(20);
        expect(Math.abs(result.targetStatistics.mean[1])).toBeLessThan(2);
        const out = decodePng(result.outputBuffer);
        expect([out.width, out.height]).toEqual([96, 40]);
        const mid = (20 * 96 + 48) * 4;
        expect(out.rgba[mid]).toBeGreaterThan(out.rgba[mid + 2]); // warmer: red above blue
        expect(result).not.toHaveProperty('palette');
        expect(result).not.toHaveProperty('plan');
    });

    it('has no canned palette: extractPalette is gone and an unreadable input fails', async () => {
        expect((ImageColorTransferService as any).extractPalette).toBeUndefined();
        await expect(ImageColorTransferService.transferColor({ referenceImage: 'sunset_rome.jpg', targetImage: 'colosseum_noon.jpg' }))
            .rejects.toBeInstanceOf(MissingInputError);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-color-transfer-'));
        try {
            const bogus = path.join(dir, 'not_an_image.png');
            fs.writeFileSync(bogus, 'not an image');
            await expect(ImageColorTransferService.transferColor({ referenceImage: bogus, targetImage: ramp(8, 8) })).rejects.toThrow();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

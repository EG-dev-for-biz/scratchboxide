/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as zlib from 'zlib';
import { decodeSpz } from '../src/common/splat-spz-codec';
import { SplatService } from '../src/node/3d-engine/splat-service';
import { NativeSpatialBridge } from '../src/common/spatial/NativeSpatialBridge';
import { PhotorealGaussianSplatMesh } from '../src/browser/generative-canvas/services/spatial/PhotorealGaussianSplatMesh';
import type { BakedGaussian } from '../src/common/geospatial-4d-protocol';

const splats: BakedGaussian[] = [
    { position: [1.25, -0.5, 10.0], scale: [0.02, 0.05, 0.001], quaternion: [0, 0, 0, 1], colorRgb: [0.8, 0.2, 0.1], opacity: 0.9 },
    { position: [-3.0, 2.0, 0.25], scale: [0.1, 0.1, 0.1], quaternion: [0.3826834, 0, 0, 0.9238795], colorRgb: [0.1, 0.5, 0.9], opacity: 0.4 }
];

/** Current Niantic layout as written by the repo's SPZ writers (gzip, 'NGSP' v2). */
const niantic = SplatService.serializeSpzBuffer(splats);

describe('Shared SPZ decoder', () => {
    it('decodes the NGSP v2 files the pipelines write today', () => {
        const d = decodeSpz(new Uint8Array(zlib.gunzipSync(niantic)));
        expect(d.format).toBe('spz-v2');
        expect(d.count).toBe(2);
        expect(d.positions[0]).toBeCloseTo(1.25, 3);
        expect(d.positions[5]).toBeCloseTo(0.25, 3);
        expect(d.scales[0]).toBeCloseTo(0.02, 2);
        expect(Math.abs(d.scales[1] - 0.05) / 0.05).toBeLessThan(0.07);
        expect(d.colors[0]).toBeCloseTo(0.8, 1);
        expect(d.colors[5]).toBeCloseTo(0.9, 1);
        expect(d.opacities[1]).toBeCloseTo(0.4, 2);
        expect(d.quats[4]).toBeCloseTo(0.3827, 1);
        expect(d.quats[7]).toBeCloseTo(0.9239, 1);
    });

    it('decodes legacy SPZ1 interleaved records', () => {
        const n = 1;
        const buf = Buffer.alloc(16 + 22 * n);
        buf.writeUInt32LE(0x315a5053, 0);
        buf.writeUInt32LE(n, 8);
        buf.writeUInt8(12, 12);
        let o = 16;
        buf.writeInt32LE(4096, o); buf.writeInt32LE(-8192, o + 4); buf.writeInt32LE(2048, o + 8); o += 12;
        buf.writeInt8(0, o++); buf.writeInt8(0, o++); buf.writeInt8(0, o++);
        buf.writeInt8(0, o++); buf.writeInt8(0, o++); buf.writeInt8(0, o++);
        buf.writeUInt8(255, o++); buf.writeUInt8(0, o++); buf.writeUInt8(128, o++); buf.writeUInt8(200, o++);
        const d = decodeSpz(new Uint8Array(buf));
        expect(d.format).toBe('spz1-legacy');
        expect(Array.from(d.positions)).toEqual([1, -2, 0.5]);
        expect(d.colors[0]).toBeCloseTo(1, 5);
        expect(d.colors[2]).toBeCloseTo(128 / 255, 5);
        expect(d.opacities[0]).toBeCloseTo(200 / 255, 5);
        expect(d.quats[3]).toBeCloseTo(1, 5);
    });

    it('refuses SPZ v3 rotations rather than decoding them wrongly', () => {
        const raw = Buffer.from(zlib.gunzipSync(niantic));
        raw.writeUInt32LE(3, 4);
        expect(() => decodeSpz(new Uint8Array(raw))).toThrow(/v3/);
    });

    it('is what the browser splat mesh and the canvas bridge use, so current .spz files load in the app', async () => {
        const mesh = await PhotorealGaussianSplatMesh.parseSpzBuffer(new Uint8Array(niantic));
        expect(mesh.count).toBe(2);
        expect(mesh.colors[0]).toBeCloseTo(0.8, 1);
        const bridged = NativeSpatialBridge.decodeSpzPayload(new Uint8Array(zlib.gunzipSync(niantic)));
        expect(bridged).toHaveLength(2);
        expect(bridged[1].opacity).toBeCloseTo(0.4, 2);
        const service = SplatService.parseSpzBuffer(niantic);
        expect(service[0].position[2]).toBeCloseTo(10, 3);
    });
});

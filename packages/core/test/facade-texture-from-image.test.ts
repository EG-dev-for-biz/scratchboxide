/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade texture builder on a plain wall picture (buildFacadeTextureFromImage, behind the facade_texture_build tool),
 * with fake model clients: the picture's grey hole is sent as unseen and the redraw that fills it is kept; a redraw that
 * shears the lower storeys sideways is refused by the quality score when the infill cannot mend it.
 */

import { describe, expect, it } from 'vitest';
import { buildFacadeTexture, buildFacadeTextureFromImage } from '../src/node/3d-engine/staged-location/facade-texture/facade-texture';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import type { PlateRequest } from '../src/node/3d-engine/staged-location/pipeline-e/enhance';

const PX = 0.05, W = 200, H = 160;

/** A 10 m x 8 m brick facade with piers every 2 m, windows and a string course (as the quality tests). */
function facade(): Uint8Array {
    let r = 7;
    const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
    const G = 8, gw = Math.ceil(W / G) + 2;
    const grid = Array.from({ length: gw * (Math.ceil(H / G) + 2) }, rnd);
    const noise = (x: number, y: number) => {
        const gx = x / G, gy = y / G, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, v = (i: number, j: number) => grid[j * gw + i];
        return (1 - fx) * (1 - fy) * v(x0, y0) + fx * (1 - fy) * v(x0 + 1, y0) + (1 - fx) * fy * v(x0, y0 + 1) + fx * fy * v(x0 + 1, y0 + 1);
    };
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = x * PX, t = (H - 1 - y) * PX, bay = s % 2;
        let c = [150 + 30 * noise(x, y), 70 + 20 * noise(x + 50, y), 60 + 15 * noise(x, y + 50)];
        if (bay < 0.3) c = [110 + 20 * noise(x, y), 50, 45];
        else if (bay > 0.7 && bay < 1.6 && (t % 2.6) > 0.6 && (t % 2.6) < 2.0) c = [40, 45, 55];
        if (t > 4 && t < 4.3) c = [205, 195, 175];
        out.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], (y * W + x) * 4);
    }
    return out;
}

/** `img` (W x H) centred on a grey canvas of the request's size: the model's answer at the padded framing. */
function answer(img: Uint8Array, r: PlateRequest): Uint8Array {
    const out = new Uint8Array(r.width * r.height * 4).fill(128);
    const ox = Math.floor((r.width - W) / 2), oy = Math.floor((r.height - H) / 2);
    for (let y = 0; y < H; y++) out.set(img.subarray(y * W * 4, (y + 1) * W * 4), ((y + oy) * r.width + ox) * 4);
    return new Uint8Array(encodePng(r.width, r.height, Buffer.from(out), 4));
}

describe('facade texture from a wall picture', () => {
    it('sends the grey hole as unseen and keeps the redraw that draws it as the wall continues', async () => {
        const truth = facade();
        const input = truth.slice();
        for (let y = 100; y < H; y++) for (let x = 20; x < 80; x++) input.set([128, 128, 128, 255], (y * W + x) * 4);
        const sent: PlateRequest[] = [];
        const client = async (r: PlateRequest) => { sent.push(r); return { bytes: answer(truth, r), modelUsed: 'fake' }; };
        const res = await buildFacadeTextureFromImage({ image: { width: W, height: H, rgba: input }, widthM: W * PX, heightM: H * PX, locationName: 'X', client, models: ['fake-lite'], unseenModels: ['fake-full'] });
        expect(sent.length).toBe(1);
        // a wall with unseen areas goes to the model that fills them
        expect(sent[0].models).toEqual(['fake-full']);
        expect(sent[0].prompt).toMatch(/grey/i);
        expect(res.coveredShare).toBeCloseTo(1 - (60 * 60) / (W * H), 3);
        expect(res.accepted).toBe(true);
        expect(res.quality?.passed).toBe(true);
        // the hole is drawn: the texture there is the truth's, not grey
        const i = (130 * W + 50) * 4;
        expect(Array.from(res.texture!.rgba.subarray(i, i + 3))).toEqual(Array.from(truth.subarray(i, i + 3)));
    });

    it('refuses a redraw whose lower storeys jump sideways, when the infill cannot mend the seam', async () => {
        const truth = facade(), sheared = truth.slice(), shift = Math.round(0.6 / PX);
        for (let y = 100; y < H; y++) for (let x = 0; x < W; x++) sheared.set(truth.subarray((y * W + ((x + shift) % W)) * 4, (y * W + ((x + shift) % W)) * 4 + 4), (y * W + x) * 4);
        const client = async (r: PlateRequest) => ({ bytes: answer(sheared, r), modelUsed: 'fake' });
        // the infill model answers with the holes still magenta: the inpaint lock refuses it
        const infill = async (q: { image: { bytes: Uint8Array } }) => ({ bytes: q.image.bytes, modelUsed: 'fake-infill' });
        const models: string[][] = [];
        const seenClient = async (r: PlateRequest) => { models.push(r.models); return client(r); };
        const res = await buildFacadeTextureFromImage({ image: { width: W, height: H, rgba: truth }, widthM: W * PX, heightM: H * PX, locationName: 'X', client: seenClient, models: ['fake'], unseenModels: ['fake-full'], infill: { client: infill as never, models: ['fake-infill'] } });
        expect(res.accepted).toBe(false);
        expect(res.quality?.seams).toBeGreaterThan(0);
        expect(res.infill?.decision).toBe('rejected');
        expect(res.why).toMatch(/seam/);
        expect(res.texture).toBeUndefined();
        // a fully seen wall keeps the redraw model
        expect(models).toEqual([['fake']]);
        void decodeImageInMemory;
    });

    it('counts storeys and bays on what the survey saw, not on the fill sent in its place', async () => {
        const truth = facade(), fill = new Uint8Array(W * H * 4), use = new Uint8Array(W * H).fill(1);
        for (let i = 0; i < W * H; i++) fill.set([200, 30, 30, 255], i * 4);
        for (let y = 0; y < 30; y++) for (let x = 0; x < W; x++) use[y * W + x] = 0;
        let counted: Uint8Array | undefined, sentImage: Uint8Array | undefined;
        const counter = async (tile: Uint8Array) => { counted = tile; return { tile: { storeys: 3, bays: 5 }, plate: { storeys: 3, bays: 5 } }; };
        const client = async (r: PlateRequest) => { sentImage = r.image; return { bytes: answer(truth, r), modelUsed: 'fake' }; };
        const face = { index: 0, key: 'w', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true, normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0], sMin: 0, sMax: W * PX, tMin: 0, tMax: H * PX, tBottom: 0, area: W * H * PX * PX, pixel: PX, orthoSMin: 0, orthoTMax: H * PX, width: W, height: H, coverage: 1, openings: [], top: [] };
        await buildFacadeTexture(face as never, { width: W, height: H, rgba: truth.slice(), source: new Uint8Array(W * H) }, use, { client, models: ['fake'], locationName: 'X', source: 1, guards: false, counter: counter as never, unseen: { source: 1, fill } });
        const sent = decodeImageInMemory(sentImage!), seen = decodeImageInMemory(counted!);
        // the model got the fill (red) in the unseen top strip; the counter got grey there
        const top = (img: { width: number; rgba: Uint8Array }, x: number, y: number) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
        const cx = Math.floor(seen.width / 2);
        expect(top(seen, cx, 2)).toEqual([128, 128, 128]);
        expect(sent.rgba.some((v, k) => k % 4 === 0 && v > 180 && sent.rgba[k + 1] < 60)).toBe(true);
    });

    it('tells the model the bottom of the wall is the street level to draw as the ground floor, in its own pixels', async () => {
        const prompts: string[] = [];
        const client = async (r: PlateRequest) => { prompts.push(r.prompt); return { bytes: answer(facade(), r), modelUsed: 'fake' }; };
        const face = { index: 0, key: 'w', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true, normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0], sMin: 0, sMax: W * PX, tMin: 0, tMax: H * PX, tBottom: 0, area: W * H * PX * PX, pixel: PX, orthoSMin: 0, orthoTMax: H * PX, width: W, height: H, coverage: 1, openings: [], top: [] };
        const mk = () => ({ width: W, height: H, rgba: facade(), source: new Uint8Array(W * H) });
        await buildFacadeTexture(face as never, mk(), new Uint8Array(W * H).fill(1), { client, models: ['fake'], locationName: 'X', source: 1, guards: false, streetBandM: 2.5 });
        await buildFacadeTexture(face as never, mk(), new Uint8Array(W * H).fill(1), { client, models: ['fake'], locationName: 'X', source: 1, guards: false });
        expect(prompts[0]).toMatch(/lowest 2\.5 m of the wall\) is street level/);
        expect(prompts[0]).toMatch(/draw no vehicles, people, poles or street furniture/);
        // 2.5 m of an 8 m wall drawn 160 px tall: 50 px of plate, plus whatever padding lies below it
        const px = Number(/The bottom (\d+) px of the plate/.exec(prompts[0])![1]);
        expect(px).toBeGreaterThanOrEqual(50);
        expect(prompts[1]).not.toMatch(/street level/);
    });
});

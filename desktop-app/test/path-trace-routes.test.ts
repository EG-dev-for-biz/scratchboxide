/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * /3d/path-trace on the standalone server: the viewport's contract (open by served sbvg URL, views that
 * follow the camera, frames polled by sequence and sample count, close). The session part runs on macOS
 * with a ray tracing Metal device and skips elsewhere; the validation part runs everywhere.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStandaloneServer } from '../server/app';
import { MetalPathTracerService, VirtualGeometryBuildService, VIRTUAL_GEOMETRY_URL_PREFIX } from '../../packages/core/src/node';

function sphereGlb(): Buffer {
    const rings = 24, segments = 48, pos: number[] = [], idx: number[] = [];
    for (let r = 0; r <= rings; r++) for (let s = 0; s <= segments; s++) {
        const phi = Math.PI * r / rings, th = 2 * Math.PI * s / segments;
        pos.push(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
    }
    for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
        const a = r * (segments + 1) + s, b = a + segments + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const p = new Float32Array(pos), i = new Uint32Array(idx);
    const pb = Buffer.from(p.buffer), ib = Buffer.from(i.buffer);
    const bin = Buffer.concat([pb, ib]);
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: p.length / 3, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
            { bufferView: 1, componentType: 5125, count: i.length, type: 'SCALAR' }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pb.length }, { buffer: 0, byteOffset: pb.length, byteLength: ib.length }],
        buffers: [{ byteLength: bin.length }]
    };
    let js = Buffer.from(JSON.stringify(json));
    js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jh, js, bh, bin]);
}

describe('/3d/path-trace routes', () => {
    let server: http.Server;
    let base = '';
    let token = '';
    let workspaceRoot = '';
    let raytracing = false;

    beforeAll(async () => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pathtrace-routes-'));
        process.env.SCRATCHBOX_WORKSPACE_ROOTS = os.tmpdir();
        process.env.SCRATCHBOX_VIRTUAL_GEOMETRY_CACHE = path.join(workspaceRoot, 'vg-cache');
        delete process.env.SCRATCHBOX_LAUNCH_TOKEN;
        const app = createStandaloneServer({ port: 0, toolsPort: 3997 });
        token = app.locals.launchToken;
        server = http.createServer(app);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/3d/path-trace`;
        raytracing = (await new MetalPathTracerService().probe()).raytracing;
    }, 120_000);

    afterAll(async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    const post = async (route: string, body: unknown) => {
        const res = await fetch(`${base}${route}`, {
            method: 'POST',
            headers: { 'X-Scratchbox-Token': token, 'Content-Type': 'application/json', Connection: 'close' },
            body: JSON.stringify(body)
        });
        return { status: res.status, json: await res.json() };
    };

    it('refuses an sbvgUrl outside the served virtual geometry files and an unknown session', async () => {
        const outside = await post('/open', { sbvgUrl: '/etc/passwd' });
        expect(outside.status).toBe(422);
        expect(outside.json.error).toMatch(/served virtual geometry file/);
        const traversal = await post('/open', { sbvgUrl: `${VIRTUAL_GEOMETRY_URL_PREFIX}/../x.sbvg` });
        expect(traversal.status).toBe(422);
        const missing = await post('/open', { sbvgUrl: `${VIRTUAL_GEOMETRY_URL_PREFIX}/doesnotexist.sbvg` });
        expect(missing.status).toBe(422);
        expect(missing.json.error).toMatch(/not on the server/);
        const view = await post('/view', { sessionId: 'nope', width: 64, height: 64 });
        expect(view.status).toBe(404);
        const frame = await fetch(`${base}/frame?sessionId=nope`, { headers: { 'X-Scratchbox-Token': token, Connection: 'close' } });
        expect(frame.status).toBe(404);
        const closed = await post('/close', { sessionId: 'nope' });
        expect(closed.json).toEqual({ success: true, closed: false });
    });

    it('opens a session for a served file, follows views and serves frames by sequence and sample count', async ctx => {
        if (!raytracing) return ctx.skip();
        const glb = path.join(workspaceRoot, 'sphere.glb');
        fs.writeFileSync(glb, sphereGlb());
        const served = await new VirtualGeometryBuildService().buildServed(glb);
        const opened = await post('/open', { sbvgUrl: served.sbvgUrl, sourceGlbPath: 'sphere.glb', workspaceRoot, lighting: { studio: {} } });
        expect(opened.status).toBe(200);
        expect(opened.json).toMatchObject({ success: true, materials: { source: 'glb', count: 0 } });
        const sessionId: string = opened.json.sessionId;
        try {
            const view = await post('/view', { sessionId, width: 96, height: 64, camera: { position: [0, 0, 4], target: [0, 0, 0], verticalFovDeg: 35 }, targetSpp: 6 });
            expect(view.status).toBe(200);
            expect(view.json).toMatchObject({ success: true, seq: 1, lighting: 'studio', targetSpp: 6 });
            const headers = { 'X-Scratchbox-Token': token, Connection: 'close' };
            let after = '';
            let done = false;
            let frames = 0;
            const deadline = Date.now() + 20_000;
            while (!done && Date.now() < deadline) {
                const res = await fetch(`${base}/frame?sessionId=${sessionId}&after=${after}`, { headers });
                if (res.status === 204) { await new Promise(r => setTimeout(r, 30)); continue; }
                expect(res.status).toBe(200);
                expect(res.headers.get('content-type')).toContain('application/octet-stream');
                expect(res.headers.get('access-control-expose-headers')).toContain('X-Frame-Seq');
                const bytes = Buffer.from(await res.arrayBuffer());
                expect(bytes.length).toBe(96 * 64 * 4);
                after = `${res.headers.get('x-frame-seq')}.${res.headers.get('x-frame-spp')}`;
                done = res.headers.get('x-frame-done') === '1';
                frames++;
            }
            expect(done).toBe(true);
            expect(frames).toBeGreaterThan(0);
            // The same frame is not sent twice.
            const again = await fetch(`${base}/frame?sessionId=${sessionId}&after=${after}`, { headers });
            expect(again.status).toBe(204);
        } finally {
            const closed = await post('/close', { sessionId });
            expect(closed.json).toEqual({ success: true, closed: true });
        }
    }, 120_000);

    const postGlb = async (bytes: Buffer) => {
        const res = await fetch(`${base}/snapshot`, {
            method: 'POST',
            headers: { 'X-Scratchbox-Token': token, 'Content-Type': 'model/gltf-binary', Connection: 'close' },
            body: new Uint8Array(bytes)
        });
        return { status: res.status, json: await res.json() };
    };

    it('refuses a snapshot that is not a GLB, an unknown snapshot id and a still for an unknown session', async () => {
        const notGlb = await postGlb(Buffer.from('not a glb at all, just text'));
        expect(notGlb.status).toBe(400);
        expect(notGlb.json.error).toMatch(/binary GLB/);
        const unknown = await post('/open', { sbvgUrl: `${VIRTUAL_GEOMETRY_URL_PREFIX}/doesnotexist.sbvg`, snapshotId: 'zz' });
        expect(unknown.status).toBe(422);
        const still = await post('/render', { sessionId: 'nope', width: 64, height: 64, camera: { position: [0, 0, 4], target: [0, 0, 0] } });
        expect(still.status).toBe(404);
    });

    it('builds a viewport snapshot once, opens it with the camera offset by the file origin, and saves a still in the workspace', async ctx => {
        // The sphere moved off the origin: the file stores vertices relative to its own centre, which /snapshot reports.
        const shifted = sphereGlb();
        const json = JSON.parse(shifted.subarray(20, 20 + shifted.readUInt32LE(12)).toString('utf8'));
        json.nodes[0].translation = [100, 5, -40];
        let js = Buffer.from(JSON.stringify(json));
        js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
        const binStart = 20 + shifted.readUInt32LE(12);
        const bin = shifted.subarray(binStart);
        const header = Buffer.alloc(12);
        header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + bin.length, 8);
        const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
        const glb = Buffer.concat([header, jh, js, bin]);

        const first = await postGlb(glb);
        expect(first.status).toBe(200);
        expect(first.json.snapshotId).toMatch(/^[0-9a-f]{32}$/);
        expect(first.json.sbvgUrl.startsWith(`${VIRTUAL_GEOMETRY_URL_PREFIX}/`)).toBe(true);
        expect(first.json.cached).toBe(false);
        // Traced whole: the leaf clusters only, no LOD pyramid and no atlases.
        expect(first.json.summary).toMatchObject({ levelCount: 1, atlasCount: 0 });
        expect(first.json.origin[0]).toBeCloseTo(100, 3);
        expect(first.json.origin[1]).toBeCloseTo(5, 3);
        expect(first.json.origin[2]).toBeCloseTo(-40, 3);
        const again = await postGlb(glb);
        expect(again.json).toMatchObject({ snapshotId: first.json.snapshotId, sbvgUrl: first.json.sbvgUrl, cached: true });

        if (!raytracing) return ctx.skip();
        const opened = await post('/open', { sbvgUrl: first.json.sbvgUrl, snapshotId: first.json.snapshotId, lighting: { sun: { elevationDeg: 40, azimuthDeg: 135 } } });
        expect(opened.status).toBe(200);
        expect(opened.json.origin[0]).toBeCloseTo(100, 3);
        const sessionId: string = opened.json.sessionId;
        try {
            // The world camera (100, 5, -36) looking at the sphere's world centre, in file coordinates.
            const camera = { position: [0, 0, 4], target: [0, 0, 0], verticalFovDeg: 35 };
            const still = await post('/render', { sessionId, width: 120, height: 80, samplesPerPixel: 16, camera, workspaceRoot, name: 'Snapshot Sphere' });
            expect(still.status).toBe(200);
            expect(still.json.path).toMatch(/^renders\/path-traced\/snapshot_sphere-.+\.png$/);
            const png = fs.readFileSync(path.join(workspaceRoot, still.json.path));
            expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
            expect(png.readUInt32BE(16)).toBe(120);
            expect(png.readUInt32BE(20)).toBe(80);
            const record = JSON.parse(fs.readFileSync(path.join(workspaceRoot, still.json.path.replace(/\.png$/, '.json')), 'utf8'));
            expect(record).toMatchObject({ width: 120, height: 80, samplesPerPixel: 16, denoised: true, lighting: { sun: { elevationDeg: 40, azimuthDeg: 135 } } });
            // The sphere fills the middle of the frame: the camera reached it through the origin offset (a camera
            // left in world coordinates would look at empty space 100 m away).
            expect(record.cut.triangles).toBeGreaterThan(1000);
            expect(record.geometryCoverage).toBeGreaterThan(0.25);

            // A change of light reaches the open session with no capture and no build: a point light given in the
            // GLB's world coordinates is moved into the file's by its origin, and the next view samples it.
            const relit = await post('/lights', { sessionId, lighting: { studio: { radiance: [0, 0, 0] } }, lights: [{ position: [100, 5, -36], direction: [0, 0, -1], intensity: [20, 20, 20] }] });
            expect(relit.status).toBe(200);
            expect(relit.json).toMatchObject({ success: true, lights: 1 });
            const view = await post('/view', { sessionId, width: 64, height: 48, camera, targetSpp: 4 });
            expect(view.status).toBe(200);
            expect(view.json.lights).toMatchObject({ sampling: true, points: 1, distant: 0 });
            expect(view.json.lighting).toBe('studio');
            const lampStill = await post('/render', { sessionId, width: 64, height: 48, samplesPerPixel: 8, camera, workspaceRoot, name: 'Lamp Sphere' });
            expect(lampStill.status).toBe(200);
            // Lit by the lamp alone in a black dome: the sphere is bright, the background black.
            const lampRecord = JSON.parse(fs.readFileSync(path.join(workspaceRoot, lampStill.json.path.replace(/\.png$/, '.json')), 'utf8'));
            expect(lampRecord.lighting).toMatchObject({ studio: { radiance: [0, 0, 0] } });
        } finally {
            await post('/close', { sessionId });
        }
    }, 180_000);
});

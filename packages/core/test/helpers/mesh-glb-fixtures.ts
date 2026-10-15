/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Test-only input meshes written as binary glTF 2.0. The native mesh pipelines (mesh reshaping, UTDRA) only ever
 * process a GLB they are given; these synthetic shapes are what the tests give them. Each one is built the way
 * the pipelines' former built-in benchmark meshes were (same dimensions, vertex colours and normals), so
 * classification tests keep their meaning.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FixtureMesh {
    positions: number[];
    indices: number[];
    /** Per-vertex normals; computed from the triangles (area-weighted, like the engine) when absent. */
    normals?: number[];
    /** Per-vertex RGBA in 0..1. */
    colors?: number[];
}

type V3 = [number, number, number];
type V4 = [number, number, number, number];

class Builder {
    readonly positions: number[] = [];
    readonly normals: number[] = [];
    readonly colors: number[] = [];
    readonly indices: number[] = [];

    vertex(p: V3, n: V3, c: V4): number {
        this.positions.push(...p);
        this.normals.push(...n);
        this.colors.push(...c);
        return this.positions.length / 3 - 1;
    }

    quad(p0: V3, p1: V3, p2: V3, p3: V3, n: V3, c: V4): void {
        const b = this.vertex(p0, n, c);
        this.vertex(p1, n, c); this.vertex(p2, n, c); this.vertex(p3, n, c);
        this.indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }

    tri(p0: V3, p1: V3, p2: V3, n: V3, c: V4): void {
        const b = this.vertex(p0, n, c);
        this.vertex(p1, n, c); this.vertex(p2, n, c);
        this.indices.push(b, b + 1, b + 2);
    }

    mesh(recomputeNormals: boolean): FixtureMesh {
        return {
            positions: this.positions,
            indices: this.indices,
            normals: recomputeNormals ? computeVertexNormals(this.positions, this.indices) : this.normals,
            colors: this.colors
        };
    }
}

/** Area-weighted vertex normals (sum of unnormalised face normals, then normalised), as ScratchboxMesh::recomputeNormals. */
export function computeVertexNormals(positions: number[], indices: number[]): number[] {
    const n = new Array(positions.length).fill(0);
    for (let t = 0; t + 2 < indices.length; t += 3) {
        const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
        const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
        const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
        const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        for (const v of [a, b, c]) { n[v] += f[0]; n[v + 1] += f[1]; n[v + 2] += f[2]; }
    }
    for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
}

/** Writes one mesh (one primitive, no node transform) as a GLB with POSITION, NORMAL, COLOR_0 and uint32 indices. */
export function writeFixtureGlb(file: string, mesh: FixtureMesh): string {
    const views: Buffer[] = [];
    const bufferViews: object[] = [];
    const accessors: object[] = [];
    let offset = 0;
    const add = (bytes: Buffer, target: number, accessor: object) => {
        const pad = (4 - (bytes.length % 4)) % 4;
        views.push(bytes, Buffer.alloc(pad));
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
        accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
        offset += bytes.length + pad;
        return accessors.length - 1;
    };
    const vertexCount = mesh.positions.length / 3;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i++) {
        const v = Math.fround(mesh.positions[i]);
        min[i % 3] = Math.min(min[i % 3], v);
        max[i % 3] = Math.max(max[i % 3], v);
    }
    const attributes: Record<string, number> = {
        POSITION: add(Buffer.from(new Float32Array(mesh.positions).buffer), 34962, { componentType: 5126, count: vertexCount, type: 'VEC3', min, max })
    };
    const normals = mesh.normals ?? computeVertexNormals(mesh.positions, mesh.indices);
    attributes.NORMAL = add(Buffer.from(new Float32Array(normals).buffer), 34962, { componentType: 5126, count: vertexCount, type: 'VEC3' });
    if (mesh.colors) {
        attributes.COLOR_0 = add(Buffer.from(new Float32Array(mesh.colors).buffer), 34962, { componentType: 5126, count: vertexCount, type: 'VEC4' });
    }
    const indices = add(Buffer.from(new Uint32Array(mesh.indices).buffer), 34963, { componentType: 5125, count: mesh.indices.length, type: 'SCALAR' });
    const bin = Buffer.concat(views);
    const doc = {
        asset: { version: '2.0', generator: 'scratchbox test fixture' },
        buffers: [{ byteLength: bin.length }],
        bufferViews,
        accessors,
        meshes: [{ primitives: [{ attributes, indices, mode: 4 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0
    };
    let json = Buffer.from(JSON.stringify(doc), 'utf8');
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(json.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(bin.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([header, jsonHeader, json, binHeader, bin]));
    return file;
}

/** The JSON chunk of a GLB file. */
export function readGlbJson(file: string): any {
    const buf = fs.readFileSync(file);
    return JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
}

/** Reads POSITION min/max of the first primitive (as written by writeFixtureGlb or the native GLB writer). */
export function readGlbPositions(file: string): { positions: Float32Array; min: V3; max: V3 } {
    const buf = fs.readFileSync(file);
    const jsonLen = buf.readUInt32LE(12);
    const doc = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
    const binStart = 20 + jsonLen + 8;
    const acc = doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION];
    const view = doc.bufferViews[acc.bufferView];
    const start = binStart + (view.byteOffset || 0) + (acc.byteOffset || 0);
    const positions = new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + acc.count * 12));
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
        min[i % 3] = Math.min(min[i % 3], positions[i]);
        max[i % 3] = Math.max(max[i % 3], positions[i]);
    }
    return { positions, min, max };
}

const TWO_PI = Math.PI * 2;

/** Open cylinder along Y (radius 1, height 4, 24 x 16 segments), centred at the origin. */
export function cylinderMesh(radius = 1, height = 4, radialSegments = 24, heightSegments = 16): FixtureMesh {
    const b = new Builder();
    for (let y = 0; y <= heightSegments; y++) {
        const posY = -height / 2 + (y / heightSegments) * height;
        for (let x = 0; x <= radialSegments; x++) {
            const a = (x / radialSegments) * TWO_PI;
            b.vertex([Math.cos(a) * radius, posY, Math.sin(a) * radius], [Math.cos(a), 0, Math.sin(a)], [0.85, 0.85, 0.88, 1]);
        }
    }
    const stride = radialSegments + 1;
    for (let y = 0; y < heightSegments; y++) {
        for (let x = 0; x < radialSegments; x++) {
            const i0 = y * stride + x, i1 = (y + 1) * stride + x, i2 = (y + 1) * stride + x + 1, i3 = y * stride + x + 1;
            b.indices.push(i0, i1, i2, i0, i2, i3);
        }
    }
    return b.mesh(false);
}

/** Lofted vase-like body (12 rings of 16 points, 6 tall), the former "sculpture" benchmark. */
export function sculptureMesh(): FixtureMesh {
    const b = new Builder();
    const rings = 12, points = 16, height = 6;
    for (let s = 0; s < rings; s++) {
        const t = s / (rings - 1);
        const r = 1 + 0.35 * Math.sin(t * Math.PI);
        for (let p = 0; p < points; p++) {
            const a = (p / points) * TWO_PI;
            b.vertex([Math.cos(a) * r, (t - 0.5) * height, Math.sin(a) * r * 0.9], [0, 0, 0], [0.8, 0.85, 0.95, 1]);
        }
    }
    for (let s = 0; s < rings - 1; s++) {
        for (let p = 0; p < points; p++) {
            const a = s * points + p, c = s * points + (p + 1) % points;
            b.indices.push(a, a + points, c + points, a, c + points, c);
        }
    }
    return b.mesh(true);
}

/** Three-tier tower on a podium (40 x 60 x 180 m by default); the former "urban" / "hybrid" benchmark. */
export function skyscraperMesh(width = 40, depth = 60, height = 180): FixtureMesh {
    const b = new Builder();
    const stone: V4 = [0.82, 0.80, 0.76, 1];
    const box = (hw: number, hd: number, y0: number, y1: number, roof: V4) => {
        b.quad([-hw, y0, -hd], [hw, y0, -hd], [hw, y1, -hd], [-hw, y1, -hd], [0, 0, -1], stone);
        b.quad([hw, y0, hd], [-hw, y0, hd], [-hw, y1, hd], [hw, y1, hd], [0, 0, 1], stone);
        b.quad([-hw, y0, hd], [-hw, y0, -hd], [-hw, y1, -hd], [-hw, y1, hd], [-1, 0, 0], stone);
        b.quad([hw, y0, -hd], [hw, y0, hd], [hw, y1, hd], [hw, y1, -hd], [1, 0, 0], stone);
        b.quad([-hw, y1, -hd], [hw, y1, -hd], [hw, y1, hd], [-hw, y1, hd], [0, 1, 0], roof);
    };
    const hw = width / 2, hd = depth / 2, h1 = height * 0.3, h2 = height * 0.8;
    box(hw, hd, 0, h1, [0.3, 0.3, 0.35, 1]);
    box(hw * 0.75, hd * 0.75, h1, h2, [0.3, 0.3, 0.35, 1]);
    box(hw * 0.5, hd * 0.5, h2, height, [0.25, 0.25, 0.28, 1]);
    return b.mesh(true);
}

/** Gabled house on a lawn (12 x 16 m, walls 4.5 m, ridge 7.5 m); the former "suburban" benchmark. */
export function suburbanHouseMesh(width = 12, depth = 16, wallHeight = 4.5, ridgeHeight = 7.5): FixtureMesh {
    const b = new Builder();
    const hw = width / 2, hd = depth / 2;
    const siding: V4 = [0.88, 0.85, 0.80, 1], roof: V4 = [0.28, 0.29, 0.32, 1], lawn: V4 = [0.22, 0.55, 0.18, 1];
    b.quad([-hw * 1.8, 0, -hd * 1.8], [hw * 1.8, 0, -hd * 1.8], [hw * 1.8, 0, hd * 1.8], [-hw * 1.8, 0, hd * 1.8], [0, 1, 0], lawn);
    b.quad([-hw, 0, -hd], [hw, 0, -hd], [hw, wallHeight, -hd], [-hw, wallHeight, -hd], [0, 0, -1], siding);
    b.quad([hw, 0, hd], [-hw, 0, hd], [-hw, wallHeight, hd], [hw, wallHeight, hd], [0, 0, 1], siding);
    b.quad([-hw, 0, hd], [-hw, 0, -hd], [-hw, wallHeight, -hd], [-hw, wallHeight, hd], [-1, 0, 0], siding);
    b.quad([hw, 0, -hd], [hw, 0, hd], [hw, wallHeight, hd], [hw, wallHeight, -hd], [1, 0, 0], siding);
    b.tri([-hw, wallHeight, -hd], [hw, wallHeight, -hd], [0, ridgeHeight, -hd], [0, 0, -1], siding);
    b.tri([hw, wallHeight, hd], [-hw, wallHeight, hd], [0, ridgeHeight, hd], [0, 0, 1], siding);
    b.quad([-hw - 0.4, wallHeight, -hd - 0.4], [0, ridgeHeight + 0.2, -hd - 0.4], [0, ridgeHeight + 0.2, hd + 0.4], [-hw - 0.4, wallHeight, hd + 0.4], [0, 1, 0], roof);
    b.quad([0, ridgeHeight + 0.2, -hd - 0.4], [hw + 0.4, wallHeight, -hd - 0.4], [hw + 0.4, wallHeight, hd + 0.4], [0, ridgeHeight + 0.2, hd + 0.4], [0, 1, 0], roof);
    return b.mesh(true);
}

/** A 12 m bridge deck over a false photogrammetric curtain wall reaching the ground; the former "bridge" benchmark. */
export function bridgeWithCurtainMesh(): FixtureMesh {
    const b = new Builder();
    b.tri([-10, 12, -2], [10, 12, -2], [10, 12, 2], [0, 1, 0], [0.35, 0.35, 0.38, 1]);
    b.tri([-10, 0, 0], [10, 0, 0], [10, 12, 0], [0, 0, 1], [0.6, 0.4, 0.3, 1]);
    return b.mesh(false);
}

/** Valley floor rising into a 220 m cliff (150 m span, 8 x 8 grid); the former "mountain" benchmark. */
export function alpineCliffMesh(baseSpan = 150, height = 220): FixtureMesh {
    const b = new Builder();
    const res = 8;
    for (let z = 0; z <= res; z++) {
        const fz = z / res;
        for (let x = 0; x <= res; x++) {
            const fx = x / res;
            const py = fz > 0.4 ? Math.pow((fz - 0.4) / 0.6, 1.8) * height : 0;
            b.vertex([(fx - 0.5) * baseSpan, py, (fz - 0.5) * baseSpan], [0, 1, 0], [0.5, 0.5, 0.5, 1]);
        }
    }
    for (let z = 0; z < res; z++) {
        for (let x = 0; x < res; x++) {
            const i0 = z * (res + 1) + x, i1 = i0 + 1, i2 = (z + 1) * (res + 1) + x, i3 = i2 + 1;
            b.indices.push(i0, i2, i1, i1, i2, i3);
        }
    }
    return b.mesh(true);
}

/** Six trees (trunk quad and a 16-triangle green crown each); the former "forest" benchmark. */
export function forestMesh(): FixtureMesh {
    const b = new Builder();
    for (let cluster = 0; cluster < 6; cluster++) {
        const cx = ((cluster % 3) - 1) * 12, cz = (Math.floor(cluster / 3) - 0.5) * 12;
        const trunkH = 10 + (cluster % 2) * 3;
        const bark: V4 = [0.38, 0.25, 0.15, 1];
        b.quad([cx - 0.4, 0, cz], [cx + 0.4, 0, cz], [cx + 0.3, trunkH, cz], [cx - 0.3, trunkH, cz], [1, 0, 0], bark);
        for (let i = 0; i < 16; i++) {
            const phi = (i / 16) * TWO_PI, nextPhi = ((i + 1) / 16) * TWO_PI;
            const r = 4.5 + Math.sin(phi * 3) * 0.8;
            const p0: V3 = [cx, trunkH + 4, cz];
            const p1: V3 = [cx + Math.cos(phi) * r, trunkH + 1, cz + Math.sin(phi) * r];
            const p2: V3 = [cx + Math.cos(nextPhi) * r, trunkH + 1, cz + Math.sin(nextPhi) * r];
            const leaf: V4 = [0.12, 0.68, 0.18, 1];
            const dir = (p: V3): V3 => { const d: V3 = [p[0] - cx, p[1] - trunkH, p[2] - cz]; const l = Math.hypot(...d) || 1; return [d[0] / l, d[1] / l, d[2] / l]; };
            const base = b.vertex(p0, [0, 1, 0], leaf);
            b.vertex(p1, dir(p1), leaf);
            b.vertex(p2, dir(p2), leaf);
            b.indices.push(base, base + 1, base + 2);
        }
    }
    return b.mesh(false);
}

/** Rewrites the JSON chunk of a GLB in place (e.g. to add a node transform or a texture), keeping its binary chunk. */
export function rewriteGlbJson(file: string, mutate: (gltf: any) => void): string {
    const buf = fs.readFileSync(file);
    const jsonLen = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
    mutate(gltf);
    const binChunk = buf.subarray(20 + jsonLen);
    let json = Buffer.from(JSON.stringify(gltf), 'utf8');
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + json.length + binChunk.length, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(json.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    fs.writeFileSync(file, Buffer.concat([header, jsonHeader, json, binChunk]));
    return file;
}

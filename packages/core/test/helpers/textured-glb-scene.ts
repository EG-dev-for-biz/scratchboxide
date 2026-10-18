/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * An independent reader and software renderer for textured GLB scenes, for tests: it shares no code with the
 * production box projection (not even the GLB parser), so a test that compares the two compares two implementations.
 *
 * `buildSceneGlb` writes small multi-node scenes (per-node transforms, shared meshes, extras, line primitives);
 * `readTexturedScene` reads one back with world-space positions, UVs and materials; `renderTexturedScene` rasterises it
 * with its albedo textures sampled through each primitive's own UVs and a REPEAT wrap, to a PNG for the screenshot record.
 */

import * as zlib from 'zlib';
import { decodePng } from '../../src/node/texture-processing';
import { encodeRgbaToPng } from './test-screenshot-helper';
import type { FixtureMesh } from './mesh-glb-fixtures';

type V3 = [number, number, number];

export interface SceneNodeSpec {
    name?: string;
    mesh?: number;
    translation?: V3;
    /** Quaternion x, y, z, w. */
    rotation?: [number, number, number, number];
    scale?: V3;
    children?: number[];
    extras?: Record<string, unknown>;
}

export interface SceneMeshSpec {
    name?: string;
    primitives: Array<{
        mesh: FixtureMesh;
        /** glTF primitive mode; 4 (default) triangles, 1 lines. */
        mode?: number;
        /** Leave POSITION out of the attributes. */
        omitPosition?: boolean;
        extras?: Record<string, unknown>;
    }>;
}

/** Writes a GLB with the given meshes and node graph (roots are the nodes no other node lists as a child). */
export function buildSceneGlb(meshes: SceneMeshSpec[], nodes: SceneNodeSpec[], extra: { rootExtras?: Record<string, unknown> } = {}): Buffer {
    const views: Buffer[] = [];
    const bufferViews: object[] = [];
    const accessors: object[] = [];
    let offset = 0;
    const add = (bytes: Buffer, target: number, accessor: object): number => {
        const pad = (4 - (bytes.length % 4)) % 4;
        views.push(bytes, Buffer.alloc(pad));
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
        accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
        offset += bytes.length + pad;
        return accessors.length - 1;
    };
    const gltfMeshes = meshes.map(m => ({
        ...(m.name !== undefined ? { name: m.name } : {}),
        primitives: m.primitives.map(p => {
            const mesh = p.mesh;
            const count = mesh.positions.length / 3;
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < mesh.positions.length; i++) {
                const v = Math.fround(mesh.positions[i]);
                min[i % 3] = Math.min(min[i % 3], v); max[i % 3] = Math.max(max[i % 3], v);
            }
            const attributes: Record<string, number> = {};
            if (!p.omitPosition) attributes.POSITION = add(Buffer.from(new Float32Array(mesh.positions).buffer), 34962, { componentType: 5126, count, type: 'VEC3', min, max });
            if (mesh.normals) attributes.NORMAL = add(Buffer.from(new Float32Array(mesh.normals).buffer), 34962, { componentType: 5126, count, type: 'VEC3' });
            if (mesh.colors) attributes.COLOR_0 = add(Buffer.from(new Float32Array(mesh.colors).buffer), 34962, { componentType: 5126, count, type: 'VEC4' });
            if (mesh.uvs) attributes.TEXCOORD_0 = add(Buffer.from(new Float32Array(mesh.uvs).buffer), 34962, { componentType: 5126, count, type: 'VEC2' });
            const indices = add(Buffer.from(new Uint32Array(mesh.indices).buffer), 34963, { componentType: 5125, count: mesh.indices.length, type: 'SCALAR' });
            return { attributes, indices, mode: p.mode ?? 4, ...(p.extras ? { extras: p.extras } : {}) };
        })
    }));
    const isChild = new Set<number>();
    nodes.forEach(n => (n.children ?? []).forEach(c => isChild.add(c)));
    const bin = Buffer.concat(views);
    const doc: Record<string, unknown> = {
        asset: { version: '2.0', generator: 'scratchbox test scene' },
        buffers: [{ byteLength: bin.length }],
        bufferViews, accessors, meshes: gltfMeshes, nodes,
        scenes: [{ nodes: nodes.map((_, i) => i).filter(i => !isChild.has(i)) }],
        scene: 0,
        ...(extra.rootExtras ? { extras: extra.rootExtras } : {})
    };
    let json = Buffer.from(JSON.stringify(doc), 'utf8');
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jh, json, bh, bin]);
}

// ---------------------------------------------------------------------------------------------------------------------

export interface ReadPrimitive {
    nodeIndex: number;
    nodeName?: string;
    meshIndex: number;
    meshName?: string;
    primitiveIndex: number;
    mode: number;
    attributeKeys: string[];
    localPositions: Float32Array;
    worldPositions: Float64Array;
    indices: Uint32Array;
    uvs: Record<string, Float32Array>;
    materialIndex?: number;
}

export interface TexturedScene {
    json: any;
    bin: Buffer;
    primitives: ReadPrimitive[];
    /** The primitive's material resolved to image buffers (PNG bytes) per slot, or undefined when it has no material. */
    material(index: number | undefined): undefined | {
        baseColor?: { image: Buffer; texCoord: number; sampler: any };
        normal?: { image: Buffer; texCoord: number; scale?: number };
        occlusion?: { image: Buffer; texCoord: number };
        metallicRoughness?: { image: Buffer; texCoord: number };
        raw: any;
    };
}

function mul(a: number[], b: number[]): number[] {
    const r = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k]; r[c * 4 + row] = s; }
    return r;
}

function trs(n: SceneNodeSpec | any): number[] {
    if (Array.isArray(n.matrix)) return [...n.matrix];
    const t = n.translation ?? [0, 0, 0], s = n.scale ?? [1, 1, 1], [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
    return [
        (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + w * z) * s[0], 2 * (x * z - w * y) * s[0], 0,
        2 * (x * y - w * z) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + w * x) * s[1], 0,
        2 * (x * z + w * y) * s[2], 2 * (y * z - w * x) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
        t[0], t[1], t[2], 1
    ];
}

export function readTexturedScene(glb: Buffer): TexturedScene {
    if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
    const binStart = 20 + jsonLen + 8;
    const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen));
    const read = (accessorIndex: number): { data: number[]; components: number; count: number } => {
        const a = json.accessors[accessorIndex];
        const view = json.bufferViews[a.bufferView];
        const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[a.type];
        const size = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[a.componentType];
        const stride = view.byteStride || components * size;
        const base = (view.byteOffset || 0) + (a.byteOffset || 0);
        const data: number[] = [];
        for (let i = 0; i < a.count; i++) {
            for (let c = 0; c < components; c++) {
                const p = base + i * stride + c * size;
                data.push(a.componentType === 5126 ? bin.readFloatLE(p) : a.componentType === 5125 ? bin.readUInt32LE(p) : a.componentType === 5123 ? bin.readUInt16LE(p) : bin[p]);
            }
        }
        return { data, components, count: a.count };
    };

    const primitives: ReadPrimitive[] = [];
    const nodes: any[] = json.nodes ?? [];
    const isChild = new Set<number>();
    nodes.forEach(n => (n.children ?? []).forEach((c: number) => isChild.add(c)));
    const roots: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter(i => !isChild.has(i));
    const walk = (ni: number, parent: number[]): void => {
        const node = nodes[ni];
        const world = mul(parent, trs(node));
        if (node.mesh !== undefined) {
            const mesh = json.meshes[node.mesh];
            mesh.primitives.forEach((prim: any, pi: number) => {
                const posAccessor = prim.attributes.POSITION;
                const local = posAccessor !== undefined ? Float32Array.from(read(posAccessor).data) : new Float32Array(0);
                const wp = new Float64Array(local.length);
                for (let v = 0; v < local.length / 3; v++) {
                    const x = local[v * 3], y = local[v * 3 + 1], z = local[v * 3 + 2];
                    wp[v * 3] = world[0] * x + world[4] * y + world[8] * z + world[12];
                    wp[v * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
                    wp[v * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
                }
                const uvs: Record<string, Float32Array> = {};
                for (const [k, ai] of Object.entries(prim.attributes) as Array<[string, number]>) if (/^TEXCOORD_\d+$/.test(k)) uvs[k] = Float32Array.from(read(ai).data);
                primitives.push({
                    nodeIndex: ni, nodeName: node.name, meshIndex: node.mesh, meshName: mesh.name, primitiveIndex: pi, mode: prim.mode ?? 4,
                    attributeKeys: Object.keys(prim.attributes), localPositions: local, worldPositions: wp,
                    indices: prim.indices !== undefined ? Uint32Array.from(read(prim.indices).data) : Uint32Array.from({ length: local.length / 3 }, (_, i) => i),
                    uvs, materialIndex: prim.material
                });
            });
        }
        (node.children ?? []).forEach((c: number) => walk(c, world));
    };
    roots.forEach(r => walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));

    const imageBytes = (textureIndex: number): { image: Buffer; sampler: any } => {
        const tex = json.textures[textureIndex];
        const img = json.images[tex.source];
        const view = json.bufferViews[img.bufferView];
        const start = view.byteOffset || 0;
        return { image: bin.subarray(start, start + view.byteLength), sampler: tex.sampler !== undefined ? json.samplers[tex.sampler] : undefined };
    };
    const info = (ti: any) => (ti ? { ...imageBytes(ti.index), texCoord: ti.texCoord ?? 0, scale: ti.scale } : undefined);
    return {
        json, bin, primitives,
        material(index) {
            if (index === undefined) return undefined;
            const m = json.materials[index];
            const pbr = m.pbrMetallicRoughness ?? {};
            return {
                baseColor: info(pbr.baseColorTexture) as any, normal: info(m.normalTexture) as any,
                occlusion: info(m.occlusionTexture) as any, metallicRoughness: info(pbr.metallicRoughnessTexture) as any, raw: m
            };
        }
    };
}

/** [width, height] of a PNG from its IHDR; throws when it is not a PNG. */
export function pngSize(png: Buffer): [number, number] {
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG');
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

/** The dominant world-normal axis of a triangle (0 x, 1 y, 2 z), ties going to the lower axis. */
export function dominantAxis(p: Float64Array, a: number, b: number, c: number): number {
    const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const e2 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
    const n = [Math.abs(e1[1] * e2[2] - e1[2] * e2[1]), Math.abs(e1[2] * e2[0] - e1[0] * e2[2]), Math.abs(e1[0] * e2[1] - e1[1] * e2[0])];
    return n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2;
}

export interface RenderedScene {
    png: Buffer;
    /** Pixels the model covers, and the standard deviation of their luma: a blank or flat render fails both. */
    coveredPixels: number;
    lumaStdDev: number;
}

/** Software-renders the scene's triangles with their albedo textures (REPEAT, bilinear) through their own UVs and simple lighting. */
export function renderTexturedScene(scene: TexturedScene, view: { width?: number; height?: number; azimuthDeg?: number; elevationDeg?: number } = {}): RenderedScene {
    const W = view.width ?? 640, H = view.height ?? 480;
    const az = ((view.azimuthDeg ?? 35) * Math.PI) / 180, el = ((view.elevationDeg ?? 22) * Math.PI) / 180;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of scene.primitives) for (let i = 0; i < p.worldPositions.length; i++) { min[i % 3] = Math.min(min[i % 3], p.worldPositions[i]); max[i % 3] = Math.max(max[i % 3], p.worldPositions[i]); }
    const centre = [0, 1, 2].map(a => (min[a] + max[a]) / 2);
    const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
    const dist = radius * 3.1;
    const eye = [centre[0] + dist * Math.cos(el) * Math.sin(az), centre[1] + dist * Math.sin(el), centre[2] + dist * Math.cos(el) * Math.cos(az)];
    const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const fwd = norm(sub(centre, eye)), right = norm(cross(fwd, [0, 1, 0])), up = cross(right, fwd);
    const focal = (0.5 * H) / Math.tan((30 * Math.PI) / 360);
    const light = norm([0.5, 0.8, 0.6]);

    const textures = new Map<number, { w: number; h: number; rgba: Buffer }>();
    const albedo = (materialIndex: number | undefined) => {
        if (materialIndex === undefined) return undefined;
        const key = materialIndex;
        if (!textures.has(key)) {
            const m = scene.material(materialIndex);
            if (!m?.baseColor) return undefined;
            const d: any = decodePng(m.baseColor.image);
            textures.set(key, { w: d.width, h: d.height, rgba: d.data ?? d.rgba ?? d.pixels });
        }
        return textures.get(key);
    };

    const rgba = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; const t = y / H; rgba[o] = 120 - 25 * t; rgba[o + 1] = 124 - 25 * t; rgba[o + 2] = 132 - 25 * t; rgba[o + 3] = 255; }
    const zbuf = new Float32Array(W * H).fill(Infinity);
    let covered = 0;
    const project = (wp: Float64Array, i: number) => {
        const rel = [wp[i * 3] - eye[0], wp[i * 3 + 1] - eye[1], wp[i * 3 + 2] - eye[2]];
        const z = dot(rel, fwd);
        return { x: W / 2 + (focal * dot(rel, right)) / z, y: H / 2 - (focal * dot(rel, up)) / z, z };
    };
    for (const p of scene.primitives) {
        if (p.mode !== 4) continue;
        const uv = p.uvs.TEXCOORD_0 ?? Object.values(p.uvs)[0];
        const tex = albedo(p.materialIndex);
        const bcTex = scene.material(p.materialIndex)?.baseColor?.texCoord ?? 0;
        const uvSet = p.uvs[`TEXCOORD_${bcTex}`] ?? uv;
        for (let t = 0; t + 2 < p.indices.length; t += 3) {
            const ia = p.indices[t], ib = p.indices[t + 1], ic = p.indices[t + 2];
            const A = project(p.worldPositions, ia), B = project(p.worldPositions, ib), C = project(p.worldPositions, ic);
            if (A.z <= 0.01 || B.z <= 0.01 || C.z <= 0.01) continue;
            const n = norm(cross(sub([p.worldPositions[ib * 3], p.worldPositions[ib * 3 + 1], p.worldPositions[ib * 3 + 2]], [p.worldPositions[ia * 3], p.worldPositions[ia * 3 + 1], p.worldPositions[ia * 3 + 2]]),
                sub([p.worldPositions[ic * 3], p.worldPositions[ic * 3 + 1], p.worldPositions[ic * 3 + 2]], [p.worldPositions[ia * 3], p.worldPositions[ia * 3 + 1], p.worldPositions[ia * 3 + 2]])));
            const facing = Math.abs(dot(n, light));
            const shade = 0.35 + 0.65 * facing;
            const minX = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x))), maxX = Math.min(W - 1, Math.ceil(Math.max(A.x, B.x, C.x)));
            const minY = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y))), maxY = Math.min(H - 1, Math.ceil(Math.max(A.y, B.y, C.y)));
            const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
            if (Math.abs(area) < 1e-9) continue;
            for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
                const px = x + 0.5, py = y + 0.5;
                const w0 = ((B.x - px) * (C.y - py) - (C.x - px) * (B.y - py)) / area;
                const w1 = ((C.x - px) * (A.y - py) - (A.x - px) * (C.y - py)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const z = w0 * A.z + w1 * B.z + w2 * C.z;
                const zi = y * W + x;
                if (z >= zbuf[zi]) continue;
                zbuf[zi] = z;
                let r = 200, g = 200, b = 200;
                if (tex && uvSet) {
                    const iz = w0 / A.z + w1 / B.z + w2 / C.z; // perspective-correct interpolation
                    const u = (w0 * uvSet[ia * 2] / A.z + w1 * uvSet[ib * 2] / B.z + w2 * uvSet[ic * 2] / C.z) / iz;
                    const v = (w0 * uvSet[ia * 2 + 1] / A.z + w1 * uvSet[ib * 2 + 1] / B.z + w2 * uvSet[ic * 2 + 1] / C.z) / iz;
                    const fx = (((u % 1) + 1) % 1) * tex.w - 0.5, fy = (((v % 1) + 1) % 1) * tex.h - 0.5;
                    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
                    const px4 = (xx: number, yy: number, ch: number) => tex.rgba[(((yy % tex.h) + tex.h) % tex.h * tex.w + (((xx % tex.w) + tex.w) % tex.w)) * 4 + ch];
                    const s = (ch: number) => (px4(x0, y0, ch) * (1 - tx) + px4(x0 + 1, y0, ch) * tx) * (1 - ty) + (px4(x0, y0 + 1, ch) * (1 - tx) + px4(x0 + 1, y0 + 1, ch) * tx) * ty;
                    r = s(0); g = s(1); b = s(2);
                }
                const o = zi * 4;
                rgba[o] = Math.min(255, r * shade); rgba[o + 1] = Math.min(255, g * shade); rgba[o + 2] = Math.min(255, b * shade);
            }
        }
    }
    let n = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < W * H; i++) if (zbuf[i] !== Infinity) { const l = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]; n++; sum += l; sum2 += l * l; }
    covered = n;
    const mean = n ? sum / n : 0;
    return { png: encodeRgbaToPng(W, H, rgba), coveredPixels: covered, lumaStdDev: n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0 };
}

/** Standard deviation of one PNG's RGBA luma, for "this image is not a flat fill". */
export function pngLumaStdDev(png: Buffer): number {
    const d: any = decodePng(png);
    const px: Buffer = d.data ?? d.rgba ?? d.pixels;
    const n = d.width * d.height;
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const l = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]; s += l; s2 += l * l; }
    const mean = s / n;
    return Math.sqrt(Math.max(0, s2 / n - mean * mean));
}

export const inflate = zlib.inflateSync;

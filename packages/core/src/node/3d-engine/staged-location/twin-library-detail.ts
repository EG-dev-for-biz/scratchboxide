/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The surface library's micro-detail under a rebuilt layer's textured twin: the twin's colour stays the texture pass's
 * (the tile photo transferred and relit, the library where no photo reached), and each primitive gains its chosen
 * library entry's normal and roughness maps at their real-world size, through a second UV set (TEXCOORD_1, world-scale
 * planar: from above on level surfaces, along and up a wall). Plain glTF (normalTexture.texCoord = 1), no shader needed.
 * The photo's atlas is ~0.2 m a texel; the relief and the sheen of the surface's material sit under it at millimetres.
 */

import * as jpegJs from 'jpeg-js';
import { assembleGlb, parseGlbBytes, readAccessor } from './glb-bytes';
import { decodeImageInMemory } from './tile-texture-transfer';
import type { LibraryFillSpec } from './texture-library-fill';
import type { SurfaceLibrary } from './surface-materials';

export const TWIN_DETAIL_VERSION = 'twin-library-detail/2';

/** How strongly the library's normal map bends the twin's shading (glTF normalTexture.scale). */
export const TWIN_DETAIL_NORMAL_SCALE = 0.8;

export function addLibraryDetail(twin: Uint8Array, spec: LibraryFillSpec, library: SurfaceLibrary): { glb: Buffer; primitives: number; byEntry: Record<string, number> } {
    const glb = parseGlbBytes(twin);
    const json = glb.json;
    const extra: Buffer[] = [];
    let binLength = glb.bin.byteLength;
    const pad = (b: Buffer) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
    const addView = (bytes: Uint8Array, target?: number): number => {
        const b = pad(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        // keep the existing bin 4-aligned before appending
        json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
        extra.push(b);
        binLength += b.length;
        return json.bufferViews.length - 1;
    };
    if (glb.bin.byteLength % 4) { const p = Buffer.alloc(4 - (glb.bin.byteLength % 4)); extra.push(p); binLength += p.length; }
    json.images ??= []; json.textures ??= []; json.samplers ??= [];
    json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
    const sampler = json.samplers.length - 1;
    // per entry: its normal map as stored, and a metallic-roughness image (G its roughness, B its metalness)
    const maps = new Map<number, { normal: number; mr: number }>();
    const metalOf = new Map<number, number>();
    const mapsOf = (entryIndex: number) => {
        let m = maps.get(entryIndex);
        if (m) return m;
        const e = library.entry(spec.entries[entryIndex].id)!;
        const tex = (bytes: Uint8Array, mimeType: string, name: string) => {
            json.images.push({ name, mimeType, bufferView: addView(bytes) });
            json.textures.push({ source: json.images.length - 1, sampler, name });
            return json.textures.length - 1;
        };
        const nb = library.readMap(e, 'normal');
        const rough = decodeImageInMemory(library.readMap(e, 'roughness'));
        const mr = Buffer.alloc(rough.width * rough.height * 4);
        // G roughness, B full (the metalness is the factor): a JPEG's subsampled chroma would turn a varying B, or an R far
        // from G, into stray metalness (walls went dark under it; Federation Square, 2026-10-22)
        for (let i = 0; i < rough.width * rough.height; i++) { const g = rough.rgba[i * 4 + 1]; mr[i * 4] = g; mr[i * 4 + 1] = g; mr[i * 4 + 2] = 255; mr[i * 4 + 3] = 255; }
        m = {
            normal: tex(new Uint8Array(nb), nb[0] === 0x89 ? 'image/png' : 'image/jpeg', `${e.id}_detail_normal`),
            mr: tex(new Uint8Array(jpegJs.encode({ data: mr, width: rough.width, height: rough.height }, 90).data), 'image/jpeg', `${e.id}_detail_roughness`)
        };
        metalOf.set(entryIndex, e.surface.metallic);
        maps.set(entryIndex, m);
        return m;
    };
    const nodeOfMesh = new Map<number, string>();
    (json.nodes ?? []).forEach((n: any) => { if (n.mesh !== undefined) nodeOfMesh.set(n.mesh, String(n.name ?? '')); });
    const materialFor = new Map<string, number>();
    const byEntry: Record<string, number> = {};
    let primitives = 0;
    (json.meshes ?? []).forEach((mesh: any, mi: number) => {
        const name = (nodeOfMesh.get(mi) ?? '').split('#')[0];
        for (const prim of mesh.primitives ?? []) {
            if (prim.attributes?.POSITION === undefined || prim.material === undefined || prim.attributes.TEXCOORD_1 !== undefined) continue;
            const base = json.materials[prim.material];
            // a twin material that already carries a metallic-roughness reading (glass) keeps its own
            if (base?.pbrMetallicRoughness?.metallicRoughnessTexture) continue;
            const pos = readAccessor(glb, prim.attributes.POSITION).data;
            const count = pos.length / 3;
            const idx = prim.indices !== undefined ? Array.from(readAccessor(glb, prim.indices).data) : Array.from({ length: count }, (_, i) => i);
            // the primitive's level share and mean wall direction, and the use its triangles mostly take
            let level = 0, wx = 0, wz = 0;
            const votes = new Map<number, number>();
            const g = spec.grids?.[name];
            for (let t = 0; t + 2 < idx.length; t += 3) {
                const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
                const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
                const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
                const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
                const isLevel = Math.abs(ny) / l >= (spec.levelAbove ?? 0.6);
                if (isLevel) level += l; else { wx += nx; wz += nz; }
                let use = -1;
                if (g) {
                    const gi = Math.floor((pos[a] + pos[b] + pos[c]) / 3 / g.cellM - g.x0 / g.cellM), gk = Math.floor((pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3 / g.cellM - g.z0 / g.cellM);
                    if (gi >= 0 && gk >= 0 && gi < g.nx && gk < g.nz) use = g.use[gk * g.nx + gi];
                }
                if (use < 0) { const r = spec.byNode[name] ?? spec.fallback; if (r) use = isLevel ? r.level : r.wall; }
                if (use >= 0) votes.set(use, (votes.get(use) ?? 0) + l);
            }
            let use = -1, best = 0;
            for (const [u, v] of votes) if (v > best) { best = v; use = u; }
            const u = spec.uses[use];
            const entry = u ? spec.entries[u.entry] : undefined;
            if (!u || !entry || !library.entry(entry.id)) continue;
            // world-scale planar UVs: from above when the primitive is mostly level, else on its mean wall plane
            const levelMostly = level >= Math.hypot(wx, wz);
            const h = Math.hypot(wx, wz) || 1, hx = wz / h, hz = -wx / h;
            const uv = new Float32Array(count * 2);
            for (let v = 0; v < count; v++) {
                const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
                uv[v * 2] = (levelMostly ? x : x * hx + z * hz) / entry.realSizeM[0];
                uv[v * 2 + 1] = (levelMostly ? z : -y) / entry.realSizeM[1];
            }
            json.accessors.push({ bufferView: addView(new Uint8Array(uv.buffer), 34962), componentType: 5126, count, type: 'VEC2' });
            prim.attributes.TEXCOORD_1 = json.accessors.length - 1;
            const key = `${prim.material}:${u.entry}`;
            if (!materialFor.has(key)) {
                const m = mapsOf(u.entry);
                const mat = JSON.parse(JSON.stringify(base));
                mat.name = `${base.name ?? 'Twin'}_${entry.id}`;
                mat.normalTexture = { index: m.normal, texCoord: 1, scale: TWIN_DETAIL_NORMAL_SCALE };
                mat.pbrMetallicRoughness = { ...(mat.pbrMetallicRoughness ?? {}), metallicRoughnessTexture: { index: m.mr, texCoord: 1 }, metallicFactor: metalOf.get(u.entry) ?? 0, roughnessFactor: 1 };
                mat.extras = { ...(mat.extras ?? {}), sbSurfaceDetail: { schema: 'scratchbox.surface-detail/1', version: TWIN_DETAIL_VERSION, entryId: entry.id, realSizeM: entry.realSizeM, provenance: 'generated', note: 'the library entry\'s normal and roughness maps at their real size under the twin\'s colour (TEXCOORD_1, world-scale planar); the colour is the texture pass\'s' } };
                json.materials.push(mat);
                materialFor.set(key, json.materials.length - 1);
            }
            prim.material = materialFor.get(key)!;
            byEntry[entry.id] = (byEntry[entry.id] ?? 0) + 1;
            primitives++;
        }
    });
    const bin = Buffer.concat([Buffer.from(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength), ...extra]);
    json.buffers = [{ byteLength: bin.length }];
    json.asset = { ...(json.asset ?? { version: '2.0' }), extras: { ...(json.asset?.extras ?? {}), sbSurfaceDetail: { version: TWIN_DETAIL_VERSION, primitives, byEntry } } };
    return { glb: assembleGlb(json, new Uint8Array(bin)), primitives, byEntry };
}

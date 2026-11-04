/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The native GLB writer gives a normal-mapped mesh tangents that follow its UVs (glTF convention: xyz along +u,
 * cross(N, T) * w up the image, toward decreasing v) where the producer left the Vertex placeholder (1,0,0,1), and
 * keeps tangents a producer set. A cylinder is the case the placeholder gets most wrong: on its side (1,0,0) is not
 * even perpendicular to the normal.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { parseGlbBytes, readAccessor, ParsedGlb } from '../src/node/3d-engine/staged-location/glb-bytes';

const SOURCE = `#include "scratchbox_engine.hpp"
#include <iostream>

using namespace scratchbox;

int main() {
    texture::ImageBuffer flat(8, 8, 3, 0);
    for (size_t i = 0; i < flat.data.size(); i += 3) { flat.data[i] = 128; flat.data[i + 1] = 128; flat.data[i + 2] = 255; }
    const std::vector<uint8_t> png = texture::encodePng(flat);

    // A bark-like trunk: placeholder tangents, its normal map routed by target name
    auto trunk = geometry::ScratchboxMesh::createCylinder(0.5f, 0.5f, 4.0f, 32, math::Vec4(1, 1, 1, 1), true);
    trunk.name = "trunk_column";
    trunk.material.name = "Bark";
    // A plate with tangents its producer set: kept as given
    auto plate = geometry::GeometryBuilder::createPlane(2.0f, 2.0f, 2, 2);
    plate.name = "plate";
    plate.material.name = "Plate";
    for (auto& v : plate.vertices) v.tangent = math::Vec4(0.0f, 0.0f, 1.0f, -1.0f);
    // A box without a normal texture: written as given
    auto bare = geometry::ScratchboxMesh::createBox(math::Vec3(1, 1, 1));
    bare.name = "bare";
    bare.material.name = "Bare";

    io::EmbeddedTexture trunkNormal;
    trunkNormal.name = "trunk_normal";
    trunkNormal.data = png;
    trunkNormal.usage = io::TextureUsage::NORMAL;
    trunkNormal.materialIndex = 7;
    trunkNormal.targetMaterialName = "Bark";
    io::EmbeddedTexture plateNormal = trunkNormal;
    plateNormal.name = "plate_normal";
    plateNormal.materialIndex = 1;
    plateNormal.targetMaterialName = "";

    io::GlbWriter::streamChunk("multi", io::GlbWriter::serializeMultiMeshToGlb({trunk, plate, bare}, {trunkNormal, plateNormal}));
    io::GlbWriter::streamChunk(trunk, "single", {trunkNormal});
    std::cout << "UV_TANGENTS_OK" << std::endl;
    return 0;
}
`;

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

interface Primitive { name: string; normalMapped: boolean; pos: Float64Array; nrm: Float64Array; uv: Float64Array; tan: Float64Array; idx: Float64Array }

function primitives(glb: ParsedGlb): Primitive[] {
    return glb.json.meshes.map((mesh: any) => {
        const p = mesh.primitives[0];
        const a = p.attributes;
        return {
            name: mesh.name,
            normalMapped: glb.json.materials[p.material].normalTexture !== undefined,
            pos: readAccessor(glb, a.POSITION).data,
            nrm: readAccessor(glb, a.NORMAL).data,
            uv: readAccessor(glb, a.TEXCOORD_0).data,
            tan: readAccessor(glb, a.TANGENT).data,
            idx: readAccessor(glb, p.indices).data,
        };
    });
}

const v3 = (d: Float64Array, i: number): V3 => [d[i * 3], d[i * 3 + 1], d[i * 3 + 2]];
const t3 = (d: Float64Array, i: number): V3 => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];

/** Every vertex: |T| = 1, T perpendicular to N, |w| = 1; every triangle corner: T along +u, cross(N, T) * w along -v. */
function checkGltfFrame(p: Primitive) {
    const count = p.pos.length / 3;
    let placeholder = 0, worstUnit = 0, worstDot = 0, worstW = 0;
    for (let i = 0; i < count; i++) {
        const t = t3(p.tan, i), n = v3(p.nrm, i), w = p.tan[i * 4 + 3];
        if (t[0] === 1 && t[1] === 0 && t[2] === 0 && w === 1) placeholder++;
        worstUnit = Math.max(worstUnit, Math.abs(Math.hypot(...t) - 1));
        worstDot = Math.max(worstDot, Math.abs(dot(t, n)));
        worstW = Math.max(worstW, Math.abs(Math.abs(w) - 1));
    }
    let corners = 0, alongU = 0, upImage = 0;
    for (let f = 0; f + 2 < p.idx.length; f += 3) {
        const [a, b, c] = [p.idx[f], p.idx[f + 1], p.idx[f + 2]];
        const e1 = sub(v3(p.pos, b), v3(p.pos, a)), e2 = sub(v3(p.pos, c), v3(p.pos, a));
        const u1 = p.uv[b * 2] - p.uv[a * 2], v1 = p.uv[b * 2 + 1] - p.uv[a * 2 + 1];
        const u2 = p.uv[c * 2] - p.uv[a * 2], v2 = p.uv[c * 2 + 1] - p.uv[a * 2 + 1];
        const det = u1 * v2 - u2 * v1;
        if (Math.abs(det) < 1e-12) continue;
        const dPdu = scale(sub(scale(e1, v2), scale(e2, v1)), 1 / det);
        const dPdv = scale(sub(scale(e2, u1), scale(e1, u2)), 1 / det);
        for (const k of [a, b, c]) {
            const t = t3(p.tan, k), n = v3(p.nrm, k), w = p.tan[k * 4 + 3];
            corners++;
            if (dot(t, dPdu) > 0) alongU++;
            if (dot(scale(cross(n, t), w), dPdv) < 0) upImage++;
        }
    }
    return { count, placeholder, worstUnit, worstDot, worstW, corners, alongU, upImage };
}

describe('native GLB writer: UV tangents for normal-mapped meshes', () => {
    const compiler = new NativeCppCompilerService();

    it('writes glTF tangents from the UVs where the producer left the placeholder, and keeps set ones', async () => {
        const compiled = await compiler.compileSource(SOURCE, { outputBinaryName: `test_glb_uv_tangents_${Date.now()}` });
        expect(compiled.success, compiled.compilerOutput).toBe(true);
        const run = await compiler.executeBinary(compiled.binaryPath!);
        try { fs.unlinkSync(compiled.binaryPath!); } catch { /* cache link */ }
        expect(run.success).toBe(true);
        expect(run.stdout).toContain('UV_TANGENTS_OK');
        const chunk = (name: string) => parseGlbBytes(Buffer.from(run.chunks.find((c: any) => c.name === name)!.glbBase64, 'base64'));

        const [trunk, plate, bare] = primitives(chunk('multi'));
        expect([trunk.name, plate.name, bare.name]).toEqual(['trunk_column', 'plate', 'bare']);
        expect([trunk.normalMapped, plate.normalMapped, bare.normalMapped]).toEqual([true, true, false]);

        // The trunk: side and caps (66 + 2 x 34 vertices), every vertex in the glTF frame of its UVs
        const t = checkGltfFrame(trunk);
        expect(t.count).toBe(134);
        expect(t.worstUnit).toBeLessThan(1e-4);
        expect(t.worstDot).toBeLessThan(1e-4);
        expect(t.worstW).toBe(0);
        expect(t.corners).toBe(trunk.idx.length);
        expect(t.alongU).toBe(t.corners);
        expect(t.upImage).toBe(t.corners);
        // the side's 66 vertices: none left at the placeholder (it is parallel to the normal at angle 0)
        let sidePlaceholder = 0;
        for (let i = 0; i < 66; i++) if (trunk.tan[i * 4] === 1 && trunk.tan[i * 4 + 1] === 0 && trunk.tan[i * 4 + 2] === 0 && trunk.tan[i * 4 + 3] === 1) sidePlaceholder++;
        expect(sidePlaceholder).toBe(0);

        // The plate's own tangents kept bit for bit
        for (let i = 0; i < plate.tan.length / 4; i++) expect(Array.from(plate.tan.slice(i * 4, i * 4 + 4))).toEqual([0, 0, 1, -1]);
        // A mesh without a normal texture is written as given
        expect(checkGltfFrame(bare).placeholder).toBe(bare.pos.length / 3);

        // The single-mesh writer: the same frame
        const [single] = primitives(chunk('single'));
        expect(single.normalMapped).toBe(true);
        const s = checkGltfFrame(single);
        expect(s.worstDot).toBeLessThan(1e-4);
        expect(s.worstW).toBe(0);
        expect(s.alongU).toBe(s.corners);
        expect(s.upImage).toBe(s.corners);
        expect(Array.from(single.tan)).toEqual(Array.from(trunk.tan));
    }, 120000);
});

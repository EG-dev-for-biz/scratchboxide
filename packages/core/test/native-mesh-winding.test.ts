/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Triangle winding of the C++20 mesh helpers. ScratchboxMesh::recomputeSmoothNormals() derives
 * normals from winding and materials default to single-sided, so an inward-wound face renders
 * inverted or culled. A probe that includes only scratchbox_geometry.hpp and scratchbox_shaper.hpp
 * is compiled through NativeCppCompilerService and dumps each mesh; this file then checks the dump
 * with its own vector math (no code shared with the engine): zero inward triangles, analytic signed
 * volumes, every edge matched by its reverse, and stored normals agreeing with the winding. A
 * screenshot that paints back-facing triangles red goes to test-results/screenshots/ (gitignored).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { encodePng } from '../src/node/texture-processing';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/mesh-winding');
const SHOTS = path.join(REPO, 'test-results/screenshots');

const PROBE_SOURCE = `#include "scratchbox_geometry.hpp"
#include "scratchbox_shaper.hpp"
#include <cstdio>
#include <vector>

using scratchbox::geometry::ScratchboxMesh;
using scratchbox::math::Vec3;
using scratchbox::math::TWO_PI;
using scratchbox::shaper::Loft3D;
using scratchbox::shaper::LoopSubdivision;

static void emit(const char* name, const ScratchboxMesh& m) {
    std::printf("{\\"name\\":\\"%s\\",\\"positions\\":[", name);
    for (size_t i = 0; i < m.vertices.size(); ++i) {
        const Vec3& p = m.vertices[i].position;
        std::printf("%s%.9g,%.9g,%.9g", i ? "," : "", p.x, p.y, p.z);
    }
    std::printf("],\\"normals\\":[");
    for (size_t i = 0; i < m.vertices.size(); ++i) {
        const Vec3& n = m.vertices[i].normal;
        std::printf("%s%.9g,%.9g,%.9g", i ? "," : "", n.x, n.y, n.z);
    }
    std::printf("],\\"indices\\":[");
    for (size_t i = 0; i < m.indices.size(); ++i) std::printf("%s%u", i ? "," : "", m.indices[i]);
    std::printf("]}\\n");
}

// 2 x 1 rectangle extruded 4 along +Z in 5 slices; the loop runs counter-clockwise about +Z.
static std::vector<std::vector<Vec3>> prism(bool clockwise) {
    std::vector<std::vector<Vec3>> slices;
    for (int s = 0; s < 5; ++s) {
        float z = -2.0f + static_cast<float>(s);
        std::vector<Vec3> loop = {{-1.0f, -0.5f, z}, {1.0f, -0.5f, z}, {1.0f, 0.5f, z}, {-1.0f, 0.5f, z}};
        if (clockwise) std::reverse(loop.begin(), loop.end());
        slices.push_back(loop);
    }
    return slices;
}

// Unit-radius 32-gon lofted 2 along +Y in 6 slices; angle runs X -> Z, i.e. clockwise about +Y.
static std::vector<std::vector<Vec3>> cylinder(bool clockwise) {
    std::vector<std::vector<Vec3>> slices;
    float sign = clockwise ? 1.0f : -1.0f;
    for (int s = 0; s < 6; ++s) {
        std::vector<Vec3> loop;
        for (int p = 0; p < 32; ++p) {
            float a = sign * TWO_PI * static_cast<float>(p) / 32.0f;
            loop.push_back({std::cos(a), -1.0f + 0.4f * static_cast<float>(s), std::sin(a)});
        }
        slices.push_back(loop);
    }
    return slices;
}

int main() {
    emit("box_2x1x3", ScratchboxMesh::createBox({2.0f, 1.0f, 3.0f}));
    emit("beveled_2x1x3_b0.1", ScratchboxMesh::createBeveledBox({2.0f, 1.0f, 3.0f}, 0.1f));
    emit("beveled_0.5x2x1_b0.2", ScratchboxMesh::createBeveledBox({0.5f, 2.0f, 1.0f}, 0.2f));
    emit("loft_prism_ccw", Loft3D::skin(prism(false), true));
    emit("loft_prism_cw", Loft3D::skin(prism(true), true));
    emit("loft_prism_ccw_open", Loft3D::skin(prism(false), false));
    emit("loft_prism_cw_open", Loft3D::skin(prism(true), false));
    emit("loft_cylinder_ccw", Loft3D::skin(cylinder(false), true));
    emit("loft_cylinder_cw", Loft3D::skin(cylinder(true), true));
    emit("loft_cylinder_cw_loop_subdivided", LoopSubdivision::subdivide(Loft3D::skin(cylinder(true), true), 1));
    return 0;
}
`;

interface MeshDump { name: string; positions: number[]; normals: number[]; indices: number[] }

interface WindingAudit {
    triangles: number;
    inward: number;
    signedVolume: number;
    /** Directed edges (welded by position) not paired with exactly one reverse edge. */
    unmatchedEdges: number;
    /** Smallest dot(stored vertex normal, winding normal) over every triangle corner. */
    minNormalAgreement: number;
}

type V3 = number[];
const sub = (a: V3, b: V3) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vertex = (arr: number[], i: number) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];

function auditWinding(mesh: MeshDump): WindingAudit {
    const nv = mesh.positions.length / 3;
    const centroid = [0, 0, 0];
    for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) centroid[k] += mesh.positions[v * 3 + k] / nv;
    const key = (i: number) => vertex(mesh.positions, i).map(c => Math.round(c * 1e5)).join(',');

    const directed = new Map<string, number>();
    const audit: WindingAudit = { triangles: 0, inward: 0, signedVolume: 0, unmatchedEdges: 0, minNormalAgreement: 1 };
    for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
        const [pa, pb, pc] = [vertex(mesh.positions, a), vertex(mesh.positions, b), vertex(mesh.positions, c)];
        const n = cross(sub(pb, pa), sub(pc, pa));
        const faceCentroid = [0, 1, 2].map(k => (pa[k] + pb[k] + pc[k]) / 3);
        audit.triangles++;
        if (dot(n, sub(faceCentroid, centroid)) < 0) audit.inward++;
        audit.signedVolume += dot(pa, cross(pb, pc)) / 6;
        for (const corner of [a, b, c]) {
            audit.minNormalAgreement = Math.min(audit.minNormalAgreement, dot(unit(n), unit(vertex(mesh.normals, corner))));
        }
        for (const [u, w] of [[a, b], [b, c], [c, a]]) {
            const e = `${key(u)}|${key(w)}`;
            directed.set(e, (directed.get(e) ?? 0) + 1);
        }
    }
    for (const [e, count] of directed) {
        const [u, w] = e.split('|');
        if (count !== 1 || directed.get(`${w}|${u}`) !== 1) audit.unmatchedEdges++;
    }
    return audit;
}

/** Box with every edge chamfered at 45 degrees by b: minus 12 edge prisms and 8 corner cubes plus their kept tetrahedra. */
const beveledBoxVolume = (x: number, y: number, z: number, b: number) =>
    x * y * z - 2 * b * b * (x + y + z - 6 * b) - (20 / 3) * b * b * b;
/** Prism over a regular n-gon inscribed in radius r. */
const polygonPrismVolume = (n: number, r: number, h: number) => 0.5 * n * r * r * Math.sin((2 * Math.PI) / n) * h;

/**
 * Orthographic depth-tested render: triangles facing the camera are shaded clay grey, triangles
 * facing away are painted red. A closed, outward-wound mesh shows no red from any direction.
 * Top row looks from `eye`, bottom row from `-eye`, so every face is seen from outside once.
 */
function renderWindingSheet(meshes: MeshDump[], size = 300): { png: Buffer; backPixels: number[]; frontPixels: number[] } {
    const eyes = [unit([1.2, 0.9, 1.5]), unit([-1.2, -0.9, -1.5])];
    const W = size * meshes.length, H = size * eyes.length;
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) rgba.set([236, 236, 240, 255], i * 4);
    const backPixels = meshes.map(() => 0), frontPixels = meshes.map(() => 0);

    meshes.forEach((mesh, col) => {
        eyes.forEach((eye, row) => {
            const right = unit(cross([0, 1, 0], eye)), up = cross(eye, right);
            const light = unit([eye[0] + 0.5 * up[0] + 0.3 * right[0], eye[1] + 0.5 * up[1] + 0.3 * right[1], eye[2] + 0.5 * up[2] + 0.3 * right[2]]);
            const nv = mesh.positions.length / 3;
            let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
            for (let v = 0; v < nv; v++) {
                const p = vertex(mesh.positions, v);
                lo = [Math.min(lo[0], dot(p, right)), Math.min(lo[1], dot(p, up))];
                hi = [Math.max(hi[0], dot(p, right)), Math.max(hi[1], dot(p, up))];
            }
            const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]) || 1;
            const scale = (size * 0.84) / span;
            const ox = col * size + size / 2, oy = row * size + size / 2;
            const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
            const screen = (p: V3) => [ox + (dot(p, right) - cx) * scale, oy - (dot(p, up) - cy) * scale, -dot(p, eye)];

            const depth = new Float64Array(size * size).fill(Infinity);
            const facing = new Int8Array(size * size);
            for (let t = 0; t < mesh.indices.length; t += 3) {
                const [pa, pb, pc] = [0, 1, 2].map(k => vertex(mesh.positions, mesh.indices[t + k]));
                const n = unit(cross(sub(pb, pa), sub(pc, pa)));
                const front = dot(n, eye) > 0;
                // Back faces lose depth ties so silhouette pixels never read as inverted.
                const bias = front ? 0 : span * 1e-6;
                const shade = 0.35 + 0.65 * Math.max(0, dot(n, light));
                const color = front ? [178 * shade, 180 * shade, 186 * shade] : [222, 38, 38];
                const [A, B, C] = [screen(pa), screen(pb), screen(pc)];
                const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
                if (Math.abs(area) < 1e-12) continue;
                const minX = Math.max(col * size, Math.floor(Math.min(A[0], B[0], C[0])));
                const maxX = Math.min(col * size + size - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
                const minY = Math.max(row * size, Math.floor(Math.min(A[1], B[1], C[1])));
                const maxY = Math.min(row * size + size - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
                for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
                    const px = x + 0.5, py = y + 0.5;
                    const w0 = ((B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px)) / area;
                    const w1 = ((C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px)) / area;
                    const w2 = 1 - w0 - w1;
                    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
                    const z = w0 * A[2] + w1 * B[2] + w2 * C[2] + bias;
                    const di = (y - row * size) * size + (x - col * size);
                    if (z >= depth[di]) continue;
                    depth[di] = z;
                    facing[di] = front ? 1 : 2;
                    rgba.set([color[0], color[1], color[2]], (y * W + x) * 4);
                }
            }
            for (const f of facing) {
                if (f === 1) frontPixels[col]++;
                else if (f === 2) backPixels[col]++;
            }
        });
    });
    return { png: encodePng(W, H, rgba), backPixels, frontPixels };
}

describe('Native mesh helper winding (createBeveledBox, Loft3D::skin)', () => {
    const meshes = new Map<string, MeshDump>();
    const audits = new Map<string, WindingAudit>();

    beforeAll(async () => {
        fs.mkdirSync(WORK, { recursive: true });
        const compiler = new NativeCppCompilerService();
        const compiled = await compiler.compileSource(PROBE_SOURCE, {
            outputDir: WORK,
            outputBinaryName: 'mesh_winding_probe',
            optimization: '-O1'
        });
        expect(compiled.success, compiled.compilerOutput).toBe(true);
        const run = await compiler.executeBinary(compiled.binaryPath!);
        expect(run.exitCode, run.stderr).toBe(0);
        for (const line of run.stdout.split('\n')) {
            if (!line.startsWith('{')) continue;
            const mesh: MeshDump = JSON.parse(line);
            meshes.set(mesh.name, mesh);
            audits.set(mesh.name, auditWinding(mesh));
        }
        expect(meshes.size).toBe(10);
    }, 180_000);

    it('reference: createBox is outward, closed and exactly 2 x 1 x 3', () => {
        const a = audits.get('box_2x1x3')!;
        expect(a.inward).toBe(0);
        expect(a.unmatchedEdges).toBe(0);
        expect(a.signedVolume).toBeCloseTo(6, 6);
    });

    it.each([
        ['beveled_2x1x3_b0.1', [2, 1, 3, 0.1]],
        ['beveled_0.5x2x1_b0.2', [0.5, 2, 1, 0.2]]
    ] as const)('createBeveledBox %s winds every face, chamfer and corner outward', (name, [x, y, z, b]) => {
        const a = audits.get(name)!;
        expect(a.triangles).toBe(44);
        expect(a.inward).toBe(0);
        expect(a.unmatchedEdges).toBe(0);
        expect(a.signedVolume).toBeCloseTo(beveledBoxVolume(x, y, z, b), 4);
        // Every face is flat and stores its analytic normal, so it must match the winding exactly.
        expect(a.minNormalAgreement).toBeGreaterThan(0.9999);
    });

    it.each(['loft_prism_ccw', 'loft_prism_cw'])('Loft3D::skin %s is outward with consistent caps whichever way the loop runs', name => {
        const a = audits.get(name)!;
        expect(a.triangles).toBe(40);
        expect(a.inward).toBe(0);
        expect(a.unmatchedEdges).toBe(0);
        expect(a.signedVolume).toBeCloseTo(8, 5);
        expect(a.minNormalAgreement).toBeGreaterThan(0);
    });

    it.each(['loft_prism_ccw_open', 'loft_prism_cw_open'])('Loft3D::skin %s without caps still faces outward', name => {
        const a = audits.get(name)!;
        expect(a.triangles).toBe(32);
        expect(a.inward).toBe(0);
        // Only the two open 4-edge rims are unpaired.
        expect(a.unmatchedEdges).toBe(8);
        expect(a.minNormalAgreement).toBeGreaterThan(0);
    });

    it.each(['loft_cylinder_ccw', 'loft_cylinder_cw'])('Loft3D::skin %s matches the inscribed 32-gon prism volume', name => {
        const a = audits.get(name)!;
        expect(a.triangles).toBe(2 * 32 * 5 + 2 * 32);
        expect(a.inward).toBe(0);
        expect(a.unmatchedEdges).toBe(0);
        expect(a.signedVolume).toBeCloseTo(polygonPrismVolume(32, 1, 2), 4);
        expect(a.minNormalAgreement).toBeGreaterThan(0);
    });

    it('a capped loft stays closed and outward through LoopSubdivision (caps share the rim vertices)', () => {
        const a = audits.get('loft_cylinder_cw_loop_subdivided')!;
        expect(a.triangles).toBe(4 * (2 * 32 * 5 + 2 * 32));
        expect(a.inward).toBe(0);
        expect(a.unmatchedEdges).toBe(0);
        expect(a.signedVolume).toBeGreaterThan(0.85 * polygonPrismVolume(32, 1, 2));
        expect(a.minNormalAgreement).toBeGreaterThan(0);
    });

    it('renders no back-facing triangle from either side (screenshot)', () => {
        const shown = ['beveled_2x1x3_b0.1', 'loft_prism_ccw', 'loft_prism_cw', 'loft_cylinder_ccw', 'loft_cylinder_cw_loop_subdivided'];
        const sheet = renderWindingSheet(shown.map(n => meshes.get(n)!));
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'native-mesh-winding_helpers.png'), sheet.png);
        shown.forEach((name, i) => {
            expect(sheet.frontPixels[i], name).toBeGreaterThan(5000);
            expect(sheet.backPixels[i], name).toBe(0);
        });
    });
});

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
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';

interface Primitive { positions: number[]; indices: number[] }

function readPrimitives(file: string): Primitive[] {
    const buf = fs.readFileSync(file);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('glTF');
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    const bin = buf.subarray(20 + jsonLen + 8);
    const read = (accessorIdx: number): number[] => {
        const acc = json.accessors[accessorIdx];
        const view = json.bufferViews[acc.bufferView];
        const comps = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[acc.type];
        const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
        const out: number[] = [];
        for (let i = 0; i < acc.count * comps; i++) {
            if (acc.componentType === 5126) out.push(bin.readFloatLE(base + i * 4));
            else if (acc.componentType === 5125) out.push(bin.readUInt32LE(base + i * 4));
            else out.push(bin.readUInt16LE(base + i * 2));
        }
        return out;
    };
    return json.meshes.flatMap((m: any) => m.primitives.map((p: any) => ({
        positions: read(p.attributes.POSITION),
        indices: read(p.indices)
    })));
}

/** Edges not shared by exactly two triangles, welding by exact position. */
function badEdgeCount(p: Primitive): number {
    const key = (i: number) => [0, 1, 2].map(k => p.positions[i * 3 + k]).join(',');
    const edges = new Map<string, number>();
    for (let t = 0; t < p.indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
            const a = key(p.indices[t + e]);
            const b = key(p.indices[t + ((e + 1) % 3)]);
            if (a === b) continue;
            const k = a < b ? `${a}|${b}` : `${b}|${a}`;
            edges.set(k, (edges.get(k) || 0) + 1);
        }
    }
    return [...edges.values()].filter(c => c !== 2).length;
}

async function run(body: string): Promise<{ p: Primitive; stdout: string }> {
    const runner = NativePythonRunnerService.getInstance();
    const result = await runner.runScript(`
import scratchbox as sb
${body}
sb.io.write_glb(sb.constants.OUTPUT_GLB_PATH, [out])
`);
    expect(result.success, result.stderr).toBe(true);
    const prims = readPrimitives(result.glbPath!);
    expect(prims.length).toBe(1);
    return { p: prims[0], stdout: result.stdout };
}

const ys = (p: Primitive) => Array.from({ length: p.positions.length / 3 }, (_, i) => p.positions[i * 3 + 1]);

describe('Isoparametric normal relief (sb.relief)', () => {
    it('cuts a groove of the asked depth and width into a 2 m cube top, subdividing only there', async () => {
        const { p } = await run(`
groove = sb.relief.profile([[(-0.8, 1.0, 0.0), (0.8, 1.0, 0.0)]], width_m=0.05, depth_m=-0.02, sharpness=0.0).facing((0, 1, 0))
out = sb.relief.apply(sb.create_box(width=2.0, height=2.0, depth=2.0), [groove])
print("tris", len(out.indices) // 3)`);
        expect(badEdgeCount(p)).toBe(0);
        const n = p.positions.length / 3;
        const all = Array.from({ length: n }, (_, i) => i);
        // Top-face vertices only (side faces also gain subdivision vertices near the top edge).
        const top = all.filter(i => p.positions[i * 3 + 1] > 0.9 && Math.abs(p.positions[i * 3]) < 0.99 && Math.abs(p.positions[i * 3 + 2]) < 0.99);
        const topY = top.map(i => p.positions[i * 3 + 1]);
        expect(Math.min(...topY)).toBeCloseTo(0.98, 3);           // full depth reached on the centre line
        expect(Math.max(...topY)).toBeCloseTo(1.0, 5);            // nothing raised
        // Subdivision concentrates where the groove is: the bottom face has far fewer vertices than the top.
        const bottom = all.filter(i => p.positions[i * 3 + 1] < -0.99);
        expect(bottom.length * 10).toBeLessThan(top.length);
        // Outside the groove's half-width the top is untouched.
        for (const i of top.filter(i => Math.abs(p.positions[i * 3 + 2]) > 0.06)) expect(p.positions[i * 3 + 1]).toBeCloseTo(1.0, 5);
    }, 600000);

    it('knurls a face with the asked pitch: ridge count matches, peaks at full height, valleys at zero', async () => {
        const { p } = await run(`
knurl = sb.relief.ridges((0, 1.0, 0), (1, 0, 0), pitch_m=0.1, depth_m=0.01, sharpness=0.8, duty=0.5, second_direction=(0, 0, 1)) \\
    .limit_box((-0.5, 0.9, -0.5), (0.5, 1.1, 0.5)).facing((0, 1, 0))
out = sb.relief.apply(sb.create_box(width=2.0, height=2.0, depth=2.0), [knurl], max_subdivisions=7)`);
        expect(badEdgeCount(p)).toBe(0);
        const inside = Array.from({ length: p.positions.length / 3 }, (_, i) => i)
            .filter(i => p.positions[i * 3 + 1] > 0.9 && Math.abs(p.positions[i * 3]) < 0.45 && Math.abs(p.positions[i * 3 + 2]) < 0.45);
        const h = inside.map(i => p.positions[i * 3 + 1]);
        expect(Math.max(...h)).toBeCloseTo(1.01, 3);
        expect(Math.min(...h)).toBeCloseTo(1.0, 4);
        // Along the ridge line z = 0 there is one ridge per pitch: every 0.1 m cell between -0.5 and 0.5
        // holds a raised sample (mesh vertices rarely sit exactly on a peak, so the bar is well below full
        // height), and nothing is raised except near a pitch multiple.
        const onLine = inside.filter(i => Math.abs(p.positions[i * 3 + 2]) < 0.008);
        const raisedCells = new Set(onLine.filter(i => p.positions[i * 3 + 1] > 1.004).map(i => Math.round(p.positions[i * 3] / 0.1)));
        expect(raisedCells.size).toBeGreaterThanOrEqual(9);
        for (const i of onLine.filter(i => p.positions[i * 3 + 1] > 1.004)) {
            const fx = p.positions[i * 3] / 0.1;
            expect(Math.abs(fx - Math.round(fx))).toBeLessThan(0.26);   // within the ridge's half-width (duty 0.5)
        }
    }, 600000);

    it('remeshes a fan cap under a groove into well-shaped triangles with no coincident vertices', async () => {
        const { p } = await run(`
cyl = sb.create_cylinder(radius=0.25, height=0.3, segments=96)
groove = sb.relief.profile([[(-0.3, 0.15, 0.08), (0.3, 0.15, 0.08)]], width_m=0.01, depth_m=-0.003).facing((0, 1, 0))
out = sb.relief.apply(cyl, [groove], max_subdivisions=6)`);
        expect(badEdgeCount(p)).toBe(0);
        const P = (i: number) => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]];
        const minAngles: number[] = [];
        let coincident = 0;
        for (let t = 0; t < p.indices.length; t += 3) {
            const pts = [P(p.indices[t]), P(p.indices[t + 1]), P(p.indices[t + 2])];
            const cen = [0, 1, 2].map(k => (pts[0][k] + pts[1][k] + pts[2][k]) / 3);
            if (cen[1] < 0.146 || Math.abs(cen[2] - 0.08) > 0.012) continue;   // the groove band on the cap
            if (new Set(pts.map(q => q.join(','))).size < 3) { coincident++; continue; }
            let mn = Infinity;
            for (let k = 0; k < 3; k++) {
                const o = pts[k], u = pts[(k + 1) % 3], v = pts[(k + 2) % 3];
                const a = [u[0] - o[0], u[1] - o[1], u[2] - o[2]], b = [v[0] - o[0], v[1] - o[1], v[2] - o[2]];
                const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
                mn = Math.min(mn, (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
            }
            minAngles.push(mn);
        }
        minAngles.sort((x, y) => x - y);
        expect(coincident).toBe(0);
        expect(minAngles.length).toBeGreaterThan(1000);
        // The untouched fan has every triangle at 3.75 degrees; collapses alone reach about 7.5 / 30.
        expect(minAngles[Math.floor(minAngles.length / 10)]).toBeGreaterThan(15);
        expect(minAngles[Math.floor(minAngles.length / 2)]).toBeGreaterThan(40);
    }, 600000);

    it('refuses parameters that make no relief and warns about a layer that moves nothing', async () => {
        const runner = NativePythonRunnerService.getInstance();
        const result = await runner.runScript(`
import scratchbox as sb, warnings
box = sb.create_box(width=1, height=1, depth=1)
cases = {
    "width": lambda: sb.relief.profile([[(-0.4, 0.5, 0), (0.4, 0.5, 0)]], width_m=0.0, depth_m=-0.01),
    "pitch": lambda: sb.relief.ridges((0, 0.5, 0), (1, 0, 0), pitch_m=0.0, depth_m=0.01),
    "image": lambda: sb.relief.ridges((0, 0.5, 0), (1, 0, 0), pitch_m=0.1, depth_m=0.01).limit_box((1, 1, 1), (0, 0, 0)),
    "facing": lambda: sb.relief.ridges((0, 0.5, 0), (1, 0, 0), pitch_m=0.1, depth_m=0.01).facing((0, 0, 0)),
}
for label, make in cases.items():
    try:
        sb.relief.apply(box, [make()]); print("NO ERROR", label)
    except ValueError as e:
        print("RAISED", label, str(e).split(": ", 1)[1][:40])
with warnings.catch_warnings(record=True) as ws:
    warnings.simplefilter("always")
    out = sb.relief.apply(box, [sb.relief.profile([[(-0.4, 5.0, 0), (0.4, 5.0, 0)]], width_m=0.05, depth_m=-0.01)])
print("noop-warned", any("moved no vertex" in str(w.message) for w in ws), len(out.indices))
`);
        expect(result.success, result.stderr).toBe(true);
        expect(result.stdout).toContain('RAISED width profile width_m must be positive');
        expect(result.stdout).toContain('RAISED pitch ridge pitch_m must be positive');
        expect(result.stdout).toContain('RAISED image limit_box has box_min above box_max');
        expect(result.stdout).toContain('RAISED facing facing direction must not be the zero');
        expect(result.stdout).toContain('noop-warned True 36');
        expect(result.stdout).not.toContain('NO ERROR');
    }, 600000);

    it('embosses only the faces an image lands on: the side next to an embossed front keeps its plane', async () => {
        const { p } = await run(`
import struct, zlib
w = h = 16
rows = b"".join(b"\\x00" + bytes([255] * w) for _ in range(h))   # an all-white image
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
# Centred 0.2 m from the cube's +x edge, so the projection slab passes through the +x side face.
emboss = sb.relief.image(png, (0.8, 0, 1.0), (0, 0, 1), (0, 1, 0), width_m=0.64, height_m=0.64, depth_m=0.03)
out = sb.relief.apply(sb.create_box(width=2.0, height=2.0, depth=2.0), [emboss], target_edge_m=0.02)`);
        expect(badEdgeCount(p)).toBe(0);
        const n = p.positions.length / 3;
        let maxX = -Infinity, raised = 0;
        for (let i = 0; i < n; i++) {
            const x = p.positions[i * 3], y = p.positions[i * 3 + 1], z = p.positions[i * 3 + 2];
            maxX = Math.max(maxX, x);
            if (Math.abs(y) < 0.2 && x > 0.5 && x < 0.9 && z > 1.0) { expect(z).toBeCloseTo(1.03, 3); raised++; }
        }
        expect(maxX).toBeLessThanOrEqual(1.0 + 1e-6);   // the +x side was not pushed outward anywhere
        expect(raised).toBeGreaterThan(100);
    }, 600000);

    it('embosses a projected height image: white raises by depth, black and outside do not move', async () => {
        const { p } = await run(`
import struct, zlib
# A 64x64 greyscale PNG: white disc of radius 20 px on black.
w = h = 64
rows = b""
for y in range(h):
    rows += b"\\x00" + bytes(255 if (x - 32) ** 2 + (y - 32) ** 2 <= 400 else 0 for x in range(w))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
emboss = sb.relief.image(png, (0, 0, 1.0), (0, 0, 1), (0, 1, 0), width_m=0.64, height_m=0.64, depth_m=0.03)
out = sb.relief.apply(sb.create_box(width=2.0, height=2.0, depth=2.0), [emboss], target_edge_m=0.01)`);
        expect(badEdgeCount(p)).toBe(0);
        const n = p.positions.length / 3;
        const front = Array.from({ length: n }, (_, i) => i).filter(i => p.positions[i * 3 + 2] > 0.99);
        const zOf = (i: number) => p.positions[i * 3 + 2];
        const rOf = (i: number) => Math.hypot(p.positions[i * 3], p.positions[i * 3 + 1]);
        const disc = front.filter(i => rOf(i) < 0.17), rim = front.filter(i => rOf(i) > 0.24);
        expect(disc.length).toBeGreaterThan(100);
        for (const i of disc) expect(zOf(i)).toBeCloseTo(1.03, 3);
        for (const i of rim) expect(zOf(i)).toBeCloseTo(1.0, 4);
    }, 600000);
});

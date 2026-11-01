/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';

const PRELUDE = `
import struct, math, json
import scratchbox as sb
import scratchbox_native as sn
def pos(m):
    b = m.get_positions_flat(); return [struct.unpack_from('<3f', b, i * 12) for i in range(len(b) // 12)]
def part(parts, slot): return [x for x in parts if x.name.endswith(slot)][0]
prof = sb.moulding_profile(0.12, 0.10)
`;

async function run(body: string): Promise<string> {
    const runner = NativePythonRunnerService.getInstance();
    const result = await runner.runScript(PRELUDE + body);
    expect(result.success, result.stderr).toBe(true);
    return result.stdout;
}

describe('Facade details, parts split and weathering (reviewer-found defects in the shared code)', () => {
    it('a string-course profile replaces the box belt only on the floors it is swept on', async () => {
        const out = await run(`
def bands(**kw):
    parts = sb.create_building_parts(width=20, depth=12, floors=4, **kw)
    P = pos(part(parts, 'trim'))   # belts and string courses are trim; foundation is the plinth alone
    return [sum(1 for p in P if y - 0.5 < p[1] <= y + 0.001 and p[2] > 6.05) for y in (5.0, 8.4, 11.8, 15.2)]
plain = bands(); listed = bands(details={"string_course_profile": prof, "string_course_floors": [1]}); every = bands(details={"string_course_profile": prof})
print("plain", plain); print("listed", listed); print("every", every)
print("kept", listed[1] == plain[1] and listed[2] == plain[2] and listed[3] == plain[3], "swept", listed[0] > plain[0], all(e > p for e, p in zip(every[:3], plain[:3])))
`);
        expect(out).toContain('kept True swept True True');
    }, 600000);

    it('dormers sit only where a roof slope rises behind the eave', async () => {
        const out = await run(`
try:
    sb.create_building_parts(width=20, depth=12, floors=2, roof="flat", details={"dormer_width_m": 1.2}); print("NO ERROR flat")
except ValueError as e:
    print("RAISED flat", "pitched roof" in str(e))
for roof in ("gable", "hip"):
    parts = sb.create_building_parts(width=20, depth=12, floors=2, roof=roof, details={"dormer_width_m": 1.2})
    W = [p for p in pos(part(parts, 'wall')) if p[1] > 0.8 + 4.2 + 3.4 + 0.01]
    print(roof, "dormer_verts", len(W), "beyond_gable_ends", sum(1 for p in W if abs(p[0]) > 10.001))
`);
        expect(out).toContain('RAISED flat True');
        expect(out).toMatch(/gable dormer_verts [1-9]\d* beyond_gable_ends 0/);   // none on the E/W gable-end walls
        expect(out).toMatch(/hip dormer_verts [1-9]\d* beyond_gable_ends [1-9]\d*/); // hips slope on every side
    }, 600000);

    it('corner pilasters, moulding caps, balusters and the parts split: no overhang, no degenerate triangle, no gap, no lost brightening', async () => {
        const out = await run(`
parts = sb.create_building_parts(width=20, depth=12, floors=2, details={"pilaster_width_m": 0.4, "pilaster_projection_m": 0.08})
P = pos(part(parts, 'trim')); pf = 0.08 * 1.35   # pilasters are trim; the flared base block spans y 0.8 to 1.1
print("corner_overhang", sum(1 for p in P if p[2] > 6.001 and p[0] < -10 - pf - 1e-3 and 0.7 < p[1] < 1.2),
      sum(1 for p in P if p[0] < -10.001 and p[2] > 6 + pf + 1e-3 and 0.7 < p[1] < 1.2),
      "base_verts", sum(1 for p in P if p[0] < -9.5 and p[2] > 5.5 and 0.7 < p[1] < 1.2) > 0)
parts = sb.create_building_parts(width=20, depth=12, floors=3, bake_curvature_ao=False,
    details={"sill_profile": prof, "hood_profile": prof, "cornice_profile": sb.moulding_profile(0.3, 0.25), "balcony_floors": [1], "pilaster_width_m": 0.3})
tot = deg = 0
for m in parts:
    Q = pos(m); I = list(m.indices)
    for t in range(0, len(I), 3):
        a, b, c = (Q[i] for i in I[t:t + 3])
        u = [b[k] - a[k] for k in range(3)]; v = [c[k] - a[k] for k in range(3)]
        cr = (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])
        tot += 1; deg += math.sqrt(sum(x * x for x in cr)) < 1e-10
print("tris", tot, "degenerate", deg)
F = pos(part(parts, 'frame')); slab = 0.8 + 4.2
bal = [p for p in F if p[2] > 6.05 and slab - 0.01 < p[1] < slab + 0.3]
print("baluster_gap", round(min(p[1] for p in bal) - slab, 4), "max_trim_shade", round(max(v.color.x for v in part(parts, 'trim').vertices), 3))
w = part(sb.create_building_parts(width=18, depth=18, floors=3, curvature=0.6), 'wall'); byp = {}
for v, p in zip(w.vertices, pos(w)):
    if abs(v.normal.y) > 0.9: continue
    byp.setdefault(tuple(round(c, 4) for c in p), set()).add(round(v.uv.x, 3))
print("curved_shared", len(byp), "split_u", sum(1 for k, s in byp.items() if len(s) > 1 and not (k[2] < 0 and abs(k[0]) < 0.6)))
`);
        expect(out).toContain('corner_overhang 0 0 base_verts True');
        expect(out).toMatch(/tris [1-9]\d* degenerate 0/);           // was 12% of all triangles
        expect(out).toContain('baluster_gap 0.0 max_trim_shade 1.05'); // on the slab; sill tops keep their 1.05
        expect(out).toMatch(/curved_shared [1-9]\d* split_u 0/);      // one u per wall vertex except the seam
    }, 600000);

    it('texture provenance reaches the GLB as labelled extras with a confidence, and loose inputs are refused', async () => {
        const out = await run(`
parts = sb.create_building_parts(width=12, depth=8, floors=2)
path = sb.constants.OUTPUT_GLB_PATH
rep = sb.write_textured_building(path, parts, surfaces={"wall": {"coursed": {}, "provenance": "measured", "confidence": 0.9}})
data = open(path, "rb").read(); jl = struct.unpack_from("<I", data, 12)[0]; j = json.loads(data[20:20 + jl])
ex = {m["name"].rsplit("_", 1)[-1]: m.get("extras", {}).get("scratchbox") for m in j["materials"]}
print("wall", ex["wall"]); print("roof", ex["roof"]); print("report", rep["parts"]["wall"]["provenance"], rep["parts"]["wall"]["confidence"])
for label, surf in (("label", {"wall": {"coursed": {}, "provenance": "guessed"}}), ("conf", {"wall": {"coursed": {}, "confidence": 2}}), ("slot", {"walls": {"coursed": {}}})):
    try:
        sb.write_textured_building(path, parts, surfaces=surf); print("NO ERROR", label)
    except ValueError as e:
        print("RAISED", label, str(e)[:60])
for label, meshes, tex in (("target", list(parts), [("nothing_here", "base_color", b"x", "image/png", 1.0, 1.0)]), ("empty", [], [])):
    try:
        sn.io.write_glb_textured(path, meshes, tex); print("NO ERROR", label)
    except ValueError as e:
        print("RAISED", label, str(e)[:50])
`);
        expect(out).toContain("wall {'provenance': 'measured', 'confidence': 0.9, 'source': 'procedural coursed surface'}");
        expect(out).toContain("roof {'provenance': 'generated', 'confidence': 1.0, 'source': 'procedural building'}");
        expect(out).toContain('report measured 0.9');
        expect(out).toContain('RAISED label provenance must be one of');
        expect(out).toContain('RAISED conf wall: confidence must be in 0..1');
        expect(out).toContain("RAISED slot Unknown surface slot(s) or part(s) ['walls']");
        expect(out).toContain("RAISED target write_glb_textured: texture target 'nothing_her");
        expect(out).toContain('RAISED empty write_glb_textured: every mesh is empty');
        expect(out).not.toContain('NO ERROR');
    }, 600000);

    it('weathering: undersides are sheltered, a deep ledge sheds more run-off than a band, and the terms are independent', async () => {
        const out = await run(`
import struct, zlib
def decode_png(data):
    assert data[:8] == b"\\x89PNG\\r\\n\\x1a\\n"
    pos = 8; idat = b""; w = h = 0; ct = 0
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos+4])[0]; typ = data[pos+4:pos+8]; body = data[pos+8:pos+8+ln]; pos += 12 + ln
        if typ == b"IHDR": w, h, bd, ct = struct.unpack(">IIBB", body[:10])
        elif typ == b"IDAT": idat += body
    ch = {6: 4, 2: 3, 0: 1, 4: 2}[ct]
    raw = zlib.decompress(idat); stride = w * ch; out = bytearray(h * stride); prev = bytearray(stride); p = 0
    for y in range(h):
        f = raw[p]; p += 1; line = bytearray(raw[p:p+stride]); p += stride
        for i in range(stride):
            a = line[i-ch] if i >= ch else 0; b = prev[i]; c = prev[i-ch] if i >= ch else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + ((a + b) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out[y*stride:(y+1)*stride] = line; prev = line
    return w, h, ch, bytes(out)
parts = sb.create_building_parts(width=8, depth=6, floors=2, details={"balcony_floors": [1]})
recv = [p for p in parts if p.name.rsplit("_", 1)[-1] in ("wall", "foundation", "roof", "trim")]   # the balcony slabs are trim
def bake(**zero):
    prm = sn.weathering.WeatheringParams(); prm.texel_m = 0.1; prm.variation = 0.0
    for k, v in zero.items(): setattr(prm, k, v)
    baked = sn.weathering.bake_weathering(recv, list(parts), prm, "w")
    W, H, ch, px = decode_png(baked["atlas_png"]); ov = baked["overlay"]; P = pos(ov); V = ov.vertices; I = list(ov.indices)
    tris = [(I[t], I[t + 1], I[t + 2]) for t in range(0, len(I), 3)]
    def darkening(point, axis, sign):   # alpha x (1 - luminance) of the overlay texel under a world point
        a_, b_ = [k for k in range(3) if k != axis]
        for ids in tris:
            n = [sum(getattr(V[i].normal, c) for i in ids) / 3 for c in "xyz"]
            if n[axis] * sign < 0.9 or abs(sum(P[i][axis] for i in ids) / 3 - point[axis]) > 0.03: continue
            p0, p1, p2 = (P[i] for i in ids)
            d = (p1[a_]-p0[a_])*(p2[b_]-p0[b_]) - (p2[a_]-p0[a_])*(p1[b_]-p0[b_])
            if abs(d) < 1e-12: continue
            l1 = ((point[a_]-p0[a_])*(p2[b_]-p0[b_]) - (p2[a_]-p0[a_])*(point[b_]-p0[b_])) / d
            l2 = ((p1[a_]-p0[a_])*(point[b_]-p0[b_]) - (point[a_]-p0[a_])*(p1[b_]-p0[b_])) / d
            l0 = 1 - l1 - l2
            if min(l0, l1, l2) < -1e-6: continue
            u = l0*V[ids[0]].uv.x + l1*V[ids[1]].uv.x + l2*V[ids[2]].uv.x; v = l0*V[ids[0]].uv.y + l1*V[ids[1]].uv.y + l2*V[ids[2]].uv.y
            o = (min(H-1, max(0, int(v*H))) * W + min(W-1, max(0, int(u*W)))) * ch
            return px[o+3] / 255 * (1 - (0.2126*px[o] + 0.7152*px[o+1] + 0.0722*px[o+2]) / 255)
        return None
    def strip(points, axis, sign):
        vals = [s for s in (darkening(p, axis, sign) for p in points) if s is not None]
        return sum(vals) / len(vals)
    xs = [x / 10 for x in range(-28, -11)] + [x / 10 for x in range(12, 29)]   # under the two balcony slabs
    gap = [x / 10 for x in range(-4, 5)]                                       # between them: band only
    return dict(soffit=strip([(x, 4.84, 3.4) for x in xs], 1, -1), slab=strip([(x, 4.6, 3.0) for x in xs], 2, 1),
                band=strip([(x, 4.6, 3.0) for x in gap], 2, 1), pier=strip([(x, 2.3, -3.0) for x in gap], 2, -1))
d = bake(); s = bake(shelter_grime=0.0)
print("soffit_vs_pier", round(d["soffit"] / max(1e-6, d["pier"]), 2), "slab_vs_band", round(d["slab"] / max(1e-6, d["band"]), 2),
      "soffit_without_shelter", round(s["soffit"], 3))
try:
    prm = sn.weathering.WeatheringParams(); prm.texel_m = 0.002
    sn.weathering.bake_weathering(recv, list(parts), prm, "w"); print("NO ERROR cap")
except RuntimeError as e:
    print("RAISED cap", "atlas would be" in str(e))
`);
        const m = out.match(/soffit_vs_pier ([\d.]+) slab_vs_band ([\d.]+) soffit_without_shelter ([\d.]+)/);
        expect(m, out).toBeTruthy();
        expect(parseFloat(m![1])).toBeGreaterThan(2.5);    // a never-rained-on underside is grimier than an open pier (was lighter)
        expect(parseFloat(m![2])).toBeGreaterThan(1.4);    // a 0.85 m slab sheds more than a 0.16 m band (was equal)
        expect(parseFloat(m![3])).toBeLessThan(0.02);      // the underside is shelter grime alone: no wash, no streak, no cavity
        expect(out).toContain('RAISED cap True');
    }, 600000);
});

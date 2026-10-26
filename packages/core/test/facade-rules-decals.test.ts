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
import struct, math, zlib
import scratchbox as sb
import scratchbox_native as sn
def pos(m):
    b = m.get_positions_flat(); return [struct.unpack_from('<3f', b, i * 12) for i in range(len(b) // 12)]
def part(parts, slot): return pos([x for x in parts if x.name.endswith(slot)][0])
`;

async function run(body: string): Promise<string> {
    const runner = NativePythonRunnerService.getInstance();
    const result = await runner.runScript(PRELUDE + body);
    expect(result.success, result.stderr).toBe(true);
    return result.stdout;
}

describe('Facade layout rules and decals (reviewer-found defects)', () => {
    it('curved buildings apply floor_heights and refuse rules and bay scales instead of dropping them', async () => {
        const out = await run(`
plain = max(p[1] for p in pos(sb.create_building(width=20, depth=12, floors=4, curvature=0.3)))
tall = max(p[1] for p in pos(sb.create_building(width=20, depth=12, floors=4, curvature=0.3, floor_heights=[6, 6, 6, 6])))
print("taller", round(tall - plain, 2))
for label, kw in (("rules", dict(facade_rules=[{"floors": (1, 3), "opening": False}])), ("scale", dict(centre_bay_scale=1.4))):
    try:
        sb.create_building(width=20, depth=12, floors=4, curvature=0.3, **kw); print("NO ERROR", label)
    except ValueError as e:
        print("RAISED", label, "not applied by the curved builder" in str(e))
`);
        // Default storeys are 4.2 + 3 x 3.4 = 14.4 m; four 6 m storeys add 9.6 m.
        expect(out).toContain('taller 9.6');
        expect(out).toContain('RAISED rules True');
        expect(out).toContain('RAISED scale True');
        expect(out).not.toContain('NO ERROR');
    }, 600000);

    it('pilasters are sized from the resolved openings, so a widened window is never cut by a pilaster', async () => {
        const out = await run(`
parts = sb.create_building_parts(width=20, depth=12, floors=3, bay_width=4.0, window_width=1.0,
    facade_rules=[{"floors": (0, 2), "window_width_m": 3.3}], details={"pilaster_width_m": 2.0, "pilaster_projection_m": 0.2})
glass = sorted(set(round(p[0], 3) for p in part(parts, 'glass') if abs(p[2] - 5.75) < 0.05 and 5.0 < p[1] < 8.0))
shafts = sorted(set(round(p[0], 3) for p in part(parts, 'foundation') if 6.1 < p[2] < 6.25 and abs(p[1] - 0.8) < 1e-3))
overlap = sum(1 for g in glass for a, b in zip(shafts[::2], shafts[1::2]) if a < g < b)
print("glass", glass); print("shafts", shafts); print("overlap", overlap)
`);
        expect(out).toContain('glass [-9.65, -6.35, -5.65, -2.35, -1.65, 1.65, 2.35, 5.65, 6.35, 9.65]');
        // Pier between 3.3 m windows in 4 m bays is 0.7 m; the shaft takes 90% of it, centred on the bay line
        // (the corner pilasters turn the corner by their 0.2 m projection instead of overhanging it).
        expect(out).toContain('shafts [-10.2, -9.685, -6.315, -5.685, -2.315, -1.685, 1.685, 2.315, 5.685, 6.315, 9.685, 10.2]');
        expect(out).toContain('overlap 0');
    }, 600000);

    it('a rule-set sill cannot push an opening through the floor above', async () => {
        const out = await run(`
parts = sb.create_building_parts(width=20, depth=12, floors=3, floor_height=3.2, facade_rules=[{"floors": 1, "sill_height_m": 3.0}])
b1, b2 = 0.8 + 4.2, 0.8 + 4.2 + 3.2
g1 = [p for p in part(parts, 'glass') if b1 < p[1] < b2 - 0.05 and abs(p[2] - 5.75) < 0.05]
print("floor1 glass", round(min(p[1] for p in g1), 3), round(max(p[1] for p in g1), 3), "next floor", b2)
`);
        // Sill clamped to floorH - 0.7 = 2.5 m: glass 7.5..7.8, under the 0.4 m lintel band below 8.2.
        expect(out).toContain('floor1 glass 7.5 7.8 next floor 8.2');
    }, 600000);

    it('rule validation names the field and the problem instead of leaking KeyError / TypeError', async () => {
        const out = await run(`
cases = (("sides-bare", {"sides": "south"}), ("sides-name", {"sides": ["foo"]}), ("balcony", {"balcony": "sometimes"}),
         ("floors-str", {"floors": "all"}), ("floors-rev", {"floors": (3, 1)}), ("type", {"window_width_m": "wide"}))
for label, rule in cases:
    try:
        sb.create_building_parts(width=20, depth=12, floors=3, facade_rules=[rule]); print("NO ERROR", label)
    except ValueError as e:
        print("RAISED", label, str(e)[:60])
    except Exception as e:
        print("LEAKED", label, type(e).__name__)
`);
        expect(out).toContain("RAISED sides-bare facade rule 0: 'sides' must be a list");
        expect(out).toContain("RAISED sides-name facade rule 0: unknown side 'foo'");
        expect(out).toContain("RAISED balcony facade rule 0: unknown balcony mode 'sometimes'");
        expect(out).toContain("RAISED floors-str facade rule 0: 'floors' must be an int");
        expect(out).toContain("RAISED floors-rev facade rule 0: 'floors' range (3, 1)");
        expect(out).toContain("RAISED type facade rule 0: 'window_width_m' does not accept");
        expect(out).not.toContain('NO ERROR');
        expect(out).not.toContain('LEAKED');
    }, 600000);

    it('a decal whose up is parallel to its normal still gets a full-size frame, and thick panels have a back', async () => {
        const out = await run(`
p = sn.weathering.make_decal_panel(sn.math.Vec3(0, 5, 0), sn.math.Vec3(0, 1, 0), sn.math.Vec3(0, 1, 0), 2.0, 1.0, 0.02, 0.004, "d")
P = pos(p)
xs, zs = [q[0] for q in P], [q[2] for q in P]
print("tris", len(list(p.indices)) // 3, "nan", any(math.isnan(c) for q in P for c in q), "span", round(max(xs) - min(xs), 3), round(max(zs) - min(zs), 3))
ny = sorted(set(round(v.normal.y, 2) for v in p.vertices))
print("normals_y", ny)
`);
        expect(out).toContain('tris 12 nan False span 2.0 1.0');   // front, back and four edges
        expect(out).toContain('normals_y [-1.0, 0.0, 1.0]');
    }, 600000);

    it('decal aging only lays weathering back where the decal has paint: a transparent decal changes nothing', async () => {
        const out = await run(`
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
def rgba(w, h, px):
    rows = b"".join(b"\\x00" + b"".join(px(x, y) for x in range(w)) for y in range(h))
    return b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
clear = rgba(8, 8, lambda x, y: b"\\xff\\x00\\x00\\x00")
opaque = rgba(8, 8, lambda x, y: b"\\xff\\x00\\x00\\xff")
parts = sb.create_building_parts(width=12, depth=8, floors=2)
walls = [q for q in parts if q.name.endswith("wall")]
prm = sn.weathering.WeatheringParams()
def bake(decals): return sn.weathering.bake_weathering(walls, list(parts), prm, "w", decals)["atlas_png"]
base = bake([])
at = lambda img: [(sn.math.Vec3(0, 3, 4.0), sn.math.Vec3(0, 0, 1), sn.math.Vec3(0, 1, 0), 2.0, 2.0, 0.35, 1.0, img)]
print("clear_same", base == bake(at(clear)), "opaque_differs", base != bake(at(opaque)))
try:
    sn.weathering.bake_weathering([], list(parts), prm, "w", []); print("NO ERROR empty")
except ValueError as e:
    print("RAISED empty", "no receiver" in str(e))
try:
    sb.write_textured_building(sb.constants.OUTPUT_GLB_PATH, parts, weathering={"receivers": ["nothing"]}); print("NO ERROR receivers")
except ValueError as e:
    print("RAISED receivers", "match no building part" in str(e))
`);
        expect(out).toContain('clear_same True opaque_differs True');
        expect(out).toContain('RAISED empty True');
        expect(out).toContain('RAISED receivers True');
        expect(out).not.toContain('NO ERROR');
    }, 600000);
});

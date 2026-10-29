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
import struct
import scratchbox as sb
def pos(m):
    b = m.get_positions_flat(); return [struct.unpack_from('<3f', b, i * 12) for i in range(len(b) // 12)]
def all_pos(parts):
    return [p for m in parts for p in pos(m)]
def raises(fn):
    try:
        fn(); return "NO ERROR"
    except ValueError as e:
        return "RAISED " + str(e)[:90]
`;

async function run(body: string): Promise<string> {
    const runner = NativePythonRunnerService.getInstance();
    const result = await runner.runScript(PRELUDE + body);
    expect(result.success, result.stderr).toBe(true);
    return result.stdout;
}

describe('Building footprint outlines', () => {
    it('builds an L plan with one facade per edge and nothing in the notch', async () => {
        const out = await run(`
fp = [(-14, 9), (14, 9), (14, -3), (-2, -3), (-2, -15), (-14, -15)]
parts = sb.create_building_parts(footprint=fp, floors=3, roof="flat", name="L",
                                 details={"quoin_course_m": 0.5, "balcony_floors": [1]}, facade_rules=[{"floors": 1, "balcony": "continuous"}])
print("facades", [(k, round(f["length"]), round(f["heading_deg"])) for k, f in parts.facades.items()])
P = all_pos(parts)
print("in notch", sum(1 for x, y, z in P if x > -1.0 and z < -4.0))
xs = [p[0] for p in P]; zs = [p[2] for p in P]
print("extent", round(min(xs)), round(max(xs)), round(min(zs)), round(max(zs)))
print("slots", sorted(m.name.split("_")[-1] for m in parts))
`);
        expect(out).toContain("facades [('edge0', 28, 180), ('edge1', 12, 90), ('edge2', 16, 0), ('edge3', 12, 90), ('edge4', 12, 0), ('edge5', 24, 270)]");
        expect(out).toContain('in notch 0');            // the inside corner is a return, balconies stop short of it
        expect(out).toContain('extent -15 15 -16 10');  // walls plus projecting trim, never more than a metre out
        expect(out).toContain("slots ['foundation', 'frame', 'glass', 'roof', 'trim', 'wall']");
    }, 600000);

    it('builds a courtyard plan whose inner walls face into the court and leaves the court open', async () => {
        const out = await run(`
parts = sb.create_building_parts(footprint=[(-18, 14), (18, 14), (18, -14), (-18, -14)],
                                 courtyards=[[(-8, 4), (8, 4), (8, -6), (-8, -6)]], floors=4, roof="flat", name="C",
                                 details={"pilaster_width_m": 0.5})
f = parts.facades
print("count", len(f))
print("court", sorted((round(v["length"]), round(v["heading_deg"])) for k, v in f.items() if int(k[4:]) >= 4))
print("in court", sum(1 for x, y, z in all_pos(parts) if abs(x) < 7.0 and -5.0 < z < 3.0))
`);
        expect(out).toContain('count 8');
        // the court's north wall (z = -6) faces south into it, its south wall faces north, and so on
        expect(out).toContain('court [(10, 90), (10, 270), (16, 0), (16, 180)]');
        expect(out).toContain('in court 0');
    }, 600000);

    it('cleans outlines and refuses ones it cannot build', async () => {
        const out = await run(`
noisy = [(-10, 6), (0, 6.2), (10, 6), (10, -6), (10.02, -6.01), (-10, -6)]
print("cleaned", len(sb.create_building_parts(footprint=noisy, floors=2, roof="flat", name="N").facades))
print("rect", sb.create_building_parts(footprint=[(-8, 6), (8, 6), (8, -6), (-8, -6)], floors=2, roof="flat", name="R").facades["edge0"]["heading_deg"])
print(raises(lambda: sb.create_building_parts(footprint=[(0, 0), (10, 10), (10, 0), (0, 10)], roof="flat")))
print(raises(lambda: sb.create_building_parts(footprint=[(-5, 5), (5, 5), (5, -5), (-5, -5)], courtyards=[[(0, 0), (9, 0), (9, 3)]], roof="flat")))
print(raises(lambda: sb.create_building_parts(footprint=[(-5, 5), (5, 5), (5, -5), (-5, -5)], roof="hip")))
print(raises(lambda: sb.create_building_parts(footprint=[(-5, 5), (5, 5), (5, -5), (-5, -5)], roof="flat", entrance_edge=7)))
print(raises(lambda: sb.create_building_parts(footprint=[(-5, 5), (5, 5), (5, -5), (-5, -5)], roof="flat", facade_rules=[{"sides": ["south"], "opening": False}])))
`);
        expect(out).toContain('cleaned 4');        // a 1-degree bend and a 2 cm jog are survey noise, not corners
        expect(out).toContain('rect 180.0');
        expect(out).toMatch(/RAISED footprint crosses itself/);
        expect(out).toMatch(/RAISED courtyard 0 reaches outside the footprint/);
        expect(out).toMatch(/RAISED a footprint outline takes roof="flat" for now/);
        expect(out).toMatch(/RAISED entrance_edge 7 is not an outer edge/);
        expect(out).toMatch(/RAISED facade rule 0: on a footprint outline, sides are edge indices/);
        expect(out).not.toContain('NO ERROR');
    }, 600000);
});

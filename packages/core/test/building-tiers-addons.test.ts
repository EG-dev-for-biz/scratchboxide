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
import json, os, struct, tempfile, warnings
import scratchbox as sb
import scratchbox_native as sn
def pos(m):
    b = m.get_positions_flat(); return [struct.unpack_from('<3f', b, i * 12) for i in range(len(b) // 12)]
def glb_json(path):
    d = open(path, "rb").read(); n = struct.unpack_from("<I", d, 12)[0]; return json.loads(d[20:20 + n])
`;

async function run(body: string): Promise<string> {
    const runner = NativePythonRunnerService.getInstance();
    const result = await runner.runScript(PRELUDE + body);
    expect(result.success, result.stderr).toBe(true);
    return result.stdout;
}

describe('Building tiers (stacking) and closed add-ons', () => {
    it('places a tier at base_y and offset, with its facades and chimney tops moved with it', async () => {
        const out = await run(`
low = sb.create_building_parts(width=20, depth=14, floors=3, roof="flat", name="Low")
top = sb.create_building_parts(width=12, depth=8, floors=2, plinth_height=0.0, roof="mansard", base_y=11.0, offset=(1.5, -2.0),
                               details={"chimney_count": 1}, name="Top")
ys = [p[1] for m in top for p in pos(m)]
xs = [p[0] for m in top if m.name.endswith("_wall") for p in pos(m)]
print("top min y", round(min(ys), 3))
print("top wall x", round(min(xs), 3), round(max(xs), 3))
print("south start", tuple(round(c, 3) for c in top.facades["south"]["start"]))
print("soot y", round(top.soot_sources[0][1], 2) > 11.0)
both = sb.stack_buildings(low, top)
print("parts", len(both), "keys", sorted(k for k in both.facades if "/" in k)[:2], "plain south is low", both.facades["south"] == low.facades["south"])
try:
    sb.stack_buildings(low, sb.create_building_parts(width=10, depth=8, floors=1, name="Low")); print("NO ERROR")
except ValueError as e:
    print("RAISED", "repeat" in str(e))
`);
        expect(out).toContain('top min y 11.0');
        expect(out).toContain('top wall x -4.5 7.5');          // 12 m wide, centred on x = 1.5
        expect(out).toContain('south start (-4.5, 11.0, 2.0)'); // 8 m deep, centred on z = -2
        expect(out).toContain('soot y True');
        expect(out).toContain("parts 10 keys ['Low/east', 'Low/north'] plain south is low True");
        expect(out).toContain('RAISED True');
        expect(out).not.toContain('NO ERROR');
    }, 600000);

    it('writes add-ons with their own provenance, shared slot textures and the weathering default', async () => {
        const out = await run(`
parts = sb.create_building_parts(width=16, depth=12, floors=2, name="B")
small = sn.meshops.bevel(sb.create_box(size=(0.6, 2.0, 0.4)), 0.02); small.translate(sn.math.Vec3(0, 1.0, 6.3))
small2 = sn.meshops.bevel(sb.create_box(size=(0.6, 2.0, 0.4)), 0.02); small2.translate(sn.math.Vec3(3, 1.0, 6.3))
dense = sb.sdf.sphere(0.4).to_mesh((-0.5, -0.5, -0.5), (0.5, 0.5, 0.5), 120); dense.translate(sn.math.Vec3(0, 8.0, 0))
path = os.path.join(tempfile.mkdtemp(), "b.glb")
coursed = {"coursed": {"unit_width_m": 0.6, "unit_height_m": 0.3, "joint_width_m": 0.01, "joint_depth_m": 0.005, "pixels_per_metre": 64}}
r = sb.write_textured_building(path, parts, {"foundation": coursed}, weathering={"texel_m": 0.25}, extras=[
    {"mesh": small, "slot": "foundation", "source": "test pier"},
    {"mesh": small2, "slot": "foundation", "provenance": "photo-inferred", "confidence": 0.6},
    {"mesh": dense, "slot": "ornament", "color": (0.8, 0.7, 0.6)},
])
for e in r["extras"]: print("extra", e["slot"], e["provenance"], e["weathered"], e["triangles"] > 20000)
g = glb_json(path)
mats = {m["name"]: m for m in g["materials"]}
meshes = {m["name"]: m for m in g["meshes"]}
tex = sorted({g["materials"][m["primitives"][0]["material"]]["pbrMetallicRoughness"].get("baseColorTexture", {}).get("index") for n, m in meshes.items() if "extras-foundation-" in n})
print("foundation add-ons share", tex)
prov = sorted(json.loads(json.dumps(g["materials"][meshes[n]["primitives"][0]["material"]].get("extras", {})))["scratchbox"]["provenance"] for n in meshes if "extras-" in n)
print("provenance", prov)
for bad in ({"mesh": small, "slot": "wall_x"}, {"mesh": small, "slot": "wall", "provenance": "measured-ish"}):
    try:
        sb.write_textured_building(path, parts, extras=[bad]); print("NO ERROR")
    except ValueError as e:
        print("RAISED")
r2 = sb.write_textured_building(path, parts, weathering={"texel_m": 0.25}, extras=[{"mesh": dense, "slot": "ornament", "weather": True}])
print("opt-in weathered", r2["extras"][0]["weathered"])
`);
        expect(out).toContain('extra foundation generated True False');
        expect(out).toContain('extra foundation photo-inferred True False');
        expect(out).toContain('extra ornament generated False True');    // dense: not weathered unless asked
        expect(out).toMatch(/foundation add-ons share \[\d+\]/);         // one texture for both
        expect(out).toContain("provenance ['generated', 'generated', 'photo-inferred']");
        expect(out.match(/RAISED/g)?.length).toBe(2);
        expect(out).not.toContain('NO ERROR');
        expect(out).toContain('opt-in weathered True');
    }, 600000);

    it('projects add-on UVs in world metres along the dominant axis', async () => {
        const out = await run(`
box = sb.create_box(size=(2.0, 3.0, 1.0)); box.translate(sn.math.Vec3(5.0, 1.5, 0.0))
m = sn.architecture.project_world_uvs(box)
P = pos(m); err = 0.0
for i, v in enumerate(m.vertices):
    x, y, z = P[i]
    n = v.normal
    if n.z > 0.9:   # front face: u along +X, v up (image top = up)
        err = max(err, abs(v.uv.x - x), abs(v.uv.y + y))
print("front face uv error", round(err, 6), "triangles", len(m.indices) // 3)
`);
        expect(out).toContain('front face uv error 0.0 triangles 12');
    }, 600000);
});

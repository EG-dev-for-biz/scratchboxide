/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Named faces and edges in sb (scratchbox_named_topology.hpp): makers name their faces, sb.meshops.bevel(edges=...)
 * bevels exactly the named edges and keeps the names, mesh.place_on sets a part on a named face, and every bad name
 * is refused loudly. Each case runs a real script through the native engine and checks the transformed geometry.
 */

import { describe, it, expect } from 'vitest';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';

/** Runs an sb script whose last stdout line is a JSON report, and returns the report. */
async function report(body: string): Promise<any> {
    const runner = NativePythonRunnerService.getInstance();
    const res = await runner.runScript(`
import json, math
import scratchbox as sb
V = sb.math.Vec2

def watertight(m):
    edges = {}
    pts = [ (round(v.position.x, 6), round(v.position.y, 6), round(v.position.z, 6)) for v in m.vertices ]
    ix = list(m.indices)
    for t in range(0, len(ix), 3):
        for k in range(3):
            a, b = pts[ix[t + k]], pts[ix[t + (k + 1) % 3]]
            key = (a, b) if a < b else (b, a)
            edges[key] = edges.get(key, 0) + 1
    return sum(1 for c in edges.values() if c != 2)

def plate(name="plate"):
    return sb.geometry.extrude_polygon([V(-0.4, -0.2), V(0.4, -0.2), V(0.4, 0.2), V(-0.4, 0.2)], 0.0, 0.06, name=name)

def refusal(fn):
    try:
        fn()
    except Exception as e:
        return str(e)
    return None

out = {}
${body}
sb.io.write_glb(OUTPUT_GLB_PATH, last)
print(json.dumps(out))
`, { timeoutMs: 120000 });
    expect(res.success, res.errorDetails || res.stderr).toBe(true);
    return JSON.parse(res.stdout.trim().split('\n').pop() || '{}');
}

describe('sb named faces and edges', () => {
    it('an extrusion names its caps and walls, and chamfering "top" cuts only the top loop', async () => {
        const r = await report(`
p = plate()
out["faces"] = p.face_names()
out["edges"] = p.edge_names()
c = sb.meshops.bevel(p, 0.015, segments=1, edges="top")
out["ys"] = sorted({round(v.position.y, 5) for v in c.vertices})
top = c.face_frame("top")
out["top_area"] = top["area"]
out["top_origin"] = top["origin"]
bottom = [v.position for v in c.vertices if abs(v.position.y) < 1e-6]
out["bottom_x"] = [min(q.x for q in bottom), max(q.x for q in bottom)]
out["after_faces"] = c.face_names()
out["after_edges"] = c.edge_names()
out["open"] = watertight(c)
out["tris"] = [p.triangle_count, c.triangle_count]
last = c
`);
        expect(r.faces).toEqual(['bottom', 'plate.bottom', 'plate.side', 'plate.top', 'side', 'top']);
        expect(r.edges).toEqual(['bottom', 'plate.bottom', 'plate.side', 'plate.top', 'side', 'top']);
        // the top loop is cut 15 mm down and in; the bottom keeps its full 0.8 m outline
        expect(r.ys).toEqual([0, 0.045, 0.06]);
        expect(r.top_area).toBeCloseTo((0.8 - 0.03) * (0.4 - 0.03), 5);
        expect(r.top_origin[1]).toBeCloseTo(0.06, 6);
        expect(r.bottom_x[0]).toBeCloseTo(-0.4, 6);
        expect(r.bottom_x[1]).toBeCloseTo(0.4, 6);
        expect(r.after_faces).toContain('chamfer');
        expect(r.after_faces).toContain('top');
        expect(r.after_edges).toEqual(expect.arrayContaining(['chamfer', 'top', 'bottom', 'side']));
        expect(r.open).toBe(0);
        expect(r.tris[1]).toBeGreaterThan(r.tris[0]);
    }, 300000);

    it('filleting "side" rounds only the vertical corners (a bevel that ends on the caps), keeping the names', async () => {
        const r = await report(`
p = plate()
f = sb.meshops.bevel(p, 0.02, segments=4, edges="side")
top = [v.position for v in f.vertices if abs(v.position.y - 0.06) < 1e-6]
out["corner_left"] = any(abs(q.x - 0.4) < 1e-5 and abs(q.z - 0.2) < 1e-5 for q in top)
out["max_x"] = max(q.x for q in top)
# every top point near the +x+z corner lies on the 20 mm round about (0.38, 0.18)
near = [q for q in top if q.x > 0.38 + 1e-6 and q.z > 0.18 + 1e-6]
out["corner_radius"] = [math.hypot(q.x - 0.38, q.z - 0.18) for q in near]
out["y_range"] = [f.bounds.min.y, f.bounds.max.y]
out["cap_areas"] = [f.face_frame("top")["area"], f.face_frame("bottom")["area"]]
out["faces"] = f.face_names()
out["edges"] = f.edge_names()
out["open"] = watertight(f)
g = sb.meshops.bevel(f, 0.008, segments=3, edges="top")
out["then_top_ys"] = sorted({round(v.position.y, 5) for v in g.vertices})
out["then_top_open"] = watertight(g)
last = g
`);
        expect(r.corner_left).toBe(false);
        expect(r.max_x).toBeCloseTo(0.4, 5);
        expect(r.corner_radius.length).toBeGreaterThan(0);
        for (const d of r.corner_radius) expect(d).toBeLessThanOrEqual(0.02 + 1e-4);
        expect(r.y_range[0]).toBeCloseTo(0, 6);              // nothing cut from the caps' height
        expect(r.y_range[1]).toBeCloseTo(0.06, 6);
        // both caps lose the same four corners: 0.8 x 0.4 less 4 x (r^2 - pi r^2 / 4), less the 4-facet chords
        const round = 0.32 - (4 - Math.PI) * 0.02 * 0.02;
        for (const a of r.cap_areas) { expect(a).toBeLessThan(round); expect(a).toBeGreaterThan(round - 1e-4); }
        expect(r.faces).toEqual(expect.arrayContaining(['fillet', 'top', 'bottom', 'side']));
        expect(r.edges).not.toContain('side');               // the side edges became the fillet
        expect(r.edges).toEqual(expect.arrayContaining(['fillet', 'top']));
        expect(r.open).toBe(0);
        expect(r.then_top_ys[0]).toBe(0);
        expect(r.then_top_ys[r.then_top_ys.length - 1]).toBeCloseTo(0.06, 6);
        expect(r.then_top_ys.some((y: number) => y > 0.05 && y < 0.06)).toBe(true);
        expect(r.then_top_open).toBe(0);
    }, 300000);

    it('place_on sets a part on a named face, and a merge keeps both parts\' names', async () => {
        const r = await report(`
base = sb.meshops.bevel(plate("base"), 0.01, edges="top")
boss = sb.create_box(0.1, 0.2, 0.1, name="boss")
boss.place_on(base, "top", u=0.15, v=-0.05)
out["boss"] = [[boss.bounds.min.x, boss.bounds.min.y, boss.bounds.min.z], [boss.bounds.max.x, boss.bounds.max.y, boss.bounds.max.z]]
side = sb.create_box(0.05, 0.05, 0.05, name="tab")
side.place_on(base, "side", gap=0.0)
fr = base.face_frame("side")
out["side_frame"] = fr
out["tab_min_along_normal"] = min((v.position.x - fr["origin"][0]) * fr["normal"][0] + (v.position.y - fr["origin"][1]) * fr["normal"][1] + (v.position.z - fr["origin"][2]) * fr["normal"][2] for v in side.vertices)
both = sb.geometry.merge_meshes([base, boss])
out["merged_faces"] = both.face_names()
out["boss_top_y"] = both.face_frame("boss.top")["origin"][1]
last = both
`);
        const [lo, hi] = r.boss;
        expect(lo[1]).toBeCloseTo(0.06, 5);                  // standing on the top face
        expect(hi[1]).toBeCloseTo(0.26, 5);
        expect((lo[0] + hi[0]) / 2).toBeCloseTo(0.15, 5);    // u along the frame's x (+X on a +Y face)
        expect((lo[2] + hi[2]) / 2).toBeCloseTo(-0.05, 5);   // v along its z
        expect(Math.abs(r.side_frame.normal[1])).toBeLessThan(1e-6);
        expect(r.tab_min_along_normal).toBeCloseTo(0, 5);    // touching the side face, outside it
        expect(r.merged_faces).toEqual(expect.arrayContaining(['base.top', 'base.chamfer', 'boss.top', 'boss.side']));
        expect(r.boss_top_y).toBeCloseTo(0.26, 5);
    }, 300000);

    it('a boolean keeps both operands\' names, and a plain name that reaches a concave floor is refused', async () => {
        const r = await report(`
p = plate()
tool = sb.geometry.extrude_polygon([V(-0.1, -0.05), V(0.1, -0.05), V(0.1, 0.05), V(-0.1, 0.05)], 0.03, 0.1, name="slot")
c = sb.geometry.boolean_mesh(p, tool, "subtract")
out["faces"] = c.face_names()
floor = c.face_frame("slot.bottom")
out["floor"] = [floor["origin"][1], floor["normal"][1], floor["area"]]
out["plain_bottom"] = refusal(lambda: sb.meshops.bevel(c, 0.004, edges="bottom"))
b = sb.meshops.bevel(c, 0.004, edges="plate.bottom")
out["qualified_ys"] = sorted({round(v.position.y, 5) for v in b.vertices})
out["open"] = watertight(b)
last = b
`);
        expect(r.faces).toEqual(expect.arrayContaining(['plate.top', 'plate.side', 'slot.bottom', 'slot.side']));
        expect(r.floor[0]).toBeCloseTo(0.03, 5);             // the pocket floor, 30 mm up, facing up out of the solid
        expect(r.floor[1]).toBeCloseTo(1, 5);
        expect(r.floor[2]).toBeCloseTo(0.2 * 0.1, 5);
        expect(r.plain_bottom).toMatch(/concave .*qualified name/);
        expect(r.qualified_ys).toEqual([0, 0.004, 0.03, 0.06]);
        expect(r.open).toBe(0);
    }, 300000);

    it('refuses loudly: unknown names, a cap name from another maker, a smooth wall, a concave edge, lost names', async () => {
        const r = await report(`
p = plate()
out["unknown"] = refusal(lambda: sb.meshops.bevel(p, 0.01, edges="rim"))
out["typo"] = refusal(lambda: sb.meshops.bevel(p, 0.01, edges="tpo"))
out["start"] = refusal(lambda: sb.meshops.bevel(p, 0.01, edges="start"))
circle = sb.geometry.extrude_polygon([V(0.2 * math.cos(t * math.pi / 24), 0.2 * math.sin(t * math.pi / 24)) for t in range(48)], 0, 0.1)
out["circle_edges"] = circle.edge_names()
out["circle_side"] = refusal(lambda: sb.meshops.bevel(circle, 0.01, edges="side"))
L = sb.geometry.extrude_polygon([V(0, 0), V(0.4, 0), V(0.4, 0.1), V(0.1, 0.1), V(0.1, 0.3), V(0, 0.3)], 0, 0.05)
out["concave"] = refusal(lambda: sb.meshops.bevel(L, 0.01, edges="side"))
s = sb.create_box(1, 1, 1)
s.isotropic_remesh(0.2, 2, 30.0)
out["lost"] = refusal(lambda: s.face_frame("top"))
out["unnamed"] = refusal(lambda: sb.geometry.create_sphere(1.0).face_frame("top"))
out["face_unknown"] = refusal(lambda: p.face_frame("front"))
last = p
`);
        expect(r.unknown).toMatch(/has no edge named 'rim'; its edge names: .*top/);
        expect(r.typo).toMatch(/Did you mean 'top'\?/);
        expect(r.start).toMatch(/caps top and bottom/);
        expect(r.circle_edges).toEqual(['bottom', 'top']);
        expect(r.circle_side).toMatch(/turns smoothly all round/);
        expect(r.concave).toMatch(/concave/);
        expect(r.lost).toMatch(/rebuilt its triangles/);
        expect(r.unnamed).toMatch(/carries no face or edge names/);
        expect(r.face_unknown).toMatch(/has no face named 'front'/);
    }, 300000);
});

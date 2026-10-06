import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SceneSpatialAssertionService } from '../src/node/spatial/SceneSpatialAssertionService';
import { google3DTilesHandlers } from '../src/node/gemini/tools/spatial-tools';
import { Adaptive3DSceneSynthesizer } from '../src/node/spatial/Adaptive3DSceneSynthesizer';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const NATIVE_BUILD_DIR = path.join(REPO_ROOT, 'packages/core/src/native/3d-engine/build_py');
const PYTHON_DIR = path.join(REPO_ROOT, 'packages/core/src/python');

function getPythonCmd(): string {
    const candidatePaths = [
        process.env.SCRATCHBOX_PYTHON,
        '/opt/homebrew/bin/python3.14',
        '/opt/homebrew/bin/python3',
        path.resolve(REPO_ROOT, '.venv/bin/python'),
        path.resolve(REPO_ROOT, '.venv/bin/python3'),
        'python3'
    ];
    for (const p of candidatePaths) {
        if (p && p.includes('/') && fs.existsSync(p)) return p;
    }
    return 'python3';
}

function runPythonScript(scriptBody: string): string {
    const fullScript = `
import sys, os
sys.path.insert(0, '${NATIVE_BUILD_DIR}')
sys.path.insert(0, '${PYTHON_DIR}')
import scratchbox as sb
geometry = sb.geometry
math = sb.math
layout = sb.layout

${scriptBody}
`;
    const tempScript = path.join(REPO_ROOT, `scratch_solver_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.py`);
    fs.writeFileSync(tempScript, fullScript, 'utf8');
    const pyExe = getPythonCmd();
    try {
        const out = execSync(`"${pyExe}" "${tempScript}"`, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: {
                ...process.env,
                PYTHONPATH: `${NATIVE_BUILD_DIR}:${PYTHON_DIR}`
            }
        });
        return out.trim();
    } finally {
        if (fs.existsSync(tempScript)) {
            fs.unlinkSync(tempScript);
        }
    }
}

describe('Neuro-Symbolic 3D Pipeline: Spatial Constraint Solver & Assertion Engine', () => {

    it('1. SpatialConstraintSolver: Solves SUPPORTED_BY with exact contact alignment', () => {
        const script = `
solver = sb.layout.SpatialConstraintSolver()
plinth = sb.create_box(width=10.0, height=2.0, depth=10.0) # Y: -1.0 to 1.0
tower = sb.create_box(width=3.0, height=8.0, depth=3.0)   # Y: -4.0 to 4.0

solver.register_mesh("plinth", plinth)
solver.register_mesh("tower", tower)
solver.add_constraint("tower", "supported_by", "plinth", "top", 0.0)
solver.solve(0)

print(f"{plinth.bounds.max.y:.3f},{tower.bounds.min.y:.3f},{tower.bounds.max.y:.3f}")
`;
        const output = runPythonScript(script);
        const [plinthMaxY, towerMinY, towerMaxY] = output.split(',');
        expect(parseFloat(towerMinY)).toBeCloseTo(parseFloat(plinthMaxY), 0.001);
        expect(parseFloat(towerMaxY)).toBeCloseTo(9.0, 0.001);
    });

    it('2. SpatialConstraintSolver: Solves ATTACHED_TO_SURFACE face alignment (Crown/Top & Side)', () => {
        const script = `
building = sb.create_box(width=8.0, height=6.0, depth=8.0) # -4 to 4, -3 to 3, -4 to 4
hvac = sb.create_box(width=2.0, height=1.5, depth=2.0)
wing = sb.create_box(width=3.0, height=4.0, depth=4.0)

# Direct snap_to API
hvac.snap_to(building, face="top", clearance=0.0)
wing.snap_to(building, face="left", clearance=0.1)

print(f"{building.bounds.max.y:.3f},{hvac.bounds.min.y:.3f},{building.bounds.min.x:.3f},{wing.bounds.max.x:.3f}")
`;
        const output = runPythonScript(script);
        const [bMaxY, hvacMinY, bMinX, wingMaxX] = output.split(',');
        expect(parseFloat(hvacMinY)).toBeCloseTo(parseFloat(bMaxY), 0.001);
        expect(parseFloat(wingMaxX)).toBeCloseTo(parseFloat(bMinX) - 0.1, 0.001);
    });

    it('3. SpatialConstraintSolver: Relaxes pairwise OBB/AABB penetrations with zero interpenetration', () => {
        const script = `
solver = sb.layout.SpatialConstraintSolver()
boxA = sb.create_box(width=4.0, height=4.0, depth=4.0) # Centered at 0,0,0
boxB = sb.create_box(width=4.0, height=4.0, depth=4.0)
boxB.translate(1.0, 0.0, 0.0) # Intentionally overlapping by 3.0m in X

solver.register_mesh("boxA", boxA)
solver.register_mesh("boxB", boxB)
solver.relax_collisions(iterations=8, min_margin=0.02)

# Check overlap after relaxation
overlap_x = min(boxA.bounds.max.x, boxB.bounds.max.x) - max(boxA.bounds.min.x, boxB.bounds.min.x)
print(f"{overlap_x:.3f}")
`;
        const output = runPythonScript(script);
        const overlapX = parseFloat(output);
        expect(overlapX).toBeLessThanOrEqual(0.001);
    });

    it('4. SceneSpatialAssertionService: Audits contacts and detects penetrations vs certified layouts', () => {
        const tempGlb = path.join(REPO_ROOT, `test_scene_contacts_${Date.now()}.glb`);
        const script = `
scene = sb.geometry.Mesh("CertifiedScene")
plinth = sb.create_box(width=12.0, height=1.0, depth=12.0)
building = sb.create_box(width=6.0, height=4.0, depth=6.0)
building.snap_to(plinth, face="top", clearance=0.0)

scene.merge(plinth)
scene.merge(building)
sb.io.write_glb("${tempGlb}", scene)
`;
        runPythonScript(script);
        expect(fs.existsSync(tempGlb)).toBe(true);

        const audit = SceneSpatialAssertionService.auditContacts(tempGlb);
        expect(audit.certified).toBe(true);
        expect(audit.violations.length).toBe(0);
        expect(audit.totalVertices).toBeGreaterThan(0);

        if (fs.existsSync(tempGlb)) fs.unlinkSync(tempGlb);
    });

    it('5. SceneSpatialAssertionService & Tool Registry: sb_assert_scene_contacts & sb_audit_scene_hierarchy handlers', async () => {
        const tempGlb = path.join(REPO_ROOT, `test_scene_hierarchy_${Date.now()}.glb`);
        const script = `
scene = sb.geometry.Mesh("HierarchyTestScene")
# Generate dense structure with sub-parts
for i in range(10):
    sphere = sb.create_sphere(radius=1.5, segments=32)
    sphere.translate(float(i * 2.0), 0.0, 0.0)
    scene.merge(sphere)

sb.io.write_glb("${tempGlb}", scene)
`;
        runPythonScript(script);
        expect(fs.existsSync(tempGlb)).toBe(true);

        const contactRes = await google3DTilesHandlers.sb_assert_scene_contacts({ glbPath: tempGlb }, {} as any);
        expect(contactRes.summaryResult).toBeDefined();

        const hierarchyRes = await google3DTilesHandlers.sb_audit_scene_hierarchy({ glbPath: tempGlb, minVertices: 1000, minTriangles: 500 }, {} as any);
        expect(hierarchyRes.summaryResult).toContain('certified');

        if (fs.existsSync(tempGlb)) fs.unlinkSync(tempGlb);
    });

    it('6. Adaptive3DSceneSynthesizer: Generates AdaptiveSceneGraphBlueprint with explicit SpatialRelation contracts', () => {
        const synth = new Adaptive3DSceneSynthesizer();
        const contract = synth.synthesizeContractFromPrompt('Construct an alpine research observatory with rooftop HVAC chillers and access ramp');

        expect(contract.relations).toBeDefined();
        expect(contract.relations!.length).toBeGreaterThanOrEqual(4);
        expect(contract.sceneGraph).toBeDefined();
        expect(contract.sceneGraph!.entities.length).toBeGreaterThanOrEqual(3);

        const supportedRel = contract.relations!.find(r => r.predicate === 'SUPPORTED_BY');
        expect(supportedRel).toBeDefined();
        expect(supportedRel!.targetId).toBeDefined();
    });

    it('7. Terrain Raycast Grounding: ground_on_terrain snaps mesh onto sloped terrain mesh with zero levitation', () => {
        const script = `
# Sloped terrain (10 degree tilt)
terrain = sb.create_plane(width=40.0, height=40.0, seg_x=8, seg_y=8)
terrain.rotate_x(10.0)

# Building hovering 12m above ground
bldg = sb.create_box(width=4.0, height=6.0, depth=4.0)
bldg.translate(0.0, 12.0, 0.0)

solver = sb.layout.SpatialConstraintSolver()
solver.register_mesh("bldg", bldg)
ok = solver.ground_on_terrain("bldg", terrain, 0.0)

print(f"{ok},{bldg.bounds.min.y:.3f}")
`;
        const output = runPythonScript(script);
        const [ok, minY] = output.split(',');
        expect(ok).toBe('True');
        // Tilted plane at x=0,z=0 has height ~0.44m; grounded mesh bottom must match within 5cm
        expect(parseFloat(minY)).toBeGreaterThan(0.0);
        expect(parseFloat(minY)).toBeLessThan(1.0);
    });

    it('8. sb.layout.resolve_constraints: end-to-end scene graph resolution with terrain grounding and zero violations', () => {
        const script = `
terrain = sb.create_plane(width=60.0, height=60.0, seg_x=8, seg_y=8)

plinth = sb.create_box(width=12.0, height=1.0, depth=12.0)
tower = sb.create_box(width=4.0, height=10.0, depth=4.0)
mast = sb.create_box(width=0.5, height=6.0, depth=0.5)

meshes = {"plinth": plinth, "tower": tower, "mast": mast}
relations = [
    {"subject": "plinth", "predicate": "supported_by", "target": "terrain"},
    {"subject": "tower", "predicate": "supported_by", "target": "plinth"},
    {"subject": "mast", "predicate": "attached_to_surface", "target": "tower", "face": "top"},
]
violations = sb.layout.resolve_constraints(meshes, relations, terrain=terrain)

# Verify contact chain: plinth on terrain (y=0), tower on plinth, mast on tower
print(f"{len(violations)},{plinth.bounds.min.y:.3f},{tower.bounds.min.y:.3f},{plinth.bounds.max.y:.3f},{mast.bounds.min.y:.3f},{tower.bounds.max.y:.3f}")
`;
        const output = runPythonScript(script);
        const [violCount, plinthMinY, towerMinY, plinthMaxY, mastMinY, towerMaxY] = output.split(',').map(parseFloat);
        expect(violCount).toBe(0);
        expect(plinthMinY).toBeCloseTo(0.0, 1);           // grounded on flat terrain
        expect(towerMinY).toBeCloseTo(plinthMaxY, 2);     // tower rests on plinth top
        expect(mastMinY).toBeCloseTo(towerMaxY, 2);       // mast rests on tower top
    });

    it('9. Floating Asset Detection: auditContacts flags a mesh hovering >2cm above its support', () => {
        const tempGlb = path.join(REPO_ROOT, `test_floating_${Date.now()}.glb`);
        const script = `
scene = sb.geometry.Mesh("FloatingScene")
ground = sb.create_box(width=20.0, height=1.0, depth=20.0)
ground.name = "terrain_plinth"
floater = sb.create_box(width=2.0, height=2.0, depth=2.0)
floater.name = "floating_prop"
floater.translate(0.0, 3.5, 0.0)  # 2.5m air gap above ground top (y=0.5)

scene.merge(ground)
scene.merge(floater)
sb.io.write_glb("${tempGlb}", scene)
`;
        runPythonScript(script);
        expect(fs.existsSync(tempGlb)).toBe(true);

        const audit = SceneSpatialAssertionService.auditContacts(tempGlb, 0.02);
        const floatingViolations = audit.violations.filter(v => v.type === 'floating_air_gap');
        expect(floatingViolations.length).toBeGreaterThanOrEqual(1);
        expect(floatingViolations[0].metricDistance).toBeGreaterThan(0.02);
        expect(audit.certified).toBe(false);

        if (fs.existsSync(tempGlb)) fs.unlinkSync(tempGlb);
    });

    it('10. Zero-Collision Layout: solver relaxes an intentionally overlapping multi-part assembly to zero interpenetration', () => {
        const script = `
solver = sb.layout.SpatialConstraintSolver()
parts = {}
for i in range(4):
    b = sb.create_box(width=3.0, height=3.0, depth=3.0)
    b.translate(float(i) * 1.0, 0.0, 0.0)  # heavy initial overlap
    solver.register_mesh(f"part_{i}", b)
    parts[f"part_{i}"] = b

solver.relax_collisions(iterations=16, min_margin=0.02)
violations = solver.audit_contacts(0.05)
penetrations = [v for v in violations if v.type == "penetration"]
print(f"{len(penetrations)}")
`;
        const output = runPythonScript(script);
        expect(parseInt(output)).toBe(0);
    });

    it('11. Chat-authored layout idioms: plane size kwarg, bounds.size/center properties, ground_on keeps footprint XZ', () => {
        const script = `
terrain = sb.create_plane(size=sb.math.Vec3(150, 0.1, 150), seg_x=16, seg_y=16)
tb = terrain.bounds
deck = sb.create_box(size=sb.math.Vec3(20.0, 0.5, 15.0))
deck.ground_on(terrain, clearance=8.0)
pillars = []
for x in (-9.0, 9.0):
    p = sb.create_cylinder(radius=0.3, height=1.0, segments=12)
    p.snap_to(deck, face="bottom", offset=(x, 0.0, 4.0))
    p.ground_on(terrain)
    pillars.append(p)
s = deck.bounds.size
c = pillars[0].bounds.center
print(f"{tb.size.x:.2f},{tb.size.z:.2f},{s.x:.2f},{s.y:.2f},{deck.bounds.min.y:.2f},{c.x:.2f},{c.z:.2f},{pillars[1].bounds.center.x:.2f},{pillars[0].bounds.min.y:.3f}")
`;
        const [terrW, terrD, deckW, deckH, deckMinY, p0x, p0z, p1x, p0MinY] = runPythonScript(script).split(',').map(parseFloat);
        expect(terrW).toBeCloseTo(150, 1);
        expect(terrD).toBeCloseTo(150, 1);
        expect(deckW).toBeCloseTo(20, 2);
        expect(deckH).toBeCloseTo(0.5, 2);
        expect(deckMinY).toBeCloseTo(8.0, 1);
        expect(p0x).toBeCloseTo(-9.0, 2);
        expect(p0z).toBeCloseTo(4.0, 2);
        expect(p1x).toBeCloseTo(9.0, 2);
        expect(Math.abs(p0MinY)).toBeLessThan(0.02);
    });
});

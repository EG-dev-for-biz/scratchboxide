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
});

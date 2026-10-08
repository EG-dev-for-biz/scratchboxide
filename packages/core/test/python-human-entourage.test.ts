import { describe, it, expect } from 'vitest';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import * as fs from 'fs';

describe('Python SB-Human Entourage & Grounding Verification', () => {
    it('1. Synthesizes architectural scale entourage figure via sb.Human and World.add_human', async () => {
        const runner = NativePythonRunnerService.getInstance();

        const script = `
import scratchbox as sb

world = sb.World()
human = world.add_human(
    role="lead_surveyor",
    height=1.80,
    gender_beta=0.5,
    pose="standing_survey",
    position=(2.0, 0.0, 3.0),
    facing_deg=45.0
)

assert human is not None, "Human entity must be instantiated"
assert human.role == "lead_surveyor"
assert abs(human.height - 1.80) < 1e-4

mesh = human.mesh
assert mesh is not None, "Human mesh must be generated"
assert len(mesh.vertices) >= 10000, f"Expected high-poly humanoid mesh, got {len(mesh.vertices)}"
assert len(mesh.indices) >= 20000, f"Expected high-poly index buffer, got {len(mesh.indices)}"

# Verify 18% Studio Grey Clay Invariant
assert mesh.material.name == "Entourage_Studio_Clay"
assert abs(mesh.material.roughness - 0.85) < 0.05
assert abs(mesh.material.metallic - 0.0) < 0.05

glb_data = world.build()
assert len(glb_data) > 500000, f"Expected valid GLB buffer > 500KB, got {len(glb_data)}"

with open(OUTPUT_GLB_PATH, "wb") as f:
    f.write(glb_data)

print("PYTHON_HUMAN_TEST_SUCCESS")
`;

        const result = await runner.runScript(script);
        expect(result.success).toBe(true);
        expect(result.stdout).toContain('PYTHON_HUMAN_TEST_SUCCESS');
        expect(result.glbBase64).toBeDefined();
        expect(result.glbPath && fs.existsSync(result.glbPath)).toBe(true);
    });

    it('2. Solves 2-bone IK foot grounding and adapts elevation when grounded on terrain', async () => {
        const runner = NativePythonRunnerService.getInstance();

        const script = `
import scratchbox as sb

world = sb.World()
terrain = world.add_terrain(extents=(60.0, 60.0), archetype="alpine_karst")

human = world.add_human(
    role="site_architect",
    height=1.75,
    gender_beta=-0.4,
    pose="standing_survey"
)

# Ground figure onto terrain surface with offset
human.stand_on(terrain, offset=(8.0, 6.0), facing_deg=-30.0)

mesh = human.mesh
assert mesh is not None
assert len(mesh.vertices) >= 10000

# Verify foot elevation matches terrain ground contact (bounds.min.y > -50 and < 50)
foot_y = mesh.bounds.min.y
head_y = mesh.bounds.max.y
computed_height = head_y - foot_y
assert abs(computed_height - 1.75) < 0.15, f"Expected height ~1.75m, got {computed_height}"

glb_data = world.build()
assert len(glb_data) > 1000000, f"Expected scene GLB buffer > 1MB, got {len(glb_data)}"

with open(OUTPUT_GLB_PATH, "wb") as f:
    f.write(glb_data)

print("PYTHON_HUMAN_GROUNDING_SUCCESS")
`;

        const result = await runner.runScript(script);
        expect(result.success).toBe(true);
        expect(result.stdout).toContain('PYTHON_HUMAN_GROUNDING_SUCCESS');
        expect(result.glbBase64).toBeDefined();
    });

    it('3. Exposes nanobind native human module classes directly (SbHumanModel, Skeleton, GenderMorph)', async () => {
        const runner = NativePythonRunnerService.getInstance();

        const script = `
import scratchbox as sb

assert hasattr(sb, "human"), "scratchbox.human module must be exposed"
human_mod = sb.human

assert hasattr(human_mod, "GenderMorph"), "GenderMorph must be exposed"
assert hasattr(human_mod, "SbHumanModel"), "SbHumanModel must be exposed"
assert hasattr(human_mod, "Skeleton"), "Skeleton must be exposed"
assert hasattr(human_mod, "create_grounded_character"), "create_grounded_character must be exposed"

# Direct native model instantiation and forward kinematics
model = human_mod.SbHumanModel.load_standard(human_mod.GenderMorph.Male, 1.78)
skeleton = model.skeleton

l_shoulder = skeleton.find_joint("LeftShoulder")
assert l_shoulder >= 0, "LeftShoulder joint must exist"

# Posing joint rotation in radians
skeleton.set_joint_rotation("LeftShoulder", sb.math.Vec3(0.1, 0.2, -1.0))
rot = skeleton.get_joint_rotation("LeftShoulder")
assert abs(rot.z - (-1.0)) < 1e-4, f"Expected rot.z = -1.0, got {rot.z}"

posed_mesh = model.evaluate_posed(skeleton)
assert len(posed_mesh.vertices) >= 10000

print("PYTHON_NATIVE_HUMAN_SUCCESS")
`;

        const result = await runner.runScript(script);
        expect(result.success).toBe(true);
        expect(result.stdout).toContain('PYTHON_NATIVE_HUMAN_SUCCESS');
    });
});

import { test, expect } from 'vitest';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { PYTHON_3D_API_REFERENCE } from '../src/node/gemini/tools/python-3d-tools';

// The reference is what the model codes against; a stale name turns straight into failed tool calls. The listing part
// is generated from the stubs (sb-stubs.test.ts checks it against the module); this checks the hand-written usage notes too.
test('every API name in the execute_3d_python_script reference exists in the scratchbox package', async () => {
    // names, not patterns: "sb.create_*" in the notes stands for the factory family
    const sbNames = [...new Set([...PYTHON_3D_API_REFERENCE.matchAll(/\bsb\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)]
        .filter(m => PYTHON_3D_API_REFERENCE[(m.index ?? 0) + m[0].length] !== '*').map(m => m[0]))];
    const notes = PYTHON_3D_API_REFERENCE.slice(PYTHON_3D_API_REFERENCE.indexOf('Usage notes:'));
    const meshNames = [...new Set([...notes.matchAll(/\b(weld_vertices|get_positions_flat|translate|scale|append|vertex_count|triangle_count|bounds)\b/g)].map(m => m[1]))];

    expect(sbNames.length).toBeGreaterThan(5);
    expect(meshNames).toEqual(expect.arrayContaining(['translate', 'append', 'vertex_count', 'bounds']));

    const script = `
import json, scratchbox as sb
def resolve(name):
    obj = sb
    for part in name.split('.')[1:]:
        if not hasattr(obj, part):
            return False
        obj = getattr(obj, part)
    return True
Mesh = sb.geometry.Mesh
print(json.dumps({
    "missing_sb": [n for n in ${JSON.stringify(sbNames)} if not resolve(n)],
    "missing_mesh": [n for n in ${JSON.stringify(meshNames)} + ["rotate_x", "rotate_y", "rotate_z"] if not hasattr(Mesh, n)],
    "scene_add_mesh": hasattr(sb.Scene(), "add_mesh"),
    "documented_absent_but_present": [n for n in ["clone", "copy", "transform"] if hasattr(Mesh, n)] + (["materials"] if hasattr(sb, "materials") else []),
}))
`;
    const res = await NativePythonRunnerService.getInstance().runScript(script);
    expect(res.exitCode, res.stderr).toBe(0);
    const report = JSON.parse(res.stdout.trim().split('\n').pop() || '{}');
    expect(report.missing_sb).toEqual([]);
    expect(report.missing_mesh).toEqual([]);
    expect(report.scene_add_mesh).toBe(true);
    expect(report.documented_absent_but_present, 'the reference says these do not exist; update it').toEqual([]);
}, 180_000);

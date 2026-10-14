import { test, expect } from 'vitest';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { PYTHON_3D_API_REFERENCE } from '../src/node/gemini/tools/python-3d-tools';

// The reference is what the model codes against; a stale name turns straight into failed tool calls.
test('every API name in the execute_3d_python_script reference exists in the scratchbox package', async () => {
    const sbNames = [...new Set(PYTHON_3D_API_REFERENCE.match(/\bsb\.[A-Za-z_]+(?:\.[A-Za-z_]+)*/g) || [])];
    const meshLine = PYTHON_3D_API_REFERENCE.split('\n').find(l => l.startsWith('- Mesh methods')) || '';
    const meshMethods = [...new Set([...meshLine.matchAll(/([a-z_]+)\(/g)].map(m => m[1]))];
    const meshProps = (/parentheses: ([^\n]+?)\.$/m.exec(meshLine)?.[1] || '')
        .split(',').map(p => p.trim().split(' ')[0]).filter(Boolean);

    expect(sbNames.length).toBeGreaterThan(15);
    expect(meshMethods).toEqual(expect.arrayContaining(['translate', 'rotate_y', 'append', 'set_material']));
    expect(meshProps).toEqual(['vertex_count', 'triangle_count', 'bounds']);

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
    "missing_mesh": [n for n in ${JSON.stringify([...meshMethods, ...meshProps])} if not hasattr(Mesh, n)],
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

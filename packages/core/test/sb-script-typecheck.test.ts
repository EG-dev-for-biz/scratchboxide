import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifySbDiagnostics, formatSbApiErrors, suggestNames, typeCheckSbScript, SB_TYPECHECK_TIMEOUT_MS } from '../src/node/3d-engine/sb-script-typecheck';
import { SB_API_VERSION } from '../src/node/3d-engine/sb-api.generated';
import { python3DHandlers } from '../src/node/gemini/tools/python-3d-tools';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';

// A valid scene in the style the guide teaches: facade factories, patched Mesh methods, materials, Scene, export.
const VALID = `import scratchbox as sb
import math

scene = sb.Scene()
body = sb.create_sphere(radius=1.0, rings=48, sectors=96)
body.displace(freq=1.4, amp=0.12)
body.scale(1.2, 0.8, 1.6)
body.translate(0.0, 1.0, 0.0)
mat = sb.PbrMaterial(base_color=(0.6, 0.6, 0.62, 1.0), roughness=0.8)
body.set_material(mat)
for i in range(6):
    a = i / 6.0 * math.tau
    leg = sb.sweep_curve_profile(path=[(math.cos(a) * 0.8, 0.6, math.sin(a) * 0.8), (math.cos(a) * 1.6, 0.0, math.sin(a) * 1.6)], profile_dimensions=(0.08, 0.08))
    body.append(leg)
body.set_material(sb.PbrMaterial.clay())
print(body.vertex_count, body.bounds.min.y)
scene.add_mesh(body)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`;

afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SCRATCHBOX_SB_TYPECHECK_TIMEOUT_MS;
});

describe('scratchbox script type check (basedpyright against the generated stubs)', () => {
    it('passes a valid script within the time limit', async () => {
        const r = await typeCheckSbScript(VALID);
        expect(r.status, JSON.stringify(r)).toBe('passed');
        expect(r.errors).toEqual([]);
        expect(r.apiVersion).toBe(SB_API_VERSION);
        expect(r.durationMs).toBeLessThan(SB_TYPECHECK_TIMEOUT_MS);
    }, 60_000);

    it('rejects a call to a method Mesh does not have, naming the line and the close real names', async () => {
        const script = VALID.replace('body.displace(freq=1.4, amp=0.12)', 'body.displace_noise(freq=1.4, amp=0.12)');
        const r = await typeCheckSbScript(script);
        expect(r.status).toBe('rejected');
        expect(r.errors).toHaveLength(1);
        const [e] = r.errors;
        expect(e.line).toBe(6);
        expect(e.message).toBe('Cannot access attribute "displace_noise" for class "Mesh"');
        expect(e.suggestions).toContain('displace');
        expect(e.source).toBe('body.displace_noise(freq=1.4, amp=0.12)');
        const text = formatSbApiErrors(r.errors);
        expect(text).toContain('it was not run');
        expect(text).toContain('line 6: Cannot access attribute "displace_noise" for class "Mesh" (did you mean: displace');
    }, 60_000);

    it('rejects unknown module members, unknown imports from the package, wrong keywords and non-callables', async () => {
        const script = `import scratchbox as sb
from scratchbox import create_torus
import scratchbox.materials
m = sb.create_cube_mesh(1.0)
v = sb.math.Vec3(1.0, 2.0, 3.0, 4.0)
w = sb.geometry.Mesh()
w.rotate_x(angle=30.0)
n = w.vertex_count()
`;
        const r = await typeCheckSbScript(script);
        expect(r.status).toBe('rejected');
        const byLine = new Map(r.errors.map(e => [e.line, e]));
        expect(byLine.get(2)?.message).toMatch(/"create_torus" is unknown import symbol/);
        expect(byLine.get(3)?.message).toMatch(/Import "scratchbox.materials" could not be resolved/);
        expect(byLine.get(4)?.message).toMatch(/"create_cube_mesh" is not a known attribute of module "scratchbox"/);
        expect(byLine.get(4)?.suggestions).toContain('create_cube');
        // a wrong argument count against an overloaded native constructor is reported by pyright as "No overloads",
        // which also covers plain type mismatches, so it does not block
        expect(byLine.has(5)).toBe(false);
        expect(byLine.get(7)?.message).toMatch(/No parameter named "angle"/);
        expect(byLine.get(8)?.message).toMatch(/is not callable/);
    }, 60_000);

    it('does not block on type mismatches, Optional access or missing third-party stubs', () => {
        const lines = ['p.root_hint = (0.0, 1.0, 0.0)', 'x = maybe.attr', 'import somepkg'];
        const { errors, ignored } = classifySbDiagnostics([
            { severity: 'error', rule: 'reportAttributeAccessIssue', message: 'Cannot assign to attribute "root_hint" for class "Params*"\n  Type "tuple[float, float, float]" is not assignable to type "list[float] | None"', range: { start: { line: 0, character: 0 } } },
            { severity: 'error', rule: 'reportOptionalMemberAccess', message: '"attr" is not a known attribute of "None"', range: { start: { line: 1, character: 4 } } },
            { severity: 'error', rule: 'reportArgumentType', message: 'Argument of type "tuple[float, float, float]" cannot be assigned to parameter "offset" of type "Vec3"', range: { start: { line: 0, character: 0 } } },
            { severity: 'error', rule: 'reportCallIssue', message: 'No overloads for "__init__" match the provided arguments', range: { start: { line: 0, character: 0 } } },
            { severity: 'error', rule: 'reportMissingImports', message: 'Import "somepkg" could not be resolved', range: { start: { line: 2, character: 0 } } },
            { severity: 'warning', rule: 'reportAttributeAccessIssue', message: 'Cannot access attribute "x" for class "Mesh"\n  Attribute "x" is unknown', range: { start: { line: 0, character: 0 } } }
        ], lines);
        expect(errors).toEqual([]);
        expect(ignored).toBe(5);
    });

    it('suggests close names by edit distance or a shared word', () => {
        expect(suggestNames('rotate_xyz', ['rotate_x', 'rotate_y', 'translate', 'scale'])).toEqual(['rotate_x', 'rotate_y']);
        expect(suggestNames('create_torus_knot', ['create_cylinder', 'create_lathe', 'sweep_curve_profile'])).toEqual(['create_cylinder', 'create_lathe']);
    });

    it('fails open when the check cannot finish in time: the script runs and the result says it was not checked', async () => {
        const r = await typeCheckSbScript(VALID, { timeoutMs: 1 });
        expect(r.status).toBe('timed_out');
        expect(r.note).toMatch(/did not finish within 1 ms/);

        process.env.SCRATCHBOX_SB_TYPECHECK_TIMEOUT_MS = '1';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const outcome = await python3DHandlers.execute_3d_python_script({ script: VALID, description: 'fail-open check' });
        const payload = outcome.resultPayload as any;
        expect(outcome.status, payload.stderr || payload.error).toBe('completed');
        expect(payload.typeCheck.status).toBe('timed_out');
        expect(payload.artifact.data.pythonGenerator.typeCheck.status).toBe('timed_out');
        expect(warn.mock.calls.some(c => /type check timed_out after \d+ms; running unchecked/.test(String(c[0])))).toBe(true);
    }, 180_000);
});

describe('the gate in the tools', () => {
    it('execute_3d_python_script returns the API errors without running the script', async () => {
        const script = VALID.replace('body.set_material(mat)', 'body.assign_material(mat)').replace('sb.io.write_glb', 'raise SystemExit(3)  #');
        const outcome = await python3DHandlers.execute_3d_python_script({ script, description: 'gate check' });
        const payload = outcome.resultPayload as any;
        expect(outcome.status).toBe('failed');
        expect(payload.error).toMatch(/line 10: Cannot access attribute "assign_material" for class "Mesh" \(did you mean: .*set_material/);
        expect(payload.typeCheck.status).toBe('rejected');
        expect(payload.exitCode).toBeUndefined(); // nothing ran
        expect(outcome.summaryResult).toMatch(/rejected before running/);
    }, 60_000);

    it('execute_3d_python_script stamps the API version and the check into the scene it builds', async () => {
        const outcome = await python3DHandlers.execute_3d_python_script({ script: VALID, description: 'stamp check' });
        const payload = outcome.resultPayload as any;
        expect(outcome.status, payload.stderr || payload.error).toBe('completed');
        expect(payload.typeCheck.status).toBe('passed');
        expect(payload.artifact.data.pythonGenerator.sbApiVersion).toBe(SB_API_VERSION);
        expect(payload.artifact.data.pythonGenerator.typeCheck).toMatchObject({ status: 'passed', apiVersion: SB_API_VERSION });
    }, 180_000);

    it('a 3d-scene payload script with an unknown API call is not mounted', async () => {
        const script = VALID.replace('body.displace(freq=1.4, amp=0.12)', 'body.add_noise(0.1)');
        const outcome = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'Gate', payload: { script } } as any, {} as any);
        const payload = (outcome as any).resultPayload;
        expect((outcome as any).status).toBe('failed');
        expect(payload.error).toMatch(/was not run.*\n.*line 6: Cannot access attribute "add_noise" for class "Mesh"/s);
    }, 60_000);
});

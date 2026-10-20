import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { generateSbStubs, readTree, sbApiModulePath, sbStubsDir, type SbStubGenerationReport } from '../src/node/3d-engine/sb-stubs';
import { SB_API_CORE_SUMMARY, SB_API_INDEX, SB_API_SUMMARY, SB_API_VERSION } from '../src/node/3d-engine/sb-api.generated';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { PYTHON_3D_API_REFERENCE } from '../src/node/gemini/tools/python-3d-tools';
import { SB_PYTHON_SCRIPT_GUIDE } from '../src/node/gemini/prompt-builder';

// One fresh generation shared by the generator and drift checks (it builds/imports the real module and runs basedpyright).
let tmp: string;
let report: SbStubGenerationReport;
let fresh: Map<string, string>;
let freshTs: string;

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stubs-test-'));
    report = await generateSbStubs({ outDir: path.join(tmp, 'typings'), summaryTs: path.join(tmp, 'sb-api.generated.ts') });
    fresh = readTree(path.join(tmp, 'typings'));
    freshTs = fs.readFileSync(path.join(tmp, 'sb-api.generated.ts'), 'utf8');
}, 600_000);

afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('scratchbox stub generator', () => {
    it('writes a stub for the package, every Python submodule and every native submodule', () => {
        const files = [...fresh.keys()];
        expect(files).toContain('scratchbox/__init__.pyi');
        expect(files).toContain('scratchbox_native/__init__.pyi');
        for (const sub of ['geometry', 'math', 'io', 'composer']) expect(files).toContain(`scratchbox_native/${sub}.pyi`);
        for (const sub of ['world', 'human', 'adaptive_object']) expect(files).toContain(`scratchbox/${sub}.pyi`);
        expect(report.stubFiles).toBe(files.length);
        expect(report.patches, 'signatures the generator could not read').toEqual([]);
    });

    it('describes the API as it is after the package patches the native classes', () => {
        const geometry = fresh.get('scratchbox_native/geometry.pyi')!;
        // Mesh.translate is replaced in Python by a variadic wrapper (translate(x, y, z) or translate(vec)) returning the mesh
        expect(geometry).toMatch(/def translate\(self, \*args\) -> Mesh/);
        // methods added in Python only
        expect(geometry).toMatch(/def snap_to\(self, target/);
        const init = fresh.get('scratchbox/__init__.pyi')!;
        // facade factories: real parameter names; return types from the native function they replace or from inference
        expect(init).toMatch(/def create_sphere\(radius=1\.0, rings=16, sectors=32, color=None, segments=None, material=None, \*\*kwargs\) -> scratchbox_native\.geometry\.Mesh/);
        expect(init).toMatch(/def create_box\(\*args, \*\*kwargs\) -> scratchbox_native\.geometry\.Mesh/);
        // a class whose metaclass answers any name keeps that (sb.PbrMaterial.<any preset>() works at runtime)
        expect(init).toMatch(/class PbrMaterial\(metaclass=_PbrMeta\)/);
        expect(init).toMatch(/class _PbrMeta\(type\):\n    def __getattr__\(cls, name\)/);
        // module-level namespace objects are typed by their class, which is emitted
        expect(init).toMatch(/^layout: _LayoutModule$/m);
        expect(init).toMatch(/^class _LayoutModule:/m);
        // everything public is re-exported
        expect(init).toMatch(/^__all__ = \[.*'create_box'.*'geometry'.*\]$/m);
        // instances that take new attributes say so (nanobind dynamic_attr), the others do not
        expect(geometry).toMatch(/class Mesh:[\s\S]*?def __setattr__\(self, name: str, value: typing\.Any, \/\) -> None/);
        expect(fresh.get('scratchbox_native/math.pyi')).not.toContain('__setattr__');
        // attributes a Python class sets on self are attributes too
        expect(fresh.get('scratchbox/human.pyi')).toMatch(/^    height: typing\.Any$/m);
    });

    it('names every public attribute of the live module', async () => {
        const res = await NativePythonRunnerService.getInstance().runScript(`
import json, scratchbox as sb
from scratchbox_native import geometry
print(json.dumps({"sb": [n for n in dir(sb) if not n.startswith("_")], "mesh": [n for n in dir(geometry.Mesh) if not n.startswith("_")]}))
`);
        expect(res.exitCode, res.stderr).toBe(0);
        const live = JSON.parse(res.stdout.trim().split('\n').pop() || '{}') as { sb: string[]; mesh: string[] };
        expect(live.sb.filter(n => !SB_API_INDEX.scratchbox.includes(n))).toEqual([]);
        expect(live.mesh.filter(n => !SB_API_INDEX.Mesh.includes(n))).toEqual([]);
    }, 180_000);

    it('stamps a version that is the hash of the stub files', () => {
        const hash = crypto.createHash('sha256');
        for (const [rel, text] of [...fresh.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) hash.update(rel).update(text);
        expect(report.version).toBe(hash.digest('hex').slice(0, 12));
        expect(freshTs).toContain(`export const SB_API_VERSION = '${report.version}';`);
    });
});

describe('scratchbox stub drift', () => {
    it('the committed stubs and API summary match a fresh generation from the module', () => {
        const committed = readTree(sbStubsDir());
        const rerun = 'Run `npm run stubs:sb` and commit packages/core/src/python/typings and packages/core/src/node/3d-engine/sb-api.generated.ts';
        const added = [...fresh.keys()].filter(k => !committed.has(k));
        const removed = [...committed.keys()].filter(k => !fresh.has(k));
        const changed = [...fresh.keys()].filter(k => committed.has(k) && committed.get(k) !== fresh.get(k));
        expect({ added, removed, changed }, `The scratchbox stubs drifted from the module. ${rerun}.`).toEqual({ added: [], removed: [], changed: [] });
        expect(fs.readFileSync(sbApiModulePath(), 'utf8') === freshTs, `sb-api.generated.ts drifted from the stubs. ${rerun}.`).toBe(true);
        expect(SB_API_VERSION).toBe(report.version);
    });
});

describe('scratchbox API summary', () => {
    it('stays within its token budgets (about 4 characters per token)', () => {
        expect(SB_API_SUMMARY.length).toBeLessThanOrEqual(3500 * 4);
        expect(SB_API_CORE_SUMMARY.length).toBeLessThanOrEqual(1800 * 4);
        expect(SB_API_SUMMARY.length).toBeGreaterThan(SB_API_CORE_SUMMARY.length);
    });

    it('lists module -> class -> signatures, most used first, with one-line docs in the full summary', () => {
        expect(SB_API_SUMMARY).toContain(`version ${SB_API_VERSION}`);
        expect(SB_API_SUMMARY).toMatch(/^sb functions \(import scratchbox as sb\):$/m);
        expect(SB_API_SUMMARY).toMatch(/^  sb\.create_lathe\(profile, segments=32, .*\) -> Mesh/m);
        expect(SB_API_SUMMARY).toMatch(/^sb\.geometry\.Mesh:$/m);
        expect(SB_API_SUMMARY).toMatch(/^  \.translate\(\*args\) -> Mesh/m);
        expect(SB_API_SUMMARY).toMatch(/  # \S/); // doc lines
        // the classes the package functions return come before the rest
        expect(SB_API_SUMMARY.indexOf('sb.geometry.Mesh:')).toBeLessThan(SB_API_SUMMARY.indexOf('sb.Scene:'));
        expect(SB_API_CORE_SUMMARY).toMatch(/^sb\.geometry\.Mesh: .*translate\(\*args\) -> Mesh/m);
        expect(SB_API_CORE_SUMMARY).toMatch(/^sb\.PbrMaterial: /m);
    });

    it('every name the summaries list exists in the stubs index', () => {
        // the Mesh block: the full summary's indented lines under its heading, the core summary's one line
        const fullMesh = SB_API_SUMMARY.split(/\n(?=\S)/).find(b => b.startsWith('sb.geometry.Mesh:')) || '';
        const coreMesh = SB_API_CORE_SUMMARY.split('\n').find(l => l.startsWith('sb.geometry.Mesh:')) || '';
        for (const block of [fullMesh, coreMesh]) {
            const called = [...block.matchAll(/(?:^  \.|; )(\w+)\(/gm)].map(m => m[1]).filter(n => n !== 'Mesh');
            expect(called.length).toBeGreaterThan(10);
            expect(called.filter(n => !SB_API_INDEX.Mesh.includes(n))).toEqual([]);
        }
        const sbFns = [...SB_API_SUMMARY.matchAll(/^  sb\.(\w+)\(/gm)].map(m => m[1]);
        expect(sbFns.length).toBeGreaterThan(30);
        expect(sbFns.filter(n => !SB_API_INDEX.scratchbox.includes(n))).toEqual([]);
    });

    it('is what the model is given: the tool description and the script guide use the generated text', () => {
        expect(PYTHON_3D_API_REFERENCE.startsWith(SB_API_CORE_SUMMARY)).toBe(true);
        expect(SB_PYTHON_SCRIPT_GUIDE).toContain(SB_API_SUMMARY);
        // the hand-maintained listing it replaced is gone
        expect(SB_PYTHON_SCRIPT_GUIDE).not.toContain('Direct Primitive & Procedural Helpers');
    });
});

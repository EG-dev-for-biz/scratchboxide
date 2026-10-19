/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Every Python sidecar the app spawns runs on one interpreter: SCRATCHBOX_PYTHON when set, else the project's .venv,
 * never the system python3 on PATH (which lacks OpenCV, so the ownership and occluder masks failed on every view).
 * A missing interpreter or module is a typed PythonEnvironmentError at first use, with the command that fixes it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PythonEnvironmentError } from '../src/common/errors/pipeline-errors';
import { checkPythonEnvironment, projectVenvPython, repoRoot, requirePythonModules, resolveRepoPython } from '../src/node/process/repo-python';
import { ObjectSegmenterService } from '../src/node/video/ObjectSegmenterService';
import { MediaPipePoseService } from '../src/node/spatial/MediaPipePoseService';
import { PanoramaDepthService } from '../src/node/spatial/PanoramaDepthService';
import { TapirTrackingService } from '../src/node/spatial/TapirTrackingService';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';

const saved = process.env.SCRATCHBOX_PYTHON;
afterEach(() => { if (saved === undefined) delete process.env.SCRATCHBOX_PYTHON; else process.env.SCRATCHBOX_PYTHON = saved; });

/** The system interpreter on PATH (not the project's). */
function systemPython(): string | undefined {
    for (const p of ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) if (fs.existsSync(p)) return p;
    return undefined;
}

describe('the shared Python resolver', () => {
    it("resolves the project's .venv when SCRATCHBOX_PYTHON is not set, and it has the sidecars' modules", () => {
        delete process.env.SCRATCHBOX_PYTHON;
        const venv = projectVenvPython();
        expect(venv, "the project's .venv (or, in a worktree, the main checkout's)").toBeDefined();
        expect(resolveRepoPython({ modules: ['numpy', 'cv2', 'mediapipe'], purpose: 'the test' })).toBe(venv);
        // it really is a Python with OpenCV
        expect(execFileSync(venv!, ['-c', 'import cv2; print(cv2.__version__)'], { encoding: 'utf8' }).trim()).toMatch(/^\d+\./);
        const check = checkPythonEnvironment();
        expect(check.ok).toBe(true);
    });

    it('honours SCRATCHBOX_PYTHON, and fails typed when it points nowhere', () => {
        process.env.SCRATCHBOX_PYTHON = projectVenvPython()!;
        expect(resolveRepoPython()).toBe(process.env.SCRATCHBOX_PYTHON);
        process.env.SCRATCHBOX_PYTHON = path.join(os.tmpdir(), 'no-such-python-here');
        let err: unknown;
        try { resolveRepoPython({ purpose: 'the test' }); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(PythonEnvironmentError);
        expect((err as PythonEnvironmentError).code).toBe('python_interpreter_missing');
        expect((err as Error).message).toMatch(/SCRATCHBOX_PYTHON is set to .*does not exist/);
    });

    it('fails at first use, typed and actionable, on an interpreter without a module, and never falls back', () => {
        let err: unknown;
        try { requirePythonModules(projectVenvPython()!, ['numpy', 'scratchbox_no_such_module'], 'The object segmenter'); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(PythonEnvironmentError);
        const e = err as PythonEnvironmentError;
        expect(e.code).toBe('python_modules_missing');
        expect(e.missingModules).toEqual(['scratchbox_no_such_module']);
        expect(e.remedy).toMatch(/-m pip install scratchbox_no_such_module/);
        // the system Python lacks OpenCV: pointed at it, the segmenter fails with the pip command, not on every view
        const sys = systemPython();
        if (sys) {
            let missing: string[] = [];
            try { execFileSync(sys, ['-c', 'import cv2'], { stdio: 'ignore' }); } catch { missing = ['cv2']; }
            if (missing.length) {
                process.env.SCRATCHBOX_PYTHON = sys;
                let e2: unknown;
                try { resolveRepoPython({ modules: ['cv2'], purpose: 'The object segmenter' }); } catch (x) { e2 = x; }
                expect(e2).toBeInstanceOf(PythonEnvironmentError);
                expect((e2 as Error).message).toMatch(/needs the Python module cv2.*pip install opencv-python/);
            }
        }
    });

    it('fails typed when there is no .venv and no SCRATCHBOX_PYTHON', () => {
        delete process.env.SCRATCHBOX_PYTHON;
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-novenv-'));
        try {
            expect(projectVenvPython(empty)).toBeUndefined();
        } finally { fs.rmSync(empty, { recursive: true, force: true }); }
        expect(projectVenvPython(repoRoot())).toBeDefined();
    });

    it('every sidecar service resolves to the same interpreter, at first use, not at construction', () => {
        delete process.env.SCRATCHBOX_PYTHON;
        const venv = projectVenvPython()!;
        const read = (o: object, key: string) => (o as Record<string, unknown>)[key];
        expect(read(new ObjectSegmenterService(), 'pythonBinary')).toBe(venv);
        expect(read(new MediaPipePoseService(), 'pythonBinary')).toBe(venv);
        expect(read(new TapirTrackingService(), 'pythonBinary')).toBe(venv);
        expect(new NativePythonRunnerService().getPythonExecutable()).toBe(venv);
        if (fs.existsSync(venv)) {
            // the depth model's modules (torch, transformers) are in the project's .venv too
            expect(read(new PanoramaDepthService(), 'pythonExecutable')).toBe(venv);
        }
        // construction never resolves: a bad interpreter fails the first call, not the module import
        process.env.SCRATCHBOX_PYTHON = path.join(os.tmpdir(), 'no-such-python-here');
        const svc = new ObjectSegmenterService();
        expect(() => read(svc, 'pythonBinary')).toThrow(PythonEnvironmentError);
    });
});

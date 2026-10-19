/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PythonEnvironmentError } from '../../common/errors/pipeline-errors';

let cachedRoot: string | undefined;

/**
 * The repository root: the nearest ancestor of this module (else of the working directory) holding package.json and
 * packages/core. Falls back to the working directory outside a checkout. The desktop server runs from desktop-app/,
 * so repo files (sidecar scripts, models, .venv) are resolved from here, not from process.cwd().
 */
export function repoRoot(): string {
    if (cachedRoot) return cachedRoot;
    for (const start of [__dirname, process.cwd()]) {
        let d = path.resolve(start);
        for (let i = 0; i < 12; i++) {
            if (fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'packages', 'core'))) {
                cachedRoot = d;
                return d;
            }
            const up = path.dirname(d);
            if (up === d) break;
            d = up;
        }
    }
    return process.cwd();
}

/** A path inside the repository (see repoRoot). */
export function repoPath(...parts: string[]): string {
    return path.join(repoRoot(), ...parts);
}

/** The project's own interpreter: <repo>/.venv/bin/python, else (in a git worktree) the main checkout's. */
export function projectVenvPython(root = repoRoot()): string | undefined {
    const own = path.join(root, '.venv', 'bin', 'python');
    if (fs.existsSync(own)) return own;
    // a linked worktree's .git is a file: "gitdir: <main>/.git/worktrees/<name>"
    try {
        const dotGit = path.join(root, '.git');
        if (fs.statSync(dotGit).isFile()) {
            const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
            if (m) {
                const commonDir = path.resolve(root, m[1].trim(), '..', '..');
                const main = path.join(path.dirname(commonDir), '.venv', 'bin', 'python');
                if (path.basename(commonDir) === '.git' && fs.existsSync(main)) return main;
            }
        }
    } catch { /* no .git here */ }
    return undefined;
}

/** pip package names where they differ from the module a sidecar imports. */
const PIP_NAME: Record<string, string> = { cv2: 'opencv-python', PIL: 'pillow', sklearn: 'scikit-learn', yaml: 'pyyaml' };

const modulesPresent = new Set<string>();

function venvRemedy(): string {
    return `create the project's environment: \`python3 -m venv ${repoPath('.venv')} && ${repoPath('.venv', 'bin', 'pip')} install -r ${repoPath('requirements.txt')}\` (or set SCRATCHBOX_PYTHON to an interpreter that has the modules)`;
}

/**
 * Throws PythonEnvironmentError unless `python` can import every one of `modules` (checked with importlib's find_spec,
 * without importing them; a success is remembered for the process, a failure is checked again next time).
 */
export function requirePythonModules(python: string, modules: readonly string[], purpose: string): void {
    if (!modules.length) return;
    const key = `${python}\0${[...modules].sort().join(',')}`;
    if (modulesPresent.has(key)) return;
    let missing: string[];
    try {
        const out = execFileSync(python, ['-c', 'import importlib.util,sys\nprint(",".join(m for m in sys.argv[1:] if importlib.util.find_spec(m) is None))', ...modules], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
        missing = out.trim() ? out.trim().split(',') : [];
    } catch (err) {
        throw new PythonEnvironmentError('python_interpreter_missing', python, [...modules], venvRemedy(), `${purpose} needs Python, but ${python} could not run (${(err as Error).message.split('\n')[0]}).`);
    }
    if (missing.length) {
        const pip = missing.map(m => PIP_NAME[m] ?? m).join(' ');
        throw new PythonEnvironmentError('python_modules_missing', python, missing, `run \`${python} -m pip install ${pip}\``, `${purpose} needs the Python module${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, which ${python} does not have.`);
    }
    modulesPresent.add(key);
}

/**
 * The Python every sidecar the app spawns runs on: the first of `overrideVars` that is set (a sidecar's own variable,
 * e.g. SCRATCHBOX_DEPTH_PYTHON), else SCRATCHBOX_PYTHON, else the project's `.venv` (projectVenvPython). Never the
 * system Python on PATH: an interpreter without the sidecars' modules (OpenCV, MediaPipe, torch) fails every call, so a
 * missing interpreter, or one lacking any of `modules`, is a PythonEnvironmentError at first use, with the command that
 * fixes it.
 */
export function resolveRepoPython(opts: { overrideVars?: readonly string[]; modules?: readonly string[]; purpose?: string } = {}): string {
    const purpose = opts.purpose ?? 'this step';
    let python: string | undefined;
    for (const name of [...(opts.overrideVars ?? []), 'SCRATCHBOX_PYTHON']) {
        const v = (process.env[name] || '').trim();
        if (!v) continue;
        if (!fs.existsSync(v)) {
            throw new PythonEnvironmentError('python_interpreter_missing', v, [...(opts.modules ?? [])], `point ${name} at an existing interpreter, or unset it to use ${repoPath('.venv', 'bin', 'python')}`, `${name} is set to ${v}, which does not exist.`);
        }
        python = v;
        break;
    }
    python ??= projectVenvPython();
    if (!python) {
        throw new PythonEnvironmentError('python_interpreter_missing', repoPath('.venv', 'bin', 'python'), [...(opts.modules ?? [])], venvRemedy(), `${purpose} needs the project's Python environment, but ${repoPath('.venv', 'bin', 'python')} does not exist and SCRATCHBOX_PYTHON is not set.`);
    }
    requirePythonModules(python, opts.modules ?? [], purpose);
    return python;
}

/** The modules the app's own sidecars import (segmentation, pose, depth, photo rectification): checked at startup. */
export const SIDECAR_MODULES = ['numpy', 'cv2', 'mediapipe', 'PIL', 'torch', 'transformers'] as const;

/**
 * The startup check: which interpreter the sidecars will run on and whether it has their modules. Never throws; the
 * caller logs the result (a failure is logged as an error with its fix, and each sidecar still fails at first use).
 */
export function checkPythonEnvironment(): { ok: true; python: string; source: string } | { ok: false; error: PythonEnvironmentError } {
    try {
        const python = resolveRepoPython({ modules: SIDECAR_MODULES, purpose: "Running the app's Python sidecars (object and occluder masks, pose, depth)" });
        return { ok: true, python, source: process.env.SCRATCHBOX_PYTHON?.trim() ? 'SCRATCHBOX_PYTHON' : "the project's .venv" };
    } catch (err) {
        if (err instanceof PythonEnvironmentError) return { ok: false, error: err };
        throw err;
    }
}

/** Logs the startup check: the interpreter in use, or (as an error) why the sidecars will fail and the command that fixes it. */
export function logPythonEnvironment(log: Pick<Console, 'log' | 'error'> = console): void {
    const r = checkPythonEnvironment();
    if (r.ok) log.log(`[Scratchbox Python] sidecars run on ${r.python} (${r.source}); ${SIDECAR_MODULES.join(', ')} present`);
    else log.error(`[Scratchbox Python] ${r.error.message}`);
}

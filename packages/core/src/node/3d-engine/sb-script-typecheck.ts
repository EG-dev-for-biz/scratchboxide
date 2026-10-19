/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pre-execution type check of a model-written scratchbox script against the generated stubs
 * (packages/core/src/python/typings, from scripts/gen_sb_stubs.py), with basedpyright from the project's .venv.
 *
 * Only diagnostics that mean the script calls something the API does not have block the run: an unknown attribute of
 * a scratchbox class or module, an unknown import from the package, wrong argument names or counts, calling a
 * non-callable. Everything else pyright reports (argument types, Optional narrowing, third-party stubs, inference
 * limits) is counted and ignored, so valid scripts run. A check that cannot finish (time limit, no basedpyright)
 * fails open: the script runs and the result says the check did not happen; it is never reported as passed.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveRepoPython } from '../process/repo-python';
import { sbStubsDir } from './sb-stubs';
import { SB_API_INDEX, SB_API_VERSION } from './sb-api.generated';

/** About 2 s: a cold basedpyright run on a scene script takes ~0.5 s. */
export const SB_TYPECHECK_TIMEOUT_MS = 2000;

export interface SbApiError {
    line: number;
    column: number;
    rule: string;
    message: string;
    /** The script line, trimmed. */
    source: string;
    /** Names in the same class or module close to the unknown one. */
    suggestions?: string[];
}

export interface SbTypeCheckResult {
    /** passed: no API errors; rejected: API errors, the script must not run; timed_out / unavailable / failed: no verdict. */
    status: 'passed' | 'rejected' | 'timed_out' | 'unavailable' | 'failed';
    durationMs: number;
    apiVersion: string;
    errors: SbApiError[];
    /** pyright diagnostics that do not block (argument types, Optional access, ...). */
    ignoredDiagnostics: number;
    note?: string;
}

interface PyrightDiagnostic {
    file?: string;
    severity: string;
    message: string;
    rule?: string;
    range: { start: { line: number; character: number } };
}

const OWN_ROOTS = ['scratchbox', 'scratchbox_native'];

/** The short class names the stubs define (keys of the index that are not module paths). */
function isStubClass(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(SB_API_INDEX, name) && !OWN_ROOTS.some(r => name === r || name.startsWith(`${r}.`));
}

function editDistance(a: string, b: string): number {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return dp[a.length][b.length];
}

/** Up to five names from `candidates` that look like `wanted`: a small edit distance or a shared word. */
export function suggestNames(wanted: string, candidates: readonly string[]): string[] {
    const w = wanted.toLowerCase();
    const words = w.split('_').filter(p => p.length >= 3);
    return candidates
        .filter(c => !c.startsWith('_'))
        .map(c => {
            const lc = c.toLowerCase();
            const d = editDistance(w, lc);
            const shared = words.some(p => lc.includes(p)) || lc.split('_').some(p => p.length >= 3 && w.includes(p));
            return { c, score: d <= Math.max(2, Math.floor(w.length / 3)) ? d : shared ? 10 + d : Infinity };
        })
        .filter(x => Number.isFinite(x.score))
        .sort((a, b) => a.score - b.score || a.c.localeCompare(b.c))
        .slice(0, 5)
        .map(x => x.c);
}

/**
 * The diagnostics that block a run, with "did you mean" hints. `lines` is the script split into lines; the rest of
 * the diagnostics are only counted.
 */
export function classifySbDiagnostics(diagnostics: PyrightDiagnostic[], lines: string[]): { errors: SbApiError[]; ignored: number } {
    const errors: SbApiError[] = [];
    let ignored = 0;
    for (const d of diagnostics) {
        if (d.severity !== 'error') continue;
        const message = d.message.split('\n')[0].trim();
        const line = d.range.start.line;
        const source = (lines[line] ?? '').trim();
        let blocking = false;
        let suggestions: string[] | undefined;
        if (d.rule === 'reportAttributeAccessIssue') {
            const unknownAttr = /Attribute "(\w+)" is unknown/.exec(d.message);
            const cls = /(?:access|assign to) attribute "\w+" for class "(?:type\[)?(\w+)\*?\]?"/.exec(d.message);
            const mod = /"(\w+)" is not a known attribute of module "([\w.]+)"/.exec(d.message);
            const imp = /"(\w+)" is unknown import symbol/.exec(d.message);
            if (unknownAttr && cls && isStubClass(cls[1])) {
                blocking = true;
                suggestions = suggestNames(unknownAttr[1], SB_API_INDEX[cls[1]] ?? []);
            } else if (mod && OWN_ROOTS.some(r => mod[2] === r || mod[2].startsWith(`${r}.`))) {
                blocking = true;
                suggestions = suggestNames(mod[1], SB_API_INDEX[mod[2]] ?? []);
            } else if (imp && /\bscratchbox/.test(source)) {
                blocking = true;
                const from = /from\s+([\w.]+)\s+import/.exec(source)?.[1];
                suggestions = from ? suggestNames(imp[1], SB_API_INDEX[from] ?? []) : undefined;
            }
        } else if (d.rule === 'reportCallIssue') {
            // names and counts, not types: "No overloads ..." also covers type mismatches, so it does not block
            blocking = /No parameter named|Expected \d+ (?:more )?positional argument|Arguments? missing for parameters?|is not callable/.test(d.message);
        } else if (d.rule === 'reportMissingImports') {
            const name = /Import "([\w.]+)" could not be resolved/.exec(d.message)?.[1] ?? '';
            blocking = OWN_ROOTS.some(r => name === r || name.startsWith(`${r}.`));
        }
        if (blocking) {
            errors.push({ line: line + 1, column: d.range.start.character + 1, rule: d.rule ?? '', message, source, ...(suggestions?.length ? { suggestions } : {}) });
        } else {
            ignored++;
        }
    }
    return { errors, ignored };
}

/** The errors as the model sees them in the tool result: one line each, with the offending source and hints. */
export function formatSbApiErrors(errors: SbApiError[], apiVersion = SB_API_VERSION): string {
    const shown = errors.slice(0, 12).map(e =>
        `line ${e.line}: ${e.message}${e.suggestions?.length ? ` (did you mean: ${e.suggestions.join(', ')}?)` : ''}  |  ${e.source.slice(0, 120)}`);
    const more = errors.length > shown.length ? `\n(+${errors.length - shown.length} more)` : '';
    return `The script uses ${errors.length === 1 ? 'a name or argument' : 'names or arguments'} the scratchbox API does not have ` +
        `(type check against the generated stubs, API ${apiVersion}); it was not run. Fix ${errors.length === 1 ? 'this line' : 'these lines'} ` +
        `and call again. The API reference is in read_sb_script_guide.\n${shown.join('\n')}${more}`;
}

let workDir: string | undefined;

/** A per-process directory with the pyright config (stubs on the path) and the names the runner defines. */
function checkDir(python: string): string {
    if (workDir && fs.existsSync(workDir)) return workDir;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-typecheck-'));
    fs.writeFileSync(path.join(dir, 'pyrightconfig.json'), JSON.stringify({
        extraPaths: [sbStubsDir()],
        typeCheckingMode: 'standard',
        reportMissingModuleSource: false,
        // the scripts are the only files here; never scan anything else
        include: ['.'],
        exclude: ['**/__pycache__']
    }, null, 2));
    // NativePythonRunnerService prepends OUTPUT_GLB_PATH when a script does not assign it
    fs.writeFileSync(path.join(dir, '__builtins__.pyi'), 'OUTPUT_GLB_PATH: str\n');
    workDir = dir;
    return dir;
}

function basedpyrightFor(python: string): string | undefined {
    const candidate = path.join(path.dirname(python), process.platform === 'win32' ? 'basedpyright.exe' : 'basedpyright');
    return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Type-checks `script` against the scratchbox stubs. Never throws: a check that cannot run returns a status other
 * than passed/rejected with a note, which the caller logs before running the script anyway.
 */
export async function typeCheckSbScript(script: string, opts: { timeoutMs?: number; python?: string } = {}): Promise<SbTypeCheckResult> {
    const started = Date.now();
    const base = { apiVersion: SB_API_VERSION, errors: [] as SbApiError[], ignoredDiagnostics: 0 };
    let python: string;
    try {
        python = opts.python ?? resolveRepoPython({ purpose: 'Type-checking scratchbox scripts' });
    } catch (err) {
        return { ...base, status: 'unavailable', durationMs: Date.now() - started, note: `no Python environment: ${(err as Error).message}` };
    }
    const bin = basedpyrightFor(python);
    if (!bin) {
        return { ...base, status: 'unavailable', durationMs: Date.now() - started, note: `basedpyright is not installed next to ${python} (pip install -r requirements.txt)` };
    }
    if (!fs.existsSync(path.join(sbStubsDir(), 'scratchbox', '__init__.pyi'))) {
        return { ...base, status: 'unavailable', durationMs: Date.now() - started, note: `the scratchbox stubs are missing from ${sbStubsDir()} (npm run stubs:sb)` };
    }
    const dir = checkDir(python);
    const file = path.join(dir, `script_${crypto.randomBytes(6).toString('hex')}.py`);
    fs.writeFileSync(file, script, 'utf8');
    // SCRATCHBOX_SB_TYPECHECK_TIMEOUT_MS overrides the limit (a slow machine, or a test of the fail-open path)
    const envTimeout = Number(process.env.SCRATCHBOX_SB_TYPECHECK_TIMEOUT_MS);
    const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : SB_TYPECHECK_TIMEOUT_MS);
    try {
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile(bin, ['--outputjson', '--pythonpath', python, '-p', path.join(dir, 'pyrightconfig.json'), file],
                { cwd: dir, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
                (err, out) => {
                    // exit code 1 means "errors found": the JSON report is still on stdout
                    if (err && (err as any).killed) return reject(Object.assign(new Error('timed out'), { timedOut: true }));
                    if (err && !out) return reject(err);
                    resolve(out);
                });
        });
        const report = JSON.parse(stdout) as { generalDiagnostics?: PyrightDiagnostic[] };
        const ownFile = (report.generalDiagnostics ?? []).filter(d => !d.file || path.resolve(d.file) === path.resolve(file));
        const { errors, ignored } = classifySbDiagnostics(ownFile, script.split('\n'));
        return { ...base, status: errors.length ? 'rejected' : 'passed', errors, ignoredDiagnostics: ignored, durationMs: Date.now() - started };
    } catch (err: any) {
        if (err?.timedOut) {
            return { ...base, status: 'timed_out', durationMs: Date.now() - started, note: `the type check did not finish within ${timeoutMs} ms; the script runs unchecked` };
        }
        return { ...base, status: 'failed', durationMs: Date.now() - started, note: `the type check could not run: ${String(err?.message || err).slice(0, 300)}` };
    } finally {
        fs.rmSync(file, { force: true });
    }
}

/** The run metadata a script built scene keeps: which API it was written against and what the check said. */
export function sbTypeCheckMetadata(r: SbTypeCheckResult): { status: SbTypeCheckResult['status']; durationMs: number; apiVersion: string; ignoredDiagnostics: number; note?: string } {
    return { status: r.status, durationMs: r.durationMs, apiVersion: r.apiVersion, ignoredDiagnostics: r.ignoredDiagnostics, ...(r.note ? { note: r.note } : {}) };
}

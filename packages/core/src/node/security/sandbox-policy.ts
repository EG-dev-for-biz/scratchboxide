/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as os from 'os';
import * as path from 'path';
import { resolveWithinRoot } from './path-guard';

export class SandboxCommandRejectedError extends Error {
    readonly code = 'command_not_allowed';
    constructor(message: string, readonly segment?: string, readonly reason?: string) {
        super(message);
        this.name = 'SandboxCommandRejectedError';
    }
}

/** Environment variable names passed from the host into every sandboxed process. */
export const SANDBOX_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'NODE_ENV', 'CI'];

/** Any key matching this is never forwarded, regardless of source. */
export const SANDBOX_SECRET_ENV_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|_URL$)/i;

/**
 * Commands the sandbox will run without an explicit user confirmation.
 * Interpreters and launchers (node, python, npx, npm, make, cmake, env, ...) are
 * listed so that `node script.js`, `python3 script.py` and `npx vitest run` work,
 * but their inline-code forms (`node -e`, `python -c`, `env <cmd>`, `npx -c`, ...)
 * are rejected by {@link assertInterpreterSafe} and require user confirmation.
 */
export const DEFAULT_COMMAND_ALLOWLIST = [
    'ls', 'cat', 'echo', 'pwd', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'vitest', 'jest',
    'python3', 'python', 'pip', 'git', 'rg', 'grep', 'find', 'head', 'tail', 'wc', 'mkdir', 'touch',
    'cp', 'mv', 'sed', 'which',
    // C/C++ 3D Engine & Native Procedural Generators
    'clang', 'clang++', 'gcc', 'g++', 'make', 'cmake',
    // Harmless helpers used by agents and tests.
    'env', 'printenv', 'sleep', 'exit', 'true', 'false'
];

export const GIT_READ_ONLY_SUBCOMMANDS = ['status', 'log', 'diff', 'show', 'branch', 'rev-parse'];

/** Patterns that are refused even when the user has explicitly confirmed the command. */
const HARD_DENY_PATTERNS: RegExp[] = [
    /\b(chmod|chown)\s+(-R\s+)?777\s+\//i,
    /\bdd\s+if=.*of=\/dev\//i,
    /\bmkfs(\.[a-z0-9]+)?\s+\/dev\//i,
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // Fork bomb
    />\s*\/dev\/(sda|hda|nvme|disk)/i
];

export interface CommandPolicyOptions {
    cwd: string;
    confirmedByUser?: boolean;
    allowlist?: string[];
}

/**
 * Build the environment handed to the sandboxed child: a small allowlist of
 * host variables plus explicitly requested variables, with anything that looks
 * like a secret removed regardless of where it came from.
 */
export function buildScrubbedEnv(
    hostEnv: NodeJS.ProcessEnv,
    ...overlays: Array<Record<string, string | undefined> | undefined>
): Record<string, string> {
    const extraAllowed = (hostEnv.SCRATCHBOX_SANDBOX_ENV_ALLOWLIST || '')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
    const allowed = new Set([...SANDBOX_ENV_ALLOWLIST, ...extraAllowed]);

    const result: Record<string, string> = {};
    for (const name of allowed) {
        const value = hostEnv[name];
        if (typeof value === 'string' && !SANDBOX_SECRET_ENV_PATTERN.test(name)) {
            result[name] = value;
        }
    }
    for (const overlay of overlays) {
        if (!overlay) continue;
        for (const [name, value] of Object.entries(overlay)) {
            if (typeof value !== 'string') continue;
            if (SANDBOX_SECRET_ENV_PATTERN.test(name)) continue;
            result[name] = value;
        }
    }
    return result;
}

/**
 * Split a shell command line on top-level `;`, `&&`, `||`, `|`, `&` and newlines
 * (quotes respected). Newlines/carriage returns are command separators in
 * `sh -c`, so they must be treated like `;` or a trailing line would bypass the policy.
 */
export function splitShellSegments(command: string): string[] {
    const segments: string[] = [];
    let current = '';
    let quote: string | null = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            else if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '\\' && i + 1 < command.length) {
            current += ch + command[++i];
            continue;
        }
        if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
            // Treat single '&' (background) like a separator too.
            const next = command[i + 1];
            if ((ch === '|' || ch === '&') && next === ch) i++;
            segments.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    segments.push(current);
    return segments.map(s => s.trim()).filter(Boolean);
}

/** Minimal POSIX-ish tokenizer: handles single/double quotes and backslash escapes. */
export function tokenize(segment: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let hasToken = false;
    let quote: string | null = null;
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
                current += segment[++i];
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            hasToken = true;
            continue;
        }
        if (ch === '\\' && i + 1 < segment.length) {
            current += segment[++i];
            hasToken = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (hasToken) {
                tokens.push(current);
                current = '';
                hasToken = false;
            }
            continue;
        }
        current += ch;
        hasToken = true;
    }
    if (hasToken) tokens.push(current);
    return tokens;
}

function isDestructiveRmTarget(target: string, cwd: string): boolean {
    const home = os.homedir();
    const stripped = target.replace(/\/+$/, '') || '/';
    if (stripped === '/' || stripped === '/*' || stripped === '*' || stripped === '~' || stripped === '~/' || stripped === '~/*') {
        return true;
    }
    if (stripped === '..' || stripped.startsWith('../') || stripped === home || stripped === `${home}/*`) {
        return true;
    }
    if (target.startsWith('~')) {
        return true;
    }
    if (path.isAbsolute(stripped)) {
        try {
            resolveWithinRoot(cwd, stripped.replace(/\/\*$/, ''));
            return false;
        } catch {
            return true;
        }
    }
    // Relative path: must stay inside cwd.
    try {
        resolveWithinRoot(cwd, stripped.replace(/\/\*$/, ''));
        return false;
    } catch {
        return true;
    }
}

/**
 * Checks that never bypass user confirmation. Throws when the command must not run.
 */
export function assertNotHardDenied(command: string, cwd: string): void {
    for (const pattern of HARD_DENY_PATTERNS) {
        if (pattern.test(command)) {
            throw new SandboxCommandRejectedError(
                `Blocked by sandbox policy: command matches a hard-denied pattern [${pattern.source}]`,
                command,
                'hard_denied'
            );
        }
    }
    for (const segment of splitShellSegments(command)) {
        const tokens = tokenize(segment);
        const [cmd, ...args] = tokens;
        if (path.basename(cmd || '') !== 'rm') continue;
        const flags = args.filter(a => a.startsWith('-'));
        const recursive = flags.some(f => /^-[a-zA-Z]*[rR]/.test(f) || f === '--recursive');
        const force = flags.some(f => /^-[a-zA-Z]*f/.test(f) || f === '--force');
        const targets = args.filter(a => !a.startsWith('-'));
        if ((recursive || force) && targets.some(t => isDestructiveRmTarget(t, cwd))) {
            throw new SandboxCommandRejectedError(
                `Blocked by sandbox policy: "${segment}" would recursively delete outside the sandbox working directory`,
                segment,
                'destructive_rm'
            );
        }
    }
}

function assertPathsWithinCwd(paths: string[], cwd: string, segment: string, what: string): void {
    for (const candidate of paths) {
        if (candidate === '-' || candidate === '{}' ) continue;
        const expanded = candidate.startsWith('~') ? path.join(os.homedir(), candidate.slice(1)) : candidate;
        try {
            resolveWithinRoot(cwd, expanded);
        } catch {
            throw new SandboxCommandRejectedError(
                `Blocked by sandbox policy: ${what} path "${candidate}" is outside the sandbox working directory`,
                segment,
                'path_outside_cwd'
            );
        }
    }
}

function assertRedirectsWithinCwd(segment: string, cwd: string): void {
    // Match `>`, `>>`, `<`, `2>`, `&>` followed by a target token.
    const redirect = /(?:^|\s)(?:\d?>>?|&>|<)\s*([^\s;&|]+)/g;
    let match: RegExpExecArray | null;
    while ((match = redirect.exec(segment)) !== null) {
        const target = match[1].replace(/^["']|["']$/g, '');
        if (target === '/dev/null' || /^&\d$/.test(target)) continue;
        assertPathsWithinCwd([target], cwd, segment, 'redirect');
    }
}

/** Shells are never auto-allowed, including when launched through npx/npm exec/env. */
const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);

/** Python modules that are safe to run via `python -m` without confirmation. */
export const PYTHON_SAFE_MODULES = new Set([
    'pytest', 'unittest', 'pip', 'venv', 'py_compile', 'compileall', 'json.tool', 'doctest',
    'mypy', 'black', 'ruff', 'flake8', 'pyflakes', 'pylint', 'isort'
]);

/**
 * Leading `NAME=value` assignments that change how an interpreter or the shell
 * loads code (e.g. `NODE_OPTIONS=--import=data:...`, `LD_PRELOAD=...`).
 */
const DANGEROUS_ENV_ASSIGNMENT = /^(NODE_OPTIONS|NODE_PATH|PYTHON[A-Z_]*|LD_[A-Z_]+|DYLD_[A-Z_]+|BASH_ENV|ENV|PERL5OPT|PERL5LIB|RUBYOPT|GIT_[A-Z_]+|PATH|IFS|PS4|SHELLOPTS|PROMPT_COMMAND|PAGER|EDITOR|VISUAL)=/;

const NODE_VALUE_FLAGS = new Set([
    '-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions',
    '--input-type', '--title', '--env-file', '--stack-size', '--inspect-port'
]);

function rejectInline(segment: string, message: string, reason = 'inline_code'): never {
    throw new SandboxCommandRejectedError(
        `Blocked by sandbox policy: ${message} requires explicit user confirmation (segment: "${segment}")`,
        segment,
        reason
    );
}

function assertNodeSafe(args: string[], segment: string): void {
    let script: string | undefined;
    let infoOnly = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            script = args[i + 1];
            break;
        }
        if (arg === '-') rejectInline(segment, 'node reading code from stdin');
        if (!arg.startsWith('-')) {
            script = arg;
            break;
        }
        const [flag, inlineValue] = arg.startsWith('--') ? arg.split(/=([\s\S]*)/, 2) : [arg, undefined];
        if (flag === '--eval' || flag === '--print' || flag === '--interactive') {
            rejectInline(segment, `node ${flag}`);
        }
        // Short clusters such as -e, -p, -pe, -i.
        if (!arg.startsWith('--') && /^-[a-zA-Z]*[epi]/.test(arg)) {
            rejectInline(segment, `node ${arg}`);
        }
        if (flag === '-v' || flag === '--version' || flag === '-h' || flag === '--help' || flag === '--check' || flag === '-c') {
            infoOnly = true;
        }
        if (NODE_VALUE_FLAGS.has(flag)) {
            const value = inlineValue !== undefined ? inlineValue : args[++i];
            if (value !== undefined && /^(data:|https?:|file:)/i.test(value)) {
                rejectInline(segment, `node ${flag} with a URL module`);
            }
        }
    }
    if (script === undefined && !infoOnly) {
        rejectInline(segment, 'node without a script file (REPL/stdin)');
    }
}

function assertPythonSafe(args: string[], segment: string): void {
    let script: string | undefined;
    let infoOnly = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-') rejectInline(segment, 'python reading code from stdin');
        if (arg === '--') {
            script = args[i + 1];
            break;
        }
        if (!arg.startsWith('-')) {
            script = arg;
            break;
        }
        if (arg.startsWith('--')) {
            if (arg === '--version' || arg === '--help') infoOnly = true;
            continue;
        }
        // Short option cluster, e.g. -c, -Bc, -um pytest, -W ignore.
        for (let j = 1; j < arg.length; j++) {
            const opt = arg[j];
            if (opt === 'c') rejectInline(segment, 'python -c');
            if (opt === 'i') rejectInline(segment, 'python -i');
            if (opt === 'V' || opt === 'h') infoOnly = true;
            if (opt === 'm') {
                const mod = arg.length > j + 1 ? arg.slice(j + 1) : args[++i];
                if (!mod || !PYTHON_SAFE_MODULES.has(mod)) {
                    rejectInline(segment, `python -m ${mod || ''}`.trim());
                }
                return;
            }
            if (opt === 'W' || opt === 'X') {
                if (arg.length === j + 1) i++;
                break;
            }
        }
    }
    if (script === undefined && !infoOnly) {
        rejectInline(segment, 'python without a script file (REPL/stdin)');
    }
}

/** Validates the command launched by `npx`/`npm exec`/`pnpm dlx`: no `-c`, no shells or inline interpreters. */
function assertLaunchedCommandSafe(args: string[], segment: string, launcher: string, valueFlags: Set<string>): void {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            assertInnerCommandSafe(args.slice(i + 1), segment);
            return;
        }
        if (arg.startsWith('-')) {
            const flag = arg.split('=')[0];
            if (flag === '-c' || flag === '--call' || flag === '--shell') {
                rejectInline(segment, `${launcher} ${flag}`);
            }
            if (valueFlags.has(flag) && !arg.includes('=')) i++;
            continue;
        }
        assertInnerCommandSafe(args.slice(i), segment);
        return;
    }
}

function assertInnerCommandSafe(tokens: string[], segment: string): void {
    if (tokens.length === 0) return;
    const inner = path.basename(tokens[0]);
    if (SHELL_COMMANDS.has(inner)) {
        rejectInline(segment, `launching shell "${inner}"`);
    }
    assertInterpreterSafe(inner, tokens.slice(1), segment);
}

const LAUNCHER_VALUE_FLAGS = new Set(['-p', '--package', '-w', '--workspace', '--prefix', '-C', '--dir', '--filter', '--cwd']);

/** Directories whose binaries may be invoked by absolute path. */
const TRUSTED_BINARY_DIRS = new Set(['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/sbin', '/sbin']);

/**
 * Rejects the inline-code / arbitrary-launch forms of allowlisted interpreters so that
 * the auto-allow tier cannot be used to run arbitrary code (`node -e`, `python -c`,
 * `env bash -c`, `npx -c`, `cmake -E`, `rg --pre`, `gcc -wrapper`, ...).
 */
export function assertInterpreterSafe(cmd: string, args: string[], segment: string): void {
    switch (cmd) {
        case 'node':
        case 'nodejs':
            assertNodeSafe(args, segment);
            break;
        case 'python':
        case 'python3':
            assertPythonSafe(args, segment);
            break;
        case 'env': {
            // `env` (print environment) is fine; `env [opts] [VAR=x] cmd ...` launches an arbitrary program.
            const launches = args.some(a => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
            if (launches) rejectInline(segment, 'env launching a command or using options');
            break;
        }
        case 'npx':
            assertLaunchedCommandSafe(args, segment, 'npx', LAUNCHER_VALUE_FLAGS);
            break;
        case 'npm':
        case 'pnpm':
        case 'yarn': {
            const subIndex = args.findIndex(a => !a.startsWith('-'));
            if (subIndex < 0) break;
            const sub = args[subIndex];
            const rest = args.slice(subIndex + 1);
            if (sub === 'exec' || sub === 'x' || sub === 'dlx') {
                assertLaunchedCommandSafe(rest, segment, `${cmd} ${sub}`, LAUNCHER_VALUE_FLAGS);
            } else if (cmd !== 'npm' && (sub === 'node' || SHELL_COMMANDS.has(sub) || sub === 'python' || sub === 'python3')) {
                // `yarn node -e ...` / `pnpm node ...` run the interpreter directly.
                assertInnerCommandSafe(args.slice(subIndex), segment);
            }
            break;
        }
        case 'make':
        case 'gmake':
            if (args.some(a => a === '-E' || a.startsWith('--eval'))) rejectInline(segment, 'make --eval');
            break;
        case 'cmake':
            if (args.some(a => a === '-E' || a === '-P')) rejectInline(segment, `cmake ${args.find(a => a === '-E' || a === '-P')}`);
            break;
        case 'clang':
        case 'clang++':
        case 'gcc':
        case 'g++':
            if (args.some(a => a === '-wrapper' || a.startsWith('-fplugin') || a.startsWith('-specs') || a === '-B' || /^-B./.test(a))) {
                rejectInline(segment, `${cmd} with a wrapper/plugin/toolchain override`);
            }
            break;
        case 'rg':
            if (args.some(a => a === '--pre' || a.startsWith('--pre='))) rejectInline(segment, 'rg --pre');
            break;
        default:
            break;
    }
}

function assertSegmentAllowed(segment: string, options: CommandPolicyOptions, allowlist: Set<string>): void {
    const tokens = tokenize(segment);
    if (tokens.length === 0) return;

    // Skip leading VAR=value assignments.
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
        if (DANGEROUS_ENV_ASSIGNMENT.test(tokens[index])) {
            rejectInline(segment, `setting ${tokens[index].split('=')[0]}`, 'env_assignment');
        }
        index++;
    }
    if (index >= tokens.length) return;

    const rawCmd = tokens[index];
    const cmd = path.basename(rawCmd);
    const args = tokens.slice(index + 1);

    // `./node` or `/tmp/x/ls` is whatever binary sits there, not the allowlisted tool.
    if (rawCmd.includes('/') && !TRUSTED_BINARY_DIRS.has(path.dirname(rawCmd))) {
        throw new SandboxCommandRejectedError(
            `Blocked by sandbox policy: path-qualified command "${rawCmd}" is outside the system binary directories (segment: "${segment}")`,
            segment,
            'not_allowlisted'
        );
    }

    if (!allowlist.has(cmd)) {
        throw new SandboxCommandRejectedError(
            `Blocked by sandbox policy: command "${cmd}" is not in the allowlist (segment: "${segment}")`,
            segment,
            'not_allowlisted'
        );
    }

    assertInterpreterSafe(cmd, args, segment);

    const positional = args.filter(a => !a.startsWith('-'));

    switch (cmd) {
        case 'git': {
            const sub = positional[0];
            if (!sub || !GIT_READ_ONLY_SUBCOMMANDS.includes(sub)) {
                throw new SandboxCommandRejectedError(
                    `Blocked by sandbox policy: only read-only git subcommands are allowed (${GIT_READ_ONLY_SUBCOMMANDS.join(', ')})`,
                    segment,
                    'git_write_subcommand'
                );
            }
            if (sub === 'branch' && args.some(a => /^(-[dDmMcC]|--delete|--move|--copy|--force|-f|--set-upstream-to|-u|--unset-upstream|--edit-description)$/.test(a))) {
                throw new SandboxCommandRejectedError(
                    'Blocked by sandbox policy: git branch may only list branches inside the sandbox',
                    segment,
                    'git_write_subcommand'
                );
            }
            break;
        }
        case 'mv':
        case 'cp':
        case 'mkdir':
        case 'touch':
            assertPathsWithinCwd(positional, options.cwd, segment, cmd);
            break;
        case 'sed': {
            const inPlace = args.some(a => a === '-i' || /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
            if (inPlace) {
                // First positional is the script (unless -e/-f given); remaining are files.
                const files = args.includes('-e') || args.includes('-f') ? positional : positional.slice(1);
                assertPathsWithinCwd(files, options.cwd, segment, 'sed -i');
            }
            break;
        }
        case 'find': {
            if (args.some(a => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))) {
                throw new SandboxCommandRejectedError(
                    'Blocked by sandbox policy: find may not execute or delete inside the sandbox',
                    segment,
                    'find_exec'
                );
            }
            break;
        }
        default:
            break;
    }

    assertRedirectsWithinCwd(segment, options.cwd);
}

/**
 * Validates a full command line against the sandbox policy.
 * Throws {@link SandboxCommandRejectedError} when the command must not run.
 */
export function assertCommandAllowed(command: string, options: CommandPolicyOptions): void {
    const trimmed = (command || '').trim();
    if (!trimmed) {
        throw new SandboxCommandRejectedError('Blocked by sandbox policy: empty command', command, 'empty');
    }

    assertNotHardDenied(trimmed, options.cwd);

    if (options.confirmedByUser === true) {
        return;
    }

    if (/`|\$\(|<\(|>\(/.test(trimmed)) {
        throw new SandboxCommandRejectedError(
            'Blocked by sandbox policy: command/process substitution requires explicit user confirmation',
            trimmed,
            'substitution'
        );
    }

    const allowlist = new Set(options.allowlist || DEFAULT_COMMAND_ALLOWLIST);
    for (const segment of splitShellSegments(trimmed)) {
        assertSegmentAllowed(segment, options, allowlist);
    }
}

/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
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

/** Commands the sandbox will run without an explicit user confirmation. */
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

/** Split a shell command line on top-level `;`, `&&`, `||`, `|` (quotes respected). */
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
        if (ch === ';' || ch === '|' || ch === '&') {
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

function assertSegmentAllowed(segment: string, options: CommandPolicyOptions, allowlist: Set<string>): void {
    const tokens = tokenize(segment);
    if (tokens.length === 0) return;

    // Skip leading VAR=value assignments.
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
    if (index >= tokens.length) return;

    const rawCmd = tokens[index];
    const cmd = path.basename(rawCmd);
    const args = tokens.slice(index + 1);

    if (!allowlist.has(cmd)) {
        throw new SandboxCommandRejectedError(
            `Blocked by sandbox policy: command "${cmd}" is not in the allowlist (segment: "${segment}")`,
            segment,
            'not_allowlisted'
        );
    }

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

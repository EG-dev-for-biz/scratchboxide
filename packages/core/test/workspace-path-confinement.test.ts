import { test } from 'vitest';
import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
    PathTraversalError,
    assertWorkspaceRoot,
    resolveWithinRoot
} from '../src/node/security/path-guard';
import { WorkspaceConfigService } from '../src/node/workspace-config-service';

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-path-guard-'));
    try {
        await fn(await fs.realpath(root));
    } finally {
        await fs.remove(root);
    }
}

test('resolveWithinRoot accepts legit nested relative and absolute paths', async () => {
    await withTempRoot(async root => {
        const nested = resolveWithinRoot(root, 'src/components/Button.tsx');
        assert.strictEqual(nested, path.join(root, 'src', 'components', 'Button.tsx'));

        const absoluteInside = resolveWithinRoot(root, path.join(root, 'docs', 'readme.md'));
        assert.strictEqual(absoluteInside, path.join(root, 'docs', 'readme.md'));

        // Root itself is allowed
        assert.strictEqual(resolveWithinRoot(root, '.'), root);
        assert.strictEqual(resolveWithinRoot(root, ''), root);

        // Dot segments that stay inside are fine
        assert.strictEqual(resolveWithinRoot(root, 'src/../docs/a.md'), path.join(root, 'docs', 'a.md'));
    });
});

test('resolveWithinRoot rejects ../ escapes', async () => {
    await withTempRoot(async root => {
        assert.throws(() => resolveWithinRoot(root, '../outside.txt'), PathTraversalError);
        assert.throws(() => resolveWithinRoot(root, 'src/../../outside.txt'), PathTraversalError);
        assert.throws(() => resolveWithinRoot(root, '..'), PathTraversalError);
        assert.throws(() => resolveWithinRoot(root, 'a/../../../etc/passwd'), PathTraversalError);
    });
});

test('resolveWithinRoot rejects absolute paths outside root and sibling-prefix roots', async () => {
    await withTempRoot(async root => {
        assert.throws(() => resolveWithinRoot(root, '/etc/passwd'), PathTraversalError);
        assert.throws(() => resolveWithinRoot(root, os.homedir()), PathTraversalError);
        // "/tmp/sb-path-guard-abc" must not accept "/tmp/sb-path-guard-abc-evil/x"
        assert.throws(() => resolveWithinRoot(root, `${root}-evil/x.txt`), PathTraversalError);
    });
});

test('resolveWithinRoot follows symlinks that escape the root', async () => {
    await withTempRoot(async root => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-path-guard-outside-'));
        try {
            await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
            await fs.symlink(outside, path.join(root, 'link'));
            assert.throws(() => resolveWithinRoot(root, 'link/secret.txt'), PathTraversalError);
            assert.throws(() => resolveWithinRoot(root, 'link'), PathTraversalError);
        } finally {
            await fs.remove(outside);
        }
    });
});

test('assertWorkspaceRoot enforces the allowlist', async () => {
    await withTempRoot(async root => {
        const allowed = [root];
        assert.strictEqual(assertWorkspaceRoot(root, allowed), root);
        assert.strictEqual(assertWorkspaceRoot(path.join(root, 'nested', 'project'), allowed), path.join(root, 'nested', 'project'));
        assert.throws(() => assertWorkspaceRoot(`${root}-evil`, allowed), PathTraversalError);
        assert.throws(() => assertWorkspaceRoot('/etc', allowed), PathTraversalError);
        assert.throws(() => assertWorkspaceRoot(path.join(root, '..'), allowed), PathTraversalError);
    });
});

test('WorkspaceConfigService confines artifact and lens writes to the workspace root', async () => {
    await withTempRoot(async root => {
        const service = new WorkspaceConfigService();

        // Legit nested write works
        const ok = await service.syncArtifactToWorkspace(root, {
            id: 'art-1',
            type: 'live-code-sandbox',
            title: 'Widget',
            data: { files: [{ name: 'nested/Widget.tsx', content: 'export const x = 1;' }] }
        } as any);
        assert.strictEqual(ok.success, true, ok.error);
        assert.ok(await fs.pathExists(path.join(root, 'src', 'components', 'nested', 'Widget.tsx')));

        // Traversal via file.name is rejected and nothing is written outside
        const escaped = await service.syncArtifactToWorkspace(root, {
            id: 'art-2',
            type: 'live-code-sandbox',
            title: 'Evil',
            data: { files: [{ name: '../../../../evil.txt', content: 'pwned' }] }
        } as any);
        assert.strictEqual(escaped.success, false);
        assert.ok(/outside|escape|traversal/i.test(escaped.error || ''), escaped.error);
        assert.strictEqual(await fs.pathExists(path.join(root, 'evil.txt')), false);
        assert.strictEqual(await fs.pathExists(path.resolve(root, '../../../../evil.txt')), false);

        // Traversal via targetSubdir is rejected
        const escapedSubdir = await service.syncArtifactToWorkspace(root, {
            id: 'art-3',
            type: 'markdown-document',
            title: 'Doc',
            data: { title: 'Doc', sections: [] }
        } as any, '../outside-docs');
        assert.strictEqual(escapedSubdir.success, false);

        // writeLensFiles: legit relative path ok, traversal rejected
        const lensOk = await service.writeLensFiles(root, { 'docs/a.md': '# a' });
        assert.strictEqual(lensOk.success, true);
        assert.ok(await fs.pathExists(path.join(root, 'docs', 'a.md')));

        const lensBad = await service.writeLensFiles(root, { '../escape.md': '# bad', [path.join(os.tmpdir(), 'abs-escape.md')]: '# bad' });
        assert.strictEqual(lensBad.success, false);
        assert.strictEqual(await fs.pathExists(path.resolve(root, '../escape.md')), false);
    });
});

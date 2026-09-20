import { test } from 'vitest';
import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceConfigService } from '../src/node/workspace-config-service';
import { PathTraversalError } from '../src/node/security/path-guard';
import { getMonacoLanguage } from '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-real-fs-test-'));
    try {
        await fn(await fs.realpath(root));
    } finally {
        await fs.remove(root);
    }
}

test('Real Filesystem Bridge: directory tree, read, write, and path confinement', async () => {
    await withTempRoot(async root => {
        const service = new WorkspaceConfigService();

        // 1. Write nested file directly to disk
        const relPath = 'src/components/DeepButton.tsx';
        const fileContent = 'export const DeepButton = () => <button>Click</button>;';
        const writeRes = await service.writeFileContent(root, relPath, fileContent);

        assert.strictEqual(writeRes.success, true);
        assert.strictEqual(writeRes.path, relPath);
        assert.strictEqual(typeof writeRes.size, 'number');

        // Verify physical existence
        const physicalPath = path.join(root, relPath);
        assert.ok(await fs.pathExists(physicalPath), 'File must exist on disk');
        const diskContent = await fs.readFile(physicalPath, 'utf-8');
        assert.strictEqual(diskContent, fileContent);

        // 2. Read file content back via service
        const readRes = await service.readFileContent(root, relPath);
        assert.strictEqual(readRes.content, fileContent);
        assert.strictEqual(readRes.isBinary, false);

        // 3. Scan directory tree
        const tree = await service.getDirectoryTree(root, 5);
        assert.ok(Array.isArray(tree), 'Directory tree must be an array');
        assert.ok(tree.length > 0, 'Directory tree must not be empty');

        const srcFolder = tree.find(node => node.name === 'src' && node.isFolder);
        assert.ok(srcFolder, 'Directory tree must include src folder');
        assert.ok(srcFolder.children && srcFolder.children.length > 0, 'src folder must have children');

        // 4. Path traversal safety
        await assert.rejects(
            async () => {
                await service.writeFileContent(root, '../../evil.txt', 'malicious');
            },
            PathTraversalError
        );

        await assert.rejects(
            async () => {
                await service.readFileContent(root, '/etc/passwd');
            },
            PathTraversalError
        );
    });
});

test('Monaco Language Mapping: accurately maps file extensions and sandbox languages', () => {
    assert.strictEqual(getMonacoLanguage('react', 'App.tsx'), 'typescript');
    assert.strictEqual(getMonacoLanguage('typescript', 'index.ts'), 'typescript');
    assert.strictEqual(getMonacoLanguage('javascript', 'script.js'), 'javascript');
    assert.strictEqual(getMonacoLanguage('python', 'model.py'), 'python');
    assert.strictEqual(getMonacoLanguage('css', 'styles.css'), 'css');
    assert.strictEqual(getMonacoLanguage('json', 'package.json'), 'json');
    assert.strictEqual(getMonacoLanguage('markdown', 'README.md'), 'markdown');
    assert.strictEqual(getMonacoLanguage(undefined, 'engine.cpp'), 'cpp');
    assert.strictEqual(getMonacoLanguage(undefined, 'math.hpp'), 'cpp');
    assert.strictEqual(getMonacoLanguage(undefined, 'deploy.sh'), 'shell');
});

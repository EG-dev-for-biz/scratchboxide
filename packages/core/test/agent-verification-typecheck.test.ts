import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentVerificationService, parseTscErrors } from '../src/node/gemini/agent-verification-service';
import { LspDiagnosticFeedbackService } from '../src/node/lsp-diagnostic-feedback-service';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';

const repoNodeModules = path.resolve(__dirname, '../../../node_modules');

async function makeProject(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-verify-'));
    await fs.symlink(repoNodeModules, path.join(root, 'node_modules'));
    await fs.writeJson(path.join(root, 'tsconfig.json'), { compilerOptions: { strict: true, noEmit: true, target: 'es2020', types: [] }, include: ['src'] });
    await fs.ensureDir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'other.ts'), 'export const untouched: number = "pre-existing";\n');
    return root;
}

test('a type error in an edited file fails verification with that error; the fix passes', async () => {
    const root = await makeProject();
    const verifier = new AgentVerificationService(new LspDiagnosticFeedbackService(), new ContainerSandboxService());

    await fs.writeFile(path.join(root, 'src', 'edited.ts'), 'export const count: number = "three";\n');
    const bad = await verifier.verify({ workspaceRoot: root, modifiedFiles: ['src/edited.ts'] });
    assert.strictEqual(bad.passed, false);
    assert.match(bad.summary || '', /src\/edited\.ts:1: TS2322/);
    assert.ok(!(bad.summary || '').includes('other.ts'), 'errors in files the agent did not touch are not blamed on it');

    await fs.writeFile(path.join(root, 'src', 'edited.ts'), 'export const count: number = 3;\n');
    const good = await verifier.verify({ workspaceRoot: root, modifiedFiles: ['src/edited.ts'] });
    assert.strictEqual(good.passed, true, good.summary);
    assert.match(good.summary || '', /Typecheck passed for \. \(1 pre-existing error/);
}, 120_000);

test('non-TypeScript edits are not claimed as typechecked', async () => {
    const root = await makeProject();
    const verifier = new AgentVerificationService(new LspDiagnosticFeedbackService(), new ContainerSandboxService());
    const result = await verifier.verify({ workspaceRoot: root, modifiedFiles: ['notes.md'] });
    assert.strictEqual(result.passed, true);
    assert.match(result.summary || '', /nothing was typechecked/);
});

test('tsc output is parsed into absolute file diagnostics', () => {
    const d = parseTscErrors("src/a.ts(4,7): error TS2304: Cannot find name 'x'.\nnoise", '/proj');
    assert.deepStrictEqual(d, [{ file: '/proj/src/a.ts', filePath: '/proj/src/a.ts', line: 4, message: "TS2304: Cannot find name 'x'.", severity: 'error', source: 'tsc' }]);
});

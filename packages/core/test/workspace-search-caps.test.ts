import { test, afterEach } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { workspaceHandlers, SEARCH_MAX_FILE_BYTES } from '../src/node/gemini/tools/workspace-tools';

const savedPath = process.env.PATH;
afterEach(() => { process.env.PATH = savedPath; });

function workspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ws-search-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const needle = 1;\nother\n');
    fs.writeFileSync(path.join(root, 'big.log'), 'needle\n' + 'x'.repeat(SEARCH_MAX_FILE_BYTES + 10));
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2, 0])]));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'needle');
    return root;
}

test('workspace_search (Node engine) skips oversized and binary files', async () => {
    const root = workspace();
    process.env.PATH = '/nonexistent'; // no rg: the Node search runs
    const out: any = await workspaceHandlers.workspace_search({ query: 'needle' }, { workspaceRoot: root } as any);
    assert.strictEqual(out.resultPayload.engine, 'node');
    assert.deepStrictEqual(out.resultPayload.matches, [{ file: 'src/a.ts', line: 1, content: 'const needle = 1;' }]);
});

test('workspace_search reads ripgrep --json when rg is installed and keeps the workspace exclusions', async () => {
    const root = workspace();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rg-shim-'));
    const argsLog = path.join(bin, 'args');
    const ev = (p: string, n: number, t: string) => JSON.stringify({ type: 'match', data: { path: { text: p }, line_number: n, lines: { text: t + '\n' } } });
    const lines = [JSON.stringify({ type: 'begin', data: { path: { text: './src/a.ts' } } }), ev('./src/a.ts', 1, 'const needle = 1;'), ev('./node_modules/dep.js', 1, 'needle'), ev('./src/with:colon.ts', 7, '  needle: true')];
    fs.writeFileSync(path.join(bin, 'rg'), `#!/bin/sh\necho "$@" > "${argsLog}"\ncat <<'EOF'\n${lines.join('\n')}\nEOF\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${savedPath}`;
    const out: any = await workspaceHandlers.workspace_search({ query: 'needle' }, { workspaceRoot: root } as any);
    assert.strictEqual(out.resultPayload.engine, 'ripgrep');
    assert.deepStrictEqual(out.resultPayload.matches, [
        { file: 'src/a.ts', line: 1, content: 'const needle = 1;' },
        { file: 'src/with:colon.ts', line: 7, content: 'needle: true' }
    ]);
    const args = fs.readFileSync(argsLog, 'utf8');
    assert.match(args, /--fixed-strings/);
    assert.match(args, new RegExp(`--max-filesize ${SEARCH_MAX_FILE_BYTES}`));
});

import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceConfigService } from '../src/node/workspace-config-service';
import { buildProjectKnowledgeSection } from '../src/node/gemini/prompt-builder';
import { assertSafeWorkspacePath } from '../src/node/gemini/tools/workspace-tools';

async function workspace(files: Record<string, string | Buffer>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-know-'));
    for (const [rel, content] of Object.entries(files)) {
        await fs.outputFile(path.join(root, '.scratchbox', 'knowledge', rel), content);
    }
    return root;
}

test('small knowledge sets are included in full, binaries are named but not inlined', async () => {
    const root = await workspace({ 'brief.md': 'Client wants a brass telescope.', 'specs/dims.txt': 'Tube length 1.2 m', 'ref.png': Buffer.from([0x89, 0x50, 0, 0, 1]) });
    const section = await buildProjectKnowledgeSection(root, new WorkspaceConfigService());
    assert.match(section, /PROJECT KNOWLEDGE/);
    assert.match(section, /Client wants a brass telescope\./);
    assert.match(section, /Tube length 1\.2 m/);
    assert.match(section, /ref\.png" bytes="5">\(binary or over 2 MB/);
});

test('large knowledge sets become an index the agent reads from', async () => {
    const root = await workspace({ 'big.md': 'x'.repeat(200_000), 'notes.md': 'short' });
    const section = await buildProjectKnowledgeSection(root, new WorkspaceConfigService());
    assert.match(section, /too large to include in full/);
    assert.match(section, /\.scratchbox\/knowledge\/big\.md \(195 KB\)/);
    assert.ok(!section.includes('xxxxxxxxxx'), 'large content is not inlined');
});

test('the agent may read knowledge files but nothing else in .scratchbox, and may not write there', () => {
    assert.doesNotThrow(() => assertSafeWorkspacePath('.scratchbox/knowledge/brief.md', 'read'));
    assert.throws(() => assertSafeWorkspacePath('.scratchbox/config.json', 'read'), /Access denied/);
    assert.throws(() => assertSafeWorkspacePath('.scratchbox/knowledge/brief.md', 'write'), /Access denied/);
    assert.throws(() => assertSafeWorkspacePath('.scratchbox/knowledge/../config.json', 'read'), /Access denied/);
});

test('no knowledge folder means no section', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-know-'));
    assert.strictEqual(await buildProjectKnowledgeSection(root, new WorkspaceConfigService()), '');
});

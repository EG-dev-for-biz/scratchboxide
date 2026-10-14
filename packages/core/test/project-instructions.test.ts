import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceConfigService } from '../src/node/workspace-config-service';
import { buildProjectInstructionsSection, buildSystemInstruction } from '../src/node/gemini/prompt-builder';

async function makeRepo(): Promise<{ repo: string; app: string }> {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-instr-'));
    await fs.ensureDir(path.join(repo, '.git'));
    await fs.writeFile(path.join(repo, 'AGENTS.md'), 'Repo rule: never use closed enums.');
    const app = path.join(repo, 'desktop-app');
    await fs.ensureDir(path.join(app, '.scratchbox', 'rules'));
    await fs.writeFile(path.join(app, 'SCRATCHBOX.md'), 'App rule: grey clay first.');
    await fs.writeFile(path.join(app, '.scratchbox', 'rules', 'units.md'), 'Use meters.');
    await fs.writeJson(path.join(app, '.scratchbox', 'config.json'), { settings: { customPromptInstructions: 'Answer in British English.' } });
    return { repo, app };
}

test('instructions are gathered from the workspace up to the repo root, outermost first', async () => {
    const { repo, app } = await makeRepo();
    const result = await new WorkspaceConfigService().loadAgentInstructions(app);
    assert.deepStrictEqual(result.files.map(f => path.relative(repo, f.path)), [
        'AGENTS.md',
        path.join('desktop-app', 'SCRATCHBOX.md'),
        path.join('desktop-app', '.scratchbox', 'rules', 'units.md')
    ]);
    assert.strictEqual(result.customInstructions, 'Answer in British English.');
});

test('the system prompt carries every project instruction', async () => {
    const { app } = await makeRepo();
    const prompt = await buildSystemInstruction(
        { prompt: 'hi', mode: 'agent', workspaceRoot: app } as any,
        { workspaceConfig: new WorkspaceConfigService() }
    );
    for (const text of ['never use closed enums', 'grey clay first', 'Use meters.', 'British English']) {
        assert.ok(prompt.includes(text), `system prompt is missing "${text}"`);
    }
    assert.ok(prompt.indexOf('PROJECT INSTRUCTIONS') < prompt.indexOf('NATIVE CAPABILITIES'));
});

test('no instruction files means no section', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-empty-'));
    await fs.ensureDir(path.join(empty, '.git'));
    assert.strictEqual(await buildProjectInstructionsSection(empty, new WorkspaceConfigService()), '');
});

import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceConfigService } from '../src/node/workspace-config-service';
import { buildSkillIndexSection } from '../src/node/gemini/prompt-builder';
import { workspaceHandlers } from '../src/node/gemini/tools/workspace-tools';

async function repoWithSkills(): Promise<{ repo: string; app: string }> {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-skills-'));
    await fs.ensureDir(path.join(repo, '.git'));
    await fs.outputFile(path.join(repo, '.agents', 'skills', 'clay-modeling', 'SKILL.md'),
        '---\nname: clay-modeling\ndescription: Build hero props in 18% grey clay with a 70-20-10 hierarchy.\n---\n# Clay modeling\nStep 1: block out the silhouette.\n' + 'Detail. '.repeat(1000));
    await fs.outputFile(path.join(repo, '.agents', 'skills', 'clay-modeling', 'reference.md'), 'supporting notes');
    const app = path.join(repo, 'desktop-app');
    await fs.outputFile(path.join(app, '.scratchbox', 'skills', 'lighting.md'), '---\nname: lighting\ndescription: Three-point studio lighting.\n---\nUse a key, fill and rim.');
    return { repo, app };
}

test('the prompt lists skills from the workspace and its parents, names and descriptions only', async () => {
    const { app } = await repoWithSkills();
    const section = await buildSkillIndexSection(app, new WorkspaceConfigService());
    assert.match(section, /- clay-modeling: Build hero props in 18% grey clay/);
    assert.match(section, /- lighting: Three-point studio lighting\./);
    assert.ok(!section.includes('Step 1: block out'), 'skill bodies stay out of the prompt');
    assert.ok(!(await buildSkillIndexSection(app, new WorkspaceConfigService(), ['clay-modeling'])).includes('clay-modeling'),
        'a manually attached skill is not listed twice');
});

test('load_skill returns full instructions, lists supporting files, and reads only those', async () => {
    const { app } = await repoWithSkills();
    const out: any = await workspaceHandlers.load_skill({ name: 'clay-modeling' }, { workspaceRoot: app, request: { prompt: '' } } as any);
    assert.match(out.resultPayload.instructions, /Step 1: block out the silhouette/);
    assert.ok(out.resultPayload.instructions.length > 8000, 'not truncated');
    assert.deepStrictEqual(out.resultPayload.files, ['reference.md']);
    const ref: any = await workspaceHandlers.load_skill({ name: 'clay-modeling', file: 'reference.md' }, { workspaceRoot: app, request: { prompt: '' } } as any);
    assert.strictEqual(ref.resultPayload.content, 'supporting notes');
    await assert.rejects(async () => workspaceHandlers.load_skill({ name: 'clay-modeling', file: '../../../.git/config' }, { workspaceRoot: app, request: { prompt: '' } } as any), /is not a file of skill/);
    await assert.rejects(async () => workspaceHandlers.load_skill({ name: 'nope' }, { workspaceRoot: app, request: { prompt: '' } } as any), /No skill named "nope"\. Available: clay-modeling, lighting/);
});

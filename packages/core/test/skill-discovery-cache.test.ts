import { test, vi } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceConfigService } from '../src/node/workspace-config-service';

test('discoverAgentSkills re-reads skills only when a skill file or folder changed', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-skill-cache-')));
    fs.mkdirSync(path.join(root, '.git'));
    const skillDir = path.join(root, '.agents', 'skills', 'alpha');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: alpha\ndescription: first\n---\nDo alpha.\n');
    const svc = new WorkspaceConfigService();
    const parse = vi.spyOn(WorkspaceConfigService.prototype as any, 'parseSkillMarkdown');

    const first = await svc.discoverAgentSkills(root);
    assert.deepStrictEqual(first.map(s => s.name), ['alpha']);
    const parsedOnce = parse.mock.calls.length;
    const again = await new WorkspaceConfigService().discoverAgentSkills(root);
    assert.deepStrictEqual(again.map(s => [s.name, s.rawContent]), first.map(s => [s.name, s.rawContent]));
    assert.strictEqual(parse.mock.calls.length, parsedOnce, 'unchanged skills are not re-read');
    again[0].name = 'mutated';
    assert.strictEqual((await svc.discoverAgentSkills(root))[0].name, 'alpha', 'callers get copies');

    // An edited SKILL.md (new size) and a new skill folder are picked up.
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: alpha\ndescription: second\n---\nDo alpha, then more.\n');
    assert.match(String((await svc.discoverAgentSkills(root))[0].rawContent), /then more/);
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'beta'));
    fs.writeFileSync(path.join(root, '.agents', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\nDo beta.\n');
    assert.deepStrictEqual((await svc.discoverAgentSkills(root)).map(s => s.name), ['alpha', 'beta']);
    parse.mockRestore();
});

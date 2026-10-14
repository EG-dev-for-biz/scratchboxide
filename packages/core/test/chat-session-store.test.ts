import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatSessionStore, mergeChatSessions } from '../src/node/chat-session-store';

test('sessions round-trip through <workspace>/.scratchbox/sessions and can be deleted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-sess-'));
    const store = new ChatSessionStore(root);
    await store.save(root, { id: 'sess-a', title: 'Telescope', messages: [{ text: 'hi' }] });
    await store.save(root, { id: 'sess-b', title: 'Stool', messages: [] });
    assert.ok(await fs.pathExists(path.join(root, '.scratchbox', 'sessions', 'sess-a.json')));

    const listed = await store.list(root);
    assert.deepStrictEqual(listed.map(s => s.id).sort(), ['sess-a', 'sess-b']);
    assert.strictEqual((listed.find(s => s.id === 'sess-a') as any).title, 'Telescope');

    await store.remove(root, 'sess-a');
    assert.deepStrictEqual((await store.list(root)).map(s => s.id), ['sess-b']);
});

test('session ids cannot escape the sessions folder', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-sess-'));
    await assert.rejects(new ChatSessionStore(root).save(root, { id: '../../evil' }), /Invalid session id/);
});

test('merge keeps one copy per id, preferring the one with more messages', () => {
    const disk = [{ id: 'a', messages: [1, 2, 3] }, { id: 'old', messages: [1] }];
    const cache = [{ id: 'a', messages: [1] }, { id: 'new', messages: [1, 2] }];
    const merged = mergeChatSessions(disk, cache);
    assert.deepStrictEqual(merged.map(s => s.id), ['a', 'new', 'old']);
    assert.strictEqual(merged[0].messages.length, 3);
});

test('recent projects persist in ~/.scratchbox-ide/projects.json', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-home-'));
    const store = new ChatSessionStore(home);
    assert.deepStrictEqual(await store.listProjects(), []);
    await store.saveProjects([{ id: 'p1', name: 'Telescope', path: '/work/telescope' }]);
    assert.deepStrictEqual(await store.listProjects(), [{ id: 'p1', name: 'Telescope', path: '/work/telescope' }]);
});

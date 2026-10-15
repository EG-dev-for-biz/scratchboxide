import { test } from 'vitest';
import * as assert from 'node:assert';
import { compactChatHistory, type HistoryMessage } from '../src/node/gemini/history-compaction';

const msg = (i: number, size = 10): HistoryMessage => ({ role: i % 2 ? 'model' : 'user', text: `m${i} ${'x'.repeat(size)}` });

test('history within budget is sent verbatim and never summarized', async () => {
    const history = Array.from({ length: 30 }, (_, i) => msg(i));
    let called = false;
    const out = await compactChatHistory(history, async () => { called = true; return ''; }, 10_000, 12);
    assert.deepStrictEqual(out, history);
    assert.strictEqual(called, false);
});

test('over budget, older turns become one summary and recent turns stay verbatim', async () => {
    const history = Array.from({ length: 30 }, (_, i) => msg(i, 1000));
    let transcript = '';
    const out = await compactChatHistory(history, async t => { transcript = t; return '- user wants a telescope'; }, 5_000, 12);
    assert.strictEqual(out.length, 13);
    assert.match(out[0].text, /Summary of the earlier part of this conversation \(18 messages\)/);
    assert.match(out[0].text, /user wants a telescope/);
    assert.deepStrictEqual(out.slice(1), history.slice(18));
    assert.ok(transcript.includes('m17') && !transcript.includes('m18 '));
});

test('a failed summary still drops older turns and says so', async () => {
    const history = Array.from({ length: 20 }, (_, i) => msg(i, 1000));
    const out = await compactChatHistory(history, async () => { throw new Error('quota'); }, 5_000, 12);
    assert.match(out[0].text, /8 earlier messages were dropped/);
    assert.strictEqual(out.length, 13);
});

test('a failed or empty summary is reported to the caller, so the reply can say older turns were left out', async () => {
    const history = Array.from({ length: 20 }, (_, i) => msg(i, 1000));
    const failures: Array<{ dropped: number; error: string }> = [];
    const report = (dropped: number, error: unknown) => failures.push({ dropped, error: error instanceof Error ? error.message : String(error) });
    await compactChatHistory(history, async () => { throw new Error('quota'); }, 5_000, 12, report);
    await compactChatHistory(history, async () => '   ', 5_000, 12, report);
    await compactChatHistory(history, async () => '- kept', 5_000, 12, report);
    assert.deepStrictEqual(failures, [{ dropped: 8, error: 'quota' }, { dropped: 8, error: 'the summary came back empty' }]);
});

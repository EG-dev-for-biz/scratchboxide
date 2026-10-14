import { test } from 'vitest';
import * as assert from 'node:assert';
import { prepareToolResultForModel } from '../src/node/gemini/streaming';

test('large numeric buffers are summarized before reaching the model', () => {
    const positions = Array.from({ length: 300_000 }, (_, i) => i * 0.001);
    const result = prepareToolResultForModel('algorithmic_uv_unwrap_rewrap', {
        vertexCount: 100_000,
        mesh: { positions, bounds: [0, 0, 0, 1, 1, 1] }
    });
    assert.deepStrictEqual(result, {
        vertexCount: 100_000,
        mesh: { positions: '[numeric array omitted, length: 300000]', bounds: [0, 0, 0, 1, 1, 1] }
    });
});

test('an oversized tool result is truncated to the per-result cap', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: `part_${i}`, note: 'contact verified against seat underside' }));
    const result = prepareToolResultForModel('sb_audit_scene_hierarchy', { rows });
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.length < 200_100, `expected capped result, got ${result.length} chars`);
    assert.match(result, /\[truncated, \d+ more chars\]$/);
});

test('small results pass through unchanged', () => {
    const payload = { success: true, score: 95, issues: ['none'] };
    assert.deepStrictEqual(prepareToolResultForModel('audit_3d_scene_viewport', payload), payload);
});

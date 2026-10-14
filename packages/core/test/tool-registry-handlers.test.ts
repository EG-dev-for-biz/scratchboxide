import { test } from 'vitest';
import * as assert from 'node:assert';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

test('every tool offered to the model has a handler', () => {
    const registry: any = createDefaultToolRegistry();
    const missing = registry.declarations().map((d: any) => d.name).filter((n: string) => typeof registry.get(n)?.handler !== 'function');
    assert.deepStrictEqual(missing, [], `declared with no handler: ${missing.join(', ')}`);
});

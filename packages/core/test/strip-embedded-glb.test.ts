import { test } from 'vitest';
import * as assert from 'node:assert';
import { stripEmbeddedGlb } from '../src/common/strip-embedded-glb';

const scene = (withHero: boolean) => ({
    type: '3d-scene',
    data: {
        pythonGenerator: { sourceCode: 'sb.build()', glbPath: '/repo/build/3d-python/scene_1.glb', glbBase64: 'Z2xURg'.repeat(1000) },
        objects: withHero ? [{ content: { type: '3d-model', durableUri: '/models/scene_1.glb' } }] : []
    }
});

test('drops the embedded model only where the same file is referenced', () => {
    const session = { id: 's', messages: [{ artifacts: [scene(true)] }], activeArtifact: scene(true), artifactHistory: [scene(false)] };
    const out: any = stripEmbeddedGlb(session);
    assert.strictEqual(out.activeArtifact.data.pythonGenerator.glbBase64, undefined);
    assert.strictEqual(out.activeArtifact.data.pythonGenerator.sourceCode, 'sb.build()');
    assert.strictEqual(out.messages[0].artifacts[0].data.pythonGenerator.glbBase64, undefined);
    assert.ok(out.artifactHistory[0].data.pythonGenerator.glbBase64, 'kept when no file reference exists, or the model would be lost');
    assert.ok((session.activeArtifact.data.pythonGenerator as any).glbBase64, 'input is not mutated');
    assert.ok(JSON.stringify(out).length < JSON.stringify(session).length / 2);
});

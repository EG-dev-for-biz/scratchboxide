import { test } from 'vitest';
import * as assert from 'node:assert';
import { stripEmbeddedGlb } from '../src/common/strip-embedded-glb';

const scene = (withHero: boolean, glbPath = '/repo/build/3d-python/scene_1.glb', sourceCode = 'sb.build()') => ({
    type: '3d-scene',
    data: {
        pythonGenerator: { sourceCode, glbPath, glbBase64: 'Z2xURg'.repeat(1000) },
        objects: withHero ? [{ content: { type: '3d-model', durableUri: '/models/scene_1.glb' } }] : []
    }
});

test('drops the embedded model where the same file is referenced', () => {
    const notServed = '/repo/desktop-app/build/3d-native/scene_1.glb';
    const session = { id: 's', messages: [{ artifacts: [scene(true, notServed)] }], activeArtifact: scene(true, notServed), artifactHistory: [scene(false, notServed)] };
    const out: any = stripEmbeddedGlb(session);
    assert.strictEqual(out.activeArtifact.data.pythonGenerator.glbBase64, undefined);
    assert.strictEqual(out.activeArtifact.data.pythonGenerator.sourceCode, 'sb.build()');
    assert.strictEqual(out.messages[0].artifacts[0].data.pythonGenerator.glbBase64, undefined);
    assert.ok(out.artifactHistory[0].data.pythonGenerator.glbBase64, 'kept when no object loads the file and the app does not serve it, or the model would be lost');
    assert.ok((session.activeArtifact.data.pythonGenerator as any).glbBase64, 'input is not mutated');
    assert.ok(JSON.stringify(out).length < JSON.stringify(session).length / 2);
});

test('drops the embedded model of a generator whose file the app serves and whose source can rebuild it', () => {
    const out: any = stripEmbeddedGlb({ history: [scene(false), scene(false, '/repo/build/3d-python/scene_1.glb', '')] });
    assert.strictEqual(out.history[0].data.pythonGenerator.glbBase64, undefined, 'the viewport loads /build/3d-python/scene_1.glb');
    assert.strictEqual(out.history[0].data.pythonGenerator.glbPath, '/repo/build/3d-python/scene_1.glb');
    assert.strictEqual(out.history[0].data.pythonGenerator.sourceCode, 'sb.build()');
    assert.ok(out.history[1].data.pythonGenerator.glbBase64, 'kept without a source to rebuild it if the file is deleted');
});

import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Dynamic4DGaussianSplatService } from '../src/node/3d-engine/Dynamic4DGaussianSplatService';
import { SbHumanAvatarService } from '../src/node/spatial/SbHumanAvatarService';
import { encodeGaussianPly } from '../src/common/gaussian-ply-codec';

function repoWithAvatar(frames: number) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-avatar-cache-'));
    const dir = path.join(root, 'models', 'performer_4dgs', 'demos', 'perf_a');
    fs.mkdirSync(dir, { recursive: true });
    const gaussians = Array.from({ length: 20 }, (_, i) => ({ position: [i * 0.01, 1, 0] as [number, number, number], colorRgb: [0.5, 0.4, 0.3] as [number, number, number], opacity: 0.9, scale: [0.01, 0.01, 0.01] as [number, number, number], boneIndices: [0, 0, 0, 0] as [number, number, number, number], boneWeights: [1, 0, 0, 0] as [number, number, number, number] }));
    fs.writeFileSync(path.join(dir, 'human_4dgs.ply'), encodeGaussianPly(gaussians));
    const writeMotion = (n: number) => fs.writeFileSync(path.join(dir, 'motion.json'), JSON.stringify({ fps: 30, num_frames: n, num_joints: 1, joints_name: ['root'], kintree_parents: [-1], canonical_joints: [[0, 1, 0]], frames: Array.from({ length: n }, () => ({ root_translation: [0, 0, 0], joint_rotations: [[0, 0, 0]] })) }));
    writeMotion(frames);
    return { root, dir, writeMotion };
}

test('an avatar loads once per process across service instances, and again when its files change', () => {
    const { root, writeMotion } = repoWithAvatar(5);
    const a = new Dynamic4DGaussianSplatService(root).loadAvatar('perf_a');
    const b = new Dynamic4DGaussianSplatService(root).loadAvatar('perf_a');
    assert.strictEqual(b, a, 'a second tool call reuses the parsed avatar');
    assert.strictEqual(a.gaussians.length, 20);
    assert.strictEqual(a.details.numFrames, 5);
    writeMotion(7);
    const c = new Dynamic4DGaussianSplatService(root).loadAvatar('perf_a');
    assert.notStrictEqual(c, a);
    assert.strictEqual(c.motion.frames.length, 7);
    assert.strictEqual(c.details.numFrames, 7);
});

test('the actor list reads each motion track once per version', async () => {
    const { root, writeMotion } = repoWithAvatar(4);
    const svc = new SbHumanAvatarService(root);
    const first = await svc.getActor('perf_a');
    assert.strictEqual(first?.frameCount, 4);
    assert.strictEqual(first?.fps, 30);
    writeMotion(9);
    assert.strictEqual((await new SbHumanAvatarService(root).getActor('perf_a'))?.frameCount, 9);
});

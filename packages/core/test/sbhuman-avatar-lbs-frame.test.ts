import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_CANONICAL_JOINTS } from '../src/common/humanoid-skinning';
import { PerformerSurfaceMeshService } from '../src/node/spatial/PerformerSurfaceMeshService';
import {
    SbHumanAvatarService,
    AvatarFrameOutOfRangeError,
    AvatarSkinningDataMissingError,
    UnsupportedSkinModalityError
} from '../src/node/spatial/SbHumanAvatarService';

type V3 = [number, number, number];
const rotY = (v: V3, a: number): V3 => [Math.cos(a) * v[0] + Math.sin(a) * v[2], v[1], -Math.sin(a) * v[0] + Math.cos(a) * v[2]];

// Two triangles, each bound to a different joint, positioned near the body.
const REST: V3[] = [[0.1, 1.0, 0.05], [0.2, 1.1, 0.0], [0.15, 0.9, 0.1], [-0.3, 0.4, 0.0], [-0.25, 0.5, 0.1], [-0.35, 0.45, -0.05]];
const BONES = [0, 0, 0, 2, 2, 2];

let root: string;
let service: SbHumanAvatarService;

function writeActor(id: string, withMotion: boolean, motionSource = 'mediapipe_pose_track'): void {
    const dir = path.join(root, 'models', 'performer_4dgs', 'demos', id);
    fs.mkdirSync(dir, { recursive: true });
    // listActors only needs the body file to exist; the GLB below is the rest mesh it decodes.
    fs.writeFileSync(path.join(dir, 'gvhmr_body.json'), '{}');
    const positions = new Float32Array(REST.flat());
    const skinIndices = new Uint8Array(REST.length * 4);
    const skinWeights = new Float32Array(REST.length * 4);
    BONES.forEach((b, i) => { skinIndices[i * 4] = b; skinWeights[i * 4] = 1; });
    const normals = new Float32Array(REST.length * 3);
    for (let i = 0; i < REST.length; i++) normals[i * 3] = 1; // +X
    const glb = PerformerSurfaceMeshService.encodeGlb(
        { positions, indices: new Uint32Array([0, 1, 2, 3, 4, 5]), skinIndices, skinWeights, normals },
        { includeSkin: true, canonicalJoints: DEFAULT_CANONICAL_JOINTS }
    );
    fs.mkdirSync(path.join(root, 'public', 'models'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public', 'models', `humanoid_${id}.glb`), glb);
    if (withMotion) {
        const canon = DEFAULT_CANONICAL_JOINTS as V3[];
        const frames = [0, Math.PI / 2].map((a, i) => ({
            frame_index: i,
            timestamp: i / 25,
            root_translation: [0, 0, 0],
            root_rotation_quat: [0, 0, 0, 1],
            joint_positions_3d: canon.map(j => rotY(j, a))
        }));
        fs.writeFileSync(path.join(dir, 'motion.json'), JSON.stringify({
            fps: 25, num_frames: 2, num_joints: 22, joints_name: [], kintree_parents: [],
            canonical_joints: canon, frames, motion_source: motionSource
        }));
    }
}

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbhuman-lbs-'));
    writeActor('tracked', true);
    writeActor('idle', true, 'synthetic_idle');
    writeActor('nomotion', false);
    service = new SbHumanAvatarService(root);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('PbrMeshSkinAdapter poses the frame it is asked for', () => {
    it('frame 0 (motion = canonical) returns the rest positions', async () => {
        const f = await service.evaluateActorFrame('tracked', 0, 'pbr-standard');
        for (let i = 0; i < REST.length; i++) {
            for (let k = 0; k < 3; k++) expect(f.positions![i * 3 + k]).toBeCloseTo(REST[i][k], 4);
        }
    });

    it('frame 1 (skeleton rotated 90 deg about Y) rotates every vertex and normal by the same rotation', async () => {
        const f = await service.evaluateActorFrame('tracked', 1, 'pbr-standard');
        expect(f.frameIndex).toBe(1);
        expect(f.motionSource).toBe('mediapipe_pose_track');
        for (let i = 0; i < REST.length; i++) {
            const want = rotY(REST[i], Math.PI / 2);
            for (let k = 0; k < 3; k++) expect(f.positions![i * 3 + k]).toBeCloseTo(want[k], 3);
            const n = rotY([1, 0, 0], Math.PI / 2);
            for (let k = 0; k < 3; k++) expect(f.normals![i * 3 + k]).toBeCloseTo(n[k], 3);
        }
        // Posed bounds differ from rest: the rest x-extent becomes the z-extent.
        expect(f.bounds!.max[2] - f.bounds!.min[2]).toBeCloseTo(0.55, 3);
    });

    it('2DGS surfels sit at the posed triangle centroids with face normals', async () => {
        const f = await service.evaluateActorFrame('tracked', 1, '2dgs-planar-surfel');
        expect(f.gaussianCount).toBe(2);
        const c0 = rotY([(0.1 + 0.2 + 0.15) / 3, 1.0, 0.05], Math.PI / 2);
        for (let k = 0; k < 3; k++) expect(f.positions![k]).toBeCloseTo(c0[k], 3);
        const n = f.normals!;
        expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
    });

    it('fails with typed errors instead of returning the rest pose', async () => {
        await expect(service.evaluateActorFrame('tracked', 2, 'pbr-standard')).rejects.toBeInstanceOf(AvatarFrameOutOfRangeError);
        await expect(service.evaluateActorFrame('nomotion', 0, 'pbr-standard')).rejects.toBeInstanceOf(AvatarSkinningDataMissingError);
    });

    it('rejects a modality with no adapter rather than serving PBR', async () => {
        await expect(service.getSkinAdapter('tracked', 'hybrid-pbr-hair-groom')).rejects.toBeInstanceOf(UnsupportedSkinModalityError);
        await expect(service.getSkinAdapter('tracked', 'not-a-modality')).rejects.toBeInstanceOf(UnsupportedSkinModalityError);
        const actor = await service.getActor('tracked');
        expect(actor!.availableModalities).not.toContain('hybrid-pbr-hair-groom');
    });

    it('reports the motion provenance so procedural motion is not passed off as tracked', async () => {
        const f = await service.evaluateActorFrame('idle', 1, 'pbr-standard');
        expect(f.motionSource).toBe('synthetic_idle');
    });
});

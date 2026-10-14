/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    decodeGaussianPly,
    encodeGaussianPly,
    SCRATCHBOX_PLY_ENCODING_COMMENT,
    SH_C0
} from '../src/common/gaussian-ply-codec';
import {
    Mat3,
    Vec3,
    applyMat3,
    computeBoneRotations,
    retargetSegmentDirections,
    skinPoint,
    SBHUMAN22_PARENTS
} from '../src/common/humanoid-skinning';
import { HumanoidMotionBridgeService } from '../src/node/spatial/HumanoidMotionBridgeService';
import { VideoTo4DPerformerPipelineService } from '../src/node/spatial/VideoTo4DPerformerPipelineService';
import { Dynamic4DGaussianSplatService } from '../src/node/3d-engine/Dynamic4DGaussianSplatService';
import { PerformerPoseTrack, PoseLandmarkTuple } from '../src/node/spatial/PerformerPoseTrackService';
import { GvhmrBody, GvhmrBodyService } from '../src/node/spatial/GvhmrBodyService';
import { MultiviewCloudService } from '../src/node/spatial/MultiviewCloudService';
import { encodePng } from '../src/node/texture-processing';
import { requireAssets, requirePythonModules, withReason } from './helpers/requirements';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEMOS_DIR = path.join(REPO_ROOT, 'models/performer_4dgs/demos');
const FEATURED_DEMOS = ['10331522', '2785536', '5435720', '15443888', '5885633'];
const CANONICAL: Vec3[] = new HumanoidMotionBridgeService().getDefaultCanonicalJoints();
const PERFORMER_PRODUCER = 'scripts/regenerate_5_demos.ts (GVHMR body via scripts/run_gvhmr.py)';

function rotY(deg: number): Mat3 {
    const a = (deg * Math.PI) / 180;
    return [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
}

function expectMatClose(a: Mat3, b: Mat3, digits = 4) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(a[i][j]).toBeCloseTo(b[i][j], digits);
}

/** Builds MediaPipe-convention (Y-down, Z away from camera) 33 landmarks from a Y-up joint set. */
function mediapipeWorldFromJoints(j: Vec3[]): PoseLandmarkTuple[] {
    const lm: Vec3[] = new Array(33).fill(null).map(() => [0, 0, 0] as Vec3);
    const head = j[15];
    lm[0] = [head[0], head[1], head[2] + 0.1];
    for (const i of [1, 2, 3]) lm[i] = [head[0] + 0.03, head[1] + 0.03, head[2] + 0.08];
    for (const i of [4, 5, 6]) lm[i] = [head[0] - 0.03, head[1] + 0.03, head[2] + 0.08];
    lm[7] = [head[0] + 0.07, head[1], head[2]];
    lm[8] = [head[0] - 0.07, head[1], head[2]];
    lm[9] = [head[0] + 0.02, head[1] - 0.05, head[2] + 0.09];
    lm[10] = [head[0] - 0.02, head[1] - 0.05, head[2] + 0.09];
    lm[11] = j[16]; lm[12] = j[17]; lm[13] = j[18]; lm[14] = j[19]; lm[15] = j[20]; lm[16] = j[21];
    for (const i of [17, 19, 21]) lm[i] = j[20];
    for (const i of [18, 20, 22]) lm[i] = j[21];
    lm[23] = j[1]; lm[24] = j[2]; lm[25] = j[4]; lm[26] = j[5]; lm[27] = j[7]; lm[28] = j[8];
    lm[29] = [j[10][0], j[10][1], j[10][2] - 0.05]; lm[31] = [j[10][0], j[10][1], j[10][2] + 0.05];
    lm[30] = [j[11][0], j[11][1], j[11][2] - 0.05]; lm[32] = [j[11][0], j[11][1], j[11][2] + 0.05];
    return lm.map(([x, y, z]) => [x, -y, -z, 0.99]);
}

describe('Gaussian PLY codec', () => {
    const sample = [{
        position: [0.1, 1.2, -0.05] as Vec3,
        normal: [0, 0, 1] as Vec3,
        colorRgb: [0.9, 0.2, 0.05] as Vec3,
        opacity: 0.8,
        scale: [0.004, 0.006, 0.001] as Vec3,
        quaternion: [0.1825742, 0.3651484, 0.5477226, 0.7302967] as [number, number, number, number],
        boneIndices: [9, 6, 13, 0] as [number, number, number, number],
        boneWeights: [0.6, 0.25, 0.1, 0.05] as [number, number, number, number]
    }];

    it('round-trips SH colour, logit opacity, log scale, w-first quaternion and bone weights', () => {
        const text = encodeGaussianPly(sample);
        expect(text).toContain(`comment ${SCRATCHBOX_PLY_ENCODING_COMMENT}`);
        const firstRow = text.split('end_header\n')[1].trim().split(/\s+/).map(Number);
        expect(firstRow[6]).toBeCloseTo((0.9 - 0.5) / SH_C0, 3);
        expect(firstRow[13]).toBeCloseTo(0.7302967, 4); // rot_0 is w

        const { gaussians, encoding } = decodeGaussianPly(text);
        expect(encoding).toEqual({ color: 'sh_dc', quat: 'wxyz', source: 'comment' });
        const g = gaussians[0];
        g.colorRgb.forEach((c, i) => expect(c).toBeCloseTo(sample[0].colorRgb[i], 3));
        g.quaternion.forEach((q, i) => expect(q).toBeCloseTo(sample[0].quaternion[i], 4));
        g.scale.forEach((s, i) => expect(s).toBeCloseTo(sample[0].scale[i], 5));
        expect(g.opacity).toBeCloseTo(0.8, 3);
        expect(g.boneIndices).toEqual([9, 6, 13, 0]);
        expect(g.boneWeights![0]).toBeCloseTo(0.6, 4);
    });

    it('is decoded identically by the native C++20 humanoid header', () => {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sbx-ply-cpp-'));
        const plyPath = path.join(dir, 'sample.ply');
        fs.writeFileSync(plyPath, encodeGaussianPly(sample));
        const src = path.join(dir, 'main.cpp');
        fs.writeFileSync(src, `#include "scratchbox_4dgs_humanoid.hpp"
#include <fstream>
#include <sstream>
#include <iostream>
int main() {
    std::ifstream in("${plyPath}"); std::stringstream ss; ss << in.rdbuf();
    scratchbox::performer_4d::FourDHumanoidAvatar a;
    if (!a.parsePly(ss.str())) return 1;
    const auto& g = a.restGaussians[0];
    std::cout << g.color.x << " " << g.color.y << " " << g.color.z << " " << g.rotation.x << " " << g.rotation.y << " " << g.rotation.z << " " << g.rotation.w;
}`);
        const bin = path.join(dir, 'main');
        try {
            require('child_process').execSync(`clang++ -std=c++20 -O1 -I "${path.resolve(__dirname, '../src/native/3d-engine/include')}" "${src}" -o "${bin}"`, { stdio: 'pipe' });
            const out = require('child_process').execSync(`"${bin}"`, { encoding: 'utf-8' }).trim().split(/\s+/).map(Number);
            out.slice(0, 3).forEach((c: number, i: number) => expect(c).toBeCloseTo(sample[0].colorRgb[i], 3));
            out.slice(3).forEach((q: number, i: number) => expect(q).toBeCloseTo(sample[0].quaternion[i], 4));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reads legacy benchmark PLYs as plain RGB with w-first quaternions', () => {
        const legacy = [
            'ply', 'format ascii 1.0', 'element vertex 2',
            ...['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'].map(p => `property float ${p}`),
            'end_header',
            '-0.11 1.38 -0.11 0.03 -0.58 -0.80 0.1912 0.1582 0.1480 3.20 -3.10 -3.10 -3.10 1.00 0.00 0.00 0.00',
            '-0.15 0.66 0.10 -0.62 -0.25 0.73 0.6471 0.7020 0.7059 3.20 -3.10 -3.10 -3.10 1.00 0.00 0.00 0.00'
        ].join('\n');
        const { gaussians, encoding } = decodeGaussianPly(legacy);
        expect(encoding.color).toBe('rgb');
        expect(encoding.quat).toBe('wxyz');
        expect(gaussians[1].colorRgb[0]).toBeCloseTo(0.6471, 4);
        expect(gaussians[0].quaternion).toEqual([0, 0, 0, 1]);
    });

    it('reads pre-codec pipeline PLYs as SH colour with x-first quaternions', () => {
        const pre = [
            'ply', 'format ascii 1.0', 'element vertex 1',
            ...['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'].map(p => `property float ${p}`),
            'property int joint_id',
            ...[0, 1, 2, 3].map(i => `property int bone_idx_${i}`),
            ...[0, 1, 2, 3].map(i => `property float bone_weight_${i}`),
            'end_header',
            '0 1 0 0 0 1 -1.2 -0.8 0.4 3.18 -5.3 -5.0 -6.6 0.1361 0.7285 0.0000 0.6713 2 2 1 0 0 0.7 0.2 0.1 0.0'
        ].join('\n');
        const { gaussians, encoding } = decodeGaussianPly(pre);
        expect(encoding).toMatchObject({ color: 'sh_dc', quat: 'xyzw', source: 'heuristic' });
        expect(gaussians[0].quaternion[3]).toBeCloseTo(0.6713 / Math.hypot(0.1361, 0.7285, 0, 0.6713), 4);
        expect(gaussians[0].colorRgb[0]).toBeCloseTo(0.5 + SH_C0 * -1.2, 4);
        expect(gaussians[0].boneIndices).toEqual([2, 1, 0, 0]);
    });
});

describe('Humanoid LBS skinning', () => {
    it('leaves the canonical pose unchanged', () => {
        const R = computeBoneRotations(CANONICAL, CANONICAL);
        R.forEach(r => expectMatClose(r, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]));
        const p: Vec3 = [0.5, 1.31, -0.05];
        const q = skinPoint(p, [18, 16, 0, 0], [0.7, 0.3, 0, 0], CANONICAL, CANONICAL, R);
        q.forEach((v, i) => expect(v).toBeCloseTo(p[i], 6));
    });

    it('swings a forearm point with its elbow', () => {
        const posed = CANONICAL.map(j => [...j] as Vec3);
        const elbow = posed[18];
        const len = Math.hypot(...(CANONICAL[20].map((v, i) => v - CANONICAL[18][i]) as Vec3));
        posed[20] = [elbow[0], elbow[1] - len, elbow[2]];
        const R = computeBoneRotations(CANONICAL, posed);
        const mid: Vec3 = CANONICAL[18].map((v, i) => (v + CANONICAL[20][i]) / 2) as Vec3;
        const q = skinPoint(mid, [18, 0, 0, 0], [1, 0, 0, 0], CANONICAL, posed, R);
        expect(q[0]).toBeCloseTo(elbow[0], 3);
        expect(q[1]).toBeCloseTo(elbow[1] - len / 2, 3);
    });

    it('recovers torso twist from the shoulder line instead of the last child segment', () => {
        const yaw = rotY(30);
        const pelvis = CANONICAL[0];
        const posed = CANONICAL.map(j => {
            const r = applyMat3(yaw, [j[0] - pelvis[0], j[1] - pelvis[1], j[2] - pelvis[2]]);
            return [r[0] + pelvis[0], r[1] + pelvis[1], r[2] + pelvis[2]] as Vec3;
        });
        const R = computeBoneRotations(CANONICAL, posed);
        for (const j of [0, 3, 6, 9, 12, 16, 18, 1, 4]) expectMatClose(R[j], yaw, 3);
    });
});

describe('Pose-track retargeting and camera resection', () => {
    const bridge = new HumanoidMotionBridgeService();

    function syntheticTrack(frames: Vec3[][]): PerformerPoseTrack {
        return {
            source: 'synthetic.mp4', width: 1080, height: 1920, fps: 25, model: 'test',
            frames: frames.map((j, f) => ({
                frame_index: f,
                timestamp: f / 25,
                world: mediapipeWorldFromJoints(j),
                // Orthographic view at 600 px/m with square pixels
                image: mediapipeWorldFromJoints(j).map(([x, y]) => [0.5 + (x * 600) / 1080, 0.5 + (y * 600) / 1920, 0, 0.99] as PoseLandmarkTuple)
            }))
        };
    }

    it('preserves avatar bone lengths, follows segment directions and pins feet to the floor', () => {
        const raised = CANONICAL.map(j => [...j] as Vec3);
        raised[20] = [raised[18][0], raised[18][1] + 0.25, raised[18][2]];
        const motion = bridge.retargetPoseTrack(syntheticTrack([CANONICAL, raised, CANONICAL]), CANONICAL, { smoothingPasses: 0, focalLengthPx: 60000 });
        expect(motion.motion_source).toBe('mediapipe_pose_track');
        expect(motion.frames.length).toBe(3);
        const floor = Math.min(CANONICAL[10][1], CANONICAL[11][1]);
        for (const fr of motion.frames) {
            const js = fr.joint_positions_3d as Vec3[];
            for (let j = 1; j < 22; j++) {
                const p = SBHUMAN22_PARENTS[j];
                const len = Math.hypot(js[j][0] - js[p][0], js[j][1] - js[p][1], js[j][2] - js[p][2]);
                const canonLen = Math.hypot(CANONICAL[j][0] - CANONICAL[p][0], CANONICAL[j][1] - CANONICAL[p][1], CANONICAL[j][2] - CANONICAL[p][2]);
                expect(len).toBeCloseTo(canonLen, 5);
            }
            expect(Math.min(js[10][1], js[11][1])).toBeCloseTo(floor, 5);
        }
        const wrist = motion.frames[1].joint_positions_3d[20];
        const elbow = motion.frames[1].joint_positions_3d[18];
        expect(wrist[1] - elbow[1]).toBeGreaterThan(0.2);
        expect(Math.abs(wrist[0] - elbow[0])).toBeLessThan(0.01);
    });

    it('trusts 2D image evidence over MediaPipe depth for limb bending', () => {
        // World landmarks claim a 50 degree forward knee bend; the image shows full-length straight legs.
        const bentWorld = CANONICAL.map(j => [...j] as Vec3);
        for (const [knee, ankle] of [[4, 7], [5, 8]]) {
            const shin = Math.hypot(...(CANONICAL[ankle].map((v, i) => v - CANONICAL[knee][i]) as Vec3));
            bentWorld[ankle] = [bentWorld[knee][0], bentWorld[knee][1] - shin * Math.cos(0.87), bentWorld[knee][2] - shin * Math.sin(0.87)];
        }
        const track = syntheticTrack([CANONICAL]);
        track.frames[0].world = mediapipeWorldFromJoints(bentWorld);
        const motion = bridge.retargetPoseTrack(track, CANONICAL, { smoothingPasses: 0, focalLengthPx: 60000 });
        const js = motion.frames[0].joint_positions_3d as Vec3[];
        for (const [hip, knee, ankle] of [[1, 4, 7], [2, 5, 8]]) {
            const u = js[hip].map((v, i) => v - js[knee][i]);
            const w = js[ankle].map((v, i) => v - js[knee][i]);
            const angle = Math.acos((u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w))) * 180 / Math.PI;
            expect(angle).toBeGreaterThan(165);
        }
    });

    it('resects the hero camera centre from 2D landmarks', () => {
        const pipeline = new VideoTo4DPerformerPipelineService();
        const intr = { width: 1080, height: 1920, fx: 1500, fy: 1500, cx: 540, cy: 960 };
        const cam: Vec3 = [0.12, 1.05, 3.2];
        const world = mediapipeWorldFromJoints(CANONICAL);
        const image = world.map(([x, y, z, v]) => {
            const X = x, Y = -y, Z = -z;
            const camZ = cam[2] - Z;
            return [(intr.fx * (X - cam[0]) / camZ + intr.cx) / intr.width, (intr.fy * (-(Y - cam[1])) / camZ + intr.cy) / intr.height, 0, v] as [number, number, number, number];
        });
        const posed22 = bridge.convertLandmarksToSbHuman22(world.map(([x, y, z, v]) => ({ x, y, z, visibility: v })));
        const solved = pipeline.solveCameraFromLandmarks(image, posed22, intr)!;
        expect(solved).not.toBeNull();
        expect(solved.camX).toBeCloseTo(cam[0], 1);
        expect(solved.camY).toBeCloseTo(cam[1], 1);
        expect(Math.abs(solved.standoff - cam[2])).toBeLessThan(0.1);
    });

    it('refuses to emit a motionless avatar from a still image unless explicitly allowed', async () => {
        const pipeline = new VideoTo4DPerformerPipelineService();
        // Any still image exercises the refusal; a small generated PNG stands in for a demo hero frame.
        const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sbx-4d-still-'));
        const hero = path.join(root, 'still', 'hero.png');
        fs.mkdirSync(path.dirname(hero));
        const W = 32, H = 64;
        const rgba = Buffer.alloc(W * H * 4, 128);
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
        fs.writeFileSync(hero, encodePng(W, H, rgba));
        const out = path.join(root, 'out');
        try {
            await expect(pipeline.executePipeline({ videoPath: hero, outputDir: out, numGaussians: 2000 })).rejects.toThrow(/No performer motion could be tracked/);
            expect(fs.existsSync(path.join(out, 'motion.json'))).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('GVHMR SB-Human body avatar', () => {
    // Rest: front quad (bone 1) facing +Z at z=0 and a hidden quad (bone 2) 0.5 m behind it.
    // Hero camera frame (OpenCV, y down): front quad at z=2, hidden quad at z=2.5, both centred on the axis.
    const quad = (z: number, flipY: boolean): Vec3[] => [[-0.5, 0, z], [0.5, 0, z], [0.5, 1, z], [-0.5, 1, z]]
        .map(([x, y, zz]) => (flipY ? [x, -(y - 0.5), zz] : [x, y, zz]) as Vec3);
    const body: GvhmrBody = {
        source: 'synthetic.mp4', fps: 25, width: 100, height: 100, num_frames: 2,
        K: [[100, 0, 50], [0, 100, 50], [0, 0, 1]],
        betas: new Array(10).fill(0),
        faces: [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]],
        rest_vertices: [...quad(0, false), ...quad(-0.5, false)],
        rest_joints: CANONICAL.map(j => [...j] as Vec3),
        skin_indices: [...new Array(4).fill([1, 0, 0, 0]), ...new Array(4).fill([2, 0, 0, 0])],
        skin_weights: new Array(8).fill([1, 0, 0, 0]),
        hero_incam_vertices: [...quad(2, true), ...quad(2.5, true)],
        frames: [{ joints: CANONICAL }, { joints: CANONICAL.map(([x, y, z]) => [x + 0.1, y, z] as Vec3) }]
    };
    const service = new GvhmrBodyService();
    const image = new Uint8Array(100 * 100 * 3);
    for (let v = 0; v < 100; v++) for (let u = 0; u < 100; u++) image.set(u < 50 ? [255, 0, 0] : [0, 0, 255], (v * 100 + u) * 3);

    it('samples the fitted surface area-uniformly with normalised barycentric skin weights', () => {
        const avatar = service.sampleCanonicalAvatar(body, 4000, [0.5, 0.5, 0.5]);
        expect(avatar.gaussians.length).toBe(4000);
        const front = avatar.gaussians.filter(g => g.position[2] > -0.25);
        expect(front.length / 4000).toBeGreaterThan(0.45);
        expect(front.length / 4000).toBeLessThan(0.55);
        for (const g of avatar.gaussians) {
            expect(g.boneWeights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
            expect(g.position[1]).toBeGreaterThanOrEqual(0);
            expect(g.position[1]).toBeLessThanOrEqual(1);
        }
        expect(front.every(g => g.boneIndices[0] === 1)).toBe(true);
    });

    it('textures visible samples from their exact hero-frame pixel and leaves occluded ones unsampled', () => {
        const avatar = service.sampleCanonicalAvatar(body, 4000, [0.5, 0.5, 0.5]);
        const { sampledFraction } = service.bakeHeroTexture(body, avatar, image, 100, 100);
        expect(sampledFraction).toBeGreaterThan(0.4);
        expect(sampledFraction).toBeLessThan(0.55);
        for (const g of avatar.gaussians) {
            if (g.position[2] > -0.25) {
                const expected = g.position[0] < -0.02 ? [1, 0, 0] : g.position[0] > 0.02 ? [0, 0, 1] : null;
                if (expected) expect(g.colorRgb).toEqual(expected);
            } else {
                expect(g.colorRgb).toEqual([0.5, 0.5, 0.5]);
            }
        }
    });

    it('converts GVHMR world joints into absolute avatar motion', () => {
        const motion = service.toMotion(body, 'synthetic');
        expect(motion.motion_source).toBe('gvhmr');
        expect(motion.frames.length).toBe(2);
        expect(motion.canonical_joints).toEqual(body.rest_joints);
        expect(motion.frames[1].joint_positions_3d[0][0]).toBeCloseTo(CANONICAL[0][0] + 0.1, 6);
        expect(motion.frames[1].root_translation[0]).toBeCloseTo(0.1, 6);
    });
});

describe('Viewer skinning parity', () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'public/video_to_4d_performer_studio.html'), 'utf-8');

    it('mirrors computeBoneRotations exactly', () => {
        const m = /\/\/ @sbx-skinning-begin([\s\S]*?)\/\/ @sbx-skinning-end/.exec(html);
        expect(m).not.toBeNull();
        const viewerCompute = new Function(`${m![1]}; return computeSkeletalBoneRotations;`)() as (c: Vec3[], p: Vec3[]) => Mat3[];

        let seed = 7;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.3;
        const posed = CANONICAL.map(j => [j[0] + rnd(), j[1] + rnd(), j[2] + rnd()] as Vec3);
        const a = computeBoneRotations(CANONICAL, posed);
        const b = viewerCompute(CANONICAL, posed);
        a.forEach((r, j) => expectMatClose(b[j], r, 6));
    });

    const python = [path.join(require('os').homedir(), '.cache/scratchbox/gvhmr-venv/bin/python'), 'python3']
        .find(p => !p.includes('/') || fs.existsSync(p))!;
    const numpy = requirePythonModules(python, ['numpy']);

    it.skipIf(!numpy.ok)(withReason('matches the NumPy port used by the multi-view refinement trainer', numpy), () => {
        let seed = 11;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.3;
        const posed = CANONICAL.map(j => [j[0] + rnd(), j[1] + rnd(), j[2] + rnd()] as Vec3);
        const out = require('child_process').execFileSync(python, [path.join(REPO_ROOT, 'scripts/sbx_skinning.py')], {
            input: JSON.stringify({ canonical: CANONICAL, posed }),
            encoding: 'utf-8'
        });
        const numpyR = JSON.parse(out) as Mat3[];
        computeBoneRotations(CANONICAL, posed).forEach((r, j) => expectMatClose(numpyR[j], r, 6));
    });

    it('keeps the invisible GLB holdout out of the depth buffer so it cannot punch holes in splats', () => {
        expect(html).not.toMatch(/colorWrite = false;(?![^\n]*depthWrite = false)/);
    });
});

describe('Featured Performer demo avatars', () => {
    const service = new Dynamic4DGaussianSplatService(REPO_ROOT);

    for (const id of FEATURED_DEMOS) {
        const dir = path.join(DEMOS_DIR, id);
        const avatar = requireAssets([path.join(dir, 'motion.json'), path.join(dir, 'human_4dgs.ply')], PERFORMER_PRODUCER);
        describe.skipIf(!avatar.ok)(withReason(id, avatar), () => {

            it('carries GVHMR-recovered motion with real joint travel', () => {
                const motion = JSON.parse(fs.readFileSync(path.join(dir, 'motion.json'), 'utf-8'));
                expect(motion.motion_source).toBe('gvhmr');
                expect(motion.frames.length).toBeGreaterThanOrEqual(100);
                let maxRange = 0;
                for (let j = 0; j < 22; j++) {
                    for (let a = 0; a < 3; a++) {
                        const vals = motion.frames.map((f: any) => f.joint_positions_3d[j][a]);
                        maxRange = Math.max(maxRange, Math.max(...vals) - Math.min(...vals));
                    }
                }
                expect(maxRange).toBeGreaterThan(0.1);
            });

            it('stores the reference 3DGS encoding with exact skinning weights', () => {
                const head = fs.readFileSync(path.join(dir, 'human_4dgs.ply'), 'utf-8').slice(0, 2000);
                expect(head).toContain(SCRATCHBOX_PLY_ENCODING_COMMENT);
                expect(head).toContain('property int bone_idx_0');
            });

            it('deforms into a closed body with no hollow horizontal bands', () => {
                const { motion } = service.loadAvatar(id);
                for (const f of [0, Math.floor(motion.frames.length / 2)]) {
                    const frame = service.animateFrame(id, f);
                    const lowY = frame.bounds.min[1] + 0.1;
                    const highY = frame.bounds.max[1] - 0.15;
                    const bins = new Array(Math.ceil((highY - lowY) / 0.03)).fill(0);
                    for (const s of frame.splats) {
                        const b = Math.floor((s.position[1] - lowY) / 0.03);
                        if (b >= 0 && b < bins.length) bins[b]++;
                    }
                    expect(Math.min(...bins)).toBeGreaterThan(60);
                }
            });
        });
    }
});

describe('Multi-view cloud job', () => {
    it('launches an internal-IP A100 VM with the job metadata and falls through stocked-out zones', () => {
        const calls: string[][] = [];
        const service = new MultiviewCloudService((cmd, args) => {
            calls.push([cmd, ...args]);
            if (cmd === 'gcloud' && args.includes('--zone=us-central1-a')) {
                throw Object.assign(new Error('fail'), { stderr: 'ZONE_RESOURCE_POOL_EXHAUSTED' });
            }
            return '';
        });
        const job = service.submit({ backend: 'gce', videoPath: path.join(DEMOS_DIR, '2785536', 'canonical_frame.jpg'), jobId: 'test-job', viewsPerLayer: 6, layerPitches: [0, 30] });
        expect(job.zone).toBe('us-central1-b');
        const create = calls.filter(c => c[0] === 'gcloud').pop()!;
        expect(create).toContain('--no-address');
        expect(create).toContain('--accelerator=type=nvidia-tesla-a100,count=1');
        expect(create.find(a => a.startsWith('--metadata='))).toContain('views-per-layer=6,layer-pitches=[0,30]');
        expect(calls.some(c => c[0] === 'gsutil' && c.at(-1) === 'gs://scratchbox-canvas-multiview-artifacts/jobs/test-job/input.mp4')).toBe(true);
    });

    it('executes the Cloud Run GPU job with per-run environment overrides by default', () => {
        const calls: string[][] = [];
        const service = new MultiviewCloudService((cmd, args) => {
            calls.push([cmd, ...args]);
            return cmd === 'gcloud' ? 'sbx-multiview-diffusion-abc12\n' : '';
        });
        const job = service.submit({ videoPath: path.join(DEMOS_DIR, '2785536', 'canonical_frame.jpg'), jobId: 'cr-job', layerPitches: [0, 30], reuseFrom: 'old-job', stage: 'refine' });
        expect(job.backend).toBe('cloudrun');
        expect(job.execution).toBe('sbx-multiview-diffusion-abc12');
        const exec = calls.find(c => c[0] === 'gcloud')!;
        expect(exec.slice(1, 5)).toEqual(['run', 'jobs', 'execute', 'sbx-multiview-diffusion']);
        expect(exec.find(a => a.startsWith('--update-env-vars='))).toBe(
            '--update-env-vars=^;^JOB_ID=cr-job;CLIP=performer;VIEWS=24;PITCHES=[0,30];ITERS=30000;REUSE_FROM=old-job;STAGE=refine;REFINE_MAX_SECONDS=2800;VIEWS_PER_GROUP=4');
        service.submit({ videoPath: path.join(DEMOS_DIR, '2785536', 'canonical_frame.jpg'), jobId: 'cr-job-2', viewsPerGroup: 6 });
        expect(calls.filter(c => c[0] === 'gcloud')[1].find(a => a.startsWith('--update-env-vars='))).toContain(';VIEWS_PER_GROUP=6');
    });

    it('installs the trained avatar with motion regenerated from the same GVHMR body', () => {
        const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sbx-4da-install-'));
        const download = path.join(root, 'download');
        const avatar = path.join(root, 'avatar');
        fs.mkdirSync(path.join(download, 'refined'), { recursive: true });
        const body: GvhmrBody = {
            source: 'x.mp4', fps: 25, width: 10, height: 10, num_frames: 1, K: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], betas: [],
            faces: [[0, 1, 2]], rest_vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], rest_joints: CANONICAL,
            skin_indices: new Array(3).fill([0, 0, 0, 0]), skin_weights: new Array(3).fill([1, 0, 0, 0]),
            hero_incam_vertices: [[0, 0, 1], [1, 0, 1], [0, 1, 1]], frames: [{ joints: CANONICAL }]
        };
        fs.writeFileSync(path.join(download, 'gvhmr_body.json'), JSON.stringify(body));
        fs.writeFileSync(path.join(download, 'refined', 'human_4dgs.ply'), encodeGaussianPly([{
            position: [0, 1, 0], colorRgb: [0.5, 0.5, 0.5], opacity: 0.9, scale: [0.01, 0.01, 0.01], quaternion: [0, 0, 0, 1],
            boneIndices: [0, 0, 0, 0], boneWeights: [1, 0, 0, 0]
        }]));
        new MultiviewCloudService(() => '').install(download, avatar, 'demo');
        const motion = JSON.parse(fs.readFileSync(path.join(avatar, 'motion.json'), 'utf-8'));
        expect(motion.motion_source).toBe('gvhmr');
        expect(motion.avatar_source).toBe('multiview_refined');
        expect(decodeGaussianPly(fs.readFileSync(path.join(avatar, 'human_4dgs.ply'), 'utf-8')).gaussians.length).toBe(1);

        // A longer local GVHMR track of the same clip drives the avatar on the trained body's bone lengths.
        const scaled = CANONICAL.map(j => [j[0] * 1.1, j[1] * 1.1, j[2] * 1.1] as Vec3);
        const longBody: GvhmrBody = { ...body, fps: 24, num_frames: 3, rest_joints: scaled,
            frames: [0, 1, 2].map(f => ({ joints: scaled.map(j => [j[0] + f * 0.1, j[1], j[2]] as Vec3) })) };
        fs.writeFileSync(path.join(root, 'long_body.json'), JSON.stringify(longBody));
        new MultiviewCloudService(() => '').install(download, avatar, 'demo', { motionBodyPath: path.join(root, 'long_body.json') });
        const long = JSON.parse(fs.readFileSync(path.join(avatar, 'motion.json'), 'utf-8'));
        expect(long.frames.length).toBe(3);
        expect(long.fps).toBe(24);
        expect(long.canonical_joints).toEqual(CANONICAL);
        const f2 = long.frames[2].joint_positions_3d;
        expect(f2[0][0]).toBeCloseTo(CANONICAL[0][0] + 0.2, 6);
        expect(f2[0][1]).toBeCloseTo(CANONICAL[0][1], 6);
        for (let j = 1; j < 22; j++) {
            const p = SBHUMAN22_PARENTS[j];
            const len = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
            expect(len(f2[j], f2[p])).toBeCloseTo(len(CANONICAL[j], CANONICAL[p]), 6);
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
});

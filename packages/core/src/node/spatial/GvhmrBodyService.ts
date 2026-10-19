/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileBuffer } from '../process/exec-file-async';
import { resolveRepoPython } from '../process/repo-python';
import { HumanoidMotionData, SkinWeightedGaussian } from '../3d-engine/Dynamic4DGaussianSplatService';
import { SBHUMAN22_PARENTS, Vec3 } from '../../common/humanoid-skinning';
import { resolveBinary } from '../video/HeadlessVideoEditorService';

/** Output of scripts/run_gvhmr.py (see its docstring for coordinate conventions). */
export interface GvhmrBody {
    source: string;
    gvhmr_revision?: string;
    fps: number;
    width: number;
    height: number;
    num_frames: number;
    K: number[][];
    betas: number[];
    faces: Array<[number, number, number]>;
    rest_vertices: Vec3[];
    rest_joints: Vec3[];
    skin_indices: Array<[number, number, number, number]>;
    skin_weights: Array<[number, number, number, number]>;
    hero_incam_vertices: Vec3[];
    frames: Array<{ joints: Vec3[] }>;
}

export interface GvhmrSurfaceSample {
    face: number;
    bary: Vec3;
}

export interface GvhmrCanonicalAvatar {
    gaussians: SkinWeightedGaussian[];
    samples: GvhmrSurfaceSample[];
    canonicalJoints: Array<[number, number, number]>;
    kintreeParents: number[];
}

export interface RunGvhmrOptions {
    maxFrames?: number;
    device?: string;
    pythonBinary?: string;
    gvhmrRoot?: string;
    /** Aborting it kills the GVHMR child process. */
    signal?: AbortSignal;
}

const JOINT_NAMES = [
    'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee', 'spine2', 'left_ankle',
    'right_ankle', 'spine3', 'left_foot', 'right_foot', 'neck', 'left_collar', 'right_collar', 'head',
    'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist'
];

function findRepoFile(relative: string): string | null {
    for (const start of [process.cwd(), __dirname]) {
        let cur = start;
        while (cur !== path.dirname(cur)) {
            const candidate = path.join(cur, relative);
            if (fs.existsSync(candidate)) return candidate;
            cur = path.dirname(cur);
        }
    }
    return null;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};
const baryMix = (bary: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 => [
    bary[0] * a[0] + bary[1] * b[0] + bary[2] * c[0],
    bary[0] * a[1] + bary[1] * b[1] + bary[2] * c[1],
    bary[0] * a[2] + bary[1] * b[2] + bary[2] * c[2]
];

function vertexNormals(vertices: Vec3[], faces: Array<[number, number, number]>): Vec3[] {
    const acc: Vec3[] = vertices.map(() => [0, 0, 0]);
    for (const [a, b, c] of faces) {
        const n = cross(sub(vertices[b], vertices[a]), sub(vertices[c], vertices[a]));
        for (const v of [a, b, c]) {
            acc[v][0] += n[0]; acc[v][1] += n[1]; acc[v][2] += n[2];
        }
    }
    return acc.map(normalize);
}

/** Shortest-arc quaternion (x, y, z, w) taking +Z onto the unit normal n. */
function quatFromNormal(n: Vec3): [number, number, number, number] {
    if (n[2] >= 0.9999) return [0, 0, 0, 1];
    if (n[2] <= -0.9999) return [0, 1, 0, 0];
    const s = Math.sqrt((1 + n[2]) * 2);
    const q: [number, number, number, number] = [-n[1] / s, n[0] / s, 0, s / 2];
    const l = Math.hypot(...q);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * Builds performer avatars from GVHMR's SB-Human body: the canonical Gaussians are sampled on
 * the fitted rest mesh, textured by projecting their exact hero-frame positions through GVHMR's camera,
 * and driven by GVHMR's world-grounded joint motion.
 */
export class GvhmrBodyService {
    public static resolvePythonBinary(explicit?: string): string {
        const candidates = [explicit, process.env.SCRATCHBOX_GVHMR_PYTHON, path.join(os.homedir(), '.cache/scratchbox/gvhmr-venv/bin/python')];
        return candidates.find(c => c && fs.existsSync(c)) || resolveRepoPython({ purpose: 'GVHMR' });
    }

    public static resolveGvhmrRoot(explicit?: string): string {
        return explicit || process.env.SCRATCHBOX_GVHMR_ROOT || path.join(os.homedir(), 'dev/GVHMR');
    }

    public load(bodyPath: string): GvhmrBody {
        const body = JSON.parse(fs.readFileSync(bodyPath, 'utf-8')) as GvhmrBody;
        if (!Array.isArray(body.frames) || !body.frames.length || !Array.isArray(body.rest_vertices)) {
            throw new Error(`${bodyPath} is not a GVHMR body export`);
        }
        return body;
    }

    /** Runs scripts/run_gvhmr.py and returns its gvhmr_body.json (also written into outputDir). */
    public async run(videoPath: string, outputDir: string, options: RunGvhmrOptions = {}): Promise<GvhmrBody> {
        const script = findRepoFile('scripts/run_gvhmr.py');
        if (!script) throw new Error('scripts/run_gvhmr.py not found');
        const root = GvhmrBodyService.resolveGvhmrRoot(options.gvhmrRoot);
        if (!fs.existsSync(path.join(root, 'hmr4d'))) {
            throw new Error(`GVHMR checkout not found at ${root}; clone GVHMR or set SCRATCHBOX_GVHMR_ROOT`);
        }
        const python = GvhmrBodyService.resolvePythonBinary(options.pythonBinary);
        const device = options.device || process.env.SCRATCHBOX_GVHMR_DEVICE || (process.platform === 'darwin' ? 'mps' : 'cuda');
        const args = [script, '--video', path.resolve(videoPath), '--out-dir', path.resolve(outputDir), '--device', device, '--gvhmr-root', root];
        if (options.maxFrames) args.push('--max-frames', String(options.maxFrames));
        try {
            await execFileBuffer(python, args, { maxBuffer: 256 * 1024 * 1024, timeoutMs: 30 * 60 * 1000, signal: options.signal });
        } catch (err: any) {
            if (options.signal?.aborted) throw err;
            const tail = String(err?.stderr || err?.message || '').split('\n').filter(Boolean).slice(-4).join('\n');
            throw new Error(
                `GVHMR failed (${python}, device ${device}). Create the environment with ` +
                '`python3.11 -m venv ~/.cache/scratchbox/gvhmr-venv && ~/.cache/scratchbox/gvhmr-venv/bin/pip install -r requirements.txt` ' +
                `or set SCRATCHBOX_GVHMR_PYTHON. ${tail}`
            );
        }
        return this.load(path.join(outputDir, 'gvhmr_body.json'));
    }

    /** Area-uniform Gaussian surfels on the fitted rest mesh with barycentric 4-bone skin weights. */
    public sampleCanonicalAvatar(body: GvhmrBody, numGaussians: number, baseColor: Vec3 = [0.5, 0.5, 0.5], seed = 7): GvhmrCanonicalAvatar {
        const V = body.rest_vertices;
        const F = body.faces;
        const N = vertexNormals(V, F);
        const areas = F.map(([a, b, c]) => Math.hypot(...cross(sub(V[b], V[a]), sub(V[c], V[a]))) / 2);
        const cumulative: number[] = [];
        let total = 0;
        for (const a of areas) cumulative.push((total += a));

        let state = seed >>> 0;
        const random = () => {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };

        // Surfel extent from the mean sample spacing so the surface closes at any density.
        const spacing = Math.sqrt(total / Math.max(1, numGaussians));
        const scale: Vec3 = [0.65 * spacing, 0.65 * spacing, 0.18 * spacing];

        const gaussians: SkinWeightedGaussian[] = [];
        const samples: GvhmrSurfaceSample[] = [];
        for (let i = 0; i < numGaussians; i++) {
            const r = random() * total;
            let lo = 0, hi = cumulative.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (cumulative[mid] < r) lo = mid + 1; else hi = mid;
            }
            const face = lo;
            const s = Math.sqrt(random());
            const t = random();
            const bary: Vec3 = [1 - s, s * (1 - t), s * t];
            const [a, b, c] = F[face];

            const weights = new Map<number, number>();
            [a, b, c].forEach((v, k) => {
                for (let m = 0; m < 4; m++) {
                    const j = body.skin_indices[v][m];
                    weights.set(j, (weights.get(j) || 0) + bary[k] * body.skin_weights[v][m]);
                }
            });
            const top = [...weights.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
            while (top.length < 4) top.push([0, 0]);
            const wSum = top.reduce((acc, [, w]) => acc + w, 0) || 1;
            const normal = normalize(baryMix(bary, N[a], N[b], N[c]));

            gaussians.push({
                position: baryMix(bary, V[a], V[b], V[c]),
                normal,
                scale,
                colorRgb: [...baseColor] as Vec3,
                opacity: 0.96,
                quaternion: quatFromNormal(normal),
                boneIndices: top.map(([j]) => j) as [number, number, number, number],
                boneWeights: top.map(([, w]) => w / wSum) as [number, number, number, number]
            });
            samples.push({ face, bary });
        }

        return {
            gaussians,
            samples,
            canonicalJoints: body.rest_joints.map(j => [j[0], j[1], j[2]]),
            kintreeParents: SBHUMAN22_PARENTS.slice()
        };
    }

    /**
     * Colours every sample from the hero frame at its exact hero-pose position (barycentric on GVHMR's
     * in-camera mesh). Occlusion uses a rasterized depth buffer of that mesh; samples the camera cannot
     * see take the mean observed colour of their primary bone.
     */
    public bakeHeroTexture(
        body: GvhmrBody,
        avatar: GvhmrCanonicalAvatar,
        heroRgb: Uint8Array | Buffer,
        width: number,
        height: number
    ): { sampledFraction: number } {
        const Vc = body.hero_incam_vertices;
        const F = body.faces;
        const Nc = vertexNormals(Vc, F);
        const [[fx, , cx], [, fy, cy]] = body.K;
        const sx = width / body.width;
        const sy = height / body.height;
        const project = (p: Vec3): [number, number, number] => [(fx * p[0] / p[2] + cx) * sx, (fy * p[1] / p[2] + cy) * sy, p[2]];

        const D = 2; // depth buffer downsampling
        const dw = Math.ceil(width / D), dh = Math.ceil(height / D);
        const depth = new Float32Array(dw * dh).fill(Infinity);
        const pv = Vc.map(v => (v[2] > 0.05 ? project(v) : null));
        for (const [a, b, c] of F) {
            const A = pv[a], B = pv[b], C = pv[c];
            if (!A || !B || !C) continue;
            const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]) / D)), x1 = Math.min(dw - 1, Math.ceil(Math.max(A[0], B[0], C[0]) / D));
            const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]) / D)), y1 = Math.min(dh - 1, Math.ceil(Math.max(A[1], B[1], C[1]) / D));
            const det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
            if (Math.abs(det) < 1e-9) continue;
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    const px = (x + 0.5) * D, py = (y + 0.5) * D;
                    const l0 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / det;
                    const l1 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / det;
                    const l2 = 1 - l0 - l1;
                    if (l0 < 0 || l1 < 0 || l2 < 0) continue;
                    const z = l0 * A[2] + l1 * B[2] + l2 * C[2];
                    const idx = y * dw + x;
                    if (z < depth[idx]) depth[idx] = z;
                }
            }
        }

        const sampled = new Array(avatar.gaussians.length).fill(false);
        avatar.samples.forEach((s, i) => {
            const [a, b, c] = F[s.face];
            const p = baryMix(s.bary, Vc[a], Vc[b], Vc[c]);
            if (p[2] <= 0.05) return;
            const n = normalize(baryMix(s.bary, Nc[a], Nc[b], Nc[c]));
            const facing = -(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) / Math.hypot(p[0], p[1], p[2]);
            if (facing < 0.05) return;
            const [u, v, z] = project(p);
            if (u < 0 || v < 0 || u >= width || v >= height) return;
            if (z > depth[Math.floor(v / D) * dw + Math.floor(u / D)] + 0.02) return;
            const pix = (Math.floor(v) * width + Math.floor(u)) * 3;
            avatar.gaussians[i].colorRgb = [heroRgb[pix] / 255, heroRgb[pix + 1] / 255, heroRgb[pix + 2] / 255];
            sampled[i] = true;
        });

        const sums = new Map<number, [number, number, number, number]>();
        avatar.gaussians.forEach((g, i) => {
            if (!sampled[i]) return;
            const acc = sums.get(g.boneIndices[0]) || [0, 0, 0, 0];
            acc[0] += g.colorRgb[0]; acc[1] += g.colorRgb[1]; acc[2] += g.colorRgb[2]; acc[3]++;
            sums.set(g.boneIndices[0], acc);
        });
        avatar.gaussians.forEach((g, i) => {
            if (sampled[i]) return;
            const acc = sums.get(g.boneIndices[0]);
            if (acc && acc[3] > 0) g.colorRgb = [acc[0] / acc[3] * 0.9, acc[1] / acc[3] * 0.9, acc[2] / acc[3] * 0.9];
        });

        return { sampledFraction: sampled.filter(Boolean).length / Math.max(1, sampled.length) };
    }

    /** Reads an image as packed RGB24 at its native resolution. */
    public readRgb(imagePath: string, width: number, height: number, signal?: AbortSignal): Promise<Buffer> {
        const ffmpeg = resolveBinary('ffmpeg');
        return execFileBuffer(ffmpeg, ['-v', 'error', '-i', imagePath, '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
            maxBuffer: width * height * 3 + 1024,
            signal
        });
    }

    public toMotion(body: GvhmrBody, clipId?: string): HumanoidMotionData {
        const rest = body.rest_joints;
        const fps = body.fps || 25;
        return {
            clip_id: clipId,
            body_model: 'sbhuman_22',
            fps,
            num_frames: body.frames.length,
            num_joints: 22,
            joints_name: JOINT_NAMES,
            kintree_parents: SBHUMAN22_PARENTS.slice(),
            canonical_joints: rest.map(j => [j[0], j[1], j[2]]),
            frames: body.frames.map((f, i) => ({
                frame_index: i,
                timestamp: i / fps,
                root_translation: [f.joints[0][0] - rest[0][0], f.joints[0][1] - rest[0][1], f.joints[0][2] - rest[0][2]],
                root_rotation_quat: [0, 0, 0, 1],
                joint_positions_3d: f.joints.map(j => [j[0], j[1], j[2]]),
                confidence: 1
            })),
            motion_source: 'gvhmr',
            source_video: body.source
        };
    }
}

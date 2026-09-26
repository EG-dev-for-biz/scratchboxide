/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { retargetSegmentDirections } from '../../common/humanoid-skinning';
import { GvhmrBodyService } from './GvhmrBodyService';

export interface FourDAnyoneJobOptions {
    videoPath: string;
    /** 'cloudrun' (default): the sbx-4danyone-multiview Cloud Run GPU job; 'gce': a one-off A100 VM. */
    backend?: 'cloudrun' | 'gce';
    jobId?: string;
    viewsPerLayer?: number;
    /** Target views denoised together (4 or 6); Cloud Run defaults to 4 to fit the L4's 22 GB. */
    viewsPerGroup?: 4 | 6;
    layerPitches?: number[];
    refineIters?: number;
    /** Reuse the staged multi-view diffusion output of an earlier job and only re-run refinement. */
    reuseFrom?: string;
    /**
     * Cloud Run caps GPU tasks at 1 hour, so its runs are split: 'inference' stages the diffusion output,
     * 'refine' trains from a stage within a time budget. 'all' runs both in one task (GCE default).
     */
    stage?: 'inference' | 'refine' | 'all';
    /** Wall-clock budget for refinement (Cloud Run default 2800 s so the task finishes inside the hour). */
    refineMaxSeconds?: number;
    bucket?: string;
    zones?: string[];
    machineType?: string;
    acceleratorType?: string;
}

export interface FourDAnyoneJobStatus {
    state: 'submitted' | 'setup' | 'inference' | 'staged' | 'export' | 'refine' | 'upload' | 'done' | 'failed' | 'unknown';
    detail?: string;
    time?: string;
    instance?: string;
}

export interface FourDAnyoneJob {
    jobId: string;
    bucket: string;
    jobUri: string;
    backend?: 'cloudrun' | 'gce';
    /** GCE backend */
    zone?: string;
    instance?: string;
    /** Cloud Run backend */
    region?: string;
    execution?: string;
}

const DEFAULT_BUCKET = 'scratchbox-canvas-4danyone-artifacts';
const IMAGE_FAMILY = 'common-cu129-ubuntu-2204-nvidia-580';
const JOB_SCRIPTS = ['scripts/run_gvhmr.py', 'scripts/refine_multiview_avatar.py', 'scripts/sbx_skinning.py', 'deploy/4danyone-cloudrun/entrypoint.sh'];
const CLOUD_RUN_JOB = 'sbx-4danyone-multiview';
const CLOUD_RUN_REGION = 'us-central1';

function findRepoFile(relative: string): string {
    for (const start of [process.cwd(), __dirname]) {
        let cur = start;
        while (cur !== path.dirname(cur)) {
            const candidate = path.join(cur, relative);
            if (fs.existsSync(candidate)) return candidate;
            cur = path.dirname(cur);
        }
    }
    throw new Error(`${relative} not found`);
}

/**
 * Runs the 4DAnyone multi-view diffusion stage plus Scratchbox's animatable Gaussian refinement on GPU,
 * either as the Cloud Run job built by deploy/4danyone-cloudrun (default) or on a one-off GCE A100 VM
 * (deploy/4danyone-gpu/startup.sh), and installs the trained avatar. Both share the GCS job layout
 * gs://<bucket>/jobs/<id>/{input.mp4, scripts/, status.json, log.txt, stage/, output/}.
 */
export type CommandRunner = (cmd: string, args: string[], input?: string) => string;

const execRunner: CommandRunner = (cmd, args, input) =>
    execFileSync(cmd, args, { encoding: 'utf-8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

export class FourDAnyoneCloudService {
    constructor(private readonly run: CommandRunner = execRunner) {}

    public submit(options: FourDAnyoneJobOptions): FourDAnyoneJob {
        const bucket = options.bucket || DEFAULT_BUCKET;
        const jobId = options.jobId || `4da-${path.basename(options.videoPath, path.extname(options.videoPath))}-${Date.now().toString(36)}`
            .toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const jobUri = `gs://${bucket}/jobs/${jobId}`;
        const clip = 'performer';

        this.run('gsutil', ['-q', 'cp', path.resolve(options.videoPath), `${jobUri}/input.mp4`]);
        this.run('gsutil', ['-q', 'cp', ...JOB_SCRIPTS.map(s => findRepoFile(s)), `${jobUri}/scripts/`]);
        this.run('gsutil', ['-q', 'cp', '-', `${jobUri}/status.json`], JSON.stringify({ state: 'submitted', time: new Date().toISOString() }));

        if ((options.backend ?? 'cloudrun') === 'cloudrun') {
            const env = [
                `JOB_ID=${jobId}`, `CLIP=${clip}`, `VIEWS=${options.viewsPerLayer ?? 24}`,
                `PITCHES=[${(options.layerPitches ?? [15]).join(',')}]`, `ITERS=${options.refineIters ?? 30000}`,
                `REUSE_FROM=${options.reuseFrom ?? ''}`, `STAGE=${options.stage ?? 'all'}`,
                `REFINE_MAX_SECONDS=${options.refineMaxSeconds ?? 2800}`,
                `VIEWS_PER_GROUP=${options.viewsPerGroup ?? 4}`
            ].join(';');
            const out = this.run('gcloud', [
                'run', 'jobs', 'execute', CLOUD_RUN_JOB, `--region=${CLOUD_RUN_REGION}`, '--async',
                `--update-env-vars=^;^${env}`, '--format=value(metadata.name)'
            ]);
            return { jobId, bucket, jobUri, backend: 'cloudrun', region: CLOUD_RUN_REGION, execution: out.trim().split('\n').pop() };
        }

        const instance = `sbx-${jobId}`.slice(0, 62).replace(/-+$/, '');
        const metadata = [
            `job-id=${jobId}`, `bucket=${bucket}`, `clip=${clip}`,
            `views-per-layer=${options.viewsPerLayer ?? 24}`,
            `layer-pitches=[${(options.layerPitches ?? [15]).join(',')}]`,
            `refine-iters=${options.refineIters ?? 15000}`,
            ...(options.reuseFrom ? [`reuse-from=${options.reuseFrom}`] : [])
        ].join(',');
        const zones = options.zones || ['us-central1-a', 'us-central1-b', 'us-central1-c', 'us-central1-f'];
        let lastError = '';
        for (const zone of zones) {
            try {
                this.run('gcloud', [
                    'compute', 'instances', 'create', instance, `--zone=${zone}`,
                    `--machine-type=${options.machineType || 'a2-highgpu-1g'}`,
                    `--accelerator=type=${options.acceleratorType || 'nvidia-tesla-a100'},count=1`,
                    '--maintenance-policy=TERMINATE', '--provisioning-model=STANDARD',
                    `--image-family=${IMAGE_FAMILY}`, '--image-project=deeplearning-platform-release',
                    '--boot-disk-size=250GB', '--boot-disk-type=pd-ssd', '--scopes=cloud-platform',
                    // Org policy forbids external IPs; egress goes through the region's Cloud NAT.
                    '--no-address',
                    '--max-run-duration=6h', '--instance-termination-action=DELETE',
                    `--metadata=${metadata},install-nvidia-driver=True`,
                    `--metadata-from-file=startup-script=${findRepoFile('deploy/4danyone-gpu/startup.sh')}`,
                    '--quiet'
                ]);
                return { jobId, bucket, zone, instance, jobUri, backend: 'gce' };
            } catch (err: any) {
                lastError = String(err?.stderr || err?.message || err);
                if (!/ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources|unavailable|stockout/i.test(lastError)) break;
            }
        }
        throw new Error(`Could not start the 4DAnyone GPU VM: ${lastError.trim().split('\n').slice(-3).join(' ')}`);
    }

    public status(job: Pick<FourDAnyoneJob, 'jobUri'>): FourDAnyoneJobStatus {
        try {
            return JSON.parse(this.run('gsutil', ['cat', `${job.jobUri}/status.json`])) as FourDAnyoneJobStatus;
        } catch {
            return { state: 'unknown' };
        }
    }

    public async waitForCompletion(job: FourDAnyoneJob, onStatus?: (s: FourDAnyoneJobStatus) => void, pollMs = 60000): Promise<FourDAnyoneJobStatus> {
        let last = '';
        for (;;) {
            const s = this.status(job);
            const key = `${s.state}:${s.detail}`;
            if (key !== last) {
                onStatus?.(s);
                last = key;
            }
            if (s.state === 'done' || s.state === 'failed' || s.state === 'staged') {
                if (job.backend !== 'cloudrun') this.deleteInstance(job, s.instance);
                return s;
            }
            const crashed = job.backend === 'cloudrun' && this.cloudRunExecutionFailed(job);
            if (crashed) return { state: 'failed', detail: `Cloud Run execution ${job.execution} failed before reporting status` };
            await new Promise(r => setTimeout(r, pollMs));
        }
    }

    private cloudRunExecutionFailed(job: FourDAnyoneJob): boolean {
        if (!job.execution) return false;
        try {
            const failed = this.run('gcloud', ['run', 'jobs', 'executions', 'describe', job.execution,
                `--region=${job.region || CLOUD_RUN_REGION}`, '--format=value(status.failedCount)']);
            return Number(failed.trim() || 0) > 0;
        } catch {
            return false;
        }
    }

    /** Best-effort: the VM's own service account typically lacks compute permissions to delete itself. */
    public deleteInstance(job: Pick<FourDAnyoneJob, 'zone' | 'instance'>, instance?: string): void {
        if (!job.zone) return;
        const name = instance || job.instance;
        if (!name || !job.zone) return;
        try {
            this.run('gcloud', ['compute', 'instances', 'delete', name, `--zone=${job.zone}`, '--quiet']);
        } catch {
            // Already deleted, or deletion is handled by max-run-duration
        }
    }

    public download(job: Pick<FourDAnyoneJob, 'jobUri'>, destDir: string): string {
        fs.mkdirSync(destDir, { recursive: true });
        this.run('gsutil', ['-q', '-m', 'cp', '-r', `${job.jobUri}/output/*`, destDir]);
        try {
            this.run('gsutil', ['-q', 'cp', `${job.jobUri}/log.txt`, path.join(destDir, 'job_log.txt')]);
        } catch {
            // Log upload is best-effort
        }
        return destDir;
    }

    /**
     * Installs a downloaded job into an avatar directory: the trained PLY becomes human_4dgs.ply and
     * motion.json is regenerated from the same GVHMR body the Gaussians were trained against.
     */
    /**
     * Installs a finished job into a demo directory. `motionBodyPath` (a longer local GVHMR track of the same
     * clip) replaces 4DAnyone's 121-frame window, retargeted onto the trained body's bone lengths.
     */
    public install(downloadDir: string, avatarDir: string, clipId: string, options: { motionBodyPath?: string } = {}): void {
        const refinedPly = path.join(downloadDir, 'refined', 'human_4dgs.ply');
        const bodyPath = path.join(downloadDir, 'gvhmr_body.json');
        if (!fs.existsSync(refinedPly) || !fs.existsSync(bodyPath)) {
            throw new Error(`${downloadDir} does not contain refined/human_4dgs.ply and gvhmr_body.json`);
        }
        fs.mkdirSync(avatarDir, { recursive: true });
        const service = new GvhmrBodyService();
        const body = service.load(bodyPath);
        fs.copyFileSync(refinedPly, path.join(avatarDir, 'human_4dgs.ply'));
        fs.copyFileSync(bodyPath, path.join(avatarDir, 'gvhmr_body.json'));
        let driver = body;
        if (options.motionBodyPath) {
            const long = service.load(options.motionBodyPath);
            const shift = [0, 1, 2].map(a => body.rest_joints[0][a] - long.rest_joints[0][a]);
            driver = {
                ...body,
                fps: long.fps,
                num_frames: long.frames.length,
                source: long.source,
                frames: long.frames.map(f => ({ joints: retargetSegmentDirections(body.rest_joints, f.joints,
                    [f.joints[0][0] + shift[0], f.joints[0][1] + shift[1], f.joints[0][2] + shift[2]]) }))
            };
        }
        const motion = { ...service.toMotion(driver, clipId), motion_source: 'gvhmr', avatar_source: '4danyone_multiview_refined' };
        fs.writeFileSync(path.join(avatarDir, 'motion.json'), JSON.stringify(motion, null, 2));
        const report = path.join(downloadDir, 'refined', 'refine_report.json');
        if (fs.existsSync(report)) fs.copyFileSync(report, path.join(avatarDir, 'refine_report.json'));
    }

    public static defaultWorkDir(jobId: string): string {
        return path.join(os.homedir(), '.cache/scratchbox/4danyone-jobs', jobId);
    }
}

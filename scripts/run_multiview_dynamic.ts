import * as fs from 'fs';
import * as path from 'path';
import { MultiviewCloudService, MultiviewJob } from '../packages/core/src/node/spatial/MultiviewCloudService';

// Usage: npx vite-node scripts/run_multiview_dynamic.ts <demoId> [--views 24] [--pitches 15] [--iters 30000]
//   [--group 4|6] [--motion-body <longer gvhmr_body.json driving the installed avatar>]
//        [--backend cloudrun|gce]
//        [--reuse-from <jobId>]  re-run refinement on an earlier job's staged diffusion output
//        [--resume <jobId> --zone <zone>]
// Runs multi-view diffusion + animatable Gaussian refinement on the Cloud Run L4 job (or a GCE A100) and installs the
// trained avatar into models/performer_4dgs/demos/<demoId> (the previous PLY is kept as human_4dgs.gvhmr.ply).

function flag(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const demoId = process.argv[2];
    if (!demoId || demoId.startsWith('--')) throw new Error('usage: run_multiview_dynamic.ts <demoId> [...]');
    const demoDir = path.resolve(process.cwd(), 'models/performer_4dgs/demos', demoId);
    const video = path.join(demoDir, 'source_video.mp4');
    if (!fs.existsSync(video)) throw new Error(`${video} missing; run scripts/regenerate_5_demos.ts first`);

    const cloud = new MultiviewCloudService();
    const backend = (flag('backend') as 'cloudrun' | 'gce') || 'cloudrun';
    const log = (s: { state: string; detail?: string }) => console.log(`[multiview] ${new Date().toISOString()} ${s.state}: ${s.detail || ''}`);
    const base = {
        videoPath: video,
        backend,
        viewsPerLayer: Number(flag('views') || 24),
        viewsPerGroup: flag('group') ? (Number(flag('group')) as 4 | 6) : undefined,
        layerPitches: (flag('pitches') || '15').split(',').map(Number),
        refineIters: Number(flag('iters') || 30000)
    };
    const resume = flag('resume');
    let job: MultiviewJob;
    let final;
    if (resume) {
        job = { jobId: resume, bucket: 'scoutscan-multiview-artifacts', backend: flag('zone') ? 'gce' : 'cloudrun',
            zone: flag('zone'), jobUri: `gs://scoutscan-multiview-artifacts/jobs/${resume}` };
        final = await cloud.waitForCompletion(job, log);
    } else if (backend === 'cloudrun') {
        // Cloud Run caps GPU tasks at 1 hour: stage the diffusion output first, then refine from it.
        const jobId = `mv-${demoId}-${Date.now().toString(36)}`;
        let reuseFrom = flag('reuse-from');
        if (!reuseFrom) {
            job = cloud.submit({ ...base, jobId, stage: 'inference' });
            console.log(`[multiview] job ${jobId}: inference execution ${job.execution}`);
            const staged = await cloud.waitForCompletion(job, log);
            if (staged.state !== 'staged') throw new Error(`inference ${staged.state}: ${staged.detail}`);
            reuseFrom = jobId;
        }
        job = cloud.submit({ ...base, jobId, stage: 'refine', reuseFrom });
        console.log(`[multiview] job ${jobId}: refine execution ${job.execution} (stage from ${reuseFrom})`);
        final = await cloud.waitForCompletion(job, log);
    } else {
        job = cloud.submit({ ...base, jobId: `mv-${demoId}-${Date.now().toString(36)}`, reuseFrom: flag('reuse-from') });
        console.log(`[multiview] job ${job.jobId} on GCE ${job.instance} ${job.zone}`);
        final = await cloud.waitForCompletion(job, log);
    }
    const workDir = MultiviewCloudService.defaultWorkDir(job.jobId);
    if (final.state !== 'done') {
        try { cloud.download(job, workDir); } catch { /* partial outputs */ }
        throw new Error(`job ${job.jobId} ${final.state}: ${final.detail}; log in ${workDir}/job_log.txt`);
    }
    cloud.download(job, workDir);
    const ply = path.join(demoDir, 'human_4dgs.ply');
    const backup = path.join(demoDir, 'human_4dgs.gvhmr.ply');
    if (fs.existsSync(ply) && !fs.existsSync(backup)) fs.copyFileSync(ply, backup);
    cloud.install(workDir, demoDir, demoId, { motionBodyPath: flag('motion-body') });
    console.log(`[multiview] installed refined avatar into ${demoDir} (outputs in ${workDir})`);
}

main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});

import * as path from 'path';
import * as fs from 'fs-extra';
import { execFileSync } from 'child_process';
import { VideoTo4DPerformerPipelineService } from '../packages/core/src/node/spatial/VideoTo4DPerformerPipelineService';

const GCS_SAMPLES = 'gs://scoutscan-multiview-artifacts/samples';

// Motion, body shape, hero frame and texture all come from the performer's source video via GVHMR
// (cached gvhmr_body.json is reused unless --retrack; --mediapipe selects the landmark fallback).
// source: null marks a locally generated clip (see scripts/generate_man_in_black_performer.ts).
const demos: Array<{ id: string; height: number; label: string; source: string | null; fps?: number; durationSec?: number }> = [
    { id: '10331522', height: 1.82, label: 'Lead Vocalist', source: '10331522-uhd_2160_4096_25fps.mp4' },
    { id: '2785536', height: 1.76, label: 'Acoustic Soloist', source: '2785536-uhd_2160_3840_25fps.mp4' },
    { id: '5435720', height: 1.74, label: 'Hip-Hop Dynamic', source: '5435720-uhd_2160_4096_25fps.mp4' },
    { id: '15443888', height: 1.79, label: 'High-Speed Dancer', source: '15443888_1080_1920_100fps.mp4' },
    { id: '5885633', height: 1.72, label: 'Vertical Choreography', source: '5885633-hd_1080_1920_25fps.mp4' },
    { id: 'man-in-black', height: 1.85, label: 'Man in Black (original)', source: null, fps: 24, durationSec: 7.96 }
];

async function ensureSourceVideo(outputDir: string, sourceName: string | null): Promise<string> {
    const local = path.join(outputDir, 'source_video.mp4');
    if (!(await fs.pathExists(local))) {
        if (!sourceName) throw new Error(`${local} missing; generate it first`);
        console.log(`Downloading ${GCS_SAMPLES}/${sourceName} ...`);
        execFileSync('gsutil', ['-q', 'cp', `${GCS_SAMPLES}/${sourceName}`, local], { stdio: 'inherit' });
    }
    return local;
}

async function main() {
    const pipeline = new VideoTo4DPerformerPipelineService();
    const args = process.argv.slice(2);
    const retrack = args.includes('--retrack');
    const useMediapipe = args.includes('--mediapipe');
    const only = args.filter(a => !a.startsWith('--'));
    const results = [];

    for (const demo of demos.filter(d => only.length === 0 || only.includes(d.id))) {
        console.log(`\n=== Performer ${demo.id} (${demo.label}) ===`);
        const outputDir = path.resolve(process.cwd(), 'models/performer_4dgs/demos', demo.id);
        const videoPath = await ensureSourceVideo(outputDir, demo.source);
        const cachedBody = path.join(outputDir, 'gvhmr_body.json');
        const cachedTrack = path.join(outputDir, 'pose_track.json');
        const gvhmrBodyPath = !useMediapipe && !retrack && (await fs.pathExists(cachedBody)) ? cachedBody : undefined;
        const poseTrackPath = useMediapipe && !retrack && (await fs.pathExists(cachedTrack)) ? cachedTrack : undefined;

        const result = await pipeline.executePipeline({
            videoPath,
            motionEstimator: useMediapipe ? 'mediapipe' : 'gvhmr',
            gvhmrBodyPath,
            poseTrackPath,
            characterId: demo.id,
            outputDir,
            targetHeightMeters: demo.height,
            numGaussians: 35000,
            fps: demo.fps ?? 25,
            motionSequenceLengthSec: demo.durationSec
        });

        const summary = {
            id: demo.id,
            label: demo.label,
            frames: result.numFrames,
            motionSource: result.telemetry.motionSource,
            trackedFrames: result.telemetry.trackedFrames,
            cameraSolve: result.telemetry.cameraSolve,
            camera: result.cameraIntrinsics,
            backprojectionIoU: result.telemetry.backprojectionIoU,
            backprojectionGated: result.telemetry.backprojectionGated
        };
        console.log(JSON.stringify(summary, null, 2));
        results.push(summary);
    }

    const summaryPath = path.resolve(process.cwd(), 'models/performer_4dgs/demos/regeneration_summary.json');
    const previous: Array<{ id: string }> = (await fs.pathExists(summaryPath)) ? await fs.readJson(summaryPath).catch(() => []) : [];
    const merged = [...previous.filter(p => !results.some(r => r.id === p.id)), ...results];
    await fs.writeJson(summaryPath, merged, { spaces: 2 });
}

main().catch(err => {
    console.error('Pipeline regeneration failed:', err);
    process.exit(1);
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import {
    VideoTo4DPerformerPipelineService,
    VideoTo4DPerformerOptions
} from '../src/node/spatial/VideoTo4DPerformerPipelineService';

describe('PerformerPipelineRerun', () => {
    let pipeline: VideoTo4DPerformerPipelineService;
    const testOutputDir = path.resolve(process.cwd(), 'tmp/test_performer_rerun');

    beforeEach(async () => {
        pipeline = new VideoTo4DPerformerPipelineService();
        await fs.ensureDir(testOutputDir);
    });

    afterEach(async () => {
        await fs.remove(testOutputDir);
    });

    it('successfully triggers and executes on-demand pipeline rerun with custom parameters', async () => {
        const fixtureHeroPath = path.resolve(process.cwd(), 'public/models/4danyone/demos/10331522/canonical_frame.jpg');
        expect(fs.existsSync(fixtureHeroPath)).toBe(true);

        const customOptions: VideoTo4DPerformerOptions = {
            videoPath: fixtureHeroPath,
            characterId: 'test_rerun_performer',
            outputDir: testOutputDir,
            targetHeightMeters: 1.85,
            numGaussians: 10000,
            fps: 30,
            heroTimestampSec: 0.0,
            exportNerfstudioDataset: true,
            allowSyntheticIdleMotion: true
        };

        const result = await pipeline.executePipeline(customOptions);

        expect(result).toBeDefined();
        expect(result.characterId).toBe('test_rerun_performer');
        expect(result.numGaussians).toBe(10000);
        expect(result.morphology.heightMeters).toBe(1.85);
        expect(result.fps).toBe(30);

        // Verify generated files
        expect(fs.existsSync(result.plyPath)).toBe(true);
        expect(fs.existsSync(result.motionPath)).toBe(true);
        expect(fs.existsSync(result.nerfstudioTransformsPath)).toBe(true);

        // Verify Nerfstudio dataset export
        const nerfTransforms = await fs.readJson(result.nerfstudioTransformsPath);
        expect(nerfTransforms.camera_model).toBe('OPENCV');
        expect(nerfTransforms.frames).toBeDefined();
        expect(nerfTransforms.frames.length).toBeGreaterThan(0);
        expect(nerfTransforms.frames[0].transform_matrix).toBeDefined();

        // Verify morphology ratios
        expect(result.morphology.ratios.headsTall).toBeGreaterThan(6.0);
        expect(result.morphology.solvedBetas.length).toBe(8);

        // Verify stage timings
        expect(result.telemetry.stage1DurationMs).toBeGreaterThanOrEqual(0);
        expect(result.telemetry.stage2DurationMs).toBeGreaterThanOrEqual(0);
        expect(result.telemetry.stage3DurationMs).toBeGreaterThanOrEqual(0);
        expect(result.telemetry.stage4DurationMs).toBeGreaterThanOrEqual(0);
        expect(result.telemetry.stage5DurationMs).toBeGreaterThanOrEqual(0);
        expect(result.telemetry.stage6DurationMs).toBeGreaterThanOrEqual(0);
        expect(result.telemetry.totalDurationMs).toBeGreaterThan(0);
    });
});

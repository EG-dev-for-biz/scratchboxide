import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { VideoTo4DPerformerPipelineService } from '../src/node/spatial/VideoTo4DPerformerPipelineService';
import { REPO_ROOT, requireAssets, withReason } from './helpers/requirements';

// Rebuilds every featured performer from its cached GVHMR SB-Human body into a temp directory.
// The shipped demos are regenerated from source video by scripts/regenerate_5_demos.ts, never by tests.
describe('Regenerate All 5 Demo PLYs', () => {
    const demos = [
        { id: '10331522', height: 1.82 },
        { id: '2785536', height: 1.76 },
        { id: '5435720', height: 1.74 },
        { id: '15443888', height: 1.79 },
        { id: '5885633', height: 1.72 }
    ];

    for (const demo of demos) {
        const demoDir = path.join(REPO_ROOT, 'models/performer_4dgs/demos', demo.id);
        const gvhmrBodyPath = path.join(demoDir, 'gvhmr_body.json');
        const inputs = requireAssets(
            [gvhmrBodyPath, path.join(demoDir, 'canonical_frame.jpg')],
            'scripts/regenerate_5_demos.ts (GVHMR body via scripts/run_gvhmr.py)'
        );
        it.skipIf(!inputs.ok)(withReason(`rebuilds ${demo.id} from its hero frame and GVHMR body`, inputs), async () => {
            expect(fs.existsSync(gvhmrBodyPath)).toBe(true);

            const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), `sbx-regen-${demo.id}-`));
            const heroPath = path.join(outputDir, 'hero.jpg');
            await fs.copy(path.join(demoDir, 'canonical_frame.jpg'), heroPath);

            try {
                const result = await new VideoTo4DPerformerPipelineService().executePipeline({
                    videoPath: heroPath,
                    gvhmrBodyPath,
                    characterId: demo.id,
                    outputDir,
                    targetHeightMeters: demo.height,
                    numGaussians: 35000,
                    exportNerfstudioDataset: false,
                    // Keep the viewport GLB copy out of public/models (it would overwrite the shipped demo surface)
                    viewportModelsDir: outputDir
                });

                expect(result.telemetry.motionSource).toBe('gvhmr');
                expect(result.telemetry.cameraSolve).toBe('gvhmr');
                expect(result.numFrames).toBeGreaterThanOrEqual(100);
                expect(result.telemetry.backprojectionGated).toBe(false);
                expect((await fs.stat(result.plyPath)).size).toBeGreaterThan(3.5 * 1024 * 1024);
            } finally {
                await fs.remove(outputDir);
            }
        }, 120000);
    }
});

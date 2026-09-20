import path from 'path';
import fs from 'fs-extra';
import { generatePanoramaFromImage } from '../packages/core/src/node/spatial/Google360PanoramaPipelineService.js';

async function main() {
    const imagesToProcess = [
        {
            name: 'manhattan_ai',
            input: path.resolve(process.cwd(), 'public/images/manhattan_ai.png'),
            output: path.resolve(process.cwd(), 'public/panoramas/manhattan_sunset_360.png')
        },
        {
            name: 'alpine_ai',
            input: path.resolve(process.cwd(), 'public/images/alpine_ai.png'),
            output: path.resolve(process.cwd(), 'public/panoramas/alpine_ridge_360.png')
        },
        {
            name: 'dubai_ai',
            input: path.resolve(process.cwd(), 'public/images/dubai_ai.png'),
            output: path.resolve(process.cwd(), 'public/panoramas/dubai_marina_360.png')
        },
        {
            name: 'shibuya_ai',
            input: path.resolve(process.cwd(), 'public/images/shibuya_ai.png'),
            output: path.resolve(process.cwd(), 'public/panoramas/shibuya_neon_360.png')
        }
    ];

    await fs.ensureDir(path.resolve(process.cwd(), 'public/panoramas'));

    for (const item of imagesToProcess) {
        if (!fs.existsSync(item.input)) {
            console.warn(`File not found: ${item.input}`);
            continue;
        }

        console.log(`Generating 360 panorama for ${item.name}...`);
        const result = await generatePanoramaFromImage({
            inputImagePath: item.input,
            outputImagePath: item.output,
            width: 2048,
            height: 1024,
            hfovDeg: 92.0,
            infillCeiling: true,
            infillFloor: true,
            healSeam: true,
            mockExecution: true
        });

        console.log(`Generated: ${item.output} (${result.width}x${result.height}, coverage: ${(result.coverageRatio * 100).toFixed(1)}%)`);
    }

    console.log('Batch panorama generation complete.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

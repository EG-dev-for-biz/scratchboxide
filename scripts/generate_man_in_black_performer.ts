import * as path from 'path';
import * as fs from 'fs-extra';
import { execFileSync } from 'child_process';
import { GoogleMediaGenerationService } from '../packages/core/src/node/google-media-generation-service';
import { MediaAssetStore } from '../packages/core/src/node/media-asset-store';
import {
    buildFrameMotivatedPerformerVideoPrompt,
    buildNeutralPerformerPrompt
} from '../packages/core/src/browser/generative-canvas/services/video/omniVideoPromptService';

// Generates an original (fictional) 1960s-style country performer as a Performer 4DGS-ready source clip:
// neutral #808080 studio, flat light, 9:16 head-to-toe, A-pose Frame 0, locked camera, 8 s @ 1080p.
// Usage: GOOGLE_CLOUD_PROJECT=scratchbox-canvas npx vite-node scripts/generate_man_in_black_performer.ts [--image-only] [--reuse-image]

const DEMO_ID = 'man-in-black';

const subject = 'An original, fictional country singer in his mid-thirties (an invented face that does not resemble any real person or celebrity), dark swept-back pompadour hair';
const wardrobe = 'all-black 1960s country stage outfit: black western-cut suit jacket, black button-up shirt, black trousers, black leather cowboy boots; a natural-wood acoustic guitar is worn on his back (the guitar body sits behind his torso and only its headstock pokes up behind his left shoulder), held by a thin brown leather strap running diagonally across the front of his chest; nothing is held in his hands and nothing covers his hips or legs';
const videoMotion = 'After holding the A-pose for half a second, he relaxes into an easy, rhythmic country performance in place: a slow side-to-side two-step sway, tapping his right boot to the beat, snapping the fingers of both hands at hip height, a friendly nod, a gentle quarter-turn to his left and back to face the camera, ending in a relaxed upright stance. Feet stay on the floor within the frame, the whole body from hair to boot soles stays fully visible in every frame, and the guitar stays on his back.';
const likenessGuard = 'likeness of any real person, celebrity lookalike, famous musician';

async function main() {
    const args = process.argv.slice(2);
    const workspaceRoot = process.cwd();
    const outDir = path.resolve(workspaceRoot, 'models/performer_4dgs/demos', DEMO_ID);
    await fs.ensureDir(outDir);
    const service = new GoogleMediaGenerationService(new MediaAssetStore());
    const store = new MediaAssetStore();

    const imagePrompt = buildNeutralPerformerPrompt({ subject, wardrobe, kind: 'image', aspectRatio: '9:16', extraNegativePrompt: likenessGuard });
    const heroPath = path.join(outDir, 'hero_frame.png');
    let heroAsset;
    if (args.includes('--reuse-image') && (await fs.pathExists(heroPath))) {
        heroAsset = await store.put(workspaceRoot, await fs.readFile(heroPath), 'image/png');
    } else {
        console.log('Generating hero frame ...');
        const image = await service.generateImage({
            kind: 'image',
            prompt: imagePrompt.prompt,
            negativePrompt: imagePrompt.negativePrompt,
            aspectRatio: '9:16',
            workspaceRoot,
            idempotencyKey: `${DEMO_ID}-hero-${Date.now()}`,
            modelPriority: ['gemini-2.5-flash-image']
        });
        heroAsset = image.asset;
        await fs.copy(store.resolve(workspaceRoot, image.asset), heroPath);
        console.log(`Hero frame (${image.modelUsed}) -> ${heroPath}`);
    }
    if (args.includes('--image-only')) return;

    const videoPrompt = buildFrameMotivatedPerformerVideoPrompt({
        subject,
        wardrobe,
        heroPoseType: 'a-pose',
        videoModelBackbone: 'Veo3.1',
        videoMotion,
        extraNegativePrompt: likenessGuard
    });
    // Veo receives Frame 0 as the conditioning image; the Omni media tags have no meaning to it.
    const veoPrompt = videoPrompt.prompt
        .replace(/<FIRST_FRAME><IMAGE_REF_0><\/FIRST_FRAME>/g, 'the provided first frame')
        .replace(/^the provided first frame\s*/, '');

    console.log('Generating performance video (Veo, 8 s, 9:16, 1080p) ...');
    const video = await service.generateVideo({
        kind: 'video',
        prompt: veoPrompt,
        negativePrompt: videoPrompt.negativePrompt.replace(/, motion blur|, dynamic action pose/g, ''),
        aspectRatio: '9:16',
        durationSeconds: 8,
        resolution: '1080p',
        generateAudio: false,
        sourceAsset: heroAsset,
        workspaceRoot,
        idempotencyKey: `${DEMO_ID}-video-${Date.now()}`,
        modelPriority: ['veo-3.1-generate-001', 'veo-3.1-generate-preview']
    }, stage => console.log(`  ${stage} ...`));

    const videoPath = path.join(outDir, 'source_video.mp4');
    await fs.copy(store.resolve(workspaceRoot, video.asset), videoPath);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
        '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames', '-of', 'json', videoPath]).toString();
    await fs.writeJson(path.join(outDir, 'generation.json'), {
        demoId: DEMO_ID,
        fictional: true,
        imagePrompt,
        videoPrompt: { ...videoPrompt, prompt: veoPrompt },
        videoModel: video.modelUsed,
        stream: JSON.parse(probe).streams?.[0],
        createdAt: new Date().toISOString()
    }, { spaces: 2 });
    console.log(`Video (${video.modelUsed}) -> ${videoPath}\n${probe}`);
}

main().catch(err => {
    console.error('Performer generation failed:', err);
    process.exit(1);
});

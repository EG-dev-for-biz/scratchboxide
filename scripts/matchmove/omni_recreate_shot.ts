/**
 * Recreates a matched camera move as a 2D video with Omni: the source clip's first and last frames pin the
 * opening and closing composition, and the tile blockout rendered along the solved path drives the camera.
 * People and vehicles are removed from the pinned frames with the Street View restyle so the streets stay empty.
 *
 * Usage (from the repo root):
 *   npx vite-node scripts/matchmove/omni_recreate_shot.ts -- --dir .scratchbox/matchmove/eloise_plaza --phase clean
 *   npx vite-node scripts/matchmove/omni_recreate_shot.ts -- --dir .scratchbox/matchmove/eloise_plaza --phase omni
 * Credentials: GOOGLE_SERVICE_ACCOUNT_JSON from .env (Vertex AI project that has Omni access).
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GoogleGenAI } from '@google/genai';
import { GoogleAuth } from 'google-auth-library';
import { StreetViewRestyleService, compositeWithinRegions, removedObjectRegions, type PixelRegion } from '../../packages/core/src/node/spatial/StreetViewRestyleService';
import { GeminiMultimodalObjectDetectorService } from '../../packages/core/src/node/spatial/GeminiMultimodalObjectDetectorService';
import { OmniVideoService, buildBlockoutFirstLastPrompt } from '../../packages/core/src/node/video/OmniVideoService';
import { decodePng, encodePng } from '../../packages/core/src/node/texture-processing';

const DETECT_PROMPT = 'Detect every person and every vehicle (cars, taxis, trucks, buses, vans, motorcycles, bicycles) in this image, including partially visible ones and their shadows. Return a clean JSON object with schema: { "objects": [ { "label": string, "category": "person" | "vehicle", "box_2d": [ymin, xmin, ymax, xmax] } ] }. Coordinates must be integers from 0 to 1000. Return { "objects": [] } if there are none. Output ONLY valid JSON.';

const SHOT = 'A slow descending crane shot. The camera starts looking up at the roofline and corner turret, pedestals down the facade while tilting down past the balconies and arched windows, glides over the entrance canopy, and finishes in a top-down bird\'s-eye view of the street.';

function arg(name: string, fallback?: string): string {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
}

function loadEnv(file: string): void {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (!m || process.env[m[1]] !== undefined) continue;
        let value = m[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        process.env[m[1]] = value;
    }
}

function serviceAccount(): { credentials: any; project: string } {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set (.env).');
    const credentials = JSON.parse(raw.replace(/\\\\"/g, '"'));
    credentials.private_key = String(credentials.private_key ?? '').replace(/\\n/g, '\n');
    return { credentials, project: credentials.project_id };
}

function ffmpeg(args: string[]): void {
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
}

async function main() {
    loadEnv(path.resolve('.env'));
    const dir = path.resolve(arg('dir'));
    const phase = arg('phase', 'all');
    const firstIndex = Number(arg('first', '1'));
    const lastIndex = Number(arg('last', '240'));
    const out = path.join(dir, 'omni');
    fs.mkdirSync(out, { recursive: true });
    const { credentials, project } = serviceAccount();
    const frame = (n: number) => path.join(dir, 'frames', `${String(n).padStart(4, '0')}.jpg`);
    const firstPath = path.join(out, 'first_frame.jpg');
    const lastPath = path.join(out, 'last_frame_clean.png');

    if (phase === 'clean' || phase === 'all') {
        fs.copyFileSync(frame(firstIndex), firstPath);
        const existing = ['png', 'jpg'].map(ext => path.join(out, `last_frame_clean_model.${ext}`)).find(p => fs.existsSync(p));
        let modelOut = process.argv.includes('--reuse-clean') ? existing : undefined;
        let restyleMeta: Record<string, unknown> = { reused: modelOut };
        if (!modelOut) {
            const client = new GoogleGenAI({ vertexai: true, project, location: 'global', googleAuthOptions: { credentials, projectId: project } });
            const result = await new StreetViewRestyleService({ client })
                .restyle({ image: fs.readFileSync(frame(lastIndex)), mimeType: 'image/jpeg', aspectRatio: '16:9' });
            modelOut = path.join(out, `last_frame_clean_model.${result.mimeType.includes('png') ? 'png' : 'jpg'}`);
            fs.writeFileSync(modelOut, result.image);
            restyleMeta = { model: result.model, prompt: result.prompt };
        }

        // The restyle redraws more than the people and cars (it can invent sidewalks or drop the chalk), so only
        // the detected objects' regions are taken from it; the rest of the pinned frame stays the source pixels.
        const originalPng = path.join(out, 'last_frame_source.png');
        const cleanedPng = path.join(out, 'last_frame_clean_model_1080.png');
        ffmpeg(['-i', frame(lastIndex), originalPng]);
        ffmpeg(['-i', modelOut, '-vf', 'scale=1920:1080:flags=lanczos', cleanedPng]);
        const original = decodePng(fs.readFileSync(originalPng));
        const cleaned = decodePng(fs.readFileSync(cleanedPng));
        const detection = await GeminiMultimodalObjectDetectorService.detectObjectsFromImage(frame(lastIndex), { project, customPrompt: DETECT_PROMPT });
        if (!detection.success) throw new Error(`Detection failed: ${detection.error}`);
        const boxes: PixelRegion[] = detection.objects
            .map(o => {
                const [ymin, xmin, ymax, xmax] = o.box2d.map(v => v / 1000);
                return { x0: xmin * original.width, y0: ymin * original.height, x1: xmax * original.width, y1: ymax * original.height };
            })
            .filter(r => (r.x1 - r.x0) * (r.y1 - r.y0) < 0.25 * original.width * original.height);
        const regions = removedObjectRegions(original, cleaned, boxes, { threshold: 40, blockPx: 8, marginPx: 28 });
        if (boxes.length && !regions.length) {
            throw new Error(`Detected ${boxes.length} object(s) in frame ${lastIndex} but the restyle did not remove them.`);
        }
        const composite = compositeWithinRegions(original, cleaned, regions, { featherPx: 24, searchPx: 16, ringPx: 24 });
        fs.writeFileSync(lastPath, encodePng(original.width, original.height, composite));
        fs.writeFileSync(path.join(out, 'clean.json'), JSON.stringify({
            sourceFrame: lastIndex, restyle: restyleMeta, detections: detection.objects, detectionBoxes: boxes, regions
        }, null, 2));
        console.log(`frame ${lastIndex}: ${detection.objects.length} object(s) detected, ${regions.length} region(s) replaced -> ${lastPath}`);
    }

    if (phase === 'omni' || phase === 'all') {
        if (!fs.existsSync(lastPath)) throw new Error(`Run --phase clean first (${lastPath} is missing).`);
        const blockoutPath = path.join(out, 'blockout.mp4');
        ffmpeg(['-i', path.join(dir, 'recreation', 'recreated.mp4'), '-an', '-vf', 'scale=1280:720', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', blockoutPath]);
        const prompt = buildBlockoutFirstLastPrompt({ shot: SHOT, emptyStreets: true });
        fs.writeFileSync(path.join(out, 'prompt.txt'), prompt);
        const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const omni = new OmniVideoService({
            project,
            getAccessToken: async () => (await auth.getAccessToken()) ?? '',
            pollIntervalMs: 10000
        });
        console.log('submitting to Omni...');
        const result = await omni.generate({
            prompt,
            firstFrame: { data: fs.readFileSync(firstPath), mimeType: 'image/jpeg' },
            lastFrame: { data: fs.readFileSync(lastPath), mimeType: 'image/png' },
            blockoutVideo: { data: fs.readFileSync(blockoutPath), mimeType: 'video/mp4' }
        });
        const videoPath = path.join(out, 'omni_recreation.mp4');
        fs.writeFileSync(videoPath, result.video);
        fs.writeFileSync(path.join(out, 'interaction.json'), JSON.stringify({
            interactionId: result.interactionId, model: result.model, elapsedMs: result.elapsedMs, mimeType: result.mimeType,
            firstFrame: firstIndex, lastFrame: lastIndex, blockout: 'recreation/recreated.mp4'
        }, null, 2));
        console.log(`Omni video (${(result.elapsedMs / 1000).toFixed(0)} s) -> ${videoPath}`);
    }

    if (phase === 'verify') {
        // Empty-street check: people and vehicles detected in sampled frames of the Omni output.
        const videoPath = path.join(out, 'omni_recreation.mp4');
        const sampleDir = path.join(out, 'verify_frames');
        fs.mkdirSync(sampleDir, { recursive: true });
        const frames = [1, 25, 49, 73, 97, 121, 145, 169, 193, 217, 240];
        const results: Array<{ frame: number; objects: unknown[] }> = [];
        for (const f of frames) {
            const png = path.join(sampleDir, `${String(f).padStart(4, '0')}.png`);
            ffmpeg(['-i', videoPath, '-vf', `select=eq(n\\,${f - 1})`, '-frames:v', '1', png]);
            const detection = await GeminiMultimodalObjectDetectorService.detectObjectsFromImage(png, { project, customPrompt: DETECT_PROMPT });
            if (!detection.success) throw new Error(`Detection failed on frame ${f}: ${detection.error}`);
            results.push({ frame: f, objects: detection.objects });
            console.log(`frame ${f}: ${detection.objects.length} person/vehicle detection(s)`);
        }
        const total = results.reduce((s, r) => s + r.objects.length, 0);
        fs.writeFileSync(path.join(out, 'verify.json'), JSON.stringify({ sampledFrames: frames, detectionsTotal: total, frames: results }, null, 2));
    }
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});

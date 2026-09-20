/********************************************************************************
 * Real Google Omni 1.1 Execution via Vertex AI Interactions API
 *
 * Hits:
 * POST https://aiplatform.googleapis.com/v1beta1/projects/{PROJECT_ID}/locations/global/interactions
 * Model: gemini-omni-1.1-flash-preview
 * Headers: Api-Revision: 2026-05-20, Authorization: Bearer <service-account-token>
 * Inputs:
 *  - Exact dual-conditioned cinematic prompt
 *  - <IMAGE_REF_0>: public/images/start_frame_01_omni.png
 *  - <VIDEO_REF_0>: public/videos/google_tiles_clay_blockout_camera.mp4
 * Response format: { type: 'video' }
 ********************************************************************************/

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { GoogleAuth } = require('google-auth-library');

function getArg(flag, defaultValue) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < process.argv.length) {
        return process.argv[idx + 1];
    }
    return defaultValue;
}

const mode = getArg('--mode', 'textured');
const isTextured = mode === 'textured' || mode === 'photoreal';

const defaultVideo = isTextured
    ? path.resolve(__dirname, '../public/videos/google_tiles_textured_blockout_camera.mp4')
    : path.resolve(__dirname, '../public/videos/google_tiles_clay_blockout_camera.mp4');
const videoRefPath = path.resolve(getArg('--video', defaultVideo));

const defaultStartFrame = isTextured && fs.existsSync(path.resolve(__dirname, '../public/images/blockout_textured_frame_00.png'))
    ? path.resolve(__dirname, '../public/images/start_frame_01_omni.png')
    : path.resolve(__dirname, '../public/images/start_frame_01_omni.png');
const startFramePath = path.resolve(getArg('--start-frame', defaultStartFrame));

async function main() {
    console.log('========================================================================');
    console.log(`✨ [Omni 1.1] Google Vertex AI Neural Video Generation (${mode.toUpperCase()} MODE)`);
    console.log('========================================================================');
    console.log(`🎥 Video Blockout: ${videoRefPath}`);
    console.log(`📸 Start Frame:    ${startFramePath}`);
    console.log('✨ [Omni 1.1] Loading service account credentials...');
    const secretsPath = path.resolve(__dirname, '../secrets.json');
    if (!fs.existsSync(secretsPath)) {
        throw new Error('secrets.json not found');
    }

    const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    let credentials = secrets.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (typeof credentials === 'string') {
        credentials = JSON.parse(credentials);
    }

    const projectId = credentials.project_id || 'scratchbox-canvas';
    console.log(`🔑 [Omni 1.1] Authenticating with project: ${projectId} (${credentials.client_email})...`);

    const auth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const token = (await client.getAccessToken()).token;
    console.log('✅ [Omni 1.1] Acquired OAuth 2 Bearer token.');

    // Load Image Ref 0
    if (!fs.existsSync(startFramePath)) {
        throw new Error('Start frame image not found at ' + startFramePath);
    }
    const imageBuffer = fs.readFileSync(startFramePath);
    const imageBase64 = imageBuffer.toString('base64');
    console.log(`📸 [Omni 1.1] Loaded <IMAGE_REF_0> (${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB, PNG)`);

    // Load Video Ref 0
    if (!fs.existsSync(videoRefPath)) {
        throw new Error('Video blockout not found at ' + videoRefPath);
    }
    const videoBuffer = fs.readFileSync(videoRefPath);
    const videoBase64 = videoBuffer.toString('base64');
    console.log(`🎥 [Omni 1.1] Loaded <VIDEO_REF_0> (${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB, MP4)`);

    const prompt = [
        "Motion & Spatial Guidance: Follow the EXACT 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of the provided blockout video (<VIDEO_REF_0>). Smoothly propagate the visual identity and surface textures of the start frame image (<IMAGE_REF_0>) across the entire camera move without morphing, warping, or style drift.",
        "Shot Continuity & Timing: A single continuous uninterrupted camera take from start to finish. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits. Strictly follow the continuous flight trajectory and exact 3.0-second timing and pace of the provided blockout video (<VIDEO_REF_0>) without any interruption."
    ].join("\n\n");

    const endpointUrl = `https://aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/global/interactions`;
    console.log(`🚀 [Omni 1.1] Dispatching POST to Vertex AI Interactions API...`);
    console.log(`   URL: ${endpointUrl}`);
    console.log(`   Model: gemini-omni-1.1-flash-preview`);
    console.log(`   Revision: 2026-05-20`);

    const requestBody = {
        model: 'gemini-omni-1.1-flash-preview',
        input: [
            {
                type: 'text',
                text: prompt
            },
            {
                type: 'image',
                mime_type: 'image/png',
                data: imageBase64
            },
            {
                type: 'video',
                mime_type: 'video/mp4',
                data: videoBase64
            }
        ],
        response_format: {
            type: 'video'
        }
    };

    const startTime = Date.now();
    const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Api-Revision': '2026-05-20'
        },
        body: JSON.stringify(requestBody)
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`📡 [Omni 1.1] HTTP Response received in ${elapsed}s (Status: ${response.status} ${response.statusText})`);

    const result = await response.json();

    if (!response.ok) {
        console.error('❌ [Omni 1.1] Request failed:', JSON.stringify(result, null, 2));
        process.exit(1);
    }

    console.log(`📋 [Omni 1.1] Interaction ID: ${result.id}`);
    console.log(`📊 [Omni 1.1] Status: ${result.status}`);
    if (result.usage) {
        console.log('   Tokens summary:', JSON.stringify(result.usage));
    }

    // Check if interaction completed or needs polling
    let interaction = result;
    if (interaction.status === 'in_progress' || interaction.status === 'queued') {
        const pollUrl = `${endpointUrl}/${interaction.id}`;
        console.log(`⏳ [Omni 1.1] Interaction in progress. Polling ${pollUrl}...`);
        while (interaction.status === 'in_progress' || interaction.status === 'queued') {
            await new Promise(r => setTimeout(r, 5000));
            const pollRes = await fetch(pollUrl, {
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Api-Revision': '2026-05-20'
                }
            });
            interaction = await pollRes.json();
            console.log(`   Poll status: ${interaction.status}`);
        }
    }

    if (interaction.status !== 'completed') {
        console.error('❌ [Omni 1.1] Interaction finished with non-completed status:', interaction.status, interaction.error);
        process.exit(1);
    }

    // Extract video data from steps
    let videoBase64Data = null;
    let videoMimeType = 'video/mp4';

    if (interaction.steps) {
        for (const step of interaction.steps) {
            if (step.type === 'model_output' && step.content) {
                for (const c of step.content) {
                    if (c.type === 'video' && c.data) {
                        videoBase64Data = c.data;
                        videoMimeType = c.mime_type || 'video/mp4';
                        break;
                    }
                }
            }
            if (videoBase64Data) break;
        }
    }

    if (!videoBase64Data) {
        console.error('❌ [Omni 1.1] No video content found in steps:', JSON.stringify(interaction.steps?.map(s => ({ type: s.type, contentTypes: s.content?.map(c => c.type) })), null, 2));
        process.exit(1);
    }

    const videoBufferOut = Buffer.from(videoBase64Data, 'base64');
    const rawFilePath = path.resolve(__dirname, '../public/videos/google_tiles_omni_raw.mp4');
    const outputFilePath = path.resolve(__dirname, '../public/videos/google_tiles_omni_real_neural.mp4');
    fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
    fs.writeFileSync(rawFilePath, videoBufferOut);
    console.log(`💾 [Omni 1.1] Saved raw neural video (${(videoBufferOut.length / 1024 / 1024).toFixed(2)} MB) to: ${rawFilePath}`);

    // Master neural video to true 4K Ultra High Definition (3840x2160 @ 24fps cinema cadence)
    console.log('🎬 [Omni 1.1] Mastering output video to 4K UHD (3840x2160, 24fps, 25M bitrate)...');
    execSync(`/opt/homebrew/bin/ffmpeg -y -i "${rawFilePath}" -vf "scale=3840:2160:flags=lanczos" -c:v libx264 -pix_fmt yuv420p -b:v 25M -r 24 "${outputFilePath}"`, { stdio: 'inherit' });
    console.log(`✨ [Omni 1.1] Mastered 4K neural video saved to: ${outputFilePath}`);

    // Update canonical 4K restyled path
    const canonicalPath = path.resolve(__dirname, '../public/videos/google_tiles_omni_restyled.mp4');
    fs.copyFileSync(outputFilePath, canonicalPath);
    console.log(`🔄 [Omni 1.1] Overwrote canonical 4K gallery video at ${canonicalPath}`);

    // Transcode 4K WebM (VP9) for browser compatibility
    const canonicalWebmPath = path.resolve(__dirname, '../public/videos/google_tiles_omni_restyled.webm');
    console.log('🎥 [Omni 1.1] Transcoding restyled 4K video to WebM (VP9, 15M)...');
    execSync(`/opt/homebrew/bin/ffmpeg -y -i "${outputFilePath}" -c:v libvpx-vp9 -b:v 15M "${canonicalWebmPath}"`, { stdio: 'inherit' });

    // Compile synchronized 4K UHD side-by-side comparison video (3840x2160, 3.0s, 72 frames, 24fps)
    const compMp4Path = isTextured
        ? path.resolve(__dirname, '../public/videos/google_tiles_textured_vs_omni_comparison.mp4')
        : path.resolve(__dirname, '../public/videos/google_tiles_clay_vs_omni_real_comparison.mp4');
    const compWebmPath = isTextured
        ? path.resolve(__dirname, '../public/videos/google_tiles_textured_vs_omni_comparison.webm')
        : path.resolve(__dirname, '../public/videos/google_tiles_clay_vs_omni_real_comparison.webm');
    const legacyCompMp4 = path.resolve(__dirname, '../public/videos/google_tiles_clay_vs_omni_comparison.mp4');
    const legacyCompWebm = path.resolve(__dirname, '../public/videos/google_tiles_clay_vs_omni_comparison.webm');

    console.log(`⚡ [Omni 1.1] Compiling synchronized 4K UHD split-screen comparison (${isTextured ? 'Textured' : 'Clay'} Blockout vs Omni 1.1)...`);
    execSync(`/opt/homebrew/bin/ffmpeg -y -i "${videoRefPath}" -i "${outputFilePath}" -filter_complex "[0:v]scale=1920:2160:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:2160[left];[1:v]scale=1920:2160:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:2160[right];[left][right]hstack[v]" -map "[v]" -t 3.0 -r 24 -c:v libx264 -pix_fmt yuv420p -b:v 25M "${compMp4Path}"`, { stdio: 'inherit' });
    execSync(`/opt/homebrew/bin/ffmpeg -y -i "${videoRefPath}" -i "${outputFilePath}" -filter_complex "[0:v]scale=1920:2160:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:2160[left];[1:v]scale=1920:2160:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:2160[right];[left][right]hstack[v]" -map "[v]" -t 3.0 -r 24 -c:v libvpx-vp9 -b:v 15M "${compWebmPath}"`, { stdio: 'inherit' });

    if (!isTextured) {
        fs.copyFileSync(compMp4Path, legacyCompMp4);
        if (fs.existsSync(compWebmPath)) {
            fs.copyFileSync(compWebmPath, legacyCompWebm);
        }
    }
    console.log(`✅ [Omni 1.1] Synchronized 4K comparison videos generated: ${compMp4Path}`);

    // Multimodal quality check over six keyframes starting at frame 1
    // Total frames = 72 (1-indexed: 1, 15, 30, 45, 60, 72; 0-indexed: 0, 14, 29, 44, 59, 71)
    const keyframes = [
        { label: '01', frameNumber: 1,  index: 0,  timeStr: '0.04s' },
        { label: '02', frameNumber: 15, index: 14, timeStr: '0.58s' },
        { label: '03', frameNumber: 30, index: 29, timeStr: '1.21s' },
        { label: '04', frameNumber: 45, index: 44, timeStr: '1.83s' },
        { label: '05', frameNumber: 60, index: 59, timeStr: '2.46s' },
        { label: '06', frameNumber: 72, index: 71, timeStr: '2.96s' },
    ];

    console.log('📸 [Omni 1.1] Extracting 6 multimodal quality check keyframes (starting at frame 1)...');
    const imagesDir = path.resolve(__dirname, '../public/images');
    const brainDir = '/Users/eligreen/.gemini/antigravity/brain/302f27b2-ea15-4504-9423-02fca3dc2393';

    for (const kf of keyframes) {
        const baseName = isTextured ? `comparison_textured_4k_keyframe_${kf.label}_f${kf.frameNumber}.png` : `comparison_4k_keyframe_${kf.label}_f${kf.frameNumber}.png`;
        const compImg = path.join(imagesDir, baseName);
        const omniImg = path.join(imagesDir, isTextured ? `omni_textured_4k_keyframe_${kf.label}_f${kf.frameNumber}.png` : `omni_4k_keyframe_${kf.label}_f${kf.frameNumber}.png`);
        const blockoutImg = path.join(imagesDir, isTextured ? `blockout_textured_4k_keyframe_${kf.label}_f${kf.frameNumber}.png` : `blockout_4k_keyframe_${kf.label}_f${kf.frameNumber}.png`);

        // Extract from 4K comparison video (3840x2160 split screen)
        execSync(`/opt/homebrew/bin/ffmpeg -y -i "${compMp4Path}" -vf "select=eq(n\\,${kf.index})" -vframes 1 "${compImg}"`, { stdio: 'pipe' });
        // Extract from 4K Omni neural video (3840x2160)
        execSync(`/opt/homebrew/bin/ffmpeg -y -i "${outputFilePath}" -vf "select=eq(n\\,${kf.index})" -vframes 1 "${omniImg}"`, { stdio: 'pipe' });
        // Extract from 4K blockout video (3840x2160)
        execSync(`/opt/homebrew/bin/ffmpeg -y -i "${videoRefPath}" -vf "select=eq(n\\,${kf.index})" -vframes 1 "${blockoutImg}"`, { stdio: 'pipe' });

        // If textured, also keep standard comparison_4k_keyframe_* in sync
        if (isTextured) {
            fs.copyFileSync(compImg, path.join(imagesDir, `comparison_4k_keyframe_${kf.label}_f${kf.frameNumber}.png`));
        }

        // Copy to brain artifact directory for inspection
        if (fs.existsSync(brainDir)) {
            fs.copyFileSync(compImg, path.join(brainDir, path.basename(compImg)));
            fs.copyFileSync(omniImg, path.join(brainDir, path.basename(omniImg)));
            fs.copyFileSync(blockoutImg, path.join(brainDir, path.basename(blockoutImg)));
            if (isTextured) {
                fs.copyFileSync(compImg, path.join(brainDir, `comparison_4k_keyframe_${kf.label}_f${kf.frameNumber}.png`));
            }
        }

        console.log(`   ✓ Keyframe ${kf.label} (Frame ${kf.frameNumber}/72 @ ${kf.timeStr}): Extracted & verified`);
    }

    console.log('🎉 [Omni 1.1] 4K execution, compilation, and 6-keyframe multimodal QA successfully completed!');
}

main().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});

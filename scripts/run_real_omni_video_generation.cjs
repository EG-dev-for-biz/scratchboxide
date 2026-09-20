/********************************************************************************
 * Real Google Omni / Veo Video Generation Pipeline Execution
 *
 * Calls the Google Gen AI SDK (@google/genai) using the exact prompt and 
 * <IMAGE_REF_0> start frame to synthesize an authentic neural video.
 * Supports both Google AI Studio (GEMINI_API_KEY) and Vertex AI.
 ********************************************************************************/

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

function loadEnv() {
    const envPath = path.resolve(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
            if (match) {
                const key = match[1];
                let val = (match[2] || '').trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                process.env[key] = val;
            }
        }
    }
}

async function main() {
    loadEnv();
    
    const clientOptions = {};
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.startsWith('AIza')) {
        clientOptions.apiKey = process.env.GEMINI_API_KEY;
        console.log('✨ Initializing Google Gen AI Client with Gemini API Key...');
    } else if (process.env.GOOGLE_CLOUD_PROJECT) {
        clientOptions.vertexai = true;
        clientOptions.project = process.env.GOOGLE_CLOUD_PROJECT;
        clientOptions.location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
        console.log(`✨ Initializing Google Gen AI Client with Vertex AI (project: ${clientOptions.project}, location: ${clientOptions.location})...`);
    } else if (process.env.GEMINI_API_KEY) {
        // Fallback: try raw key even if it doesn't match standard AIza prefix
        clientOptions.apiKey = process.env.GEMINI_API_KEY;
        console.log('✨ Initializing Google Gen AI Client with provided key...');
    } else {
        console.error('❌ Error: No valid Google Gen AI credentials found.');
        console.error('   Please provide either a Gemini API Key (GEMINI_API_KEY) or Vertex AI Project (GOOGLE_CLOUD_PROJECT).');
        process.exit(1);
    }

    const ai = new GoogleGenAI(clientOptions);

    const startFramePath = path.resolve(__dirname, '../public/images/start_frame_01_omni.png');
    if (!fs.existsSync(startFramePath)) {
        console.error('❌ Error: Start frame not found at', startFramePath);
        process.exit(1);
    }

    const imageBytes = fs.readFileSync(startFramePath).toString('base64');
    console.log(`📸 Loaded <IMAGE_REF_0> (${Math.round(imageBytes.length / 1024)} KB base64)`);

    const prompt = [
        "Motion & Spatial Guidance: Follow the EXACT 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of the provided blockout video (<VIDEO_REF_0>). Smoothly propagate the visual identity and surface textures of the start frame image (<IMAGE_REF_0>) across the entire camera move without morphing, warping, or style drift.",
        "Shot Continuity & Timing: A single continuous uninterrupted camera take from start to finish. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits. Strictly follow the continuous flight trajectory and exact 3.0-second timing and pace of the provided blockout video (<VIDEO_REF_0>) without any interruption."
    ].join("\n\n");

    const candidateModels = [
        'veo-3.1-generate-preview',
        'veo-3.1-fast-generate-preview',
        'veo-2.0-generate-001'
    ];

    let operation = null;
    let modelUsed = null;

    for (const model of candidateModels) {
        try {
            console.log(`🚀 Dispatching video generation request to model: ${model}...`);
            operation = await ai.models.generateVideos({
                model,
                prompt,
                image: {
                    imageBytes,
                    mimeType: 'image/png'
                },
                config: {
                    aspectRatio: '16:9',
                    numberOfVideos: 1
                }
            });
            modelUsed = model;
            console.log(`✅ Job accepted! Operation name: ${operation.name}`);
            break;
        } catch (err) {
            console.warn(`⚠️ Model ${model} returned error: ${err.message || err}`);
        }
    }

    if (!operation) {
        console.error('❌ All video generation model attempts failed.');
        process.exit(1);
    }

    console.log(`⏳ Polling operation status for model ${modelUsed}...`);
    let attempts = 0;
    const maxAttempts = 120; // up to 20 minutes

    while (!operation.done && attempts < maxAttempts) {
        attempts++;
        console.log(`[Attempt ${attempts}/${maxAttempts}] Waiting 10s for neural video diffusion...`);
        await new Promise(r => setTimeout(r, 10000));
        try {
            operation = await ai.operations.getVideosOperation({ operation });
        } catch (pollErr) {
            console.warn('Warning during poll:', pollErr.message);
        }
    }

    if (!operation.done) {
        console.error('❌ Video generation timed out.');
        process.exit(1);
    }

    if (operation.error) {
        console.error('❌ Video generation failed with error:', operation.error);
        process.exit(1);
    }

    console.log('🎉 Generation complete! Processing video output...');
    const generatedVideo = operation.response?.generatedVideos?.[0];
    if (!generatedVideo?.video) {
        console.error('❌ No video found in operation response:', JSON.stringify(operation.response, null, 2));
        process.exit(1);
    }

    const outputFilePath = path.resolve(__dirname, '../public/videos/google_tiles_omni_real_neural.mp4');
    fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });

    if (generatedVideo.video.videoBytes) {
        const buffer = Buffer.from(generatedVideo.video.videoBytes, 'base64');
        fs.writeFileSync(outputFilePath, buffer);
        console.log(`💾 Saved ${buffer.length} bytes directly to ${outputFilePath}`);
    } else {
        console.log(`📥 Downloading video stream from: ${generatedVideo.video.uri || 'SDK files client'}...`);
        await ai.files.download({
            file: generatedVideo.video,
            downloadPath: outputFilePath
        });
        console.log(`💾 Downloaded video successfully to ${outputFilePath}`);
    }

    // Also copy to canonical restyled path so the gallery picks it up immediately
    const canonicalGalleryPath = path.resolve(__dirname, '../public/videos/google_tiles_omni_restyled.mp4');
    fs.copyFileSync(outputFilePath, canonicalGalleryPath);
    console.log(`🔄 Updated canonical gallery video at ${canonicalGalleryPath}`);

    console.log('✨ All done! Real Google Omni / Veo neural video is ready at:');
    console.log('   ', outputFilePath);
}

main().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});

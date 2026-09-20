const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

async function restoreCheckpoint() {
    console.log('🔄 [Restore] Loading credentials...');
    const secretsPath = path.resolve(__dirname, '../secrets.json');
    const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    let credentials = secrets.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (typeof credentials === 'string') credentials = JSON.parse(credentials);

    const projectId = credentials.project_id || 'scratchbox-canvas';
    const auth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const token = (await client.getAccessToken()).token;
    console.log('✅ [Restore] Acquired Bearer token.');

    const interactionId = 'ChA1ZDc0YzQ1ZTUyODVlNDkyEAgaATAqBG1haW4';
    const url = `https://aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/global/interactions/${interactionId}`;
    console.log(`📡 [Restore] Fetching interaction ${interactionId} from ${url}...`);

    const res = await fetch(url, {
        headers: {
            'Authorization': 'Bearer ' + token,
            'Api-Revision': '2026-05-20'
        }
    });

    if (!res.ok) {
        console.error('❌ [Restore] Fetch failed:', res.status, await res.text());
        process.exit(1);
    }

    const interaction = await res.json();
    console.log(`📋 [Restore] Status: ${interaction.status}`);

    let videoBase64 = null;
    if (interaction.steps) {
        for (const step of interaction.steps) {
            if (step.type === 'model_output' && step.content) {
                for (const c of step.content) {
                    if (c.type === 'video' && c.data) {
                        videoBase64 = c.data;
                        break;
                    }
                }
            }
            if (videoBase64) break;
        }
    }

    if (!videoBase64) {
        console.error('❌ [Restore] No video data in interaction response');
        process.exit(1);
    }

    const videoBuffer = Buffer.from(videoBase64, 'base64');
    const targetPath1 = path.resolve(__dirname, '../public/videos/google_tiles_omni_real_neural.mp4');
    const targetPath2 = path.resolve(__dirname, '../public/videos/google_tiles_omni_restyled.mp4');

    fs.writeFileSync(targetPath1, videoBuffer);
    fs.writeFileSync(targetPath2, videoBuffer);
    console.log(`💾 [Restore] Restored authentic neural video (${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB) to:`);
    console.log(`   ${targetPath1}`);
    console.log(`   ${targetPath2}`);

    // Restore conditioning image
    const sourceCleanImg = '/Users/eligreen/.gemini/antigravity/brain/302f27b2-ea15-4504-9423-02fca3dc2393/start_frame_clean_1789670978242.png';
    const destImg1 = path.resolve(__dirname, '../public/images/start_frame_01_omni.png');
    const destImg2 = path.resolve(__dirname, '../public/models/frame_01_restyle.png');
    if (fs.existsSync(sourceCleanImg)) {
        fs.copyFileSync(sourceCleanImg, destImg1);
        fs.copyFileSync(sourceCleanImg, destImg2);
        console.log(`📸 [Restore] Restored start frame image to ${destImg1} and ${destImg2}`);
    } else {
        console.warn(`⚠️ Source clean image not found at ${sourceCleanImg}`);
    }

    console.log('🎉 [Restore] Checkpoint restoration complete!');
}

restoreCheckpoint().catch(err => {
    console.error('Fatal restore error:', err);
    process.exit(1);
});

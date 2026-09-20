const path = require('path');
const fs = require('fs');

async function main() {
    console.log('Testing Colosseum 3D tile capture...');
    const { getGoogle3DTilesFullTexture } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');

    const anchor = {
        lat: 41.890210,
        lng: 12.492230,
        elevation: 25.0,
        landmarkName: 'Colosseum, Rome, Italy'
    };

    const outputGlbPath = path.join(process.cwd(), 'public/models/colosseum_rome_textured.glb');

    // Create a 16-frame full 360-degree orbit around the Colosseum with wide FOV
    const fps = 4;
    const durationSec = 4.0;
    const totalFrames = 16;
    const frames = [];
    const radius = 195.0; // Encompassing full Colosseum diameter
    const camY = 75.0; // Elevated orbital perspective looking down into arena

    for (let i = 0; i < totalFrames; i++) {
        const theta = (i / totalFrames) * 2 * Math.PI;
        const posX = Math.sin(theta) * radius;
        const posZ = Math.cos(theta) * radius;
        frames.push({
            frame: i,
            timeSec: Number((i / fps).toFixed(3)),
            position: [Number(posX.toFixed(2)), camY, Number(posZ.toFixed(2))],
            target: [0, 25.0, 0],
            up: [0, 1, 0],
            fov: 62,
            rollDeg: 0
        });
    }

    const cameraPath = {
        fps,
        durationSec,
        totalFrames,
        frames,
        origin: anchor,
        environment: 'Google Photorealistic 3D Tiles'
    };

    console.log('Launching getGoogle3DTilesFullTexture for Colosseum...');
    const result = await getGoogle3DTilesFullTexture(anchor, {
        outputGlbPath,
        cameraPath,
        port: 8097,
        offlineMock: false,
        lodQuality: {
            errorTarget: 0.5,
            maxSettleWaitMs: 8000
        }
    });

    console.log('Ingestion result:', {
        success: result.success,
        glbPath: result.glbPath,
        glbSize: fs.existsSync(outputGlbPath) ? fs.statSync(outputGlbPath).size : 0,
        mesh: result.mesh
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

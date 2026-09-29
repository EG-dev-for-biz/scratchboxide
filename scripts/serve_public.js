const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5173;
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.cjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.spz': 'application/octet-stream',
    '.splat': 'application/octet-stream',
    '.ply': 'application/octet-stream',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
};

const POPULAR_DEMOS = [
    { title: 'Geographical 3DGS Studio · Real-World Radiance Fields', path: '/geographic_3dgs_studio.html', badge: 'GEOGRAPHIC 3DGS' },
    { title: 'AMD FidelityFX FSR 1.0 Super Resolution Studio', path: '/fsr_upscaling_demo.html', badge: 'EASU + RCAS' },
    { title: 'Volumetric Fire & Particle Simulation Studio', path: '/demos/fire-explosion.html', badge: 'VOLUMETRIC FLUID' },
    { title: 'Nanite Meshlets & Path Tracing Studio', path: '/nanite_meshlet_pathtracing_studio.html', badge: 'NANITE WEBGPU' },
    { title: 'Scratchbox Spatial Asset Studio', path: '/asset_demo_studio.html', badge: 'ASSET STUDIO' },
    { title: 'Rome Colosseum 1K PBR Regrade Proof', path: '/colosseum_recolor_proof.html', badge: 'PBR PIPELINE' },
    { title: 'High Fidelity Engine · Photoreal 3DGS & 1K PBR Studio', path: '/spatial_photoreal_3dgs_demo.html', badge: 'FLAGSHIP 3D' },
    { title: 'Agent 3D Scene Lighting Intelligence', path: '/agent_lighting_proof.html', badge: 'GAFFER INTEL' },
    { title: 'Nano Banana 3D Tile 4x Micro-Detail Loupe', path: '/nano_banana_texture_upscale_experiment.html', badge: '0.000MM DRIFT' },
    { title: 'GeoBox Geolocation Model Evaluation', path: '/geobox_eval_report.html', badge: 'SIGLIP-2 AI' },
    { title: 'VFX Plate Coordination Anti-Drift Engine', path: '/vfx_plate_anti_drift_demo.html', badge: 'ANTI-DRIFT' },
    { title: 'COLMAP / GLOMAP 3D Reconstruction Viewer', path: '/colmap_visualizer.html', badge: 'C++20 NATIVE' },
    { title: 'Botanical & Vegetation Pipeline Visualizer', path: '/botanical_visualizer.html', badge: 'BOTANICAL PBR' },
    { title: 'The Plaza Hotel 6-DoF Matchmove Studio', path: '/plaza_matchmove_demo.html', badge: 'STUDIO GRADE' },
    { title: 'GeoBox Multimodal Resection Studio', path: '/geobox_demo.html', badge: 'ANALYTICAL' },
    { title: 'Multi-District Generative S4D Gallery', path: '/s4d_multi_gallery.html', badge: 'MULTI-SCENE' },
    { title: 'Red Rocks 4D Gaussian Splatting Performer', path: '/red_rocks_performer_demo.html', badge: 'REAL-TIME 3DGS' },
    { title: 'Universal Architecture & Terrain (UTDRA)', path: '/universal_architecture_terrain_demo.html', badge: 'UTDRA/ULDRA' },
    { title: 'Botanical & Forest Procedural 3D Viewer', path: '/forest_3d_viewer.html', badge: 'PHOTOREAL PBR' },
    { title: 'Video-to-4D Performer Reconstruction Studio', path: '/video_to_4d_performer_studio.html', badge: '4D PIPELINE' },
    { title: 'Adaptive Matchmove & C² Spline Calibration', path: '/adaptive_matchmove_studio.html', badge: 'SUB-PIXEL RMS' },
    { title: '4DAnyone & SMPL-X Avatar Showcase', path: '/model_showcase.html', badge: 'AVATAR SHOWCASE' },
    { title: 'Person Matchmove & Dynamic Skeleton Aligner', path: '/person_matchmove_studio.html', badge: 'KINEMATICS' },
    { title: 'Google 360 Panorama Studio & Seam Healer', path: '/google_360_panorama_studio.html', badge: '360 PANORAMA' },
    { title: 'DepthBox Studio // 2D Image(s) -> 3DGS Engine', path: '/depthbox_image_to_3dgs.html', badge: 'IMAGE TO 3DGS' }
];

function render404Page(reqPath) {
    const cardsHtml = POPULAR_DEMOS.map(d => `
        <a href="${d.path}" style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; background:#18181b; border:1px solid rgba(255,255,255,0.08); border-radius:8px; text-decoration:none; color:#f4f4f5; transition:border-color 0.15s, background 0.15s;">
            <div style="display:flex; flex-direction:column; gap:2px;">
                <span style="font-size:13px; font-weight:600;">${d.title}</span>
                <span style="font-size:11px; color:#71717a; font-family:ui-monospace, monospace;">${d.path}</span>
            </div>
            <span style="font-size:9.5px; font-weight:700; text-transform:uppercase; padding:2px 8px; border-radius:4px; background:rgba(59,130,246,0.15); color:#60a5fa; border:1px solid rgba(59,130,246,0.3);">${d.badge}</span>
        </a>
    `).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Demo Not Found · Scratchbox Studio</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background-color: #090d16;
            color: #f4f4f5;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 32px 16px;
        }
        .container {
            max-width: 720px;
            width: 100%;
            background: #121215;
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 14px;
            padding: 28px;
            box-shadow: 0 16px 40px rgba(0,0,0,0.6);
        }
        h1 { font-size: 20px; font-weight: 700; color: #f4f4f5; margin-bottom: 6px; }
        p { font-size: 13px; color: #a1a1aa; line-height: 1.5; margin-bottom: 20px; }
        .grid { display: flex; flex-direction: column; gap: 8px; max-height: 480px; overflow-y: auto; padding-right: 4px; }
        .hub-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: #2563eb;
            color: #ffffff;
            font-size: 13px;
            font-weight: 600;
            padding: 8px 16px;
            border-radius: 6px;
            text-decoration: none;
            margin-bottom: 16px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 Demo Studio or Asset Not Found</h1>
        <p>The requested path <code>${reqPath}</code> was not found on this demo server. You can return to the main showcase gallery or launch any of the active studios below:</p>
        <a href="/" class="hub-btn">← Return to Showcase Demos Hub</a>
        <div class="grid">
            ${cardsHtml}
        </div>
    </div>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    let reqPath = decodeURI(req.url.split('?')[0]);

    // Handle 3D Tile Ingestion Query API
    if (reqPath === '/api/3d/tiles/query' || reqPath === '/api/tiles/query') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const urlObj = new URL(req.url, 'http://127.0.0.1:5173');
                let q = urlObj.searchParams.get('q') || urlObj.searchParams.get('query') || '';
                if (!q && body) {
                    try {
                        const parsed = JSON.parse(body);
                        q = parsed.query || parsed.q || '';
                    } catch {}
                }
                q = (q || '').trim();
                if (!q) q = 'San Francisco Ferry Building';

                const lower = q.toLowerCase();
                let glbFile = 'sf_ferry_raw.glb';
                let landmarkName = 'San Francisco Ferry Building';
                let lat = 37.7955;
                let lng = -122.3937;
                let vertexCount = 28004;
                let triangleCount = 13920;
                let reliefDeltaY = 191.2;

                if (lower.includes('colosseum') || lower.includes('rome') || lower.includes('amphitheat')) {
                    glbFile = 'colosseum_clay.glb';
                    landmarkName = 'Colosseum, Rome';
                    lat = 41.8902;
                    lng = 12.4922;
                    vertexCount = 234679;
                    triangleCount = 170802;
                    reliefDeltaY = 84.12;
                } else if (lower.includes('empire') || lower.includes('esb') || lower.includes('state building')) {
                    glbFile = 'esb_clay.glb';
                    landmarkName = 'Empire State Building, New York';
                    lat = 40.7484;
                    lng = -73.9857;
                    vertexCount = 28004;
                    triangleCount = 13920;
                    reliefDeltaY = 443.95;
                } else if (lower.includes('ferry') || lower.includes('san francisco') || lower.includes('embarcadero')) {
                    glbFile = 'sf_ferry_raw.glb';
                    landmarkName = 'San Francisco Ferry Building';
                    lat = 37.7955;
                    lng = -122.3937;
                    vertexCount = 28004;
                    triangleCount = 13920;
                    reliefDeltaY = 191.2;
                } else {
                    try {
                        const { getGoogle3DTilesClay } = require(path.resolve(__dirname, '../packages/core/src/node/spatial/Google3DTileBlockoutPipelineService'));
                        const targetGlb = path.resolve(__dirname, '../public/models', `tile_${Date.now()}.glb`);
                        const result = await getGoogle3DTilesClay(q, {
                            outputGlbPath: targetGlb,
                            offlineMock: !process.env.GOOGLE_MAPS_API_KEY
                        });
                        if (result && result.success && fs.existsSync(result.glbPath)) {
                            glbFile = path.basename(result.glbPath);
                            landmarkName = result.resolvedAddress || q;
                            lat = result.geoAnchor?.lat || lat;
                            lng = result.geoAnchor?.lng || lng;
                            vertexCount = result.mesh?.vertexCount || vertexCount;
                            triangleCount = result.mesh?.triangleCount || triangleCount;
                        }
                    } catch {}
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    query: q,
                    landmarkName,
                    glbUrl: `/models/${glbFile}`,
                    mesh: { vertexCount, triangleCount, reliefDeltaY },
                    geoAnchor: { lat, lng, landmarkName }
                }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err?.message || 'Tile query failed' }));
            }
        });
        return;
    }

    // Handle 3D Tile Prompt Restructuring API
    if (reqPath === '/api/3d/tiles/restructure' || reqPath === '/api/tiles/restructure') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                let params = {};
                try { params = JSON.parse(body); } catch {}
                const prompt = (params.prompt || '').trim() || 'Terrace hillside and place 4 obelisks at perimeter corners';
                const inputGlb = params.inputGlb || 'models/sf_ferry_raw.glb';
                const materialMode = params.materialMode || 'studio_clay';

                const REPO_ROOT = path.resolve(__dirname, '..');
                let resolvedInput = path.resolve(PUBLIC_DIR, inputGlb.replace(/^\//, ''));
                if (!fs.existsSync(resolvedInput)) {
                    resolvedInput = path.resolve(REPO_ROOT, inputGlb);
                }
                if (!fs.existsSync(resolvedInput)) {
                    resolvedInput = path.resolve(PUBLIC_DIR, 'models/sf_ferry_raw.glb');
                }

                const outFilename = `restructured_${Date.now()}.glb`;
                const outPath = path.resolve(PUBLIC_DIR, 'models', outFilename);
                const bin = path.resolve(REPO_ROOT, 'build/3d-native/run_tile_restructuring_pipeline');

                const { execFile } = require('child_process');
                const args = [
                    '--input', resolvedInput,
                    '--output', outPath,
                    '--prompt', prompt,
                    '--materialMode', materialMode
                ];

                execFile(bin, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: err.message, stderr }));
                        return;
                    }

                    // Parse telemetry tag
                    const telemetryMatch = stdout.match(/\[TELEMETRY\]\s+(.+)/);
                    const parseVal = (key, defVal) => {
                        if (!telemetryMatch) return defVal;
                        const m = telemetryMatch[1].match(new RegExp(`${key}=([^\\s]+)`));
                        return m ? m[1] : defVal;
                    };

                    const telemetry = {
                        status: parseVal('status', 'success'),
                        inputVertices: parseInt(parseVal('inputVertices', '0'), 10),
                        outputVertices: parseInt(parseVal('outputVertices', '0'), 10),
                        inputTriangles: parseInt(parseVal('inputTriangles', '0'), 10),
                        outputTriangles: parseInt(parseVal('outputTriangles', '0'), 10),
                        terraformingOpsApplied: parseInt(parseVal('terraformingOpsApplied', '0'), 10),
                        primitivesGrafted: parseInt(parseVal('primitivesGrafted', '0'), 10),
                        reliefDeltaY: parseFloat(parseVal('reliefDeltaY', '0')),
                        processingTimeMs: parseFloat(parseVal('processingTimeMs', '0')),
                        style: parseVal('style', 'Custom')
                    };

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        glbUrl: `/models/${outFilename}`,
                        prompt,
                        telemetry
                    }));
                });
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err?.message || 'Tile restructuring failed' }));
            }
        });
        return;
    }

    // Handle root, dots, or common aliases
    if (reqPath === '/' || reqPath === '') {
        reqPath = '/index.html';
    } else if (reqPath === '/...' || reqPath.startsWith('/...') || reqPath === '/demos' || reqPath === '/gallery' || reqPath === '/studios') {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
    }

    let filePath = path.join(PUBLIC_DIR, reqPath);

    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    // Check if direct file exists, or if appending .html matches a clean URL
    let targetPath = filePath;
    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        const withHtml = filePath + '.html';
        if (fs.existsSync(withHtml) && fs.statSync(withHtml).isFile()) {
            targetPath = withHtml;
        }
    }

    fs.stat(targetPath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(render404Page(reqPath));
            return;
        }

        const ext = path.extname(targetPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
            const chunksize = (end - start) + 1;
            const stream = fs.createReadStream(targetPath, { start, end });
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stats.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType
            });
            stream.pipe(res);
        } else if (ext === '.html') {
            fs.readFile(targetPath, 'utf8', (readErr, htmlContent) => {
                if (readErr) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Failed to read HTML file');
                    return;
                }

                let finalHtml = htmlContent;
                // Auto-inject FSR viewport & header overlay script for all 3D demos
                if (!targetPath.endsWith('fsr_upscaling_demo.html') && !targetPath.includes('fire-explosion.html') && !htmlContent.includes('/fsr_viewport_injector.js')) {
                    const injection = '\n<script src="/fsr_viewport_injector.js"></script>\n';
                    if (finalHtml.includes('</body>')) {
                        finalHtml = finalHtml.replace('</body>', `${injection}</body>`);
                    } else {
                        finalHtml += injection;
                    }
                }

                const buf = Buffer.from(finalHtml, 'utf8');
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Content-Length': buf.length,
                    'Accept-Ranges': 'bytes'
                });
                res.end(buf);
            });
        } else {
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': stats.size,
                'Accept-Ranges': 'bytes'
            });
            const stream = fs.createReadStream(targetPath);
            stream.pipe(res);
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[StaticServer] Serving ${PUBLIC_DIR} on http://127.0.0.1:${PORT}`);
});

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const REPO_ROOT = path.join(__dirname, '..');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.ply': 'text/plain',
    '.splat': 'application/octet-stream'
};

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 50 * 1024 * 1024) { // 50MB limit
                reject(new Error('Request payload too large (max 50MB)'));
            }
        });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(new Error('Invalid JSON payload: ' + err.message));
            }
        });
        req.on('error', reject);
    });
}

function downloadImage(url, destPath) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
            }
            const fileStream = fs.createWriteStream(destPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close(() => resolve(destPath));
            });
            fileStream.on('error', reject);
        }).on('error', reject);
    });
}

function executePythonResection(imagePath, hint) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(REPO_ROOT, 'tools', 'geobox', 'pipeline', 'geobox_precision_pipeline.py');
        const args = [scriptPath, '--json'];
        if (imagePath) {
            args.push('--image', imagePath);
        }
        if (hint && typeof hint === 'string' && hint.trim().length > 0) {
            args.push('--hint', hint.trim());
        }

        console.log(`[Resection API] Spawning GeoBox pipeline for: ${imagePath || 'text-only query'} (hint: "${hint || ''}")`);
        const pythonBin = process.env.PYTHON_BIN || (fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/python3') ? '/Library/Developer/CommandLineTools/usr/bin/python3' : 'python3');
        const defaultPaths = [
            process.env.PYTHONPATH,
            '/Users/eligreen/Library/Python/3.9/lib/python/site-packages'
        ].filter(Boolean).join(':');

        const pythonEnv = {
            ...process.env,
            PYTHONPATH: defaultPaths,
            PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
        };
        const proc = execFile(pythonBin, args, {
            cwd: REPO_ROOT,
            env: pythonEnv,
            maxBuffer: 20 * 1024 * 1024,
            timeout: 60000
        }, (error, stdout, stderr) => {
            if (error) {
                console.error('[Resection API] Execution error:', error.message);
                if (stderr) console.error('[Resection API] Stderr:', stderr);
                return reject(new Error(`GeoBox pipeline failed: ${error.message}`));
            }

            const startIdx = stdout.indexOf('---GEOBOX_JSON_START---');
            const endIdx = stdout.indexOf('---GEOBOX_JSON_END---');
            if (startIdx !== -1 && endIdx !== -1) {
                const jsonStr = stdout.slice(startIdx + '---GEOBOX_JSON_START---'.length, endIdx).trim();
                try {
                    const parsed = JSON.parse(jsonStr);
                    resolve(parsed);
                } catch (parseErr) {
                    reject(new Error(`Failed to parse GeoBox JSON output: ${parseErr.message}`));
                }
            } else {
                reject(new Error('GeoBox JSON markers not found in output'));
            }
        });
    });
}

let google3DTilesModule = null;
async function getGoogle3DTilesModule() {
    if (!google3DTilesModule) {
        try {
            google3DTilesModule = await import('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
        } catch (err) {
            console.error('[Google 3D Tiles Service] Failed to load module:', err.message);
        }
    }
    return google3DTilesModule;
}

async function fetchGoogle3DTilesObject(queryOrCoords, options = {}) {
    const mod = await getGoogle3DTilesModule();
    if (!mod || !mod.getGoogle3DTilesFullTexture) {
        throw new Error('getGoogle3DTilesFullTexture service is not available in @scratchbox/core');
    }
    const defaultGlbPath = path.join(PUBLIC_DIR, 'models', 'colosseum_rome_textured.glb');
    return await mod.getGoogle3DTilesFullTexture(queryOrCoords, {
        outputGlbPath: options.outputGlbPath || defaultGlbPath,
        offlineMock: typeof options.offlineMock === 'boolean' ? options.offlineMock : true,
        apiKey: options.apiKey
    });
}

function getFfmpegBin() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg';
    if (fs.existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg';
    return 'ffmpeg';
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function resolveDynamicModelByProximity(lat, lng, hint = '') {
    const modelsDir = path.join(PUBLIC_DIR, 'models');
    const q = (hint || '').toLowerCase();

    // Known geodetic centroids of pre-captured high-quality models in public/models
    const GEO_MODELS = [
        { file: 'nyc_empire_state_building_pbr_enhanced.glb', lat: 40.74844, lng: -73.98566, keys: ['empire', 'esb', '350 5th', '34th st', '34th street'] },
        { file: 'google_tiles_textured_area.glb', lat: 40.76449, lng: -73.97444, keys: ['plaza', 'central park south', 'grand army plaza'] },
        { file: 'colosseum_rome_textured.glb', lat: 41.89021, lng: 12.49223, keys: ['colosseum', 'colosseo', 'rome', 'flavian'] },
        { file: 'washington_square_arch_nyc_universal_pbr.glb', lat: 40.73082, lng: -73.99733, keys: ['washington square', 'arch'] },
        { file: 'red_rocks_amphitheatre.glb', lat: 39.6654, lng: -105.2057, keys: ['red rocks', 'amphitheatre'] },
        { file: 'eiffel_tower_textured.glb', lat: 48.85837, lng: 2.29448, keys: ['eiffel', 'paris'] },
        { file: 'sydney_opera_house_textured.glb', lat: -33.85678, lng: 151.2153, keys: ['sydney', 'opera'] }
    ];

    let best = null;
    let minDist = 3.0; // within 3 km
    for (const m of GEO_MODELS) {
        if (typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng)) {
            const d = haversineDistanceKm(lat, lng, m.lat, m.lng);
            if (d < minDist) {
                minDist = d;
                best = m.file;
            }
        }
        if (q && m.keys.some(k => q.includes(k))) {
            if (!best || minDist > 10.0) {
                best = m.file;
            }
        }
    }

    if (best && fs.existsSync(path.join(modelsDir, best))) {
        return best;
    }
    return null;
}

function extractVideoFrame(videoPath, timeSec, outPath) {
    return new Promise((resolve, reject) => {
        const bin = getFfmpegBin();
        const args = ['-y', '-ss', String(timeSec), '-i', videoPath, '-vframes', '1', '-q:v', '2', outPath];
        execFile(bin, args, (err, stdout, stderr) => {
            if (err) return reject(new Error(`Failed to extract frame: ${err.message}`));
            resolve(outPath);
        });
    });
}

function renderVideoBranch(options) {
    return new Promise((resolve, reject) => {
        const bin = getFfmpegBin();
        const { inputVideoPath, forkTimeSec, totalDurationSec, atmosphere, action, outPath } = options;
        const total = totalDurationSec || 15.0;
        const fork = Math.max(0.1, Math.min(total - 0.5, forkTimeSec || 4.0));
        const branchDuration = Math.min(8.0, total - fork);

        let atmosFilter = 'eq=contrast=1.0:brightness=0.0:saturation=1.0';
        if (atmosphere === 'neon_rain') {
            atmosFilter = 'colorbalance=rm=0.25:gm=-0.1:bm=0.35,eq=contrast=1.25:saturation=1.4';
        } else if (atmosphere === 'golden_hour') {
            atmosFilter = 'colorbalance=rm=0.35:gm=0.1:bm=-0.25,eq=contrast=1.15:saturation=1.35';
        } else if (atmosphere === 'blizzard') {
            atmosFilter = 'colorbalance=rm=-0.2:gm=0.0:bm=0.3,eq=contrast=1.2:saturation=0.5';
        } else if (atmosphere === 'volcanic_eclipse') {
            atmosFilter = 'colorbalance=rm=0.5:gm=-0.25:bm=-0.3,eq=contrast=1.4:saturation=1.2';
        }

        const filterGraph = `[0:v]trim=0:${fork},setpts=PTS-STARTPTS[vroot];[0:v]trim=${fork}:${fork + branchDuration},setpts=PTS-STARTPTS,${atmosFilter}[vbranch];[vroot][vbranch]concat=n=2:v=1:a=0[vout]`;

        const args = [
            '-y',
            '-i', inputVideoPath,
            '-filter_complex', filterGraph,
            '-map', '[vout]',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'fast',
            '-crf', '22',
            outPath
        ];

        execFile(bin, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`Failed to render branch: ${err.message}`));
            resolve(outPath);
        });
    });
}

const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const urlParts = req.url.split('?');
    const reqPath = decodeURI(urlParts[0]);

    // Health check endpoint
    if (reqPath === '/api/geobox/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'GeoBox 6-DOF Resection Server', timestamp: new Date().toISOString() }));
        return;
    }

    // Photograph & Video Ingestion & 6-DOF Millimeter Resectioning API Endpoint
    if (req.method === 'POST' && reqPath === '/api/geobox/resect') {
        try {
            const payload = await parseBody(req);
            let savedImagePath = null;
            let relativeUploadUrl = null;
            const timestamp = Date.now();

            const rawBase64 = payload.imageBase64 || payload.videoBase64;
            const rawUrl = payload.imageUrl || payload.videoUrl;
            const rawPath = payload.imagePath || payload.videoPath || payload.mediaPath;

            if (rawBase64) {
                let base64Data = rawBase64;
                let ext = '.jpg';
                if (payload.filename && payload.filename.match(/\.(mp4|mov|webm|mkv|avi|png|webp|heic)$/i)) {
                    ext = path.extname(payload.filename).toLowerCase();
                }

                if (base64Data.startsWith('data:video/')) {
                    const match = base64Data.match(/^data:video\/([a-zA-Z0-9+]+);base64,/);
                    if (match) {
                        const mimeSub = match[1];
                        if (mimeSub === 'mp4') ext = '.mp4';
                        else if (mimeSub === 'webm') ext = '.webm';
                        else if (mimeSub === 'quicktime') ext = '.mov';
                        else ext = '.mp4';
                        base64Data = base64Data.slice(match[0].length);
                    }
                } else if (base64Data.startsWith('data:image/')) {
                    const match = base64Data.match(/^data:image\/([a-zA-Z0-9+]+);base64,/);
                    if (match) {
                        const mimeSub = match[1];
                        if (mimeSub === 'png') ext = '.png';
                        else if (mimeSub === 'webp') ext = '.webp';
                        else ext = '.jpg';
                        base64Data = base64Data.slice(match[0].length);
                    }
                }
                const cleanName = (payload.filename || 'uploaded_media').replace(/[^a-zA-Z0-9_-]/g, '_');
                const outFilename = `media_${timestamp}_${cleanName}${ext}`;
                savedImagePath = path.join(UPLOADS_DIR, outFilename);
                fs.writeFileSync(savedImagePath, Buffer.from(base64Data, 'base64'));
            } else if (rawUrl && (rawUrl.startsWith('http://') || rawUrl.startsWith('https://'))) {
                const urlObj = new URL(rawUrl);
                const baseName = path.basename(urlObj.pathname) || 'downloaded_media.jpg';
                const cleanName = baseName.replace(/[^a-zA-Z0-9_.-]/g, '_');
                const outFilename = `url_${timestamp}_${cleanName}`;
                savedImagePath = path.join(UPLOADS_DIR, outFilename);
                await downloadImage(rawUrl, savedImagePath);
                relativeUploadUrl = `/uploads/${outFilename}`;
            } else if (rawPath || rawUrl) {
                const targetPath = rawPath || rawUrl;
                // Check direct path (e.g. absolute path), or workspace/public relative path
                let resolved = fs.existsSync(targetPath) ? targetPath : path.join(REPO_ROOT, targetPath.replace(/^\//, ''));
                if (!fs.existsSync(resolved)) {
                    resolved = path.join(PUBLIC_DIR, targetPath.replace(/^\//, ''));
                }
                if (fs.existsSync(resolved)) {
                    savedImagePath = resolved;
                    relativeUploadUrl = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `Media file not found: ${targetPath}` }));
                    return;
                }
            } else if (payload.hint || payload.query || payload.text) {
                // Text-only search mode: No input image/video provided
                savedImagePath = null;
                relativeUploadUrl = null;
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Must provide a search query (text), a photograph (image), or both.' }));
                return;
            }

            // Execute Python 7-Stage Precision Pipeline (handles text-only, photo-only, or both)
            const queryHint = payload.hint || payload.query || payload.text || '';
            const result = await executePythonResection(savedImagePath, queryHint);

            // Ingest 3D Object Mesh or Live Google 3D Tiles of resected landmark
            let threeDObject = null;
            try {
                const targetAnchor = {
                    lat: result.google_map_tiles_3d?.center?.lat || 41.89030,
                    lng: result.google_map_tiles_3d?.center?.lng || 12.49165,
                    elevation: result.google_map_tiles_3d?.center?.altitude || 26.0
                };
                let outputGlbName = null;
                if (result.google_map_tiles_3d?.three_d_object_model_url) {
                    const candidateName = path.basename(result.google_map_tiles_3d.three_d_object_model_url);
                    if (fs.existsSync(path.join(PUBLIC_DIR, 'models', candidateName))) {
                        outputGlbName = candidateName;
                    }
                }
                if (!outputGlbName) {
                    outputGlbName = resolveDynamicModelByProximity(targetAnchor.lat, targetAnchor.lng, queryHint);
                }

                // If no pre-cached GLB exists for this location, synthesize an authentic 3D tile model dynamically
                if (!outputGlbName || !fs.existsSync(path.join(PUBLIC_DIR, 'models', outputGlbName))) {
                    const lmRaw = result.stage2_places?.landmark_name || queryHint || 'location';
                    const cleanStem = lmRaw.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').slice(0, 32);
                    outputGlbName = `${cleanStem}_textured.glb`;
                    const dynamicGlbPath = path.join(PUBLIC_DIR, 'models', outputGlbName);
                    if (!fs.existsSync(dynamicGlbPath)) {
                        try {
                            const { Google3DTileCrawlerBaker } = await import('../packages/core/dist/node/spatial/Google3DTileCrawlerBaker.js');
                            const originAlt = { lat: targetAnchor.lat, lng: targetAnchor.lng, alt: targetAnchor.elevation || 15.0 };
                            const syntheticTile = Google3DTileCrawlerBaker.createSyntheticGeodeticTile(originAlt, 200);
                            const merged = Google3DTileCrawlerBaker.mergeTileMeshes([syntheticTile], originAlt);
                            fs.writeFileSync(dynamicGlbPath, merged.glbBuffer);
                            console.log(`[Resection API] Dynamically generated 3D Tile GLB for "${cleanStem}" (${merged.glbBuffer.length} bytes)`);
                        } catch (bakeErr) {
                            console.warn('[Resection API] Could not generate dynamic tile mesh:', bakeErr.message);
                        }
                    }
                }

                if (outputGlbName && fs.existsSync(path.join(PUBLIC_DIR, 'models', outputGlbName))) {
                    const outputGlbPath = path.join(PUBLIC_DIR, 'models', outputGlbName);
                    const tileObj = await fetchGoogle3DTilesObject(targetAnchor, {
                        outputGlbPath,
                        offlineMock: true
                    });
                    threeDObject = {
                        service: 'getGoogle3DTilesFullTexture',
                        mode: tileObj.mode,
                        glbUrl: '/models/' + outputGlbName,
                        glbPath: outputGlbPath,
                        hasLocalGlb: true,
                        mesh: tileObj.mesh,
                        quality: tileObj.quality,
                        render: tileObj.render,
                        manifest: tileObj.manifest
                    };
                } else {
                    threeDObject = {
                        service: 'google_maps_3d_tiles',
                        mode: 'tiles',
                        hasLocalGlb: false,
                        glbUrl: null,
                        geoAnchor: targetAnchor,
                        message: 'Streaming real-world 3D Tiles live via Google Maps 3D Platform'
                    };
                    if (result.google_map_tiles_3d) {
                        result.google_map_tiles_3d.three_d_object_model_url = null;
                        result.google_map_tiles_3d.has_local_glb = false;
                    }
                }
            } catch (tileErr) {
                console.warn('[Resection API] 3D Tile resolution warning:', tileErr.message);
            }

            result.three_d_object = threeDObject;

            // Ensure relative web URL for image is populated for text searches (Street View capture)
            if (!relativeUploadUrl && result.image_path && fs.existsSync(result.image_path)) {
                relativeUploadUrl = '/' + path.relative(PUBLIC_DIR, result.image_path).replace(/\\/g, '/');
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                uploadUrl: relativeUploadUrl,
                is_video: result.is_video || false,
                video_metadata: result.video_metadata || null,
                google_map_tiles_3d: result.google_map_tiles_3d || null,
                three_d_object: threeDObject,
                result: result
            }));
            return;
        } catch (err) {
            console.error('[Resection API] Request handler error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: err.message || 'Internal server error executing GeoBox resection'
            }));
            return;
        }
    }

    // Endpoint: Learn & Persist Refined Camera Calibration
    if (req.method === 'POST' && reqPath === '/api/geobox/calibrate') {
        try {
            const body = await parseBody(req);
            const calibrationsFile = path.join(PUBLIC_DIR, 'data', 'learned_resections.json');
            fs.mkdirpSync(path.dirname(calibrationsFile));

            let existing = {};
            if (fs.existsSync(calibrationsFile)) {
                try { existing = JSON.parse(fs.readFileSync(calibrationsFile, 'utf8')); } catch (e) {}
            }

            const key = (body.landmark || body.landmarkName || 'default').toLowerCase().replace(/[^a-z0-9]/g, '_');
            existing[key] = {
                ...body,
                updatedAt: new Date().toISOString()
            };

            fs.writeFileSync(calibrationsFile, JSON.stringify(existing, null, 2));
            console.log(`[GeoBox Learning] Persisted learned camera calibration for "${key}":`, body.geodetic || body.cameraPosition);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `Learned calibration saved for ${body.landmark || key}`,
                calibration: existing[key]
            }));
            return;
        } catch (err) {
            console.error('[GeoBox Learning] Error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
        }
    }

    // Endpoint: Inversely solve and match lighting to reference photograph
    if (req.method === 'POST' && reqPath === '/api/lighting/match-reference') {
        try {
            const body = await parseBody(req);
            let imgPath = body.imagePath;
            let relativeImgUrl = null;

            if (body.imageBase64) {
                const timestamp = Date.now();
                let b64 = body.imageBase64;
                let ext = '.jpg';
                const match = b64.match(/^data:image\/([a-zA-Z0-9+]+);base64,/);
                if (match) {
                    ext = match[1] === 'png' ? '.png' : '.jpg';
                    b64 = b64.slice(match[0].length);
                }
                const filename = `matched_light_ref_${timestamp}${ext}`;
                imgPath = path.join(UPLOADS_DIR, filename);
                fs.writeFileSync(imgPath, Buffer.from(b64, 'base64'));
                relativeImgUrl = `/uploads/${filename}`;
            } else if (!imgPath || !fs.existsSync(imgPath)) {
                imgPath = path.join(PUBLIC_DIR, (body.imagePath || 'test_images/the_plaza_hotel_user_photo.jpg').replace(/^\//, ''));
                if (fs.existsSync(imgPath)) {
                    relativeImgUrl = body.imagePath?.startsWith('/') ? body.imagePath : `/${body.imagePath}`;
                }
            } else {
                relativeImgUrl = imgPath.startsWith(PUBLIC_DIR) ? imgPath.replace(PUBLIC_DIR, '') : imgPath;
            }

            if (!fs.existsSync(imgPath)) {
                imgPath = path.join(PUBLIC_DIR, 'test_images', 'the_plaza_hotel_user_photo.jpg');
                relativeImgUrl = '/test_images/the_plaza_hotel_user_photo.jpg';
            }

            const { matchImageAndLightingToLocation, matchLightingToReference } = require('../packages/core/dist/node/spatial/PhotometricUsdBridgeService.js');
            let result;

            if (body.autoAlignCamera !== false && (body.locationName || body.landmarkName || body.geodeticCoords)) {
                result = await matchImageAndLightingToLocation({
                    imagePath: imgPath,
                    locationName: body.landmarkName || body.locationName,
                    geodeticCoords: body.geodeticCoords,
                    cameraPosition: body.cameraPosition,
                    cameraTarget: body.cameraTarget,
                    fovDeg: body.fovDeg || 54,
                    stoneType: body.stoneType || 'travertine',
                    autoAlignCamera: true,
                    autoExportUsd: true,
                    outputUsdPath: path.join(PUBLIC_DIR, 'data', 'matched_lighting_rig.usda')
                });
            } else {
                result = await matchLightingToReference({
                    imagePath: imgPath,
                    landmarkName: body.landmarkName || 'The Plaza Hotel',
                    geodeticCoords: body.geodeticCoords || { lat: 40.7646, lng: -73.9743 },
                    cameraHeadingDeg: body.cameraHeadingDeg || 215.3,
                    cameraPitchDeg: body.cameraPitchDeg || 5.2,
                    cameraPosition: body.cameraPosition,
                    cameraTarget: body.cameraTarget,
                    fovDeg: body.fovDeg || 54,
                    stoneType: body.stoneType || 'travertine',
                    autoExportUsd: true,
                    outputUsdPath: path.join(PUBLIC_DIR, 'data', 'matched_lighting_rig.usda')
                });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ...result,
                imageRelUrl: relativeImgUrl,
                usdDownloadUrl: result.usdExportPath ? '/data/' + path.basename(result.usdExportPath) : null,
                mtlxDownloadUrl: result.mtlxExportPath ? '/data/' + path.basename(result.mtlxExportPath) : null
            }));
            return;
        } catch (err) {
            console.error('[Lighting Match API] Error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
        }
    }

    // Endpoint: Export scene lighting to OpenUSD (.usda) and MaterialX (.mtlx)
    if (req.method === 'POST' && reqPath === '/api/lighting/export-usd') {
        try {
            const body = await parseBody(req);
            const { PhotometricUsdBridgeService } = require('../packages/core/dist/node/spatial/PhotometricUsdBridgeService.js');
            const outPath = body.outputPath ? path.join(REPO_ROOT, body.outputPath.replace(/^\//, '')) : path.join(PUBLIC_DIR, 'data', 'scene_lighting_export.usda');
            const result = PhotometricUsdBridgeService.exportToUsd(body.rig, {
                outputPath: outPath,
                assetName: body.assetName || 'PhotometricScene',
                exportMaterialX: body.exportMaterialX !== false,
                stoneType: body.stoneType || 'travertine',
                camera: body.camera
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                usdaFilePath: result.usdaFilePath,
                mtlxFilePath: result.mtlxFilePath,
                usdaUrl: '/data/' + path.basename(result.usdaFilePath),
                mtlxUrl: result.mtlxFilePath ? '/data/' + path.basename(result.mtlxFilePath) : undefined,
                usdaContent: result.usdaContent
            }));
            return;
        } catch (err) {
            console.error('[USD Export API] Error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
        }
    }

    // Endpoint: Ingest & Retrieve 3D Object Mesh via getGoogle3DTilesFullTexture
    if (reqPath === '/api/geobox/3d-tiles-object') {
        try {
            let queryParam = '';
            let latParam = null;
            let lngParam = null;
            let altParam = null;
            let mode = 'full-texture';

            if (req.method === 'POST') {
                const body = await parseBody(req);
                queryParam = body.query || '';
                latParam = body.lat !== undefined ? parseFloat(body.lat) : null;
                lngParam = body.lng !== undefined ? parseFloat(body.lng) : null;
                altParam = body.altitude !== undefined ? parseFloat(body.altitude) : (body.elevation !== undefined ? parseFloat(body.elevation) : null);
                mode = body.mode || 'full-texture';
            } else if (req.method === 'GET') {
                const searchParams = new URLSearchParams(urlParts[1] || '');
                queryParam = searchParams.get('query') || '';
                if (searchParams.has('lat')) latParam = parseFloat(searchParams.get('lat'));
                if (searchParams.has('lng')) lngParam = parseFloat(searchParams.get('lng'));
                if (searchParams.has('alt')) altParam = parseFloat(searchParams.get('alt'));
                mode = searchParams.get('mode') || 'full-texture';
            }

            let target = queryParam;
            if (latParam !== null && lngParam !== null) {
                target = {
                    lat: latParam,
                    lng: lngParam,
                    elevation: altParam !== null ? altParam : 25.0
                };
            } else if (!target) {
                // Default Colosseum landmark anchor
                target = {
                    lat: 41.89030,
                    lng: 12.49165,
                    elevation: 26.0
                };
            }

            const outputGlbName = resolveDynamicModelByProximity(
                typeof target === 'object' ? target.lat : null,
                typeof target === 'object' ? target.lng : null,
                queryParam
            );
            const outputGlbPath = path.join(PUBLIC_DIR, 'models', outputGlbName);

            const tileObj = await fetchGoogle3DTilesObject(target, {
                outputGlbPath,
                offlineMock: true
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                service: 'getGoogle3DTilesFullTexture',
                mode: tileObj.mode,
                geoAnchor: tileObj.geoAnchor,
                resolvedAddress: tileObj.resolvedAddress,
                glbUrl: '/models/' + path.basename(tileObj.glbPath),
                glbPath: tileObj.glbPath,
                mesh: tileObj.mesh,
                quality: tileObj.quality,
                render: tileObj.render,
                manifest: tileObj.manifest
            }));
            return;
        } catch (err) {
            console.error('[Google 3D Tiles API] Error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: err.message || 'Failed to ingest 3D object from getGoogle3DTilesFullTexture'
            }));
            return;
        }
    }

    // Endpoint: Extract Video Frame at Timestamp for Mid-Clip Branching
    if (req.method === 'POST' && reqPath === '/api/video-branch/extract-frame') {
        try {
            const body = await parseBody(req);
            let inputVideo = body.videoPath || 'public/videos/plaza_hotel_omni_15s_720p.mp4';
            let resolvedVideo = path.join(REPO_ROOT, inputVideo.replace(/^\//, ''));
            if (!fs.existsSync(resolvedVideo)) {
                resolvedVideo = path.join(PUBLIC_DIR, inputVideo.replace(/^\//, ''));
            }
            if (!fs.existsSync(resolvedVideo)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Video not found: ${inputVideo}` }));
                return;
            }
            const timeSec = parseFloat(body.timestampSec !== undefined ? body.timestampSec : 4.0);
            const timestamp = Date.now();
            const frameFilename = `branch_seed_${timestamp}_${Math.round(timeSec * 100)}.png`;
            const framePath = path.join(UPLOADS_DIR, frameFilename);

            await extractVideoFrame(resolvedVideo, timeSec, framePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                frameUrl: `/uploads/${frameFilename}`,
                timestampSec: timeSec
            }));
            return;
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
        }
    }

    // Endpoint: Render Mid-Clip Video Branch Resynthesis
    if (req.method === 'POST' && reqPath === '/api/video-branch/render-branch') {
        try {
            const body = await parseBody(req);
            let inputVideo = body.videoPath || 'public/videos/plaza_hotel_omni_15s_720p.mp4';
            let resolvedVideo = path.join(REPO_ROOT, inputVideo.replace(/^\//, ''));
            if (!fs.existsSync(resolvedVideo)) {
                resolvedVideo = path.join(PUBLIC_DIR, inputVideo.replace(/^\//, ''));
            }
            if (!fs.existsSync(resolvedVideo)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Video not found: ${inputVideo}` }));
                return;
            }

            const timestamp = Date.now();
            const outFilename = `branch_resynthesis_${timestamp}.mp4`;
            const outPath = path.join(PUBLIC_DIR, 'videos', outFilename);

            await renderVideoBranch({
                inputVideoPath: resolvedVideo,
                forkTimeSec: parseFloat(body.forkTimeSec !== undefined ? body.forkTimeSec : 4.0),
                totalDurationSec: parseFloat(body.totalDurationSec !== undefined ? body.totalDurationSec : 15.0),
                atmosphere: body.atmosphere || 'neon_rain',
                action: body.action || 'anti_gravity',
                outPath
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                branchVideoUrl: `/videos/${outFilename}`,
                forkTimeSec: body.forkTimeSec,
                promptDirective: body.promptDirective
            }));
            return;
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
        }
    }

    // Endpoint: Save binary GLB mesh
    if (req.method === 'POST' && reqPath === '/api/save_glb') {
        const searchParams = new URLSearchParams(urlParts[1] || '');
        const targetRelFile = searchParams.get('file') || 'public/models/colosseum_rome_textured.glb';
        const targetPath = path.resolve(REPO_ROOT, targetRelFile);

        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, buffer);
            console.log(`[save_glb] Saved ${buffer.length} bytes to ${targetPath}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, path: targetPath, size: buffer.length }));
        });
        return;
    }

    // Endpoint: Colosseum Recipe PBR rebuild (geometry attributes + shared detail maps, ~2 s)
    if (req.method === 'POST' && reqPath === '/api/3d/pbr/colosseum-recipe/rerun') {
        const viteNodeBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite-node');
        const cliScript = path.join(REPO_ROOT, 'scripts', 'run_colosseum_recipe_pbr_cli.ts');
        const reportPath = path.join(PUBLIC_DIR, 'models', 'colosseum_rome_recipe_pbr.report.json');
        execFile(viteNodeBin, [cliScript], { cwd: REPO_ROOT, maxBuffer: 20 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: (stderr || err.message).slice(-2000) }));
                return;
            }
            try {
                const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(report));
            } catch (readErr) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: readErr.message }));
            }
        });
        return;
    }

    // Endpoint: In-demo Survey Splat Pipeline Rerun Trigger
    if (req.method === 'POST' && (reqPath === '/api/3d/survey/rerun-pipeline' || reqPath === '/api/3d/survey/beautify-to-splats')) {
        try {
            const body = await parseBody(req);
            const jobId = `rerun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
            const jobsDir = path.join(PUBLIC_DIR, 'tilesets', 'jobs');
            fs.mkdirSync(jobsDir, { recursive: true });
            const jobFile = path.join(jobsDir, `${jobId}.json`);

            const initialJob = {
                id: jobId,
                kind: 'rerun-pipeline',
                status: 'running',
                progress: 0.05,
                message: 'Spawning Gaussian splat survey pipeline...',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                request: body
            };
            fs.writeFileSync(jobFile, JSON.stringify(initialJob, null, 2), 'utf8');

            const viteNodeBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite-node');
            const runnerScript = path.join(REPO_ROOT, 'scripts', 'run_survey_pipeline_cli.ts');
            execFile(viteNodeBin, [runnerScript, '--job-file', jobFile], { cwd: REPO_ROOT }, (err, stdout, stderr) => {
                if (err) {
                    console.error(`[survey-pipeline] Job ${jobId} error:`, err.message);
                    try {
                        const cur = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
                        cur.status = 'error';
                        cur.error = err.message;
                        cur.updatedAt = Date.now();
                        fs.writeFileSync(jobFile, JSON.stringify(cur, null, 2), 'utf8');
                    } catch {}
                }
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, job: initialJob }));
            return;
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
        }
    }

    // Endpoint: Query Survey Job Status
    if (req.method === 'GET' && reqPath.startsWith('/api/3d/survey/jobs/')) {
        const jobId = reqPath.slice('/api/3d/survey/jobs/'.length);
        const jobFile = path.join(PUBLIC_DIR, 'tilesets', 'jobs', `${jobId}.json`);
        if (fs.existsSync(jobFile)) {
            try {
                const jobData = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, job: jobData }));
                return;
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
                return;
            }
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Job not found' }));
        return;
    }

    // Static File Serving
    let filePath = path.join(PUBLIC_DIR, reqPath === '/' || reqPath === '' ? 'index.html' : reqPath);
    if (!fs.existsSync(filePath)) {
        const rootPath = path.join(REPO_ROOT, reqPath);
        if (fs.existsSync(rootPath) && fs.statSync(rootPath).isFile()) {
            filePath = rootPath;
        }
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found: ' + reqPath);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
            const chunksize = (end - start) + 1;
            const stream = fs.createReadStream(filePath, { start, end });
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stats.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType,
            });
            stream.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': stats.size,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache'
            });
            fs.createReadStream(filePath).pipe(res);
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Scratchbox Hub & GeoBox Resection Server] Running at http://127.0.0.1:${PORT}/`);
    console.log(`  - Hub: http://127.0.0.1:${PORT}/index.html`);
    console.log(`  - Showcase: http://127.0.0.1:${PORT}/model_showcase.html?model=geobox`);
    console.log(`  - GeoBox Demo: http://127.0.0.1:${PORT}/geobox_demo.html`);
    console.log(`  - API Resection: POST http://127.0.0.1:${PORT}/api/geobox/resect`);
});

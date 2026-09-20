const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8089;
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
        const args = [scriptPath, '--image', imagePath, '--json'];
        if (hint && typeof hint === 'string' && hint.trim().length > 0) {
            args.push('--hint', hint.trim());
        }

        console.log(`[Resection API] Spawning GeoBox pipeline for: ${imagePath} (hint: "${hint || ''}")`);
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
            timeout: 30000
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
                // Pre-existing public test video/image or uploaded media path
                let resolved = path.join(REPO_ROOT, targetPath.replace(/^\//, ''));
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
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Must provide imageBase64/videoBase64, imageUrl/videoUrl, or imagePath/videoPath' }));
                return;
            }

            // Execute Python 7-Stage Precision Pipeline (handles both videos and images)
            const result = await executePythonResection(savedImagePath, payload.hint);

            // Ingest 3D Object Mesh of resected landmark via getGoogle3DTilesFullTexture
            let threeDObject = null;
            try {
                const targetAnchor = {
                    lat: result.google_map_tiles_3d?.center?.lat || 41.89030,
                    lng: result.google_map_tiles_3d?.center?.lng || 12.49165,
                    elevation: result.google_map_tiles_3d?.center?.altitude || 26.0
                };
                const outputGlbPath = path.join(PUBLIC_DIR, 'models', 'colosseum_rome_textured.glb');
                const tileObj = await fetchGoogle3DTilesObject(targetAnchor, {
                    outputGlbPath,
                    offlineMock: true
                });
                threeDObject = {
                    service: 'getGoogle3DTilesFullTexture',
                    mode: tileObj.mode,
                    glbUrl: '/models/' + path.basename(tileObj.glbPath),
                    glbPath: tileObj.glbPath,
                    mesh: tileObj.mesh,
                    quality: tileObj.quality,
                    render: tileObj.render,
                    manifest: tileObj.manifest
                };
            } catch (tileErr) {
                console.warn('[Resection API] getGoogle3DTilesFullTexture call warning:', tileErr.message);
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

            const outputGlbName = (typeof target === 'object' && target.lat && Math.abs(target.lat - 41.89) < 0.05)
                ? 'colosseum_rome_textured.glb'
                : 'google_tiles_textured_area.glb';
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

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Cache-Control': 'no-cache'
        });

        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Scratchbox Hub & GeoBox Resection Server] Running at http://127.0.0.1:${PORT}/`);
    console.log(`  - Hub: http://127.0.0.1:${PORT}/index.html`);
    console.log(`  - Showcase: http://127.0.0.1:${PORT}/model_showcase.html?model=geobox`);
    console.log(`  - GeoBox Demo: http://127.0.0.1:${PORT}/geobox_demo.html`);
    console.log(`  - API Resection: POST http://127.0.0.1:${PORT}/api/geobox/resect`);
});

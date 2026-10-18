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

// TypeScript services from packages/core, loaded as CommonJS. Docker (Dockerfile.inference) compiles them into
// build/serve-public-core with `npm run build:serve-public`; a dev checkout without that build loads the TypeScript
// source through ts-node (as desktop-app's server:dev does). When neither is available the endpoint says so.
const CORE_CJS_DIR = path.join(REPO_ROOT, 'build', 'serve-public-core');
const CORE_SRC_DIR = path.join(REPO_ROOT, 'packages', 'core', 'src');
const coreModules = new Map();
let tsNodeRegistered = false;

/** A packages/core module by its path under src/ without extension, e.g. 'node/spatial/GeoBoxPrecisionResectionService'. */
function loadCoreModule(modulePath) {
    if (coreModules.has(modulePath)) return coreModules.get(modulePath);
    const built = path.join(CORE_CJS_DIR, modulePath + '.js');
    let mod;
    if (fs.existsSync(built)) {
        mod = require(built);
    } else {
        const source = path.join(CORE_SRC_DIR, modulePath + '.ts');
        if (!tsNodeRegistered) {
            let tsNode;
            try {
                tsNode = require('ts-node');
            } catch {
                throw new CoreModuleUnavailableError(modulePath, `${path.relative(REPO_ROOT, built)} is not built and ts-node is not installed to load ${path.relative(REPO_ROOT, source)}; run \`npm run build:serve-public\``);
            }
            tsNode.register({
                transpileOnly: true,
                skipProject: true,
                compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'ES2022', esModuleInterop: true, jsx: 'react-jsx' }
            });
            tsNodeRegistered = true;
        }
        mod = require(source);
    }
    coreModules.set(modulePath, mod);
    return mod;
}

class CoreModuleUnavailableError extends Error {
    constructor(modulePath, reason) {
        super(`${modulePath} is unavailable: ${reason}`);
        this.code = 'service_unavailable';
    }
}

/** HTTP status for an error thrown by a core service: typed input errors are the caller's, the rest are ours. */
function statusForError(err) {
    switch (err && err.code) {
        case 'missing_input': return 400;
        case 'location_unresolved': return 422;
        case 'service_unavailable': return 503;
        default: return 500;
    }
}

/** The request fields GeoBoxPrecisionResectionService reads, taken from the JSON body as given. */
const RESECTION_FIELDS = ['targetCoords', 'targetLandmarkName', 'cameraOpticalCenter', 'knownCoords', 'headingDeg', 'pitchDeg',
    'rollDeg', 'standoffDistanceMeters', 'points2D', 'points3D', 'verticalLines', 'imageWidthPx', 'imageHeightPx',
    'sensorFocalMm', 'sensorWidthMm', 'frustumReachMeters'];

function resectionRequestFrom(payload, mediaPath, isVideo) {
    const request = {};
    for (const field of RESECTION_FIELDS) {
        if (payload[field] !== undefined && payload[field] !== null) request[field] = payload[field];
    }
    const hint = payload.hint || payload.query || payload.text;
    if (typeof hint === 'string' && hint.trim()) request.promptHint = hint.trim();
    if (mediaPath) request[isVideo ? 'videoPath' : 'imagePath'] = mediaPath;
    return request;
}

async function fetchGoogle3DTilesObject(queryOrCoords, options = {}) {
    const mod = loadCoreModule('node/spatial/Google3DTileBlockoutPipelineService');
    if (!options.outputGlbPath) {
        throw new Error('fetchGoogle3DTilesObject needs an outputGlbPath for this extraction');
    }
    // Real Google 3D Tiles for this place or an error: no default model, no offline mock.
    const tileObj = await mod.getGoogle3DTilesFullTexture(queryOrCoords, {
        outputGlbPath: options.outputGlbPath,
        apiKey: options.apiKey
    });
    if (!tileObj || !tileObj.success || tileObj.mock) {
        throw new Error(tileObj?.error || 'The Google 3D Tiles extraction returned no tiles for this place.');
    }
    return tileObj;
}

/** A file name for a fresh extraction, keyed by the place it is for and the time it was made. */
function extractionGlbName(target, mode) {
    const key = typeof target === 'object'
        ? `${Number(target.lat).toFixed(5)}_${Number(target.lng).toFixed(5)}`
        : String(target).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'place';
    return `tiles_${key}_${mode}_${Date.now()}.glb`;
}

function getFfmpegBin() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg';
    if (fs.existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg';
    return 'ffmpeg';
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

// ── Request path & origin hardening ─────────────────────────────────────────
// Static files come from public/. The only repo-root paths served are the ones
// public/ demos load by root-relative URL: the three / 3d-tiles-renderer import
// maps, /public/... model URLs and /docs/screenshots proof images. Everything
// else at the repo root (secrets.json, .env, service-account.json, source) is not.
const REPO_ROOT_STATIC_DIRS = ['node_modules/three', 'node_modules/3d-tiles-renderer', 'public', 'docs/screenshots'];
const STATIC_ROOTS = [PUBLIC_DIR, ...REPO_ROOT_STATIC_DIRS.map((dir) => path.join(REPO_ROOT, dir))];
const SURVEY_JOB_ID_PATTERN = /^rerun-[a-z0-9]+-[a-z0-9]+$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Separator-aware containment: true when `candidate` is `root` or inside it. */
function isWithinDir(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** Resolve a user-supplied relative path strictly inside `root`; returns null on escape. */
function resolveInside(root, userPath) {
    if (typeof userPath !== 'string' || !userPath || userPath.includes('\0')) return null;
    const resolved = path.resolve(root, userPath.replace(/^[\\/]+/, ''));
    return isWithinDir(root, resolved) ? resolved : null;
}

/** True for a regular file whose real path (symlinks followed) lies inside a static root. */
function isServableFile(candidate) {
    let real;
    try {
        if (!fs.statSync(candidate).isFile()) return false;
        real = fs.realpathSync(candidate);
    } catch {
        return false;
    }
    return STATIC_ROOTS.some((root) => {
        try { return isWithinDir(fs.realpathSync(root), real); } catch { return false; }
    });
}

/** Map a request path onto a servable file, or null. Dotfiles and `..` segments are never served. */
function resolveStaticFile(reqPath) {
    if (reqPath.split(/[\\/]/).some((segment) => segment.startsWith('.'))) return null;
    const publicPath = resolveInside(PUBLIC_DIR, reqPath);
    if (!publicPath) return null;

    const relPath = reqPath.replace(/^[\\/]+/, '');
    const rootDir = REPO_ROOT_STATIC_DIRS.find((dir) => relPath.startsWith(dir + '/'));
    const baseName = path.basename(publicPath);
    const htmlName = baseName.endsWith('.html') ? baseName : baseName + '.html';
    const candidates = [
        publicPath,
        rootDir ? resolveInside(path.join(REPO_ROOT, rootDir), relPath.slice(rootDir.length + 1)) : null,
        publicPath.endsWith('.html') ? null : publicPath + '.html',
        path.join(PUBLIC_DIR, 'demos/showcase', baseName),
        path.join(PUBLIC_DIR, 'demos/showcase', htmlName),
        path.join(PUBLIC_DIR, 'demos/experiments', baseName),
        path.join(PUBLIC_DIR, 'demos/experiments', htmlName),
        path.join(PUBLIC_DIR, 'demos', baseName),
        path.join(PUBLIC_DIR, 'demos', htmlName)
    ];
    return candidates.find((candidate) => candidate && isServableFile(candidate)) || null;
}

function parseEnvList(...names) {
    const out = new Set();
    for (const name of names) {
        for (const entry of String(process.env[name] || '').split(',')) {
            const trimmed = entry.trim().replace(/\/+$/, '');
            if (trimmed) out.add(trimmed.toLowerCase());
        }
    }
    return out;
}

const ENV_ALLOWED_ORIGINS = parseEnvList('SERVE_PUBLIC_ALLOWED_ORIGINS', 'SCRATCHBOX_ALLOWED_ORIGINS');
const ENV_ALLOWED_HOSTS = parseEnvList('SERVE_PUBLIC_ALLOWED_HOSTS');

/** The port actually bound (PORT=0 picks an ephemeral one). */
function boundPort() {
    const address = server.address();
    return address ? address.port : PORT;
}

/** DNS-rebinding guard: only loopback Host headers for this server's port, or the env allowlist. */
function isAllowedHost(hostHeader) {
    if (!hostHeader) return false;
    const host = String(hostHeader).toLowerCase();
    if (ENV_ALLOWED_HOSTS.has(host)) return true;
    const m = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!m) return false;
    if (ENV_ALLOWED_HOSTS.has(m[1])) return true;
    return LOOPBACK_HOSTNAMES.has(m[1]) && (m[2] === undefined || Number(m[2]) === boundPort());
}

/** Only this server's own loopback origins (e.g. a localhost:<port> page calling 127.0.0.1:<port>), or the env allowlist. */
function isAllowedOrigin(origin) {
    if (!origin) return false;
    const normalized = String(origin).toLowerCase().replace(/\/+$/, '');
    if (ENV_ALLOWED_ORIGINS.has(normalized)) return true;
    let parsed;
    try { parsed = new URL(normalized); } catch { return false; }
    if (parsed.protocol !== 'http:') return false;
    const port = parsed.port ? Number(parsed.port) : 80;
    return LOOPBACK_HOSTNAMES.has(parsed.hostname) && port === boundPort();
}

function rejectRequest(res, status, error) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Vary': 'Origin' });
    res.end(JSON.stringify({ success: false, error }));
}

// ── API path containment ────────────────────────────────────────────────────
// API routes read media and write outputs only inside public/.
const REAL_PUBLIC_DIR = fs.realpathSync(PUBLIC_DIR);
const GLB_WRITE_DIRS = [path.join(PUBLIC_DIR, 'models'), path.join(PUBLIC_DIR, 'tiles')];
const USD_WRITE_DIRS = [path.join(PUBLIC_DIR, 'data')];
const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian

/**
 * Resolve a media path the demos send (`/videos/x.mp4`, `public/videos/x.mp4`, or an absolute
 * path the GeoBox pipeline returned) to the real path of an existing file inside public/, or null.
 */
function resolvePublicInputFile(userPath) {
    if (typeof userPath !== 'string' || !userPath || userPath.includes('\0')) return null;
    const candidates = [
        path.isAbsolute(userPath) ? path.resolve(userPath) : null,
        resolveInside(REPO_ROOT, userPath),
        resolveInside(PUBLIC_DIR, userPath)
    ];
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            if (!fs.statSync(candidate).isFile()) continue;
            const real = fs.realpathSync(candidate);
            if (isWithinDir(REAL_PUBLIC_DIR, real)) return real;
        } catch { /* missing: try the next candidate */ }
    }
    return null;
}

/** Root-relative web URL for a real path inside public/. */
function publicUrlFor(realPath) {
    return '/' + path.relative(REAL_PUBLIC_DIR, realPath).split(path.sep).join('/');
}

/**
 * Resolve a repo-relative write target (e.g. `public/models/x.glb`) inside one of `dirs` with
 * extension `ext`, or null. Dot segments, existing non-regular files (symlinks) and parent
 * directories whose real path leaves the allowed directory are refused.
 */
function resolveWriteTarget(userPath, dirs, ext) {
    const resolved = resolveInside(REPO_ROOT, userPath);
    if (!resolved || path.extname(resolved).toLowerCase() !== ext) return null;
    const dir = dirs.find((d) => isWithinDir(d, resolved) && resolved !== d);
    if (!dir || path.relative(dir, resolved).split(path.sep).some((segment) => segment.startsWith('.'))) return null;

    fs.mkdirSync(dir, { recursive: true });
    let existing = path.dirname(resolved);
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    try {
        if (!isWithinDir(fs.realpathSync(dir), fs.realpathSync(existing))) return null;
        if (!fs.lstatSync(resolved).isFile()) return null;
    } catch (err) {
        if (err.code !== 'ENOENT') return null;
    }
    return resolved;
}

const server = http.createServer(async (req, res) => {
    // DNS-rebinding guard: only answer to loopback Host headers (or the env allowlist).
    if (!isAllowedHost(req.headers.host)) {
        rejectRequest(res, 421, 'Host not allowed');
        return;
    }

    // Origin guard: echo CORS only for this server's own loopback origins (or the env
    // allowlist), and refuse any request that carries a foreign Origin.
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (origin !== undefined) {
        if (!isAllowedOrigin(origin)) {
            rejectRequest(res, 403, 'Origin not allowed');
            return;
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const urlParts = req.url.split('?');
    let reqPath;
    try {
        reqPath = decodeURI(urlParts[0]);
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('400 Malformed URL');
        return;
    }

    if (reqPath.startsWith('/api/')) {
        // Block cross-site no-Origin subresource loads (<img>, navigations) against API routes.
        const fetchSite = req.headers['sec-fetch-site'];
        if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none' && !isAllowedOrigin(origin)) {
            rejectRequest(res, 403, 'Cross-site API request rejected');
            return;
        }
        // Force a CORS preflight for state-changing calls: no "simple" text/plain, form or
        // untyped POSTs. save_glb takes a raw binary glTF body; every other POST takes JSON.
        if (req.method === 'POST') {
            const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            const expected = reqPath === '/api/save_glb' ? ['model/gltf-binary', 'application/octet-stream'] : ['application/json'];
            if (!expected.includes(contentType)) {
                rejectRequest(res, 415, `POST ${reqPath} requires Content-Type: ${expected.join(' or ')}`);
                return;
            }
        }
    }

    // Health check endpoint
    if (reqPath === '/api/geobox/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'GeoBox camera resection server', timestamp: new Date().toISOString() }));
        return;
    }

    // Camera resection: GeoBoxPrecisionResectionService places the camera from the pose evidence in the request
    // (2D-3D correspondences, a stated camera position, or a stated heading/pitch/standoff) relative to a target
    // given as coordinates or resolved with Google Places. An attached photo or video is stored and returned as
    // uploadUrl but its pixels are not analysed (result.imageAnalysed is false). Missing input is a 400, a place that
    // cannot be resolved a 422; no pose, place or metrology is made up.
    if (req.method === 'POST' && reqPath === '/api/geobox/resect') {
        try {
            let payload;
            try {
                payload = await parseBody(req);
            } catch (parseErr) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, code: 'invalid_request', error: parseErr.message }));
                return;
            }
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
                relativeUploadUrl = `/uploads/${outFilename}`;
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
                // Web path (/test_images/x.jpg), repo path (public/...) or absolute path, inside public/ only
                const resolved = resolvePublicInputFile(targetPath);
                if (!resolved) {
                    rejectRequest(res, 400, `Media file not found under public/: ${targetPath}`);
                    return;
                }
                savedImagePath = resolved;
                relativeUploadUrl = publicUrlFor(resolved);
            }

            const isVideo = Boolean(savedImagePath && /\.(mp4|mov|webm|mkv|avi)$/i.test(savedImagePath));
            let resectionModule;
            try {
                resectionModule = loadCoreModule('node/spatial/GeoBoxPrecisionResectionService');
            } catch (loadErr) {
                res.writeHead(statusForError(loadErr), { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, code: loadErr.code || 'service_unavailable', error: loadErr.message }));
                return;
            }
            let result;
            try {
                const service = new resectionModule.GeoBoxPrecisionResectionService();
                result = await service.resectImageLocation(resectionRequestFrom(payload, savedImagePath, isVideo));
            } catch (resectErr) {
                const status = statusForError(resectErr);
                if (status === 500) console.error('[Resection API] Resection failed:', resectErr);
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    code: resectErr.code || 'resection_failed',
                    error: resectErr.message || String(resectErr),
                    uploadUrl: relativeUploadUrl
                }));
                return;
            }

            // The resected target's own 3D model: Google 3D Tiles extracted fresh at its coordinates, unless the
            // request sets extract3DTiles: false. When the extraction fails there is none and the response says why;
            // no default landmark, nearby model or synthetic tile stands in.
            let threeDObject = null;
            let threeDObjectError = null;
            const center = result.googleMapTiles3DConfig && result.googleMapTiles3DConfig.center;
            if (payload.extract3DTiles === false) {
                threeDObjectError = 'Not requested (extract3DTiles: false).';
            } else if (typeof center?.lat !== 'number' || typeof center?.lng !== 'number') {
                threeDObjectError = 'The resection reported no map centre, so no 3D tiles were fetched.';
            } else {
                const targetAnchor = { lat: center.lat, lng: center.lng, ...(typeof center.altitude === 'number' ? { elevation: center.altitude } : {}) };
                try {
                    const outputGlbName = extractionGlbName(targetAnchor, 'textured');
                    const outputGlbPath = path.join(PUBLIC_DIR, 'models', outputGlbName);
                    const tileObj = await fetchGoogle3DTilesObject(targetAnchor, { outputGlbPath });
                    threeDObject = {
                        service: 'getGoogle3DTilesFullTexture',
                        mode: tileObj.mode,
                        glbUrl: '/models/' + path.basename(tileObj.glbPath),
                        glbPath: tileObj.glbPath,
                        hasLocalGlb: true,
                        geoAnchor: tileObj.geoAnchor,
                        mesh: tileObj.mesh,
                        quality: tileObj.quality,
                        manifest: tileObj.manifest
                    };
                } catch (tileErr) {
                    threeDObjectError = `Google 3D Tiles extraction failed: ${tileErr.message}`;
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                uploadUrl: relativeUploadUrl,
                is_video: isVideo,
                google_map_tiles_3d: result.googleMapTiles3DConfig || null,
                three_d_object: threeDObject,
                three_d_object_error: threeDObjectError,
                result
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
            } else {
                imgPath = resolvePublicInputFile(body.imagePath || 'test_images/the_plaza_hotel_user_photo.jpg');
                if (!imgPath) {
                    rejectRequest(res, 400, `Image not found under public/: ${body.imagePath}`);
                    return;
                }
                relativeImgUrl = publicUrlFor(imgPath);
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
            const outPath = body.outputPath
                ? resolveWriteTarget(body.outputPath, USD_WRITE_DIRS, '.usda')
                : path.join(PUBLIC_DIR, 'data', 'scene_lighting_export.usda');
            if (!outPath) {
                rejectRequest(res, 400, 'outputPath must be a .usda path under public/data/');
                return;
            }
            const { PhotometricUsdBridgeService } = require('../packages/core/dist/node/spatial/PhotometricUsdBridgeService.js');
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

            // The place the caller named (or its coordinates), or a 400: no default landmark or elevation.
            let target = queryParam;
            if (latParam !== null && lngParam !== null && !isNaN(latParam) && !isNaN(lngParam)) {
                target = { lat: latParam, lng: lngParam, ...(altParam !== null && !isNaN(altParam) ? { elevation: altParam } : {}) };
            } else if (!target) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Name a place (query) or give lat and lng.' }));
                return;
            }

            const outputGlbPath = path.join(PUBLIC_DIR, 'models', extractionGlbName(target, 'textured'));
            const tileObj = await fetchGoogle3DTilesObject(target, { outputGlbPath });

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
            const inputVideo = body.videoPath || 'public/videos/plaza_hotel_omni_15s_720p.mp4';
            const resolvedVideo = resolvePublicInputFile(inputVideo);
            if (!resolvedVideo) {
                rejectRequest(res, 400, `Video not found under public/: ${inputVideo}`);
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
            const inputVideo = body.videoPath || 'public/videos/plaza_hotel_omni_15s_720p.mp4';
            const resolvedVideo = resolvePublicInputFile(inputVideo);
            if (!resolvedVideo) {
                rejectRequest(res, 400, `Video not found under public/: ${inputVideo}`);
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
        const targetPath = resolveWriteTarget(targetRelFile, GLB_WRITE_DIRS, '.glb');
        if (!targetPath) {
            rejectRequest(res, 400, 'file must be a .glb path under public/models/ or public/tiles/');
            return;
        }

        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (buffer.length < 12 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
                rejectRequest(res, 400, 'Request body is not a binary glTF (.glb)');
                return;
            }
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
        if (SURVEY_JOB_ID_PATTERN.test(jobId) && fs.existsSync(jobFile)) {
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
    const filePath = resolveStaticFile(reqPath === '/' || reqPath === '' ? 'index.html' : reqPath);
    if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found: ' + reqPath);
        return;
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
    // PORT=0 binds an ephemeral port; report the one actually bound.
    const port = server.address().port;
    console.log(`[Scratchbox Hub & GeoBox Resection Server] Running at http://127.0.0.1:${port}/`);
    console.log(`  - Hub: http://127.0.0.1:${port}/index.html`);
    console.log(`  - Showcase: http://127.0.0.1:${port}/model_showcase.html?model=geobox`);
    console.log(`  - API Resection: POST http://127.0.0.1:${port}/api/geobox/resect`);
});

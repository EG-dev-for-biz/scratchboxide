/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * De-risking spike for `docs/processes/beautify_chained_tiles_world_pipeline.md`.
 *
 * The existing `Google3DTileBlockoutPipelineService` only exposes whole-job entry points
 * (`run` / `renderBlockoutVideo` / `fetch3DObject`): each one bakes a fixed camera path into a
 * generated runner HTML, walks it start-to-finish inside headless Chrome, encodes a video, and
 * tears the browser down. There is no "move to an arbitrary pose and give me one frame" call, so
 * the movement pipeline's premise ("a station capture is a frame grab from a live viewport") is
 * untested. This service is that missing call: one resident Chrome session with one TilesRenderer
 * kept warm, polled for on-demand poses instead of a precomputed path, so the real question —
 * does leaf-LOD settle stay cheap for a small move once the tiles around it are already warm, or
 * does every new pose pay the full settle cost — can be measured instead of assumed.
 *
 * Reuses the parent service's address/elevation resolution and local-tangent-plane transform;
 * duplicates only the headless-Chrome launch and the settle-gate constants (`stats.downloading
 * === 0 && stats.parsing === 0`), copied verbatim from `Google3DTileBlockoutPipelineService`'s
 * runner template, so a latency comparison between the two is apples-to-apples.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { geoidUndulation } from './egm96-geoid';
import { Google3DTileBlockoutPipelineService, type GeoAnchor, type TilePipelineMode, type TileLodQualityConfig } from './Google3DTileBlockoutPipelineService';
import { resolveMapsApiKey } from '../../browser/generative-canvas/services/google-maps-service';

/** One requested camera pose to capture (same 6-DoF shape as `CameraPoseFrame`, minus timing). */
export interface LivePose {
  id: string;
  position: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
  fov?: number;
}

export interface LiveCaptureResult {
  id: string;
  /** JPEG bytes of the final render. */
  jpeg: Buffer;
  /** Wall-clock time this capture's settle-gate loop actually spent waiting, in ms. */
  settleTimeMs: number;
  /** `tiles.stats.loaded` at capture time. */
  tilesLoaded: number;
  /** True when the settle gate never reached the stable-frames threshold before `maxSettleWaitMs`. */
  timedOut: boolean;
  /** Elapsed ms from this capture being requested to its result arriving (settle time plus RPC/poll overhead). */
  roundTripMs: number;
}

export interface LiveTileViewportStartRequest {
  geoAnchor: GeoAnchor;
  apiKey?: string;
  mode?: TilePipelineMode;
  lodQuality?: TileLodQualityConfig;
  chromePath?: string;
  port?: number;
  /** Reject start() if the page reports no activity within this long (default 30000). */
  startupTimeoutMs?: number;
}

const DEFAULT_STABLE_FRAMES_THRESHOLD = 15;
const DEFAULT_MAX_SETTLE_WAIT_MS = 25000;

function findChromeBinary(custom?: string): string {
  if (custom) return custom;
  const candidates = [
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    '/opt/pw-browsers/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error(`LiveTileViewportCaptureService: no headless Chrome found (tried ${candidates.join(', ')}; set CHROME_BIN)`);
  return found;
}

/**
 * One resident headless-Chrome session holding one `TilesRenderer` warm against a geo anchor.
 * `capture()` asks it to move to a pose, wait for the existing leaf-LOD settle gate, and return a
 * frame — repeatable many times without relaunching Chrome or re-streaming the tile octree root.
 */
export class LiveTileViewportCaptureService {
  private server: http.Server | null = null;
  private chrome: ChildProcess | null = null;
  private port = 0;
  private pending = new Map<string, { resolve: (r: LiveCaptureResult) => void; reject: (e: Error) => void; requestedAt: number }>();
  private queue: Array<{ id: string; position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; fov: number }> = [];
  private started = false;
  private chromeStderrTail = '';

  async start(request: LiveTileViewportStartRequest): Promise<void> {
    if (this.started) throw new Error('LiveTileViewportCaptureService.start() called twice; stop() first');
    const chromePath = findChromeBinary(request.chromePath);
    const apiKey = resolveMapsApiKey(request.apiKey);
    if (!apiKey) throw new Error('LiveTileViewportCaptureService: no Google Maps/Tiles API key configured (GOOGLE_MAPS_API_KEY / MAP_TILES_API_KEY, or pass apiKey)');

    const pipelineSvc = new Google3DTileBlockoutPipelineService();
    const geoidHeight = geoidUndulation(request.geoAnchor.lat, request.geoAnchor.lng);
    const anchor = request.geoAnchor.elevation !== undefined
      ? request.geoAnchor
      : { ...request.geoAnchor, elevation: await pipelineSvc.fetchGroundElevation(request.geoAnchor.lat, request.geoAnchor.lng, apiKey) };
    const { matrixValues } = pipelineSvc.buildLocalTransformMatrix(anchor, geoidHeight);

    const lod = request.lodQuality || {};
    const errorTarget = Math.min(lod.errorTarget ?? 0.5, 0.5);
    const resW = lod.resolutionWidth ?? 1280;
    const resH = lod.resolutionHeight ?? 720;
    const virtualW = Math.max(lod.virtualSseWidth ?? 3840, 3840);
    const virtualH = Math.max(lod.virtualSseHeight ?? 2160, 2160);
    const stableThreshold = lod.stableFramesThreshold ?? DEFAULT_STABLE_FRAMES_THRESHOLD;
    const maxSettleMs = lod.maxSettleWaitMs ?? DEFAULT_MAX_SETTLE_WAIT_MS;
    const mode = request.mode ?? 'textured';
    const startupTimeoutMs = request.startupTimeoutMs ?? 30000;

    const html = buildInteractiveRunnerHtml({ matrixValues, apiKey, mode, errorTarget, resW, resH, virtualW, virtualH, stableThreshold, maxSettleMs });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => { if (settled) return; settled = true; this.cleanupOnFailure(); reject(new Error(msg)); };

      const server = http.createServer((req, res) => {
        const reqPath = req.url?.split('?')[0] || '';

        if (reqPath === '/' || reqPath === '/live_tile_viewport_runner.html') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(html);
        }

        if (req.method === 'GET' && reqPath === '/poll') {
          const job = this.queue.shift();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(job ?? { idle: true }));
        }

        if (req.method === 'POST' && reqPath === '/result') {
          let body = '';
          req.on('data', c => { body += c; });
          req.on('end', () => {
            try {
              const payload = JSON.parse(body);
              const waiter = this.pending.get(payload.id);
              if (waiter) {
                this.pending.delete(payload.id);
                const jpeg = Buffer.from(String(payload.jpegBase64 || '').replace(/^data:image\/jpeg;base64,/, ''), 'base64');
                waiter.resolve({
                  id: payload.id,
                  jpeg,
                  settleTimeMs: Number(payload.settleTimeMs) || 0,
                  tilesLoaded: Number(payload.tilesLoaded) || 0,
                  timedOut: Boolean(payload.timedOut),
                  roundTripMs: Date.now() - waiter.requestedAt
                });
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'ok' }));
            } catch (err: any) {
              res.writeHead(400); res.end(String(err?.message || err));
            }
          });
          return;
        }

        if (req.method === 'POST' && reqPath === '/ready') {
          settled = true;
          res.writeHead(200); res.end('ok');
          resolve();
          return;
        }

        if (req.method === 'POST' && reqPath === '/client-error') {
          let body = '';
          req.on('data', c => { body += c; });
          req.on('end', () => { console.error('[LiveTileViewportCaptureService] page error:', body); res.writeHead(200); res.end('ok'); });
          return;
        }

        // Static passthrough for three / 3d-tiles-renderer (same search order as the batch pipeline).
        const cleanPath = reqPath.replace(/^\//, '');
        const candidatePaths = [
          path.join(process.cwd(), cleanPath),
          path.resolve(process.cwd(), '../', cleanPath),
          path.resolve(process.cwd(), '../../', cleanPath),
          path.resolve(__dirname, '../../../', cleanPath),
          path.resolve(__dirname, '../../../../', cleanPath),
          path.resolve(__dirname, '../../../../../', cleanPath)
        ];
        const localFile = candidatePaths.find(p => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } });
        if (!localFile) { res.writeHead(404); return res.end('Not found: ' + reqPath); }
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json' };
        res.writeHead(200, { 'Content-Type': mime[path.extname(localFile)] || 'application/octet-stream' });
        fs.createReadStream(localFile).pipe(res);
      });

      server.on('error', (err: Error) => fail(`HTTP server error: ${err.message}`));
      server.listen(request.port ?? 0, '127.0.0.1', () => {
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : (request.port ?? 0);
        this.server = server;

        const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome_live_tile_'));
        const args = [
          '--headless=new',
          `--user-data-dir=${profileDir}`,
          '--no-sandbox',
          '--no-proxy-server',
          '--proxy-bypass-list=*',
          '--use-gl=angle',
          // Headless hosts with no GPU device fail ANGLE's EGL init outright; Chrome falls back to this
          // software rasterizer on its own when a real GPU is present, so this is safe to always pass.
          '--enable-unsafe-swiftshader',
          '--run-all-compositor-stages-before-draw',
          '--disable-gpu-vsync',
          '--disable-frame-rate-limit',
          `--window-size=${resW},${resH}`,
          `http://127.0.0.1:${this.port}/`
        ];
        const cleanEnv = { ...process.env };
        for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete (cleanEnv as any)[k];

        const proc = spawn(chromePath, args, { env: cleanEnv });
        this.chrome = proc;
        proc.stderr?.on('data', (d: Buffer) => { this.chromeStderrTail = (this.chromeStderrTail + d.toString()).slice(-4000); });
        proc.on('error', (err: Error) => fail(`Headless Chrome failed to launch: ${err.message}`));
        proc.on('exit', (code, signal) => { if (!settled) fail(`Headless Chrome exited before reporting ready (code ${code}, signal ${signal})\n${this.chromeStderrTail}`); });

        setTimeout(() => fail(`Page never POSTed /ready within ${startupTimeoutMs}ms (tiles auth/network likely failing)\n${this.chromeStderrTail}`), startupTimeoutMs);
      });
    });

    this.started = true;
  }

  /** Moves the resident viewport to `pose`, waits for the settle gate, and returns one frame. */
  async capture(pose: LivePose, opts: { timeoutMs?: number } = {}): Promise<LiveCaptureResult> {
    if (!this.started || !this.server) throw new Error('LiveTileViewportCaptureService: call start() first');
    const timeoutMs = opts.timeoutMs ?? 40000;
    return new Promise<LiveCaptureResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(pose.id); reject(new Error(`capture('${pose.id}') timed out after ${timeoutMs}ms waiting for /result`)); }, timeoutMs);
      this.pending.set(pose.id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        requestedAt: Date.now()
      });
      this.queue.push({ id: pose.id, position: pose.position, target: pose.target, up: pose.up ?? [0, 1, 0], fov: pose.fov ?? 60 });
    });
  }

  /** Captures `poses` one at a time on this one resident session — the shape of a simulated walk. */
  async captureWalk(poses: LivePose[], opts: { timeoutMs?: number } = {}): Promise<LiveCaptureResult[]> {
    const out: LiveCaptureResult[] = [];
    for (const p of poses) out.push(await this.capture(p, opts));
    return out;
  }

  private cleanupOnFailure(): void {
    this.chrome?.kill('SIGKILL');
    this.server?.close();
  }

  async stop(): Promise<void> {
    this.chrome?.kill('SIGKILL');
    this.chrome = null;
    await new Promise<void>((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); });
    this.server = null;
    this.started = false;
    for (const waiter of this.pending.values()) waiter.reject(new Error('LiveTileViewportCaptureService stopped while a capture was pending'));
    this.pending.clear();
  }
}

function buildInteractiveRunnerHtml(cfg: {
  matrixValues: number[]; apiKey: string; mode: TilePipelineMode;
  errorTarget: number; resW: number; resH: number; virtualW: number; virtualH: number;
  stableThreshold: number; maxSettleMs: number;
}): string {
  const isTextured = cfg.mode === 'textured' || cfg.mode === 'full-texture' || cfg.mode === 'photoreal';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Live Tile Viewport Capture (spike)</title>
<script type="importmap">
{ "imports": {
  "three": "/node_modules/three/build/three.module.js",
  "three/addons/": "/node_modules/three/examples/jsm/",
  "3d-tiles-renderer": "/node_modules/3d-tiles-renderer/build/index.js",
  "3d-tiles-renderer/plugins": "/node_modules/3d-tiles-renderer/build/index.plugins.js"
} }
</script></head>
<body>
<script>
window.addEventListener('error', (e) => fetch('/client-error', { method: 'POST', body: String(e.message) }).catch(() => {}));
window.addEventListener('unhandledrejection', (e) => fetch('/client-error', { method: 'POST', body: String(e.reason) }).catch(() => {}));
</script>
<script type="module">
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/plugins';

const ERROR_TARGET = ${cfg.errorTarget};
const STABLE_THRESHOLD = ${cfg.stableThreshold};
const MAX_SETTLE_MS = ${cfg.maxSettleMs};
const WIDTH = ${cfg.resW}, HEIGHT = ${cfg.resH};
const VIRTUAL_W = ${cfg.virtualW}, VIRTUAL_H = ${cfg.virtualH};
const IS_TEXTURED = ${isTextured};

const scene = new THREE.Scene();
scene.background = new THREE.Color('#dce3eb');
const camera = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.5, 15000);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setSize(WIDTH, HEIGHT);
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = IS_TEXTURED ? 1.0 : 1.15;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight('#ffffff', '#94a3b8', 0.85));
const sun = new THREE.DirectionalLight('#fffaed', IS_TEXTURED ? 0.95 : 1.45);
sun.position.set(150, 320, 100);
scene.add(sun);

const localMatrix = new THREE.Matrix4();
localMatrix.set(${cfg.matrixValues.join(', ')});

const tiles = new TilesRenderer();
tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: '${cfg.apiKey}', autoRefreshToken: true, useRecommendedSettings: false }));
tiles.group.matrix.copy(localMatrix);
tiles.group.matrixAutoUpdate = false;
scene.add(tiles.group);
tiles.setCamera(camera);
tiles.setResolution(camera, VIRTUAL_W, VIRTUAL_H);
tiles.errorTarget = ERROR_TARGET;
if (tiles.lruCache) { tiles.lruCache.maxBytesSize = 4096 * 1024 * 1024; tiles.lruCache.minBytesSize = Math.floor(4096 * 1024 * 1024 * 0.8); }
if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = 32;
if (tiles.parseQueue) tiles.parseQueue.maxJobs = 16;

const sharedClayMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#dcd6cd'), roughness: 0.82, metalness: 0.02, side: THREE.FrontSide });
function applyMode(modelScene) {
  if (!modelScene) return;
  modelScene.traverse((child) => {
    if (!child.isMesh) return;
    if (!IS_TEXTURED) { child.material = sharedClayMat; return; }
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach(m => {
      if (!m) return;
      m.side = THREE.DoubleSide;
      if (m.map) { m.map.colorSpace = THREE.SRGBColorSpace; m.map.anisotropy = renderer.capabilities.getMaxAnisotropy(); m.map.generateMipmaps = true; m.map.minFilter = THREE.LinearMipmapLinearFilter; m.map.magFilter = THREE.LinearFilter; }
      m.roughness = Math.max(m.roughness ?? 0.65, 0.45);
      m.metalness = Math.min(m.metalness ?? 0.05, 0.15);
      m.needsUpdate = true;
    });
  });
}
tiles.addEventListener('load-model', (e) => { if (e && e.scene) applyMode(e.scene); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Settle gate copied verbatim (same condition, same threshold/timeout fields) from
// Google3DTileBlockoutPipelineService's runner template, for an apples-to-apples latency comparison.
async function settleAt(pose) {
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.up.set(pose.up[0], pose.up[1], pose.up[2]);
  camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
  camera.fov = pose.fov;
  camera.aspect = WIDTH / HEIGHT;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  let stableCount = 0;
  const settleStart = Date.now();
  let tilesLoaded = 0;
  let timedOut = false;
  while (true) {
    tiles.setCamera(camera);
    tiles.setResolution(camera, VIRTUAL_W, VIRTUAL_H);
    tiles.update();
    tiles.forEachLoadedModel(applyMode);
    renderer.render(scene, camera);
    const stats = tiles.stats;
    tilesLoaded = stats.loaded || 0;
    if (stats.downloading === 0 && stats.parsing === 0 && stats.loaded > 0) {
      stableCount++;
      if (stableCount >= STABLE_THRESHOLD) break;
    } else {
      stableCount = 0;
    }
    if (Date.now() - settleStart > MAX_SETTLE_MS) { timedOut = true; break; }
    await new Promise(r => { requestAnimationFrame(r); setTimeout(r, 20); });
  }
  const settleTimeMs = Date.now() - settleStart;
  tiles.forEachLoadedModel(applyMode);
  renderer.render(scene, camera);
  const jpegBase64 = renderer.domElement.toDataURL('image/jpeg', 0.92);
  return { settleTimeMs, tilesLoaded, timedOut, jpegBase64 };
}

async function pollLoop() {
  while (true) {
    let job = null;
    try {
      const res = await fetch('/poll');
      job = await res.json();
    } catch (e) {
      await sleep(250);
      continue;
    }
    if (!job || job.idle) { await sleep(100); continue; }
    try {
      const out = await settleAt(job);
      await fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, ...out }) });
    } catch (e) {
      await fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, settleTimeMs: -1, tilesLoaded: 0, timedOut: true, jpegBase64: '' }) }).catch(() => {});
    }
  }
}

fetch('/ready', { method: 'POST' }).then(() => pollLoop());
</script>
</body></html>`;
}

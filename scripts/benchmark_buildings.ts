/**
 * The building benchmark: every place in the benchmark list built uncached with pipeline K in a live app instance, the
 * same four views of each rendered, and one labelled sheet with each building's hole share, untextured share, generated
 * share and build time. Two checkouts (two branches or commits) run side by side, place by place, so both see the same
 * load. Everything is resumable: a building with a result is not built again.
 *
 *   npx vite-node scripts/benchmark_buildings.ts plan  [--places a,b]
 *   npx vite-node scripts/benchmark_buildings.ts run   --side main=<checkout> [--side feat=<checkout>] --out <dir>
 *                                                      [--places a,b] [--retry-failed] [--keep-caches] [--max-load 100]
 *   npx vite-node scripts/benchmark_buildings.ts views --out <dir>      (re-render missing views; --force all of them)
 *   npx vite-node scripts/benchmark_buildings.ts sheet --out <dir>      (the sheet from whatever results exist)
 *   npx vite-node scripts/benchmark_buildings.ts measure --glb <model>  (one model's generated share)
 *
 * Per build, for each side in turn (docs/processes/building_benchmark.md says why each step is there):
 *  1. waits while the 1-minute load average is above --max-load;
 *  2. moves the checkout's stage cache (.scratchbox/cache) aside unless this benchmark made it, so the build is uncached
 *     (an aside is kept, never deleted; the tile leaf cache in desktop-app/.scratchbox is downloaded data and stays);
 *  3. starts that checkout's own API server on free ports with a fresh token, and stops it after the build, so no
 *     in-memory state carries from one build to the next;
 *  4. runs google_3d_tiles_get_clay { query, isolate: true, pipeline: 'k' } through /gemini/tools/run-stream;
 *  5. reads the run's records: the outside check of the finished twin (hole and untextured shares), the timeline (build
 *     time), the stage statuses, the finished model; and measures the generated share from the model's extras;
 *  6. renders four views (headings 45, 135, 225, 315, pitch 15, baked texture) with the native path tracer;
 *  7. writes <out>/<side>/<slug>/result.json and one row to the checkout's ledger (benchmarks.jsonl beside builds.jsonl);
 *  8. deletes the stage cache this build made (it was set aside empty; --keep-caches moves it under <out> instead).
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from '../packages/core/src/node/3d-engine/staged-location/glb-bytes';
import { NativeTilePathTracerService } from '../packages/core/src/node/3d-engine/native-tile-path-tracer-service';

const REPO = path.resolve(__dirname, '..');
const PLACES_FILE = path.join(REPO, 'packages/core/test/fixtures/benchmark-buildings.json');
const RESULT_SCHEMA = 'scratchbox.benchmark-building/1';
const LEDGER_SCHEMA = 'scratchbox.run-ledger.benchmark/1';
/** The bench's mark on a stage cache it created: only a cache carrying it is ever deleted. */
const OWNED_MARK = '.benchmark-owned';
/** The four views: compass headings the camera looks toward, all at one pitch, framed by the tracer on the model. */
const VIEW_HEADINGS = [45, 135, 225, 315];
/**
 * Each camera is placed from the model's own box (the tracer's auto framing cut the top off slender towers): aimed at the
 * box's centre, back far enough that the box's sphere fits the narrower field of view; the sheet crops the margin.
 */
const VIEW = { pitchDeg: 15, verticalFovDeg: 35, width: 640, height: 800, spp: 16 };
const SERVER_READY_MS = 240_000;
/** A build that has not finished in this long is stopped and recorded as failed (the ESB takes about 20 minutes). */
const BUILD_LIMIT_MS = 90 * 60_000;

interface Place { slug: string; name: string; query: string; kind: string; why: string }
interface Side { label: string; checkout: string }

interface BuildResult {
    schema: typeof RESULT_SCHEMA;
    side: string;
    checkout: string;
    commit: string;
    /** True when the checkout's app code (packages/, desktop-app/) differs from its commit: the build is not of that commit alone. */
    dirtyAppCode: boolean;
    place: Place;
    atIso: string;
    /** 'complete' | 'degraded' | 'stopped' as the tool reports it; 'failed' when it threw or produced no model. */
    outcome: string;
    reason?: string;
    runId?: string;
    resolvedAddress?: string;
    /** The stage cache was empty when the build started: every stage computed, none served. */
    cacheEmptiedBeforeBuild: boolean;
    /** Stages the timeline still marks cached (an in-run reuse, e.g. a late layer waiting on an earlier one). */
    timelineCached: string[];
    buildMs?: number;
    wallMs: number;
    stages?: Record<string, string>;
    degradations?: string[];
    /** From the outside check of the finished twin (pipeline_k_visible_defects_textured, else the untextured check). */
    holeShare?: number;
    untexturedShare?: number;
    maxViewHoleShare?: number;
    maxViewUntexturedShare?: number;
    largestHoleRegionM2?: number;
    defectsFlagged?: boolean;
    defectsWhy?: string;
    generated?: GeneratedShare;
    triangles?: number;
    model?: string;
    /** The run's own count of its model calls (model_calls.json): spend where the app has a price, tokens where it has none. */
    modelCalls?: { requests: number; failed: number; estimatedUsd: number; unpriced: Array<{ model: string; promptTokens: number; outputTokens: number }> };
    views: Array<{ headingDeg: number; png: string }>;
    loadAtStart: number;
}

/**
 * How much of the building's surface is not a photo of that spot, by area, read from the model's own provenance extras:
 * the base skirt and the shell's seal (labelled generated) count whole; a rebuilt facade counts its texels filled from
 * its repeats or the nearest real texel and its windows drawn as their repeats' median. The material library's
 * roughness and normal maps (generated on every surface) are not counted: this is about the colour seen.
 */
interface GeneratedShare { share: number; areaM2: number; generatedM2: number; byKind: Record<string, number> }

// ----------------------------------------------------------------------------------------------------------------
// arguments
// ----------------------------------------------------------------------------------------------------------------

function args(): { cmd: string; flags: Map<string, string[]> } {
    const [cmd = 'plan', ...rest] = process.argv.slice(2);
    const flags = new Map<string, string[]>();
    for (let i = 0; i < rest.length; i++) {
        if (!rest[i].startsWith('--')) continue;
        const key = rest[i].slice(2);
        const value = i + 1 < rest.length && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
        flags.set(key, [...(flags.get(key) ?? []), value]);
    }
    return { cmd, flags };
}

function flag(flags: Map<string, string[]>, key: string): string | undefined {
    return flags.get(key)?.at(-1);
}

function loadPlaces(only?: string): Place[] {
    const all = (JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8')) as { places: Place[] }).places;
    if (!only) return all;
    const want = only.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = want.filter(s => !all.some(p => p.slug === s));
    if (unknown.length) throw new Error(`no benchmark place ${unknown.join(', ')}; the list: ${all.map(p => p.slug).join(', ')}`);
    return all.filter(p => want.includes(p.slug));
}

function parseSides(values: string[] | undefined): Side[] {
    if (!values?.length) throw new Error('give at least one --side <label>=<checkout path>');
    const sides = values.map(v => {
        const at = v.indexOf('=');
        if (at <= 0) throw new Error(`--side ${v}: expected <label>=<checkout path>`);
        const label = v.slice(0, at), checkout = path.resolve(v.slice(at + 1));
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(label)) throw new Error(`--side label "${label}": letters, digits, . _ - only`);
        if (!fs.existsSync(path.join(checkout, 'desktop-app', 'package.json'))) throw new Error(`${checkout} is not a Scratchbox checkout (no desktop-app/package.json)`);
        if (!fs.existsSync(path.join(checkout, 'node_modules'))) throw new Error(`${checkout} has no node_modules: run npm install there first`);
        return { label, checkout };
    });
    if (new Set(sides.map(s => s.checkout)).size !== sides.length) throw new Error('two sides share one checkout: give each its own (git worktree add)');
    return sides;
}

// ----------------------------------------------------------------------------------------------------------------
// the checkout, its cache and its server
// ----------------------------------------------------------------------------------------------------------------

function git(checkout: string, ...a: string[]): string {
    return childProcess.execFileSync('git', ['-C', checkout, ...a], { encoding: 'utf8' }).trim();
}

function describeCheckout(checkout: string): { commit: string; dirtyAppCode: boolean } {
    const commit = git(checkout, 'rev-parse', 'HEAD');
    const dirty = git(checkout, 'status', '--porcelain', '--', 'packages', 'desktop-app').split('\n').filter(l => l && !l.startsWith('??')).length > 0;
    return { commit, dirtyAppCode: dirty };
}

/** The stage cache is set aside (kept) unless this benchmark made it; then an empty one carrying the bench's mark is made. */
function emptyStageCache(checkout: string, log: (s: string) => void): void {
    const cache = path.join(checkout, '.scratchbox', 'cache');
    if (fs.existsSync(cache)) {
        if (fs.existsSync(path.join(cache, OWNED_MARK))) {
            fs.rmSync(cache, { recursive: true, force: true });
            log('removed a stage cache an interrupted benchmark build left');
        } else {
            const aside = path.join(checkout, '.scratchbox', 'cache_aside', `before-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}`);
            fs.mkdirSync(path.dirname(aside), { recursive: true });
            fs.renameSync(cache, aside);
            log(`set the existing stage cache aside (kept): ${aside}`);
        }
    }
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, OWNED_MARK), `made by scripts/benchmark_buildings.ts at ${new Date().toISOString()}\n`);
}

function dropStageCache(checkout: string, keepUnder: string | undefined): void {
    const cache = path.join(checkout, '.scratchbox', 'cache');
    if (!fs.existsSync(path.join(cache, OWNED_MARK))) return;
    if (keepUnder) {
        fs.mkdirSync(path.dirname(keepUnder), { recursive: true });
        try { fs.renameSync(cache, keepUnder); } catch { fs.cpSync(cache, keepUnder, { recursive: true }); fs.rmSync(cache, { recursive: true, force: true }); }
    } else fs.rmSync(cache, { recursive: true, force: true });
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
}

interface Server { port: number; token: string; child: childProcess.ChildProcess; stop: () => Promise<void> }

async function startServer(checkout: string, logFile: string): Promise<Server> {
    const port = await freePort(), toolsPort = await freePort();
    const token = crypto.randomBytes(24).toString('hex');
    const out = fs.openSync(logFile, 'a');
    const child = childProcess.spawn('npm', ['run', 'server:dev'], {
        cwd: path.join(checkout, 'desktop-app'),
        detached: true,
        stdio: ['ignore', out, out],
        env: {
            ...process.env,
            NODE_ENV: 'development',
            PORT: String(port),
            SCRATCHBOX_TOOLS_PORT: String(toolsPort),
            SCRATCHBOX_NO_ELECTRON: 'true',
            SCRATCHBOX_LAUNCH_TOKEN: token,
            SCRATCHBOX_NO_LAUNCH_TOKEN: '0',
            SCRATCHBOX_ALLOW_LOCAL_IP: 'true',
            SCRATCHBOX_WORKSPACE_ROOTS: checkout,
            // a single building with pipeline K, and no readings restored from the place store: nothing served from before
            SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'k',
            SCRATCHBOX_CACHE_RESTORE: 'off'
        }
    });
    const stop = async () => {
        if (child.exitCode !== null) return;
        try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
        const t = Date.now();
        while (child.exitCode === null && Date.now() - t < 15_000) await sleep(250);
        if (child.exitCode === null) try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    };
    const started = Date.now();
    while (Date.now() - started < SERVER_READY_MS) {
        if (child.exitCode !== null) throw new Error(`the API server exited with code ${child.exitCode} before it was ready (log: ${logFile})`);
        if (await healthy(port)) return { port, token, child, stop };
        await sleep(1000);
    }
    await stop();
    throw new Error(`the API server was not ready in ${SERVER_READY_MS / 1000} s (log: ${logFile})`);
}

function healthy(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, res => { res.resume(); resolve((res.statusCode ?? 500) < 500); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * One staged build through the streamed tool route. node:http, not fetch: fetch's body timeout (300 s of silence)
 * would cut a build whose texture stage reports nothing for minutes.
 */
function runBuild(server: Server, checkout: string, place: Place, progressFile: string): Promise<{ result: any; runIds: string[] }> {
    const body = JSON.stringify({ name: 'google_3d_tiles_get_clay', args: { query: place.query, isolate: true, pipeline: 'k' }, workspaceRoot: checkout });
    const runIds = new Set<string>();
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: server.port, path: '/gemini/tools/run-stream', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-scratchbox-token': server.token }
        }, res => {
            if (res.statusCode !== 200) { reject(new Error(`run-stream answered ${res.statusCode}`)); res.resume(); return; }
            let buf = '', done: any;
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buf += chunk;
                let nl: number;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
                    if (!line.trim()) continue;
                    let ev: any;
                    try { ev = JSON.parse(line); } catch { continue; }
                    const text = JSON.stringify(ev);
                    for (const m of text.matchAll(/scene-stg-([0-9a-f]{8})\b/g)) runIds.add(m[1]);
                    if (typeof ev?.stage?.runId === 'string') runIds.add(ev.stage.runId);
                    if (ev.type === 'done') done = ev.result;
                    else fs.appendFileSync(progressFile, `${new Date().toISOString()} ${ev.type === 'progress' ? ev.message : `${ev.type} ${ev.stage?.stage ?? ''} ${ev.stage?.status ?? ''}`}\n`);
                }
            });
            res.on('end', () => (done ? resolve({ result: done, runIds: [...runIds] }) : reject(new Error('the stream ended without a result'))));
            res.on('error', reject);
        });
        req.setTimeout(BUILD_LIMIT_MS, () => req.destroy(new Error(`no result in ${BUILD_LIMIT_MS / 60_000} minutes`)));
        req.on('error', reject);
        req.end(body);
    });
}

// ----------------------------------------------------------------------------------------------------------------
// reading the run
// ----------------------------------------------------------------------------------------------------------------

function readJson(file: string): any {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** The run this build made: the id the stream named, else the newest run record for this query made after it started. */
function findRun(checkout: string, named: string[], query: string, sinceMs: number): string | undefined {
    const runs = path.join(checkout, '.scratchbox', 'cache', 'staged_location', 'runs');
    for (const id of named) if (fs.existsSync(path.join(runs, id, 'stages.json'))) return id;
    if (!fs.existsSync(runs)) return undefined;
    return fs.readdirSync(runs)
        .map(id => ({ id, rec: readJson(path.join(runs, id, 'stages.json')) }))
        .filter(r => r.rec?.request?.query === query && (r.rec.createdAtMs ?? 0) >= sinceMs - 5000)
        .sort((a, b) => b.rec.createdAtMs - a.rec.createdAtMs)[0]?.id;
}

function triangleArea(a: number[], b: number[], c: number[]): number {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** The generated share of the finished model's surface (see GeneratedShare). */
function measureGenerated(glbBytes: Uint8Array): GeneratedShare & { triangles: number } {
    const glb = parseGlbBytes(glbBytes);
    const world = nodeWorldMatrices(glb.json);
    const byKind: Record<string, number> = {};
    let areaM2 = 0, generatedM2 = 0, triangles = 0;
    (glb.json.nodes ?? []).forEach((node: any, n: number) => {
        if (node.mesh === undefined) return;
        let nodeArea = 0;
        for (const prim of glb.json.meshes[node.mesh].primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pos = readAccessor(glb, prim.attributes.POSITION);
            const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : undefined;
            const count = idx ? idx.length : pos.count;
            const p = (i: number) => transformPoint(world[n], pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]);
            for (let t = 0; t + 2 < count; t += 3) {
                const i0 = idx ? idx[t] : t, i1 = idx ? idx[t + 1] : t + 1, i2 = idx ? idx[t + 2] : t + 2;
                nodeArea += triangleArea(p(i0), p(i1), p(i2));
                triangles++;
            }
        }
        areaM2 += nodeArea;
        const e = node.extras ?? {};
        let share = 0, kind = '';
        for (const [key, value] of Object.entries<any>(e)) {
            if (value?.provenance?.label === 'generated') { share = 1; kind = key; break; }
        }
        const tex = e.sbFacadeLattice?.provenance?.texture;
        if (!kind && tex) {
            const holes = tex.holes, repeats = tex.repeats;
            const total = holes?.share > 0 ? holes.texels / holes.share : undefined;
            share = Math.min(1, (holes?.label === 'generated' ? holes.share ?? 0 : 0) + (repeats?.label === 'generated' && total ? repeats.texels / total : 0));
            kind = 'sbFacadeLattice';
        }
        if (share > 0) {
            generatedM2 += share * nodeArea;
            byKind[kind] = (byKind[kind] ?? 0) + share * nodeArea;
        }
    });
    for (const k of Object.keys(byKind)) byKind[k] = Math.round(byKind[k]);
    return { share: areaM2 > 0 ? generatedM2 / areaM2 : 0, areaM2: Math.round(areaM2), generatedM2: Math.round(generatedM2), byKind, triangles };
}

/** The run's model calls, read from its copied records. */
function modelCalls(r: BuildResult, runDir: string): void {
    const m = readJson(path.join(runDir, 'model_calls.json'));
    if (!m) return;
    r.modelCalls = {
        requests: m.requests, failed: m.failed, estimatedUsd: m.estimatedUsd ?? 0,
        unpriced: (m.unpriced ?? []).map((model: string) => ({ model, promptTokens: m.byModel?.[model]?.promptTokens ?? 0, outputTokens: (m.byModel?.[model]?.outputTokens ?? 0) + (m.byModel?.[model]?.thinkingTokens ?? 0) }))
    };
}

/** The outcome and the degradations, as the tool reported them (its status, and each degradation's stage and reason). */
function fromToolResult(r: BuildResult, result: any): void {
    const payload = result?.resultPayload ?? {};
    r.outcome = typeof payload.status === 'string' ? payload.status : (result?.success ? 'complete' : 'failed');
    if (!result?.success) r.reason = result?.error?.message ?? 'the tool failed';
    if (Array.isArray(payload.degradations)) r.degradations = payload.degradations.map((d: any) => `${d.stage}: ${d.reason ?? d.reasonCode}`);
}

/** The model's world-space box (the glTF frame: +X east, +Y up, north toward -Z). */
function modelBox(glbBytes: Uint8Array): { min: number[]; max: number[] } {
    const glb = parseGlbBytes(glbBytes);
    const world = nodeWorldMatrices(glb.json);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    (glb.json.nodes ?? []).forEach((node: any, n: number) => {
        if (node.mesh === undefined) return;
        for (const prim of glb.json.meshes[node.mesh].primitives ?? []) {
            const a = glb.json.accessors[prim.attributes?.POSITION];
            if (!a?.min || !a?.max) continue;
            for (let c = 0; c < 8; c++) {
                const p = transformPoint(world[n], c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]);
                for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
            }
        }
    });
    return { min, max };
}

/** A camera looking toward a compass heading (clockwise from north) at VIEW's pitch, framing the box's sphere. */
function viewCamera(box: { min: number[]; max: number[] }, headingDeg: number) {
    const centre = [0, 1, 2].map(k => (box.min[k] + box.max[k]) / 2) as [number, number, number];
    const radius = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2;
    const h = headingDeg * Math.PI / 180, p = VIEW.pitchDeg * Math.PI / 180;
    const vFov = VIEW.verticalFovDeg * Math.PI / 180, hFov = 2 * Math.atan(Math.tan(vFov / 2) * VIEW.width / VIEW.height);
    const distance = 1.05 * radius / Math.sin(Math.min(vFov, hFov) / 2);
    const look = [Math.sin(h) * Math.cos(p), -Math.sin(p), -Math.cos(h) * Math.cos(p)];
    const position = centre.map((c, k) => c - look[k] * distance) as [number, number, number];
    return { position, target: centre, verticalFovDeg: VIEW.verticalFovDeg };
}

async function renderViews(glbPath: string, dir: string, log: (s: string) => void, force = false): Promise<Array<{ headingDeg: number; png: string }>> {
    const tracer = new NativeTilePathTracerService();
    const box = modelBox(fs.readFileSync(glbPath));
    const views: Array<{ headingDeg: number; png: string }> = [];
    for (const headingDeg of VIEW_HEADINGS) {
        const png = path.join(dir, `view_${headingDeg}.png`);
        if (force || !fs.existsSync(png)) {
            const work = path.join(dir, `.trace_${headingDeg}`);
            const r = await tracer.render({
                glbPath, outputDir: work,
                // a fixed sun: baked mode shows the texture as captured, so the sun only shades the ground-free studio
                sun: { elevationDeg: 45, azimuthDeg: 135 },
                width: VIEW.width, height: VIEW.height, samplesPerPixel: VIEW.spp, maxBounces: 2, shadingMode: 'baked', denoise: true, groundPlane: false,
                camera: viewCamera(box, headingDeg)
            });
            if (!r.success || !fs.existsSync(r.beautyPngPath)) { log(`view ${headingDeg}: the tracer failed`); continue; }
            fs.copyFileSync(r.beautyPngPath, png);
            fs.rmSync(work, { recursive: true, force: true });
        }
        views.push({ headingDeg, png: path.relative(dir, png) });
    }
    return views;
}

// ----------------------------------------------------------------------------------------------------------------
// one build
// ----------------------------------------------------------------------------------------------------------------

async function buildOne(side: Side, place: Place, outDir: string, opts: { keepCaches: boolean; maxLoad: number }): Promise<BuildResult> {
    const dir = path.join(outDir, side.label, place.slug);
    fs.mkdirSync(dir, { recursive: true });
    const log = (s: string) => { const line = `${new Date().toISOString()} [${side.label}/${place.slug}] ${s}`; console.log(line); fs.appendFileSync(path.join(dir, 'bench.log'), `${line}\n`); };
    while (os.loadavg()[0] > opts.maxLoad) { log(`load ${os.loadavg()[0].toFixed(0)} above ${opts.maxLoad}: waiting`); await sleep(60_000); }
    const loadAtStart = os.loadavg()[0];
    const { commit, dirtyAppCode } = describeCheckout(side.checkout);
    const base: BuildResult = {
        schema: RESULT_SCHEMA, side: side.label, checkout: side.checkout, commit, dirtyAppCode, place, atIso: new Date().toISOString(),
        outcome: 'failed', cacheEmptiedBeforeBuild: false, timelineCached: [], wallMs: 0, views: [], loadAtStart: Math.round(loadAtStart)
    };
    emptyStageCache(side.checkout, log);
    base.cacheEmptiedBeforeBuild = true;
    log(`building at ${commit.slice(0, 8)}${dirtyAppCode ? ' (app code has uncommitted changes)' : ''}, load ${loadAtStart.toFixed(0)}`);
    const started = Date.now();
    let server: Server | undefined;
    let runIds: string[] = [];
    try {
        server = await startServer(side.checkout, path.join(dir, 'server.log'));
        const out = await runBuild(server, side.checkout, place, path.join(dir, 'progress.log'));
        runIds = out.runIds;
        fs.writeFileSync(path.join(dir, 'tool_result.json'), JSON.stringify(out.result, null, 1));
        fromToolResult(base, out.result);
    } catch (err) {
        base.reason = (err as Error).message;
    } finally {
        await server?.stop();
    }
    base.wallMs = Date.now() - started;
    const runId = findRun(side.checkout, runIds, place.query, started);
    if (runId) {
        base.runId = runId;
        const run = path.join(side.checkout, '.scratchbox', 'cache', 'staged_location', 'runs', runId);
        fs.cpSync(run, path.join(dir, 'run'), { recursive: true });
        modelCalls(base, path.join(dir, 'run'));
        const rec = readJson(path.join(run, 'stages.json'));
        base.resolvedAddress = rec?.place?.formattedAddress;
        base.stages = rec?.statuses;
        const timeline = fs.existsSync(path.join(run, 'timeline.jsonl')) ? fs.readFileSync(path.join(run, 'timeline.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean) : [];
        const finish = timeline.find((t: any) => t.stage === 'finish');
        if (finish) base.buildMs = finish.tMs;
        base.timelineCached = timeline.filter((t: any) => t.cached && t.stage !== 'finish').map((t: any) => t.stage);
        const seen = readJson(path.join(run, 'pipeline_k_visible_defects_textured.json')) ?? readJson(path.join(run, 'pipeline_k_visible_defects.json'));
        if (seen) Object.assign(base, {
            holeShare: seen.holeShare, untexturedShare: seen.clayShare, maxViewHoleShare: seen.maxViewHoleShare, maxViewUntexturedShare: seen.maxViewClayShare,
            largestHoleRegionM2: seen.largestHoleRegionM2, defectsFlagged: seen.flagged, defectsWhy: seen.why
        });
        const model = readJson(path.join(run, 'pipeline_k_model.json'));
        if (model?.model && fs.existsSync(model.model)) {
            base.model = model.url ?? model.model;
            const g = measureGenerated(fs.readFileSync(model.model));
            base.generated = { share: g.share, areaM2: g.areaM2, generatedM2: g.generatedM2, byKind: g.byKind };
            base.triangles = g.triangles;
            base.views = await renderViews(model.model, dir, log);
        } else {
            base.outcome = 'failed';
            base.reason = base.reason ?? 'the build produced no pipeline K model (no pipeline_k_model.json)';
        }
    } else base.reason = base.reason ?? 'no run record was written';
    dropStageCache(side.checkout, opts.keepCaches ? path.join(dir, 'cache') : undefined);
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(base, null, 1));
    appendLedger(side.checkout, base, path.join(dir, 'result.json'));
    log(`${base.outcome}${base.reason ? ` (${base.reason})` : ''}: holes ${pct(base.holeShare)}, untextured ${pct(base.untexturedShare)}, generated ${pct(base.generated?.share)}, ${base.buildMs ? (base.buildMs / 60_000).toFixed(1) : '?'} min`);
    return base;
}

/** One row per build in the checkout's ledger directory (the run ledger's, SCRATCHBOX_LEDGER_DIR when set), joinable on runId. */
function appendLedger(checkout: string, r: BuildResult, resultFile: string): void {
    const dir = process.env.SCRATCHBOX_LEDGER_DIR ? path.resolve(process.env.SCRATCHBOX_LEDGER_DIR) : path.join(checkout, '.scratchbox', 'ledger');
    try {
        fs.mkdirSync(dir, { recursive: true });
        const row = {
            schema: LEDGER_SCHEMA, atMs: Date.now(), atIso: new Date().toISOString(), runId: r.runId, outcome: r.outcome, reason: r.reason,
            place: { slug: r.place.slug, query: r.place.query, resolvedAddress: r.resolvedAddress },
            arm: { pipeline: 'k', isolate: true, side: r.side, commit: r.commit, dirtyAppCode: r.dirtyAppCode },
            features: {
                holeShare: r.holeShare, untexturedShare: r.untexturedShare, maxViewHoleShare: r.maxViewHoleShare, maxViewUntexturedShare: r.maxViewUntexturedShare,
                largestHoleRegionM2: r.largestHoleRegionM2, generatedShare: r.generated?.share, surfaceAreaM2: r.generated?.areaM2, triangles: r.triangles,
                buildMs: r.buildMs, wallMs: r.wallMs, loadAtStart: r.loadAtStart,
                modelRequests: r.modelCalls?.requests, modelFailed: r.modelCalls?.failed, modelUsd: r.modelCalls?.estimatedUsd, unpricedModels: r.modelCalls?.unpriced
            },
            decision: { uncached: r.cacheEmptiedBeforeBuild, timelineCached: r.timelineCached, degraded: r.degradations ?? [], defectsFlagged: r.defectsFlagged },
            proof: { result: resultFile, runRecord: r.runId ? path.join(path.dirname(resultFile), 'run', 'stages.json') : undefined, model: r.model }
        };
        fs.appendFileSync(path.join(dir, 'benchmarks.jsonl'), `${JSON.stringify(row)}\n`, { flag: 'a' });
    } catch (err) {
        console.warn(`ledger row not written: ${(err as Error).message}`);
    }
}

const pct = (v: number | undefined) => (v === undefined ? '?' : `${(v * 100).toFixed(2)}%`);

// ----------------------------------------------------------------------------------------------------------------
// commands
// ----------------------------------------------------------------------------------------------------------------

function results(outDir: string): BuildResult[] {
    const out: BuildResult[] = [];
    if (!fs.existsSync(outDir)) return out;
    for (const side of fs.readdirSync(outDir)) {
        const sideDir = path.join(outDir, side);
        if (!fs.statSync(sideDir).isDirectory()) continue;
        for (const slug of fs.readdirSync(sideDir)) {
            const r = readJson(path.join(sideDir, slug, 'result.json'));
            if (r?.schema === RESULT_SCHEMA) out.push(r);
        }
    }
    return out;
}

function sheet(outDir: string, places: Place[]): void {
    // results written before fromToolResult existed (or by an older copy of this script) are read again from the tool's own answer
    for (const r of results(outDir)) {
        const dir = path.join(outDir, r.side, r.place.slug);
        const tool = readJson(path.join(dir, 'tool_result.json'));
        if (!tool || r.outcome === 'failed' && !r.runId) continue;
        const before = JSON.stringify([r.outcome, r.degradations, r.modelCalls]);
        fromToolResult(r, tool);
        if (!r.model && r.outcome !== 'failed') r.outcome = 'failed';
        modelCalls(r, path.join(dir, 'run'));
        if (JSON.stringify([r.outcome, r.degradations, r.modelCalls]) !== before) fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r, null, 1));
    }
    const sides = readJson(path.join(outDir, 'sides.json')) as Side[] | undefined;
    const manifest = { places: places.map(p => p.slug), sides: sides?.map(s => s.label) ?? [...new Set(results(outDir).map(r => r.side))], results: results(outDir) };
    fs.writeFileSync(path.join(outDir, 'sheet.json'), JSON.stringify(manifest, null, 1));
    childProcess.execFileSync('python3', [path.join(REPO, 'scripts', 'benchmark_buildings_sheet.py'), outDir], { stdio: 'inherit' });
}

async function main(): Promise<void> {
    const { cmd, flags } = args();
    const places = loadPlaces(flag(flags, 'places'));
    if (cmd === 'plan') {
        for (const p of places) console.log(`${p.slug.padEnd(14)} ${p.kind.padEnd(48)} ${p.query}\n${''.padEnd(15)}${p.why}`);
        console.log(`\n${places.length} buildings a side. Each is one uncached pipeline K build (5-25 min; the ESB about 20) plus four path-traced views (about 1 min).`);
        return;
    }
    const outDir = path.resolve(flag(flags, 'out') ?? path.join(REPO, '.scratchbox', 'benchmarks', 'buildings'));
    fs.mkdirSync(outDir, { recursive: true });
    if (cmd === 'sheet') return sheet(outDir, places);
    if (cmd === 'measure') {
        console.log(JSON.stringify(measureGenerated(fs.readFileSync(path.resolve(flag(flags, 'glb') ?? '')))));
        return;
    }
    if (cmd === 'views') {
        for (const r of results(outDir)) {
            const dir = path.join(outDir, r.side, r.place.slug);
            // the build's cache copy when it was kept, else the copy the build published under the checkout's public/
            const note = readJson(path.join(dir, 'run', 'pipeline_k_model.json'));
            const model = [note?.model, ...(note?.url ? [path.join(r.checkout, 'public', note.url), path.join(r.checkout, 'desktop-app', 'public', note.url)] : [])].find(f => f && fs.existsSync(f));
            if (!model) { console.log(`${r.side}/${r.place.slug}: its model is gone; nothing to render`); continue; }
            r.views = await renderViews(model, dir, s => console.log(`${r.side}/${r.place.slug}: ${s}`), flags.has('force'));
            fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r, null, 1));
        }
        return sheet(outDir, places);
    }
    if (cmd !== 'run') throw new Error(`unknown command ${cmd}: plan | run | views | sheet | measure`);
    const sides = parseSides(flags.get('side'));
    fs.writeFileSync(path.join(outDir, 'sides.json'), JSON.stringify(sides, null, 1));
    const opts = { keepCaches: flags.has('keep-caches'), maxLoad: Number(flag(flags, 'max-load') ?? 100) };
    const retryFailed = flags.has('retry-failed');
    // place by place, each side in turn, so the two sides of a comparison are built minutes apart under the same load
    for (const place of places) {
        for (const side of sides) {
            const prior = readJson(path.join(outDir, side.label, place.slug, 'result.json'));
            if (prior?.schema === RESULT_SCHEMA && !(retryFailed && prior.outcome === 'failed')) {
                console.log(`[${side.label}/${place.slug}] done before (${prior.outcome}); skipped`);
                continue;
            }
            await buildOne(side, place, outDir, opts);
            sheet(outDir, places);
        }
    }
    sheet(outDir, places);
}

main().catch(err => { console.error(err); process.exit(1); });

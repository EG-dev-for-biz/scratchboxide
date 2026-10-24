/**
 * Staged-build record/replay harness (dev tool, not shipped).
 *
 * Serves a staged location build's two network inputs from recordings, so builds at different commits, or several
 * builds in one process, run on identical evidence:
 * - the vision client: each `models.generateContent` / `generateContentStream` call is keyed by its normalised content
 *   (images by their pixels, without the JPEG APP segments) and answered from `<REC>/vision/<key>.json`;
 * - the Street View grounding images: each `retrieveGroundingImage` request is keyed by its view and answered from
 *   `<REC>/grounding/<key>.{json,bin}`.
 * On a miss the call goes live and is recorded (`SCRATCHBOX_REPLAY_MODE=record`, the default) or throws
 * (`SCRATCHBOX_REPLAY_MODE=strict`, no billed calls at all). An old single-call survey recording answers the
 * per-face survey by its image captions.
 *
 * Two ways to use it:
 * 1. Preload into any process, e.g. the API server, so the real chat route runs on recordings:
 *      SCRATCHBOX_REPLAY_DIR=<rec> node --expose-gc -r ts-node/register -r ./scripts/dev/staged-replay.ts server/index.ts
 *    `kill -USR2 <pid>` then forces a GC and logs the heap (`[staged-replay] heap ...`), and writes a heap snapshot
 *    when SCRATCHBOX_HEAP_SNAPSHOT_DIR is set.
 * 2. Run builds headless through the tool entry the server uses (fresh dependencies per build, as in the server):
 *      SCRATCHBOX_REPLAY_DIR=<rec> SCRATCHBOX_ROOT=<worktree> node --expose-gc -r ts-node/register \
 *        scripts/dev/staged-replay.ts --runs 3 --query "Washington Square Arch" [--isolate false] [--procedural true]
 *    The run-variant stage caches (survey .. textures) are cleared before each build after the first; the tiles and
 *    the geocode stay cached. Prints the heap after a forced GC after each build and the peak heap.
 *
 * ts-node options the server uses: TS_NODE_TRANSPILE_ONLY=1 TS_NODE_SKIP_PROJECT=1
 * TS_NODE_COMPILER_OPTIONS='{"target":"ES2022","module":"commonjs","moduleResolution":"node","esModuleInterop":true}'.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const sha = (b: crypto.BinaryLike): string => crypto.createHash('sha256').update(b).digest('hex');

/** A JPEG without its APP/COM segments, so the same pixels with other metadata give the same key. */
export function stripJpegAppSegments(buf: Buffer): Buffer {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
    const out: Buffer[] = [buf.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= buf.length && buf[i] === 0xff) {
        const m = buf[i + 1];
        if (m === 0xda) { out.push(buf.subarray(i)); return Buffer.concat(out); }
        const len = buf.readUInt16BE(i + 2);
        if (!((m >= 0xe0 && m <= 0xef) || m === 0xfe)) out.push(buf.subarray(i, i + 2 + len));
        i += 2 + len;
    }
    return buf;
}

function normalise(v: Json): Json {
    if (Array.isArray(v)) return v.map(normalise);
    if (v && typeof v === 'object') {
        if (v.inlineData) return { img: sha(stripJpegAppSegments(Buffer.from(v.inlineData.data, 'base64'))), mime: v.inlineData.mimeType };
        const o: Json = {};
        for (const k of Object.keys(v).sort()) {
            if (k === 'abortSignal' || k === 'httpOptions') continue;
            o[k] = normalise(v[k]);
        }
        return o;
    }
    return v;
}

const textsOf = (contents: Json): string[] => (Array.isArray(contents) ? contents : [contents]).flatMap((c: Json) =>
    (c?.parts ?? []).filter((p: Json) => typeof p.text === 'string').map((p: Json) => p.text as string));

/** The SDK response's `text` getter (its non-thought text parts joined), which a JSON copy of the response loses. */
function withText(response: Json): Json {
    if (response && typeof response === 'object' && !Object.getOwnPropertyDescriptor(response, 'text')) {
        Object.defineProperty(response, 'text', { get: () => (response.candidates?.[0]?.content?.parts ?? []).filter((p: Json) => typeof p.text === 'string' && !p.thought).map((p: Json) => p.text).join('') || undefined, enumerable: false });
    }
    return response;
}

export interface ReplayStats { visionHit: number; visionMiss: number; visionBridged: number; groundingHit: number; groundingMiss: number }

export interface ReplayOptions { dir: string; mode?: 'record' | 'strict'; delayMs?: number }

export class StagedReplay {
    readonly stats: ReplayStats = { visionHit: 0, visionMiss: 0, visionBridged: 0, groundingHit: 0, groundingMiss: 0 };
    private readonly mode: 'record' | 'strict';

    constructor(private readonly opts: ReplayOptions) {
        this.mode = opts.mode ?? 'record';
        fs.mkdirSync(path.join(opts.dir, 'vision'), { recursive: true });
        fs.mkdirSync(path.join(opts.dir, 'grounding'), { recursive: true });
    }

    /** An old single-call survey reply answering a per-face survey request, matched by the image captions. */
    private bridgeSurvey(params: Json): Json | undefined {
        const texts = textsOf(params.contents);
        if (!texts[0]?.startsWith('You are surveying one real structure')) return undefined;
        const cap = /^\[(\d+)\] (Google Street View image .*?), (\d+) × (\d+) px\.$/;
        const want = texts.map(t => cap.exec(t)).filter((m): m is RegExpExecArray => !!m);
        const faces: Json[] = [];
        const dir = path.join(this.opts.dir, 'vision');
        for (const w of want) {
            let found: Json;
            for (const f of fs.readdirSync(dir)) {
                const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                if (!r.texts?.[0]?.startsWith('You are surveying one real structure')) continue;
                const c = r.texts.map((t: string) => cap.exec(t)).filter(Boolean).find((x: RegExpExecArray) => x[2] === w[2]);
                if (!c) continue;
                let reply: Json;
                try { reply = JSON.parse(r.response.candidates[0].content.parts.map((p: Json) => p.text ?? '').join('')); } catch { continue; }
                const face = reply.faces?.find((x: Json) => x.image === Number(c[1]));
                if (face) { found = { ...face, image: Number(w[1]) }; break; }
            }
            if (!found) return undefined;
            faces.push(found);
        }
        return { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ faces }) }] }, finishReason: 'STOP' }], usageMetadata: {} };
    }

    wrapGenAiClient<T extends object>(client: T): T {
        const models = (client as Json).models;
        if (!models || (client as Json).__stagedReplay) return client;
        const live = async (params: Json, stream: boolean): Promise<Json> => {
            if (stream && models.generateContentStream) {
                let text = '';
                let last: Json;
                for await (const ch of await models.generateContentStream.call(models, params)) {
                    for (const p of ch.candidates?.[0]?.content?.parts ?? []) if (typeof p.text === 'string' && !p.thought) text += p.text;
                    last = ch;
                }
                const lc = last?.candidates?.[0] ?? {};
                return { candidates: [{ ...JSON.parse(JSON.stringify(lc)), content: { role: 'model', parts: [{ text }] } }], usageMetadata: last?.usageMetadata };
            }
            return JSON.parse(JSON.stringify(await models.generateContent.call(models, params)));
        };
        const serve = async (params: Json, stream: boolean): Promise<Json> => {
            const key = sha(JSON.stringify(normalise({ model: params.model, contents: params.contents, config: params.config })));
            const file = path.join(this.opts.dir, 'vision', `${key}.json`);
            if (fs.existsSync(file)) {
                this.stats.visionHit++;
                if (this.opts.delayMs) await new Promise(r => setTimeout(r, this.opts.delayMs));
                return withText(JSON.parse(fs.readFileSync(file, 'utf8')).response);
            }
            const bridged = this.bridgeSurvey(params);
            if (bridged) { this.stats.visionBridged++; return withText(bridged); }
            this.stats.visionMiss++;
            if (this.mode === 'strict') throw new Error(`staged replay: no recording for a ${params.model} call (strict)`);
            const response = await live(params, stream);
            const fr = response.candidates?.[0]?.finishReason;
            if (!fr || fr === 'STOP') fs.writeFileSync(file, JSON.stringify({ model: params.model, texts: textsOf(params.contents), response }));
            return withText(response);
        };
        const wrappedModels = new Proxy(models, {
            get: (t, p) => {
                if (p === 'generateContent') return (params: Json) => serve(params, false);
                if (p === 'generateContentStream' && t.generateContentStream) {
                    return async (params: Json) => { const r = await serve(params, true); return (async function* () { yield r; })(); };
                }
                const v = t[p];
                return typeof v === 'function' ? v.bind(t) : v;
            }
        });
        return new Proxy(client, { get: (t, p) => (p === 'models' ? wrappedModels : p === '__stagedReplay' ? true : (t as Json)[p]) });
    }

    wrapGrounding<T extends object>(service: T): T {
        return new Proxy(service, {
            get: (t: Json, p) => {
                if (p !== 'retrieveGroundingImage') return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
                return async (req: Json, signal?: AbortSignal) => {
                    const key = sha(JSON.stringify([req.panoId, req.headingDegree, req.pitchDegree, req.fovDegree, req.aspectRatio ?? null, req.widthPx ?? null, req.heightPx ?? null]));
                    const meta = path.join(this.opts.dir, 'grounding', `${key}.json`);
                    const img = path.join(this.opts.dir, 'grounding', `${key}.bin`);
                    if (fs.existsSync(meta)) { this.stats.groundingHit++; return { ...JSON.parse(fs.readFileSync(meta, 'utf8')), image: fs.readFileSync(img) }; }
                    this.stats.groundingMiss++;
                    if (this.mode === 'strict') throw new Error('staged replay: no recording for a Street View grounding image (strict)');
                    const r = await t.retrieveGroundingImage(req, signal);
                    const { image, ...rest } = r;
                    fs.writeFileSync(img, image);
                    fs.writeFileSync(meta, JSON.stringify(rest));
                    return r;
                };
            }
        }) as T;
    }

    /** Patch the app's vision client factory and Street View grounding factory in this process. */
    install(): void {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { GeminiClient } = require('../../packages/core/src/node/gemini/gemini-client');
        const original = GeminiClient.prototype.getGenAIClient;
        const self = this;
        GeminiClient.prototype.getGenAIClient = async function (this: unknown, ...args: unknown[]) {
            const c = await original.apply(this, args);
            return c ? self.wrapGenAiClient(c) : c;
        };
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sv = require('../../packages/core/src/node/spatial/StreetViewGroundingImageService');
        const factory = sv.createStreetViewGroundingImageService;
        sv.createStreetViewGroundingImageService = (...args: unknown[]) => self.wrapGrounding(factory(...args));
    }
}

/** Force a GC (needs --expose-gc) and return heapUsed in MB. */
export function heapAfterGcMB(): number {
    (global as unknown as { gc?: () => void }).gc?.();
    (global as unknown as { gc?: () => void }).gc?.();
    return Math.round(process.memoryUsage().heapUsed / 1e6);
}

const memLine = (): string => {
    const m = process.memoryUsage();
    return `rss ${Math.round(m.rss / 1e6)} MB, external ${Math.round(m.external / 1e6)} MB (array buffers ${Math.round(m.arrayBuffers / 1e6)} MB)`;
};

function installHeapSignal(): void {
    process.on('SIGUSR2', () => {
        const mb = heapAfterGcMB();
        const dir = process.env.SCRATCHBOX_HEAP_SNAPSHOT_DIR;
        let file = '';
        if (dir) { fs.mkdirSync(dir, { recursive: true }); file = v8.writeHeapSnapshot(path.join(dir, `server-${Date.now()}.heapsnapshot`)); }
        console.log(`[staged-replay] heap ${mb} MB after GC, ${memLine()}${file ? `, snapshot ${file}` : ''}, replay ${JSON.stringify(active?.stats)}`);
    });
    // SCRATCHBOX_HEAP_SAMPLE_MS: log the live heap whenever it moved by 100 MB since the last line
    const every = Number(process.env.SCRATCHBOX_HEAP_SAMPLE_MS ?? 0);
    if (every > 0) {
        let last = 0;
        setInterval(() => {
            const h = process.memoryUsage().heapUsed;
            if (Math.abs(h - last) >= 1e8) { last = h; console.log(`[staged-replay] sample heap ${Math.round(h / 1e6)} MB, ${memLine()}`); }
        }, every).unref();
    }
}

const RUN_VARIANT_STAGES = ['survey', 'evidence', 'vision', 'vision-reply', 'figures', 'textures', 'grammar'];

async function runHeadless(argv: string[]): Promise<void> {
    const arg = (name: string, dflt: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
    const runs = Number(arg('runs', '1'));
    const query = arg('query', 'Washington Square Arch');
    const root = process.env.SCRATCHBOX_ROOT || process.cwd();
    // the server loads the Maps key from secrets.json itself; headless, pano discovery needs it in the environment
    if (!process.env.GOOGLE_MAPS_API_KEY) {
        try {
            const key = JSON.parse(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8')).GOOGLE_MAPS_API_KEY;
            if (key) process.env.GOOGLE_MAPS_API_KEY = key;
        } catch { /* no secrets: only the recordings answer */ }
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runStagedLocationTool } = require('../../packages/core/src/node/3d-engine/staged-location/staged-location-tool');
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 500);
    const heaps: number[] = [];
    for (let k = 0; k < runs; k++) {
        if (k) for (const d of RUN_VARIANT_STAGES) fs.rmSync(path.join(root, '.scratchbox/cache/staged_location', d), { recursive: true, force: true });
        const t0 = Date.now();
        // --procedural true: the 3D Building button's request (isolate + pipeline G), so a benchmark build runs headless
        const out = await runStagedLocationTool('google_3d_tiles_get_clay', { query, isolate: arg('isolate', 'true') !== 'false', trees: true, ...(arg('procedural', 'false') === 'true' ? { procedural: true } : {}) }, {
            reportProgress: () => undefined, emitStage: () => undefined
        });
        heaps.push(heapAfterGcMB());
        console.log(`[staged-replay] build ${k + 1}: ${((Date.now() - t0) / 1000).toFixed(0)} s, success ${out.resultPayload?.success}, heap ${heaps[k]} MB after GC`);
        if (process.env.SCRATCHBOX_REPLAY_PRINT_DIGEST === '1') {
            const ds = ((out.resultPayload as Json)?.degradations ?? []) as Json[];
            for (const d of ds) console.log(`  degraded ${d.stage}: ${String(d.reason ?? d.code ?? '').slice(0, 240)}`);
        }
    }
    clearInterval(timer);
    console.log(`[staged-replay] RESULT ${JSON.stringify({ heapAfterGcMB: heaps, peakHeapMB: Math.round(peak / 1e6), stats: active?.stats })}`);
}

let active: StagedReplay | undefined;
if (process.env.SCRATCHBOX_REPLAY_DIR) {
    active = new StagedReplay({
        dir: process.env.SCRATCHBOX_REPLAY_DIR,
        mode: process.env.SCRATCHBOX_REPLAY_MODE === 'strict' ? 'strict' : 'record',
        delayMs: Number(process.env.SCRATCHBOX_REPLAY_DELAY_MS ?? 0)
    });
    active.install();
    installHeapSignal();
    process.on('exit', () => console.log(`[staged-replay] ${JSON.stringify(active?.stats)}`));
}

if (require.main === module) {
    runHeadless(process.argv.slice(2)).then(() => process.exit(0), err => { console.error('[staged-replay] FAILED', err); process.exit(1); });
}

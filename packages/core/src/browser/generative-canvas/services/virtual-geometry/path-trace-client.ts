/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The client side of a progressive Metal path tracing session (/3d/path-trace): opens it, sends a view whenever
 * the camera moves, polls the newest frame and draws it on an overlay canvas, and renders stills. Shared by the
 * virtual geometry viewport and the 3D scene viewport, which differ only in where the file and the camera come from.
 */

/** What the overlay knows about its session, for a HUD. */
export interface PathTraceStatus {
    device: string;
    triangles: number;
    clusters: number;
    spp: number;
    targetSpp: number;
    rays: number;
    gpuMs: number;
    width: number;
    height: number;
    materials: string;
    denoised: boolean;
    denoiseMs: number;
    /** Pixels whose illumination came from the previous view (temporal reuse). */
    historyPixels: number;
    /** Size the frame was traced at before MetalFX scaled it to width x height. */
    renderWidth: number;
    renderHeight: number;
    upscaleMs: number;
    message?: string;
}

/** A camera in the traced file's coordinates (the source GLB's, less the file's origin). */
export interface PathTraceView {
    eye: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fovYDeg: number;
}

export interface PathTraceOverlayOptions {
    overlay: HTMLCanvasElement;
    /** Body of POST /open (sbvgUrl with sourceGlbPath or snapshotId, lighting). */
    open: Record<string, unknown>;
    /** The current camera, or null while there is none. */
    getView: () => PathTraceView | null;
    targetSpp: number;
    /**
     * Fraction of the displayed size to trace (0.25 to 1; MetalFX scales the frame up). Unset, the trace keeps to
     * about TRACE_PIXEL_BUDGET pixels whatever the display, so a 4K view costs what a 1280-wide one did.
     */
    renderScale?: number;
    /** LOD error threshold in pixels, read for every view. */
    thresholdPx?: () => number;
    onStatus: (status: PathTraceStatus) => void;
    /** Called once the session is open, before the first view (e.g. to pause the viewport's own renderer). */
    onOpened?: (opened: PathTraceOpened) => void;
    /**
     * Called with true when the camera (or the view's size) starts changing, and with false once the first frame of
     * the view it came to rest at is drawn. While it moves no view is sent: the viewport's own renderer should show
     * the motion, and the traced frame comes back when the camera has been still for REST_MS.
     */
    onMotion?: (moving: boolean) => void;
}

/** How long the camera must hold still before a traced view is sent for it. */
export const REST_MS = 100;

export interface PathTraceOpened {
    sessionId: string;
    device: string;
    origin: [number, number, number];
    materials: { source: 'glb' | 'uniform'; count: number; texturesUploaded: number };
}

export interface PathTraceStillOptions {
    /** Output size; default the displayed frame's size. */
    width?: number;
    height?: number;
    samplesPerPixel?: number;
    workspaceRoot?: string;
    name?: string;
}

export interface PathTraceStill {
    path: string;
    stats: { width: number; height: number; samplesPerPixel: number; renderMs: number; device: string };
}

export interface PathTraceOverlayHandle {
    stop(): void;
    /** Renders one denoised still of the current view into the workspace; resolves with its workspace path. */
    renderStill(options?: PathTraceStillOptions): Promise<PathTraceStill>;
}

/** Pixels traced per frame when no renderScale is asked for: the old 1280 x 720 cap's worth. */
export const TRACE_PIXEL_BUDGET = 1280 * 720;
/** Largest view the helper takes. */
const MAX_VIEW_SIDE = 8192;

/** The displayed size of a frame (the overlay's device pixels) and the fraction of it to trace. */
export function pathTraceFrameSize(cssWidth: number, cssHeight: number, dpr: number, renderScale?: number): { width: number; height: number; renderScale: number } {
    let width = Math.max(8, Math.round(cssWidth * dpr));
    let height = Math.max(8, Math.round(cssHeight * dpr));
    const fit = Math.min(1, MAX_VIEW_SIDE / width, MAX_VIEW_SIDE / height);
    width = Math.max(8, Math.round(width * fit));
    height = Math.max(8, Math.round(height * fit));
    const scale = renderScale !== undefined
        ? renderScale
        : Math.sqrt(TRACE_PIXEL_BUDGET / (width * height));
    return { width, height, renderScale: Math.min(1, Math.max(0.25, scale)) };
}

async function post(route: string, body: unknown): Promise<any> {
    const res = await fetch(`/3d/path-trace/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) throw new Error(json.error || `${route} failed (HTTP ${res.status})`);
    return json;
}

export function startPathTraceOverlay(options: PathTraceOverlayOptions): PathTraceOverlayHandle {
    const { overlay, targetSpp } = options;
    let cancelled = false;
    let sessionId: string | null = null;
    let sentView = '';
    let ticker: number | null = null;
    let motionFrame: number | null = null;
    let lastCameraTag = '';
    let stillSince = 0;
    let moving = false;
    // Whether a view went out since the camera last moved: until then frames of the old view are not drawn.
    let viewSinceMotion = false;
    // Bumped on every camera change, so a view request that returns after a newer move does not count.
    let motionGen = 0;
    let sendingView = false;
    let lastFrameTag = '';
    let frameSeq = 0;
    let done = false;
    // One frame request at a time: a request still answering (a frame is several MB) is never doubled up.
    let polling = false;
    let status: PathTraceStatus | null = null;
    const offscreen = document.createElement('canvas');

    const show = (patch: Partial<PathTraceStatus>) => {
        status = { ...(status ?? { device: '', triangles: 0, clusters: 0, spp: 0, targetSpp, rays: 0, gpuMs: 0, width: 0, height: 0, materials: '', denoised: false, denoiseMs: 0, historyPixels: 0, renderWidth: 0, renderHeight: 0, upscaleMs: 0 }), ...patch };
        options.onStatus(status);
    };

    const frameSize = () => pathTraceFrameSize(overlay.clientWidth, overlay.clientHeight, window.devicePixelRatio || 1, options.renderScale);

    const viewBody = (v: PathTraceView, size: { width: number; height: number }) => ({
        camera: { position: v.eye, target: v.target, up: v.up, verticalFovDeg: v.fovYDeg },
        width: size.width,
        height: size.height
    });

    const sendView = async () => {
        if (cancelled || !sessionId) return;
        const v = options.getView();
        if (!v) return;
        const size = frameSize();
        const body = {
            sessionId,
            ...viewBody(v, size),
            ...(options.thresholdPx ? { lod: { thresholdPx: options.thresholdPx() } } : {}),
            targetSpp,
            renderScale: size.renderScale
        };
        const tag = JSON.stringify(body);
        if (tag === sentView) {
            // Back where the last view was: its frame still stands.
            setMoving(false);
            return;
        }
        sentView = tag;
        const gen = motionGen;
        sendingView = true;
        try {
            const started = await post('view', body);
            if (cancelled) return;
            frameSeq = started.seq;
            if (gen === motionGen) viewSinceMotion = true;
            done = false;
            show({ triangles: started.cut.triangles, clusters: started.cut.clusters, spp: 0, rays: 0, gpuMs: 0, width: size.width, height: size.height, message: undefined });
        } catch (err: any) {
            setMoving(false);
            if (!cancelled) show({ message: err?.message ?? String(err) });
        } finally {
            sendingView = false;
        }
    };

    const setMoving = (next: boolean) => {
        if (moving === next) return;
        moving = next;
        options.onMotion?.(next);
    };

    const draw = (rgba: ArrayBuffer, width: number, height: number, displayWidth: number, displayHeight: number) => {
        if (offscreen.width !== width || offscreen.height !== height) {
            offscreen.width = width;
            offscreen.height = height;
        }
        const octx = offscreen.getContext('2d');
        const ctx = overlay.getContext('2d');
        if (!octx || !ctx) return;
        octx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        // The overlay's backing store is the view's device pixels: a finished (upscaled) frame is drawn 1:1, a
        // converging one, sent at its traced size, is scaled up here.
        if (overlay.width !== displayWidth || overlay.height !== displayHeight) {
            overlay.width = displayWidth;
            overlay.height = displayHeight;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(offscreen, 0, 0, overlay.width, overlay.height);
    };

    const pollFrame = async () => {
        if (cancelled || !sessionId || done || polling) return;
        polling = true;
        try {
            // `seq`: frames of a view older than the newest one sent are not wanted, so the server does not send them.
            const res = await fetch(`/3d/path-trace/frame?sessionId=${encodeURIComponent(sessionId)}&seq=${frameSeq}&after=${encodeURIComponent(lastFrameTag)}`);
            if (cancelled) return;
            if (res.status === 204) return;
            if (!res.ok) throw new Error(`frame failed (HTTP ${res.status})`);
            const seq = Number(res.headers.get('X-Frame-Seq'));
            if (seq !== frameSeq) return; // a frame of the view before the last camera move
            const spp = Number(res.headers.get('X-Frame-Spp'));
            const width = Number(res.headers.get('X-Frame-Width'));
            const height = Number(res.headers.get('X-Frame-Height'));
            const rgba = await res.arrayBuffer();
            if (cancelled || rgba.byteLength !== width * height * 4) return;
            lastFrameTag = `${seq}.${spp}`;
            done = res.headers.get('X-Frame-Done') === '1';
            const displayWidth = Number(res.headers.get('X-Frame-Display-Width') ?? width);
            const displayHeight = Number(res.headers.get('X-Frame-Display-Height') ?? height);
            draw(rgba, width, height, displayWidth, displayHeight);
            setMoving(false);
            show({
                spp, rays: Number(res.headers.get('X-Frame-Rays')), gpuMs: Number(res.headers.get('X-Frame-Gpu-Ms')),
                width: displayWidth, height: displayHeight,
                denoised: res.headers.get('X-Frame-Denoised') === '1', denoiseMs: Number(res.headers.get('X-Frame-Denoise-Ms') ?? 0),
                historyPixels: Number(res.headers.get('X-Frame-History') ?? 0),
                renderWidth: Number(res.headers.get('X-Frame-Render-Width') ?? width), renderHeight: Number(res.headers.get('X-Frame-Render-Height') ?? height),
                upscaleMs: Number(res.headers.get('X-Frame-Upscale-Ms') ?? 0)
            });
        } catch (err: any) {
            if (!cancelled) show({ message: err?.message ?? String(err) });
        } finally {
            polling = false;
        }
    };

    (async () => {
        try {
            show({ message: 'Opening the Metal path tracer…' });
            const opened = await post('open', options.open);
            if (cancelled) { await post('close', { sessionId: opened.sessionId }).catch(() => undefined); return; }
            sessionId = opened.sessionId;
            const m = opened.materials;
            show({ device: opened.device, materials: m.source === 'glb' ? `${m.count} materials · ${m.texturesUploaded} textures` : 'clay (no source GLB)', message: undefined });
            options.onOpened?.({ sessionId: opened.sessionId, device: opened.device, origin: opened.origin, materials: m });
            await sendView();
            lastCameraTag = JSON.stringify({ v: options.getView(), size: frameSize(), t: options.thresholdPx?.() });
            // The camera is checked every display frame, so the viewport takes over on the first frame of a move.
            const watchCamera = () => {
                if (cancelled) return;
                const now = performance.now();
                const tag = JSON.stringify({ v: options.getView(), size: frameSize(), t: options.thresholdPx?.() });
                if (tag !== lastCameraTag) {
                    // Moving: hand the screen to the viewport's renderer and send nothing until the camera rests.
                    lastCameraTag = tag;
                    stillSince = now;
                    motionGen++;
                    viewSinceMotion = false;
                    // The view it left is no longer wanted: free the GPU for the viewport while the camera moves.
                    if (!moving && !done && sessionId) void post('pause', { sessionId }).catch(() => undefined);
                    setMoving(true);
                } else if (moving && !viewSinceMotion && !sendingView && now - stillSince >= REST_MS) {
                    void sendView();
                }
                motionFrame = window.requestAnimationFrame(watchCamera);
            };
            motionFrame = window.requestAnimationFrame(watchCamera);
            ticker = window.setInterval(() => {
                if (cancelled) return;
                if (!moving || viewSinceMotion) void pollFrame();
            }, 50);
        } catch (err: any) {
            if (!cancelled) show({ message: err?.message ?? String(err) });
        }
    })();

    return {
        stop() {
            cancelled = true;
            if (ticker !== null) window.clearInterval(ticker);
            if (motionFrame !== null) window.cancelAnimationFrame(motionFrame);
            overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
            if (sessionId) void post('close', { sessionId }).catch(() => undefined);
        },
        async renderStill(still: PathTraceStillOptions = {}) {
            if (!sessionId) throw new Error('the path tracer is not open yet');
            const v = options.getView();
            if (!v) throw new Error('there is no camera to render from');
            const shown = frameSize();
            const width = still.width ?? shown.width;
            const height = still.height ?? Math.round(width * shown.height / shown.width);
            const json = await post('render', {
                sessionId,
                ...viewBody(v, { width, height }),
                samplesPerPixel: still.samplesPerPixel ?? 1024,
                ...(still.workspaceRoot ? { workspaceRoot: still.workspaceRoot } : {}),
                ...(still.name ? { name: still.name } : {})
            });
            return { path: json.path, stats: json.stats };
        }
    };
}

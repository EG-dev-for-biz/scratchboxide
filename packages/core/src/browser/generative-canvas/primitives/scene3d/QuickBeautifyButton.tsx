/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Quick AI Beautify on the viewport tool rail: one click captures the current frame exactly as framed, sends it to
 * POST /api/viewport-beautify (viewport-beautify-service.ts: the standard AI Beautify prompt, the scene's light kept,
 * Nano Banana Lite at 1K first) and saves the photograph as a browser download, `<scene>_beautify_<timestamp>.png`.
 * Progress shows on the button; a failure is handed to the viewport's notice (onError), never replaced by an image.
 */

import * as React from 'react';

/** Long side the captured frame is scaled down to before upload (the answer is 1K; more pixels only cost upload time). */
export const QUICK_BEAUTIFY_UPLOAD_LONG_SIDE = 2048;

export interface QuickBeautifyView {
    /** The frame as a PNG data URL (captureSceneScreenshot), or null when none can be read. */
    frameDataUrl: string | null;
    sceneName: string;
    place?: { name?: string; lat: number; lng: number };
    headingDeg?: number;
    pitchDeg?: number;
    fovDeg?: number;
    subjectDistanceM?: number;
}

export interface QuickBeautifyAnswer {
    png: Blob;
    modelUsed?: string;
    modelNote?: string;
}

/** `<scene>_beautify_<YYYYMMDD-HHMMSS>.png`, the scene name reduced to safe file-name characters. */
export function quickBeautifyFileName(sceneName: string, at: Date = new Date()): string {
    const base = sceneName.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s-]+/g, '_').slice(0, 60) || 'scene';
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
    return `${base}_beautify_${stamp}.png`;
}

/** Decodes a data URL's image, scaled so its long side is at most `longSide`, and answers PNG base64 with its size. */
async function frameForUpload(dataUrl: string, longSide: number): Promise<{ base64: string; width: number; height: number }> {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const scale = Math.min(1, longSide / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    if (scale === 1) return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), width, height };
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('the browser could not scale the frame (no 2D canvas)');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, width, height);
    const scaled = canvas.toDataURL('image/png');
    return { base64: scaled.slice(scaled.indexOf(',') + 1), width, height };
}

/** Sends one frame to the server's quick beautify and answers the PNG; throws the server's message on failure. */
export async function requestQuickBeautify(view: QuickBeautifyView, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<QuickBeautifyAnswer> {
    if (!view.frameDataUrl) throw new Error('The viewport frame could not be read (no renderer, or the canvas refused to be read).');
    const frame = await frameForUpload(view.frameDataUrl, QUICK_BEAUTIFY_UPLOAD_LONG_SIDE);
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch('/api/viewport-beautify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            imageBase64: frame.base64,
            mimeType: 'image/png',
            width: frame.width,
            height: frame.height,
            sceneName: view.sceneName,
            place: view.place,
            headingDeg: view.headingDeg,
            pitchDeg: view.pitchDeg,
            fovDeg: view.fovDeg,
            subjectDistanceM: view.subjectDistanceM
        }),
        signal: opts.signal
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* not JSON: reported below */ }
    if (!res.ok || !json?.success || typeof json.imageBase64 !== 'string') {
        const err = json?.error;
        const message = typeof err === 'string' ? err : err?.message || `the server answered ${res.status} ${res.statusText}`;
        throw new Error(message);
    }
    const bin = atob(json.imageBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { png: new Blob([bytes], { type: 'image/png' }), modelUsed: json.modelUsed, modelNote: json.modelNote };
}

function downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface QuickBeautifyButtonProps {
    /** Reads the current view at click time (the frame, the scene's name and place, the camera). */
    readView: () => QuickBeautifyView;
    /** A failure's message, or null to clear the last one (a new run started). */
    onError: (message: string | null) => void;
}

type State = { kind: 'idle' } | { kind: 'running'; startedAt: number } | { kind: 'saved'; fileName: string; model?: string };

export const QuickBeautifyButton: React.FC<QuickBeautifyButtonProps> = ({ readView, onError }) => {
    const [state, setState] = React.useState<State>({ kind: 'idle' });
    const [, tick] = React.useState(0);
    const abortRef = React.useRef<AbortController | null>(null);

    React.useEffect(() => {
        if (state.kind !== 'running') return;
        const id = setInterval(() => tick(n => n + 1), 500);
        return () => clearInterval(id);
    }, [state.kind]);
    React.useEffect(() => {
        if (state.kind !== 'saved') return;
        const id = setTimeout(() => setState({ kind: 'idle' }), 6000);
        return () => clearTimeout(id);
    }, [state]);
    React.useEffect(() => () => abortRef.current?.abort(), []);

    const run = async () => {
        if (state.kind === 'running') return;
        onError(null);
        // the frame is read now, before anything else can move the camera
        const view = readView();
        const abort = new AbortController();
        abortRef.current = abort;
        setState({ kind: 'running', startedAt: Date.now() });
        try {
            const answer = await requestQuickBeautify(view, { signal: abort.signal });
            const fileName = quickBeautifyFileName(view.sceneName);
            downloadBlob(answer.png, fileName);
            setState({ kind: 'saved', fileName, model: answer.modelUsed });
        } catch (err: any) {
            if (abort.signal.aborted) return;
            setState({ kind: 'idle' });
            onError(err?.message ?? String(err));
        } finally {
            if (abortRef.current === abort) abortRef.current = null;
        }
    };

    const running = state.kind === 'running';
    const seconds = running ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
    return (
        <div className="relative">
            <button
                type="button"
                className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all border ${
                    running ? 'bg-fuchsia-600/30 text-fuchsia-200 border-fuchsia-500/50' : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border-transparent'
                }`}
                onClick={() => { void run(); }}
                disabled={running}
                aria-busy={running}
                title={running ? `AI Beautify running… ${seconds} s` : 'AI Beautify this view and download it (PNG, the scene\'s light kept)'}
                aria-label="AI Beautify this view and download it"
                data-testid="sb-3d-quick-beautify"
                data-state={state.kind}
            >
                {running ? (
                    <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M12 3a9 9 0 1 0 9 9" />
                    </svg>
                ) : (
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
                        <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
                        <path d="M5 2l.5 1.5L7 4l-1.5.5L5 6l-.5-1.5L3 4l1.5-.5z" />
                    </svg>
                )}
            </button>
            {state.kind !== 'idle' && (
                <div
                    className="absolute left-7 top-1/2 -translate-y-1/2 whitespace-nowrap px-2 py-0.5 rounded-md bg-[#121216]/90 border border-white/10 text-[10px] text-zinc-200 pointer-events-none"
                    role="status"
                    data-testid="sb-3d-quick-beautify-status"
                >
                    {running ? `AI Beautify… ${seconds} s` : `Saved ${state.fileName}${state.model ? ` (${state.model})` : ''}`}
                </div>
            )}
        </div>
    );
};

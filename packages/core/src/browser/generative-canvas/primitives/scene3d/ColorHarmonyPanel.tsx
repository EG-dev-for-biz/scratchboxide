/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport's Colour harmony tool: a tool strip button and its panel, anchored beside it like the Weather tool
 * (the same panel styles). A hue wheel to turn the template, template shapes, sector width, strength, saturation and
 * tint. Every change goes through color-harmony.ts mergeColorHarmony, the
 * same function sb_set_color_harmony uses; the optics chain draws it (ColorHarmonyPass).
 *
 * Below it, a reference photo's look matched onto the objects (look-match.ts): the photo (or the part of it a description
 * picks out, cut out by the server's segmenter) and the viewport's objects as shown (or the selected one) are measured by
 * lightness band, and the fit written as the scene's lookMatch; the output pass draws it.
 */

import * as React from 'react';
import type { Scene3DData, SceneColorHarmony, SceneColorHarmonySector, SceneLookBand, SceneLookMatch } from '../../canvas-types';
import { DEFAULT_HARMONY_SECTORS, mergeColorHarmony, type SetColorHarmonyParams } from '../../services/postprocessing/color-harmony';
import { fitLookMatch, measureLook, mergeLookMatch, type SetLookMatchParams } from '../../services/postprocessing/look-match';
import type { ViewportObjectSample } from './viewportOptics';

export interface ColorHarmonyControlProps {
    sceneData: Scene3DData;
    mutateSceneData: (mutator: (prev: Scene3DData) => Scene3DData, opInfo?: { operator: string; params?: any }, options?: { history?: false }) => void;
    /** The object selected in the viewport, which the look match can be measured on instead of every object. */
    selectedObjectId?: string | null;
    /** The next frame as shown, with a mask of the given objects (else every object): the optics chain's sample. */
    sampleObjects?: (objectIds?: string[]) => Promise<ViewportObjectSample>;
}

/** The reference photo is measured at this size (longest side, pixels): enough for a band's mean, quick to read. */
const REFERENCE_MEASURE_PX = 1024;

/** A photo file's display colours at REFERENCE_MEASURE_PX, and the cut-out of `target` in it (when one is given). */
async function readReference(file: File, target: string): Promise<{ rgba: Uint8ClampedArray; mask?: Uint8ClampedArray; found?: string }> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, REFERENCE_MEASURE_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const draw = (img: CanvasImageSource) => {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('this browser gives no 2D canvas to read the photo with');
        ctx.drawImage(img, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h).data;
    };
    const rgba = draw(bitmap);
    bitmap.close();
    if (!target) return { rgba };
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const res = await fetch('/api/color-match/segment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: btoa(binary), mimeType: file.type, target })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.error || `the segmenter answered ${res.status}`);
    const maskBitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(body.maskBase64), c => c.charCodeAt(0))], { type: 'image/png' }));
    const mask = draw(maskBitmap);
    maskBitmap.close();
    return { rgba, mask, found: body.found };
}

/** The look of the viewport's objects as shown (the selected one, when given). */
async function measureViewport(sample: (ids?: string[]) => Promise<ViewportObjectSample>, objectId: string | null): Promise<SceneLookBand[]> {
    const shot = await sample(objectId ? [objectId] : undefined);
    if (shot.missing.length) throw new Error(`${shot.missing.join(', ')} is not in the viewport`);
    return measureLook({ rgba: shot.rgba, mask: shot.mask, maskStride: 4 }, objectId ? 'the selected object' : 'the scene\'s objects');
}

/** Template shapes the panel offers: each only writes a list of sectors (the label names nothing the shader reads). */
const TEMPLATE_PICKS: Array<{ label: string; sectors: SceneColorHarmonySector[] }> = [
    { label: 'One hue', sectors: [{ offsetDeg: 0, widthDeg: 18 }] },
    { label: 'Analogous', sectors: [{ offsetDeg: 0, widthDeg: 94 }] },
    { label: 'Complementary', sectors: [{ offsetDeg: 0, widthDeg: 18 }, { offsetDeg: 180, widthDeg: 18 }] },
    { label: 'Split', sectors: [{ offsetDeg: 0, widthDeg: 18 }, { offsetDeg: 150, widthDeg: 18 }, { offsetDeg: 210, widthDeg: 18 }] },
    { label: 'Triad', sectors: [{ offsetDeg: 0, widthDeg: 18 }, { offsetDeg: 120, widthDeg: 18 }, { offsetDeg: 240, widthDeg: 18 }] },
    { label: 'Wide pair', sectors: [{ offsetDeg: 0, widthDeg: 94 }, { offsetDeg: 180, widthDeg: 94 }] }
];

const DEFAULT_ON: SceneColorHarmony = { hueDeg: 30, sectors: DEFAULT_HARMONY_SECTORS };
/** A swatch at a hue, at a lightness and chroma most hues can show in sRGB. */
const swatch = (hueDeg: number) => `oklch(0.72 0.12 ${hueDeg.toFixed(1)})`;

const sameSectors = (a: SceneColorHarmonySector[], b: SceneColorHarmonySector[]) =>
    a.length === b.length && a.every((s, i) => Math.abs(s.offsetDeg - b[i].offsetDeg) < 1e-6 && Math.abs(s.widthDeg - b[i].widthDeg) < 1e-6);

/** The wheel: hue 0 at the top, clockwise; the template's sectors drawn over it, the hue marked. */
function HueWheel({ hueDeg, sectors, onHue }: { hueDeg: number; sectors: SceneColorHarmonySector[]; onHue: (deg: number, live: boolean) => void }): React.ReactElement {
    const size = 84, c = size / 2, rOuter = 36, rInner = 26, rMid = (rOuter + rInner) / 2;
    const at = (deg: number, r: number) => {
        const t = (deg * Math.PI) / 180;
        return [c + r * Math.sin(t), c - r * Math.cos(t)] as const;
    };
    const arc = (from: number, to: number, r: number) => {
        const [x0, y0] = at(from, r);
        const [x1, y1] = at(to, r);
        return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
    };
    const hueAt = (e: React.PointerEvent<SVGSVGElement>) => {
        const box = e.currentTarget.getBoundingClientRect();
        const dx = e.clientX - box.left - (box.width / 2), dy = e.clientY - box.top - (box.height / 2);
        return (((Math.atan2(dx, -dy) * 180) / Math.PI) + 360) % 360;
    };
    const dragging = React.useRef(false);
    const [mx, my] = at(hueDeg, rMid);
    return (
        <svg
            width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="slider" aria-label="Template hue" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hueDeg)}
            style={{ cursor: 'pointer', touchAction: 'none', flex: '0 0 auto' }}
            onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); onHue(hueAt(e), true); }}
            onPointerMove={e => { if (dragging.current) onHue(hueAt(e), true); }}
            onPointerUp={e => { dragging.current = false; onHue(hueAt(e), false); }}
        >
            {Array.from({ length: 72 }, (_, i) => (
                <path key={i} d={arc(i * 5, i * 5 + 5.4, rMid)} stroke={swatch(i * 5 + 2.5)} strokeWidth={rOuter - rInner} fill="none" />
            ))}
            {sectors.map((s, i) => {
                const centre = hueDeg + s.offsetDeg, half = Math.min(s.widthDeg, 359.9) / 2;
                return <path key={i} d={arc(centre - half, centre + half, rOuter + 3)} stroke="#f4f4f5" strokeWidth={3} strokeLinecap="round" fill="none" />;
            })}
            <circle cx={mx} cy={my} r={5} fill={swatch(hueDeg)} stroke="#fff" strokeWidth={2} />
            <circle cx={c} cy={c} r={rInner - 6} fill={swatch(hueDeg)} />
        </svg>
    );
}

export function ColorHarmonyControl({ sceneData, mutateSceneData, selectedObjectId, sampleObjects }: ColorHarmonyControlProps): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const current = sceneData.colorHarmony;
    const h: SceneColorHarmony = current ?? DEFAULT_ON;
    const sectors = h.sectors && h.sectors.length > 0 ? h.sectors : DEFAULT_HARMONY_SECTORS;
    // the grade switched off is remembered, so switching it back on brings the same one back
    const lastOn = React.useRef<SceneColorHarmony | undefined>(current);
    if (current) lastOn.current = current;

    // a change while dragging is kept out of the undo history; the release records one step
    const set = React.useCallback((patch: SetColorHarmonyParams, live = false) => {
        mutateSceneData(prev => {
            const next = mergeColorHarmony(prev.colorHarmony ?? lastOn.current ?? DEFAULT_ON, patch);
            const out = { ...prev };
            if (next) out.colorHarmony = next; else delete out.colorHarmony;
            return out;
        }, { operator: 'sb_set_color_harmony', params: patch }, live ? { history: false } : undefined);
    }, [mutateSceneData]);
    const toggle = () => {
        if (current) set({ clear: true });
        else set({ hueDeg: (lastOn.current ?? DEFAULT_ON).hueDeg });
    };

    const look = sceneData.lookMatch;
    const [refFile, setRefFile] = React.useState<File | null>(null);
    const [refUrl, setRefUrl] = React.useState<string | null>(null);
    const [refTarget, setRefTarget] = React.useState('');
    const [onSelected, setOnSelected] = React.useState(false);
    const [matchState, setMatchState] = React.useState<{ busy?: string; error?: string; note?: string }>({});
    const fileInput = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => () => { if (refUrl) URL.revokeObjectURL(refUrl); }, [refUrl]);
    const measureOn = onSelected && selectedObjectId ? selectedObjectId : null;
    const pickReference = (file: File | undefined) => {
        if (!file || !file.type.startsWith('image/')) { setMatchState({ error: 'drop a photo (an image file)' }); return; }
        setRefFile(file);
        setRefUrl(URL.createObjectURL(file));
        setMatchState({});
    };
    const writeLook = (next: SceneLookMatch | undefined, params: Record<string, unknown>, live = false) => {
        mutateSceneData(prev => {
            const out = { ...prev };
            if (next) out.lookMatch = next; else delete out.lookMatch;
            return out;
        }, { operator: 'sb_set_look_match', params }, live ? { history: false } : undefined);
    };
    const setLook = (patch: SetLookMatchParams, live = false) => {
        try { writeLook(mergeLookMatch(look, patch), patch as Record<string, unknown>, live); } catch (e) { setMatchState({ error: (e as Error).message }); }
    };
    const match = async () => {
        if (!refFile || !sampleObjects) return;
        const target = refTarget.trim();
        try {
            setMatchState({ busy: target ? `Finding ${JSON.stringify(target)} in the photo…` : 'Measuring the photo…' });
            const ref = await readReference(refFile, target);
            const reference = measureLook({ rgba: ref.rgba, mask: ref.mask, maskStride: 4 }, target ? `${JSON.stringify(target)} in the photo` : 'the photo');
            setMatchState({ busy: 'Measuring the view…' });
            const source = await measureViewport(sampleObjects, measureOn);
            const next: SceneLookMatch = { reference: { label: refFile.name, ...(target ? { target } : {}), bands: reference }, knots: fitLookMatch(source, reference), ...(look?.strength !== undefined ? { strength: look.strength } : {}) };
            writeLook(next, { reference: refFile.name, target: target || undefined, measuredOn: measureOn ?? 'all objects' });
            setMatchState({ note: `Matched to ${refFile.name}${ref.found ? ` (${ref.found})` : ''}, measured on ${measureOn ? 'the selected object' : 'all objects'} in this view.` });
        } catch (e) {
            setMatchState({ error: (e as Error).message });
        }
    };
    const refit = async () => {
        if (!look || !sampleObjects) return;
        try {
            setMatchState({ busy: 'Measuring the view…' });
            const source = await measureViewport(sampleObjects, measureOn);
            writeLook({ ...look, knots: fitLookMatch(source, look.reference.bands) }, { refit: true, measuredOn: measureOn ?? 'all objects' });
            setMatchState({ note: `Refitted to this view (${measureOn ? 'the selected object' : 'all objects'}).` });
        } catch (e) {
            setMatchState({ error: (e as Error).message });
        }
    };

    const width = Math.max(...sectors.map(s => s.widthDeg));
    const range = (label: string, value: number, max: number, onValue: (v: number, live: boolean) => void, shown: string) => (
        <div className="sb-cam-section">
            <div className="sb-cam-readout"><span>{label}</span><span className="sb-cam-value">{shown}</span></div>
            <input
                type="range" min={0} max={max} step={0.01} value={value} aria-label={label} className="sb-cam-range"
                onChange={e => onValue(Number(e.target.value), true)}
                onPointerUp={e => onValue(Number((e.target as HTMLInputElement).value), false)}
            />
        </div>
    );

    return (
        <div className="sb-3d-camera-control sb-3d-harmony-control">
            <button
                type="button"
                className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${open ? 'sb-3d-toolstrip-btn-active' : ''}`}
                onClick={() => setOpen(v => !v)}
                title="Colour harmony: move the objects' colours toward a hue template"
                aria-label="Colour harmony"
                aria-pressed={open}
            >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 3v9l7.8 4.5" />
                    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                </svg>
            </button>
            {open && (
                <div className="sb-3d-camera-panel sb-3d-harmony-panel" role="dialog" aria-label="Colour harmony">
                    <div className="sb-cam-header">
                        <span>Colour harmony</span>
                        <div className="sb-cam-row">
                            <button
                                type="button" role="switch" aria-checked={!!current} aria-label="Colour harmony on"
                                className={`sb-cam-switch ${current ? 'sb-cam-switch-on' : ''}`}
                                onClick={toggle}
                                title={current ? 'Turn the grade off (the objects keep their own colours)' : 'Turn the grade on'}
                            ><span className="sb-cam-switch-knob" /></button>
                            <button type="button" className="sb-cam-close" onClick={() => setOpen(false)} aria-label="Close colour harmony">×</button>
                        </div>
                    </div>
                    {!current && <div className="sb-cam-note">Off: the objects keep their own colours. Change anything to switch it on.</div>}
                    <div className="sb-cam-section">
                        <div className="sb-cam-row" style={{ gap: 10 }}>
                            <HueWheel hueDeg={h.hueDeg} sectors={sectors} onHue={(deg, live) => set({ hueDeg: deg }, live)} />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 auto', minWidth: 0 }}>
                                <div className="sb-cam-readout"><span>Hue</span><span className="sb-cam-value">{Math.round(h.hueDeg)}°</span></div>
                                <input
                                    type="range" min={0} max={360} step={0.5} value={h.hueDeg} aria-label="Hue" className="sb-cam-range"
                                    onChange={e => set({ hueDeg: Number(e.target.value) }, true)}
                                    onPointerUp={e => set({ hueDeg: Number((e.target as HTMLInputElement).value) })}
                                />
                            </div>
                        </div>
                    </div>
                    <div className="sb-cam-section">
                        <div className="sb-cam-readout"><span>Template</span></div>
                        <div className="sb-cam-chips">
                            {TEMPLATE_PICKS.map(t => (
                                <button
                                    key={t.label} type="button"
                                    className={`sb-cam-chip ${current && sameSectors(sectors, t.sectors) ? 'sb-cam-chip-on' : ''}`}
                                    onClick={() => set({ sectors: t.sectors })}
                                >{t.label}</button>
                            ))}
                        </div>
                    </div>
                    {range('Sector width', width, 180, (v, live) => set({ sectors: sectors.map(s => ({ ...s, widthDeg: Math.max(1, v) })) }, live), `${Math.round(width)}°`)}
                    {range('Strength', h.strength ?? 1, 1, (v, live) => set({ strength: v }, live), `${Math.round((h.strength ?? 1) * 100)}%`)}
                    {range('Saturation', h.chroma ?? 1, 2, (v, live) => set({ chroma: v }, live), `${Math.round((h.chroma ?? 1) * 100)}%`)}
                    {range('Tint (colours greys and clay)', h.tint ?? 0, 1, (v, live) => set({ tint: v }, live), `${Math.round((h.tint ?? 0) * 100)}%`)}
                    <div className="sb-cam-note">Scene objects only, never the sky. Keeps lightness, so shading stays.</div>
                    <div className="sb-cam-section sb-look-match">
                        <div className="sb-cam-readout">
                            <span>Match a reference photo</span>
                            {look && <button type="button" className="sb-cam-chip" onClick={() => { setLook({ clear: true }); setMatchState({}); }}>Clear</button>}
                        </div>
                        <div
                            className="sb-cam-note"
                            role="button" tabIndex={0} aria-label="Reference photo: drop a photo or choose one"
                            style={{ border: '1px dashed currentColor', borderRadius: 6, padding: 6, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                            onClick={() => fileInput.current?.click()}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click(); }}
                            onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                            onDrop={e => { e.preventDefault(); e.stopPropagation(); pickReference(e.dataTransfer.files?.[0]); }}
                        >
                            {refUrl && <img src={refUrl} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 4, flex: '0 0 auto' }} />}
                            <span>{refFile ? refFile.name : look ? `Matched: ${look.reference.label ?? 'a photo'}. Drop another photo to match it instead.` : 'Drop a photo here, or click to choose one'}</span>
                        </div>
                        <input ref={fileInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { pickReference(e.target.files?.[0]); e.target.value = ''; }} />
                        {refFile && (
                            <input
                                type="text" className="sb-cam-input" value={refTarget} onChange={e => setRefTarget(e.target.value)}
                                placeholder="What to match in it (empty: the whole photo)" aria-label="What to match in the photo"
                                style={{ width: '100%', marginTop: 6 }}
                            />
                        )}
                        {(refFile || look) && (
                            <div className="sb-cam-chips" style={{ marginTop: 6 }}>
                                <button type="button" className={`sb-cam-chip ${!measureOn ? 'sb-cam-chip-on' : ''}`} onClick={() => setOnSelected(false)}>All objects</button>
                                <button type="button" className={`sb-cam-chip ${measureOn ? 'sb-cam-chip-on' : ''}`} disabled={!selectedObjectId} title={selectedObjectId ? undefined : 'Select an object in the viewport first'} onClick={() => setOnSelected(true)}>Selected object</button>
                                {refFile && <button type="button" className="sb-cam-chip sb-cam-chip-on" disabled={!!matchState.busy || !sampleObjects} onClick={match}>Match</button>}
                                {look && <button type="button" className="sb-cam-chip" disabled={!!matchState.busy || !sampleObjects} onClick={refit} title="Measure this view again against the matched photo">Refit to view</button>}
                            </div>
                        )}
                    </div>
                    {look && range('Match strength', look.strength ?? 1, 1, (v, live) => setLook({ strength: v }, live), `${Math.round((look.strength ?? 1) * 100)}%`)}
                    {matchState.busy && <div className="sb-cam-note">{matchState.busy}</div>}
                    {matchState.error && <div className="sb-cam-note" role="alert" style={{ color: '#f87171' }}>{matchState.error}</div>}
                    {matchState.note && !matchState.busy && <div className="sb-cam-note">{matchState.note}</div>}
                </div>
            )}
        </div>
    );
}

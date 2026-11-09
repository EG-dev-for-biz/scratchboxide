/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window check (user ask, 2026-11-07): when a 3D Building scene loads, a small card asks the viewer to select the
 * images, cropped from earlier builds' facade photos, whose outlined box is a window, as a CAPTCHA does. The answers
 * label the window-array sites the pipeline was least sure of (pipeline-k/window-check.ts, GET and POST
 * /3d/window-check). Once per build per session; Skip and close leave it; nothing shows when the server has no check.
 * The same card asks the blob check (street-objects/blob-check.ts, /3d/blob-check: "Select every image where the magenta
 * box is on a ..."), its heading taken from the check: `endpoints` are tried in order and the first with a check shows.
 */

import * as React from 'react';
import { getApiBase, withApiHeaders } from '../../../../../common/api-client-config';

interface Tile { id: string; png?: string; jpg?: string }
/** `lead`, `subject` and `note` set the heading (the window check's when absent); `base` is the endpoint that served it. */
interface Check { id: string; detail: string; tiles: Tile[]; lead?: string; subject?: string; note?: string; base?: string }
const WINDOW_CHECK_PATH = '/3d/window-check';

function url(p: string): string {
    const base = getApiBase();
    return base ? `${base.replace(/\/+$/, '')}${p}` : p;
}
const seenKey = (runId: string) => `sb-window-check:${runId}`;
function seen(runId: string): boolean { try { return sessionStorage.getItem(seenKey(runId)) === '1'; } catch { return false; } }
function markSeen(runId: string): void { try { sessionStorage.setItem(seenKey(runId), '1'); } catch { /* storage blocked: the card may show again */ } }

/** One request per build at a time: a remounted card (React's development double effect) shares it rather than drawing a second check. */
const inFlight = new Map<string, Promise<Check | undefined>>();
function checkFor(runId: string, endpoints: string[]): Promise<Check | undefined> {
    let p = inFlight.get(runId);
    if (!p) {
        p = (async () => { for (const e of endpoints) { const c = await fetchWindowCheck(undefined, e).catch(() => undefined); if (c) return c; } return undefined; })();
        inFlight.set(runId, p);
    }
    return p;
}

/** A check from `endpoint` (a path, a query allowed), with `base` set to the path its answer goes to. */
export async function fetchWindowCheck(fetchImpl: typeof fetch = (...a) => fetch(...a), endpoint: string = WINDOW_CHECK_PATH): Promise<Check | undefined> {
    const res = await fetchImpl(url(endpoint), withApiHeaders({}));
    const body = await res.json().catch(() => ({}));
    return res.ok && body?.check ? ({ ...(body.check as Check), base: endpoint.split('?')[0] }) : undefined;
}
export async function answerWindowCheck(id: string, selected: string[], skipped: boolean, fetchImpl: typeof fetch = (...a) => fetch(...a), base: string = WINDOW_CHECK_PATH): Promise<{ stored: number; controlsPassed: boolean } | undefined> {
    const res = await fetchImpl(url(`${base}/${id}`), withApiHeaders({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selected, skipped }) }));
    const body = await res.json().catch(() => ({}));
    return res.ok && body?.success ? { stored: body.stored, controlsPassed: body.controlsPassed } : undefined;
}

const BLUE = '#1a73e8';

export const WindowCheckCard: React.FC<{ runId: string; topPx?: number; leftPx?: number; endpoints?: string[] }> = ({ runId, topPx = 12, leftPx = 72, endpoints = [WINDOW_CHECK_PATH] }) => {
    const [check, setCheck] = React.useState<Check | undefined>();
    const [selected, setSelected] = React.useState<Set<string>>(new Set());
    const [state, setState] = React.useState<'idle' | 'sending' | 'thanks' | 'closed'>('idle');
    const [note, setNote] = React.useState('');
    React.useEffect(() => {
        if (seen(runId)) return;
        let live = true;
        void checkFor(runId, endpoints).then(c => { if (live && c) { setCheck(c); markSeen(runId); } });
        return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runId]);
    React.useEffect(() => {
        if (state !== 'thanks') return;
        const t = setTimeout(() => setState('closed'), 2500);
        return () => clearTimeout(t);
    }, [state]);
    if (!check || state === 'closed') return null;

    const send = async (skipped: boolean) => {
        setState('sending');
        const r = await answerWindowCheck(check.id, [...selected], skipped, undefined, check.base).catch(() => undefined);
        if (skipped) { setState('closed'); return; }
        setNote(r ? `Thanks: ${r.stored} answers saved${r.controlsPassed ? '' : ' (kept aside: a known image was answered differently)'}.` : 'Your answers could not be saved.');
        setState('thanks');
    };
    const toggle = (id: string) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

    return (
        <div
            role="dialog"
            aria-label={check.detail}
            data-testid="sb-window-check"
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); void send(true); } }}
            style={{ position: 'absolute', top: topPx, left: leftPx, zIndex: 40, width: 420, maxWidth: 'calc(100% - 96px)', background: '#fff', borderRadius: 4, boxShadow: '0 4px 16px rgba(0,0,0,0.35)', fontFamily: 'Roboto, system-ui, sans-serif', overflow: 'hidden', color: '#202124' }}
        >
            <div style={{ background: BLUE, color: '#fff', padding: '12px 14px', position: 'relative' }}>
                <div style={{ fontSize: 13 }}>{check.lead ?? 'Select every image where the yellow box is on a'}</div>
                <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.15 }}>{check.subject ?? 'window'}</div>
                <div style={{ fontSize: 12, marginTop: 2 }}>{check.note ?? 'Leave the others. Optional: it helps the 3D Building feature find windows.'}</div>
                <button type="button" className="sb-window-check-close" aria-label="Close the check" onClick={() => void send(true)} style={{ position: 'absolute', top: 6, right: 8, background: 'transparent', border: 'none', color: '#fff', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            {state === 'thanks'
                ? <div role="status" style={{ padding: 16, fontSize: 13 }}>{note}</div>
                : <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, padding: 4 }}>
                        {check.tiles.map((t, i) => {
                            const on = selected.has(t.id);
                            return (
                                <button key={t.id} type="button" className="sb-window-check-tile" aria-pressed={on} aria-label={`Image ${i + 1}${on ? ', selected' : ''}`} onClick={() => toggle(t.id)} data-tile={t.id}
                                    style={{ position: 'relative', padding: 0, border: 'none', outline: on ? `3px solid ${BLUE}` : 'none', outlineOffset: -3, background: '#eee', cursor: 'pointer', aspectRatio: '1 / 1', overflow: 'hidden', width: '100%', minWidth: 0 }}>
                                    <img src={t.jpg ? `data:image/jpeg;base64,${t.jpg}` : `data:image/png;base64,${t.png}`} alt="" draggable={false} style={{ width: '100%', height: '100%', display: 'block', transform: on ? 'scale(0.82)' : 'none', transition: 'transform 120ms' }} />
                                    {on && <span aria-hidden="true" style={{ position: 'absolute', top: 3, left: 3, width: 20, height: 20, borderRadius: 10, background: BLUE, color: '#fff', fontSize: 14, lineHeight: '20px', textAlign: 'center' }}>✓</span>}
                                </button>
                            );
                        })}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderTop: '1px solid #dadce0' }}>
                        <span style={{ fontSize: 12, color: '#5f6368' }}>{selected.size ? `${selected.size} selected` : 'None selected yet'}</span>
                        <span style={{ display: 'flex', gap: 6 }}>
                            <button type="button" className="sb-window-check-skip" title="Skip this check: nothing is saved" disabled={state === 'sending'} onClick={() => void send(true)} style={{ background: '#fff', color: BLUE, border: `1px solid ${BLUE}`, borderRadius: 3, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>SKIP</button>
                            <button type="button" className="sb-window-check-verify" title="Save your answers" disabled={state === 'sending'} onClick={() => void send(false)} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 3, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>VERIFY</button>
                        </span>
                    </div>
                </>}
        </div>
    );
};

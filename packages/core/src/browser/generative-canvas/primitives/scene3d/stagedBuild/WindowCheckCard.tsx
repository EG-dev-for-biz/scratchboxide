/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window check (user ask, 2026-11-07): when a 3D Building scene loads, a card asks the viewer to select the images,
 * cropped from earlier builds' facade photos, whose outlined box is a window, as a CAPTCHA does. The answers label the
 * window-array sites the pipeline was least sure of (pipeline-k/window-check.ts, GET and POST /3d/window-check). Once
 * per build per session; Skip and close leave it; nothing shows when the server has no check. The same card asks the blob
 * check (street-objects/blob-check.ts, /3d/blob-check: "Select every image where the magenta box is on a ..."), its
 * heading taken from the check: `endpoints` are tried in order and the first with a check shows.
 *
 * Where it shows (user ask, 2026-11-08): while the build's remesh stage is running, dead time for the viewer, the card
 * is a popup centred over the viewport (`modal`), drawn in the viewport's own chrome (viewportChrome.ts); once that stage
 * is over, or when the check arrives at any other time, it sits unobtrusively beside the toolstrip and never blocks the
 * view. A check open as a popup when the remesh finishes moves to that corner with its selection kept. Verify and Skip
 * close it; a site already answered is never asked again (the server's label store decides which sites it draws).
 */

import * as React from 'react';
import { getApiBase, withApiHeaders } from '../../../../../common/api-client-config';
import { CHROME_ACCENT, CHROME_ACCENT_FILL, CHROME_BUTTON, CHROME_BUTTON_PRIMARY, CHROME_MUTED, CHROME_PANEL, CHROME_TEXT } from './viewportChrome';

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

/** Above the staged overlay (25), the tree stats (30) and the toolstrip (20); the popup's backdrop covers them all. */
const CORNER_Z = 40;
const MODAL_Z = 45;
const CARD_CSS = '.sb-window-check button:focus-visible{outline:2px solid #56B4E9;outline-offset:2px}'
    + '.sb-window-check-tile:hover{border-color:rgba(255,255,255,0.45)!important}'
    + '.sb-window-check-skip:hover{background:rgba(255,255,255,0.14)!important}'
    + '.sb-window-check-verify:hover{filter:brightness(1.1)}'
    + '.sb-window-check-close:hover{color:#fff!important}';

export interface WindowCheckPanelProps {
    check: Check;
    selected: ReadonlySet<string>;
    state: 'idle' | 'sending' | 'thanks';
    note: string;
    /** Centred over the viewport on a dimmed backdrop (the remesh is running); else a card beside the toolstrip. */
    modal: boolean;
    topPx: number;
    leftPx: number;
    onToggle: (id: string) => void;
    onSend: (skipped: boolean) => void;
}

/** The card itself, given its data: what the live card draws, and what the tests render. */
export const WindowCheckPanel: React.FC<WindowCheckPanelProps> = ({ check, selected, state, note, modal, topPx, leftPx, onToggle, onSend }) => {
    const dialogRef = React.useRef<HTMLDivElement>(null);
    const isWindow = (check.base ?? WINDOW_CHECK_PATH) === WINDOW_CHECK_PATH;
    // the popup takes the keyboard when it opens (Escape skips, Tab reaches the tiles); the corner card waits to be clicked
    React.useEffect(() => { if (modal) dialogRef.current?.focus(); }, [modal]);
    const place: React.CSSProperties = modal
        ? { position: 'relative', width: 440, maxWidth: 'calc(100% - 32px)', maxHeight: 'calc(100% - 32px)', overflowY: 'auto' }
        : { position: 'absolute', top: topPx, left: leftPx, zIndex: CORNER_Z, width: 400, maxWidth: 'calc(100% - 96px)' };
    const dialog = (
        <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal={modal || undefined}
            aria-label={check.detail}
            data-testid="sb-window-check"
            data-placement={modal ? 'popup' : 'corner'}
            className="sb-window-check"
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onSend(true); } }}
            style={{ ...CHROME_PANEL, ...place, padding: 0, outline: 'none', pointerEvents: 'auto', userSelect: 'none' }}
        >
            <style>{CARD_CSS}</style>
            <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid rgba(255,255,255,0.1)', position: 'relative' }}>
                <div style={{ color: CHROME_MUTED, fontSize: 11, letterSpacing: 0.3, textTransform: 'uppercase' }}>{isWindow ? 'Window check' : 'Quick check'}</div>
                <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3, marginTop: 2, paddingRight: 20 }}>{check.lead ?? 'Select every image where the yellow box is on a'} <span style={{ color: CHROME_ACCENT }}>{check.subject ?? 'window'}</span>.</div>
                <div style={{ color: CHROME_MUTED, marginTop: 2 }}>{check.note ?? (modal ? 'Optional, while the building is remeshed: it helps the 3D Building feature find windows. Leave the others.' : 'Optional: it helps the 3D Building feature find windows. Leave the others.')}</div>
                <button type="button" className="sb-window-check-close" aria-label="Close the check" onClick={() => onSend(true)}
                    style={{ position: 'absolute', top: 6, right: 8, background: 'transparent', border: 'none', color: CHROME_MUTED, fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: 2 }}>×</button>
            </div>
            {state === 'thanks'
                ? <div role="status" style={{ padding: '14px 12px' }}>{note}</div>
                : <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, padding: 10 }}>
                        {check.tiles.map((t, i) => {
                            const on = selected.has(t.id);
                            return (
                                <button key={t.id} type="button" className="sb-window-check-tile" aria-pressed={on} aria-label={`Image ${i + 1}${on ? ', selected' : ''}`} onClick={() => onToggle(t.id)} data-tile={t.id}
                                    style={{
                                        position: 'relative', padding: 0, cursor: 'pointer', aspectRatio: '1 / 1', overflow: 'hidden', width: '100%', minWidth: 0, borderRadius: 6,
                                        background: 'rgba(255,255,255,0.06)', border: `2px solid ${on ? CHROME_ACCENT : 'rgba(255,255,255,0.14)'}`,
                                        boxShadow: on ? `0 0 0 2px ${CHROME_ACCENT_FILL} inset` : 'none', transition: 'border-color 120ms'
                                    }}>
                                    <img src={t.jpg ? `data:image/jpeg;base64,${t.jpg}` : `data:image/png;base64,${t.png}`} alt="" draggable={false} style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover', transform: on ? 'scale(0.86)' : 'none', transition: 'transform 120ms', borderRadius: 3 }} />
                                    {on && <span aria-hidden="true" style={{ position: 'absolute', top: 4, left: 4, width: 18, height: 18, borderRadius: 9, background: CHROME_ACCENT, color: '#0b0b0e', fontSize: 12, fontWeight: 700, lineHeight: '18px', textAlign: 'center' }}>✓</span>}
                                </button>
                            );
                        })}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px 10px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                        <span style={{ color: CHROME_MUTED }} data-testid="sb-window-check-count">{selected.size ? `${selected.size} selected` : 'None selected yet'}</span>
                        <span style={{ display: 'flex', gap: 6 }}>
                            <button type="button" className="sb-window-check-skip" title="Skip this check: nothing is saved" disabled={state === 'sending'} onClick={() => onSend(true)} style={{ ...CHROME_BUTTON, padding: '5px 12px', textAlign: 'center' }}>Skip</button>
                            <button type="button" className="sb-window-check-verify" title="Save your answers" disabled={state === 'sending'} onClick={() => onSend(false)} style={{ ...CHROME_BUTTON_PRIMARY, padding: '5px 14px', textAlign: 'center', opacity: state === 'sending' ? 0.6 : 1 }}>Verify</button>
                        </span>
                    </div>
                </>}
        </div>
    );
    if (!modal) return dialog;
    return (
        <div data-testid="sb-window-check-backdrop" style={{ position: 'absolute', inset: 0, zIndex: MODAL_Z, background: 'rgba(8, 8, 10, 0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto', color: CHROME_TEXT }}>
            {dialog}
        </div>
    );
};

export const WindowCheckCard: React.FC<{ runId: string; modal?: boolean; topPx?: number; leftPx?: number; endpoints?: string[] }> = ({ runId, modal = false, topPx = 12, leftPx = 72, endpoints = [WINDOW_CHECK_PATH] }) => {
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

    // the thank-you note never holds the viewport: it goes to the corner even while the remesh runs
    return <WindowCheckPanel check={check} selected={selected} state={state} note={note} modal={modal && state !== 'thanks'} topPx={topPx} leftPx={leftPx} onToggle={toggle} onSend={s => void send(s)} />;
};

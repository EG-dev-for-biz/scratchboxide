/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged-build overlay (design §7.3): which stage is running and from what, every stage's status in words, the
 * structure that was picked, the vision model that read the photos (with any fallback or failure), the degraded parts
 * and why, the provenance toggle and its legend, replay, retry and attribution.
 *
 * Docked bottom-left, clear of the toolstrip (above it), the HUD (top right), the scrubber and the open timeline: it
 * measures them and keeps out of their boxes. Plain text at 12 px or more; a polite live region announces stage
 * transitions only; every control is a button with a name, toggles carry aria-pressed, Escape collapses it.
 */

import * as React from 'react';
import type { DegradationRecord, StageStatus, StageSummary, StagedBuildState, StagedLayer } from '../../../../../common/spatial/staged-location-contracts';
import type { LayerRevealFrame } from './revealScheduler';
import type { LegendRow } from './provenanceShading';
import type { StageProgress } from './stagedBuildState';

/** Where a degraded part is in the viewport (degradationPlacement.ts): an exact part, a whole layer, or nothing drawn. */
export interface DegradationPlacementNote {
    scope: 'part' | 'layer' | 'none';
    /** Layers the shaded nodes are in. */
    layerIds: string[];
}

export interface StagedBuildOverlayProps {
    state: StagedBuildState;
    /** The run is shown as interrupted (turn ended, or a saved running state from before this page loaded). */
    interrupted: boolean;
    layers: LayerRevealFrame[];
    progress: Map<string, StageProgress>;
    nowMs: number;
    /** Wall clock, for the elapsed time of a running stage (server timings are wall-clock ms). */
    wallNowMs: number;
    announcement: string;
    provenanceOn: boolean;
    onToggleProvenance: () => void;
    legend: LegendRow[];
    showReplaced: boolean;
    onToggleShowReplaced: () => void;
    onReplay: () => void;
    onRetry: (record: DegradationRecord) => void;
    onHighlight: (record: DegradationRecord) => void;
    highlightedId?: string;
    /** Where each degraded part is, by record id; absent while layers are still loading. */
    placements?: ReadonlyMap<string, DegradationPlacementNote>;
    /** Bottom inset: 16 px, or above the docked timeline when it is open. */
    bottomInsetPx: number;
    /** Why reveals currently show their end state at once (frame time, hidden document). */
    skipNote?: string;
}

/** "4 images · 1 vision call". */
export function costWords(c: { images: number; visionCalls: number; seconds: number; imagesSent?: number }): string {
    const parts = [c.images ? `${c.images} image${c.images === 1 ? '' : 's'} fetched` : '', c.imagesSent ? `${c.imagesSent} sent to the model` : '', c.visionCalls ? `${c.visionCalls} vision call${c.visionCalls === 1 ? '' : 's'}` : ''].filter(Boolean);
    return parts.join(' · ');
}

/** The survey's materials and measured colours: swatches per face, labelled as photo-inferred hints (clay stays one grey; no texture). */
function SurveyHints({ hints }: { hints: NonNullable<StagedBuildState['materialHints']> }): React.ReactElement {
    return (
        <div style={{ marginTop: 6 }} data-testid="sb-staged-survey" aria-label="Survey of the faces: materials and colours measured from the photos">
            <div style={{ color: MUTED }}>{`Survey (photo-inferred hints, colours measured from the photos, ${costWords(hints.cost)}, ${hints.cost.seconds.toFixed(1)} s)`}</div>
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {hints.faces.map(f => (
                    <li key={f.faceId} data-face={f.faceId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ minWidth: 44 }}>{`${Math.round(f.headingDeg)}°`}</span>
                        {f.skipped
                            ? <span style={{ color: MUTED }}>{`not surveyed: ${f.skipped}`}</span>
                            : (
                                <>
                                    <span aria-label={`palette ${f.palette?.colours.map(c => c.hex).join(', ') ?? 'none'}`} style={{ display: 'inline-flex', gap: 2 }}>
                                        {(f.palette?.colours ?? []).map(c => <span key={c.hex} title={`${c.hex} · ${Math.round(c.share * 100)}%`} data-swatch={c.hex} style={{ width: 14, height: 14, borderRadius: 3, background: c.hex, border: '1px solid rgba(255,255,255,0.35)', display: 'inline-block' }} />)}
                                    </span>
                                    <span style={{ color: MUTED }}>{`${f.elements.length} element${f.elements.length === 1 ? '' : 's'}${f.materials[0] ? ` · ${f.materials[0].description}` : ''}`}</span>
                                </>
                            )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

const GLYPH: Record<StageStatus, string> = { pending: '○', running: '●', committed: '✓', degraded: '↓', skipped: '–', failed: '✕', stopped: '■' };

const PANEL: React.CSSProperties = {
    position: 'absolute', left: 12, zIndex: 25, maxWidth: 320, width: 'max-content', minWidth: 220,
    boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10,
    background: 'rgba(18, 18, 22, 0.92)', border: '1px solid rgba(255, 255, 255, 0.14)',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)', color: '#e4e4e7',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", fontSize: 12, lineHeight: 1.45,
    overflowY: 'auto', pointerEvents: 'auto', userSelect: 'text', textAlign: 'left'
};
const MUTED = '#b4b4bb';
const BUTTON: React.CSSProperties = {
    font: 'inherit', fontSize: 12, color: '#e4e4e7', background: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(255, 255, 255, 0.18)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', textAlign: 'left'
};
const HIDDEN: React.CSSProperties = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };
/** The HUD row (Fit to View, scene badge) sits within the top 48 px. */
const HUD_CLEARANCE_PX = 56;
/** Below this much room under the toolstrip the panel docks beside it instead. */
const MIN_PANEL_HEIGHT_PX = 180;
const FOCUS_CSS = '.sb-staged-overlay button:focus-visible{outline:2px solid #56B4E9;outline-offset:2px}';

function seconds(ms: number | undefined): string {
    if (ms === undefined || !Number.isFinite(ms)) return '';
    return ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

function builtDate(ms: number | undefined): string {
    return ms ? new Date(ms).toISOString().slice(0, 10) : '';
}

function stageTime(s: StageSummary, wallNowMs: number): number | undefined {
    if (s.timings.ms !== undefined) return s.timings.ms;
    if (s.status === 'running') return Math.max(0, wallNowMs - s.timings.startedAtMs);
    if (s.timings.endedAtMs !== undefined) return s.timings.endedAtMs - s.timings.startedAtMs;
    return undefined;
}

function SwatchBox({ row }: { row: LegendRow }) {
    const base: React.CSSProperties = { display: 'inline-block', width: 14, height: 14, borderRadius: 3, flex: '0 0 auto', marginTop: 1, border: '1px solid rgba(255,255,255,0.35)' };
    const bg = '#1c2026';
    let background = row.color;
    if (row.pattern === 'stripes') background = `repeating-linear-gradient(45deg, ${row.color} 0 4px, ${bg} 4px 6px)`;
    else if (row.pattern === 'crosshatch') background = `repeating-linear-gradient(45deg, ${row.color} 0 4px, ${bg} 4px 6px), repeating-linear-gradient(-45deg, ${row.color} 0 4px, ${bg} 4px 6px)`;
    else if (row.pattern === 'dots') background = `radial-gradient(circle, ${bg} 1.6px, ${row.color} 1.7px) 0 0 / 6px 6px`;
    else if (row.pattern === 'hatch') background = `repeating-linear-gradient(-45deg, ${row.color} 0 2px, transparent 2px 7px), #8a8f98`;
    else if (row.pattern === 'cividis') background = 'linear-gradient(90deg, #00204c, #7c7b78, #ffe945)';
    if (row.pattern === 'crosshatch') return <span aria-hidden="true" style={{ ...base, backgroundImage: background, backgroundColor: row.color }} />;
    return <span aria-hidden="true" style={{ ...base, background }} />;
}

export const StagedBuildOverlay: React.FC<StagedBuildOverlayProps> = props => {
    const { state } = props;
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const [collapsed, setCollapsed] = React.useState(false);
    const [degradedOpen, setDegradedOpen] = React.useState(false);
    const [box, setBox] = React.useState<{ bottom: number; left: number; maxHeight: number | undefined; narrow: boolean }>({ bottom: props.bottomInsetPx, left: 12, maxHeight: undefined, narrow: false });

    // Keep clear of the viewport's own chrome (toolstrip, HUD row, scrubber, the docked timeline wherever it is drawn):
    // measure their boxes in the container, try docking below the toolstrip, then beside it, and take the column
    // with the most room between the obstacles above and below it.
    React.useLayoutEffect(() => {
        const panel = panelRef.current;
        const container = panel?.parentElement;
        if (!panel || !container) return;
        const measure = () => {
            const c = container.getBoundingClientRect();
            const width = Math.min(320, panel.getBoundingClientRect().width || 320);
            const rel = (el: Element | null) => {
                const r = el?.getBoundingClientRect();
                return r && r.width > 0 && r.height > 0 ? { left: r.left - c.left, right: r.right - c.left, top: r.top - c.top, bottom: r.bottom - c.top } : undefined;
            };
            const timeline = rel(container.querySelector('.sb-3d-docked-timeline'));
            const obstacles = [
                rel(container.querySelector('.sb-3d-toolstrip')),
                rel(container.querySelector('.sb-3d-minimal-badge-container')),
                rel(container.querySelector('.sb-3d-timeline-scrubber')),
                timeline
            ].filter((r): r is NonNullable<typeof r> => !!r);
            // Without a measurable timeline box, the caller's inset says where it is.
            const floor = timeline ? 16 : props.bottomInsetPx;
            const toolstrip = rel(container.querySelector('.sb-3d-toolstrip'));
            const lefts = [12, ...(toolstrip ? [toolstrip.right + 8] : [])];
            let best: { left: number; top: number; bottomEdge: number } | undefined;
            for (const left of lefts) {
                const span = obstacles.filter(o => o.left < left + width && o.right > left);
                const mid = c.height / 2;
                let top = HUD_CLEARANCE_PX, bottomEdge = c.height - floor;
                for (const o of span) {
                    if ((o.top + o.bottom) / 2 < mid) top = Math.max(top, o.bottom + 8);
                    else bottomEdge = Math.min(bottomEdge, o.top - 8);
                }
                if (span.some(o => o.top <= top && o.bottom >= bottomEdge)) continue;   // fully blocked
                const room = bottomEdge - top;
                if (!best || (room >= MIN_PANEL_HEIGHT_PX && best.bottomEdge - best.top < MIN_PANEL_HEIGHT_PX) || (room > best.bottomEdge - best.top && (best.bottomEdge - best.top) < MIN_PANEL_HEIGHT_PX)) {
                    best = { left, top, bottomEdge };
                }
                if (room >= MIN_PANEL_HEIGHT_PX && best.left === left) break;
            }
            const pick = best ?? { left: 12, top: HUD_CLEARANCE_PX, bottomEdge: c.height - floor };
            const bottom = Math.max(0, c.height - pick.bottomEdge);
            const maxHeight = Math.max(0, pick.bottomEdge - pick.top);
            const narrow = c.width < 560;
            setBox(prev => (prev.bottom === bottom && prev.left === pick.left && prev.maxHeight === maxHeight && prev.narrow === narrow ? prev : { bottom, left: pick.left, maxHeight, narrow }));
        };
        measure();
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined;
        ro?.observe(container);
        ro?.observe(panel);
        // The chrome around it opens and closes (the timeline drawer): re-measure when the container's children change.
        const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : undefined;
        mo?.observe(container, { childList: true });
        return () => { ro?.disconnect(); mo?.disconnect(); };
    }, [props.bottomInsetPx, collapsed, props.provenanceOn, degradedOpen]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            setCollapsed(true);
        }
    };

    const runOver = state.runState !== 'running' || props.interrupted;
    const runWord = props.interrupted ? 'interrupted' : state.runState;
    const current = (() => {
        const running = state.stages.filter(s => s.status === 'running').sort((a, b) => b.timings.startedAtMs - a.timings.startedAtMs);
        if (running.length > 0) return running[0];
        return [...state.stages].filter(s => s.status !== 'pending' && s.status !== 'skipped')
            .sort((a, b) => (b.timings.endedAtMs ?? b.timings.startedAtMs) - (a.timings.endedAtMs ?? a.timings.startedAtMs))[0];
    })();
    // The last progress line of a stage that is still running; a stopped or ended stage has no live progress.
    const liveProgress = current && current.status === 'running' && !runOver ? props.progress.get(current.stage) : undefined;
    const chips = state.stages.filter(s => s.layerIds.length > 0 || s.order >= 0 || s.status === 'degraded' || s.status === 'failed' || s.status === 'skipped' || s.status === 'stopped');
    const notes = props.layers.flatMap(l => [
        ...(l.outOfOrder ? [l.outOfOrder] : []),
        ...(l.phase === 'held' && l.heldBy.length > 0 ? [`${titleForLayer(state, l)} waits for ${l.heldBy.map(id => titleForId(state, id)).join(', ')} to reveal`] : []),
        ...(l.cutShort ? [`${titleForLayer(state, l)}: crossfade ended at once (the layer it replaced was removed)`] : []),
        ...(l.skipped ? [`${titleForLayer(state, l)}: reveal skipped (${l.skipped})`] : []),
        ...(l.loadFailed ? [`${titleForLayer(state, l)}: its file could not be loaded, so it is not drawn`] : [])
    ]);
    const skippedLine = props.skipNote ? `reveal skipped (${props.skipNote})` : undefined;
    const vm = state.visionModel;
    const degradations = state.degradations;
    // A retry is a new chat message, which aborts a turn that is still streaming: offered only once the run is over.
    const retryable = runOver ? degradations.filter(d => d.retry && d.transient) : [];
    const live = <div role="status" aria-live="polite" style={HIDDEN}>{props.announcement}</div>;

    const compact = collapsed || box.narrow;
    const panelStyle: React.CSSProperties = { ...PANEL, bottom: box.bottom, left: box.left, ...(box.maxHeight !== undefined ? { maxHeight: box.maxHeight } : {}) };

    if (compact) {
        const word = current ? `${current.title}: ${current.status}` : runWord;
        return (
            <div ref={panelRef} className="sb-staged-overlay" data-testid="sb-staged-overlay" data-collapsed="true" style={{ ...panelStyle, minWidth: 0, padding: '6px 10px' }} onKeyDown={onKeyDown}>
                <style>{FOCUS_CSS}</style>
                {live}
                <button type="button" className="sb-staged-build-button" style={BUTTON} aria-expanded={false} aria-label={`Staged build: ${word}. Show details`} onClick={() => setCollapsed(false)}>
                    {current ? `${GLYPH[current.status]} ${current.title} — ${current.status}` : `Staged build — ${runWord}`}
                </button>
            </div>
        );
    }

    return (
        <div ref={panelRef} className="sb-staged-overlay" data-testid="sb-staged-overlay" data-collapsed="false" style={panelStyle} onKeyDown={onKeyDown} aria-label="Staged location build">
            <style>{FOCUS_CSS}</style>
            {live}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }} data-testid="sb-staged-current">
                    {current ? `${current.title} — ${GLYPH[current.status]} ${current.status}` : 'Staged build'}
                    {current && stageTime(current, props.wallNowMs) !== undefined ? <span style={{ color: MUTED, fontWeight: 400 }}>{` · ${seconds(stageTime(current, props.wallNowMs))}`}</span> : null}
                </div>
                <button type="button" className="sb-staged-build-button" style={{ ...BUTTON, padding: '0 6px' }} aria-expanded={true} aria-label="Collapse the staged build panel" onClick={() => setCollapsed(true)}>–</button>
            </div>
            {current?.source ? <div style={{ color: MUTED }} data-testid="sb-staged-source">{current.source}</div> : null}
            {liveProgress?.message || liveProgress?.progress !== undefined
                ? <div style={{ color: MUTED }}>{[liveProgress.progress !== undefined ? `${Math.round(liveProgress.progress * 100)}%` : '', liveProgress.message ?? ''].filter(Boolean).join(' · ')}</div>
                : null}
            {runOver ? <div style={{ marginTop: 4 }} data-testid="sb-staged-runstate">{runSentence(state, props.interrupted)}</div> : null}

            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 4 }} aria-label="Stages">
                {chips.map(s => {
                    const t = stageTime(s, props.wallNowMs);
                    const cached = s.timings.cached ? `cached (built ${builtDate(s.timings.builtAtMs)})` : '';
                    const why = stageReason(state, s);
                    // a committed stage can still hold geometry that is not measurement: the chip says so beside the status
                    const inferredHere = s.status === 'committed' ? state.layers.filter(l => l.stage === s.stage && !l.retired && l.provenance.measuredGeometry === false) : [];
                    const inferredText = inferredHere.length ? `includes inferred or grown geometry (${[...new Set(inferredHere.map(l => String(l.provenance.label)))].join(', ')})` : '';
                    const costText = s.cost ? costWords(s.cost) : '';
                    const label = `${s.title}: ${s.status}${inferredText ? `, ${inferredText}` : ''}${t !== undefined ? `, ${(t / 1000).toFixed(1)} seconds` : ''}${costText ? `, ${costText}` : ''}${cached ? `, ${cached}` : ''}${why ? `. ${why}` : ''}`;
                    return (
                        <li key={s.stage} aria-label={label} data-stage-status={s.status} style={{ padding: '2px 6px', borderRadius: 6, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', ...(why ? { flex: '1 1 100%' } : {}) }}>
                            <span aria-hidden="true">{`${GLYPH[s.status]} ${s.title} ${s.status}${inferredText ? ' · inferred' : ''}${t !== undefined ? ` · ${seconds(t)}` : ''}${costText ? ` · ${costText}` : ''}${cached ? ` · ${cached}` : ''}`}</span>
                            {why ? <div aria-hidden="true" data-testid="sb-staged-stage-reason" style={{ color: MUTED }}>{why}</div> : null}
                        </li>
                    );
                })}
            </ul>

            {state.structure ? (
                <div style={{ marginTop: 6, color: MUTED }} data-testid="sb-staged-structure">
                    {`Structure ${formatM(state.structure.geocodeToStructureM)} from the geocoded point; extracted ${formatM(state.structure.extractionRadiusM)} around it (${state.structure.containmentRounds} ${state.structure.containmentRounds === 1 ? 'round' : 'rounds'})`}
                </div>
            ) : null}
            {state.materialHints ? <SurveyHints hints={state.materialHints} /> : null}
            {vm ? <div style={{ marginTop: 4, color: MUTED }} data-testid="sb-staged-vision">{visionSentence(vm)}</div> : null}
            {notes.length > 0 || skippedLine ? (
                <ul style={{ margin: '6px 0 0', paddingLeft: 16, color: MUTED }} data-testid="sb-staged-notes">
                    {[...notes, ...(skippedLine ? [skippedLine] : [])].map((n, i) => <li key={i}>{n}</li>)}
                </ul>
            ) : null}

            {degradations.length > 0 ? (
                <div style={{ marginTop: 8 }}>
                    <button type="button" className="sb-staged-build-button" style={BUTTON} aria-expanded={degradedOpen} onClick={() => setDegradedOpen(o => !o)} data-testid="sb-staged-degraded-toggle">
                        {`${degradedOpen ? '▾' : '▸'} ${degradations.length} degraded ${degradations.length === 1 ? 'part' : 'parts'}`}
                    </button>
                    {degradedOpen ? (
                        <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="sb-staged-degraded-list">
                            {degradations.map(d => {
                                const note = props.placements?.get(d.id);
                                const where = placementSentence(state, note);
                                return (
                                    <li key={d.id}>
                                        <button type="button" className="sb-staged-build-button" style={{ ...BUTTON, width: '100%', ...(props.highlightedId === d.id ? { borderColor: '#D55E00' } : {}) }}
                                            aria-pressed={props.highlightedId === d.id}
                                            aria-label={`${d.part.description} fell to ${d.fellTo}: ${d.reason}${note?.scope === 'none' ? ' It has no separate part to highlight in the viewport.' : ' Highlight it in the viewport.'}`}
                                            onClick={() => props.onHighlight(d)}>
                                            <div>{`${d.part.description} → ${d.fellTo}`}</div>
                                            <div style={{ color: MUTED }}>{d.reason}</div>
                                            {where ? <div style={{ color: MUTED }} data-testid="sb-staged-degraded-where">{where}</div> : null}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : null}
                </div>
            ) : null}
            {retryable.map(d => (
                <div key={`retry-${d.id}`} style={{ marginTop: 6 }}>
                    <button type="button" className="sb-staged-build-button" style={BUTTON} onClick={() => props.onRetry(d)} aria-label={`Retry the ${stageTitle(state, d.stage)} stage`}>
                        {`Retry ${stageTitle(state, d.stage)}`}
                    </button>
                </div>
            ))}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                <button type="button" className="sb-staged-build-button" style={{ ...BUTTON, ...(props.provenanceOn ? { background: 'rgba(86,180,233,0.25)', borderColor: '#56B4E9' } : {}) }} aria-pressed={props.provenanceOn} onClick={props.onToggleProvenance} data-testid="sb-staged-provenance-toggle">
                    Provenance
                </button>
                {runOver ? (
                    <>
                        <button type="button" className="sb-staged-build-button" style={BUTTON} onClick={props.onReplay} data-testid="sb-staged-replay">Replay build</button>
                        <button type="button" className="sb-staged-build-button" style={{ ...BUTTON, ...(props.showReplaced ? { background: 'rgba(255,255,255,0.2)' } : {}) }} aria-pressed={props.showReplaced} onClick={props.onToggleShowReplaced} data-testid="sb-staged-show-replaced">Show replaced layers</button>
                    </>
                ) : null}
            </div>
            {props.provenanceOn ? (
                <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }} aria-label="Provenance legend" data-testid="sb-staged-legend">
                    {props.legend.map(row => (
                        <li key={row.key} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', paddingLeft: row.indent ? 14 : 0 }}>
                            <SwatchBox row={row} />
                            <span>{row.text}{row.count !== undefined ? <span style={{ color: MUTED }}>{` (${row.count.toLocaleString('en-US')} ${row.count === 1 ? 'vertex' : 'vertices'})`}</span> : null}{row.unknown ? <span style={{ color: MUTED }}> (not in the legend)</span> : null}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
            <div style={{ marginTop: 8, color: MUTED }} data-testid="sb-staged-attribution">{state.attribution.join(' · ') || 'Map data ©Google'}</div>
        </div>
    );
};

function formatM(m: number): string {
    return `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
}

function stageTitle(state: StagedBuildState, stage: string): string {
    return state.stages.find(s => s.stage === stage)?.title || stage;
}

/** A layer's name in a sentence: its stage's title, with the layer's own code when the stage owns several layers. */
function layerName(state: StagedBuildState, layer: StagedLayer): string {
    const title = stageTitle(state, layer.stage);
    return state.layers.filter(l => l.stage === layer.stage).length > 1 ? `${title} (${layer.layer})` : title;
}

function titleForLayer(state: StagedBuildState, l: LayerRevealFrame): string {
    return layerName(state, l.layer);
}

function titleForId(state: StagedBuildState, objectId: string): string {
    const layer = state.layers.find(l => l.objectId === objectId);
    if (layer) return layerName(state, layer);
    const owner = state.stages.find(s => s.layerIds.includes(objectId));
    return owner?.title || objectId;
}

function visionSentence(vm: NonNullable<StagedBuildState['visionModel']>): string {
    const thinking = 'level' in vm.thinking ? `thinking ${vm.thinking.level.toLowerCase()}` : `thinking budget ${vm.thinking.budget}`;
    if (vm.outcome === 'failed') {
        const tried = [vm.requested, ...vm.skipped.map(s => s.model)].filter((m, i, a) => m && a.indexOf(m) === i).join(', ');
        return `Tried ${tried || vm.requested} (${thinking}): ${vm.error ?? 'no answer'}`;
    }
    const ttft = vm.ttftMs !== undefined ? `first token ${(vm.ttftMs / 1000).toFixed(1)} s, ` : '';
    const base = `Detail read by ${vm.used} (${thinking}; ${ttft}${(vm.ms / 1000).toFixed(1)} s)`;
    const fallback = vm.used !== vm.requested ? ` instead of ${vm.requested}: ${vm.skipped.find(s => s.model === vm.requested)?.reason ?? vm.skipped[0]?.reason ?? 'fallback'}` : '';
    return base + fallback;
}

/** Why a stage did not commit in full, in one sentence: its own reason, else the first of its degradation records'. */
function stageReason(state: StagedBuildState, s: StageSummary): string | undefined {
    if (s.status !== 'degraded' && s.status !== 'failed' && s.status !== 'skipped' && s.status !== 'stopped') return undefined;
    if (s.reason) return s.reason;
    return state.degradations.find(d => s.degradationIds.includes(d.id))?.reason;
}

/** What the highlight does for a degraded part, when that is not simply "shades the part". */
function placementSentence(state: StagedBuildState, note: DegradationPlacementNote | undefined): string {
    if (!note || note.scope === 'part') return '';
    if (note.scope === 'none') return 'No separate part to highlight in the viewport.';
    const names = [...new Set(note.layerIds.map(id => state.layers.find(l => l.objectId === id)).filter((l): l is StagedLayer => !!l).map(l => layerName(state, l)))];
    return names.length > 0 ? `Highlights the whole of ${names.join(', ')}.` : '';
}

/**
 * The end-of-run sentence: what is in the scene, what fell to simpler real data and why, what was skipped and why, and
 * what was not built and why. A degraded stage's output is not listed as built.
 */
function runSentence(state: StagedBuildState, interrupted: boolean): string {
    const head = interrupted ? 'Interrupted' : state.runState === 'stopped' ? 'Stopped' : state.runState === 'failed' ? 'Failed' : 'Finished';
    const by = (...statuses: StageStatus[]) => state.stages.filter(s => statuses.includes(s.status));
    const list = (stages: StageSummary[]) => {
        // A reason is a sentence; inside parentheses it loses its full stop.
        const items = stages.map(s => { const why = stageReason(state, s); return why ? `${s.title} (${why.replace(/[.\s]+$/, '')})` : s.title; });
        return items.join(stages.some(s => stageReason(state, s)) ? '; ' : ', ');
    };
    const committed = by('committed');
    const inScene = committed.filter(s => s.layerIds.length > 0);
    const alsoDone = committed.filter(s => s.layerIds.length === 0);
    const degraded = by('degraded');
    const skipped = by('skipped');
    const unbuilt = by('stopped', 'failed');
    const finishedClean = state.runState === 'finished' && !interrupted;
    const scene = inScene.length > 0 ? (finishedClean ? `Finished: ${list(inScene)} in the scene.` : `${head}. ${list(inScene)} stay in the scene.`) : `${head}.`;
    return [
        scene,
        alsoDone.length > 0 ? `Also done: ${list(alsoDone)}.` : '',
        degraded.length > 0 ? `Fell to simpler real data: ${list(degraded)}.` : '',
        skipped.length > 0 ? `Skipped: ${list(skipped)}.` : '',
        unbuilt.length > 0 ? `Not built: ${list(unbuilt)}.` : '',
        state.retry && (state.retry.stages.length > 0 || !finishedClean) ? `Retry with retryRunId ${state.retry.retryRunId}.` : ''
    ].filter(Boolean).join(' ');
}

/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import type { SetCameraLensParams } from '../../services/operators/lighting-camera-operators';
import { planViewportOptics } from './viewportOptics';
import {
    type CameraCommand,
    type SceneCamera,
    cameraFov,
    effectiveFocalLength,
    focalLengthCommands,
    lensCommands,
    resetCameraCommands,
    sensorCommands,
    sensorOf
} from './cameraSettings';

/** Convenience values only: each fills the continuous field, nothing branches on them. */
const FOCAL_QUICK_PICKS_MM = [8, 14, 24, 35, 50, 85, 135, 200];
/** The focal range the panel's slider and field cover (the operators accept any positive focal length). */
export const FOCAL_RANGE_MM = { min: 8, max: 200 } as const;
const LOG_MIN = Math.log(FOCAL_RANGE_MM.min);
const LOG_SPAN = Math.log(FOCAL_RANGE_MM.max) - LOG_MIN;
/** Log-scaled slider position (0..1000) of a focal length, so 8-24 mm get as much travel as 70-200 mm. */
export const focalToSlider = (mm: number): number =>
    Math.round(1000 * (Math.log(Math.min(FOCAL_RANGE_MM.max, Math.max(FOCAL_RANGE_MM.min, mm))) - LOG_MIN) / LOG_SPAN);
export const sliderToFocal = (pos: number): number => Number(Math.exp(LOG_MIN + (pos / 1000) * LOG_SPAN).toFixed(1));
const FSTOP_QUICK_PICKS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];
const SQUEEZE_QUICK_PICKS = [1, 1.33, 1.5, 2];
const COMMON_SENSORS_MM: ReadonlyArray<{ label: string; width: number; height: number }> = [
    { label: 'Full frame 36 × 24', width: 36, height: 24 },
    { label: 'Super 35 24.89 × 18.66', width: 24.89, height: 18.66 },
    { label: 'APS-C 23.6 × 15.6', width: 23.6, height: 15.6 },
    { label: 'Micro 4/3 17.3 × 13', width: 17.3, height: 13 },
    { label: '1 inch 13.2 × 8.8', width: 13.2, height: 8.8 },
    { label: '65 mm 52.48 × 23.01', width: 52.48, height: 23.01 }
];

type DistortionKey = 'k1' | 'k2' | 'k3' | 'p1' | 'p2';
const DISTORTION_RANGE: Record<DistortionKey, { min: number; max: number; step: number }> = {
    k1: { min: -0.5, max: 0.5, step: 0.001 },
    k2: { min: -0.5, max: 0.5, step: 0.001 },
    k3: { min: -0.5, max: 0.5, step: 0.001 },
    p1: { min: -0.05, max: 0.05, step: 0.0005 },
    p2: { min: -0.05, max: 0.05, step: 0.0005 }
};

const BTN = 'relative group flex items-center justify-center w-5 h-5 rounded-md transition-all';
const IDLE = 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent';
const ACTIVE = 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30';
// The app has no utility-class build: the panel is styled by these classes in browser/style/unified-ui.css.
const CHIP = 'sb-cam-chip';
const CHIP_IDLE = '';
const CHIP_ON = 'sb-cam-chip-on';
const INPUT = 'sb-cam-input';

const fmt = (v: number, digits = 2): string => String(Number(v.toFixed(digits)));
const near = (a: number | undefined, b: number, tol = 1e-3): boolean => a !== undefined && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

export interface CameraSettingsControlProps {
    /** The scene camera (scene data is the only source of what the panel shows). */
    camera: SceneCamera | undefined;
    /** What the viewport could not draw of the lens (the "Lens optics not fully drawn" notice). */
    opticsIssues: string[];
    /** Runs operator commands as one undoable step; returns the operator's refusal (nothing changed) or null. */
    onCommands: (commands: CameraCommand[], meta: { label: string; continuous?: boolean }) => string | null;
    /** Stores the current view as the scene camera (kept on reload). */
    onSaveView: () => string | null;
    /** Moves the view to the stored camera pose. */
    onRestoreView: () => void;
    pickingFocus: boolean;
    onPickingFocusChange: (on: boolean) => void;
    /** Why the last viewport focus pick changed nothing, if it did not. */
    pickError?: string | null;
    /** The focus distance the viewport measured last frame (a tracked focus object), when it draws depth of field. */
    readFocusDistance?: () => number | null;
}

/** A continuous numeric field: edits commit on Enter or blur; an empty field removes the value when `onClear` is given. */
const NumberField: React.FC<{
    label: string;
    value: number | undefined;
    placeholder?: string;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
    testId: string;
    onCommit: (v: number) => void;
    onClear?: () => void;
}> = ({ label, value, placeholder, unit, min, max, step, testId, onCommit, onClear }) => {
    const shown = value === undefined ? '' : fmt(value, 4);
    const [draft, setDraft] = React.useState(shown);
    React.useEffect(() => setDraft(shown), [shown]);
    const commit = () => {
        const text = draft.trim();
        if (text === shown) return;
        if (text === '') {
            if (onClear) onClear(); else setDraft(shown);
            return;
        }
        const v = Number(text);
        if (!Number.isFinite(v)) { setDraft(shown); return; }
        // out-of-range values are brought to the field's range (shown back if that changes nothing)
        const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
        // the field shows the scene value again: the new one once the edit lands, the old one if it was refused
        setDraft(shown);
        if (String(clamped) === shown) return;
        onCommit(clamped);
    };
    return (
        <label className="sb-cam-row">
            <span className="sb-cam-label">{label}</span>
            <input
                type="number"
                inputMode="decimal"
                aria-label={label}
                data-testid={testId}
                className={INPUT}
                value={draft}
                placeholder={placeholder}
                min={min}
                max={max}
                step={step ?? 'any'}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
            />
            {unit && <span className="sb-cam-unit">{unit}</span>}
        </label>
    );
};

const Section: React.FC<{ title: string; children: React.ReactNode; aside?: React.ReactNode }> = ({ title, children, aside }) => (
    <section className="sb-cam-section">
        <div className="sb-cam-section-head">
            <h3>{title}</h3>
            {aside}
        </div>
        {children}
    </section>
);

/**
 * The camera button in the viewport tool strip and its anchored settings panel: lens (focal length, sensor, the
 * field of view they give), depth of field (switch, f-stop, focus distance, pick focus in the viewport), lens
 * distortion, anamorphic squeeze, saving and restoring the view, and a reset. Every edit is an operator command.
 */
export const CameraSettingsControl: React.FC<CameraSettingsControlProps> = ({
    camera, opticsIssues, onCommands, onSaveView, onRestoreView, pickingFocus, onPickingFocusChange, pickError, readFocusDistance
}) => {
    const [open, setOpen] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [showAdvanced, setShowAdvanced] = React.useState(false);
    const [measuredFocus, setMeasuredFocus] = React.useState<number | null>(null);
    const [maxHeight, setMaxHeight] = React.useState<number | undefined>(undefined);
    const wrapperRef = React.useRef<HTMLDivElement>(null);
    const buttonRef = React.useRef<HTMLButtonElement>(null);
    const panelRef = React.useRef<HTMLDivElement>(null);
    const panelId = React.useId();
    const pickingRef = React.useRef(pickingFocus);
    pickingRef.current = pickingFocus;

    const lens = camera?.lens;
    const fov = cameraFov(camera);
    const focal = effectiveFocalLength(camera);
    const sensor = sensorOf(lens);
    // horizontal field of view on the sensor's own aspect (the viewport's width follows its panel)
    const horizontalFov = (2 * Math.atan((sensor.width / sensor.height) * Math.tan((fov * Math.PI) / 360)) * 180) / Math.PI;
    const distortion = lens?.distortion;
    const plan = planViewportOptics(lens);
    const wantsDof = lens?.apertureFStop !== undefined || lens?.focusDistanceMeters !== undefined || !!lens?.focusObjectId;
    const dofOn = lens?.depthOfField === true || (lens?.depthOfField !== false && wantsDof);
    const dofMissing = plan.issues.find(i => i.startsWith('depth of field needs'));
    // the depth-of-field hint is shown in its own section
    const notDrawn = opticsIssues.filter(i => !i.startsWith('depth of field needs'));

    const close = React.useCallback((restoreFocus: boolean) => {
        setOpen(false);
        if (pickingRef.current) onPickingFocusChange(false);
        if (restoreFocus) buttonRef.current?.focus();
    }, [onPickingFocusChange]);

    const run = (commands: CameraCommand[], label: string, continuous = false) => {
        const refused = onCommands(commands, { label, continuous });
        setError(refused);
    };
    const runLens = (params: SetCameraLensParams, label: string, continuous = false) => run(lensCommands(camera, params), label, continuous);

    // Escape closes (or first cancels picking); a press outside closes, except while picking focus in the viewport.
    React.useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            if (pickingRef.current) onPickingFocusChange(false);
            else close(true);
        };
        const onDown = (e: MouseEvent) => {
            if (pickingRef.current) return;
            if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) close(false);
        };
        window.addEventListener('keydown', onKey, true);
        document.addEventListener('mousedown', onDown, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            document.removeEventListener('mousedown', onDown, true);
        };
    }, [open, close, onPickingFocusChange]);

    // Fit the panel to the viewport below its button and move focus into it.
    React.useLayoutEffect(() => {
        if (!open) return;
        const wrapper = wrapperRef.current;
        const host = wrapper?.closest('.sb-scene3d-primitive-container') as HTMLElement | null;
        if (wrapper && host) {
            const room = host.getBoundingClientRect().bottom - wrapper.getBoundingClientRect().top - 12;
            setMaxHeight(room > 120 ? room : undefined);
        }
        panelRef.current?.focus();
    }, [open]);

    React.useEffect(() => {
        if (!open || !readFocusDistance) return;
        const tick = () => setMeasuredFocus(readFocusDistance());
        tick();
        const timer = setInterval(tick, 500);
        return () => clearInterval(timer);
    }, [open, readFocusDistance]);

    const distortionRow = (key: DistortionKey) => {
        const range = DISTORTION_RANGE[key];
        const value = distortion?.[key] ?? 0;
        return (
            <div key={key} className="sb-cam-row">
                <span className="sb-cam-key">{key}</span>
                <input
                    type="range"
                    aria-label={`${key} slider`}
                    data-testid={`sb-camera-${key}-slider`}
                    className="sb-cam-range"
                    min={range.min}
                    max={range.max}
                    step={range.step}
                    value={Math.max(range.min, Math.min(range.max, value))}
                    onChange={e => runLens({ distortion: { k1: distortion?.k1 ?? 0, [key]: Number(e.target.value) } }, `Lens distortion ${key}`, true)}
                />
                <div className="sb-cam-num">
                    <NumberField
                        label={key}
                        value={value}
                        testId={`sb-camera-${key}`}
                        onCommit={v => runLens({ distortion: { k1: distortion?.k1 ?? 0, [key]: v } }, `Lens distortion ${key} = ${v}`)}
                    />
                </div>
            </div>
        );
    };

    return (
        <div ref={wrapperRef} className="sb-3d-camera-control">
            <button
                ref={buttonRef}
                type="button"
                aria-label="Camera settings"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                data-testid="sb-3d-camera-settings"
                className={`sb-3d-toolstrip-btn ${BTN} ${open ? ACTIVE : IDLE}`}
                onClick={() => (open ? close(false) : setOpen(true))}
                title="Camera Settings: lens, depth of field, distortion"
            >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                </svg>
            </button>

            {open && (
                <div
                    ref={panelRef}
                    id={panelId}
                    role="dialog"
                    aria-label="Camera settings"
                    tabIndex={-1}
                    data-testid="sb-3d-camera-panel"
                    className="sb-3d-camera-panel"
                    style={{ maxHeight }}
                >
                    <div className="sb-cam-header">
                        <span>Camera</span>
                        <button
                            type="button"
                            aria-label="Close camera settings"
                            className="sb-cam-close"
                            onClick={() => close(true)}
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                        </button>
                    </div>

                    <Section title="Lens">
                        <div className="sb-cam-chips" role="group" aria-label="Focal length quick picks">
                            {FOCAL_QUICK_PICKS_MM.map(mm => (
                                <button
                                    key={mm}
                                    type="button"
                                    data-testid={`sb-camera-focal-${mm}`}
                                    aria-pressed={near(lens?.focalLengthMm, mm)}
                                    className={`${CHIP} ${near(lens?.focalLengthMm, mm) ? CHIP_ON : CHIP_IDLE}`}
                                    onClick={() => run(focalLengthCommands(camera, mm), `Camera: ${mm} mm lens`)}
                                >
                                    {mm}
                                </button>
                            ))}
                        </div>
                        <div className="sb-cam-row">
                            <span className="sb-cam-label">{`${FOCAL_RANGE_MM.min}–${FOCAL_RANGE_MM.max}`}</span>
                            <input
                                type="range"
                                aria-label="Focal length slider"
                                aria-valuetext={`${fmt(focal.mm, 1)} mm`}
                                data-testid="sb-camera-focal-slider"
                                className="sb-cam-range"
                                min={0}
                                max={1000}
                                step={1}
                                value={focalToSlider(focal.mm)}
                                onChange={e => {
                                    const mm = sliderToFocal(Number(e.target.value));
                                    run(focalLengthCommands(camera, mm), `Camera: ${mm} mm lens`, true);
                                }}
                            />
                        </div>
                        <NumberField
                            label="Focal"
                            unit="mm"
                            min={FOCAL_RANGE_MM.min}
                            max={FOCAL_RANGE_MM.max}
                            value={lens?.focalLengthMm}
                            placeholder={`${fmt(focal.mm, 1)} (from FOV)`}
                            testId="sb-camera-focal"
                            onCommit={v => run(focalLengthCommands(camera, v), `Camera: ${fmt(v, 1)} mm lens`)}
                        />
                        <div className="sb-cam-row">
                            <span className="sb-cam-label">Sensor</span>
                            <select
                                aria-label="Common sensor sizes"
                                data-testid="sb-camera-sensor-preset"
                                className={`${INPUT} sb-cam-select`}
                                value=""
                                onChange={e => {
                                    const s = COMMON_SENSORS_MM[Number(e.target.value)];
                                    if (s) run(sensorCommands(camera, s.width, s.height), `Camera: ${s.width} × ${s.height} mm sensor`);
                                }}
                            >
                                <option value="">{`${fmt(sensor.width)} × ${fmt(sensor.height)} mm${sensor.assumed ? ' (assumed)' : ''}`}</option>
                                {COMMON_SENSORS_MM.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
                            </select>
                        </div>
                        <div className="sb-cam-pair">
                            <NumberField label="W" unit="mm" min={0.1} value={lens?.sensorWidthMm} placeholder={fmt(sensor.width)} testId="sb-camera-sensor-w"
                                onCommit={v => run(sensorCommands(camera, v, sensor.height), `Camera: ${v} mm sensor width`)} />
                            <NumberField label="H" unit="mm" min={0.1} value={lens?.sensorHeightMm} placeholder={fmt(sensor.height)} testId="sb-camera-sensor-h"
                                onCommit={v => run(sensorCommands(camera, sensor.width, v), `Camera: ${v} mm sensor height`)} />
                        </div>
                        <div className="sb-cam-readout" data-testid="sb-camera-fov">
                            <span>Field of view</span>
                            <span className="sb-cam-value">{`${fmt(fov, 1)}° V · ${fmt(horizontalFov, 1)}° H`}</span>
                        </div>
                    </Section>

                    <Section
                        title="Depth of field"
                        aside={
                            <button
                                type="button"
                                role="switch"
                                aria-checked={dofOn}
                                aria-label="Depth of field"
                                data-testid="sb-camera-dof"
                                className={`sb-cam-switch${dofOn ? ' sb-cam-switch-on' : ''}`}
                                onClick={() => runLens({ depthOfField: !dofOn }, dofOn ? 'Depth of field off' : 'Depth of field on')}
                            >
                                <span className="sb-cam-switch-knob" />
                            </button>
                        }
                    >
                        <div className="sb-cam-chips" role="group" aria-label="f-stop quick picks">
                            {FSTOP_QUICK_PICKS.map(n => (
                                <button
                                    key={n}
                                    type="button"
                                    data-testid={`sb-camera-fstop-${n}`}
                                    aria-pressed={near(lens?.apertureFStop, n)}
                                    className={`${CHIP} ${near(lens?.apertureFStop, n) ? CHIP_ON : CHIP_IDLE}`}
                                    onClick={() => runLens({ apertureFStop: n }, `Camera: f/${n}`)}
                                >
                                    {`f/${n}`}
                                </button>
                            ))}
                        </div>
                        <NumberField label="f-stop" min={0.1} value={lens?.apertureFStop} placeholder="—" testId="sb-camera-fstop"
                            onCommit={v => runLens({ apertureFStop: v }, `Camera: f/${v}`)} onClear={() => runLens({ apertureFStop: null }, 'Camera: f-stop removed')} />
                        {lens?.focusObjectId ? (
                            <div className="sb-cam-row" data-testid="sb-camera-focus-object">
                                <span className="sb-cam-label">Focus on</span>
                                <span className="sb-cam-value sb-cam-truncate" title={lens.focusObjectId}>{lens.focusObjectId}</span>
                                <button type="button" className={`${CHIP} ${CHIP_IDLE}`} aria-label="Stop tracking the focus object"
                                    onClick={() => runLens(measuredFocus ? { focusDistanceMeters: Number(measuredFocus.toFixed(3)), focusObjectId: null } : { focusObjectId: null }, 'Camera: focus distance')}>
                                    Clear
                                </button>
                            </div>
                        ) : (
                            <NumberField label="Focus" unit="m" min={0.001} value={lens?.focusDistanceMeters} placeholder="—" testId="sb-camera-focus"
                                onCommit={v => runLens({ focusDistanceMeters: v, focusObjectId: null }, `Camera: focus ${v} m`)}
                                onClear={() => runLens({ focusDistanceMeters: null }, 'Camera: focus removed')} />
                        )}
                        {lens?.focusObjectId && measuredFocus !== null && (
                            <div className="sb-cam-note sb-cam-right" data-testid="sb-camera-focus-measured">{`now ${fmt(measuredFocus, 2)} m from the camera`}</div>
                        )}
                        <button
                            type="button"
                            aria-pressed={pickingFocus}
                            data-testid="sb-camera-pick-focus"
                            className={`${CHIP} sb-cam-wide ${pickingFocus ? CHIP_ON : CHIP_IDLE}`}
                            onClick={() => onPickingFocusChange(!pickingFocus)}
                        >
                            {pickingFocus ? 'Click a point in the viewport (Esc cancels)' : 'Pick focus in viewport'}
                        </button>
                        {pickingFocus && <div className="sb-cam-note">Click focuses at that point; Alt-click focuses on the whole object and follows it.</div>}
                        {pickError && <div role="alert" className="sb-cam-error-text" data-testid="sb-camera-pick-error">{pickError}</div>}
                        {dofOn && dofMissing && <div className="sb-cam-warn-text" data-testid="sb-camera-dof-missing">{`Not drawn yet: ${dofMissing}.`}</div>}
                    </Section>

                    <Section
                        title="Lens distortion"
                        aside={
                            <button type="button" data-testid="sb-camera-distortion-reset" className={`${CHIP} ${CHIP_IDLE}`} disabled={!distortion}
                                onClick={() => runLens({ distortion: null }, 'Lens distortion reset')}>
                                Reset
                            </button>
                        }
                    >
                        {distortionRow('k1')}
                        {distortionRow('k2')}
                        <button
                            type="button"
                            aria-expanded={showAdvanced}
                            className="sb-cam-disclosure"
                            onClick={() => setShowAdvanced(s => !s)}
                        >
                            {showAdvanced ? '▾ Advanced (k3, p1, p2)' : '▸ Advanced (k3, p1, p2)'}
                        </button>
                        {showAdvanced && (['k3', 'p1', 'p2'] as const).map(distortionRow)}
                        <div className="sb-cam-note">k1 &lt; 0 barrel, k1 &gt; 0 pincushion (normalized camera coordinates).</div>
                    </Section>

                    <Section title="Anamorphic squeeze">
                        <div className="sb-cam-chips" role="group" aria-label="Squeeze quick picks">
                            {SQUEEZE_QUICK_PICKS.map(s => (
                                <button key={s} type="button" data-testid={`sb-camera-squeeze-${s}`}
                                    aria-pressed={near(lens?.anamorphicSqueeze ?? 1, s)}
                                    className={`${CHIP} ${near(lens?.anamorphicSqueeze ?? 1, s) ? CHIP_ON : CHIP_IDLE}`}
                                    onClick={() => runLens({ anamorphicSqueeze: s }, `Camera: ${s}x squeeze`)}>
                                    {`${s}x`}
                                </button>
                            ))}
                        </div>
                        <NumberField label="Squeeze" unit="x" min={0.01} value={lens?.anamorphicSqueeze} placeholder="1" testId="sb-camera-squeeze"
                            onCommit={v => runLens({ anamorphicSqueeze: v }, `Camera: ${v}x squeeze`)} onClear={() => runLens({ anamorphicSqueeze: null }, 'Camera: squeeze removed')} />
                        <div className="sb-cam-note">Shapes the bokeh and distortion; the viewport keeps its own aspect ratio.</div>
                    </Section>

                    <Section title="View">
                        <div className="sb-cam-pair">
                            <button type="button" data-testid="sb-camera-save-view" className={`${CHIP} sb-cam-wide`}
                                title="Store this view as the scene camera; the scene opens on it after a reload"
                                onClick={() => setError(onSaveView())}>
                                Save camera
                            </button>
                            <button type="button" data-testid="sb-camera-restore-view" className={`${CHIP} sb-cam-wide`}
                                disabled={!camera?.position} title="Move the view to the stored camera pose"
                                onClick={onRestoreView}>
                                Restore saved
                            </button>
                        </div>
                        {camera?.keepPoseOnLoad && <div className="sb-cam-note" data-testid="sb-camera-pose-kept">Saved view: the scene opens on it.</div>}
                        <div className="sb-cam-note">Clip planes are automatic (the near plane follows the viewing distance).</div>
                    </Section>

                    {notDrawn.length > 0 && (
                        <div className="sb-cam-notice" data-testid="sb-camera-optics-notice">
                            <div className="sb-cam-notice-title">Lens optics not fully drawn</div>
                            {notDrawn.map(i => <div key={i}>{i}</div>)}
                        </div>
                    )}
                    {error && (
                        <div role="alert" className="sb-cam-error" data-testid="sb-camera-error">{error}</div>
                    )}

                    <button
                        type="button"
                        data-testid="sb-camera-reset-all"
                        className={`${CHIP} sb-cam-wide sb-cam-danger`}
                        onClick={() => run(resetCameraCommands(), 'Reset camera settings')}
                    >
                        Reset all camera settings
                    </button>
                </div>
            )}
        </div>
    );
};

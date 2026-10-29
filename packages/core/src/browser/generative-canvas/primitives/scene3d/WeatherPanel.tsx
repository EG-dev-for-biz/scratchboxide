/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport's Weather tool: a tool strip button and its panel, anchored beside it like the camera settings
 * (CameraSettingsControl.tsx, the same panel styles). Time of day (dawn through day into night, with play), the date,
 * cloud cover, haze and fog. Every change goes through scene-weather.ts applySceneWeather, the same function the scene
 * graph's Weather node uses; "Off" restores the sky the scene had before.
 */

import * as React from 'react';
import type { Scene3DData } from '../../canvas-types';
import { applySceneWeather, clearSceneWeather, DEFAULT_SCENE_WEATHER, formatTimeOfDay, readSceneWeather, sceneLocation, weatherPhase, weatherSun, type SceneWeather } from '../../services/atmosphere/scene-weather';

export interface WeatherControlProps {
    sceneData: Scene3DData;
    mutateSceneData: (mutator: (prev: Scene3DData) => Scene3DData, opInfo?: { operator: string; params?: any }, options?: { history?: false }) => void;
}

/** Hours the play button advances per tick, and the tick (ms). */
const PLAY_STEP_H = 0.25, PLAY_TICK_MS = 250;

export function WeatherControl({ sceneData, mutateSceneData }: WeatherControlProps): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const [playing, setPlaying] = React.useState(false);
    const current = readSceneWeather(sceneData);
    const w: SceneWeather = current ?? DEFAULT_SCENE_WEATHER;
    const loc = sceneLocation(sceneData);
    const sun = weatherSun(w, loc);
    const latest = React.useRef(w);
    latest.current = w;
    // the weather switched off is remembered, so switching it back on brings the same day back
    const lastOn = React.useRef<SceneWeather | undefined>(current);
    if (current) lastOn.current = current;
    const toggle = () => {
        setPlaying(false);
        if (current) mutateSceneData(prev => clearSceneWeather(prev), { operator: 'clear_weather' });
        else mutateSceneData(prev => applySceneWeather(prev, lastOn.current ?? {}), { operator: 'set_weather', params: lastOn.current ?? {} });
    };

    // a change while dragging or playing is kept out of the undo history; the release records one step
    const set = React.useCallback((patch: Partial<SceneWeather>, live = false) => {
        mutateSceneData(prev => applySceneWeather(prev, patch), { operator: 'set_weather', params: patch }, live ? { history: false } : undefined);
    }, [mutateSceneData]);

    React.useEffect(() => {
        if (!playing) return;
        const id = window.setInterval(() => set({ timeOfDay: (latest.current.timeOfDay + PLAY_STEP_H) % 24 }, true), PLAY_TICK_MS);
        return () => window.clearInterval(id);
    }, [playing, set]);
    React.useEffect(() => { if (!open) setPlaying(false); }, [open]);

    const range = (label: string, key: 'cloudCover' | 'haze' | 'fog') => (
        <div className="sb-cam-section" key={key}>
            <div className="sb-cam-readout"><span>{label}</span><span className="sb-cam-value">{Math.round(w[key] * 100)}%</span></div>
            <input
                type="range" min={0} max={1} step={0.01} value={w[key]} aria-label={label} className="sb-cam-range"
                onChange={e => set({ [key]: Number(e.target.value) } as Partial<SceneWeather>, true)}
                onPointerUp={e => set({ [key]: Number((e.target as HTMLInputElement).value) } as Partial<SceneWeather>)}
            />
        </div>
    );

    return (
        <div className="sb-3d-camera-control sb-3d-weather-control">
            <button
                type="button"
                className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${open ? 'sb-3d-toolstrip-btn-active' : ''}`}
                onClick={() => setOpen(v => !v)}
                title="Weather: time of day, clouds, haze, fog"
                aria-label="Weather"
                aria-pressed={open}
            >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M19.1 4.9l-1.4 1.4M16 12a4 4 0 0 0-7.7-1.5" />
                    <path d="M17.5 19H9a5 5 0 1 1 4.6-7h1.4a3.5 3.5 0 1 1 2.5 7z" />
                </svg>
            </button>
            {open && (
                <div className="sb-3d-camera-panel sb-3d-weather-panel" role="dialog" aria-label="Weather">
                    <div className="sb-cam-header">
                        <span>Weather</span>
                        <div className="sb-cam-row">
                            <button
                                type="button" role="switch" aria-checked={!!current} aria-label="Weather on"
                                className={`sb-cam-switch ${current ? 'sb-cam-switch-on' : ''}`}
                                onClick={toggle}
                                title={current ? 'Turn the weather off (the scene keeps its own sky)' : 'Turn the weather on'}
                            ><span className="sb-cam-switch-knob" /></button>
                            <button type="button" className="sb-cam-close" onClick={() => setOpen(false)} aria-label="Close weather">×</button>
                        </div>
                    </div>
                    {!current && <div className="sb-cam-note">Weather is off: the scene keeps its own look. Switch it on, or change anything below.</div>}
                    <div className="sb-cam-section">
                        <div className="sb-cam-readout">
                            <span>Time of day</span>
                            <span className="sb-cam-value">{formatTimeOfDay(w.timeOfDay)} · {weatherPhase(sun.elevationDeg)}</span>
                        </div>
                        <div className="sb-cam-row">
                            <button type="button" className={`sb-cam-chip ${playing ? 'sb-cam-chip-on' : ''}`} onClick={() => setPlaying(p => !p)} aria-label={playing ? 'Pause the day' : 'Play through the day'}>{playing ? 'Pause' : 'Play'}</button>
                            <input
                                type="range" min={0} max={24} step={0.05} value={w.timeOfDay} aria-label="Time of day" className="sb-cam-range"
                                onChange={e => set({ timeOfDay: Number(e.target.value) }, true)}
                                onPointerUp={e => set({ timeOfDay: Number((e.target as HTMLInputElement).value) })}
                            />
                        </div>
                        <div className="sb-cam-row">
                            <span className="sb-cam-label">Date</span>
                            <input type="date" className="sb-cam-input" value={w.date ?? ''} aria-label="Date" onChange={e => set({ date: e.target.value || undefined })} />
                        </div>
                    </div>
                    {range('Cloud cover', 'cloudCover')}
                    {range('Haze', 'haze')}
                    {range('Fog', 'fog')}
                    <div className="sb-cam-note">
                        {sun.source === 'ephemeris'
                            ? `Sun from the ephemeris at ${loc!.lat.toFixed(3)}, ${loc!.lng.toFixed(3)}: ${sun.elevationDeg.toFixed(1)}° up, ${sun.azimuthDeg.toFixed(0)}° azimuth.`
                            : `No place is set, so the sun follows a plain path (rises east at 06:00, sets west at 18:00): ${sun.elevationDeg.toFixed(1)}° up.`}
                    </div>
                </div>
            )}
        </div>
    );
}

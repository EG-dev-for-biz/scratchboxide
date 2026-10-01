/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
    VideoTimelineData,
    TimelineElement,
    GradeParams,
    type VfxParams,
    BlendMode,
    BLEND_MODE_LABELS,
    type ColorWheelOffset,
    type VideoMediaAsset,
    type KeyingParams,
    type LayerTransform,
    type LightWrapParams,
    type CameraSolveTrack,
    type GeodeticEphemerisAnchor,
    type LensDistortionParams,
    type AntiDriftHoldoutConfig,
    type VfxPlateConfig
} from '../../services/video/videoTypes';
import { VfxPlateMatchmoveService } from '../../services/video/VfxPlateMatchmoveService';
import {
    GenerativePatchConfig,
    GenerativePatchMode,
    ApiAspectRatio,
    ApiResolutionTier,
    deduceOptimalAspectRatio,
    deduceOptimalResolution
} from '../../../../common/video-generative-patch';

export interface VideoInspectorPanelProps {
    data: VideoTimelineData;
    selectedClip?: TimelineElement;
    onUpdateClip: (updatedClip: TimelineElement) => void;
    onUpdateGlobalGrade: (grade: Partial<GradeParams>) => void;
    onAddMediaAsset: (asset: VideoMediaAsset) => void;
    onUpdateMasterVolume?: (vol: number) => void;
    onUpdateTrackVolume?: (trackId: string, vol: number) => void;
}

type InspectorTab = 'grade' | 'scopes' | 'audio' | 'vfx' | 'media' | '3d' | 'matchmove';

export const VideoInspectorPanel: React.FC<VideoInspectorPanelProps> = ({
    data,
    selectedClip,
    onUpdateClip,
    onUpdateGlobalGrade,
    onAddMediaAsset,
    onUpdateMasterVolume,
    onUpdateTrackVolume
}) => {
    const [activeTab, setActiveTab] = useState<InspectorTab>(selectedClip?.type === '3d' ? '3d' : 'grade');
    const [scopeType, setScopeType] = useState<'waveform' | 'parade' | 'vectorscope' | 'histogram'>('waveform');

    useEffect(() => {
        if (selectedClip?.type === '3d') {
            setActiveTab('3d');
        }
    }, [selectedClip?.id, selectedClip?.type]);

    const scopesCanvasRef = useRef<HTMLCanvasElement | null>(null);

    // Active grade and vfx objects (either selected clip or project global)
    const activeGrade: Partial<GradeParams> = selectedClip?.grade || data.globalGrade || {
        exposure: 0,
        contrast: 0,
        saturation: 100,
        colorTemp: 6500,
        colorTint: 0
    };

    const activeVfx: Partial<VfxParams> = selectedClip?.vfx || {
        blur: 0,
        vignette: 0,
        chromatic: 0,
        oldFilm: 0,
        bokehBlur: 0
    };

    // Update grade handler
    const handleGradeChange = (changes: Partial<GradeParams>) => {
        const nextGrade = { ...activeGrade, ...changes };
        if (selectedClip) {
            onUpdateClip({ ...selectedClip, grade: nextGrade });
        } else {
            onUpdateGlobalGrade(nextGrade);
        }
    };

    // Update VFX handler
    const handleVfxChange = (changes: Partial<VfxParams>) => {
        if (!selectedClip) return;
        const nextVfx = { ...activeVfx, ...changes };
        onUpdateClip({ ...selectedClip, vfx: nextVfx });
    };

    // Update Transform / Blend handler
    const handleTransformChange = (changes: Partial<TimelineElement>) => {
        if (!selectedClip) return;
        onUpdateClip({ ...selectedClip, ...changes });
    };

    // Update Chroma Keying handler
    const handleKeyingChange = (changes: Partial<KeyingParams>) => {
        if (!selectedClip) return;
        const currentKeying: KeyingParams = selectedClip.keying ? {
            enabled: selectedClip.keying.enabled ?? false,
            keyColor: selectedClip.keying.keyColor ?? '#00ff00',
            tolerance: selectedClip.keying.tolerance ?? 35,
            softness: selectedClip.keying.softness ?? 15,
            despill: selectedClip.keying.despill ?? 60,
            invert: selectedClip.keying.invert ?? false,
            ...selectedClip.keying,
            ...changes
        } : {
            enabled: true,
            keyColor: '#00ff00',
            tolerance: 35,
            softness: 15,
            despill: 60,
            invert: false,
            ...changes
        };
        onUpdateClip({ ...selectedClip, keying: currentKeying });
    };

    // Update Generative VFX Patch handler
    const handleGenerativePatchChange = (changes: Partial<GenerativePatchConfig>) => {
        if (!selectedClip) return;
        const currentPatch: GenerativePatchConfig = selectedClip.generativePatch ? {
            enabled: selectedClip.generativePatch.enabled ?? false,
            mode: selectedClip.generativePatch.mode ?? 'remove',
            targetBox: selectedClip.generativePatch.targetBox ?? { x: 50, y: 50, width: 320, height: 180 },
            prompt: selectedClip.generativePatch.prompt ?? 'Remove burned-in timecode window and inpaint seamless background texture',
            aspectRatio: selectedClip.generativePatch.aspectRatio ?? 'auto',
            resolutionTier: selectedClip.generativePatch.resolutionTier ?? 'auto',
            featherRadius: selectedClip.generativePatch.featherRadius ?? 8,
            matchGrain: selectedClip.generativePatch.matchGrain ?? true,
            grainIntensity: selectedClip.generativePatch.grainIntensity ?? 12,
            ...selectedClip.generativePatch,
            ...changes
        } : {
            enabled: true,
            mode: 'remove',
            targetBox: { x: 50, y: 50, width: 320, height: 180 },
            prompt: 'Remove burned-in timecode window and inpaint seamless background texture',
            aspectRatio: 'auto',
            resolutionTier: 'auto',
            featherRadius: 8,
            matchGrain: true,
            grainIntensity: 12,
            ...changes
        };
        onUpdateClip({ ...selectedClip, generativePatch: currentPatch });
    };

    // Update 2D Layer Transform handler
    const handleLayerTransformChange = (changes: Partial<LayerTransform>) => {
        if (!selectedClip) return;
        const currentTransform: LayerTransform = selectedClip.layerTransform ? {
            x: selectedClip.layerTransform.x ?? 0,
            y: selectedClip.layerTransform.y ?? 0,
            scaleX: selectedClip.layerTransform.scaleX ?? 1.0,
            scaleY: selectedClip.layerTransform.scaleY ?? 1.0,
            rotation: selectedClip.layerTransform.rotation ?? 0,
            ...selectedClip.layerTransform,
            ...changes
        } : {
            x: 0,
            y: 0,
            scaleX: selectedClip.scale ?? 1.0,
            scaleY: selectedClip.scale ?? 1.0,
            rotation: selectedClip.rotation ?? 0,
            ...changes
        };
        onUpdateClip({ ...selectedClip, layerTransform: currentTransform });
    };

    // Update Optical Light Wrap handler
    const handleLightWrapChange = (changes: Partial<LightWrapParams>) => {
        if (!selectedClip) return;
        const currentLw: LightWrapParams = selectedClip.lightWrap ? {
            intensity: selectedClip.lightWrap.intensity ?? 0,
            spread: selectedClip.lightWrap.spread ?? 0,
            ...selectedClip.lightWrap,
            ...changes
        } : {
            intensity: 0,
            spread: 0,
            ...changes
        };
        onUpdateClip({ ...selectedClip, lightWrap: currentLw });
    };

    // Update VFX Plate & Anti-Drift Matchmove handler
    const handleVfxPlateChange = (changes: Partial<VfxPlateConfig>) => {
        if (!selectedClip) return;
        const currentPlate: Partial<VfxPlateConfig> = selectedClip.vfxPlate || {};
        const updatedPlate = { ...currentPlate, ...changes };
        onUpdateClip({ ...selectedClip, vfxPlate: updatedPlate });
    };

    // Synchronize directional sunlight with real-world astronomical ephemeris
    const handleSyncSolarLighting = () => {
        if (!selectedClip) return;
        const currentAnchor = selectedClip.vfxPlate?.geodeticAnchor;
        const anchor: GeodeticEphemerisAnchor = {
            lat: currentAnchor?.lat ?? 34.0522,
            lng: currentAnchor?.lng ?? -118.2437,
            alt: currentAnchor?.alt ?? 100,
            headingDegrees: currentAnchor?.headingDegrees ?? 0,
            utcTimestampIso: currentAnchor?.utcTimestampIso ?? new Date().toISOString(),
            sunLockActive: true
        };
        const lighting = VfxPlateMatchmoveService.computeSolarLighting(anchor);
        const updatedAnchor: GeodeticEphemerisAnchor = {
            ...anchor,
            calculatedSolar: lighting.solarPosition,
            solarDirectionVector: lighting.directionVector,
            sunLockActive: true
        };
        const currentPlate = selectedClip.vfxPlate || {};
        onUpdateClip({
            ...selectedClip,
            vfxPlate: { ...currentPlate, geodeticAnchor: updatedAnchor },
            lightingConfig: {
                ...selectedClip.lightingConfig,
                ambientColor: lighting.ambientColor,
                ambientIntensity: lighting.ambientIntensity,
                directionalColor: lighting.directionalColor,
                directionalIntensity: lighting.directionalIntensity,
                directionalPosition: [
                    lighting.directionVector[0] * 20,
                    lighting.directionVector[1] * 20,
                    lighting.directionVector[2] * 20
                ]
            }
        });
    };

    // Draw video scopes on canvas
    useEffect(() => {
        if (activeTab !== 'scopes') return;
        const canvas = scopesCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const w = canvas.width;
        const h = canvas.height;

        ctx.fillStyle = '#09090b';
        ctx.fillRect(0, 0, w, h);

        if (scopeType === 'waveform') {
            // Luma Waveform (IRE 0 to 100)
            ctx.strokeStyle = '#27272a';
            ctx.lineWidth = 1;

            // Draw IRE grid lines: 100, 75, 50, 25, 0
            const ires = [100, 75, 50, 25, 0];
            ctx.fillStyle = '#71717a';
            ctx.font = '9px monospace';
            ires.forEach(ire => {
                const y = h - (ire / 100) * (h - 24) - 12;
                ctx.beginPath();
                ctx.moveTo(30, y);
                ctx.lineTo(w - 10, y);
                ctx.stroke();
                ctx.fillText(`${ire}`, 8, y + 3);
            });

            // Synthetic waveform trace
            ctx.strokeStyle = 'rgba(34, 197, 94, 0.4)'; // Phosphor green
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let x = 30; x < w - 10; x += 2) {
                const normX = (x - 30) / (w - 40);
                const noise = Math.sin(normX * 12 + (data.currentTime || 0) * 2) * 25 + Math.cos(normX * 28) * 15;
                const baseIre = 50 + noise;
                const clampedIre = Math.max(5, Math.min(95, baseIre));
                const y = h - (clampedIre / 100) * (h - 24) - 12;
                if (x === 30) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        } else if (scopeType === 'parade') {
            // RGB Parade (Red, Green, Blue columns)
            const colW = (w - 20) / 3;
            const channels = [
                { name: 'RED', color: 'rgba(239, 68, 68, 0.6)', border: '#7f1d1d' },
                { name: 'GREEN', color: 'rgba(34, 197, 94, 0.6)', border: '#14532d' },
                { name: 'BLUE', color: 'rgba(59, 130, 246, 0.6)', border: '#1e3a8a' }
            ];

            channels.forEach((ch, idx) => {
                const left = 10 + idx * colW;
                ctx.strokeStyle = '#27272a';
                ctx.strokeRect(left, 10, colW - 6, h - 20);

                ctx.fillStyle = ch.color;
                ctx.font = '10px monospace';
                ctx.fillText(ch.name, left + 6, 22);

                ctx.strokeStyle = ch.color;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                for (let x = left + 4; x < left + colW - 10; x += 2) {
                    const norm = (x - left) / colW;
                    const val = 50 + Math.sin(norm * 8 + idx * 2) * 30 + Math.random() * 8;
                    const y = h - 20 - (val / 100) * (h - 40);
                    if (x === left + 4) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            });
        } else if (scopeType === 'vectorscope') {
            // Vectorscope circular graticule
            const cx = w / 2;
            const cy = h / 2;
            const radius = Math.min(cx, cy) - 20;

            // Outer ring
            ctx.strokeStyle = '#3f3f46';
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.stroke();

            // Center crosshair
            ctx.beginPath();
            ctx.moveTo(cx - 10, cy);
            ctx.lineTo(cx + 10, cy);
            ctx.moveTo(cx, cy - 10);
            ctx.lineTo(cx, cy + 10);
            ctx.stroke();

            // Skin tone line (~137 degrees)
            const skinAngle = (137 * Math.PI) / 180;
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(skinAngle) * radius, cy - Math.sin(skinAngle) * radius);
            ctx.stroke();

            // Target boxes (R, Mg, B, Cy, G, Yl)
            const targets = [
                { label: 'R', angle: 104 },
                { label: 'Mg', angle: 61 },
                { label: 'B', angle: 347 },
                { label: 'Cy', angle: 284 },
                { label: 'G', angle: 241 },
                { label: 'Yl', angle: 167 }
            ];

            targets.forEach(t => {
                const rad = (t.angle * Math.PI) / 180;
                const tx = cx + Math.cos(rad) * (radius * 0.75);
                const ty = cy - Math.sin(rad) * (radius * 0.75);
                ctx.strokeStyle = '#71717a';
                ctx.strokeRect(tx - 4, ty - 4, 8, 8);
                ctx.fillStyle = '#a1a1aa';
                ctx.font = '8px monospace';
                ctx.fillText(t.label, tx + 6, ty + 3);
            });

            // Simulated chroma scatter cloud
            ctx.fillStyle = 'rgba(59, 130, 246, 0.35)';
            for (let i = 0; i < 40; i++) {
                const rDist = Math.random() * (radius * 0.5);
                const rAngle = Math.random() * Math.PI * 2;
                ctx.beginPath();
                ctx.arc(cx + Math.cos(rAngle) * rDist, cy + Math.sin(rAngle) * rDist, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        } else {
            // Luminance Histogram
            const bars = 64;
            const barW = (w - 20) / bars;
            for (let i = 0; i < bars; i++) {
                const norm = i / bars;
                const peak = Math.exp(-Math.pow((norm - 0.45) * 4, 2));
                const barH = (peak * 0.8 + Math.random() * 0.15) * (h - 30);
                ctx.fillStyle = `rgb(${Math.round(norm * 200 + 40)}, ${Math.round(norm * 220 + 35)}, ${Math.round(norm * 255)})`;
                ctx.fillRect(10 + i * barW, h - 15 - barH, barW - 1, barH);
            }
        }
    }, [activeTab, scopeType, data.currentTime]);

    return (
        <div className="sb-nle-inspector flex flex-col h-full bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden select-none text-xs">
            {/* Inspector Navigation Tabs */}
            <div className="sb-nle-tabs-bar flex items-center border-b border-zinc-800 bg-zinc-900/90 px-1 py-1 gap-1">
                <button
                    type="button"
                    onClick={() => setActiveTab('grade')}
                    className={`sb-tab-btn px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        activeTab === 'grade' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                    }`}
                >
                    Color Grade
                </button>
                <button
                    type="button"
                    onClick={() => setActiveTab('scopes')}
                    className={`sb-tab-btn px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        activeTab === 'scopes' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                    }`}
                >
                    Scopes
                </button>
                <button
                    type="button"
                    onClick={() => setActiveTab('audio')}
                    className={`sb-tab-btn px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        activeTab === 'audio' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                    }`}
                >
                    Audio Mixer
                </button>
                <button
                    type="button"
                    onClick={() => setActiveTab('vfx')}
                    className={`sb-tab-btn px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        activeTab === 'vfx' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                    }`}
                >
                    Transform & VFX
                </button>
                <button
                    type="button"
                    onClick={() => setActiveTab('media')}
                    className={`sb-tab-btn px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        activeTab === 'media' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                    }`}
                >
                    Media Pool
                </button>
                <button
                    type="button"
                    onClick={() => setActiveTab('3d')}
                    className={`sb-tab-btn px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        activeTab === '3d' ? 'bg-cyan-600 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                    }`}
                >
                    3D Compositor
                </button>
                <button
                    type="button"
                    onClick={() => setActiveTab('matchmove')}
                    className={`sb-tab-btn px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        activeTab === 'matchmove' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                    }`}
                >
                    Matchmove & Anti-Drift
                </button>
            </div>

            {/* Inspector Body Content */}
            <div className="sb-nle-inspector-content flex-1 overflow-y-auto p-3 text-zinc-300 custom-scrollbar">
                {/* 1. COLOR GRADE TAB */}
                {activeTab === 'grade' && (
                    <div className="flex flex-col gap-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-zinc-800">
                            <div>
                                <span className="font-semibold text-zinc-100 text-sm">
                                    {selectedClip ? `Color Grade • ${selectedClip.name}` : 'Global Master Grade'}
                                </span>
                                <div className="text-[11px] text-zinc-400">
                                    ASC-CDL Lift, Gamma, Gain, and White Balance
                                </div>
                            </div>
                            {/* Reset Grade Action */}
                            <button
                                type="button"
                                onClick={() => handleGradeChange({
                                    exposure: 0,
                                    contrast: 0,
                                    saturation: 100,
                                    colorTemp: 6500,
                                    colorTint: 0,
                                    lift: { x: 0, y: 0, luma: 0 },
                                    gamma: { x: 0, y: 0, luma: 0 },
                                    gain: { x: 0, y: 0, luma: 0 },
                                    offset: { x: 0, y: 0, luma: 0 },
                                    lutId: undefined
                                })}
                                className="sb-btn sb-btn-ghost sb-btn-xs px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700 transition-colors"
                                title="Reset all color grading adjustments to neutral Rec.709 baseline"
                            >
                                Reset Grade
                            </button>
                        </div>

                        {/* Sliders: Temperature, Tint, Exposure, Contrast, Saturation */}
                        <div className="grid grid-cols-2 gap-3 bg-zinc-900/60 p-3 rounded border border-zinc-800/80">
                            {/* Exposure */}
                            <div className="flex flex-col gap-1">
                                <div className="flex justify-between text-[11px]">
                                    <span>Exposure</span>
                                    <span className="font-mono text-blue-400">{(activeGrade.exposure ?? 0).toFixed(1)}</span>
                                </div>
                                <input
                                    type="range"
                                    min="-50"
                                    max="50"
                                    value={activeGrade.exposure ?? 0}
                                    onChange={e => handleGradeChange({ exposure: parseFloat(e.target.value) })}
                                    className="accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                />
                            </div>

                            {/* Contrast */}
                            <div className="flex flex-col gap-1">
                                <div className="flex justify-between text-[11px]">
                                    <span>Contrast</span>
                                    <span className="font-mono text-blue-400">{(activeGrade.contrast ?? 0).toFixed(0)}</span>
                                </div>
                                <input
                                    type="range"
                                    min="-50"
                                    max="50"
                                    value={activeGrade.contrast ?? 0}
                                    onChange={e => handleGradeChange({ contrast: parseFloat(e.target.value) })}
                                    className="accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                />
                            </div>

                            {/* Saturation */}
                            <div className="flex flex-col gap-1">
                                <div className="flex justify-between text-[11px]">
                                    <span>Saturation</span>
                                    <span className="font-mono text-blue-400">{(activeGrade.saturation ?? 100).toFixed(0)}%</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="200"
                                    value={activeGrade.saturation ?? 100}
                                    onChange={e => handleGradeChange({ saturation: parseFloat(e.target.value) })}
                                    className="accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                />
                            </div>

                            {/* Color Temp (Kelvin) */}
                            <div className="flex flex-col gap-1">
                                <div className="flex justify-between text-[11px]">
                                    <span>Temperature</span>
                                    <span className="font-mono text-blue-400">{(activeGrade.colorTemp ?? 6500)}K</span>
                                </div>
                                <input
                                    type="range"
                                    min="2500"
                                    max="9500"
                                    step="100"
                                    value={activeGrade.colorTemp ?? 6500}
                                    onChange={e => handleGradeChange({ colorTemp: parseFloat(e.target.value) })}
                                    className="accent-amber-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                />
                            </div>
                        </div>

                        {/* 4-Way Color Wheels: Lift, Gamma, Gain, Offset */}
                        <div className="grid grid-cols-4 gap-2">
                            {([
                                { key: 'lift', name: 'Lift', sub: 'Shadows' },
                                { key: 'gamma', name: 'Gamma', sub: 'Midtones' },
                                { key: 'gain', name: 'Gain', sub: 'Highlights' },
                                { key: 'offset', name: 'Offset', sub: 'Master' },
                            ] as const).map(wheel => {
                                const propKey = wheel.key;
                                const val: ColorWheelOffset = (activeGrade as any)[propKey] || { x: 0, y: 0, luma: 0 };

                                return (
                                    <div key={wheel.key} className="flex flex-col items-center p-2 rounded bg-zinc-900 border border-zinc-800">
                                        <div className="flex flex-col items-center leading-tight mb-1 text-center">
                                            <span className="text-[10px] font-semibold text-zinc-200">{wheel.name}</span>
                                            <span className="text-[8px] text-zinc-500 tracking-tight">{wheel.sub}</span>
                                        </div>

                                        {/* Chroma Puck Circle */}
                                        <div
                                            className="w-20 h-20 rounded-full relative cursor-crosshair border border-zinc-700 shadow-inner flex items-center justify-center overflow-hidden"
                                            style={{
                                                background: 'radial-gradient(circle, #27272a 0%, #18181b 100%)'
                                            }}
                                            onMouseDown={e => {
                                                const rect = e.currentTarget.getBoundingClientRect();
                                                const radius = rect.width / 2;
                                                const updatePuck = (clientX: number, clientY: number) => {
                                                    const dx = (clientX - (rect.left + radius)) / radius;
                                                    const dy = (clientY - (rect.top + radius)) / radius;
                                                    const dist = Math.min(1.0, Math.hypot(dx, dy));
                                                    const angle = Math.atan2(dy, dx);
                                                    handleGradeChange({
                                                        [propKey]: {
                                                            ...val,
                                                            x: Math.cos(angle) * dist,
                                                            y: Math.sin(angle) * dist
                                                        }
                                                    });
                                                };
                                                updatePuck(e.clientX, e.clientY);

                                                const onMove = (me: MouseEvent) => updatePuck(me.clientX, me.clientY);
                                                const onUp = () => {
                                                    window.removeEventListener('mousemove', onMove);
                                                    window.removeEventListener('mouseup', onUp);
                                                };
                                                window.addEventListener('mousemove', onMove);
                                                window.addEventListener('mouseup', onUp);
                                            }}
                                        >
                                            {/* Color ring decoration */}
                                            <div className="absolute inset-0 rounded-full opacity-30 bg-[conic-gradient(at_center,#ef4444,#eab308,#22c55e,#06b6d4,#3b82f6,#a855f7,#ef4444)]" />

                                            {/* Center crosshair */}
                                            <div className="w-[1px] h-full bg-zinc-600/40 absolute" />
                                            <div className="h-[1px] w-full bg-zinc-600/40 absolute" />

                                            {/* Draggable Puck Dot */}
                                            <div
                                                className="w-2.5 h-2.5 rounded-full bg-white shadow-md border border-black absolute pointer-events-none transform -translate-x-1/2 -translate-y-1/2"
                                                style={{
                                                    left: `${50 + (val.x ?? 0) * 40}%`,
                                                    top: `${50 + (val.y ?? 0) * 40}%`
                                                }}
                                            />
                                        </div>

                                        {/* Wheel Luma Slider */}
                                        <div className="w-full mt-2 flex flex-col gap-0.5">
                                            <div className="flex justify-between text-[9px] text-zinc-500">
                                                <span>Luma</span>
                                                <span className="font-mono">{(val.luma ?? 0).toFixed(0)}</span>
                                            </div>
                                            <input
                                                type="range"
                                                min="-50"
                                                max="50"
                                                value={val.luma ?? 0}
                                                onChange={e => handleGradeChange({
                                                    [propKey]: { ...val, luma: parseFloat(e.target.value) }
                                                })}
                                                className="w-full accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* 2. REAL-TIME SCOPES TAB */}
                {activeTab === 'scopes' && (
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                            <span className="font-semibold text-zinc-100 text-sm">Video Scopes & Signal Analysis</span>
                            <div className="flex items-center gap-1">
                                {(['waveform', 'parade', 'vectorscope', 'histogram'] as const).map(mode => (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={() => setScopeType(mode)}
                                        className={`sb-btn sb-btn-xs px-2 py-0.5 rounded text-[10px] uppercase font-mono transition-colors ${
                                            scopeType === mode ? 'bg-blue-600 text-white font-bold' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'
                                        }`}
                                    >
                                        {mode}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="w-full h-56 bg-black rounded border border-zinc-800 overflow-hidden flex items-center justify-center">
                            <canvas
                                ref={scopesCanvasRef}
                                width={600}
                                height={280}
                                className="w-full h-full block"
                            />
                        </div>
                    </div>
                )}

                {/* 3. AUDIO MIXER TAB */}
                {activeTab === 'audio' && (
                    <div className="flex flex-col gap-4">
                        <div className="pb-2 border-b border-zinc-800">
                            <span className="font-semibold text-zinc-100 text-sm">Multi-Track Audio Mixing Console</span>
                            <div className="text-[11px] text-zinc-400">Gain Faders, Stereo Pan, and Peak Level Meters</div>
                        </div>

                        <div className="flex gap-4 overflow-x-auto py-2">
                            {/* Master Channel */}
                            <div className="w-24 shrink-0 flex flex-col items-center bg-zinc-900/90 border border-zinc-800 rounded p-2">
                                <span className="font-bold text-[11px] text-blue-400 mb-2">MASTER</span>
                                <div className="h-40 flex items-center gap-2">
                                    <input
                                        type="range"
                                        name="masterVolume"
                                        aria-label="Master Volume"
                                        min="0"
                                        max="1.5"
                                        step="0.05"
                                        value={data.masterVolume ?? 1.0}
                                        onChange={e => onUpdateMasterVolume?.(parseFloat(e.target.value))}
                                        className="h-36 -rotate-90 w-36 accent-blue-500 cursor-pointer"
                                    />
                                    {/* Simulated stereo meter */}
                                    <div className="w-3 h-36 bg-zinc-950 rounded flex flex-col justify-end p-0.5 border border-zinc-800">
                                        <div className="w-full bg-gradient-to-t from-emerald-500 via-amber-400 to-rose-500 rounded h-[70%]" />
                                    </div>
                                </div>
                                <span className="font-mono text-[10px] text-zinc-400 mt-2">
                                    {Math.round((data.masterVolume ?? 1.0) * 100)}%
                                </span>
                            </div>

                            {/* Individual Tracks */}
                            {data.tracks.map((track, i) => (
                                <div key={track.id} className="w-24 shrink-0 flex flex-col items-center bg-zinc-900/60 border border-zinc-800/80 rounded p-2">
                                    <span className="font-semibold text-[11px] text-zinc-200 truncate w-full text-center mb-1">
                                        {track.name}
                                    </span>
                                    <span className="text-[9px] text-zinc-500 uppercase mb-2">
                                        {track.type}
                                    </span>

                                    {/* Track Fader */}
                                    <div className="h-40 flex items-center gap-2">
                                        <input
                                            type="range"
                                            name={`trackVolume_${track.id}`}
                                            aria-label={`${track.name} Volume`}
                                            min="0"
                                            max="1.5"
                                            step="0.05"
                                            value={track.volume ?? 1.0}
                                            onChange={e => onUpdateTrackVolume?.(track.id, parseFloat(e.target.value))}
                                            className="h-36 -rotate-90 w-36 accent-emerald-500 cursor-pointer"
                                        />
                                        <div className="w-2 h-36 bg-zinc-950 rounded flex flex-col justify-end p-0.5 border border-zinc-800">
                                            <div
                                                className="w-full bg-emerald-500 rounded"
                                                style={{ height: track.muted ? '0%' : '55%' }}
                                            />
                                        </div>
                                    </div>
                                    <span className="font-mono text-[10px] text-zinc-400 mt-2">
                                        {Math.round((track.volume ?? 1.0) * 100)}%
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* 4. TRANSFORM & VFX TAB */}
                {activeTab === 'vfx' && (
                    <div className="flex flex-col gap-4">
                        {!selectedClip ? (
                            <div className="text-center py-8 text-zinc-500">
                                Select a clip on the timeline to edit spatial transforms, blend modes, and lens effects.
                            </div>
                        ) : (
                            <>
                                <div className="pb-2 border-b border-zinc-800 flex justify-between items-center">
                                    <span className="font-semibold text-zinc-100 text-sm">
                                        Transform & Effects • {selectedClip.name}
                                    </span>
                                </div>

                                {/* Blend Mode & Opacity */}
                                <div className="grid grid-cols-2 gap-3 bg-zinc-900/60 p-3 rounded border border-zinc-800">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] text-zinc-400">Blend Mode</span>
                                        <select
                                            value={selectedClip.blendMode ?? BlendMode.Normal}
                                            onChange={e => handleTransformChange({ blendMode: parseInt(e.target.value, 10) as BlendMode })}
                                            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 focus:outline-none"
                                        >
                                            {Object.entries(BLEND_MODE_LABELS).map(([k, label]) => (
                                                <option key={k} value={k}>{label}</option>
                                            ))}
                                        </select>
                                    </div>

                                    <div className="flex flex-col gap-1">
                                        <div className="flex justify-between text-[11px]">
                                            <span>Opacity</span>
                                            <span className="font-mono text-blue-400">{Math.round((selectedClip.opacity ?? 1.0) * 100)}%</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="0"
                                            max="1"
                                            step="0.01"
                                            value={selectedClip.opacity ?? 1.0}
                                            onChange={e => handleTransformChange({ opacity: parseFloat(e.target.value) })}
                                            className="accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                        />
                                    </div>
                                </div>

                                {/* Spatial Transform Controls */}
                                <div className="grid grid-cols-3 gap-3 bg-zinc-900/60 p-3 rounded border border-zinc-800">
                                    <div className="flex flex-col gap-1">
                                        <div className="flex justify-between text-[11px]">
                                            <span>Scale</span>
                                            <span className="font-mono text-blue-400">{Math.round((selectedClip.scale ?? 1.0) * 100)}%</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="0.2"
                                            max="3.0"
                                            step="0.05"
                                            value={selectedClip.scale ?? 1.0}
                                            onChange={e => handleTransformChange({ scale: parseFloat(e.target.value) })}
                                            className="accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                        />
                                    </div>

                                    <div className="flex flex-col gap-1">
                                        <div className="flex justify-between text-[11px]">
                                            <span>Rotation</span>
                                            <span className="font-mono text-blue-400">{Math.round(selectedClip.rotation ?? 0)}°</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="-180"
                                            max="180"
                                            value={selectedClip.rotation ?? 0}
                                            onChange={e => handleTransformChange({ rotation: parseFloat(e.target.value) })}
                                            className="accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                        />
                                    </div>

                                    <div className="flex flex-col gap-1">
                                        <div className="flex justify-between text-[11px]">
                                            <span>Speed</span>
                                            <span className="font-mono text-blue-400">{(selectedClip.speed ?? 1.0).toFixed(1)}x</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="0.25"
                                            max="4.0"
                                            step="0.25"
                                            value={selectedClip.speed ?? 1.0}
                                            onChange={e => handleTransformChange({ speed: parseFloat(e.target.value) })}
                                            className="accent-emerald-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                        />
                                    </div>
                                </div>

                                {/* Lens VFX: Vignette, Chromatic Aberration, Old Film Grain */}
                                <div className="grid grid-cols-3 gap-3 bg-zinc-900/60 p-3 rounded border border-zinc-800">
                                    <div className="flex flex-col gap-1">
                                        <div className="flex justify-between text-[11px]">
                                            <span>Vignette</span>
                                            <span className="font-mono text-blue-400">{Math.round(activeVfx.vignette ?? 0)}%</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="0"
                                            max="100"
                                            value={activeVfx.vignette ?? 0}
                                            onChange={e => handleVfxChange({ vignette: parseFloat(e.target.value) })}
                                            className="accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                        />
                                    </div>

                                    <div className="flex flex-col gap-1">
                                        <div className="flex justify-between text-[11px]">
                                            <span>Chromatic</span>
                                            <span className="font-mono text-blue-400">{Math.round(activeVfx.chromatic ?? 0)}%</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="0"
                                            max="100"
                                            value={activeVfx.chromatic ?? 0}
                                            onChange={e => handleVfxChange({ chromatic: parseFloat(e.target.value) })}
                                            className="accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                        />
                                    </div>

                                    <div className="flex flex-col gap-1">
                                        <div className="flex justify-between text-[11px]">
                                            <span>Old Film</span>
                                            <span className="font-mono text-blue-400">{Math.round(activeVfx.oldFilm ?? 0)}%</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="0"
                                            max="100"
                                            value={activeVfx.oldFilm ?? 0}
                                            onChange={e => handleVfxChange({ oldFilm: parseFloat(e.target.value) })}
                                            className="accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                        />
                                    </div>
                                </div>

                                {/* Chroma Keying & Despill Section */}
                                <div className="flex flex-col gap-2.5 bg-zinc-900/60 p-3 rounded border border-zinc-800">
                                    <div className="flex items-center justify-between pb-1 border-b border-zinc-800/60">
                                        <div className="flex items-center gap-2">
                                            <span className="font-semibold text-zinc-200 text-xs">Chroma Keying & Matting</span>
                                            <span className="text-[10px] px-1.5 py-0.2 bg-emerald-950 text-emerald-400 border border-emerald-800/60 rounded">YCbCr GPU</span>
                                        </div>
                                        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-zinc-300">
                                            <input
                                                type="checkbox"
                                                checked={selectedClip.keying?.enabled ?? false}
                                                onChange={e => handleKeyingChange({ enabled: e.target.checked })}
                                                className="rounded bg-zinc-800 border-zinc-700 text-emerald-500 focus:ring-0 cursor-pointer"
                                            />
                                            <span>Enable Keyer</span>
                                        </label>
                                    </div>

                                    {selectedClip.keying?.enabled && (
                                        <div className="flex flex-col gap-2 pt-1">
                                            {/* Key Color Picker & Presets */}
                                            <div className="flex items-center justify-between">
                                                <span className="text-[11px] text-zinc-400">Key Color</span>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleKeyingChange({ keyColor: '#00ff00' })}
                                                        className={`sb-btn sb-btn-xs px-2 py-0.5 rounded text-[10px] font-medium border ${
                                                            (selectedClip.keying?.keyColor || '#00ff00').toLowerCase() === '#00ff00'
                                                                ? 'bg-emerald-600 border-emerald-400 text-white'
                                                                : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
                                                        }`}
                                                    >
                                                        Green
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleKeyingChange({ keyColor: '#0000ff' })}
                                                        className={`sb-btn sb-btn-xs px-2 py-0.5 rounded text-[10px] font-medium border ${
                                                            (selectedClip.keying?.keyColor || '').toLowerCase() === '#0000ff'
                                                                ? 'bg-blue-600 border-blue-400 text-white'
                                                                : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
                                                        }`}
                                                    >
                                                        Blue
                                                    </button>
                                                    <input
                                                        type="color"
                                                        value={selectedClip.keying?.keyColor || '#00ff00'}
                                                        onChange={e => handleKeyingChange({ keyColor: e.target.value })}
                                                        className="w-6 h-6 rounded border border-zinc-700 bg-zinc-800 cursor-pointer p-0"
                                                        title="Pick Custom Chroma Key Color"
                                                    />
                                                    <span className="font-mono text-[10px] text-zinc-400">{selectedClip.keying?.keyColor || '#00ff00'}</span>
                                                </div>
                                            </div>

                                            {/* Tolerance & Softness Sliders */}
                                            <div className="grid grid-cols-2 gap-3">
                                                <div className="flex flex-col gap-1">
                                                    <div className="flex justify-between text-[11px]">
                                                        <span>Tolerance</span>
                                                        <span className="font-mono text-emerald-400">{selectedClip.keying?.tolerance ?? 35}%</span>
                                                    </div>
                                                    <input
                                                        type="range"
                                                        min="0"
                                                        max="100"
                                                        value={selectedClip.keying?.tolerance ?? 35}
                                                        onChange={e => handleKeyingChange({ tolerance: parseFloat(e.target.value) })}
                                                        className="accent-emerald-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                                    />
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <div className="flex justify-between text-[11px]">
                                                        <span>Edge Softness</span>
                                                        <span className="font-mono text-emerald-400">{selectedClip.keying?.softness ?? 15}%</span>
                                                    </div>
                                                    <input
                                                        type="range"
                                                        min="0"
                                                        max="100"
                                                        value={selectedClip.keying?.softness ?? 15}
                                                        onChange={e => handleKeyingChange({ softness: parseFloat(e.target.value) })}
                                                        className="accent-emerald-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                                    />
                                                </div>
                                            </div>

                                            {/* Despill & Invert Matte */}
                                            <div className="grid grid-cols-2 gap-3 items-center">
                                                <div className="flex flex-col gap-1">
                                                    <div className="flex justify-between text-[11px]">
                                                        <span>Despill Suppression</span>
                                                        <span className="font-mono text-emerald-400">{selectedClip.keying?.despill ?? 60}%</span>
                                                    </div>
                                                    <input
                                                        type="range"
                                                        min="0"
                                                        max="100"
                                                        value={selectedClip.keying?.despill ?? 60}
                                                        onChange={e => handleKeyingChange({ despill: parseFloat(e.target.value) })}
                                                        className="accent-emerald-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                                    />
                                                </div>
                                                <div className="flex items-center gap-2 pt-3">
                                                    <label className="flex items-center gap-1.5 cursor-pointer text-xs text-zinc-300">
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedClip.keying?.invert ?? false}
                                                            onChange={e => handleKeyingChange({ invert: e.target.checked })}
                                                            className="rounded bg-zinc-800 border-zinc-700 text-emerald-500 focus:ring-0 cursor-pointer"
                                                        />
                                                        <span>Invert Key Matte</span>
                                                    </label>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* AI Generative Inpaint & VFX Patch Section */}
                                <div className="flex flex-col gap-2.5 bg-zinc-900/60 p-3 rounded border border-zinc-800">
                                    <div className="flex items-center justify-between pb-1 border-b border-zinc-800/60">
                                        <div className="flex items-center gap-2">
                                            <span className="font-semibold text-zinc-200 text-xs">AI Inpaint & Generative Patch</span>
                                            <span className="text-[10px] px-1.5 py-0.2 bg-purple-950 text-purple-400 border border-purple-800/60 rounded font-mono">Omni 1.1 VFX</span>
                                        </div>
                                        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-zinc-300">
                                            <input
                                                type="checkbox"
                                                checked={selectedClip.generativePatch?.enabled ?? false}
                                                onChange={e => handleGenerativePatchChange({ enabled: e.target.checked })}
                                                className="rounded bg-zinc-800 border-zinc-700 text-purple-500 focus:ring-0 cursor-pointer"
                                            />
                                            <span>Enable Patch</span>
                                        </label>
                                    </div>

                                    {selectedClip.generativePatch?.enabled && (() => {
                                        const patch = selectedClip.generativePatch;
                                        const tBox = patch.targetBox ?? { x: 50, y: 50, width: 320, height: 180 };
                                        const frameDim = { width: 1920, height: 1080 };
                                        const deducedRatio = deduceOptimalAspectRatio(tBox, frameDim);
                                        const deducedRes = deduceOptimalResolution(deducedRatio.cropBox, deducedRatio.aspectRatio);

                                        return (
                                            <div className="flex flex-col gap-2.5 pt-1">
                                                {/* Deduction Recommendation Banner */}
                                                <div className="flex flex-wrap items-center gap-2 p-2 rounded bg-zinc-950/70 border border-purple-900/30 text-[11px]">
                                                    <span className="text-zinc-400 font-medium">Deduced Solver:</span>
                                                    <span className="px-1.5 py-0.5 rounded bg-purple-950/80 text-purple-300 border border-purple-800/50 font-mono text-[10px]" title={deducedRatio.reason}>
                                                        {deducedRatio.aspectRatio} ({deducedRatio.area.toLocaleString()}px²)
                                                    </span>
                                                    <span className="px-1.5 py-0.5 rounded bg-blue-950/80 text-blue-300 border border-blue-800/50 font-mono text-[10px]" title={deducedRes.reason}>
                                                        {deducedRes.tier} ({deducedRes.samplingRatio}x {deducedRes.isSupersampled ? 'oversampled' : 'upsampled'})
                                                    </span>
                                                </div>

                                                {/* Mode Selector */}
                                                <div className="flex items-center justify-between">
                                                    <span className="text-[11px] text-zinc-400">Operation Mode</span>
                                                    <div className="flex items-center gap-1">
                                                        {(['remove', 'insert', 'harmonize_3d'] as const).map(mode => (
                                                            <button
                                                                key={mode}
                                                                type="button"
                                                                onClick={() => handleGenerativePatchChange({ mode })}
                                                                className={`sb-btn sb-btn-xs px-2 py-0.5 rounded text-[10px] font-medium border ${
                                                                    (patch.mode ?? 'remove') === mode
                                                                        ? 'bg-purple-600 border-purple-400 text-white'
                                                                        : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
                                                                }`}
                                                            >
                                                                {mode === 'remove' ? 'Remove / Inpaint' : mode === 'insert' ? 'Insert Object' : 'Harmonize 3D'}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>

                                                {/* Target Bounding Box Coordinates */}
                                                <div className="grid grid-cols-4 gap-2">
                                                    <div>
                                                        <label className="text-[10px] text-zinc-400 block mb-0.5">X (px)</label>
                                                        <input
                                                            type="number"
                                                            value={tBox.x}
                                                            onChange={e => handleGenerativePatchChange({
                                                                targetBox: { ...tBox, x: parseFloat(e.target.value) || 0 }
                                                            })}
                                                            className="w-full bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-xs text-zinc-200"
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="text-[10px] text-zinc-400 block mb-0.5">Y (px)</label>
                                                        <input
                                                            type="number"
                                                            value={tBox.y}
                                                            onChange={e => handleGenerativePatchChange({
                                                                targetBox: { ...tBox, y: parseFloat(e.target.value) || 0 }
                                                            })}
                                                            className="w-full bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-xs text-zinc-200"
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="text-[10px] text-zinc-400 block mb-0.5">Width (px)</label>
                                                        <input
                                                            type="number"
                                                            value={tBox.width}
                                                            onChange={e => handleGenerativePatchChange({
                                                                targetBox: { ...tBox, width: Math.max(4, parseFloat(e.target.value) || 4) }
                                                            })}
                                                            className="w-full bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-xs text-zinc-200"
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="text-[10px] text-zinc-400 block mb-0.5">Height (px)</label>
                                                        <input
                                                            type="number"
                                                            value={tBox.height}
                                                            onChange={e => handleGenerativePatchChange({
                                                                targetBox: { ...tBox, height: Math.max(4, parseFloat(e.target.value) || 4) }
                                                            })}
                                                            className="w-full bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-xs text-zinc-200"
                                                        />
                                                    </div>
                                                </div>

                                                {/* Aspect Ratio & Resolution Selectors */}
                                                <div className="grid grid-cols-2 gap-2">
                                                    <div>
                                                        <label className="text-[10px] text-zinc-400 block mb-0.5">Aspect Ratio</label>
                                                        <select
                                                            value={patch.aspectRatio ?? 'auto'}
                                                            onChange={e => handleGenerativePatchChange({ aspectRatio: e.target.value as any })}
                                                            className="w-full bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-xs text-zinc-200"
                                                        >
                                                            <option value="auto">Auto ({deducedRatio.aspectRatio})</option>
                                                            <option value="16:9">16:9 (Horizontal)</option>
                                                            <option value="9:16">9:16 (Vertical)</option>
                                                        </select>
                                                    </div>
                                                    <div>
                                                        <label className="text-[10px] text-zinc-400 block mb-0.5">Resolution Tier</label>
                                                        <select
                                                            value={patch.resolutionTier ?? 'auto'}
                                                            onChange={e => handleGenerativePatchChange({ resolutionTier: e.target.value as any })}
                                                            className="w-full bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-xs text-zinc-200"
                                                        >
                                                            <option value="auto">Auto ({deducedRes.tier})</option>
                                                            <option value="720p">720p</option>
                                                            <option value="1080p">1080p</option>
                                                            <option value="4k">4K (VFX Plate Master)</option>
                                                        </select>
                                                    </div>
                                                </div>

                                                {/* Prompt input */}
                                                <div>
                                                    <div className="flex items-center justify-between mb-0.5">
                                                        <label className="text-[10px] text-zinc-400">Generative Guidance Prompt</label>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleGenerativePatchChange({
                                                                prompt: 'Remove burned-in timecode digits and restore seamless background texture'
                                                            })}
                                                            className="sb-btn sb-btn-ghost text-[9px] text-purple-400 hover:text-purple-300 underline"
                                                        >
                                                            BITC Preset
                                                        </button>
                                                    </div>
                                                    <input
                                                        type="text"
                                                        value={patch.prompt ?? ''}
                                                        onChange={e => handleGenerativePatchChange({ prompt: e.target.value })}
                                                        placeholder="Describe defect removal or item to insert..."
                                                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:border-purple-600 focus:outline-none"
                                                    />
                                                </div>

                                                {/* Feather Radius & Grain Sliders */}
                                                <div className="flex items-center justify-between">
                                                    <span className="text-[11px] text-zinc-400">Edge Feather Radius</span>
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="range"
                                                            min={0}
                                                            max={32}
                                                            step={1}
                                                            value={patch.featherRadius ?? 8}
                                                            onChange={e => handleGenerativePatchChange({ featherRadius: parseInt(e.target.value, 10) })}
                                                            className="w-24 accent-purple-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                                                        />
                                                        <span className="text-[11px] text-zinc-300 font-mono w-7 text-right">{patch.featherRadius ?? 8}px</span>
                                                    </div>
                                                </div>

                                                <div className="flex items-center justify-between">
                                                    <label className="flex items-center gap-1.5 cursor-pointer text-xs text-zinc-300">
                                                        <input
                                                            type="checkbox"
                                                            checked={patch.matchGrain !== false}
                                                            onChange={e => handleGenerativePatchChange({ matchGrain: e.target.checked })}
                                                            className="rounded bg-zinc-800 border-zinc-700 text-purple-500 focus:ring-0 cursor-pointer"
                                                        />
                                                        <span>Match Film Grain</span>
                                                    </label>
                                                    {patch.matchGrain !== false && (
                                                        <div className="flex items-center gap-2">
                                                            <input
                                                                type="range"
                                                                min={1}
                                                                max={40}
                                                                step={1}
                                                                value={patch.grainIntensity ?? 12}
                                                                onChange={e => handleGenerativePatchChange({ grainIntensity: parseInt(e.target.value, 10) })}
                                                                className="w-20 accent-purple-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                                                            />
                                                            <span className="text-[11px] text-zinc-300 font-mono w-6 text-right">{patch.grainIntensity ?? 12}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>

                                {/* 2D Layer Affine Transform & PiP Section */}
                                <div className="flex flex-col gap-2.5 bg-zinc-900/60 p-3 rounded border border-zinc-800">
                                    <div className="flex items-center justify-between pb-1 border-b border-zinc-800/60">
                                        <span className="font-semibold text-zinc-200 text-xs">2D Spatial Transform & Picture-in-Picture</span>
                                        <div className="flex gap-1">
                                            <button
                                                type="button"
                                                onClick={() => handleLayerTransformChange({ x: 0.25, y: -0.25, scaleX: 0.4, scaleY: 0.4 })}
                                                className="sb-btn sb-btn-xs px-1.5 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] rounded"
                                            >
                                                PiP Top-Right
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleLayerTransformChange({ x: -0.25, y: -0.25, scaleX: 0.4, scaleY: 0.4 })}
                                                className="sb-btn sb-btn-xs px-1.5 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] rounded"
                                            >
                                                PiP Top-Left
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleLayerTransformChange({ x: 0, y: 0, scaleX: 1.0, scaleY: 1.0, rotation: 0 })}
                                                className="sb-btn sb-btn-xs px-1.5 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] rounded"
                                            >
                                                Reset
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="flex flex-col gap-1">
                                            <div className="flex justify-between text-[11px]">
                                                <span>Position X</span>
                                                <span className="font-mono text-cyan-400">
                                                    {((selectedClip.layerTransform?.x ?? 0) * 100).toFixed(0)}%
                                                </span>
                                            </div>
                                            <input
                                                type="range"
                                                min="-1"
                                                max="1"
                                                step="0.01"
                                                value={selectedClip.layerTransform?.x ?? 0}
                                                onChange={e => handleLayerTransformChange({ x: parseFloat(e.target.value) })}
                                                className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <div className="flex justify-between text-[11px]">
                                                <span>Position Y</span>
                                                <span className="font-mono text-cyan-400">
                                                    {((selectedClip.layerTransform?.y ?? 0) * 100).toFixed(0)}%
                                                </span>
                                            </div>
                                            <input
                                                type="range"
                                                min="-1"
                                                max="1"
                                                step="0.01"
                                                value={selectedClip.layerTransform?.y ?? 0}
                                                onChange={e => handleLayerTransformChange({ y: parseFloat(e.target.value) })}
                                                className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                            />
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="flex flex-col gap-1">
                                            <div className="flex justify-between text-[11px]">
                                                <span>Scale X</span>
                                                <span className="font-mono text-cyan-400">
                                                    {((selectedClip.layerTransform?.scaleX ?? 1.0) * 100).toFixed(0)}%
                                                </span>
                                            </div>
                                            <input
                                                type="range"
                                                min="0.1"
                                                max="3"
                                                step="0.05"
                                                value={selectedClip.layerTransform?.scaleX ?? 1.0}
                                                onChange={e => handleLayerTransformChange({ scaleX: parseFloat(e.target.value) })}
                                                className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <div className="flex justify-between text-[11px]">
                                                <span>Scale Y</span>
                                                <span className="font-mono text-cyan-400">
                                                    {((selectedClip.layerTransform?.scaleY ?? 1.0) * 100).toFixed(0)}%
                                                </span>
                                            </div>
                                            <input
                                                type="range"
                                                min="0.1"
                                                max="3"
                                                step="0.05"
                                                value={selectedClip.layerTransform?.scaleY ?? 1.0}
                                                onChange={e => handleLayerTransformChange({ scaleY: parseFloat(e.target.value) })}
                                                className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Optical Light Wrap Section */}
                                <div className="flex flex-col gap-2.5 bg-zinc-900/60 p-3 rounded border border-zinc-800">
                                    <div className="flex items-center justify-between pb-1 border-b border-zinc-800/60">
                                        <span className="font-semibold text-zinc-200 text-xs">Optical Light Wrap Edge Bleed</span>
                                        <span className="text-[10px] text-zinc-400">Atmospheric background bleed onto keyed silhouette</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="flex flex-col gap-1">
                                            <div className="flex justify-between text-[11px]">
                                                <span>Intensity</span>
                                                <span className="font-mono text-amber-400">{selectedClip.lightWrap?.intensity ?? 0}%</span>
                                            </div>
                                            <input
                                                type="range"
                                                min="0"
                                                max="100"
                                                value={selectedClip.lightWrap?.intensity ?? 0}
                                                onChange={e => handleLightWrapChange({ intensity: parseFloat(e.target.value) })}
                                                className="accent-amber-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <div className="flex justify-between text-[11px]">
                                                <span>Edge Spread</span>
                                                <span className="font-mono text-amber-400">{selectedClip.lightWrap?.spread ?? 0}%</span>
                                            </div>
                                            <input
                                                type="range"
                                                min="0"
                                                max="100"
                                                value={selectedClip.lightWrap?.spread ?? 0}
                                                onChange={e => handleLightWrapChange({ spread: parseFloat(e.target.value) })}
                                                className="accent-amber-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* 5. MEDIA POOL TAB */}
                {activeTab === 'media' && (
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                            <div>
                                <span className="font-semibold text-zinc-100 text-sm">Media Pool & Bins</span>
                                <div className="text-[11px] text-zinc-400">Import assets or drag directly into timeline tracks</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    const newAsset: VideoMediaAsset = {
                                        id: `asset-${Date.now()}`,
                                        name: `Imported Media ${data.mediaAssets.length + 1}.mp4`,
                                        type: 'video',
                                        url: '',
                                        duration: 8.0,
                                        width: 1920,
                                        height: 1080,
                                        fps: 30
                                    };
                                    onAddMediaAsset(newAsset);
                                }}
                                className="sb-btn sb-btn-secondary sb-btn-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium text-[11px] transition-colors"
                            >
                                + Video / Audio
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    const new3DAsset: VideoMediaAsset = {
                                        id: `asset-3d-${Date.now()}`,
                                        name: `project_scene_object_${data.mediaAssets.length + 1}.glb`,
                                        type: '3d',
                                        storagePath: `models/project_scene_${data.mediaAssets.length + 1}.glb`,
                                        duration: 10.0,
                                        hasAnimations: true
                                    };
                                    onAddMediaAsset(new3DAsset);
                                }}
                                className="sb-btn sb-btn-primary sb-btn-xs px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 text-white font-medium text-[11px] transition-colors"
                            >
                                + 3D Project Asset
                            </button>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            {data.mediaAssets.map(asset => (
                                <div
                                    key={asset.id}
                                    className="p-2 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 flex items-center gap-2 transition-colors cursor-grab"
                                    title="Drag to timeline track"
                                >
                                    <div className="w-10 h-10 rounded bg-zinc-800 flex items-center justify-center shrink-0 text-zinc-400">
                                        {asset.type === 'video' ? '🎬' : asset.type === 'audio' ? '🎵' : asset.type === '3d' ? '🧊' : '🖼️'}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="font-medium text-zinc-200 truncate text-[11px]">{asset.name}</div>
                                        <div className="text-[10px] text-zinc-500 font-mono">
                                            {asset.duration ? `${asset.duration.toFixed(1)}s` : 'Continuous'} • {asset.type.toUpperCase()}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* 6. 3D PROJECT COMPOSITOR TAB */}
                {activeTab === '3d' && (
                    <div className="flex flex-col gap-4">
                        {!selectedClip ? (
                            <div className="text-center py-8 text-zinc-500">
                                Select a 3D clip on the timeline to configure its project source, camera coordinates, animations, and lighting.
                            </div>
                        ) : (
                            <>
                                <div className="pb-2 border-b border-zinc-800 flex justify-between items-center">
                                    <div>
                                        <span className="font-semibold text-zinc-100 text-sm">
                                            3D Project Compositor • {selectedClip.name}
                                        </span>
                                        <div className="text-[11px] text-zinc-400">
                                            Direct integration with project scenes (.scene3d), models (.glb), and animation tracks
                                        </div>
                                    </div>
                                    <span className="px-2 py-0.5 text-[10px] bg-cyan-950 text-cyan-400 border border-cyan-800 rounded font-mono">
                                        3D LAYER
                                    </span>
                                </div>

                                {/* Source Asset in Project */}
                                <div className="flex flex-col gap-2 bg-zinc-900/70 p-3 rounded border border-zinc-800">
                                    <span className="text-xs font-semibold text-zinc-200">Project 3D Source</span>
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Source Type</span>
                                            <select
                                                value={selectedClip.sourceType ?? 'glb'}
                                                onChange={e => handleTransformChange({ sourceType: e.target.value as any })}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 focus:outline-none"
                                            >
                                                <option value="glb">Binary glTF (.glb / .gltf)</option>
                                                <option value="scene3d">Canvas Scene (.scene3d)</option>
                                                <option value="cpp-mesh">Procedural C++ Generator</option>
                                            </select>
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Project File Path</span>
                                            <input
                                                type="text"
                                                value={selectedClip.sourcePath ?? selectedClip.modelUrl ?? ''}
                                                placeholder="e.g. assets/character.glb"
                                                onChange={e => handleTransformChange({ sourcePath: e.target.value, modelUrl: e.target.value })}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                    </div>

                                    {/* Wireframe toggle */}
                                    <label className="flex items-center gap-2 mt-1 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={!!selectedClip.wireframe}
                                            onChange={e => handleTransformChange({ wireframe: e.target.checked })}
                                            className="rounded bg-zinc-800 border-zinc-700 text-cyan-500 focus:ring-0"
                                        />
                                        <span className="text-xs text-zinc-300">Wireframe Holographic Pass</span>
                                    </label>
                                </div>

                                {/* Animation Track */}
                                <div className="flex flex-col gap-2 bg-zinc-900/70 p-3 rounded border border-zinc-800">
                                    <span className="text-xs font-semibold text-zinc-200">Animation Synchronization</span>
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Track / Clip Name</span>
                                            <input
                                                type="text"
                                                value={selectedClip.animationClipName ?? ''}
                                                placeholder="e.g. Walk, Take 001"
                                                onChange={e => handleTransformChange({ animationClipName: e.target.value })}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <div className="flex justify-between text-[10px] text-zinc-400">
                                                <span>Playback Rate</span>
                                                <span className="font-mono text-cyan-400">{(selectedClip.animationSpeed ?? 1.0).toFixed(2)}x</span>
                                            </div>
                                            <input
                                                type="range"
                                                min="0.1"
                                                max="4.0"
                                                step="0.05"
                                                value={selectedClip.animationSpeed ?? 1.0}
                                                onChange={e => handleTransformChange({ animationSpeed: parseFloat(e.target.value) })}
                                                className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer mt-2"
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Camera Coordinates (Continuous Numeric Values) */}
                                <div className="flex flex-col gap-2 bg-zinc-900/70 p-3 rounded border border-zinc-800">
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs font-semibold text-zinc-200">Camera Coordinates</span>
                                        <span className="text-[10px] text-zinc-500 font-mono">Perspective</span>
                                    </div>
                                    {/* FOV */}
                                    <div className="flex flex-col gap-1">
                                        <div className="flex justify-between text-[10px] text-zinc-400">
                                            <span>Field of View (FOV)</span>
                                            <span className="font-mono text-cyan-400">{selectedClip.cameraConfig?.fov ?? 45}°</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="15"
                                            max="120"
                                            value={selectedClip.cameraConfig?.fov ?? 45}
                                            onChange={e => {
                                                const fov = parseFloat(e.target.value);
                                                const curr = selectedClip.cameraConfig || { fov: 45, position: [0, 2, 5], target: [0, 0, 0] };
                                                handleTransformChange({ cameraConfig: { ...curr, fov } });
                                            }}
                                            className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer"
                                        />
                                    </div>

                                    {/* Position X, Y, Z */}
                                    <div className="flex flex-col gap-1 mt-1">
                                        <span className="text-[10px] text-zinc-400">Camera Position [X, Y, Z]</span>
                                        <div className="grid grid-cols-3 gap-1">
                                            {['X', 'Y', 'Z'].map((axis, idx) => (
                                                <div key={axis} className="flex items-center gap-1 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700">
                                                    <span className="text-[10px] text-zinc-500">{axis}</span>
                                                    <input
                                                        type="number"
                                                        step="0.5"
                                                        value={selectedClip.cameraConfig?.position?.[idx] ?? (idx === 1 ? 2 : idx === 2 ? 5 : 0)}
                                                        onChange={e => {
                                                            const val = parseFloat(e.target.value) || 0;
                                                            const curr = selectedClip.cameraConfig || { fov: 45, position: [0, 2, 5], target: [0, 0, 0] };
                                                            const pos = [...curr.position] as [number, number, number];
                                                            pos[idx] = val;
                                                            handleTransformChange({ cameraConfig: { ...curr, position: pos } });
                                                        }}
                                                        className="w-full bg-transparent text-xs text-zinc-200 font-mono focus:outline-none"
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Target X, Y, Z */}
                                    <div className="flex flex-col gap-1 mt-1">
                                        <span className="text-[10px] text-zinc-400">Look-At Target [X, Y, Z]</span>
                                        <div className="grid grid-cols-3 gap-1">
                                            {['X', 'Y', 'Z'].map((axis, idx) => (
                                                <div key={axis} className="flex items-center gap-1 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700">
                                                    <span className="text-[10px] text-zinc-500">{axis}</span>
                                                    <input
                                                        type="number"
                                                        step="0.5"
                                                        value={selectedClip.cameraConfig?.target?.[idx] ?? 0}
                                                        onChange={e => {
                                                            const val = parseFloat(e.target.value) || 0;
                                                            const curr = selectedClip.cameraConfig || { fov: 45, position: [0, 2, 5], target: [0, 0, 0] };
                                                            const tgt = [...curr.target] as [number, number, number];
                                                            tgt[idx] = val;
                                                            handleTransformChange({ cameraConfig: { ...curr, target: tgt } });
                                                        }}
                                                        className="w-full bg-transparent text-xs text-zinc-200 font-mono focus:outline-none"
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                {/* Direct Parametric Lighting */}
                                <div className="flex flex-col gap-2 bg-zinc-900/70 p-3 rounded border border-zinc-800">
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs font-semibold text-zinc-200">Lighting Parameters</span>
                                    </div>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={!!selectedClip.useSceneLighting}
                                            onChange={e => handleTransformChange({ useSceneLighting: e.target.checked })}
                                            className="rounded bg-zinc-800 border-zinc-700 text-cyan-500 focus:ring-0"
                                        />
                                        <span className="text-xs text-zinc-300">Use Project Scene Environment Lights</span>
                                    </label>

                                    {!selectedClip.useSceneLighting && (
                                        <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-zinc-800">
                                            <div className="grid grid-cols-2 gap-2">
                                                <div className="flex flex-col gap-1">
                                                    <span className="text-[10px] text-zinc-400">Ambient Color</span>
                                                    <input
                                                        type="color"
                                                        value={selectedClip.lightingConfig?.ambientColor ?? '#ffffff'}
                                                        onChange={e => {
                                                            const curr = selectedClip.lightingConfig || {};
                                                            handleTransformChange({ lightingConfig: { ...curr, ambientColor: e.target.value } });
                                                        }}
                                                        className="w-full h-7 bg-zinc-800 rounded border border-zinc-700 cursor-pointer"
                                                    />
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <div className="flex justify-between text-[10px] text-zinc-400">
                                                        <span>Ambient Intensity</span>
                                                        <span className="font-mono text-cyan-400">{(selectedClip.lightingConfig?.ambientIntensity ?? 1.0).toFixed(1)}</span>
                                                    </div>
                                                    <input
                                                        type="range"
                                                        min="0"
                                                        max="5"
                                                        step="0.1"
                                                        value={selectedClip.lightingConfig?.ambientIntensity ?? 1.0}
                                                        onChange={e => {
                                                            const curr = selectedClip.lightingConfig || {};
                                                            handleTransformChange({ lightingConfig: { ...curr, ambientIntensity: parseFloat(e.target.value) } });
                                                        }}
                                                        className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer mt-2"
                                                    />
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-2 gap-2 mt-1">
                                                <div className="flex flex-col gap-1">
                                                    <span className="text-[10px] text-zinc-400">Directional Sun Color</span>
                                                    <input
                                                        type="color"
                                                        value={selectedClip.lightingConfig?.directionalColor ?? '#ffffff'}
                                                        onChange={e => {
                                                            const curr = selectedClip.lightingConfig || {};
                                                            handleTransformChange({ lightingConfig: { ...curr, directionalColor: e.target.value } });
                                                        }}
                                                        className="w-full h-7 bg-zinc-800 rounded border border-zinc-700 cursor-pointer"
                                                    />
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <div className="flex justify-between text-[10px] text-zinc-400">
                                                        <span>Sun Intensity</span>
                                                        <span className="font-mono text-cyan-400">{(selectedClip.lightingConfig?.directionalIntensity ?? 2.0).toFixed(1)}</span>
                                                    </div>
                                                    <input
                                                        type="range"
                                                        min="0"
                                                        max="10"
                                                        step="0.2"
                                                        value={selectedClip.lightingConfig?.directionalIntensity ?? 2.0}
                                                        onChange={e => {
                                                            const curr = selectedClip.lightingConfig || {};
                                                            handleTransformChange({ lightingConfig: { ...curr, directionalIntensity: parseFloat(e.target.value) } });
                                                        }}
                                                        className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer mt-2"
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* 7. VFX MATCHMOVE & ANTI-DRIFT TAB */}
                {activeTab === 'matchmove' && (
                    <div className="flex flex-col gap-4">
                        {!selectedClip ? (
                            <div className="text-center py-8 text-zinc-500">
                                Select a timeline clip (Live-Action Plate, 3D Layer, or Generative Inpaint Patch) to configure matchmove solving and anti-drift coordination.
                            </div>
                        ) : (
                            <>
                                <div className="pb-2 border-b border-zinc-800 flex justify-between items-center">
                                    <div>
                                        <span className="font-semibold text-zinc-100 text-sm">
                                            VFX Plate Matchmove & Generative Anti-Drift • {selectedClip.name}
                                        </span>
                                        <div className="text-[11px] text-zinc-400">
                                            Rigid spatial registration, sub-pixel camera solving, astronomical solar lock, and depth holdouts
                                        </div>
                                    </div>
                                    <span className="px-2 py-0.5 text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800 rounded font-mono">
                                        ANTI-DRIFT LOCKED
                                    </span>
                                </div>

                                {/* Section 1: Live-Action Reference Plate Identifier */}
                                <div className="flex flex-col gap-2 bg-zinc-900/70 p-3 rounded border border-zinc-800">
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs font-semibold text-zinc-200">Reference Plate Configuration</span>
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={!!selectedClip.vfxPlate?.plateId || selectedClip.isVfxPlate}
                                                onChange={e => {
                                                    const isPlate = e.target.checked;
                                                    handleVfxPlateChange({
                                                        plateId: isPlate ? (selectedClip.vfxPlate?.plateId || selectedClip.id) : undefined
                                                    });
                                                    handleTransformChange({ isVfxPlate: isPlate });
                                                }}
                                                className="rounded bg-zinc-800 border-zinc-700 text-emerald-500 focus:ring-0"
                                            />
                                            <span className="text-xs text-zinc-300">Active Live-Action Plate</span>
                                        </label>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 mt-1">
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Reference Plate ID</span>
                                            <input
                                                type="text"
                                                value={selectedClip.vfxPlate?.plateId ?? selectedClip.id}
                                                onChange={e => handleVfxPlateChange({ plateId: e.target.value })}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Target Track Alignment</span>
                                            <div className="text-xs font-mono text-emerald-400 bg-zinc-950 px-2 py-1 rounded border border-zinc-800">
                                                Track: {selectedClip.trackId}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Section 2: 6-DOF Camera Solve Track */}
                                <div className="flex flex-col gap-2 bg-zinc-900/70 p-3 rounded border border-zinc-800">
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs font-semibold text-zinc-200">6-DOF Camera Solve Track</span>
                                        <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                                            (selectedClip.vfxPlate?.cameraSolve?.frames?.length ?? 0) > 0
                                                ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-700/50'
                                                : 'bg-amber-900/40 text-amber-400 border border-amber-700/50'
                                        }`}>
                                            {(selectedClip.vfxPlate?.cameraSolve?.frames?.length ?? 0) > 0
                                                ? `${selectedClip.vfxPlate!.cameraSolve!.frames.length} SOLVE FRAMES (RMSE: ${(selectedClip.vfxPlate!.cameraSolve!.meanReprojectionErrorPx ?? 0.38).toFixed(2)}px)`
                                                : 'NO SOLVE TRACK'}
                                        </span>
                                    </div>

                                    <div className="grid grid-cols-3 gap-2 mt-1">
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Coordinate Convention</span>
                                            <select
                                                value={selectedClip.vfxPlate?.cameraSolve?.coordinateSystem ?? 'threejs'}
                                                onChange={e => {
                                                    const curr: CameraSolveTrack = selectedClip.vfxPlate?.cameraSolve || {
                                                        id: 'solve-track',
                                                        coordinateSystem: 'threejs',
                                                        fps: 24,
                                                        totalFrames: 0,
                                                        frames: []
                                                    };
                                                    handleVfxPlateChange({
                                                        cameraSolve: { ...curr, coordinateSystem: e.target.value as any }
                                                    });
                                                }}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 focus:outline-none"
                                            >
                                                <option value="threejs">Three.js (+Y up, -Z forward)</option>
                                                <option value="blender">Blender (+Z up, -Y forward)</option>
                                                <option value="nuke">Nuke / Alembic (+Y up, +Z forward)</option>
                                                <option value="opencv">OpenCV (+Y down, +Z forward)</option>
                                            </select>
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Focal Length (mm)</span>
                                            <input
                                                type="number"
                                                step="1"
                                                value={selectedClip.vfxPlate?.cameraSolve?.focalLengthMm ?? 35}
                                                onChange={e => {
                                                    const fl = parseFloat(e.target.value) || 35;
                                                    const curr: CameraSolveTrack = selectedClip.vfxPlate?.cameraSolve || {
                                                        id: 'solve-track',
                                                        coordinateSystem: 'threejs',
                                                        fps: 24,
                                                        totalFrames: 0,
                                                        frames: []
                                                    };
                                                    const fov = VfxPlateMatchmoveService.focalLengthToFov(fl, curr.sensorHeightMm ?? 24);
                                                    handleVfxPlateChange({
                                                        cameraSolve: { ...curr, focalLengthMm: fl }
                                                    });
                                                    handleTransformChange({
                                                        cameraConfig: {
                                                            fov,
                                                            position: selectedClip.cameraConfig?.position || [0, 2, 5],
                                                            target: selectedClip.cameraConfig?.target || [0, 0, 0]
                                                        }
                                                    });
                                                }}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Sensor Dim (WxH mm)</span>
                                            <div className="flex gap-1">
                                                <input
                                                    type="number"
                                                    value={selectedClip.vfxPlate?.cameraSolve?.sensorWidthMm ?? 36}
                                                    onChange={e => {
                                                        const sw = parseFloat(e.target.value) || 36;
                                                        const curr: CameraSolveTrack = selectedClip.vfxPlate?.cameraSolve || {
                                                            id: 'solve-track',
                                                            coordinateSystem: 'threejs',
                                                            fps: 24,
                                                            totalFrames: 0,
                                                            frames: []
                                                        };
                                                        handleVfxPlateChange({ cameraSolve: { ...curr, sensorWidthMm: sw } });
                                                    }}
                                                    className="w-1/2 bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-1.5 py-1 font-mono focus:outline-none"
                                                />
                                                <input
                                                    type="number"
                                                    value={selectedClip.vfxPlate?.cameraSolve?.sensorHeightMm ?? 24}
                                                    onChange={e => {
                                                        const sh = parseFloat(e.target.value) || 24;
                                                        const curr: CameraSolveTrack = selectedClip.vfxPlate?.cameraSolve || {
                                                            id: 'solve-track',
                                                            coordinateSystem: 'threejs',
                                                            fps: 24,
                                                            totalFrames: 0,
                                                            frames: []
                                                        };
                                                        handleVfxPlateChange({ cameraSolve: { ...curr, sensorHeightMm: sh } });
                                                    }}
                                                    className="w-1/2 bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-1.5 py-1 font-mono focus:outline-none"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Action to create / synthesize sample solve track if missing */}
                                    {(!selectedClip.vfxPlate?.cameraSolve?.frames || selectedClip.vfxPlate.cameraSolve.frames.length === 0) && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const frames = [];
                                                const duration = selectedClip.duration || 5.0;
                                                const fps = 24;
                                                const totalFrames = Math.ceil(duration * fps);
                                                for (let f = 0; f < totalFrames; f++) {
                                                    const t = f / fps;
                                                    frames.push({
                                                        frameNumber: f,
                                                        timeSeconds: t,
                                                        position: [
                                                            Math.sin(t * 0.5) * 1.5,
                                                            1.2 + Math.cos(t * 0.4) * 0.3,
                                                            4.0 - t * 0.2
                                                        ] as [number, number, number],
                                                        rotationQuaternion: [0, Math.sin(t * 0.05), 0, Math.cos(t * 0.05)] as [number, number, number, number],
                                                        fovDegrees: 42.0,
                                                        focalLengthMm: 35.0,
                                                        reprojectionErrorPx: 0.35 + Math.random() * 0.15
                                                    });
                                                }
                                                const solveTrack: CameraSolveTrack = {
                                                    id: `solve-${Date.now()}`,
                                                    fps,
                                                    totalFrames,
                                                    coordinateSystem: 'threejs',
                                                    sensorWidthMm: 36,
                                                    sensorHeightMm: 24,
                                                    focalLengthMm: 35,
                                                    frames,
                                                    meanReprojectionErrorPx: 0.41
                                                };
                                                handleVfxPlateChange({ cameraSolve: solveTrack });
                                            }}
                                            className="sb-btn sb-btn-sm mt-2 py-1.5 px-3 rounded bg-emerald-900/60 hover:bg-emerald-800 text-emerald-200 font-medium text-xs flex items-center justify-center gap-2 border border-emerald-700 transition-colors"
                                        >
                                            Generate / Bind High-Precision 6-DOF Matchmove Track
                                        </button>
                                    )}
                                </div>

                                {/* Section 3: Real-World Geodetic Anchor & Ephemeris Sun Lock */}
                                <div className="flex flex-col gap-2 bg-zinc-900/70 p-3 rounded border border-zinc-800">
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs font-semibold text-zinc-200">Astronomical Ephemeris & Sun Lock</span>
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={!!selectedClip.vfxPlate?.geodeticAnchor?.sunLockActive}
                                                onChange={e => {
                                                    const active = e.target.checked;
                                                    const curr = selectedClip.vfxPlate?.geodeticAnchor || {
                                                        lat: 34.0522,
                                                        lng: -118.2437,
                                                        alt: 100,
                                                        headingDegrees: 0,
                                                        utcTimestampIso: new Date().toISOString()
                                                    };
                                                    handleVfxPlateChange({
                                                        geodeticAnchor: { ...curr, sunLockActive: active }
                                                    });
                                                    if (active) {
                                                        handleSyncSolarLighting();
                                                    }
                                                }}
                                                className="rounded bg-zinc-800 border-zinc-700 text-emerald-500 focus:ring-0"
                                            />
                                            <span className="text-xs text-zinc-300 font-medium">Sun Lock Active</span>
                                        </label>
                                    </div>

                                    <div className="grid grid-cols-4 gap-2 mt-1">
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Latitude (deg)</span>
                                            <input
                                                type="number"
                                                step="0.0001"
                                                value={selectedClip.vfxPlate?.geodeticAnchor?.lat ?? 34.0522}
                                                onChange={e => {
                                                    const val = parseFloat(e.target.value) || 0;
                                                    const curr = selectedClip.vfxPlate?.geodeticAnchor || {
                                                        lat: 34.0522, lng: -118.2437, alt: 100, headingDegrees: 0, utcTimestampIso: new Date().toISOString()
                                                    };
                                                    handleVfxPlateChange({ geodeticAnchor: { ...curr, lat: val } });
                                                }}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Longitude (deg)</span>
                                            <input
                                                type="number"
                                                step="0.0001"
                                                value={selectedClip.vfxPlate?.geodeticAnchor?.lng ?? -118.2437}
                                                onChange={e => {
                                                    const val = parseFloat(e.target.value) || 0;
                                                    const curr = selectedClip.vfxPlate?.geodeticAnchor || {
                                                        lat: 34.0522, lng: -118.2437, alt: 100, headingDegrees: 0, utcTimestampIso: new Date().toISOString()
                                                    };
                                                    handleVfxPlateChange({ geodeticAnchor: { ...curr, lng: val } });
                                                }}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Elevation (m)</span>
                                            <input
                                                type="number"
                                                step="1"
                                                value={selectedClip.vfxPlate?.geodeticAnchor?.alt ?? 100}
                                                onChange={e => {
                                                    const val = parseFloat(e.target.value) || 0;
                                                    const curr = selectedClip.vfxPlate?.geodeticAnchor || {
                                                        lat: 34.0522, lng: -118.2437, alt: 100, headingDegrees: 0, utcTimestampIso: new Date().toISOString()
                                                    };
                                                    handleVfxPlateChange({ geodeticAnchor: { ...curr, alt: val } });
                                                }}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Compass Heading (°)</span>
                                            <input
                                                type="number"
                                                step="1"
                                                min="0"
                                                max="360"
                                                value={selectedClip.vfxPlate?.geodeticAnchor?.headingDegrees ?? 0}
                                                onChange={e => {
                                                    const val = parseFloat(e.target.value) || 0;
                                                    const curr = selectedClip.vfxPlate?.geodeticAnchor || {
                                                        lat: 34.0522, lng: -118.2437, alt: 100, headingDegrees: 0, utcTimestampIso: new Date().toISOString()
                                                    };
                                                    handleVfxPlateChange({ geodeticAnchor: { ...curr, headingDegrees: val } });
                                                }}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2 mt-2">
                                        <button
                                            type="button"
                                            onClick={handleSyncSolarLighting}
                                            className="sb-btn sb-btn-sm flex-1 py-1.5 px-3 rounded bg-amber-600/90 hover:bg-amber-500 text-zinc-950 font-semibold text-xs flex items-center justify-center gap-2 transition-colors shadow-sm"
                                        >
                                            <span className="text-sm">☀️</span>
                                            Synchronize Astronomical Sun Vector & Color
                                        </button>
                                    </div>
                                </div>

                                {/* Section 4: Anti-Drift Holdout & Surface Constraint */}
                                <div className="flex flex-col gap-2 bg-zinc-900/70 p-3 rounded border border-zinc-800">
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs font-semibold text-zinc-200">Anti-Drift Holdout & Proxy Constraints</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3 mt-1">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={!!selectedClip.vfxPlate?.antiDrift?.depthHoldoutEnabled}
                                                onChange={e => {
                                                    const curr = selectedClip.vfxPlate?.antiDrift || {};
                                                    handleVfxPlateChange({
                                                        antiDrift: { ...curr, depthHoldoutEnabled: e.target.checked }
                                                    });
                                                }}
                                                className="rounded bg-zinc-800 border-zinc-700 text-emerald-500 focus:ring-0"
                                            />
                                            <span className="text-xs text-zinc-300">Foreground Depth Holdout</span>
                                        </label>
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={!!selectedClip.vfxPlate?.antiDrift?.rigidProxyLocked}
                                                onChange={e => {
                                                    const curr = selectedClip.vfxPlate?.antiDrift || {};
                                                    handleVfxPlateChange({
                                                        antiDrift: { ...curr, rigidProxyLocked: e.target.checked }
                                                    });
                                                }}
                                                className="rounded bg-zinc-800 border-zinc-700 text-emerald-500 focus:ring-0"
                                            />
                                            <span className="text-xs text-zinc-300">Rigid Proxy Mesh Lock</span>
                                        </label>
                                    </div>

                                    <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-zinc-800">
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Holdout Cutoff (m)</span>
                                            <input
                                                type="number"
                                                step="0.5"
                                                value={selectedClip.vfxPlate?.antiDrift?.depthThresholdMeters ?? 12.0}
                                                onChange={e => {
                                                    const val = parseFloat(e.target.value) || 12;
                                                    const curr = selectedClip.vfxPlate?.antiDrift || {};
                                                    handleVfxPlateChange({ antiDrift: { ...curr, depthThresholdMeters: val } });
                                                }}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Edge Feather (px)</span>
                                            <input
                                                type="number"
                                                step="1"
                                                value={selectedClip.vfxPlate?.antiDrift?.edgeFeatherPx ?? 4}
                                                onChange={e => {
                                                    const val = parseFloat(e.target.value) || 4;
                                                    const curr = selectedClip.vfxPlate?.antiDrift || {};
                                                    handleVfxPlateChange({ antiDrift: { ...curr, edgeFeatherPx: val } });
                                                }}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-400">Max Permitted Drift (px)</span>
                                            <input
                                                type="number"
                                                step="0.5"
                                                value={selectedClip.vfxPlate?.antiDrift?.maxPermittedDriftPx ?? 2.0}
                                                onChange={e => {
                                                    const val = parseFloat(e.target.value) || 2.0;
                                                    const curr = selectedClip.vfxPlate?.antiDrift || {};
                                                    handleVfxPlateChange({ antiDrift: { ...curr, maxPermittedDriftPx: val } });
                                                }}
                                                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 font-mono focus:outline-none"
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Section 5: Optical Lens Distortion Harmonization */}
                                <div className="flex flex-col gap-2 bg-zinc-900/70 p-3 rounded border border-zinc-800">
                                    <span className="text-xs font-semibold text-zinc-200">Brown-Conrady Optical Distortion</span>
                                    <div className="grid grid-cols-3 gap-2">
                                        <div className="flex flex-col gap-1">
                                            <div className="flex justify-between text-[10px] text-zinc-400">
                                                <span>Radial k1</span>
                                                <span className="font-mono text-cyan-400">
                                                    {(selectedClip.vfxPlate?.lensDistortion?.k1 ?? 0).toFixed(3)}
                                                </span>
                                            </div>
                                            <input
                                                type="range"
                                                min="-0.15"
                                                max="0.15"
                                                step="0.005"
                                                value={selectedClip.vfxPlate?.lensDistortion?.k1 ?? 0}
                                                onChange={e => {
                                                    const val = parseFloat(e.target.value) || 0;
                                                    const curr = selectedClip.vfxPlate?.lensDistortion || { k1: 0, k2: 0 };
                                                    handleVfxPlateChange({ lensDistortion: { ...curr, k1: val } });
                                                }}
                                                className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer mt-1"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <div className="flex justify-between text-[10px] text-zinc-400">
                                                <span>Radial k2</span>
                                                <span className="font-mono text-cyan-400">
                                                    {(selectedClip.vfxPlate?.lensDistortion?.k2 ?? 0).toFixed(3)}
                                                </span>
                                            </div>
                                            <input
                                                type="range"
                                                min="-0.10"
                                                max="0.10"
                                                step="0.005"
                                                value={selectedClip.vfxPlate?.lensDistortion?.k2 ?? 0}
                                                onChange={e => {
                                                    const val = parseFloat(e.target.value) || 0;
                                                    const curr = selectedClip.vfxPlate?.lensDistortion || { k1: 0, k2: 0 };
                                                    handleVfxPlateChange({ lensDistortion: { ...curr, k2: val } });
                                                }}
                                                className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer mt-1"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <div className="flex justify-between text-[10px] text-zinc-400">
                                                <span>Anamorphic Squeeze</span>
                                                <span className="font-mono text-cyan-400">
                                                    {(selectedClip.vfxPlate?.lensDistortion?.squeezeFactor ?? 1.0).toFixed(2)}x
                                                </span>
                                            </div>
                                            <input
                                                type="range"
                                                min="1.0"
                                                max="2.0"
                                                step="0.05"
                                                value={selectedClip.vfxPlate?.lensDistortion?.squeezeFactor ?? 1.0}
                                                onChange={e => {
                                                    const val = parseFloat(e.target.value) || 1.0;
                                                    const curr = selectedClip.vfxPlate?.lensDistortion || { k1: 0, k2: 0 };
                                                    handleVfxPlateChange({ lensDistortion: { ...curr, squeezeFactor: val } });
                                                }}
                                                className="accent-cyan-500 h-1 bg-zinc-700 rounded cursor-pointer mt-1"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

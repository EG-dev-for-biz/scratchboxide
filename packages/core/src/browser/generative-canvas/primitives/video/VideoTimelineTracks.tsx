/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import React, { useRef, useState, useCallback, useMemo } from 'react';
import { VideoTimelineData, TimelineTrack, TimelineElement, NleTool, PropertyKeyframe } from '../../services/video/videoTypes';
import { formatTimecode, formatTimecodeShort } from '../../services/video/timecode';
import { snapToFrameSeconds } from '../../services/video/rationalTime';
import { magneticSnap, trimElementHead, trimElementTail, moveElement, splitElementAtTime } from '../../services/video/timelineMath';

export interface VideoTimelineTracksProps {
    data: VideoTimelineData;
    onUpdateTracks: (tracks: TimelineTrack[]) => void;
    onSeek: (timeSeconds: number) => void;
    onSelectClip: (clipId: string | undefined, trackId?: string) => void;
    selectedClipId?: string;
    activeTool: NleTool;
    snappingEnabled: boolean;
    zoom: number; // pixels per second
}

export const VideoTimelineTracks: React.FC<VideoTimelineTracksProps> = ({
    data,
    onUpdateTracks,
    onSeek,
    onSelectClip,
    selectedClipId,
    activeTool,
    snappingEnabled,
    zoom
}) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const rulerRef = useRef<HTMLDivElement | null>(null);

    const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
    const [dragAction, setDragAction] = useState<{
        type: 'move' | 'trim-head' | 'trim-tail' | 'drag-keyframe';
        trackId: string;
        elementId: string;
        initialX: number;
        initialStart: number;
        initialDuration: number;
        initialTrimStart: number;
        keyframeId?: string;
        propName?: string;
        initialKfTime?: number;
    } | null>(null);

    const fps = data.fps || 30;
    const currentTime = data.currentTime || 0;
    const duration = data.duration || 10;
    const pxPerSec = Math.max(10, zoom);
    const totalWidthPx = Math.max(800, duration * pxPerSec + 200);

    // Compute magnetic snap targets (playhead, markers, all clip in/out boundaries)
    const snapTargets = useMemo(() => {
        const targets = new Set<number>([0, duration, currentTime]);
        (data.markers || []).forEach(m => targets.add(m.time));
        data.tracks.forEach(t => {
            t.elements.forEach(el => {
                targets.add(el.startTime);
                targets.add(el.startTime + el.duration);
            });
        });
        return Array.from(targets);
    }, [data.tracks, data.markers, duration, currentTime]);

    // Handle ruler scrubbing
    const handleRulerMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!rulerRef.current) return;
        const rect = rulerRef.current.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        let targetTime = Math.max(0, offsetX / pxPerSec);

        if (snappingEnabled) {
            const snap = magneticSnap(targetTime, snapTargets, 10, pxPerSec);
            if (snap.didSnap) targetTime = snap.snappedTime;
        }

        onSeek(snapToFrameSeconds(targetTime, fps));
        setIsScrubbing(true);

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const currentX = moveEvent.clientX - rect.left;
            let time = Math.max(0, currentX / pxPerSec);
            if (snappingEnabled) {
                const snap = magneticSnap(time, snapTargets, 10, pxPerSec);
                if (snap.didSnap) time = snap.snappedTime;
            }
            onSeek(snapToFrameSeconds(time, fps));
        };

        const handleMouseUp = () => {
            setIsScrubbing(false);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    // Track state mutations (visibility, mute, solo, lock, volume)
    const toggleTrackVisibility = (trackId: string) => {
        onUpdateTracks(data.tracks.map(t => t.id === trackId ? { ...t, visible: !t.visible } : t));
    };

    const toggleTrackMute = (trackId: string) => {
        onUpdateTracks(data.tracks.map(t => t.id === trackId ? { ...t, muted: !t.muted } : t));
    };

    const toggleTrackLock = (trackId: string) => {
        onUpdateTracks(data.tracks.map(t => t.id === trackId ? { ...t, locked: !t.locked } : t));
    };

    const updateTrackVolume = (trackId: string, vol: number) => {
        onUpdateTracks(data.tracks.map(t => t.id === trackId ? { ...t, volume: vol } : t));
    };

    // Clip Click / Tool Actions
    const handleClipClick = (track: TimelineTrack, element: TimelineElement, e: React.MouseEvent) => {
        e.stopPropagation();

        if (track.locked) return;

        if (activeTool === 'cut') {
            // Razor cut at clicked position
            if (!containerRef.current) return;
            const targetTime = snapToFrameSeconds(currentTime, fps);
            const newElements = splitElementAtTime(track.elements, element.id, targetTime, fps);
            onUpdateTracks(data.tracks.map(t => t.id === track.id ? { ...t, elements: newElements } : t));
            return;
        }

        onSelectClip(element.id, track.id);
    };

    // Clip Dragging (Move, Trim Head, Trim Tail)
    const handleClipMouseDown = (
        track: TimelineTrack,
        element: TimelineElement,
        actionType: 'move' | 'trim-head' | 'trim-tail',
        e: React.MouseEvent
    ) => {
        e.stopPropagation();
        if (track.locked || activeTool === 'cut') return;

        onSelectClip(element.id, track.id);

        setDragAction({
            type: actionType,
            trackId: track.id,
            elementId: element.id,
            initialX: e.clientX,
            initialStart: element.startTime,
            initialDuration: element.duration,
            initialTrimStart: element.trimStart
        });

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaPx = moveEvent.clientX - e.clientX;
            const deltaSec = deltaPx / pxPerSec;

            let updatedTracks = [...data.tracks];
            const currentTrack = updatedTracks.find(t => t.id === track.id);
            if (!currentTrack) return;

            if (actionType === 'move') {
                let targetStart = Math.max(0, element.startTime + deltaSec);
                if (snappingEnabled) {
                    const snap = magneticSnap(targetStart, snapTargets, 12, pxPerSec);
                    if (snap.didSnap) targetStart = snap.snappedTime;
                }
                currentTrack.elements = moveElement(currentTrack.elements, element.id, targetStart, fps);
            } else if (actionType === 'trim-head') {
                let targetStart = Math.max(0, element.startTime + deltaSec);
                if (snappingEnabled) {
                    const snap = magneticSnap(targetStart, snapTargets, 10, pxPerSec);
                    if (snap.didSnap) targetStart = snap.snappedTime;
                }
                currentTrack.elements = trimElementHead(currentTrack.elements, element.id, targetStart, fps);
            } else if (actionType === 'trim-tail') {
                let targetDuration = Math.max(1 / fps, element.duration + deltaSec);
                if (snappingEnabled) {
                    const snap = magneticSnap(element.startTime + targetDuration, snapTargets, 10, pxPerSec);
                    if (snap.didSnap) targetDuration = snap.snappedTime - element.startTime;
                }
                currentTrack.elements = trimElementTail(currentTrack.elements, element.id, targetDuration, fps);
            }

            onUpdateTracks(updatedTracks);
        };

        const handleMouseUp = () => {
            setDragAction(null);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    // Keyframe Dragging (Re-time property animation with magnetic & frame snapping)
    const handleKeyframeMouseDown = (
        track: TimelineTrack,
        element: TimelineElement,
        propName: string,
        kf: PropertyKeyframe,
        keyframeId: string,
        e: React.MouseEvent
    ) => {
        e.stopPropagation();
        if (track.locked) return;

        onSelectClip(element.id, track.id);

        const initialKfTime = kf.time ?? 0;
        setDragAction({
            type: 'drag-keyframe',
            trackId: track.id,
            elementId: element.id,
            initialX: e.clientX,
            initialStart: element.startTime,
            initialDuration: element.duration,
            initialTrimStart: element.trimStart,
            keyframeId,
            propName,
            initialKfTime
        });

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaPx = moveEvent.clientX - e.clientX;
            const deltaSec = deltaPx / pxPerSec;
            let targetKfTime = Math.max(0, Math.min(element.duration, initialKfTime + deltaSec));

            if (snappingEnabled) {
                const absoluteTime = element.startTime + targetKfTime;
                const snap = magneticSnap(absoluteTime, snapTargets, 10, pxPerSec);
                if (snap.didSnap) {
                    targetKfTime = Math.max(0, Math.min(element.duration, snap.snappedTime - element.startTime));
                }
            }

            targetKfTime = snapToFrameSeconds(targetKfTime, fps);

            const updatedTracks = data.tracks.map(t => {
                if (t.id !== track.id) return t;
                return {
                    ...t,
                    elements: t.elements.map(el => {
                        if (el.id !== element.id || !el.keyframes) return el;
                        const propKfs = el.keyframes[propName];
                        if (!Array.isArray(propKfs)) return el;
                        return {
                            ...el,
                            keyframes: {
                                ...el.keyframes,
                                [propName]: propKfs.map((k, idx) => {
                                    const currId = k.id || `kf-${idx}`;
                                    if (currId === keyframeId || k === kf) {
                                        return { ...k, time: targetKfTime };
                                    }
                                    return k;
                                })
                            }
                        };
                    })
                };
            });

            onUpdateTracks(updatedTracks);
            onSeek(snapToFrameSeconds(element.startTime + targetKfTime, fps));
        };

        const handleMouseUp = () => {
            setDragAction(null);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    // Generate ruler second intervals
    const rulerTicks = useMemo(() => {
        const interval = pxPerSec > 60 ? 1 : pxPerSec > 30 ? 2 : 5;
        const ticks: { time: number; label: string; x: number }[] = [];
        for (let s = 0; s <= duration + 5; s += interval) {
            ticks.push({
                time: s,
                label: formatTimecodeShort(s, fps),
                x: s * pxPerSec
            });
        }
        return ticks;
    }, [duration, pxPerSec, fps]);

    return (
        <div ref={containerRef} className="sb-nle-timeline-card flex flex-col bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden select-none">
            {/* Timeline Scrollable Canvas Container */}
            <div className="sb-nle-timeline-container flex overflow-x-auto relative min-h-[220px] max-h-[360px] custom-scrollbar">
                {/* Fixed Track Headers Left Column */}
                <div className="sb-nle-track-headers-col sticky left-0 z-30 w-64 shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col shadow-md">
                    {/* Ruler Corner Header */}
                    <div className="h-7 border-b border-zinc-800 bg-zinc-900/90 px-3 flex items-center justify-between text-[11px] font-medium text-zinc-400">
                        <span>Tracks</span>
                        <span className="text-[10px] text-zinc-500 font-mono">{data.tracks.length} total</span>
                    </div>

                    {/* Track Header Cells */}
                    {data.tracks.map(track => (
                        <div
                            key={track.id}
                            className={`sb-nle-track-header-cell h-11 border-b border-zinc-800/80 px-2 py-1 flex flex-col justify-center gap-0.5 transition-colors ${
                                track.locked ? 'bg-zinc-950/60 opacity-60' : 'bg-zinc-900 hover:bg-zinc-850'
                            }`}
                        >
                            <div className="flex items-center justify-between text-xs">
                                <div className="flex items-center gap-1.5 min-w-0 pr-1">
                                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider shrink-0 ${
                                        track.type === 'video' ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/30' :
                                        track.type === '3d' ? 'bg-rose-600/30 text-rose-300 border border-rose-500/30' :
                                        track.type === 'overlay' ? 'bg-amber-600/30 text-amber-300 border border-amber-500/30' :
                                        'bg-emerald-600/30 text-emerald-300 border border-emerald-500/30'
                                    }`}>
                                        {track.type === 'video' ? 'V' : track.type === 'audio' ? 'A' : track.type === '3d' ? '3D' : 'FX'}
                                    </span>
                                    <span className="font-semibold text-zinc-200 truncate text-[11.5px]" title={track.name}>{track.name}</span>
                                </div>

                                {/* Controls: Eye, Mute, Lock */}
                                <div className="flex items-center gap-1 shrink-0">
                                    {/* Visibility / Eye */}
                                    <button
                                        type="button"
                                        onClick={() => toggleTrackVisibility(track.id)}
                                        className={`sb-btn sb-btn-ghost sb-btn-xs p-1 rounded hover:bg-zinc-800 transition-colors ${
                                            track.visible ? 'text-zinc-300' : 'text-zinc-600'
                                        }`}
                                        title={track.visible ? 'Hide track' : 'Show track'}
                                    >
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            {track.visible ? (
                                                <>
                                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                                    <circle cx="12" cy="12" r="3" />
                                                </>
                                            ) : (
                                                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                            )}
                                        </svg>
                                    </button>

                                    {/* Mute (Audio / Video) */}
                                    {(track.type === 'audio' || track.type === 'video') && (
                                        <button
                                            type="button"
                                            onClick={() => toggleTrackMute(track.id)}
                                            className={`sb-btn sb-btn-ghost sb-btn-xs p-1 rounded hover:bg-zinc-800 transition-colors ${
                                                track.muted ? 'text-rose-400 bg-rose-950/40' : 'text-zinc-400'
                                            }`}
                                            title={track.muted ? 'Unmute track' : 'Mute track'}
                                        >
                                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                {track.muted ? (
                                                    <>
                                                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                                        <line x1="23" y1="9" x2="17" y2="15" />
                                                        <line x1="17" y1="9" x2="23" y2="15" />
                                                    </>
                                                ) : (
                                                    <>
                                                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                                                    </>
                                                )}
                                            </svg>
                                        </button>
                                    )}

                                    {/* Lock */}
                                    <button
                                        type="button"
                                        onClick={() => toggleTrackLock(track.id)}
                                        className={`sb-btn sb-btn-ghost sb-btn-xs p-1 rounded hover:bg-zinc-800 transition-colors ${
                                            track.locked ? 'text-amber-400 bg-amber-950/40' : 'text-zinc-500'
                                        }`}
                                        title={track.locked ? 'Unlock track' : 'Lock track'}
                                    >
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            {track.locked ? (
                                                <>
                                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                                </>
                                            ) : (
                                                <>
                                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                                    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                                                </>
                                            )}
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            {/* Sub-Row: Audio Volume Slider OR Video/3D Track Telemetry Badge */}
                            {track.type === 'audio' ? (
                                <div className="flex items-center gap-1.5 text-[9px] text-zinc-400">
                                    <span>Vol:</span>
                                    <input
                                        type="range"
                                        min="0"
                                        max="1.5"
                                        step="0.05"
                                        value={track.volume ?? 1.0}
                                        onChange={e => updateTrackVolume(track.id, parseFloat(e.target.value))}
                                        className="w-full h-1 bg-zinc-700 rounded accent-blue-500 cursor-pointer"
                                        title="Track Gain"
                                    />
                                    <span className="font-mono w-6 text-right tabular-nums">
                                        {Math.round((track.volume ?? 1.0) * 100)}%
                                    </span>
                                </div>
                            ) : (
                                <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
                                    <span className="truncate opacity-70 text-[9.5px]">
                                        {track.elements[0]?.name ? `${track.elements[0].name.slice(0, 22)}...` : `${track.elements.length} clips`}
                                    </span>
                                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60 font-semibold tracking-wider">
                                        {track.type === '3d' ? '6-DOF' : track.type === 'video' ? '4K UHD' : 'RGBA'}
                                    </span>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {/* Main Scrollable Timeline Lanes */}
                <div
                    className="relative flex-1 bg-zinc-950 cursor-default"
                    style={{ width: `${totalWidthPx}px` }}
                    onClick={() => onSelectClip(undefined)}
                >
                    {/* Time Ruler */}
                    <div
                        ref={rulerRef}
                        onMouseDown={handleRulerMouseDown}
                        className="sb-nle-ruler h-7 border-b border-zinc-800 bg-zinc-900/60 sticky top-0 z-20 cursor-ew-resize relative overflow-hidden"
                    >
                        {rulerTicks.map(tick => (
                            <div
                                key={tick.time}
                                className="absolute top-0 bottom-0 border-l border-zinc-700/60 pl-1 text-[9px] font-mono text-zinc-400 select-none pointer-events-none"
                                style={{ left: `${tick.x}px` }}
                            >
                                {tick.label}
                            </div>
                        ))}

                        {/* Markers */}
                        {(data.markers || []).map(marker => (
                            <div
                                key={marker.id}
                                className="absolute top-0 z-30 cursor-pointer group"
                                style={{ left: `${marker.time * pxPerSec}px` }}
                                title={`${marker.label} (${formatTimecode(marker.time, fps)})`}
                                onClick={e => {
                                    e.stopPropagation();
                                    onSeek(marker.time);
                                }}
                            >
                                <div
                                    className="w-2.5 h-3.5 -ml-1.25 rounded-b shadow-md flex items-center justify-center text-[8px] font-bold text-black"
                                    style={{ backgroundColor: marker.color || '#3b82f6' }}
                                >
                                    ▼
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Draggable Playhead Scrubber Line */}
                    <div
                        className="sb-nle-playhead absolute top-0 bottom-0 z-30 pointer-events-none flex flex-col items-center"
                        style={{ left: `${currentTime * pxPerSec}px` }}
                    >
                        {/* Playhead Head Puck */}
                        <div className="w-3.5 h-4 bg-red-500 rounded-b shadow-lg -mt-0.5 flex items-center justify-center text-[7px] text-white font-bold">
                            ▼
                        </div>
                        {/* Vertical Needle */}
                        <div className="w-[1px] flex-1 bg-red-500 shadow-sm" />
                    </div>

                    {/* Track Lanes */}
                    {data.tracks.map(track => (
                        <div
                            key={track.id}
                            className={`h-11 border-b border-zinc-800/60 relative overflow-hidden ${
                                track.locked ? 'bg-zinc-950/40' : 'bg-zinc-900/20'
                            }`}
                        >
                            {/* Track grid background lines */}
                            {rulerTicks.map(tick => (
                                <div
                                    key={tick.time}
                                    className="absolute top-0 bottom-0 border-l border-zinc-850/40 pointer-events-none"
                                    style={{ left: `${tick.x}px` }}
                                />
                            ))}

                            {/* Elements / Clips */}
                            {track.elements.map(el => {
                                const leftPx = el.startTime * pxPerSec;
                                const widthPx = Math.max(8, el.duration * pxPerSec);
                                const isSelected = el.id === selectedClipId;

                                return (
                                    <div
                                        key={el.id}
                                        onClick={e => handleClipClick(track, el, e)}
                                        onMouseDown={e => handleClipMouseDown(track, el, 'move', e)}
                                        className={`sb-nle-clip-block absolute top-1 bottom-1 rounded px-2 flex items-center justify-between shadow-md cursor-grab active:cursor-grabbing transition-shadow ${
                                            isSelected
                                                ? 'ring-2 ring-blue-400 z-10'
                                                : 'hover:brightness-110 z-0'
                                        } ${
                                            el.type === 'video'
                                                ? 'bg-gradient-to-r from-blue-700 to-indigo-800 text-blue-100 border border-blue-500/40'
                                                : el.type === '3d'
                                                ? 'bg-gradient-to-r from-rose-700 to-pink-800 text-rose-100 border border-rose-500/40'
                                                : el.type === 'audio'
                                                ? 'bg-gradient-to-r from-emerald-700 to-teal-800 text-emerald-100 border border-emerald-500/40'
                                                : 'bg-gradient-to-r from-amber-700 to-orange-800 text-amber-100 border border-amber-500/40'
                                        }`}
                                        style={{
                                            left: `${leftPx}px`,
                                            width: `${widthPx}px`
                                        }}
                                        title={`${el.name} • ${formatTimecode(el.startTime, fps)} - ${formatTimecode(el.startTime + el.duration, fps)}`}
                                    >
                                        {/* Left Trim Handle */}
                                        <div
                                            onMouseDown={e => handleClipMouseDown(track, el, 'trim-head', e)}
                                            className="absolute left-0 top-0 bottom-0 w-2 hover:w-3 bg-white/20 hover:bg-white/50 cursor-col-resize rounded-l flex items-center justify-center transition-all"
                                            title="Trim Head (In-point)"
                                        >
                                            <div className="w-[1px] h-3 bg-white/60" />
                                        </div>

                                        {/* Clip Info Content */}
                                        <div className="flex items-center gap-1.5 min-w-0 pr-2 pl-1 select-none pointer-events-none">
                                            <span className="font-semibold text-xs truncate drop-shadow-sm">{el.name}</span>
                                            <span className="text-[10px] opacity-75 font-mono">
                                                {formatTimecodeShort(el.duration, fps)}
                                            </span>
                                        </div>

                                        {/* Audio waveform simulated glyph for audio clips */}
                                        {el.type === 'audio' && (
                                            <div className="flex items-center gap-[2px] opacity-40 pointer-events-none">
                                                <div className="w-[2px] h-3 bg-white rounded-full" />
                                                <div className="w-[2px] h-5 bg-white rounded-full" />
                                                <div className="w-[2px] h-7 bg-white rounded-full" />
                                                <div className="w-[2px] h-4 bg-white rounded-full" />
                                                <div className="w-[2px] h-6 bg-white rounded-full" />
                                            </div>
                                        )}

                                        {/* 3D Model / Scene Badge */}
                                        {el.type === '3d' && (
                                            <div className="flex items-center gap-1 opacity-85 pointer-events-none text-[10px] font-mono bg-black/40 px-1.5 py-0.5 rounded border border-white/10">
                                                <span>🧊 3D</span>
                                                {el.animationClipName && (
                                                    <span className="text-[9px] opacity-80 truncate max-w-[70px]">
                                                        {el.animationClipName}
                                                    </span>
                                                )}
                                            </div>
                                        )}

                                        {/* Keyframe Diamond Markers */}
                                        {(() => {
                                            if (!el.keyframes) return null;
                                            const entries: Array<{ propName: string; kf: PropertyKeyframe }> = [];
                                            if (Array.isArray(el.keyframes)) {
                                                (el.keyframes as any[]).forEach(k => entries.push({ propName: (k as any).property || 'value', kf: k }));
                                            } else {
                                                Object.entries(el.keyframes).forEach(([propName, kfs]) => {
                                                    if (Array.isArray(kfs)) {
                                                        kfs.forEach(kf => entries.push({ propName, kf }));
                                                    }
                                                });
                                            }
                                            if (entries.length === 0) return null;

                                            return (
                                                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                                                    {entries.map(({ propName, kf }, kfIdx) => {
                                                        const offsetSec = kf.time ?? 0;
                                                        const kfTimeSec = el.startTime + offsetSec;
                                                        const kfLeftPx = offsetSec * pxPerSec;
                                                        if (kfLeftPx < 0 || kfLeftPx > widthPx) return null;
                                                        const keyframeId = kf.id || `kf-${kfIdx}`;
                                                        const isKeyframeDragging = dragAction?.type === 'drag-keyframe' &&
                                                            dragAction.elementId === el.id &&
                                                            dragAction.keyframeId === keyframeId &&
                                                            dragAction.propName === propName;

                                                        return (
                                                            <div
                                                                key={keyframeId}
                                                                onMouseDown={e => {
                                                                    handleKeyframeMouseDown(track, el, propName, kf, keyframeId, e);
                                                                }}
                                                                onClick={e => {
                                                                    e.stopPropagation();
                                                                    onSeek(kfTimeSec);
                                                                }}
                                                                className={`absolute top-1/2 -translate-y-1/2 pointer-events-auto cursor-ew-resize group/kf z-20 ${
                                                                    isKeyframeDragging ? 'scale-125 z-30' : ''
                                                                }`}
                                                                style={{ left: `${kfLeftPx}px` }}
                                                                title={`Keyframe: ${propName} (${JSON.stringify(kf.value)}) at ${formatTimecode(kfTimeSec, fps)} (Click to seek, drag to re-time)`}
                                                            >
                                                                <div className={`w-2.5 h-2.5 -ml-1.25 rotate-45 border shadow transition-transform ${
                                                                    isKeyframeDragging
                                                                        ? 'bg-yellow-200 border-amber-400 scale-125'
                                                                        : 'bg-amber-300 border-amber-600 group-hover/kf:scale-125 group-hover/kf:bg-yellow-200'
                                                                }`} />
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            );
                                        })()}

                                        {/* Right Trim Handle */}
                                        <div
                                            onMouseDown={e => handleClipMouseDown(track, el, 'trim-tail', e)}
                                            className="absolute right-0 top-0 bottom-0 w-2 hover:w-3 bg-white/20 hover:bg-white/50 cursor-col-resize rounded-r flex items-center justify-center transition-all"
                                            title="Trim Tail (Out-point)"
                                        >
                                            <div className="w-[1px] h-3 bg-white/60" />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

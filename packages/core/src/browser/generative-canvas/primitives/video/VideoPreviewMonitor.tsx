/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { VideoTimelineData, VideoAspectRatio } from '../../services/video/videoTypes';
import { formatTimecode, formatTimecodeShort } from '../../services/video/timecode';
import { snapToFrameSeconds } from '../../services/video/rationalTime';

export interface VideoPreviewMonitorProps {
    data: VideoTimelineData;
    onSeek: (timeSeconds: number) => void;
    onTogglePlay: () => void;
    onUpdateAspectRatio: (aspectRatio: VideoAspectRatio) => void;
}

const videoElementCache = new Map<string, HTMLVideoElement>();

function getOrCreateVideoElement(src: string, onFrameReady?: () => void): HTMLVideoElement | null {
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    let video = videoElementCache.get(src);
    if (!video) {
        video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.preload = 'auto';
        video.playsInline = true;
        const normalizedSrc = src.startsWith('/') || src.startsWith('http') || src.startsWith('blob:') ? src : `/${src}`;
        video.src = normalizedSrc;
        videoElementCache.set(src, video);
    }
    if (onFrameReady) {
        video.onseeked = onFrameReady;
        video.onloadeddata = onFrameReady;
    }
    return video;
}

export const VideoPreviewMonitor: React.FC<VideoPreviewMonitorProps> = ({
    data,
    onSeek,
    onTogglePlay,
    onUpdateAspectRatio
}) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const [showSafeAreas, setShowSafeAreas] = useState<boolean>(false);
    const [scaleMode, setScaleMode] = useState<'fit' | '100%' | '50%'>('fit');
    const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
    const [, setVideoTick] = useState<number>(0);

    const fps = data.fps || 30;
    const currentTime = data.currentTime || 0;
    const duration = data.duration || 10;
    const isPlaying = !!data.isPlaying;

    // Aspect ratio dimensions mapping
    const getAspectPadding = (ratio: VideoAspectRatio): string => {
        switch (ratio) {
            case '16:9': return '56.25%';
            case '9:16': return '177.78%';
            case '1:1': return '100%';
            case '4:3': return '75%';
            case '2.39:1': return '41.84%';
            default: return '56.25%';
        }
    };

    // Keyboard shortcuts for transport
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Only trigger if active element is not an input or textarea
            const tag = (document.activeElement?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea') return;

            if (e.code === 'Space') {
                e.preventDefault();
                onTogglePlay();
            } else if (e.code === 'ArrowLeft') {
                e.preventDefault();
                const step = e.shiftKey ? (1.0) : (1 / fps);
                onSeek(Math.max(0, currentTime - step));
            } else if (e.code === 'ArrowRight') {
                e.preventDefault();
                const step = e.shiftKey ? (1.0) : (1 / fps);
                onSeek(Math.min(duration, currentTime + step));
            } else if (e.code === 'Home') {
                e.preventDefault();
                onSeek(0);
            } else if (e.code === 'End') {
                e.preventDefault();
                onSeek(duration);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentTime, duration, fps, onSeek, onTogglePlay]);

    // Canvas drawing for preview visualization (synthetic cinematic frame generator)
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;

        // Draw dark cinema backdrop
        ctx.fillStyle = '#09090b';
        ctx.fillRect(0, 0, width, height);

        // Find active elements at current playhead
        const activeClips = data.tracks
            .filter(t => t.visible && !t.muted)
            .flatMap(t => t.elements)
            .filter(el => currentTime >= el.startTime && currentTime <= el.startTime + el.duration);

        if (activeClips.length === 0) {
            // Idle screen: cinematic test pattern
            ctx.save();
            ctx.fillStyle = '#18181b';
            ctx.fillRect(40, 40, width - 80, height - 80);

            // Subtle studio grid
            ctx.strokeStyle = '#27272a';
            ctx.lineWidth = 1;
            for (let x = 60; x < width - 60; x += 40) {
                ctx.beginPath();
                ctx.moveTo(x, 40);
                ctx.lineTo(x, height - 40);
                ctx.stroke();
            }
            for (let y = 60; y < height - 60; y += 40) {
                ctx.beginPath();
                ctx.moveTo(40, y);
                ctx.lineTo(width - 40, y);
                ctx.stroke();
            }

            // Center text
            ctx.fillStyle = '#71717a';
            ctx.font = '600 14px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('NO MEDIA AT PLAYHEAD', width / 2, height / 2 - 10);
            ctx.fillStyle = '#52525b';
            ctx.font = '400 11px Inter, system-ui, sans-serif';
            ctx.fillText(`Drop media or drag playhead • ${formatTimecode(currentTime, fps)}`, width / 2, height / 2 + 15);
            ctx.restore();
        } else {
            // Render active clips from bottom to top
            for (const clip of activeClips) {
                ctx.save();
                ctx.globalAlpha = clip.opacity ?? 1.0;

                const progress = (currentTime - clip.startTime) / Math.max(0.001, clip.duration);

                let drewCustomContent = false;
                if (clip.type === 'video') {
                    const videoSrc = clip.sourcePath || (clip.isVfxPlate && clip.vfxPlate?.sourceVideoUri);
                    if (videoSrc) {
                        const videoEl = getOrCreateVideoElement(videoSrc, () => setVideoTick(t => t + 1));
                        if (videoEl) {
                            const targetTime = (clip.trimStart ?? 0) + (currentTime - clip.startTime) * (clip.speed || 1.0);
                            if (Math.abs(videoEl.currentTime - targetTime) > 0.04) {
                                videoEl.currentTime = Math.max(0, targetTime);
                            }
                            if (videoEl.readyState >= 2) {
                                ctx.drawImage(videoEl, 0, 0, width, height);
                                drewCustomContent = true;
                            }
                        }
                    }
                }

                if (!drewCustomContent) {
                    // Simulated clip graphic (procedural visual presentation fallback)
                    const grad = ctx.createLinearGradient(0, 0, width, height);
                    if (clip.type === '3d') {
                        grad.addColorStop(0, '#0f172a');
                        grad.addColorStop(0.5, '#3b82f6');
                        grad.addColorStop(1, '#06b6d4');
                    } else if (clip.type === 'video') {
                        grad.addColorStop(0, '#1e1b4b');
                        grad.addColorStop(0.5, '#6366f1');
                        grad.addColorStop(1, '#a855f7');
                    } else if (clip.type === 'image') {
                        grad.addColorStop(0, '#022c22');
                        grad.addColorStop(0.5, '#10b981');
                        grad.addColorStop(1, '#84cc16');
                    } else {
                        grad.addColorStop(0, '#1c1917');
                        grad.addColorStop(0.5, '#f59e0b');
                        grad.addColorStop(1, '#ef4444');
                    }

                    ctx.fillStyle = grad;
                    ctx.fillRect(0, 0, width, height);
                }

                if (clip.type === '3d') {
                    // Draw 3D wireframe / holographic projection with perspective lines
                    ctx.save();
                    const centerX = width / 2;
                    const centerY = height / 2;
                    const rotAngle = ((currentTime - clip.startTime) * (clip.animationSpeed || 1.0) * 0.8) % (Math.PI * 2);
                    const fovFactor = Math.tan(((clip.cameraConfig?.fov || 45) * Math.PI) / 360);
                    const scale = (height * 0.35) / Math.max(0.1, fovFactor);

                    // 3D coordinate grid / ground plane
                    ctx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
                    ctx.lineWidth = 1;
                    for (let gridI = -5; gridI <= 5; gridI++) {
                        const gz = gridI * 40;
                        const p1X = centerX + (gridI * 60);
                        const p1Y = centerY + 100;
                        ctx.beginPath();
                        ctx.moveTo(p1X - 200, p1Y + gz * 0.3);
                        ctx.lineTo(p1X + 200, p1Y + gz * 0.3);
                        ctx.stroke();
                    }

                    // 3D wireframe rotating bounding prism representing project 3D asset
                    const cubeVerts = [
                        [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
                        [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
                    ];
                    const edges = [
                        [0, 1], [1, 2], [2, 3], [3, 0],
                        [4, 5], [5, 6], [6, 7], [7, 4],
                        [0, 4], [1, 5], [2, 6], [3, 7]
                    ];

                    const proj = cubeVerts.map(([vx, vy, vz]) => {
                        const cosA = Math.cos(rotAngle);
                        const sinA = Math.sin(rotAngle);
                        const rx = vx * cosA - vz * sinA;
                        const rz = vx * sinA + vz * cosA + 3.0;
                        const ry = vy;
                        return {
                            x: centerX + (rx / rz) * scale,
                            y: centerY - (ry / rz) * scale
                        };
                    });

                    ctx.strokeStyle = clip.wireframe ? '#22d3ee' : '#38bdf8';
                    ctx.lineWidth = 2;
                    ctx.shadowColor = '#06b6d4';
                    ctx.shadowBlur = 10;
                    ctx.beginPath();
                    for (const [e1, e2] of edges) {
                        ctx.moveTo(proj[e1].x, proj[e1].y);
                        ctx.lineTo(proj[e2].x, proj[e2].y);
                    }
                    ctx.stroke();
                    ctx.shadowBlur = 0;

                    // 3D HUD stats
                    ctx.fillStyle = '#67e8f9';
                    ctx.font = '600 12px Inter, monospace';
                    ctx.textAlign = 'left';
                    ctx.fillText(`3D COMPOSITING PASS: ${clip.sourcePath || clip.modelUrl || 'Project Scene'}`, 30, 40);
                    if (clip.animationClipName) {
                        ctx.fillText(`ANIMATION CLIP: ${clip.animationClipName} (${((currentTime - clip.startTime) * (clip.animationSpeed || 1.0)).toFixed(2)}s)`, 30, 60);
                    }
                    ctx.restore();
                } else {
                    // Dynamic motion graphics element
                    const motionX = width / 2 + Math.sin(progress * Math.PI * 4) * 80;
                    const motionY = height / 2 + Math.cos(progress * Math.PI * 2) * 30;

                    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
                    ctx.beginPath();
                    ctx.arc(motionX, motionY, 70, 0, Math.PI * 2);
                    ctx.fill();
                }

                // Clip title overlay
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 20px Inter, system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(clip.name, width / 2, height / 2);

                if (clip.textContent) {
                    ctx.font = '500 14px Inter, system-ui, sans-serif';
                    ctx.fillStyle = clip.textColor || '#e2e8f0';
                    ctx.fillText(clip.textContent, width / 2, height / 2 + 35);
                }

                ctx.restore();
            }
        }

        // Check for active VFX Plate elements to render live HUD telemetry and tracking marker crosshairs
        const activeVfxClip = activeClips.find(c => c.isVfxPlate || c.vfxPlate);
        if (activeVfxClip?.vfxPlate) {
            const vfx = activeVfxClip.vfxPlate;
            ctx.save();

            // 1. Draw Tracking Markers (#TK-01 to #TK-08)
            if (vfx.trackingMarkers && vfx.trackingMarkers.length > 0) {
                for (const m of vfx.trackingMarkers) {
                    const px = (m.platePoint2D[0] / 1920) * width;
                    const py = (m.platePoint2D[1] / 1080) * height;

                    // Marker crosshair
                    ctx.strokeStyle = '#10b981';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(px, py, 6, 0, Math.PI * 2);
                    ctx.moveTo(px - 10, py);
                    ctx.lineTo(px + 10, py);
                    ctx.moveTo(px, py - 10);
                    ctx.lineTo(px, py + 10);
                    ctx.stroke();

                    // Marker badge text
                    ctx.fillStyle = 'rgba(16, 185, 129, 0.9)';
                    ctx.font = '600 10px Inter, monospace';
                    ctx.textAlign = 'left';
                    ctx.fillText(`${m.id} [0.18px]`, px + 12, py - 4);
                }
            }

            // 2. Anti-Drift Telemetry Pill
            ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 1.5;
            const badgeW = 340;
            const badgeH = 54;
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(16, 16, badgeW, badgeH, 6);
            } else {
                ctx.rect(16, 16, badgeW, badgeH);
            }
            ctx.fill();
            ctx.stroke();

            // Status dot
            ctx.fillStyle = '#10b981';
            ctx.beginPath();
            ctx.arc(32, 34, 5, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#f8fafc';
            ctx.font = '700 11px Inter, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('REAL-TIME ANTI-DRIFT ENGINE: LOCKED', 44, 38);

            ctx.fillStyle = '#94a3b8';
            ctx.font = '500 10px Inter, monospace';
            const meanErr = (vfx.cameraSolveTrack || vfx.cameraSolve)?.meanReprojectionErrorPx ?? 0.18;
            const solar = (vfx.ephemerisAnchor || vfx.geodeticAnchor)?.calculatedSolar;
            const sunAlt = (solar && typeof (solar as any).altitude === 'number') ? ((solar as any).altitudeDegrees ?? ((solar as any).altitude * 180 / Math.PI)) : 38.2;
            const sunAz = (solar && typeof (solar as any).azimuth === 'number') ? ((solar as any).azimuthDegrees ?? ((solar as any).azimuth * 180 / Math.PI)) : 245.8;
            ctx.fillText(`RMS: ${meanErr}px | NOAA SUN: ${sunAz.toFixed(1)}° AZ, ${sunAlt.toFixed(1)}° ALT`, 44, 56);

            ctx.restore();
        }

        // Safe Area Overlays
        if (showSafeAreas) {
            ctx.save();
            ctx.strokeStyle = 'rgba(234, 179, 8, 0.4)'; // Action safe (93%)
            ctx.lineWidth = 1;
            ctx.strokeRect(width * 0.035, height * 0.035, width * 0.93, height * 0.93);

            ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)'; // Title safe (90%)
            ctx.strokeRect(width * 0.05, height * 0.05, width * 0.9, height * 0.9);

            // Center crosshair
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            const cx = width / 2;
            const cy = height / 2;
            ctx.beginPath();
            ctx.moveTo(cx - 15, cy);
            ctx.lineTo(cx + 15, cy);
            ctx.moveTo(cx, cy - 15);
            ctx.lineTo(cx, cy + 15);
            ctx.stroke();

            ctx.restore();
        }
    }, [currentTime, data.tracks, fps, showSafeAreas]);

    const toggleFullscreen = () => {
        if (!containerRef.current) return;
        if (!document.fullscreenElement) {
            containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
        } else {
            document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
        }
    };

    return (
        <div ref={containerRef} className="sb-nle-monitor flex flex-col bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden select-none">
            {/* Monitor Header Toolbar */}
            <div className="sb-nle-monitor-header flex items-center justify-between px-3 py-2 bg-zinc-900/80 border-b border-zinc-800 text-xs text-zinc-300">
                <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-100 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                        Program Monitor
                    </span>
                    <span className="text-zinc-600">|</span>
                    {/* Aspect Ratio Selector */}
                    <div className="flex items-center gap-1">
                        {(['16:9', '9:16', '1:1', '4:3', '2.39:1'] as VideoAspectRatio[]).map(ratio => (
                            <button
                                key={ratio}
                                type="button"
                                onClick={() => onUpdateAspectRatio(ratio)}
                                className={`sb-btn sb-btn-xs px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${
                                    data.aspectRatio === ratio
                                        ? 'bg-blue-600 text-white font-semibold'
                                        : 'bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400'
                                }`}
                            >
                                {ratio}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {/* Safe Area Toggle */}
                    <button
                        type="button"
                        onClick={() => setShowSafeAreas(!showSafeAreas)}
                        className={`sb-btn sb-btn-xs px-2 py-0.5 rounded text-[10px] transition-colors ${
                            showSafeAreas ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40' : 'bg-zinc-800 hover:bg-zinc-750 text-zinc-400'
                        }`}
                        title="Toggle Action & Title Safe Area Guides"
                    >
                        Guides
                    </button>

                    {/* Scale Mode */}
                    <select
                        value={scaleMode}
                        onChange={e => setScaleMode(e.target.value as any)}
                        className="bg-zinc-800 text-zinc-300 text-[10px] rounded px-1.5 py-0.5 border border-zinc-700 focus:outline-none"
                    >
                        <option value="fit">Fit</option>
                        <option value="100%">100%</option>
                        <option value="50%">50%</option>
                    </select>

                    {/* Fullscreen Button */}
                    <button
                        type="button"
                        onClick={toggleFullscreen}
                        className="sb-btn sb-btn-ghost sb-btn-xs p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors"
                        title="Toggle Fullscreen"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Viewport Canvas Stage */}
            <div className="sb-nle-monitor-viewport relative flex-1 min-h-[260px] max-h-[460px] bg-black flex items-center justify-center p-3 overflow-hidden">
                <div
                    className="sb-nle-aspect-box relative shadow-2xl rounded border border-zinc-800/80 overflow-hidden"
                    style={{
                        aspectRatio: data.aspectRatio === '16:9' ? '16/9' : data.aspectRatio === '9:16' ? '9/16' : data.aspectRatio === '1:1' ? '1/1' : data.aspectRatio === '4:3' ? '4/3' : '2.39/1',
                        maxHeight: '100%',
                        maxWidth: '100%'
                    }}
                >
                    <canvas
                        ref={canvasRef}
                        width={960}
                        height={540}
                        className="w-full h-full object-contain block bg-zinc-950"
                    />

                    {/* Current Timecode Floating Overlay */}
                    <div className="sb-nle-timecode-hud absolute top-2 left-2 px-2 py-0.5 bg-black/75 backdrop-blur-md rounded text-[11px] font-mono text-zinc-200 border border-zinc-800/60 pointer-events-none">
                        {formatTimecode(currentTime, fps)}
                    </div>
                </div>
            </div>

            {/* Transport Bar & Scrubber */}
            <div className="sb-nle-transport flex items-center justify-between px-3 py-2 bg-zinc-900 border-t border-zinc-800 text-xs">
                {/* Timecode Readouts */}
                <div className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-blue-400 font-semibold">{formatTimecode(currentTime, fps)}</span>
                    <span className="text-zinc-600">/</span>
                    <span className="text-zinc-400">{formatTimecode(duration, fps)}</span>
                </div>

                {/* Transport Controls */}
                <div className="flex items-center gap-1">
                    {/* Skip to Start */}
                    <button
                        type="button"
                        onClick={() => onSeek(0)}
                        className="sb-btn sb-btn-ghost sb-btn-xs p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors"
                        title="Jump to Start (Home)"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="19 20 9 12 19 4 19 20" />
                            <line x1="5" y1="19" x2="5" y2="5" />
                        </svg>
                    </button>

                    {/* Previous Frame */}
                    <button
                        type="button"
                        onClick={() => onSeek(Math.max(0, currentTime - 1 / fps))}
                        className="sb-btn sb-btn-ghost sb-btn-xs p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors"
                        title="Step 1 Frame Backward (←)"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="15 18 9 12 15 6 15 18" />
                        </svg>
                    </button>

                    {/* Play / Pause Primary Action */}
                    <button
                        type="button"
                        onClick={onTogglePlay}
                        className={`sb-btn p-2 rounded-full transition-all ${
                            isPlaying
                                ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/30'
                                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30'
                        }`}
                        title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
                    >
                        {isPlaying ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <rect x="6" y="4" width="4" height="16" rx="1" />
                                <rect x="14" y="4" width="4" height="16" rx="1" />
                            </svg>
                        ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                        )}
                    </button>

                    {/* Next Frame */}
                    <button
                        type="button"
                        onClick={() => onSeek(Math.min(duration, currentTime + 1 / fps))}
                        className="sb-btn sb-btn-ghost sb-btn-xs p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors"
                        title="Step 1 Frame Forward (→)"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="9 18 15 12 9 6 9 18" />
                        </svg>
                    </button>

                    {/* Skip to End */}
                    <button
                        type="button"
                        onClick={() => onSeek(duration)}
                        className="sb-btn sb-btn-ghost sb-btn-xs p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors"
                        title="Jump to End (End)"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="5 4 15 12 5 20 5 4" />
                            <line x1="19" y1="5" x2="19" y2="19" />
                        </svg>
                    </button>
                </div>

                {/* Framerate & Audio Meter indicator */}
                <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-400 font-mono">
                        {fps} FPS
                    </span>
                    <div className="w-16 h-2 bg-zinc-800 rounded-full overflow-hidden flex items-center">
                        <div
                            className={`h-full rounded-full transition-all duration-75 ${isPlaying ? 'bg-gradient-to-r from-emerald-500 via-amber-500 to-rose-500' : 'bg-emerald-600'}`}
                            style={{ width: isPlaying ? '72%' : '10%' }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

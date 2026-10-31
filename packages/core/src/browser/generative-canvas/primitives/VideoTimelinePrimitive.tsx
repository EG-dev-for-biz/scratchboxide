/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { CanvasArtifact } from '../canvas-types';
import { canCreatePrimitive } from '../../../common/product-scope';
import {
    VideoTimelineData,
    TimelineTrack,
    TimelineElement,
    GradeParams,
    VideoAspectRatio,
    NleTool,
    VideoMediaAsset
} from '../services/video/videoTypes';
import { snapToFrameSeconds } from '../services/video/rationalTime';
import { splitElementAtTime, rippleDeleteElement } from '../services/video/timelineMath';
import { VideoPreviewMonitor } from './video/VideoPreviewMonitor';
import { VideoTimelineTracks } from './video/VideoTimelineTracks';
import { VideoToolbar } from './video/VideoToolbar';
import { VideoInspectorPanel } from './video/VideoInspectorPanel';
import { VideoExportModal } from './video/VideoExportModal';

export interface VideoTimelinePrimitiveProps {
    data?: VideoTimelineData;
    onUpdate?: (updatedData: VideoTimelineData) => void;
    onPromptAction?: (promptText: string) => void;
    onMorphArtifact?: (artifact: CanvasArtifact) => void;
    onForkArtifact?: (artifact: CanvasArtifact) => void;
    hideTopbar?: boolean;
    readOnly?: boolean;
}

const DEFAULT_TIMELINE_DATA: VideoTimelineData = {
    title: 'Cyberpunk 2088 Motion Teaser',
    subtitle: 'Multi-track non-linear video editing with ASC-CDL color grading & OTIO interchange',
    aspectRatio: '16:9',
    fps: 30,
    duration: 15.0,
    currentTime: 0,
    zoom: 50,
    isPlaying: false,
    masterVolume: 1.0,
    tracks: [
        {
            id: 'v2-overlay',
            name: 'V2 Title Graphics',
            type: 'overlay',
            visible: true,
            muted: false,
            locked: false,
            elements: [
                {
                    id: 'clip-v2-1',
                    name: 'SCRATCHBOX NLE HUD',
                    trackId: 'v2-overlay',
                    type: 'text',
                    startTime: 1.0,
                    duration: 4.5,
                    trimStart: 0,
                    trimEnd: 4.5,
                    opacity: 0.95,
                    textContent: 'SYSTEM: COMPOSITING MATRIX ONLINE',
                    textColor: '#38bdf8'
                }
            ]
        },
        {
            id: 'v1-video',
            name: 'V1 Video Footage',
            type: 'video',
            visible: true,
            locked: false,
            elements: [
                {
                    id: 'clip-v1-1',
                    name: 'City Skyline Drone Shot',
                    trackId: 'v1-video',
                    type: 'video',
                    startTime: 0,
                    duration: 5.0,
                    trimStart: 0,
                    trimEnd: 5.0,
                    opacity: 1.0,
                    grade: {
                        exposure: 0,
                        contrast: 0,
                        saturation: 100
                    }
                },
                {
                    id: 'clip-v1-2',
                    name: 'Project 3D Robot Mech',
                    trackId: 'v1-video',
                    type: '3d',
                    sourceType: 'glb',
                    sourcePath: 'assets/models/robot_mech.glb',
                    animationClipName: 'Walk_Cycle',
                    animationSpeed: 1.0,
                    cameraConfig: {
                        fov: 45,
                        position: [0, 2, 5],
                        target: [0, 0.5, 0]
                    },
                    lightingConfig: {
                        ambientColor: '#38bdf8',
                        ambientIntensity: 1.2,
                        directionalColor: '#ffffff',
                        directionalIntensity: 2.5,
                        directionalPosition: [4, 6, 4]
                    },
                    startTime: 5.0,
                    duration: 6.5,
                    trimStart: 0,
                    trimEnd: 6.5,
                    opacity: 1.0,
                    grade: {
                        exposure: 0,
                        contrast: 0,
                        saturation: 100
                    }
                },
                {
                    id: 'clip-v1-3',
                    name: 'Neon Highway Hyperlapse',
                    trackId: 'v1-video',
                    type: 'video',
                    startTime: 11.5,
                    duration: 3.5,
                    trimStart: 0,
                    trimEnd: 3.5,
                    opacity: 1.0,
                    grade: {
                        exposure: 0,
                        contrast: 0,
                        saturation: 100
                    }
                }
            ]
        },
        {
            id: 'a1-music',
            name: 'A1 Synthwave Soundtrack',
            type: 'audio',
            visible: true,
            locked: false,
            volume: 0.9,
            elements: [
                {
                    id: 'clip-a1-1',
                    name: 'Synthwave Night City Theme.wav',
                    trackId: 'a1-music',
                    type: 'audio',
                    startTime: 0,
                    duration: 15.0,
                    trimStart: 0,
                    trimEnd: 15.0,
                    volume: 0.9
                }
            ]
        },
        {
            id: 'a2-sfx',
            name: 'A2 Riser & Impact SFX',
            type: 'audio',
            visible: true,
            locked: false,
            volume: 0.75,
            elements: [
                {
                    id: 'clip-a2-1',
                    name: 'Cybernetic Impact SFX',
                    trackId: 'a2-sfx',
                    type: 'audio',
                    startTime: 4.8,
                    duration: 4.0,
                    trimStart: 0,
                    trimEnd: 4.0,
                    volume: 0.8
                }
            ]
        }
    ],
    markers: [
        { id: 'm1', time: 0, label: 'Intro Start', color: '#3b82f6' },
        { id: 'm2', time: 5.0, label: 'Bass Drop & 3D Switch', color: '#ef4444' },
        { id: 'm3', time: 11.5, label: 'Outro Climax', color: '#8b5cf6' }
    ],
    mediaAssets: [
        { id: 'med-1', name: 'City Skyline Drone Shot.mp4', type: 'video', duration: 12.0, width: 3840, height: 2160, fps: 30 },
        { id: 'med-2', name: '3D Hologram Mech Scene.glb', type: '3d', duration: 10.0 },
        { id: 'med-3', name: 'Neon Highway Hyperlapse.mp4', type: 'video', duration: 8.0, width: 1920, height: 1080, fps: 30 },
        { id: 'med-4', name: 'Synthwave Night City Theme.wav', type: 'audio', duration: 30.0 },
        { id: 'med-5', name: 'Cybernetic Impact SFX.wav', type: 'audio', duration: 4.0 }
    ],
    globalGrade: {
        exposure: 0,
        contrast: 0,
        saturation: 100,
        colorTemp: 6500,
        colorTint: 0
    }
};

export const VideoTimelinePrimitive: React.FC<VideoTimelinePrimitiveProps> = ({
    data = DEFAULT_TIMELINE_DATA,
    onUpdate,
    onPromptAction,
    onMorphArtifact,
    onForkArtifact,
    hideTopbar = false,
    readOnly = false
}) => {
    const [timelineState, setTimelineState] = useState<VideoTimelineData>(data);
    const [selectedClipId, setSelectedClipId] = useState<string | undefined>('clip-v1-1');
    const [selectedTrackId, setSelectedTrackId] = useState<string | undefined>('v1-video');
    const [activeTool, setActiveTool] = useState<NleTool>('select');
    const [snappingEnabled, setSnappingEnabled] = useState<boolean>(true);
    const [zoom, setZoom] = useState<number>(45); // px per sec
    const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);

    const animationFrameRef = useRef<number | null>(null);
    const lastTimestampRef = useRef<number | null>(null);

    // Keep internal state synced if external data changes
    useEffect(() => {
        if (data) {
            setTimelineState(data);
        }
    }, [data]);

    // Dispatch update to parent container
    const dispatchUpdate = useCallback((nextState: VideoTimelineData) => {
        setTimelineState(nextState);
        onUpdate?.(nextState);
    }, [onUpdate]);

    // Playhead animation loop
    useEffect(() => {
        if (!timelineState.isPlaying) {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
            lastTimestampRef.current = null;
            return;
        }

        const loop = (timestamp: number) => {
            if (lastTimestampRef.current === null) {
                lastTimestampRef.current = timestamp;
            }
            const dt = (timestamp - lastTimestampRef.current) / 1000;
            lastTimestampRef.current = timestamp;

            setTimelineState(prev => {
                let nextTime = prev.currentTime + dt;
                let nextPlaying = prev.isPlaying;

                if (nextTime >= prev.duration) {
                    // Loop to start
                    nextTime = 0;
                }

                return { ...prev, currentTime: nextTime, isPlaying: nextPlaying };
            });

            animationFrameRef.current = requestAnimationFrame(loop);
        };

        animationFrameRef.current = requestAnimationFrame(loop);

        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, [timelineState.isPlaying]);

    // Seek handler
    const handleSeek = useCallback((timeSeconds: number) => {
        const fps = timelineState.fps || 30;
        const clamped = Math.max(0, Math.min(timelineState.duration, snapToFrameSeconds(timeSeconds, fps)));
        dispatchUpdate({ ...timelineState, currentTime: clamped });
    }, [timelineState, dispatchUpdate]);

    // Toggle Play/Pause
    const handleTogglePlay = useCallback(() => {
        dispatchUpdate({ ...timelineState, isPlaying: !timelineState.isPlaying });
    }, [timelineState, dispatchUpdate]);

    // Update Aspect Ratio
    const handleUpdateAspectRatio = useCallback((ratio: VideoAspectRatio) => {
        dispatchUpdate({ ...timelineState, aspectRatio: ratio });
    }, [timelineState, dispatchUpdate]);

    // Update Tracks
    const handleUpdateTracks = useCallback((newTracks: TimelineTrack[]) => {
        dispatchUpdate({ ...timelineState, tracks: newTracks });
    }, [timelineState, dispatchUpdate]);

    // Find currently selected clip object
    const selectedClip = React.useMemo(() => {
        if (!selectedClipId) return undefined;
        for (const track of timelineState.tracks) {
            const found = track.elements.find(el => el.id === selectedClipId);
            if (found) return found;
        }
        return undefined;
    }, [timelineState.tracks, selectedClipId]);

    // Update Clip
    const handleUpdateClip = useCallback((updatedClip: TimelineElement) => {
        const nextTracks = timelineState.tracks.map(track => {
            const hasClip = track.elements.some(el => el.id === updatedClip.id);
            if (!hasClip) return track;
            return {
                ...track,
                elements: track.elements.map(el => el.id === updatedClip.id ? updatedClip : el)
            };
        });
        dispatchUpdate({ ...timelineState, tracks: nextTracks });
    }, [timelineState, dispatchUpdate]);

    // Split at playhead
    const handleSplitAtPlayhead = useCallback(() => {
        if (!selectedClip || !selectedTrackId) return;
        const fps = timelineState.fps || 30;
        const newTracks = timelineState.tracks.map(t => {
            if (t.id !== selectedTrackId) return t;
            return {
                ...t,
                elements: splitElementAtTime(t.elements, selectedClip.id, timelineState.currentTime, fps)
            };
        });
        dispatchUpdate({ ...timelineState, tracks: newTracks });
    }, [selectedClip, selectedTrackId, timelineState, dispatchUpdate]);

    // Ripple Delete Selected Clip
    const handleRippleDelete = useCallback(() => {
        if (!selectedClip || !selectedTrackId) return;
        const fps = timelineState.fps || 30;
        const newTracks = timelineState.tracks.map(t => {
            if (t.id !== selectedTrackId) return t;
            return {
                ...t,
                elements: rippleDeleteElement(t.elements, selectedClip.id, fps)
            };
        });
        setSelectedClipId(undefined);
        dispatchUpdate({ ...timelineState, tracks: newTracks });
    }, [selectedClip, selectedTrackId, timelineState, dispatchUpdate]);

    // Add Track
    const handleAddTrack = useCallback((type: 'video' | 'audio') => {
        const trackCount = timelineState.tracks.filter(t => t.type === type).length + 1;
        const newTrack: TimelineTrack = {
            id: `track-${type}-${Date.now()}`,
            name: `${type === 'video' ? 'V' : 'A'}${trackCount} Track`,
            type,
            visible: true,
            muted: false,
            locked: false,
            volume: 1.0,
            elements: []
        };
        dispatchUpdate({ ...timelineState, tracks: [...timelineState.tracks, newTrack] });
    }, [timelineState, dispatchUpdate]);

    // Add Media Asset to Media Pool
    const handleAddMediaAsset = useCallback((asset: VideoMediaAsset) => {
        dispatchUpdate({ ...timelineState, mediaAssets: [...timelineState.mediaAssets, asset] });
    }, [timelineState, dispatchUpdate]);

    // Morphing into 3D Scene
    const handleMorphTo3D = () => {
        if (!onMorphArtifact) return;
        onMorphArtifact({
            id: `art-3d-${Date.now()}`,
            title: `${timelineState.title} (3D Stage)`,
            summary: 'Morphed 3D viewport containing spatial video projectors and geometries',
            type: '3d-scene',
            version: 1,
            createdAt: new Date().toLocaleTimeString(),
            data: {
                title: `${timelineState.title} - 3D Scene`,
                subtitle: 'Procedural 3D stage spawned from NLE video timeline',
                camera: { position: [15, 12, 15], target: [0, 0, 0] },
                environment: { skybox: 'cyberpunk', lighting: 'shaded', ground: true },
                objects: []
            }
        });
    };

    // Morphing into Live Code Sandbox
    const handleMorphToCode = () => {
        if (!onMorphArtifact) return;
        onMorphArtifact({
            id: `art-code-${Date.now()}`,
            title: `${timelineState.title} Player Sandbox`,
            summary: 'Interactive React video player sandbox',
            type: 'live-code-sandbox',
            version: 1,
            createdAt: new Date().toLocaleTimeString(),
            data: {
                title: `${timelineState.title} - Live Player Component`,
                subtitle: 'React video timeline player sandbox',
                template: 'react',
                viewMode: 'preview',
                files: [
                    {
                        id: 'file-player',
                        name: 'VideoPlayer.tsx',
                        path: 'src/VideoPlayer.tsx',
                        language: 'react',
                        isEntry: true,
                        content: `import React from 'react';\n\nexport default function VideoPlayer() {\n  return (\n    <div className="p-8 bg-black text-white min-h-screen flex flex-col items-center justify-center">\n      <h1 className="text-2xl font-bold mb-4">${timelineState.title}</h1>\n      <p className="text-zinc-400">Duration: ${timelineState.duration}s • Aspect: ${timelineState.aspectRatio}</p>\n    </div>\n  );\n}`
                    }
                ],
                dependencies: {}
            }
        });
    };

    return (
        <div className="sb-nle-studio flex flex-col w-full h-full bg-zinc-950 text-zinc-100 overflow-hidden font-sans select-none">
            {/* Topbar */}
            {!hideTopbar && (
                <div className="sb-nle-header flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800 text-xs">
                    <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center text-white shadow-md">
                            🎬
                        </div>
                        <div>
                            <div className="font-bold text-zinc-100 text-sm flex items-center gap-2">
                                <span>{timelineState.title}</span>
                                <span className="sb-nle-badge px-2 py-0.5 rounded text-[10px] bg-blue-600/20 text-blue-400 border border-blue-500/30">
                                    NLE Studio
                                </span>
                            </div>
                            <div className="text-[11px] text-zinc-400">
                                {timelineState.subtitle}
                            </div>
                        </div>
                    </div>

                    {/* Morphing & Surface Action Buttons */}
                    <div className="flex items-center gap-2">
                        {/* AI Prompt Suggestions */}
                        <div className="hidden lg:flex items-center gap-1.5">
                            <button
                                type="button"
                                onClick={() => onPromptAction?.('Split active clip at playhead and ripple delete downstream gap')}
                                className="sb-btn sb-btn-secondary sb-btn-xs px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-750 text-zinc-300 text-[11px] border border-zinc-700 transition-colors"
                            >
                                ✂️ Smart Razor Cut
                            </button>
                        </div>

                        <div className="w-[1px] h-4 bg-zinc-700 mx-1" />

                        {/* Morph to 3D */}
                        <button
                            type="button"
                            onClick={handleMorphTo3D}
                            className="sb-btn sb-btn-secondary sb-btn-xs px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-750 text-zinc-300 text-xs flex items-center gap-1.5 transition-colors"
                            title="Morph timeline into 3D Scene Viewport"
                        >
                            <span>🧊</span>
                            <span>3D Stage</span>
                        </button>

                        {/* Morph to Code (not in the 3D/VFX build, which makes no code sandboxes) */}
                        {canCreatePrimitive('live-code-sandbox') && (
                            <button
                                type="button"
                                onClick={handleMorphToCode}
                                className="sb-btn sb-btn-secondary sb-btn-xs px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-750 text-zinc-300 text-xs flex items-center gap-1.5 transition-colors"
                                title="Morph into React Video Player Component"
                            >
                                <span>💻</span>
                                <span>React Player</span>
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Upper Stage: Monitor (Left - Expanded) + Inspector (Right) */}
            <div className="sb-nle-upper-stage flex-1 grid grid-cols-12 gap-2 p-2 min-h-0 overflow-hidden">
                {/* Left: Program Monitor (Maximized Workspace) */}
                <div className="sb-nle-monitor-col col-span-12 lg:col-span-8 xl:col-span-8 flex flex-col min-h-0">
                    <VideoPreviewMonitor
                        data={timelineState}
                        onSeek={handleSeek}
                        onTogglePlay={handleTogglePlay}
                        onUpdateAspectRatio={handleUpdateAspectRatio}
                    />
                </div>

                {/* Right: Inspector Panel */}
                <div className="sb-nle-inspector-col col-span-12 lg:col-span-4 xl:col-span-4 flex flex-col min-h-0">
                    <VideoInspectorPanel
                        data={timelineState}
                        selectedClip={selectedClip}
                        onUpdateClip={handleUpdateClip}
                        onUpdateGlobalGrade={grade => dispatchUpdate({
                            ...timelineState,
                            globalGrade: { ...timelineState.globalGrade, ...grade }
                        })}
                        onAddMediaAsset={handleAddMediaAsset}
                        onUpdateMasterVolume={vol => dispatchUpdate({ ...timelineState, masterVolume: vol })}
                        onUpdateTrackVolume={(trackId, vol) => dispatchUpdate({
                            ...timelineState,
                            tracks: timelineState.tracks.map(t => t.id === trackId ? { ...t, volume: vol } : t)
                        })}
                    />
                </div>
            </div>

            {/* Lower Stage: Toolbar + Multi-Track Timeline (Compact) */}
            <div className="sb-nle-lower-stage shrink-0 max-h-[210px] overflow-y-auto flex flex-col border-t border-zinc-800 bg-zinc-950">
                <VideoToolbar
                    activeTool={activeTool}
                    onSelectTool={setActiveTool}
                    snappingEnabled={snappingEnabled}
                    onToggleSnapping={() => setSnappingEnabled(!snappingEnabled)}
                    onSplitAtPlayhead={handleSplitAtPlayhead}
                    onRippleDeleteSelected={handleRippleDelete}
                    onAddTrack={handleAddTrack}
                    zoom={zoom}
                    onChangeZoom={setZoom}
                    onOpenExportModal={() => setIsExportModalOpen(true)}
                    canSplit={!!selectedClip && !!selectedTrackId}
                    canDelete={!!selectedClip && !!selectedTrackId}
                />

                <VideoTimelineTracks
                    data={timelineState}
                    onUpdateTracks={handleUpdateTracks}
                    onSeek={handleSeek}
                    onSelectClip={(clipId, trackId) => {
                        setSelectedClipId(clipId);
                        if (trackId) setSelectedTrackId(trackId);
                    }}
                    selectedClipId={selectedClipId}
                    activeTool={activeTool}
                    snappingEnabled={snappingEnabled}
                    zoom={zoom}
                />
            </div>

            {/* Export Modal */}
            <VideoExportModal
                data={timelineState}
                isOpen={isExportModalOpen}
                onClose={() => setIsExportModalOpen(false)}
            />
        </div>
    );
};

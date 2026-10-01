/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    BlendMode,
    type VideoTimelineData,
    type TimelineTrack,
    type TimelineElement,
    type VideoAspectRatio
} from './videoTypes';
import { splitElementAtTime, rippleDeleteElement } from './timelineMath';
import {
    classifyDomain,
    synthesizeAdaptiveVideoTimeline
} from '../adaptive-domain-engine';

/**
 * Synthesize or mutate a multi-track Video NLE timeline primitive.
 * Handles split clip at playhead, ripple delete downstream gap, aspect ratio adjustments,
 * and intelligent multi-track sequencing.
 */
export function synthesizeContextualVideoTimeline(
    prompt: string,
    customTitle?: string,
    existingData?: VideoTimelineData
): VideoTimelineData {
    const lower = prompt.toLowerCase();
    const domain = classifyDomain(prompt, customTitle);
    const adaptiveTimeline = synthesizeAdaptiveVideoTimeline(domain, customTitle ?? '', prompt);

    // Default professional tracks baseline if no existingData or empty tracks
    const baseTracks: TimelineTrack[] = existingData?.tracks && existingData.tracks.length > 0
        ? JSON.parse(JSON.stringify(existingData.tracks))
        : adaptiveTimeline.tracks;

    let currentTime = existingData?.currentTime ?? 3.0; // Playhead at 3.0s by default for mid-clip cut
    const fps = existingData?.fps ?? 30;
    let duration = existingData?.duration ?? 15.0;
    let aspectRatio: VideoAspectRatio = existingData?.aspectRatio ?? '16:9';

    if (lower.includes('9:16') || lower.includes('vertical') || lower.includes('tiktok') || lower.includes('reel') || lower.includes('shorts')) {
        aspectRatio = '9:16';
    } else if (lower.includes('1:1') || lower.includes('square')) {
        aspectRatio = '1:1';
    } else if (lower.includes('21:9') || lower.includes('cinemascope') || lower.includes('2.39:1')) {
        aspectRatio = '2.39:1';
    } else if (lower.includes('4:3')) {
        aspectRatio = '4:3';
    } else if (lower.includes('16:9')) {
        aspectRatio = '16:9';
    }

    // Check for "split" operation
    const isSplit = /split|razor|cut\s+(?:clip|at)/i.test(prompt);
    const isRippleDelete = /ripple\s+delete|ripple|delete\s+gap|close\s+gap/i.test(prompt);

    // Check for compositing, chroma keying, transform, and VFX anti-drift operations
    const isKeying = /chroma\s*key|green\s*screen|blue\s*screen|key\s*out|despill/i.test(prompt);
    const isPip = /picture\s*in\s*picture|\bpip\b|corner|scale\s+(?:down|to|by)|inset/i.test(prompt);
    const isLightWrap = /light\s*wrap/i.test(prompt);
    const isVfxDemo = /vfx\s*plate|anti-?drift|matchmove|vfx\s*demo/i.test(prompt);
    const isComposite = /composite|multi-layer/i.test(prompt) || isKeying || isPip || isLightWrap || isVfxDemo;
    const isBlue = /blue\s*screen|blue\s*key/i.test(prompt);

    if (isVfxDemo && (!existingData?.tracks || existingData.tracks.length === 0)) {
        baseTracks.length = 0;
        baseTracks.push(
            {
                id: 'track-v1-plate',
                name: 'V1: Live-Action VFX Plate',
                type: 'video',
                visible: true,
                muted: false,
                locked: true,
                color: '#3b82f6',
                elements: [
                    {
                        id: 'el-vfx-plate-01',
                        name: 'The Plaza Hotel 4K Architectural Plate (24fps)',
                        type: 'video',
                        startTime: 0.0,
                        duration: 15.0,
                        trimStart: 0.0,
                        trimEnd: 15.0,
                        sourcePath: 'videos/plaza_hotel_blockout_camera.mp4',
                        isVfxPlate: true,
                        vfxPlate: {
                            id: 'vfx-plate-live-action-01',
                            plateName: 'The Plaza Hotel 4K Architectural Plate',
                            sourceVideoUri: 'videos/plaza_hotel_blockout_camera.mp4',
                            sourceResolution: [3840, 2160],
                            frameRate: 24,
                            durationSeconds: 15.0,
                            cameraSolveTrack: {
                                id: 'solve-track-plaza-01',
                                name: 'Central Park South 6-DOF Photogrammetric Matchmove Solve',
                                coordinateSystem: 'threejs',
                                fps: 24,
                                totalFrames: 360,
                                durationSeconds: 15.0,
                                meanReprojectionErrorPx: 0.18,
                                sensorWidthMm: 36.0,
                                sensorHeightMm: 24.0,
                                focalLengthMm: 35.0,
                                isSolved: true,
                                sourceSoftware: 'Syntheyes Pro',
                                frames: [
                                    { frameNumber: 0, timeSeconds: 0.0, position: [0.0, 1.8, 5.0], rotationQuaternion: [0.0, 0.0, 0.0, 1.0], fovDegrees: 45.0, focalLengthMm: 35.0, reprojectionErrorPx: 0.15 },
                                    { frameNumber: 24, timeSeconds: 1.0, position: [0.35, 1.82, 4.85], rotationQuaternion: [0.0, 0.026, 0.0, 0.999], fovDegrees: 45.0, focalLengthMm: 35.0, reprojectionErrorPx: 0.17 },
                                    { frameNumber: 48, timeSeconds: 2.0, position: [0.72, 1.85, 4.68], rotationQuaternion: [0.0, 0.052, 0.0, 0.998], fovDegrees: 45.0, focalLengthMm: 35.0, reprojectionErrorPx: 0.18 },
                                    { frameNumber: 60, timeSeconds: 2.5, position: [0.91, 1.86, 4.58], rotationQuaternion: [0.0, 0.065, 0.0, 0.997], fovDegrees: 45.0, focalLengthMm: 35.0, reprojectionErrorPx: 0.18 },
                                    { frameNumber: 72, timeSeconds: 3.0, position: [1.10, 1.88, 4.49], rotationQuaternion: [0.0, 0.078, 0.0, 0.996], fovDegrees: 45.0, focalLengthMm: 35.0, reprojectionErrorPx: 0.19 },
                                    { frameNumber: 120, timeSeconds: 5.0, position: [1.88, 1.94, 4.08], rotationQuaternion: [0.0, 0.129, 0.0, 0.991], fovDegrees: 45.0, focalLengthMm: 35.0, reprojectionErrorPx: 0.20 },
                                    { frameNumber: 240, timeSeconds: 10.0, position: [3.75, 2.05, 3.12], rotationQuaternion: [0.0, 0.252, 0.0, 0.967], fovDegrees: 45.0, focalLengthMm: 35.0, reprojectionErrorPx: 0.22 },
                                    { frameNumber: 360, timeSeconds: 15.0, position: [4.80, 2.10, 2.65], rotationQuaternion: [0.0, 0.320, 0.0, 0.947], fovDegrees: 45.0, focalLengthMm: 35.0, reprojectionErrorPx: 0.22 }
                                ]
                            },
                            ephemerisAnchor: {
                                lat: 40.7648,
                                lng: -73.9744,
                                alt: 32.5,
                                headingDegrees: 210.0,
                                utcTimestampIso: '2026-06-21T17:30:00Z',
                                sunLockActive: true,
                                calculatedSolar: { altitude: 38.2, azimuth: 245.8, altitudeDegrees: 38.2, azimuthDegrees: 245.8 },
                                solarDirectionVector: [-0.68, 0.62, 0.38]
                            },
                            lensDistortion: {
                                k1: -0.042,
                                k2: 0.008,
                                p1: 0.0,
                                p2: 0.0,
                                anamorphicSqueeze: 1.0,
                                squeezeFactor: 1.0,
                                chromaticAberrationPx: 0.8
                            },
                            holdoutConfig: {
                                enabled: true,
                                depthHoldoutEnabled: true,
                                holdoutThresholdMeters: 8.5,
                                depthThresholdMeters: 8.5,
                                edgeFeatherRadiusPx: 3.5,
                                edgeFeatherPx: 3.5,
                                occlusionBiasMeters: 0.02,
                                maxPermittedDriftPx: 2.0
                            },
                            trackingMarkers: [
                                { id: 'TK-01', name: 'Central Portico Main Arch', worldPoint3D: [0.0, 1.8, -5.0], platePoint2D: [960, 540], weight: 1.0 },
                                { id: 'TK-02', name: 'North Gable Turret Apex', worldPoint3D: [-3.5, 6.2, -12.0], platePoint2D: [384, 756], weight: 1.0 },
                                { id: 'TK-03', name: 'Grand Cornice Dentil Frieze', worldPoint3D: [-1.8, 5.0, -9.5], platePoint2D: [512, 792], weight: 1.0 },
                                { id: 'TK-04', name: 'Central Park South Promenade Edge', worldPoint3D: [1.5, 2.5, -14.0], platePoint2D: [1240, 420], weight: 1.0 },
                                { id: 'TK-05', name: 'Grand Ballroom Balustrade', worldPoint3D: [3.2, 4.8, -16.0], platePoint2D: [1520, 280], weight: 1.0 },
                                { id: 'TK-06', name: 'Fifth Avenue Plaza Sidewalk Edge', worldPoint3D: [2.2, 0.0, -6.5], platePoint2D: [1380, 840], weight: 1.0 },
                                { id: 'TK-07', name: 'Canopy Sconce Column', worldPoint3D: [-1.0, 0.0, -5.0], platePoint2D: [720, 890], weight: 1.0 },
                                { id: 'TK-08', name: 'Fountain Plaza Pedestal Base', worldPoint3D: [0.8, 0.0, -7.2], platePoint2D: [1080, 815], weight: 1.0 }
                            ]
                        }
                    }
                ]
            },
            {
                id: 'track-v2-3d-inpaint',
                name: 'V2: 3D CG Monolith Extension',
                type: '3d',
                visible: true,
                muted: false,
                locked: false,
                color: '#06b6d4',
                elements: [
                    {
                        id: 'el-cg-monolith-01',
                        name: 'Architectural Monolith Inpaint',
                        type: '3d',
                        startTime: 0.0,
                        duration: 15.0,
                        trimStart: 0.0,
                        trimEnd: 15.0,
                        sourcePath: 'models/cg_architectural_monolith.glb',
                        wireframe: false,
                        opacity: 1.0,
                        blendMode: BlendMode.Normal,
                        cameraConfig: { fov: 45, position: [0, 1.8, 5], target: [0, 1.8, 0] },
                        lightingConfig: { ambientIntensity: 0.35, directionalIntensity: 2.8, directionalColor: '#ff9f43', directionalPosition: [5, 10, 5] }
                    }
                ]
            },
            {
                id: 'track-v3-holdout',
                name: 'V3: Foreground Actor Holdout Matte',
                type: 'overlay',
                visible: true,
                muted: false,
                locked: false,
                color: '#a855f7',
                elements: [
                    {
                        id: 'el-holdout-matte-01',
                        name: 'Pedestrian & Prop Occlusion Matte',
                        type: 'image',
                        startTime: 0.0,
                        duration: 15.0,
                        trimStart: 0.0,
                        trimEnd: 15.0,
                        opacity: 1.0,
                        blendMode: BlendMode.Normal
                    }
                ]
            },
            {
                id: 'track-a1-audio',
                name: 'A1: Production Audio',
                type: 'audio',
                visible: true,
                muted: false,
                locked: false,
                color: '#10b981',
                elements: [
                    {
                        id: 'el-audio-production-01',
                        name: 'Location Ambience (Downtown 5.1)',
                        type: 'audio',
                        startTime: 0.0,
                        duration: 15.0,
                        trimStart: 0.0,
                        trimEnd: 15.0,
                        sourcePath: 'media/audio/dtla_ambience_sync.wav',
                        volume: 0.85
                    }
                ]
            }
        );
    }

    if (isSplit) {
        // Find the active or primary track (e.g. v1-video or first track with elements spanning currentTime)
        let splitTargetTrack = baseTracks.find(t => t.elements.some(el => currentTime > el.startTime && currentTime < el.startTime + el.duration));
        if (!splitTargetTrack) {
            // Find any track with an element
            splitTargetTrack = baseTracks.find(t => t.type === 'video' && t.elements.length > 0) || baseTracks.find(t => t.elements.length > 0);
            if (splitTargetTrack && splitTargetTrack.elements.length > 0) {
                // Adjust currentTime to midpoint of first element
                const firstEl = splitTargetTrack.elements[0];
                currentTime = firstEl.startTime + firstEl.duration / 2;
            }
        }

        if (splitTargetTrack) {
            const targetEl = splitTargetTrack.elements.find(el => currentTime > el.startTime && currentTime < el.startTime + el.duration) || splitTargetTrack.elements[0];
            if (targetEl) {
                const updatedElements = splitElementAtTime(splitTargetTrack.elements, targetEl.id, currentTime, fps);
                splitTargetTrack.elements = updatedElements;

                // If ripple delete downstream gap or downstream clip was also requested:
                if (isRippleDelete && updatedElements.length > 1) {
                    // Find the second part of the split clip
                    const secondPart = updatedElements.find(el => el.id.includes('-split-') || el.startTime >= currentTime);
                    if (secondPart) {
                        splitTargetTrack.elements = rippleDeleteElement(updatedElements, secondPart.id, fps);
                    }
                }
            }
        }
    } else if (isRippleDelete) {
        // Perform ripple delete on selected or first non-empty track
        const targetTrack = baseTracks.find(t => t.type === 'video' && t.elements.length > 1) || baseTracks.find(t => t.elements.length > 1);
        if (targetTrack && targetTrack.elements.length > 1) {
            const elToDelete = targetTrack.elements[1];
            targetTrack.elements = rippleDeleteElement(targetTrack.elements, elToDelete.id, fps);
        }
    }

    // Apply Compositing, Chroma Keying, and Transform parameters
    if (isKeying || isPip || isComposite || isLightWrap) {
        // Target an upper track element (e.g. on v2 or overlay track, or first non-background element)
        let upperTrack = baseTracks.find(t => t.id.includes('v2') || t.id.includes('overlay') || t.type === 'overlay');
        if (!upperTrack && baseTracks.length > 1) {
            upperTrack = baseTracks[0];
        }

        let targetEl: TimelineElement | undefined;
        if (upperTrack && upperTrack.elements.length > 0) {
            targetEl = upperTrack.elements[0];
        } else if (baseTracks.length > 0 && baseTracks[0].elements.length > 0) {
            targetEl = baseTracks[0].elements[0];
        }

        if (targetEl) {
            if (isKeying || isComposite) {
                targetEl.keying = {
                    enabled: true,
                    keyColor: isBlue ? '#0000ff' : '#00ff00',
                    tolerance: 35,
                    softness: 15,
                    despill: 65,
                    invert: false
                };
            }

            if (isLightWrap || isKeying) {
                targetEl.lightWrap = {
                    intensity: 45,
                    spread: 25
                };
            }

            if (isPip) {
                targetEl.layerTransform = {
                    x: 0.25,
                    y: -0.25,
                    scaleX: 0.45,
                    scaleY: 0.45,
                    rotation: 0
                };
            }

            // LUT grade if cyberpunk / teal-orange / noir is specified
            if (lower.includes('cyberpunk') || lower.includes('neon')) {
                targetEl.grade = { ...targetEl.grade, lutId: 'cyberpunk', contrast: 15, saturation: 120 };
            } else if (lower.includes('teal') || lower.includes('orange')) {
                targetEl.grade = { ...targetEl.grade, lutId: 'teal-orange', contrast: 10, saturation: 110 };
            } else if (lower.includes('noir') || lower.includes('black and white')) {
                targetEl.grade = { ...targetEl.grade, lutId: 'noir', contrast: 25, saturation: 0 };
            }
        }
    }

    // Recompute total duration from max element end time
    let maxEndTime = 10.0;
    for (const track of baseTracks) {
        for (const el of track.elements) {
            const end = el.startTime + el.duration;
            if (end > maxEndTime) maxEndTime = end;
        }
    }
    duration = Math.max(duration, Math.ceil(maxEndTime));

    const finalTitle = customTitle || (isVfxDemo
        ? 'VFX Plate Anti-Drift Studio Demo'
        : (isSplit && isRippleDelete
            ? 'Video NLE: Split Clip & Ripple Delete'
            : (isSplit
                ? 'Video NLE: Razor Cut at Playhead'
                : (isKeying
                    ? 'Video Compositor: Chroma Key & Despill Studio'
                    : (isPip
                        ? 'Video Compositor: Picture-in-Picture Transform'
                        : (isComposite
                            ? 'Video Compositor: Multi-Layer VFX Composite'
                            : (existingData?.title || 'Multi-Track Video NLE Timeline')))))));

    const finalSubtitle = isVfxDemo
        ? 'Real-time 6-DOF matchmove, NOAA ephemeris sun lock, Brown-Conrady distortion & holdout matte'
        : (isSplit && isRippleDelete
            ? `Active clip split at ${currentTime.toFixed(2)}s with downstream gap ripple deleted`
            : (isSplit
                ? `Active clip split into two segments at playhead (${currentTime.toFixed(2)}s)`
                : (isKeying
                    ? 'Real-time hardware-accelerated chroma keying with despill suppression and optical light wrap'
                    : (isPip
                        ? 'Spatial 2D affine transformation with custom position, scale, and anchoring'
                        : (isComposite
                            ? 'Multi-track composited plates with GPU color grading and blend modes'
                            : (existingData?.subtitle || 'Multi-track non-linear video editing with WebGL compositor'))))));

    return {
        title: finalTitle,
        subtitle: finalSubtitle,
        fps: isVfxDemo ? 24 : fps,
        duration: isVfxDemo ? 15.0 : duration,
        currentTime,
        zoom: existingData?.zoom ?? 50,
        aspectRatio,
        isPlaying: false,
        activeTool: isSplit ? 'cut' : (isRippleDelete ? 'ripple' : (existingData?.activeTool || 'select')),
        tracks: baseTracks,
        mediaAssets: existingData?.mediaAssets ?? [],
        activeVfxPlateId: isVfxDemo ? 'vfx-plate-live-action-01' : existingData?.activeVfxPlateId
    };
}

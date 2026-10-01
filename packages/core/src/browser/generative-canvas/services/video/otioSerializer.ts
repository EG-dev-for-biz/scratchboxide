/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { VideoTimelineData, TimelineTrack, TimelineElement } from './videoTypes';
import { sortElements } from './timelineMath';

/**
 * OpenTimelineIO 1.0 JSON Serializer & Deserializer
 * Compatible with Pixar / ASWF standard (DaVinci Resolve, Final Cut Pro, Adobe Premiere)
 */

export interface OtioRationalTime {
    OTIO_SCHEMA: 'RationalTime.1';
    value: number;
    rate: number;
}

export interface OtioTimeRange {
    OTIO_SCHEMA: 'TimeRange.1';
    start_time: OtioRationalTime;
    duration: OtioRationalTime;
}

export interface OtioMediaReference {
    OTIO_SCHEMA: 'ExternalReference.1' | 'MissingReference.1';
    name?: string;
    target_url?: string;
    available_range?: OtioTimeRange;
}

export interface OtioClip {
    OTIO_SCHEMA: 'Clip.1';
    name: string;
    source_range: OtioTimeRange;
    media_reference: OtioMediaReference;
    metadata?: Record<string, unknown>;
}

export interface OtioGap {
    OTIO_SCHEMA: 'Gap.1';
    source_range: OtioTimeRange;
}

export interface OtioTrack {
    OTIO_SCHEMA: 'Track.1';
    name: string;
    kind: 'Video' | 'Audio';
    children: (OtioClip | OtioGap)[];
}

export interface OtioTimeline {
    OTIO_SCHEMA: 'Timeline.1';
    metadata: Record<string, unknown>;
    name: string;
    global_start_time: OtioRationalTime | null;
    tracks: {
        OTIO_SCHEMA: 'Stack.1';
        name: string;
        children: OtioTrack[];
    };
}

function makeRationalTime(seconds: number, rate: number): OtioRationalTime {
    return {
        OTIO_SCHEMA: 'RationalTime.1',
        value: Math.round(seconds * rate),
        rate
    };
}

function makeTimeRange(startSec: number, durationSec: number, rate: number): OtioTimeRange {
    return {
        OTIO_SCHEMA: 'TimeRange.1',
        start_time: makeRationalTime(startSec, rate),
        duration: makeRationalTime(durationSec, rate)
    };
}

/**
 * Exports VideoTimelineData into standard OpenTimelineIO 1.0 JSON format.
 */
export function exportToOtio(timeline: VideoTimelineData): OtioTimeline {
    const fps = timeline.fps || 30;

    const otioTracks: OtioTrack[] = timeline.tracks.map(track => {
        const isAudio = track.type === 'audio';
        const sorted = sortElements(track.elements);
        const children: (OtioClip | OtioGap)[] = [];

        let currentCursor = 0;

        for (const el of sorted) {
            // Fill gap before clip if any
            if (el.startTime > currentCursor + (1 / fps)) {
                const gapDuration = el.startTime - currentCursor;
                children.push({
                    OTIO_SCHEMA: 'Gap.1',
                    source_range: makeTimeRange(0, gapDuration, fps)
                });
            }

            const media = timeline.mediaAssets.find(m => m.id === el.mediaId);
            const clip: OtioClip = {
                OTIO_SCHEMA: 'Clip.1',
                name: el.name,
                source_range: makeTimeRange(el.trimStart, el.duration, fps),
                media_reference: media ? {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    name: media.name,
                    target_url: media.url
                } : {
                    OTIO_SCHEMA: 'MissingReference.1'
                },
                metadata: {
                    scratchbox: {
                        opacity: el.opacity,
                        blendMode: el.blendMode,
                        grade: el.grade,
                        vfx: el.vfx,
                        speed: el.speed
                    }
                }
            };
            children.push(clip);
            currentCursor = Math.max(currentCursor, el.startTime + el.duration);
        }

        return {
            OTIO_SCHEMA: 'Track.1',
            name: track.name,
            kind: isAudio ? 'Audio' : 'Video',
            children
        };
    });

    return {
        OTIO_SCHEMA: 'Timeline.1',
        name: timeline.title || 'Scratchbox Timeline',
        global_start_time: makeRationalTime(0, fps),
        metadata: {
            scratchboxVersion: '1.0.0',
            exportedAt: new Date().toISOString()
        },
        tracks: {
            OTIO_SCHEMA: 'Stack.1',
            name: 'tracks',
            children: otioTracks
        }
    };
}

/**
 * Imports an OTIO JSON document into native Scratchbox VideoTimelineData.
 */
export function importFromOtio(otio: OtioTimeline): Partial<VideoTimelineData> {
    const fps = otio.global_start_time?.rate || 30;
    const tracks: TimelineTrack[] = [];

    const otioTracks = otio.tracks?.children || [];

    for (let tIdx = 0; tIdx < otioTracks.length; tIdx++) {
        const oTrack = otioTracks[tIdx];
        const isAudio = oTrack.kind === 'Audio';
        const elements: TimelineElement[] = [];

        let currentCursor = 0;

        for (let cIdx = 0; cIdx < oTrack.children.length; cIdx++) {
            const child = oTrack.children[cIdx];
            const rate = child.source_range?.duration?.rate || fps;
            const dur = (child.source_range?.duration?.value || 0) / rate;
            const startOffset = (child.source_range?.start_time?.value || 0) / rate;

            if (child.OTIO_SCHEMA === 'Gap.1') {
                currentCursor += dur;
                continue;
            }

            if (child.OTIO_SCHEMA === 'Clip.1') {
                const clip = child as OtioClip;
                const metadata = (clip.metadata?.scratchbox as Record<string, unknown>) || {};

                elements.push({
                    id: `clip-${tIdx}-${cIdx}-${Date.now()}`,
                    name: clip.name || `Clip ${cIdx + 1}`,
                    type: isAudio ? 'audio' : 'video',
                    startTime: currentCursor,
                    duration: dur,
                    trimStart: startOffset,
                    trimEnd: startOffset + dur,
                    opacity: typeof metadata.opacity === 'number' ? metadata.opacity : 1.0,
                    speed: typeof metadata.speed === 'number' ? metadata.speed : 1.0,
                    grade: (metadata.grade as any) || undefined,
                    vfx: (metadata.vfx as any) || undefined
                });

                currentCursor += dur;
            }
        }

        tracks.push({
            id: `track-${tIdx}-${Date.now()}`,
            name: oTrack.name || (isAudio ? `A${tIdx + 1}` : `V${tIdx + 1}`),
            type: isAudio ? 'audio' : 'video',
            muted: false,
            locked: false,
            visible: true,
            elements
        });
    }

    return {
        title: otio.name || 'Imported Timeline',
        fps,
        tracks
    };
}

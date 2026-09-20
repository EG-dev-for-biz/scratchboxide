/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    formatTimecode,
    formatTimecodeShort,
    formatDuration,
    parseTimecode,
    TICKS_PER_SECOND,
    simplifyRational,
    frameToTime,
    timeToFrame,
    secondsToRational,
    rationalToSeconds,
    addRational,
    subRational,
    snapToFrameSeconds,
    secondsToTicks,
    ticksToSeconds,
    splitElementAtTime,
    rippleDeleteElement,
    trimElementHead,
    trimElementTail,
    slipElement,
    slideElement,
    magneticSnap,
    getInterpolatedPropValue,
    parseCubeLut,
    generateProceduralLut,
    exportToOtio,
    importFromOtio,
    QUAD_VERT,
    COMPOSITOR_FRAG,
    TimelineElement,
    VideoTimelineData,
    BlendMode
} from '../src/browser/generative-canvas/services/video';

describe('SMPTE Timecode Engine', () => {
    it('formats seconds to SMPTE timecode (non-drop-frame and drop-frame)', () => {
        expect(formatTimecode(0, 30, false)).toBe('00:00:00:00');
        expect(formatTimecode(1.0, 30, false)).toBe('00:00:01:00');
        expect(formatTimecode(3600, 24, false)).toBe('01:00:00:00');
        expect(formatTimecode(125.5, 30, false)).toBe('00:02:05:15');
    });

    it('formats compact timecode and duration', () => {
        expect(formatTimecodeShort(125.5, 30)).toBe('02:05:15');
        expect(formatDuration(45.2)).toBe('45.2s');
        expect(formatDuration(125)).toBe('2m 05s');
    });

    it('parses SMPTE timecode back to seconds', () => {
        expect(parseTimecode('00:00:01:00', 30)).toBe(1.0);
        expect(parseTimecode('01:00:00:00', 24)).toBe(3600);
        expect(parseTimecode('00:02:05:15', 30)).toBeCloseTo(125.5, 2);
    });

    it('supports SMPTE drop-frame formatting for 29.97 fps', () => {
        const tc = formatTimecode(60, 29.97, true);
        expect(tc).toContain(';');
    });
});

describe('RationalTime Engine (48 kHz Tick Precision)', () => {
    it('accurately converts seconds to 48 kHz ticks and back', () => {
        expect(TICKS_PER_SECOND).toBe(48000);
        const seconds = 2.5;
        const ticks = secondsToTicks(seconds);
        expect(ticks).toBe(120000);
        expect(ticksToSeconds(ticks)).toBe(2.5);
    });

    it('performs rational addition and subtraction without floating-point accumulation drift', () => {
        const a = frameToTime(1, 30); // 1/30
        const b = frameToTime(2, 30); // 2/30
        const sum = addRational(a, b);
        expect(rationalToSeconds(sum)).toBeCloseTo(0.1, 5);

        const diff = subRational(sum, a);
        expect(rationalToSeconds(diff)).toBeCloseTo(rationalToSeconds(b), 5);
    });

    it('snaps arbitrary seconds to exact frame boundaries', () => {
        expect(snapToFrameSeconds(1.031, 30)).toBeCloseTo(1.033333, 4);
        expect(snapToFrameSeconds(1.01, 30)).toBeCloseTo(1.0, 4);
    });
});

describe('Timeline Math & NLE Operations', () => {
    const mockElements: TimelineElement[] = [
        {
            id: 'clip-1',
            name: 'Interview Take 1',
            type: 'video',
            startTime: 2.0,
            duration: 8.0,
            trimStart: 0,
            trimEnd: 8.0
        }
    ];

    it('splits clip at playhead position cleanly', () => {
        const result = splitElementAtTime(mockElements, 'clip-1', 5.0, 30);
        expect(result.length).toBe(2);
        const [head, tail] = result;
        expect(head.id).toBe('clip-1');
        expect(head.startTime).toBe(2.0);
        expect(head.duration).toBe(3.0);
        expect(head.trimEnd).toBe(3.0);

        expect(tail.startTime).toBe(5.0);
        expect(tail.duration).toBe(5.0);
        expect(tail.trimStart).toBe(3.0);
        expect(tail.trimEnd).toBe(8.0);
    });

    it('rejects split outside of clip boundaries', () => {
        const result1 = splitElementAtTime(mockElements, 'clip-1', 1.0, 30);
        expect(result1.length).toBe(1);

        const result2 = splitElementAtTime(mockElements, 'clip-1', 11.0, 30);
        expect(result2.length).toBe(1);
    });

    it('trims clip head without moving subsequent clips', () => {
        const trimmed = trimElementHead(mockElements, 'clip-1', 3.5, 30);
        expect(trimmed[0].startTime).toBe(3.5);
        expect(trimmed[0].duration).toBe(6.5);
        expect(trimmed[0].trimStart).toBe(1.5);
    });

    it('trims clip tail smoothly', () => {
        const trimmed = trimElementTail(mockElements, 'clip-1', 5.0, 30);
        expect(trimmed[0].startTime).toBe(2.0);
        expect(trimmed[0].duration).toBe(5.0);
        expect(trimmed[0].trimEnd).toBe(5.0);
    });

    it('performs slip edit', () => {
        const slipped = slipElement(mockElements, 'clip-1', 2.0, 20.0, 30);
        expect(slipped[0].startTime).toBe(2.0);
        expect(slipped[0].duration).toBe(8.0);
        expect(slipped[0].trimStart).toBe(2.0);
        expect(slipped[0].trimEnd).toBe(10.0);
    });

    it('performs slide edit', () => {
        const elements: TimelineElement[] = [
            { id: 'clip-0', name: 'Intro', type: 'video', startTime: 0, duration: 2.0, trimStart: 0, trimEnd: 2.0 },
            { id: 'clip-1', name: 'Middle', type: 'video', startTime: 2.0, duration: 4.0, trimStart: 0, trimEnd: 4.0 },
            { id: 'clip-2', name: 'Outro', type: 'video', startTime: 6.0, duration: 4.0, trimStart: 0, trimEnd: 4.0 }
        ];
        const slid = slideElement(elements, 'clip-1', 1.0, 30);
        const mid = slid.find(e => e.id === 'clip-1');
        expect(mid?.startTime).toBe(3.0);
    });

    it('performs magnetic snapping to nearby clip boundaries or playhead', () => {
        const targets = [0, 5.0, 10.0, 15.0];
        const snap1 = magneticSnap(5.08, targets, 10, 50);
        expect(snap1.didSnap).toBe(true);
        expect(snap1.snappedTime).toBe(5.0);

        const snap2 = magneticSnap(5.3, targets, 10, 50);
        expect(snap2.didSnap).toBe(false);
        expect(snap2.snappedTime).toBe(5.3);
    });

    it('performs ripple delete and shifts subsequent clips left', () => {
        const elements: TimelineElement[] = [
            { id: 'c1', name: 'Clip 1', type: 'video', startTime: 0, duration: 4.0, trimStart: 0, trimEnd: 4.0 },
            { id: 'c2', name: 'Clip 2', type: 'video', startTime: 4.0, duration: 3.0, trimStart: 0, trimEnd: 3.0 },
            { id: 'c3', name: 'Clip 3', type: 'video', startTime: 7.0, duration: 5.0, trimStart: 0, trimEnd: 5.0 }
        ];

        const updated = rippleDeleteElement(elements, 'c2', 30);
        expect(updated.length).toBe(2);
        expect(updated[0].id).toBe('c1');
        expect(updated[0].startTime).toBe(0);
        expect(updated[1].id).toBe('c3');
        expect(updated[1].startTime).toBe(4.0);
    });

    it('interpolates keyframes using cubic Bezier easing', () => {
        const keyframes = [
            { id: 'k1', time: 0, value: 0, easing: 'easeInOut' as const },
            { id: 'k2', time: 2.0, value: 100, easing: 'linear' as const }
        ];

        expect(getInterpolatedPropValue(keyframes, 0, 0)).toBe(0);
        expect(getInterpolatedPropValue(keyframes, 0, 2.0)).toBe(100);
        const mid = getInterpolatedPropValue(keyframes, 0, 1.0);
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThan(100);
    });
});

describe('3D LUT Parser & Procedural Color Pipeline', () => {
    it('generates procedural 3D LUT tables for teal-orange, cyberpunk, vintage, and noir', () => {
        const presets = ['teal-orange', 'cyberpunk', 'vintage', 'noir'] as const;
        for (const preset of presets) {
            const lut = generateProceduralLut(preset, 16);
            expect(lut.image.width).toBe(16);
            expect(lut.image.data.length).toBe(16 * 16 * 16 * 4);
        }
    });

    it('parses Adobe/DaVinci .cube format strings into 3D LUT volumetric data', () => {
        const cubeText = `
TITLE "Sample 3D LUT"
LUT_3D_SIZE 2
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
        `;
        const parsed = parseCubeLut(cubeText);
        expect(parsed.size).toBe(2);
        expect(parsed.title).toBe('Sample 3D LUT');
        expect(parsed.data.length).toBe(2 * 2 * 2 * 4);
    });
});

describe('OpenTimelineIO (OTIO 1.0) Interchange', () => {
    const testTimeline: VideoTimelineData = {
        title: 'Cyberpunk Feature Trailer',
        aspectRatio: '16:9',
        fps: 24,
        duration: 10.0,
        currentTime: 0,
        zoom: 50,
        tracks: [
            {
                id: 'v1',
                name: 'Main Video',
                type: 'video',
                visible: true,
                muted: false,
                locked: false,
                elements: [
                    {
                        id: 'c1',
                        name: 'Intro Drone Shot',
                        type: 'video',
                        startTime: 0,
                        duration: 6.0,
                        trimStart: 0,
                        trimEnd: 6.0,
                        blendMode: BlendMode.Normal,
                        opacity: 1.0
                    }
                ]
            },
            {
                id: 'a1',
                name: 'Dialogue Track',
                type: 'audio',
                visible: true,
                muted: false,
                locked: false,
                volume: 1.0,
                elements: [
                    {
                        id: 'c2',
                        name: 'Voiceover.wav',
                        type: 'audio',
                        startTime: 1.0,
                        duration: 5.0,
                        trimStart: 0,
                        trimEnd: 5.0,
                        volume: 0.95
                    }
                ]
            }
        ],
        mediaAssets: [
            { id: 'm1', name: 'Intro Drone Shot.mp4', type: 'video', duration: 10.0 }
        ]
    };

    it('serializes Scratchbox timeline into standard OTIO 1.0 JSON format', () => {
        const otio = exportToOtio(testTimeline);
        expect(otio.OTIO_SCHEMA).toBe('Timeline.1');
        expect(otio.name).toBe('Cyberpunk Feature Trailer');
        expect(otio.tracks.children.length).toBe(2);
        expect(otio.tracks.children[0].kind).toBe('Video');
        expect(otio.tracks.children[1].kind).toBe('Audio');
    });

    it('roundtrips OTIO serialization and deserialization cleanly', () => {
        const otio = exportToOtio(testTimeline);
        const restored = importFromOtio(otio);
        expect(restored.title).toBe(testTimeline.title);
        expect(restored.fps).toBe(testTimeline.fps);
        expect(restored.tracks?.length).toBe(2);
        expect(restored.tracks?.[0].elements.length).toBe(1);
        expect(restored.tracks?.[0].elements[0].name).toBe('Intro Drone Shot');
        expect(restored.tracks?.[1].elements[0].name).toBe('Voiceover.wav');
    });
});

describe('Compositor Shaders & GLSL Integrity', () => {
    it('contains valid GLSL shaders with expected uniforms and features', () => {
        expect(QUAD_VERT).toContain('varying vec2 vUv;');
        expect(QUAD_VERT).toContain('gl_Position');
        expect(COMPOSITOR_FRAG).toContain('uniform sampler2D uTexture;');
        expect(COMPOSITOR_FRAG).toContain('uniform vec3 uLift;');
        expect(COMPOSITOR_FRAG).toContain('uniform vec3 uGamma;');
        expect(COMPOSITOR_FRAG).toContain('uniform vec3 uGain;');
        expect(COMPOSITOR_FRAG).toContain('uniform float uVignette;');
        expect(COMPOSITOR_FRAG).toContain('uniform float uChromatic;');
        expect(COMPOSITOR_FRAG).toContain('uniform float uOldFilm;');
    });
});

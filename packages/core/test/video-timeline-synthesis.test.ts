/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { parseOrSynthesizeArtifact } from '../src/node/gemini/artifact-synthesis';
import {
    classifyFallbackPrompt,
    synthesizeVideoTimelineFallback
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import { synthesizeContextualVideoTimeline } from '../src/browser/generative-canvas/services/video/videoTimelineSynthesizer';
import { resolveModeForArtifact } from '../src/browser/generative-canvas/guardrails-service';
import type { VideoTimelineData } from '../src/browser/generative-canvas/services/video/videoTypes';

describe('Video NLE Multi-Track Timeline Synthesis and Dispatch', () => {
    const defaultRequest = {
        prompt: '',
        activeArtifact: undefined,
        chatHistory: [],
        sessionContext: {
            workspacePath: '/mock/workspace',
            activeFilePath: '/mock/workspace/project.sb',
            openFiles: [],
            projectType: 'generative'
        }
    };

    it('synthesizes a video-timeline primitive for "Split active clip at playhead and ripple delete downstream gap"', () => {
        const prompt = 'Split active clip at playhead and ripple delete downstream gap';
        const modelProse = 'I have adjusted the timeline and split the active clip at the playhead, ripple deleting the downstream gap.';
        
        const artifact = parseOrSynthesizeArtifact(
            prompt,
            modelProse,
            { ...defaultRequest, prompt },
            []
        );

        expect(artifact.type).toBe('video-timeline');
        expect(artifact.title).toContain('Video NLE');
        const data = artifact.data as VideoTimelineData;
        expect(data.tracks).toBeDefined();
        expect(data.tracks.length).toBeGreaterThanOrEqual(3);
        expect(data.currentTime).toBeDefined();
        expect(data.fps).toBe(30);
    });

    it('normalizes model JSON outputs with type "timeline", "video-editor", or "video_timeline" to "video-timeline"', () => {
        const jsonOutput = `\`\`\`json
{
  "type": "video-editor",
  "title": "Director Cut NLE",
  "summary": "Multi-track sequence",
  "data": {
    "fps": 24,
    "duration": 30,
    "currentTime": 5.0,
    "aspectRatio": "2.39:1",
    "tracks": []
  }
}
\`\`\``;

        const artifact = parseOrSynthesizeArtifact(
            'Create video timeline',
            jsonOutput,
            defaultRequest,
            []
        );

        expect(artifact.type).toBe('video-timeline');
        expect(artifact.title).toBe('Director Cut NLE');
        const data = artifact.data as VideoTimelineData;
        expect(data.aspectRatio).toBe('2.39:1');
    });

    it('performs split and ripple delete on active tracks via synthesizeContextualVideoTimeline', () => {
        const initialTimeline: VideoTimelineData = {
            title: 'Test Timeline',
            subtitle: 'Baseline',
            fps: 30,
            duration: 20,
            currentTime: 2.0,
            zoom: 50,
            aspectRatio: '16:9',
            isPlaying: false,
            activeTool: 'select',
            tracks: [
                {
                    id: 'v1-test',
                    name: 'V1 Video',
                    type: 'video',
                    visible: true,
                    muted: false,
                    locked: false,
                    elements: [
                        {
                            id: 'clip-1',
                            name: 'Shot 1',
                            trackId: 'v1-test',
                            type: 'video',
                            startTime: 0,
                            duration: 10.0,
                            trimStart: 0,
                            trimEnd: 0,
                            color: 'blue'
                        }
                    ]
                }
            ],
            mediaAssets: []
        };

        const result = synthesizeContextualVideoTimeline(
            'Split active clip at playhead and ripple delete downstream gap',
            'Split Test',
            initialTimeline
        );

        expect(result.tracks[0].elements.length).toBe(1);
        expect(result.tracks[0].elements[0].duration).toBe(2.0);
        expect(result.activeTool).toBe('cut');
    });

    it('accurately classifies fallback prompts for video timeline vs documents', () => {
        const timelineClassification = classifyFallbackPrompt(
            'Split active clip at playhead and ripple delete downstream gap',
            undefined,
            'chat',
            undefined
        );

        expect(timelineClassification.isVideoTimelineRequest).toBe(true);
        expect(timelineClassification.isSandboxRequest).toBe(false);
        expect(timelineClassification.isExplicitMedia).toBe(false);

        // Document request should not be flagged as video timeline
        const docClassification = classifyFallbackPrompt(
            'Write a research document on the evolution of non-linear editing systems',
            undefined,
            'chat',
            undefined
        );

        expect(docClassification.isVideoTimelineRequest).toBe(false);
        expect(docClassification.isDocumentRequest).toBe(true);
    });

    it('generates a valid Video NLE artifact via synthesizeVideoTimelineFallback', () => {
        const { artifact, toast } = synthesizeVideoTimelineFallback(
            'Cut clip at playhead and ripple delete gap',
            undefined
        );

        expect(artifact.type).toBe('video-timeline');
        expect(artifact.title).toContain('Video NLE');
        expect(toast?.text).toContain('Synthesized Video NLE');
        const data = artifact.data as VideoTimelineData;
        expect(data.tracks.length).toBeGreaterThanOrEqual(3);
    });

    it('resolves video-timeline to video layout mode', () => {
        expect(resolveModeForArtifact('video-timeline')).toBe('video');
        expect(resolveModeForArtifact('video')).toBe('video');
        expect(resolveModeForArtifact('timeline')).toBe('video');
    });
});

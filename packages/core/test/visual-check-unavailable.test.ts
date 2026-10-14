/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The background visual check is the vision model's audit or nothing.
 *
 * It used to call a hand-rolled us-central1 endpoint (Gemini 3.x is served only from `global`, so it 404'd), then
 * fall back to a heuristic that invented a fidelity score from scene metadata, labelled it as the vision model's,
 * defaulted a missing score to 85, and could auto-repair the scene with "emergency" lighting and reframing.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VisualVerificationService, type VisionModelClient } from '../src/node/visual-verification-service';
import { isVisualAuditUnavailable, type VisualVerificationRequest } from '../src/common/visual-verification-protocol';
import { runBackgroundVisualCheck } from '../src/browser/generative-canvas/hooks/useArtifactSync';
import { captureActiveCanvasScreenshot } from '../src/browser/generative-canvas/chat/streaming-utils';
import { MessageNotices, describeVisualCheck } from '../src/browser/generative-canvas/chat/MessageNotices';
import type { CanvasArtifact, ChatMessage, Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { decodePng } from '../src/node/texture-processing';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';
import { withReason } from './helpers/requirements';

const FRAME = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9Qz8DAwMTAwAAAEAEDAT4qV4QAAAAASUVORK5CYII=';
const SCENE: Scene3DData = { title: 'Brass telescope', objects: [], environment: { skybox: 'studio', lighting: 'studio', ground: false } };
const REQUEST: VisualVerificationRequest = { image: FRAME, prompt: 'A brass telescope on a tripod', artifactType: '3d-scene', context: { artifactId: 'art-1', title: 'Telescope', sceneData: SCENE } };

/** A GeminiClient stand-in whose genai client answers (or fails) like @google/genai's models.generateContent. */
function visionClient(generate: (req: any) => Promise<{ text?: string }>, calls: any[] = []): VisionModelClient {
    return {
        getGenAIClient: async () => ({
            models: { generateContent: async (req: any) => { calls.push(req); return generate(req); } }
        } as any)
    };
}

describe('VisualVerificationService.verifyVisual', () => {
    it('returns the vision model\'s own audit, sent through the shared client with the frame inline', async () => {
        const calls: any[] = [];
        const service = new VisualVerificationService(visionClient(async () => ({
            text: JSON.stringify({ pass: false, fidelityScore: 62, critique: 'Unlit model', issues: ['No key light'], strengths: [], defects3D: [] })
        }), calls));
        const audit = await service.verifyVisual(REQUEST);
        expect(isVisualAuditUnavailable(audit)).toBe(false);
        if (isVisualAuditUnavailable(audit)) return;
        expect(audit).toMatchObject({ status: 'verified', fidelityScore: 62, pass: false, critique: 'Unlit model', modelUsed: 'gemini-3.8-flash' });
        expect(calls).toHaveLength(1);
        expect(calls[0].model).toBe('gemini-3.8-flash');
        expect(calls[0].contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/png', data: FRAME.split(',')[1] });
        expect(calls[0].config.responseMimeType).toBe('application/json');
    });

    it('a failed call (404 from the endpoint) is unavailable: no score, no critique, no fixes', async () => {
        const service = new VisualVerificationService(visionClient(async () => {
            throw new Error('[404 Not Found] Publisher Model `projects/p/locations/us-central1/publishers/google/models/gemini-3.8-flash` was not found');
        }));
        const audit = await service.verifyVisual(REQUEST);
        expect(audit.status).toBe('unavailable');
        expect(audit).not.toHaveProperty('fidelityScore');
        expect(audit).not.toHaveProperty('pass');
        expect(audit).not.toHaveProperty('visualFixes');
        expect((audit as any).error).toContain('404');
    });

    it('a reply without a fidelityScore is unavailable (no default of 85)', async () => {
        const service = new VisualVerificationService(visionClient(async () => ({ text: JSON.stringify({ critique: 'Looks fine', issues: [] }) })));
        const audit = await service.verifyVisual(REQUEST);
        expect(audit).toMatchObject({ status: 'unavailable', error: expect.stringContaining('no fidelityScore') });
    });

    it('a reply that is not JSON, or no credentials, is unavailable', async () => {
        const prose = new VisualVerificationService(visionClient(async () => ({ text: 'The scene looks great!' })));
        expect((await prose.verifyVisual(REQUEST)).status).toBe('unavailable');
        const noCreds = new VisualVerificationService({ getGenAIClient: async () => undefined });
        expect(await noCreds.verifyVisual(REQUEST)).toMatchObject({ status: 'unavailable', error: expect.stringContaining('No Google Cloud service account or Gemini API key') });
    });

    it('suggests only the operators the model named for its defects', () => {
        const service = new VisualVerificationService(visionClient(async () => ({})));
        expect(service.mapDefectsToOperators([
            { defectType: 'unlit', severity: 'critical', description: 'dark' },
            { defectType: 'missing_pbr', severity: 'warning', description: 'flat', targetObjectId: 'hull' },
            { defectType: 'framing_offset', severity: 'info', description: 'off', suggestedOperator: 'sb_frame_bounds', suggestedParams: { paddingFactor: 1.2 } }
        ])).toEqual([{ operator: 'sb_frame_bounds', params: { paddingFactor: 1.2 } }]);
    });

    it('a multi-angle audit with no viewport capture is unavailable (no stand-in frame is audited)', async () => {
        const calls: any[] = [];
        const service = new VisualVerificationService(visionClient(async () => ({ text: JSON.stringify({ fidelityScore: 90 }) }), calls));
        const audit = await service.audit3DSceneMultiAngle({ sceneData: SCENE, prompt: 'telescope' });
        expect(audit).toMatchObject({ status: 'unavailable' });
        expect(calls).toHaveLength(0);
    });

    it('the 3D self-correction loop stops when the vision check is unavailable, dispatching nothing of its own', async () => {
        const service = new VisualVerificationService(visionClient(async () => { throw new Error('quota exceeded (429)'); }));
        const result = await service.run3DVisualSelfCorrectionLoop({ sceneData: SCENE, targetPrompt: 'telescope', captureAngleFrame: () => FRAME });
        expect(result.visionUnavailable?.error).toContain('429');
        expect(result.executedOperators).toEqual([]);
        expect(result.repaired).toBe(false);
        expect(result.initialFidelityScore).toBeUndefined();
    });

    it('the 3D loop with a failing audit and no suggested operators stops instead of adding emergency lighting', async () => {
        const service = new VisualVerificationService(visionClient(async () => ({ text: JSON.stringify({ fidelityScore: 40, critique: 'dim', issues: ['dark'], defects3D: [{ defectType: 'unlit', severity: 'critical', description: 'dark' }] }) })));
        const result = await service.run3DVisualSelfCorrectionLoop({ sceneData: SCENE, targetPrompt: 'telescope', captureAngleFrame: () => FRAME, angles: ['perspective'] });
        expect(result.finalFidelityScore).toBe(40);
        expect(result.executedOperators).toEqual([]);
        expect(result.iterations).toBe(1);
    });
});

describe('the background check in the chat', () => {
    const artifact: CanvasArtifact = { id: 'art-1', type: '3d-scene', title: 'Telescope', summary: '', version: 1, createdAt: 'now', data: SCENE };

    it('an unavailable check is recorded on the message and repairs nothing', async () => {
        const { outcome, repaired } = await runBackgroundVisualCheck(artifact, () => FRAME,
            async () => ({ status: 'unavailable', error: 'gemini-3.8-flash could not inspect the frame: 404' }), new Set());
        expect(outcome).toMatchObject({ status: 'unavailable' });
        expect(repaired).toBeNull();
        expect(describeVisualCheck(outcome).text).toBe('Visual check unavailable: gemini-3.8-flash could not inspect the frame: 404');
    });

    it('no captured frame means no check at all (the 1x1 placeholder is gone)', async () => {
        let asked = 0;
        const { outcome, repaired } = await runBackgroundVisualCheck(artifact, () => null, async () => { asked++; return { status: 'unavailable', error: 'x' }; }, new Set());
        expect(asked).toBe(0);
        expect(outcome).toMatchObject({ status: 'unavailable', error: 'No frame of the canvas could be captured.' });
        expect(repaired).toBeNull();
        expect(captureActiveCanvasScreenshot('3d')).toBeNull();
    });

    it('a transport error from the server is shown as the reason', async () => {
        const { outcome } = await runBackgroundVisualCheck(artifact, () => FRAME, async () => { throw new Error('Visual verification failed (500): boom'); }, new Set());
        expect(outcome).toMatchObject({ status: 'unavailable', error: 'Visual verification failed (500): boom' });
    });

    it('a verified audit is shown with its score and model', () => {
        expect(describeVisualCheck({ status: 'verified', pass: true, fidelityScore: 88, critique: 'Clean clay massing', issues: [], strengths: [], modelUsed: 'gemini-3.8-flash' }).text)
            .toBe('Visual check (gemini-3.8-flash): 88/100 — Clean clay massing');
    });

    it.skipIf(!htmlScreenshotChrome.ok)(withReason('renders "Visual check unavailable" on the message (screenshot)', htmlScreenshotChrome), async () => {
        const message: ChatMessage = {
            id: 'm1', sender: 'assistant', text: 'Built the telescope.', timestamp: '10:00',
            visualAudit: { status: 'unavailable', error: 'gemini-3.8-flash could not inspect the frame: 404 Publisher Model was not found' }
        };
        const html = renderToStaticMarkup(React.createElement(MessageNotices, { message }));
        expect(html).toContain('Visual check unavailable: gemini-3.8-flash could not inspect the frame');
        expect(html).not.toMatch(/\d+\/100/);
        const shot = await saveHtmlScreenshot('chat_visual_check_unavailable', `<div style="padding:16px;max-width:560px">${html}</div>`, { width: 600, height: 120, background: '#18181b' });
        const { data } = decodePng(shot.png);
        let grey = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 150 && Math.abs(data[i] - data[i + 2]) < 20) grey++;
        expect(grey).toBeGreaterThan(200);
    });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GoogleMediaGenerationService } from '../src/node/google-media-generation-service';
import { MediaAssetStore } from '../src/node/media-asset-store';
import { BeautifyStationService, createGoogleStationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { NativeAiRenderEngineService } from '../src/node/spatial/NativeAiRenderEngineService';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import type { RenderMesh3D } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';
import {
    buildBeautifyPrompt,
    buildClayRenderBeautifyPrompt,
    buildStationBeautifyPrompt
} from '../src/browser/generative-canvas/services/location-beautify-service';
import { buildBlockoutNanoBananaPrompt } from '../src/browser/generative-canvas/services/video/omniVideoPromptService';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

/**
 * The AI Beautify template is applied inside the generation step, not by a tool the model has to call first.
 * These tests stand a fake Google GenAI client at the network boundary (client.models.generateContent, the
 * one call the real service makes) and assert the exact prompt text each generation path sends it.
 */

/** A fake GenAI client: records every generateContent request and answers with the request's own first image. */
function fakeClient(sent: Array<{ model: string; text: string; images: number; aspectRatio?: string }>) {
    return {
        models: {
            async generateContent(req: any) {
                const parts: any[] = req.contents;
                const text = parts.filter(p => typeof p.text === 'string').map(p => p.text).join('\n');
                const images = parts.filter(p => p.inlineData);
                sent.push({ model: req.model, text, images: images.length, aspectRatio: req.config?.imageConfig?.aspectRatio });
                return { candidates: [{ content: { parts: [{ inlineData: images[0].inlineData }] }, finishReason: 'STOP' }] };
            }
        }
    };
}

/** A 10 m cube on a 200 m ground plane, as a RenderMesh3D (indexed triangles). */
function boxGroundMesh(): RenderMesh3D {
    const V: number[] = [], I: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
        const base = V.length / 3;
        V.push(...a, ...b, ...c, ...d);
        I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const [x0, y0, z0] = [-5, 0, -5], [x1, y1, z1] = [5, 20, 5];
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    const g = 100, N = 20, cell = (2 * g) / N;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const xa = -g + i * cell, xb = xa + cell, za = -g + j * cell, zb = za + cell;
        quad([xa, 0, zb], [xb, 0, zb], [xb, 0, za], [xa, 0, za]);
    }
    return { vertices: new Float32Array(V), indices: new Uint32Array(I) };
}

describe('the AI Beautify template is applied inside generation', () => {
    const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-beautify-template-'));
    const sent: Array<{ model: string; text: string; images: number; aspectRatio?: string }> = [];
    const assetStore = new MediaAssetStore();
    const mediaService = new GoogleMediaGenerationService(assetStore, async () => fakeClient(sent) as any);
    const generator = createGoogleStationImageGenerator({ mediaService, assetStore, workspaceRoot: WORK_DIR, fidelity: 'draft', modelPriority: ['fake-image-model'] });

    beforeAll(() => fs.ensureDirSync(WORK_DIR));
    afterAll(() => fs.removeSync(WORK_DIR));

    it('mesh render restyle (spatial_ai_render_scene path) sends exactly the clay-render template, naming no place', async () => {
        sent.length = 0;
        const mesh: RenderMesh3D = { vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
        const service = new NativeAiRenderEngineService({ generator, workspaceRoot: WORK_DIR });
        const result = await service.renderAiBeautyFrame({
            mesh,
            pose: { x: 0, y: 0, z: 5, targetX: 0, targetY: 0, targetZ: 0, up: [0, 1, 0], fov: 60 },
            prompt: 'a weathered bronze lantern',
            stylePreset: 'overcast noon',
            width: 64,
            height: 48
        });
        expect(result.modelUsed).toBe('fake-image-model');
        expect(sent).toHaveLength(1);
        expect(sent[0].images).toBe(1);
        expect(sent[0].aspectRatio).toBe('4:3');
        const expected = buildClayRenderBeautifyPrompt({ subject: 'a weathered bronze lantern', aspectRatio: '4:3', styleSuffix: ' Style: overcast noon.' });
        expect(sent[0].text).toBe(expected);
        expect(sent[0].text).toBe(
            'Transform this 3D clay rendering of a weathered bronze lantern into a photorealistic photograph. '
            + 'CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly 4:3 aspect ratio, matching the reference image canvas. '
            + '(2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. '
            + '(3) Every part of the subject must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. '
            + '(4) Do not invent or add objects or features that are not visible in the reference. '
            + 'Add realistic textures, materials, natural lighting, and fine detail to make this look like a real photograph taken from this exact vantage point. Style: overcast noon.'
        );
        expect(sent[0].text).not.toMatch(/real location|coordinates|facing \d|earth\.google/);
    });

    it('survey beautify (survey_beautify_station path) sends exactly the station-grounded buildBeautifyPrompt text', async () => {
        sent.length = 0;
        const anchor: GeodeticAnchor = { lat: -33.8568, lng: 151.2153, elevationMeters: 12, headingDeg: 0, formattedAddress: 'test' };
        const renderer = new SurveyStationRenderService();
        renderer.setMesh(boxGroundMesh());
        const station = renderer.enrichStations([stationFromLookAt(1, [0, 10, 45], [0, 10, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, anchor)], { isoDate: '2026-06-21T02:00:00Z' })[0];
        const svc = new BeautifyStationService(renderer, generator);
        const ctx = { locationName: 'Circular Quay test box', styleSuffix: ' Crisp winter morning.' };
        const out = await svc.beautify(station, ctx, { width: 320, height: 180, draft: true, maxRerolls: 0 });

        expect(sent).toHaveLength(1);
        expect(sent[0].images).toBe(1);
        expect(sent[0].aspectRatio).toBe('16:9');
        const expected = buildStationBeautifyPrompt(station, { ...ctx, aspectRatio: '16:9' });
        expect(sent[0].text).toBe(expected);
        expect(out.prompt).toBe(expected);
        // The station's facts are in the text the model received: its coordinates, heading and the framing rules.
        expect(sent[0].text).toContain(`camera at coordinates ${station.coordinatesWGS84.lat.toFixed(6)}, ${station.coordinatesWGS84.lng.toFixed(6)}`);
        expect(sent[0].text).toContain(`facing ${Math.round(station.yawDegrees)}°`);
        expect(sent[0].text).toContain('CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly 16:9 aspect ratio');
        expect(sent[0].text).toContain('Circular Quay test box');
        expect(sent[0].text.endsWith(' Crisp winter morning.')).toBe(true);
        // And it is the same text buildBeautifyPrompt gives for those facts: one template, not a copy.
        expect(buildBeautifyPrompt({
            locationName: ctx.locationName,
            coordinates: { lat: station.coordinatesWGS84.lat, lng: station.coordinatesWGS84.lng },
            heading: station.yawDegrees,
            pitch: station.pitchDegrees,
            aspectRatio: '16:9',
            distance: station.beautify?.standoffMeters,
            styleSuffix: ctx.styleSuffix,
            fovDegrees: station.fovDegrees,
            focalLengthMm: station.focalLengthMm,
            cameraHeightMeters: station.cameraHeightAboveGround,
            horizonRowFraction: station.beautify?.horizonRowFraction,
            solar: station.beautify?.solar ? { azimuthDegrees: station.beautify.solar.azimuthDegrees, elevationDegrees: station.beautify.solar.elevationDegrees } : undefined
        })).toBe(expected);
    });

    it('the blockout Nano Banana prompt with no coordinates is the same clay-render template', () => {
        expect(buildBlockoutNanoBananaPrompt({ locationName: 'a clay teapot', aspectRatio: '1:1', styleSuffix: ' Matte.' }))
            .toBe(buildClayRenderBeautifyPrompt({ subject: 'a clay teapot', aspectRatio: '1:1', styleSuffix: ' Matte.' }));
    });

    it('the template tools are no longer offered, but a saved script calling one still gets the template', async () => {
        const registry = createDefaultToolRegistry();
        const offered = new Set(registry.declarations().map(d => d.name));
        for (const name of ['build_beautify_prompt', 'build_neutral_performer_prompt', 'build_frame_motivated_performer_prompt']) {
            expect(offered.has(name), name).toBe(false);
            expect(registry.get(name)?.offeredByDefault, name).toBe(false);
            expect(registry.get(name)?.declaration.description, name).toMatch(/^DEPRECATED \(hidden since 2026-10-20; remove after one release\)/);
        }
        for (const kept of ['survey_beautify_station', 'spatial_ai_render_scene']) expect(offered.has(kept), kept).toBe(true);
        const outcome = await registry.dispatch('build_beautify_prompt', { locationName: 'Independence Hall', coords: '39.948900, -75.150000', heading: 180, aspectRatio: '16:9' }, {} as any);
        expect(outcome.exec.status).toBe('completed');
        expect((outcome.resultPayload as any).prompt).toBe(buildBeautifyPrompt({ locationName: 'Independence Hall', coords: '39.948900, -75.150000', heading: 180, aspectRatio: '16:9' }));
    });
});

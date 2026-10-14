/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport draws only what the scene data holds, and says so when it cannot.
 *
 * It used to substitute its own content: a made-up C++ "Procedural Biosphere" generator for every scene without a
 * Python one (which then failed to compile, silently), a blue sculpt sphere for empty scenes, an aircraft for titles
 * such as "Jet engine turbine", redcoat soldiers for "battlefield" titles over tiles, a 2D wireframe cube when WebGL
 * failed, San Francisco tiles when the scene had no anchor and a default geoid offset when the lookup failed.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import * as THREE from 'three';
import { renderToStaticMarkup } from 'react-dom/server';
import { Scene3DPrimitive, captureSceneScreenshot } from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import { classifySceneContent, hasNonFallbackObjectContent, syncSceneContent } from '../src/browser/generative-canvas/primitives/scene3d/syncSceneContent';
import { syncTilesLayer } from '../src/browser/generative-canvas/primitives/scene3d/syncTilesLayer';
import { generatorRunFailure, generatorRequestFailure } from '../src/browser/generative-canvas/primitives/scene3d/generatorRun';
import { ViewportNotice, resolveViewportNotice } from '../src/browser/generative-canvas/primitives/scene3d/ViewportNotice';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { decodePng } from '../src/node/texture-processing';
import { saveViewportSnapshot } from './helpers/scene3d-viewport-snapshot';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';
import { withReason } from './helpers/requirements';

const render = (data: Partial<Scene3DData>) => renderToStaticMarkup(React.createElement(Scene3DPrimitive, { data: data as Scene3DData }));
const noticeKinds = (html: string) => (html.match(/data-kind="([^"]+)"/g) || []).map(m => m.slice(11, -1));

/** Composes a scene's focal content the way the viewport does and lists every mesh it added on its own. */
function composedMeshes(data: Partial<Scene3DData>, has3DTiles = false): { scene: THREE.Scene; meshes: string[]; kind: string } {
    const scene = new THREE.Scene();
    const handle = syncSceneContent({ scene } as any, {
        hasActiveScript: false,
        has3DTiles,
        hasCustomMeshes: (data.customMeshes?.length ?? 0) > 0,
        hasNonFallbackObjects: hasNonFallbackObjectContent(data as Scene3DData),
        hasCppGenerator: !!data.cppGenerator?.sourceCode,
        hasPythonGenerator: !!data.pythonGenerator?.sourceCode
    }, {
        createSplatViewer: () => ({ group: new THREE.Group(), loadSplatObservation: () => {}, dispose: () => {} })
    });
    const meshes: string[] = [];
    scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o.name || o.type); });
    return { scene, meshes, kind: handle.kind };
}

describe('the viewport supplies no generator of its own', () => {
    it('an empty scene gets no C++ generator, and the viewport says "No geometry"', () => {
        const html = render({ title: 'Empty workspace' });
        expect(html).not.toContain('Procedural Biosphere');
        expect(noticeKinds(html)).toEqual(['empty']);
        expect(html).toContain('No geometry');
    });

    it('a tiles-only scene (geoAnchor, no generator) is not empty and gets no generator', () => {
        const html = render({ title: 'Ferry Building', geoAnchor: { lat: 37.7955, lng: -122.3937, active: true } as any });
        expect(noticeKinds(html)).toEqual([]);
        expect(html).not.toContain('Procedural Biosphere');
    });

    it('a scene with the model\'s own Python generator shows no notice', () => {
        const html = render({ title: 'Telescope', pythonGenerator: { sourceCode: 'import scratchbox as sb' } as any });
        expect(noticeKinds(html)).toEqual([]);
    });

    it('a splat scene keeps its splat file in the viewport state, so it is not called empty', () => {
        const html = render({ title: 'Capture', sceneType: 'gaussian_splat', splatUrl: '/models/capture.splat' });
        expect(noticeKinds(html)).toEqual([]);
    });
});

describe('no placeholder geometry is composed for any title', () => {
    for (const title of ['', 'Jet engine turbine', 'Supersonic aircraft flight corridor', 'Lexington battlefield 1775 redcoats']) {
        it(`"${title || '(untitled)'}" with no content draws nothing and is classified empty`, () => {
            const { meshes, kind } = composedMeshes({ title, sceneType: 'general' });
            expect(meshes).toEqual([]);
            expect(kind).toBe('empty');
        });
    }

    it('a battlefield title over live tiles adds no soldiers', () => {
        const { meshes, kind } = composedMeshes({ title: 'Lexington battlefield, revolutionary redcoats', sceneType: 'battlefield' }, true);
        expect(meshes).toEqual([]);
        expect(kind).toBe('tiles');
    });

    it('the empty scene graph renders no pixels (screenshot saved)', () => {
        const { scene } = composedMeshes({ title: 'Jet engine turbine' });
        const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 500);
        camera.position.set(15, 12, 15);
        camera.lookAt(0, 0, 0);
        const shot = saveViewportSnapshot('scene3d_viewport_empty_scene_draws_nothing', scene, camera);
        expect(shot.drawnPixels).toBe(0);
    });

    it('classifies declared content sources, never words', () => {
        const base = { hasActiveScript: false, has3DTiles: false, hasCustomMeshes: false, hasNonFallbackObjects: false };
        expect(classifySceneContent(base)).toBe('empty');
        expect(classifySceneContent({ ...base, hasPythonGenerator: true })).toBe('objects');
        expect(classifySceneContent({ ...base, hasCustomMeshes: true })).toBe('custom-meshes');
        expect(classifySceneContent({ ...base, has3DTiles: true })).toBe('tiles');
        expect(classifySceneContent({ ...base, hasActiveScript: true })).toBe('script');
    });
});

describe('content failures are shown in the viewport', () => {
    it('a failed Python run reports its stderr', () => {
        const failure = generatorRunFailure('python', 200, {
            success: false, exitCode: 1, stdout: '',
            stderr: 'Traceback (most recent call last):\n  File "scene.py", line 4\nNameError: name \'sb\' is not defined'
        });
        expect(failure).toEqual({ engine: 'python', message: expect.stringContaining("NameError: name 'sb' is not defined") });
        const notices = resolveViewportNotice({ webglError: null, generatorError: failure, tilesError: null, contentKind: 'objects' });
        expect(notices.map(n => n.kind)).toEqual(['generator-error']);
        expect(notices[0].detail).toContain('NameError');
    });

    it('a failed C++ compile reports the compiler output', () => {
        const failure = generatorRunFailure('cpp', 200, { success: false, compilerOutput: "world.cpp:7:20: error: no member named 'generate_sdf_terrain'" });
        expect(failure?.message).toContain("no member named 'generate_sdf_terrain'");
    });

    it('a run that succeeds without a model is a failure, and a model is not', () => {
        expect(generatorRunFailure('python', 200, { success: true, stdout: 'done' })?.message).toContain('wrote no model');
        expect(generatorRunFailure('python', 200, { success: true, glbBase64: 'Z2xURg==' })).toBeNull();
        expect(generatorRunFailure('cpp', 500, { error: 'clang++ not found' })?.message).toContain('clang++ not found');
        expect(generatorRunFailure('cpp', 502, null)?.message).toContain('HTTP 502');
        expect(generatorRequestFailure('python', new TypeError('Failed to fetch')).message).toContain('Failed to fetch');
    });

    it('a WebGL failure shows the error alone, with no stand-in drawing', () => {
        const notices = resolveViewportNotice({ webglError: 'The 3D viewport could not start WebGL: context lost', generatorError: null, tilesError: null, contentKind: 'empty' });
        expect(notices).toEqual([{ kind: 'webgl-error', title: '3D viewport unavailable', detail: 'The 3D viewport could not start WebGL: context lost' }]);
        const html = renderToStaticMarkup(React.createElement(ViewportNotice, { notices }));
        expect(html).toContain('context lost');
        expect(html).not.toContain('<canvas');
    });

    const failureNotices = () => resolveViewportNotice({
        webglError: null,
        generatorError: generatorRunFailure('python', 200, { success: false, stderr: 'RuntimeError: create_loft needs at least two profiles' }),
        tilesError: 'Google 3D Tiles are not shown: the geoid height at 37.79550, -122.39370 could not be looked up (HTTP 500), so tile heights are unknown.',
        contentKind: 'objects'
    });

    it('renders every failure notice with its detail', () => {
        const html = renderToStaticMarkup(React.createElement(ViewportNotice, { notices: failureNotices() }));
        expect(noticeKinds(html)).toEqual(['generator-error', 'tiles-error']);
        expect(html).toContain('create_loft needs at least two profiles');
        expect(html).toContain('could not be looked up (HTTP 500)');
    });

    it.skipIf(!htmlScreenshotChrome.ok)(withReason('screenshots the failure notices, the WebGL error and the empty-scene notice in headless Chrome', htmlScreenshotChrome), async () => {
        const errorsShot = await saveHtmlScreenshot('scene3d_viewport_failure_notices',
            renderToStaticMarkup(React.createElement(ViewportNotice, { notices: failureNotices() })));
        const emptyShot = await saveHtmlScreenshot('scene3d_viewport_no_geometry_notice',
            renderToStaticMarkup(React.createElement(ViewportNotice, { notices: resolveViewportNotice({ webglError: null, generatorError: null, tilesError: null, contentKind: 'empty' }) })));
        const webglShot = await saveHtmlScreenshot('scene3d_viewport_webgl_error',
            renderToStaticMarkup(React.createElement(ViewportNotice, { notices: resolveViewportNotice({ webglError: 'The 3D viewport could not start WebGL: context lost', generatorError: null, tilesError: null, contentKind: 'empty' }) })));
        // The error panels are dark red on the viewport grey; the empty notice is a neutral dark panel.
        const count = (png: Buffer, test: (r: number, g: number, b: number) => boolean) => {
            const { data } = decodePng(png);
            let n = 0;
            for (let i = 0; i < data.length; i += 4) if (test(data[i], data[i + 1], data[i + 2])) n++;
            return n;
        };
        expect(count(errorsShot.png, (r, g, b) => r > 50 && r < 120 && g < 40 && b < 40)).toBeGreaterThan(5000);
        // A WebGL failure is one error panel and nothing drawn in its place.
        expect(count(webglShot.png, (r, g, b) => r > 50 && r < 120 && g < 40 && b < 40)).toBeGreaterThan(2000);
        expect(count(emptyShot.png, (r, g, b) => r > 50 && r < 120 && g < 40 && b < 40)).toBe(0);
        expect(count(emptyShot.png, (r, g, b) => r < 100 && Math.abs(r - g) < 12 && Math.abs(g - b) < 12)).toBeGreaterThan(3000);
    });
});

describe('live 3D Tiles need the scene\'s anchor and a known geoid height', () => {
    const stack = () => ({ scene: new THREE.Scene() }) as any;
    const fakeLayer = () => ({ group: new THREE.Group(), getTerrainManager: () => ({ fake: true }), dispose: () => {} });

    it('without a geoAnchor no layer is created (no San Francisco default) and the error is reported', () => {
        const errors: string[] = [];
        let created = 0;
        const handle = syncTilesLayer(stack(), { has3DTiles: true, geoAnchor: null, renderMode: 'clay', groundTileMode: 'photoreal-clay' },
            { onError: m => errors.push(m) }, { createLayer: () => { created++; return fakeLayer(); } });
        expect(created).toBe(0);
        expect(handle.tilesLayer).toBeNull();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('geoAnchor');
    });

    it('a failed geoid lookup shows no tiles and reports why', async () => {
        const errors: string[] = [];
        let created = 0;
        syncTilesLayer(stack(), { has3DTiles: true, geoAnchor: { lat: 51.5055, lng: -0.0754 }, renderMode: 'clay', groundTileMode: 'photoreal-clay' },
            { onError: m => errors.push(m) },
            { createLayer: () => { created++; return fakeLayer(); }, fetchGeoidUndulation: async () => { throw new Error('HTTP 500'); } });
        await new Promise(r => setTimeout(r, 0));
        expect(created).toBe(0);
        expect(errors).toEqual([expect.stringContaining('HTTP 500')]);
        expect(errors[0]).toContain('51.50550, -0.07540');
    });

    it('places the layer at the anchor with the looked-up undulation', async () => {
        const options: any[] = [];
        const ready: any[] = [];
        const handle = syncTilesLayer(stack(), { has3DTiles: true, geoAnchor: { lat: 51.5055, lng: -0.0754, elevation: 12 }, renderMode: 'clay', groundTileMode: 'photoreal-clay' },
            { onLayerReady: layer => ready.push(layer), onError: m => { throw new Error(m); } },
            { createLayer: o => { options.push(o); return fakeLayer(); }, fetchGeoidUndulation: async () => 45.6 });
        await new Promise(r => setTimeout(r, 0));
        expect(options).toEqual([expect.objectContaining({ origin: { lat: 51.5055, lng: -0.0754, alt: 12 }, geoidHeight: 45.6, renderMode: 'clay' })]);
        expect(ready).toHaveLength(1);
        expect(handle.tilesLayer).toBe(ready[0]);
    });
});

describe('frame capture reports a missing frame instead of a 1x1 image', () => {
    it('returns null without a renderer, and the frame when there is one', () => {
        expect(captureSceneScreenshot(null, null, null)).toBeNull();
        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9Qz8DAwMTAwAAAEAEDAT4qV4QAAAAASUVORK5CYII=';
        expect(captureSceneScreenshot({ domElement: { toDataURL: () => png }, render: () => {} } as any, new THREE.Scene(), new THREE.PerspectiveCamera())).toBe(png);
        expect(captureSceneScreenshot({ domElement: { toDataURL: () => { throw new Error('tainted'); } } } as any)).toBeNull();
    });
});

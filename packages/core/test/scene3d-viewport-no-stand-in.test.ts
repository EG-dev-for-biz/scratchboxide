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
import { classifySceneContent, hasNonFallbackObjectContent, syncSceneContent, undrawableSceneObjects } from '../src/browser/generative-canvas/primitives/scene3d/syncSceneContent';
import { liveTilesAnchor, syncTilesLayer } from '../src/browser/generative-canvas/primitives/scene3d/syncTilesLayer';
import { TerrainManager } from '../src/browser/generative-canvas/services/TerrainManager';
import { groundDatumBadge, projectRoutePoint } from '../src/browser/generative-canvas/primitives/scene3d/geoAnchorLabels';
import { DEFAULT_METERS_PER_SCENE_UNIT } from '../src/common/coordinate/GeoFrame';
import { fromInput, generatorErrorForScene, generatorRunFailure, generatorRequestFailure } from '../src/browser/generative-canvas/primitives/scene3d/generatorRun';
import { ViewportNotice, resolveViewportNotice } from '../src/browser/generative-canvas/primitives/scene3d/ViewportNotice';
import { createRendererStack } from '../src/browser/generative-canvas/primitives/scene3d/createRendererStack';
import { VectorRoadmapHUD, copyTextToClipboard } from '../src/browser/generative-canvas/primitives/scene3d/VectorRoadmapHUD';
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

    it('when WebGL cannot start, createRendererStack throws instead of returning a stand-in 2D canvas', () => {
        // The viewport's catch around createRendererStack shows the WebGL error; it never ran while the stack drew
        // "3D Viewport Ready" on a 2D canvas and returned a renderer that did nothing.
        const appended: any[] = [];
        const drawn: string[] = [];
        const canvas = () => ({
            style: {},
            addEventListener() {},
            removeEventListener() {},
            setAttribute() {},
            getContext: (kind: string) => kind === '2d'
                ? { fillRect() {}, fillText: (t: string) => drawn.push(t), set fillStyle(_v: any) {}, set font(_v: any) {}, set textAlign(_v: any) {} }
                : null
        });
        const savedDocument = (globalThis as any).document;
        const savedWindow = (globalThis as any).window;
        (globalThis as any).document = { createElement: () => canvas(), createElementNS: () => canvas() };
        (globalThis as any).window = { devicePixelRatio: 1 };
        try {
            const container: any = { clientWidth: 400, clientHeight: 300, appendChild: (c: any) => appended.push(c), contains: () => false, removeChild() {} };
            expect(() => createRendererStack({ container })).toThrow(/WebGL/i);
            expect(appended).toEqual([]);
            expect(drawn).toEqual([]);
        } finally {
            (globalThis as any).document = savedDocument;
            (globalThis as any).window = savedWindow;
        }
    });

    it('a WebGL failure shows the error alone, with no stand-in drawing', () => {
        const notices = resolveViewportNotice({ webglError: 'The 3D viewport could not start WebGL: context lost', generatorError: null, tilesError: null, contentKind: 'empty' });
        expect(notices).toEqual([{ kind: 'webgl-error', title: '3D viewport unavailable', detail: 'The 3D viewport could not start WebGL: context lost' }]);
        const html = renderToStaticMarkup(React.createElement(ViewportNotice, { notices }));
        expect(html).toContain('context lost');
        expect(html).not.toContain('<canvas');
    });

    it('a build failure stays only while the scene still holds that source and no model for it', () => {
        const SRC = 'import scratchbox as sb\nsb.broken()';
        const err = fromInput(generatorRunFailure('python', 200, { success: false, stderr: "NameError: name 'x' is not defined" })!, 'source', SRC);
        // Still the failing version: shown.
        expect(generatorErrorForScene(err, { pythonGenerator: { sourceCode: SRC } })).toBe(err);
        // The follow-up fixed the script and brought its model, the same source now has a model, or the generator is gone.
        expect(generatorErrorForScene(err, { pythonGenerator: { sourceCode: 'import scratchbox as sb\nsb.fixed()', glbBase64: 'Z2xURg==' } })).toBeNull();
        expect(generatorErrorForScene(err, { pythonGenerator: { sourceCode: SRC, glbBase64: 'Z2xURg==' } })).toBeNull();
        expect(generatorErrorForScene(err, {})).toBeNull();
    });

    it('an unreadable model error stays only while the scene still holds that model', () => {
        const err = fromInput({ engine: 'python', message: 'The generated model (GLB) could not be read: bad magic' }, 'glb', 'AAAA');
        expect(generatorErrorForScene(err, { pythonGenerator: { glbBase64: 'AAAA' } })).toBe(err);
        expect(generatorErrorForScene(err, { pythonGenerator: { glbBase64: 'Z2xURg==' } })).toBeNull();
    });

    it('the viewport keeps no old "Model build failed" panel over a later version that has its model', () => {
        // Same artifact, same component: v1 failed to build, v2 arrives with a model. The panel is derived from v2.
        const err = fromInput(generatorRunFailure('python', 200, { success: false, stderr: 'NameError' })!, 'source', 'v1');
        const v2 = { pythonGenerator: { sourceCode: 'v2', glbBase64: 'Z2xURg==' } };
        const notices = resolveViewportNotice({ webglError: null, generatorError: generatorErrorForScene(err, v2), tilesError: null, contentKind: 'objects' });
        expect(notices).toEqual([]);
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

describe('objects the viewport cannot draw or load are named in the viewport', () => {
    const plane = { id: 'aircraft', content: { type: '3d-scene', durableUri: 'internal:plane', mimeType: 'model/procedural-aircraft' } };
    const photo = { id: 'photo', content: { type: 'image', durableUri: 'https://example.com/photo.jpg', mimeType: 'image/jpeg' } };
    const real = { id: 'a', content: { type: '3d-model', durableUri: '/models/a.glb', mimeType: 'model/gltf-binary' } };

    it('an object the loader skips is not content, and the viewport says which and why', () => {
        expect(hasNonFallbackObjectContent({ objects: [plane, photo] as any })).toBe(false);
        expect(undrawableSceneObjects({ objects: [plane, photo, real] as any })).toEqual([
            { id: 'aircraft', reason: 'internal:plane is not a .glb, .gltf, .splat or .spz file' },
            { id: 'photo', reason: 'https://example.com/photo.jpg is not a .glb, .gltf, .splat or .spz file' }
        ]);
        // Alone: the viewport used to show neither "No geometry" nor an error.
        const html = render({ title: 'Jet', objects: [plane] as any });
        expect(noticeKinds(html)).toEqual(['undrawable-objects']);
        expect(html).toContain('aircraft: internal:plane is not a .glb, .gltf, .splat or .spz file');
        // Beside a drawable model: the model is drawn and the skipped object is still named.
        expect(noticeKinds(render({ title: 'Jet', objects: [real, photo] as any }))).toEqual(['undrawable-objects']);
        // A placeholder or a map-3d object is not reported as undrawable.
        expect(undrawableSceneObjects({ objects: [{ id: 'p', content: { type: '3d-model', durableUri: 'internal:mesh' } }, { id: 'm', content: { type: 'map-3d' } }] as any })).toEqual([]);
    });

    it('a model that fails to load is shown in the viewport, not only in the console', () => {
        const notices = resolveViewportNotice({ webglError: null, generatorError: null, tilesError: null, contentKind: 'objects', objectLoadErrors: [{ id: 'hero', error: 'HTTP 404: /models/hero.glb' }] });
        expect(notices).toEqual([{ kind: 'object-load-error', title: 'A model failed to load', detail: 'hero: HTTP 404: /models/hero.glb' }]);
    });

    it('biome terrain the scene draws is not covered by "No geometry"; in clay (no biomes drawn) the scene is empty', () => {
        const biomes = { title: 'Valley', features: { terrainBiomes: { biomeType: 'alpine' } } } as any;
        expect(noticeKinds(render({ ...biomes, renderMode: 'pbr' }))).toEqual([]);
        expect(noticeKinds(render({ ...biomes, renderMode: 'clay' }))).toEqual(['empty']);
    });

    it.skipIf(!htmlScreenshotChrome.ok)(withReason('screenshots the load-failure and undrawable-object notices', htmlScreenshotChrome), async () => {
        const notices = resolveViewportNotice({
            webglError: null, generatorError: null, tilesError: null, contentKind: 'objects',
            objectLoadErrors: [{ id: 'hero', error: 'HTTP 404: /models/hero.glb' }],
            undrawableObjects: undrawableSceneObjects({ objects: [plane, photo] as any })
        });
        const html = renderToStaticMarkup(React.createElement(ViewportNotice, { notices }));
        expect(noticeKinds(html)).toEqual(['object-load-error', 'undrawable-objects']);
        const shot = await saveHtmlScreenshot('scene3d_viewport_object_notices', html);
        const { data } = decodePng(shot.png);
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 50 && data[i] < 120 && data[i + 1] < 40 && data[i + 2] < 40) red++;
        expect(red).toBeGreaterThan(5000);
    });
});

describe('live 3D Tiles need the scene\'s anchor and a known geoid height', () => {
    const stack = () => ({ scene: new THREE.Scene() }) as any;
    const fakeLayer = () => ({ group: new THREE.Group(), getTerrainManager: () => ({ fake: true }), dispose: () => {} });
    // A made-up key: no layer here fetches anything (a window with no key is live-tiles-failure-reporting.test.ts).
    const mapsApiKey = () => 'test-maps-key-not-real';

    it('without a geoAnchor no layer is created (no San Francisco default) and the error is reported', () => {
        const errors: string[] = [];
        let created = 0;
        const handle = syncTilesLayer(stack(), { has3DTiles: true, geoAnchor: null, renderMode: 'clay', groundTileMode: 'photoreal-clay' },
            { onError: m => errors.push(m) }, { mapsApiKey, createLayer: () => { created++; return fakeLayer(); } });
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
            { mapsApiKey, createLayer: () => { created++; return fakeLayer(); }, fetchGeoidUndulation: async () => { throw new Error('HTTP 500'); } });
        await new Promise(r => setTimeout(r, 0));
        expect(created).toBe(0);
        expect(errors).toEqual([expect.stringContaining('HTTP 500')]);
        expect(errors[0]).toContain('51.50550, -0.07540');
    });

    it('rejects a 0, 0 anchor and non-numeric coordinates, each with its own reason', () => {
        for (const [geoAnchor, reason] of [
            [{ lat: 0, lng: 0 }, '0, 0'],
            [{ lat: 'forty', lng: '-73.98' }, 'not numbers'],
            [{ lat: 95, lng: 10 }, 'outside the valid']
        ] as const) {
            const errors: string[] = [];
            let created = 0;
            syncTilesLayer(stack(), { has3DTiles: true, geoAnchor: geoAnchor as any, renderMode: 'clay', groundTileMode: 'photoreal-clay' },
                { onError: m => errors.push(m) }, { mapsApiKey, createLayer: () => { created++; return fakeLayer(); }, fetchGeoidUndulation: async () => 0 });
            expect(created).toBe(0);
            expect(errors).toEqual([expect.stringContaining(reason)]);
            expect(errors[0]).not.toContain('has none');
        }
    });

    it('reads numeric-string coordinates as the numbers they are', async () => {
        const options: any[] = [];
        syncTilesLayer(stack(), { has3DTiles: true, geoAnchor: { lat: '40.7484', lng: '-73.9857', elevation: '10' }, renderMode: 'clay', groundTileMode: 'photoreal-clay' },
            { onError: m => { throw new Error(m); } }, { mapsApiKey, createLayer: o => { options.push(o); return fakeLayer(); }, fetchGeoidUndulation: async () => -32.5 });
        await new Promise(r => setTimeout(r, 0));
        expect(options[0].origin).toEqual({ lat: 40.7484, lng: -73.9857, alt: 10 });
    });

    it('with no elevation, assumes none: it measures the ground on the loaded tiles and re-places the layer there', async () => {
        // Denver: ground about 1609 m above sea level. Starting at sea level, the ground first samples 1609 m up.
        let groundY = 1609.3;
        const origins: any[] = [];
        const layer: any = {
            ...fakeLayer(),
            sampleGroundHeight: () => groundY,
            updateOrigin: (o: any, geoid: number) => { origins.push({ ...o, geoid }); groundY -= o.alt - (origins.length > 1 ? origins[origins.length - 2].alt : 0); }
        };
        const options: any[] = [];
        syncTilesLayer(stack(), { has3DTiles: true, geoAnchor: { lat: 39.7392, lng: -104.9903 }, renderMode: 'clay', groundTileMode: 'photoreal-clay' },
            { onError: m => { throw new Error(m); } }, { mapsApiKey, createLayer: o => { options.push(o); return layer; }, fetchGeoidUndulation: async () => -16.9 });
        await new Promise(r => setTimeout(r, 0));
        expect(options[0].origin.alt).toBe(0);
        layer.onTileLoaded();
        expect(origins).toEqual([{ lat: 39.7392, lng: -104.9903, alt: 1609.3, geoid: -16.9 }]);
        // Once the ground is at y = 0 (within tolerance) nothing more is moved.
        layer.onTileLoaded();
        expect(origins).toHaveLength(1);
    });

    it('finds ground far above sea level (La Paz, ~3600 m) on real tiles geometry, which the 2000 m probe missed', async () => {
        // The layer starts at sea level; its loaded ground sits 3600 m up. A real TerrainManager raycasts it.
        const scene = new THREE.Scene();
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
        ground.position.y = 3600;
        ground.updateMatrixWorld(true);
        scene.add(ground);
        const terrain = new TerrainManager({ scene });
        expect(terrain.sampleGroundHeight(0, 0)).toBeNull();
        const origins: any[] = [];
        const errors: string[] = [];
        const layer: any = { ...fakeLayer(), getTerrainManager: () => terrain, updateOrigin: (o: any) => { origins.push({ ...o }); ground.position.y = 0; ground.updateMatrixWorld(true); } };
        syncTilesLayer({ scene } as any, { has3DTiles: true, geoAnchor: { lat: -16.5, lng: -68.15, geoidUndulationMeters: 44 }, renderMode: 'clay', groundTileMode: 'photoreal-clay' },
            { onError: m => errors.push(m) }, { mapsApiKey, createLayer: () => layer });
        layer.onTileLoaded();
        expect(origins).toHaveLength(1);
        expect(origins[0].alt).toBeCloseTo(3600, 3);
        expect(errors).toEqual([]);
    });

    it('when no ground is found under the anchor, the sea-level placement is reported once, and cleared when ground appears', () => {
        const errors: string[] = [];
        let recovered = 0;
        let groundY: number | null = null;
        const layer: any = { ...fakeLayer(), getTerrainManager: () => ({ sampleGroundHeight: () => groundY }), updateOrigin: () => { groundY = 0; } };
        syncTilesLayer(stack(), { has3DTiles: true, geoAnchor: { lat: -16.5, lng: -68.15, geoidUndulationMeters: 44 }, renderMode: 'clay', groundTileMode: 'photoreal-clay' },
            { onError: m => errors.push(m), onRecovered: () => recovered++ }, { mapsApiKey, createLayer: () => layer });
        for (let i = 0; i < 31; i++) layer.onTileLoaded();
        expect(errors).toEqual([]);
        for (let i = 0; i < 10; i++) layer.onTileLoaded();
        expect(errors).toEqual(['Google 3D Tiles are placed at sea level: the scene\'s geoAnchor has no elevation and no ground was found under -16.50000, -68.15000 on the loaded tiles, so they may sit above or below the camera.']);
        groundY = 3600;
        layer.onTileLoaded();
        expect(recovered).toBe(1);
    });

    it('takes the anchor from a map-3d object when the scene has none, with its known geoid height', () => {
        expect(liveTilesAnchor({ objects: [{ id: 'm', content: { type: 'map-3d', durableUri: 'x', mimeType: 'x' }, space: { geoAnchor: { lat: 37.7955, lng: -122.3937, alt: 4 } } } as any] }))
            .toEqual({ lat: 37.7955, lng: -122.3937, elevation: 4 });
        expect(liveTilesAnchor({ geoAnchor: { lat: 51.5, lng: -0.07, elevation: 12, geoidUndulationMeters: 45.6, active: true } }))
            .toEqual({ lat: 51.5, lng: -0.07, elevation: 12, geoidUndulationMeters: 45.6 });
        expect(liveTilesAnchor({ geoAnchor: { lat: 51.5, lng: -0.07, active: false } })).toBeNull();
    });

    it('a scene whose anchor is set to draw no tiles is empty and says so', () => {
        const html = render({ title: 'Ferry Building', geoAnchor: { lat: 37.7955, lng: -122.3937, active: true }, groundTileMode: 'none' } as any);
        expect(noticeKinds(html)).toEqual(['empty']);
    });

    it('places the layer at the anchor with the looked-up undulation', async () => {
        const options: any[] = [];
        const ready: any[] = [];
        const handle = syncTilesLayer(stack(), { has3DTiles: true, geoAnchor: { lat: 51.5055, lng: -0.0754, elevation: 12 }, renderMode: 'clay', groundTileMode: 'photoreal-clay' },
            { onLayerReady: layer => ready.push(layer), onError: m => { throw new Error(m); } },
            { mapsApiKey, createLayer: o => { options.push(o); return fakeLayer(); }, fetchGeoidUndulation: async () => 45.6 });
        await new Promise(r => setTimeout(r, 0));
        // the layer is given the window's key, so it never resolves (or misses) one of its own
        expect(options).toEqual([expect.objectContaining({ apiKey: 'test-maps-key-not-real', origin: { lat: 51.5055, lng: -0.0754, alt: 12 }, geoidHeight: 45.6, renderMode: 'clay' })]);
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

describe('the viewport uses the scene\'s own anchor and route, with no default place or elevation', () => {
    it('a route pin is placed by its offset from the scene\'s anchor, and not at all without coordinates', () => {
        // San Francisco (37.79, -122.40) and 15.2 m used to stand in for a missing anchor, pin or elevation.
        expect(projectRoutePoint({ lat: '', lng: '' }, { lat: 37.792, lng: -122.405 })).toBeNull();
        expect(projectRoutePoint({ lat: 51.5007, lng: -0.1246 }, { lat: '', lng: '' })).toBeNull();
        expect(projectRoutePoint({ lat: 51.5007, lng: -0.1246 }, { lat: 'abc', lng: -0.12 })).toBeNull();
        expect(projectRoutePoint({ lat: 51.5007, lng: -0.1246 }, { lat: 120, lng: -0.12 })).toBeNull();
        const origin = projectRoutePoint({ lat: 51.5007, lng: -0.1246 }, { lat: 51.5007, lng: -0.1246 })!;
        expect(Math.abs(origin.x)).toBeLessThan(1e-6);
        expect(Math.abs(origin.z)).toBeLessThan(1e-6);
        // 10 m east is +x in scene units (GeoFrame's default scale, ~2.18 m per unit); numeric strings as saved scenes hold them.
        const east = projectRoutePoint({ lat: '51.5007', lng: '-0.1246' }, { lat: 51.5007, lng: -0.1246 + 10 / (111320 * Math.cos(51.5007 * Math.PI / 180)) })!;
        expect(east.x).toBeCloseTo(10 / DEFAULT_METERS_PER_SCENE_UNIT, 1);
        expect(Math.abs(east.z)).toBeLessThan(0.05);
    });

    it('the ground-datum badge states only the source and datum the anchor records', () => {
        const bare = groundDatumBadge({ lat: 39.7392, lng: -104.9903, elevation: 1609.3 })!;
        expect(bare.text).toBe('1609.3 m');
        expect(bare.title).toContain('source: not recorded, vertical datum: not recorded');
        expect(bare.title).not.toMatch(/Google Elevation API|EGM96|MSL/);
        const recorded = groundDatumBadge({ lat: '39.7392', lng: '-104.9903', elevation: '1609.3', elevationSource: 'google_elevation', datum: 'MSL_EGM96', landmarkName: 'Denver' })!;
        expect(recorded.text).toBe('1609.3 m MSL_EGM96');
        expect(recorded.title).toBe('Ground datum: Denver (39.7392°, -104.9903°) · ground elevation 1609.3 m [source: google_elevation, vertical datum: MSL_EGM96]');
        expect(groundDatumBadge({ lat: 39.7, lng: -104.9 })).toBeNull();
    });

    it('a scene with an anchor but no elevation shows no elevation badge', () => {
        const html = render({ title: 'Denver', geoAnchor: { lat: 39.7392, lng: -104.9903, active: true } as any });
        expect(html).not.toContain('sb-ground-datum-badge');
        expect(html).not.toContain('15.2');
        const withElevation = render({ title: 'Denver', geoAnchor: { lat: 39.7392, lng: -104.9903, elevation: 1609.3, active: true } as any });
        expect(withElevation).toContain('data-testid="sb-ground-datum-badge"');
        expect(withElevation).toContain('source: not recorded');
        expect(withElevation).not.toContain('Google Elevation API');
    });

    it('the roadmap HUD shows no map or coordinates without the scene\'s anchor, and a failed copy is not called copied', async () => {
        const hud = (geoAnchor: any) => renderToStaticMarkup(React.createElement(VectorRoadmapHUD, { geoAnchor, isOpen: true, onToggleOpen: () => {}, onUpdateConfig: () => {} }));
        const none = hud(null);
        expect(none).toContain('data-testid="sb-roadmap-no-anchor"');
        expect(none).not.toContain('37.7955');
        expect(none).not.toContain('-122.3937');
        expect(none).not.toContain('<img');
        const denver = hud({ lat: 39.7392, lng: -104.9903, elevation: 1609.3 });
        expect(denver).toContain('39.7392°, -104.9903°');
        expect(denver).toContain('source not recorded');
        expect(denver).not.toContain('Authoritative Google');
        expect(await copyTextToClipboard('x', { writeText: async () => { throw new Error('Document is not focused.'); } })).toEqual({ ok: false, error: 'Document is not focused.' });
        expect(await copyTextToClipboard('x', undefined)).toEqual({ ok: false, error: 'the clipboard is not available here' });
        expect(await copyTextToClipboard('x', { writeText: async () => undefined })).toEqual({ ok: true });
    });

    it('a workspace placeholder object does not hide the real objects beside it', () => {
        const placeholder = { id: 'p', content: { type: '3d-model', durableUri: 'internal:mesh', mimeType: 'model/gltf-binary' } };
        const real = { id: 'a', content: { type: '3d-model', durableUri: '/models/a.glb', mimeType: 'model/gltf-binary' } };
        expect(hasNonFallbackObjectContent({ objects: [placeholder, real] as any })).toBe(true);
        expect(hasNonFallbackObjectContent({ objects: [placeholder] as any })).toBe(false);
        expect(noticeKinds(render({ title: 'Opened file', objects: [placeholder, real] as any }))).toEqual([]);
        expect(noticeKinds(render({ title: 'Opened file', objects: [placeholder] as any }))).toEqual(['empty']);
    });
});

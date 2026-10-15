/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport and the mount tool agree on what a scene draws.
 *
 * - Every new "4D Scene" from the sidebar opened with a red "2 objects cannot be drawn" panel: the sidebar seeded it
 *   with `internal:grid` and `internal:sunlight` objects that draw nothing.
 * - A mount whose live tiles anchor was 0, 0 or not numbers reported success while the tiles layer refused it.
 * - A model URI with a #fragment counted as drawable for the mount and the notices, but the loader skipped it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';
import * as THREE from 'three';
import { renderToStaticMarkup } from 'react-dom/server';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { newEmptySceneArtifact } from '../src/browser/generative-canvas/hooks/useWorkspaceFiles';
import { Scene3DPrimitive } from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import * as SceneContent from '../src/browser/generative-canvas/primitives/scene3d/syncSceneContent';
import { syncTilesLayer } from '../src/browser/generative-canvas/primitives/scene3d/syncTilesLayer';
import { ViewportNotice, resolveViewportNotice } from '../src/browser/generative-canvas/primitives/scene3d/ViewportNotice';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { decodePng } from '../src/node/texture-processing';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';
import { withReason } from './helpers/requirements';

const { undrawableSceneObjects, isDrawableSceneObject } = SceneContent;
const renderScene = (data: Partial<Scene3DData>) => renderToStaticMarkup(React.createElement(Scene3DPrimitive, { data: data as Scene3DData }));
const noticeKinds = (html: string) => (html.match(/data-kind="([^"]+)"/g) || []).map(m => m.slice(11, -1));
const mount = (args: Record<string, unknown>) => canvasHandlers.mount_canvas_primitive(args, { request: { prompt: '', chatHistory: [] } } as any) as Promise<any>;

describe('a new 4D Scene opens empty, with nothing to report', () => {
    const grid = { id: 'obj-grid-1', content: { type: '3d-scene', durableUri: 'internal:grid', mimeType: 'model/gltf-binary' } };
    const light = { id: 'obj-light-1', content: { type: '3d-scene', durableUri: 'internal:sunlight', mimeType: 'model/gltf-binary' } };

    it('the sidebar\'s new scene holds no objects and a neutral studio, and the viewport says "No geometry"', () => {
        const artifact = newEmptySceneArtifact(1_700_000_000_000);
        const data = artifact.data as Scene3DData;
        expect(artifact.type).toBe('3d-scene');
        expect(data.objects).toEqual([]);
        expect(data.environment).toEqual({ skybox: 'studio', lighting: 'studio', ground: false });
        // No description of wave solvers or a WASM heap the scene does not have.
        expect(artifact.summary).toBe('');
        expect(noticeKinds(renderScene(data))).toEqual(['empty']);
    });

    it('a scene saved with the old internal:grid / internal:sunlight seeds shows "No geometry", not a failure', () => {
        expect(undrawableSceneObjects({ objects: [grid, light] as any })).toEqual([]);
        expect(noticeKinds(renderScene({ title: 'Interactive 4D Scene Workspace', objects: [grid, light] as any }))).toEqual(['empty']);
        // An object the model sent that the loader cannot read is still named.
        const plane = { id: 'aircraft', content: { type: '3d-scene', durableUri: 'internal:plane' } };
        expect(undrawableSceneObjects({ objects: [grid, light, plane] as any })).toEqual([
            { id: 'aircraft', reason: 'internal:plane is not a .glb, .gltf, .splat or .spz file' }
        ]);
    });

    it.skipIf(!htmlScreenshotChrome.ok)(withReason('screenshots the new scene\'s viewport notice', htmlScreenshotChrome), async () => {
        const notices = resolveViewportNotice({
            webglError: null, generatorError: null, tilesError: null, contentKind: 'empty',
            undrawableObjects: undrawableSceneObjects({ objects: [grid, light] as any })
        });
        expect(notices.map(n => n.kind)).toEqual(['empty']);
        const shot = await saveHtmlScreenshot('new_4d_scene_viewport_notice', renderToStaticMarkup(React.createElement(ViewportNotice, { notices })));
        const { data } = decodePng(shot.png);
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 50 && data[i] < 120 && data[i + 1] < 40 && data[i + 2] < 40) red++;
        expect(red).toBe(0);
    });
});

describe('the object loader reads a URI the way the drawability checks do', () => {
    it('a query or #fragment after the extension is read the same by the loader and the checks', () => {
        const drawableModelKind = (SceneContent as Record<string, any>).drawableModelKind;
        expect(typeof drawableModelKind).toBe('function');
        expect(drawableModelKind('/models/hero.glb#v2')).toBe('gltf');
        expect(drawableModelKind('/models/hero.gltf?v=2')).toBe('gltf');
        expect(drawableModelKind('/splats/room.spz#a')).toBe('splat');
        expect(drawableModelKind('/api/file/abc', 'gaussian-splat')).toBe('splat');
        expect(drawableModelKind('internal:plane')).toBeNull();
        expect(isDrawableSceneObject({ id: 'h', content: { type: '3d-model', durableUri: '/models/hero.glb#v2' } } as any)).toBe(true);

        // The loader asks the same function instead of its own extension patterns (which had no #).
        const loaderSource = fs.readFileSync(path.resolve(__dirname, '../src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx'), 'utf-8');
        expect(loaderSource).toContain('drawableModelKind(uri, obj.content?.type)');
        expect(loaderSource).not.toMatch(/uri\.match\(\/\\\.\((glb\|gltf|splat\|spz)\)/);
    });
});

describe('the mount judges a live tiles anchor as the tiles layer does', () => {
    const tilesError = (anchor: any): string => {
        let message = '';
        syncTilesLayer({ scene: new THREE.Scene() } as any, { has3DTiles: true, geoAnchor: anchor, renderMode: 'clay' }, { onError: m => { message = m; } });
        return message;
    };
    const cases: Array<[string, any]> = [
        ['an unset 0, 0 anchor', { lat: 0, lng: 0 }],
        ['non-numeric coordinates', { lat: 'abc', lng: 999 }],
        ['an out-of-range latitude', { lat: 95, lng: 10 }]
    ];

    for (const [label, anchor] of cases) {
        it(`${label} fails the mount with the reason the tiles layer gives, as a scene anchor or a map-3d object's`, async () => {
            const layerSays = tilesError(anchor);
            expect(layerSays).toMatch(/^Live 3D Tiles are not shown: /);
            const reason = layerSays.replace(/^Live 3D Tiles are not shown: /, '').replace(/\.$/, '');

            const asSceneAnchor = await mount({ primitiveType: '3d-scene', title: 'Place', payload: { geoAnchor: { ...anchor, active: true } } });
            expect(asSceneAnchor.status).toBe('failed');
            expect(asSceneAnchor.resultPayload.error).toContain(reason);

            const asMapObject = await mount({ primitiveType: '3d-scene', title: 'Place', payload: { objects: [{ id: 'map', content: { type: 'map-3d' }, space: { geoAnchor: { lat: anchor.lat, lng: anchor.lng } } }] } });
            expect(asMapObject.status).toBe('failed');
            expect(asMapObject.resultPayload.error).toContain(reason);

            // A drawable model beside it does not make the refused tiles a success.
            const withModel = await mount({ primitiveType: '3d-scene', title: 'Place', payload: { geoAnchor: anchor, objects: [{ id: 'a', content: { type: '3d-model', durableUri: '/models/a.glb' } }] } });
            expect(withModel.status).toBe('failed');
        });
    }

    it('a real anchor mounts, as a scene anchor and as a map-3d object\'s', async () => {
        const flatiron = { lat: 40.7411, lng: -73.9897 };
        expect(tilesError(flatiron)).toBe('');
        const asSceneAnchor = await mount({ primitiveType: '3d-scene', title: 'Flatiron', payload: { geoAnchor: { ...flatiron, active: true } } });
        expect(asSceneAnchor.resultPayload.status).toBe('success');
        const asMapObject = await mount({ primitiveType: '3d-scene', title: 'Flatiron', payload: { objects: [{ id: 'map', content: { type: 'map-3d' }, space: { geoAnchor: flatiron } }] } });
        expect(asMapObject.resultPayload.status).toBe('success');
    });
});

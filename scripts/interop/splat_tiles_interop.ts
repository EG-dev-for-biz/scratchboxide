/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Third-party interoperability check for Scratchbox splat tilesets.
 *
 * Loads a tileset produced by Splat3DTilesService through the independent stack
 * 3d-tiles-renderer + 3d-tiles-rendererjs-3dgs-plugin + gaussian-splat-lite (none of our
 * decoders are involved). If the KHR_gaussian_splatting / SPZ v2 payload is not spec-exact,
 * this page renders nothing.
 *
 * Bundled by scripts/interop/build.sh into public/js/splat_tiles_interop.js and loaded by
 * public/splat_tiles_interop.html. Query params:
 *   tileset=<url>        default /tilesets/pantheon/tileset.json
 *   eye=<m>              camera height (default from tileset.meta.json, else 1.7)
 *   walk=x,z             camera offset in metres
 */

import { Scene, PerspectiveCamera, WebGLRenderer, Vector2, Color, Matrix4 } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GaussianSplatRenderer } from 'gaussian-splat-lite';
import { GaussianSplatPlugin } from '3d-tiles-rendererjs-3dgs-plugin';

declare global {
    interface Window { __interop: { tilesLoaded: number; tilesVisible: number; splats: number; ready: boolean; errors: string[] } }
}

async function main(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const tilesetUrl = params.get('tileset') || '/tilesets/pantheon/tileset.json';
    window.__interop = { tilesLoaded: 0, tilesVisible: 0, splats: 0, ready: false, errors: [] };
    window.addEventListener('error', (e) => window.__interop.errors.push(String(e.message)));

    let eye = params.has('eye') ? Number(params.get('eye')) : NaN;
    if (!Number.isFinite(eye)) {
        try {
            const meta = await (await fetch(tilesetUrl.replace(/tileset\.json$/, 'tileset.meta.json'))).json();
            eye = Number(meta.eyeHeight) || 1.7;
        } catch { eye = 1.7; }
    }
    const walk = (params.get('walk') || '0,0.1').split(',').map(Number);

    const renderer = new WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(new Color(0x020617), 1);
    document.body.appendChild(renderer.domElement);

    const scene = new Scene();
    const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(walk[0], eye, walk[1]);
    camera.lookAt(walk[0], eye, walk[1] - 15);

    const tiles = new TilesRenderer(tilesetUrl);
    tiles.errorTarget = 8;
    tiles.setCamera(camera);
    tiles.setResolution(camera, renderer.getSize(new Vector2()));

    const splatRenderer = new GaussianSplatRenderer({ renderer, renderDepth: false });
    scene.add(splatRenderer);
    tiles.registerPlugin(new GaussianSplatPlugin({ targetCoverageBoostScale: 0 }));
    scene.add(tiles.group);
    (window as any).__tiles = tiles;

    tiles.addEventListener('load-tile-set', () => { window.__interop.ready = true; });
    tiles.addEventListener('load-model', () => { window.__interop.tilesLoaded++; });
    tiles.addEventListener('load-error', (e: any) => { window.__interop.errors.push(String(e?.error?.message || e?.error || 'load-error')); });

    const hud = document.getElementById('hud');
    // The tileset's root.transform places the splats on WGS-84 (ECEF). Re-anchor the tileset group
    // so the root's local frame coincides with our scene origin, exactly like a geospatial viewer
    // does when it centres on a tileset. If the transform were malformed, this would not recover
    // the original local metres and nothing would be in frustum.
    let anchored = false;
    const anchor = () => {
        const root: any = (tiles as any).root;
        if (!root || anchored) return;
        const rootWorld = root.cached?.transform;
        if (!rootWorld) return;
        tiles.group.matrixAutoUpdate = false;
        // inverse(root transform) brings us to the tileset's Z-up ENU frame; rotate -90 deg about X
        // so the scene is Y-up like the original splat frame (x east, y up, z south).
        tiles.group.matrix.copy(rootWorld).invert();
        tiles.group.matrix.premultiply(new Matrix4().makeRotationX(-Math.PI / 2));
        tiles.group.matrixWorldNeedsUpdate = true;
        anchored = true;
        window.__interop.ready = true;
    };

    renderer.setAnimationLoop(() => {
        anchor();
        tiles.update();
        renderer.render(scene, camera);
        const stats = (tiles as any).stats;
        window.__interop.tilesVisible = (tiles as any).visibleTiles?.size ?? 0;
        if (hud) hud.textContent = `3d-tiles-renderer + 3dgs-plugin | loaded ${window.__interop.tilesLoaded} | visible ${window.__interop.tilesVisible} | downloading ${stats?.downloading ?? 0} parsing ${stats?.parsing ?? 0}`;
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        tiles.setResolution(camera, renderer.getSize(new Vector2()));
    });
}

main().catch((e) => { window.__interop?.errors.push(String(e?.message || e)); console.error(e); });

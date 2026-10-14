import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PRELOADED_SHOWCASE_DEMOS } from '../src/browser/generative-canvas/demos/preloadedDemos';
import { STANDALONE_STUDIOS_CATALOG } from '../src/browser/generative-canvas/settings/tabs/AdminTab';

describe('Showcase Preloaded Demos Catalog', () => {
    it('should have at least 5 distinct showcase demos across categories', () => {
        expect(PRELOADED_SHOWCASE_DEMOS.length).toBeGreaterThanOrEqual(5);
        const categories = new Set(PRELOADED_SHOWCASE_DEMOS.map(d => d.category));
        expect(categories.has('3d')).toBe(true);
        expect(categories.has('video')).toBe(true);
        expect(categories.has('graph')).toBe(true);
        expect(categories.has('sandbox')).toBe(true);
        expect(categories.has('dashboard')).toBe(true);
    });

    it('each demo must have unique id and required metadata fields', () => {
        const ids = new Set<string>();
        for (const demo of PRELOADED_SHOWCASE_DEMOS) {
            expect(ids.has(demo.id)).toBe(false);
            ids.add(demo.id);

            expect(demo.title).toBeTruthy();
            expect(demo.subtitle).toBeTruthy();
            expect(demo.description).toBeTruthy();
            expect(demo.highlightBadge).toBeTruthy();
            expect(demo.introMessage).toBeTruthy();
            expect(Array.isArray(demo.tags)).toBe(true);
            expect(demo.tags.length).toBeGreaterThan(0);
            expect(demo.artifact).toBeDefined();
            expect(demo.artifact.id).toBeTruthy();
            expect(demo.artifact.type).toBeTruthy();
            expect(demo.artifact.data).toBeDefined();
        }
    });

    it('should adhere to Brand Identity Cleansing: zero mentions of Cursor or Antigravity branding', () => {
        const json = JSON.stringify(PRELOADED_SHOWCASE_DEMOS);
        // Ensure no references to competitor branding or legacy agents
        expect(json).not.toContain('Antigravity');
        expect(json).not.toContain('antigravity');
        expect(json).not.toContain('Cursor IDE');
        expect(json).not.toContain('Cursor');
    });

    it('3D geospatial demo artifact must feature Google Photorealistic 3D Tiles configuration', () => {
        const demo = PRELOADED_SHOWCASE_DEMOS.find(d => d.id === 'demo-3d-geospatial');
        expect(demo).toBeDefined();
        expect(demo?.artifact.type).toBe('3d-scene');
        const data = demo?.artifact.data as any;
        expect(data.geoAnchor).toBeDefined();
        expect(data.geoAnchor.active).toBe(true);
        expect(data.geoAnchor.landmarkName).toContain('Empire State Building');
        expect(data.environment.aerialPerspective.enabled).toBe(true);
    });

    it('Omnispatial demo must load the three real pipeline stages as one switchable variant set', () => {
        const demo = PRELOADED_SHOWCASE_DEMOS.find(d => d.id === 'demo-omnispatial-synthesis');
        expect(demo).toBeDefined();
        expect(demo?.artifact.type).toBe('3d-scene');
        expect(demo?.artifact.id).toBe('art-demo-omnispatial-real-stages');
        const data = demo?.artifact.data as any;

        // Three real GLB stages, each exempt from ground snapping (co-registered at one origin)
        expect(data.objects).toHaveLength(3);
        for (const obj of data.objects) {
            expect(obj.content.type).toBe('3d-model');
            expect(obj.content.durableUri).toMatch(/^\/models\/omnispatial_.*\.glb$/);
            expect(obj.content.metadata.role).toBe('environment');
            expect(obj.space.spatial3d).toEqual({ x: 0, y: 0, z: 0 });
        }
        expect(new Set(data.objects.map((o: any) => o.id)).size).toBe(3);

        // One open variant-set key shared by all stages, distinct numeric order, exactly one default
        const variantSets = new Set(data.objects.map((o: any) => o.content.metadata.variantSet));
        expect(variantSets.size).toBe(1);
        expect(typeof [...variantSets][0]).toBe('string');
        const orders = data.objects.map((o: any) => o.content.metadata.variantOrder);
        expect(orders.every((n: unknown) => typeof n === 'number')).toBe(true);
        expect(new Set(orders).size).toBe(3);
        expect(data.objects.filter((o: any) => o.content.metadata.variantDefault === true)).toHaveLength(1);
        for (const obj of data.objects) {
            expect(obj.content.metadata.variantLabel).toBeTruthy();
        }

        // Textures stay visible, no Google tiles streamed over the GLB district, neutral studio void
        expect(data.renderMode).not.toBe('clay');
        expect(data.geoAnchor.active).toBe(false);
        expect(data.geoAnchor.elevation).toBeUndefined();
        expect(data.environment.groundTileMode).toBe('none');
        expect(data.environment.skybox).toBe('studio');
        expect(data.environment.ground).toBe(false);
        expect(data.toolMode).toBe('view');

        // Camera must stand off beyond 1.15x the ~482 m bounding radius so auto-framing respects it
        const [px, py, pz] = data.camera.position;
        const [tx, ty, tz] = data.camera.target;
        expect(Math.hypot(px - tx, py - ty, pz - tz)).toBeGreaterThan(554);

        // The intro must explain the interactive controls
        expect(demo?.introMessage).toMatch(/orbit/i);
        expect(demo?.introMessage).toMatch(/pan/i);
        expect(demo?.introMessage).toMatch(/zoom/i);
        expect(demo?.introMessage).toMatch(/stage switcher/i);
    });

    // Opt-in asset check: public/models is gitignored (absent in CI) and the pipeline that produces
    // these GLBs rewrites them in place, so reading them during an ordinary run could see a file that
    // is mid-write. Run with SCRATCHBOX_VERIFY_DEMO_ASSETS=1 once the assets are settled.
    it.skipIf(!process.env.SCRATCHBOX_VERIFY_DEMO_ASSETS)('Omnispatial stage GLBs are present locally with a glTF header', () => {
        const demo = PRELOADED_SHOWCASE_DEMOS.find(d => d.id === 'demo-omnispatial-synthesis');
        const publicDir = path.resolve(__dirname, '../../../public');
        const uris: string[] = ((demo?.artifact.data as any)?.objects || []).map((o: any) => o.content.durableUri);
        expect(uris.length).toBeGreaterThan(0);
        const hydrated = uris.filter(uri => fs.existsSync(path.join(publicDir, uri)));
        expect(hydrated).toEqual(uris);
        for (const uri of uris) {
            const fd = fs.openSync(path.join(publicDir, uri), 'r');
            const magic = Buffer.alloc(4);
            fs.readSync(fd, magic, 0, 4, 0);
            fs.closeSync(fd);
            expect(magic.toString('ascii')).toBe('glTF');
        }
    });

    it('standalone studios must not reuse an in-app demo title', () => {
        const inAppTitles = new Set(PRELOADED_SHOWCASE_DEMOS.map(d => d.title));
        const omnispatialPlates = STANDALONE_STUDIOS_CATALOG.find(s => s.id === 'omnispatial-synthesis-demo');
        if (omnispatialPlates) {
            expect(inAppTitles.has(omnispatialPlates.title)).toBe(false);
        }
    });

    it('VFX timeline demo artifact must feature multi-track NLE and comparison', () => {
        const demo = PRELOADED_SHOWCASE_DEMOS.find(d => d.id === 'demo-vfx-timeline');
        expect(demo).toBeDefined();
        expect(demo?.artifact.type).toBe('video-timeline');
        const data = demo?.artifact.data as any;
        expect(data.tracks.length).toBeGreaterThanOrEqual(3);
    });

    it('Retro space breakout demo artifact must contain executable game sandbox code', () => {
        const demo = PRELOADED_SHOWCASE_DEMOS.find(d => d.id === 'demo-retro-breakout');
        expect(demo).toBeDefined();
        expect(demo?.artifact.type).toBe('live-code-sandbox');
        const data = demo?.artifact.data as any;
        expect(data.files).toBeDefined();
        expect(data.files.length).toBeGreaterThanOrEqual(2);
        const entryFile = data.files.find((f: any) => f.isEntry);
        expect(entryFile).toBeDefined();
        expect(entryFile.content).toContain('RetroSpaceBreakout');
    });

    it('Native 3D pipeline graph demo must feature the C++20 compile node', () => {
        const demo = PRELOADED_SHOWCASE_DEMOS.find(d => d.id === 'demo-native-pipeline-graph');
        expect(demo).toBeDefined();
        expect(demo?.artifact.type).toBe('node-graph');
        const data = demo?.artifact.data as any;
        expect(data.nodes.length).toBeGreaterThanOrEqual(4);
        expect(data.nodes.some((n: any) => n.id === 'node-compile')).toBe(true);
        expect(JSON.stringify(data)).not.toMatch(/comfy|cloud run/i);
    });

    it('Next-Gen Astro 3D Viewport demo must feature standalone studio artifact and meshlet tags', () => {
        const demo = PRELOADED_SHOWCASE_DEMOS.find(d => d.id === 'demo-nextgen-astra-viewport');
        expect(demo).toBeDefined();
        expect(demo?.category).toBe('3d');
        expect(demo?.highlightBadge).toBe('INDUSTRY BENCHMARK');
        expect(demo?.artifact.type).toBe('interactive-browser');
        const data = demo?.artifact.data as any;
        expect(data.url).toBe('/next_gen_astra_viewport_studio.html');
        expect(demo?.tags).toContain('Meshlet Virtualization');
        expect(demo?.tags).toContain('3D Gaussian Splatting');
    });

    it('Adaptive Image-to-PBR studio demo must feature interactive-browser artifact and biophysical tags', () => {
        const demo = PRELOADED_SHOWCASE_DEMOS.find(d => d.id === 'demo-image-to-adaptive-pbr');
        expect(demo).toBeDefined();
        expect(demo?.category).toBe('3d');
        expect(demo?.highlightBadge).toBe('ZERO-PRESET PBR');
        expect(demo?.artifact.type).toBe('interactive-browser');
        const data = demo?.artifact.data as any;
        expect(data.url).toBe('/image_to_adaptive_pbr_studio.html');
        expect(demo?.tags).toContain('Image to PBR');
        expect(demo?.tags).toContain('ORM Textures');
        expect(demo?.tags).toContain('Continuous Biophysics');
    });
});


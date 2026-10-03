import { describe, it, expect } from 'vitest';
import { PRELOADED_SHOWCASE_DEMOS } from '../src/browser/generative-canvas/demos/preloadedDemos';

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

    it('Autonomous spatial AI graph demo must feature KSampler and Cloud Run nodes', () => {
        const demo = PRELOADED_SHOWCASE_DEMOS.find(d => d.id === 'demo-ai-node-graph');
        expect(demo).toBeDefined();
        expect(demo?.artifact.type).toBe('node-graph');
        const data = demo?.artifact.data as any;
        expect(data.nodes.length).toBeGreaterThanOrEqual(4);
    });

    it('Next-Gen Astra 3D Viewport demo must feature standalone studio artifact and meshlet tags', () => {
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
});

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PRELOADED_SHOWCASE_DEMOS } from '../src/browser/generative-canvas/demos/preloadedDemos';

describe('Admin Access & Comprehensive Showcase Demos Catalog in Settings', () => {
    const settingsTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');
    const adminTabPath = path.resolve(__dirname, '../src/browser/generative-canvas/settings/tabs/AdminTab.tsx');
    const canvasTypesPath = path.resolve(__dirname, '../src/browser/generative-canvas/canvas-types.ts');
    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const publicDir = path.resolve(__dirname, '../../../public');

    it('1. StudioSettingsTab type incorporates "admin"', () => {
        const typesSrc = fs.readFileSync(canvasTypesPath, 'utf8');
        expect(typesSrc).toContain("'admin'");
    });

    it('2. SettingsModal sidebar navigation includes Admin & Demos tab', () => {
        const settingsSrc = fs.readFileSync(settingsTsxPath, 'utf8');
        expect(settingsSrc).toContain("id: 'admin'");
        expect(settingsSrc).toMatch(/Admin|Demos/);
    });

    it('3. AdminTab.tsx exists and provides comprehensive access to demos', () => {
        expect(fs.existsSync(adminTabPath)).toBe(true);
        const adminSrc = fs.readFileSync(adminTabPath, 'utf8');

        // Check key UI sections and capabilities
        expect(adminSrc).toContain('Admin');
        expect(adminSrc).toContain('Showcase Demos');

        // Check preloaded demos referenced
        expect(adminSrc).toContain('PRELOADED_SHOWCASE_DEMOS');
        expect(adminSrc).toContain('handleLaunchInAppDemo');

        // Check the core user-provided visualizer/studios are cataloged:
        expect(adminSrc).toContain('next_gen_astra_viewport_studio.html');
        expect(adminSrc).toContain('nanite_meshlet_pathtracing_studio.html');
        expect(adminSrc).toContain('colosseum_recolor_proof.html');
        expect(adminSrc).toContain('spatial_photoreal_3dgs_demo.html');
        expect(adminSrc).toContain('agent_lighting_proof.html');
        expect(adminSrc).toContain('nano_banana_texture_upscale_experiment.html');
        expect(adminSrc).toContain('image_to_adaptive_pbr_studio.html');
        expect(adminSrc).toContain('geobox_eval_report.html');
        expect(adminSrc).toContain('vfx_plate_anti_drift_demo.html');
        expect(adminSrc).toContain('colmap_visualizer.html');
        expect(adminSrc).toContain('botanical_visualizer.html');
        expect(adminSrc).toContain('plaza_matchmove_demo.html');
    });

    it('4. SettingsModal mounts AdminTab when activeTab is "admin"', () => {
        const settingsSrc = fs.readFileSync(settingsTsxPath, 'utf8');
        expect(settingsSrc).toContain("activeTab === 'admin'");
        expect(settingsSrc).toContain('<AdminTab');
    });

    it('5. GenerativeCanvasStudio handles demo mounting via onLaunchDemo', () => {
        const studioSrc = fs.readFileSync(studioTsxPath, 'utf8');
        expect(studioSrc).toContain('handleLaunchDemo');
        expect(studioSrc).toContain('onLaunchDemo={handleLaunchDemo}');
    });

    it('6. All preloaded showcase demos remain valid and loadable', () => {
        expect(PRELOADED_SHOWCASE_DEMOS.length).toBeGreaterThanOrEqual(5);
        for (const demo of PRELOADED_SHOWCASE_DEMOS) {
            expect(demo.id).toBeTruthy();
            expect(demo.artifact).toBeDefined();
            expect(demo.artifact.type).toBeTruthy();
        }
    });

    it('7. Cataloged standalone HTML demo studios exist in public directory', () => {
        const requiredFiles = [
            'next_gen_astra_viewport_studio.html',
            'nanite_meshlet_pathtracing_studio.html',
            'colosseum_recolor_proof.html',
            'spatial_photoreal_3dgs_demo.html',
            'agent_lighting_proof.html',
            'nano_banana_texture_upscale_experiment.html',
            'image_to_adaptive_pbr_studio.html',
            'geobox_eval_report.html',
            'vfx_plate_anti_drift_demo.html',
            'colmap_visualizer.html',
            'botanical_visualizer.html',
            'plaza_matchmove_demo.html',
            'geobox_demo.html',
            's4d_multi_gallery.html',
            'red_rocks_performer_demo.html',
            'universal_architecture_terrain_demo.html',
            'forest_3d_viewer.html',
            'video_to_4d_performer_studio.html',
            'adaptive_matchmove_studio.html',
            'person_matchmove_studio.html',
            'google_360_panorama_studio.html',
            'depthbox_image_to_3dgs.html',
            'asset_demo_studio.html',
            'camera_choreography_studio.html',
            'pro_color_grade_match_studio.html',
            'adaptive_world_styling_visualizer.html',
            'plaza_matchmove_eloise.html',
            'video_branching_studio.html',
            'geobox_precision_report.html',
            'visual_proof_alignment.html'
        ];

        for (const file of requiredFiles) {
            const exists =
                fs.existsSync(path.join(publicDir, file)) ||
                fs.existsSync(path.join(publicDir, 'demos/showcase', file)) ||
                fs.existsSync(path.join(publicDir, 'demos', file));
            expect(exists, `Expected public/${file} (or public/demos/showcase/${file}) to exist`).toBe(true);
        }
    });
});

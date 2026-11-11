/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    describeShotDetailBudget, evaluateShotDetailBudget, focalPx, heightPx, minFeatureM, parseShotPlan, projectedPixels,
    shotBasis, verticalFovDeg, type NamedTriangles, type ShotCamera
} from '../src/common/spatial/shot-detail-budget';
import { python3DHandlers } from '../src/node/gemini/tools/python-3d-tools';
import { buildReviewPrompt, renderShotView, SHOT_VIEW_LABEL } from '../src/node/3d-engine/visual-review';

// A 36 mm sensor behind a 36 mm lens, 1800 px wide: 1 m at 1 m covers 1800 px, and the horizontal field is 2*atan(0.5).
const shot: ShotCamera = { name: 'hero', position: [0, 0, 0], target: [0, 0, 10], focalMm: 36, sensorWidthMm: 36, aspect: 2, widthPx: 1800, detailPx: 2 };

/** A square grid of `n` x `n` cells, `size` metres across, facing the camera at depth `z`. */
function grid(name: string, size: number, n: number, z: number, cx = 0): NamedTriangles {
    const positions: number[] = [], indices: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(cx - size / 2 + size * i / n, -size / 2 + size * j / n, z);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        indices.push(a, b, d, a, d, c);
    }
    return { name, positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

describe('shot detail budget', () => {
    it('projects sizes to pixels from the lens, the frame and the depth along the view axis', () => {
        expect(focalPx(shot)).toBe(1800);
        expect(heightPx(shot)).toBe(900);
        expect(verticalFovDeg(shot)).toBeCloseTo(2 * Math.atan(0.25) * 180 / Math.PI, 6);
        expect(projectedPixels(shot, 1, [0, 0, 10])).toBeCloseTo(180, 9);
        // depth is along the axis, not the straight-line distance: a point off to the side at the same depth is the same size
        expect(projectedPixels(shot, 1, [4, 0, 10])).toBeCloseTo(180, 9);
        expect(projectedPixels(shot, 1, [0, 0, -5])).toBe(0);
        expect(minFeatureM(shot, [0, 0, 900])).toBeCloseTo(1, 9);
        expect(minFeatureM(shot, [0, 0, -1])).toBe(Infinity);
    });

    it('keeps a right-handed frame, also when the shot looks straight down', () => {
        const down = shotBasis({ ...shot, position: [0, 50, 0], target: [0, 0, 0] });
        expect(down.forward).toEqual([0, -1, 0]);
        expect(Math.hypot(...down.right)).toBeCloseTo(1, 9);
        expect(down.right[0] * down.forward[0] + down.right[1] * down.forward[1] + down.right[2] * down.forward[2]).toBeCloseTo(0, 9);
        const level = shotBasis(shot);
        expect(level.up[1]).toBeCloseTo(1, 9);
    });

    it('counts triangles under the budget per part, and only those in frame', () => {
        // 1 m across in 10 cells at 900 m: each cell is 0.1 m = 0.2 px, its diagonal 0.28 px: every triangle is under 2 px
        const far = grid('far block', 1, 10, 900);
        // the same grid at 9 m: a cell is 20 px
        const near = grid('near wall', 1, 10, 9);
        // behind the camera: never in frame
        const behind = grid('behind', 1, 4, -20);
        const report = evaluateShotDetailBudget([far, near, behind], [shot]);
        expect(report.triangles).toBe(200 + 200 + 32);
        expect(report.inFrame).toBe(400);
        expect(report.outOfFrame).toBe(32);
        expect(report.underBudget).toBe(200);
        expect(report.underBudgetShare).toBeCloseTo(0.5, 9);
        expect(report.heaviest.map(p => p.name)).toEqual(['far block']);
        const byName = Object.fromEntries(report.parts.map(p => [p.name, p]));
        expect(byName['far block'].medianEdgePx).toBeCloseTo(0.2 * Math.SQRT2, 3);
        expect(byName['near wall'].medianEdgePx).toBeCloseTo(20 * Math.SQRT2, 3);
        expect(byName['near wall'].underBudget).toBe(0);
        expect(byName['near wall'].nearestM).toBeCloseTo(9, 6);
        expect(byName['behind'].inFrame).toBe(0);
    });

    it('counts detail as seen when any declared shot resolves it', () => {
        const far = grid('far block', 1, 10, 900);
        const closeUp: ShotCamera = { ...shot, name: 'close', position: [0, 0, 890], target: [0, 0, 900] };
        const one = evaluateShotDetailBudget([far], [shot]);
        const both = evaluateShotDetailBudget([far], [shot, closeUp]);
        expect(one.underBudget).toBe(200);
        expect(both.underBudget).toBe(0);
        expect(both.parts[0].medianEdgePx).toBeCloseTo(18 * Math.SQRT2, 3);
    });

    it('tells the builder which parts to coarsen only when a real share is wasted', () => {
        const wasteful = describeShotDetailBudget(evaluateShotDetailBudget([grid('far block', 1, 10, 900), grid('near wall', 1, 10, 9)], [shot]));
        expect(wasteful).toContain('200 of those (50%) are under 2 px');
        expect(wasteful).toContain('far block 200 of 200');
        expect(wasteful).toContain('min_feature_m');
        const fine = describeShotDetailBudget(evaluateShotDetailBudget([grid('near wall', 1, 10, 9)], [shot]));
        expect(fine).toContain('0 of those (0%)');
        expect(fine).not.toContain('min_feature_m');
        const unseen = describeShotDetailBudget(evaluateShotDetailBudget([grid('near wall', 1, 2, 9), grid('behind', 1, 10, -20)], [shot]));
        expect(unseen).toContain('outside every declared shot');
        expect(describeShotDetailBudget(evaluateShotDetailBudget([], [shot]))).toBe('');
    });

    it('reports an under-built frame by its pixels per triangle', () => {
        // 1,620,000 frame pixels: 200 triangles in frame is 8,100 px a triangle, a frame of plain blocks
        const sparse = evaluateShotDetailBudget([grid('near wall', 1, 10, 9)], [shot]);
        expect(sparse.pixelsPerTriangle).toBeCloseTo(1800 * 900 / 200, 6);
        const text = describeShotDetailBudget(sparse);
        expect(text).toContain('The frame is under-built: 8100 pixels per in-frame triangle');
        expect(text).toContain('member_m');
        // 300 x 300 cells at 9 m: 180,000 triangles in frame, 9 px each, no advice
        const dense = evaluateShotDetailBudget([grid('near wall', 1, 300, 9)], [shot]);
        expect(dense.pixelsPerTriangle).toBeLessThan(16);
        expect(describeShotDetailBudget(dense)).not.toContain('under-built');
    });

    it('reads only complete shots from a shot plan', () => {
        const ok = { name: 'hero', position: [0, 160, -120], target: [0, 20, 180], focalMm: 31.5, sensorWidthMm: 36, aspect: 2.39, widthPx: 1920, detailPx: 2 };
        const shots = parseShotPlan({ shots: [ok, { ...ok, focalMm: 0 }, { ...ok, target: ok.position }, { ...ok, position: [0, 1] }, null] });
        expect(shots).toHaveLength(1);
        expect(shots[0]).toMatchObject(ok);
        expect(parseShotPlan(null)).toEqual([]);
        expect(parseShotPlan({ shots: 'none' })).toEqual([]);
    });

    it('renders the shot view at the shot\'s aspect and explains it to the reviewer', () => {
        const wall = grid('wall', 4, 4, 9);
        const view = renderShotView({ positions: wall.positions as Float32Array, indices: wall.indices as Uint32Array }, shot, 400);
        expect(view.label).toBe(`${SHOT_VIEW_LABEL} "hero"`);
        expect(view.png.subarray(1, 4).toString()).toBe('PNG');
        expect(view.png.readUInt32BE(16)).toBe(400);
        expect(view.png.readUInt32BE(20)).toBe(200);
        expect(buildReviewPrompt('a street', '', [view.label, 'top view'])).toContain('the camera the scene is built for');
        expect(buildReviewPrompt('a street', '', ['top view'])).not.toContain('the camera the scene is built for');
    });
});

describe('execute_3d_python_script with a declared shot', () => {
    it('opens the scene on the shot and reports the detail the shot cannot show', async () => {
        const outcome = await python3DHandlers.execute_3d_python_script({
            script: [
                'import scratchbox as sb',
                'hero = sb.shot(position=(0, 40, -100), target=(0, 0, 100), focal_mm=31.5, aspect=2.39, width_px=1920, name="hero")',
                'assert hero.height_px == 803',
                'assert abs(hero.focal_px - 1680.0) < 1e-6',
                'assert hero.sees((0, 0, 100)) and not hero.sees((0, 0, -200))',
                '# 5 cm is under 2 px at 600 m and well over it at 20 m',
                'assert not hero.resolves(0.05, at=(0, 0, 500)) and hero.resolves(0.05, at=(0, 30, -80))',
                'assert sb.shot_plan.resolves(0.05, (0, 30, -80)) and not sb.shot_plan.resolves(0.05, (0, 0, 500))',
                '# a 4 cm bar 400 m out is thickened to the 2 px the shot needs (0.48 m), never past 8x its size; near the lens it stays 4 cm',
                'far_bar = hero.member_m(0.04, at=(0, 0, 300))',
                'assert abs(far_bar - min(2 * hero.depth((0, 0, 300)) / hero.focal_px, 0.32)) < 1e-9, far_bar',
                'assert hero.member_m(0.04, at=(0, 39, -99)) == 0.04',
                'assert sb.shot_plan.member_m(0.04, (0, 39, -99)) == 0.04',
                '# this shot looks down +z, so frame left is +x: the left edge at 200 m lies at positive x and projects back onto the frame edge',
                'lx, ly, lz = hero.frame_point(-1.0, 0.0, 200.0)',
                'assert lx > 0 and abs(hero.depth((lx, ly, lz)) - 200.0) < 1e-6 and abs(hero.right[0] + 1.0) < 1e-9',
                'assert hero.sees(hero.frame_point(-0.99, 0.99, 50.0)) and not hero.sees(hero.frame_point(-1.05, 0.0, 50.0))',
                'scene = sb.Scene()',
                'near = sb.create_sphere(radius=6.0, rings=24, sectors=48)',
                'near.translate(0, 6, 0)',
                'near.name = "near_sphere"',
                'scene.add_mesh(near)',
                '# a finely tessellated ball 2 km away: every triangle is far under 2 px',
                'far = sb.create_sphere(radius=3.0, rings=96, sectors=192)',
                'far.translate(0, 3, 2000)',
                'far.name = "far_sphere"',
                'scene.add_mesh(far)',
                'sb.io.write_glb(OUTPUT_GLB_PATH, scene)'
            ].join('\n'),
            description: 'Shot budget probe'
        });

        expect(outcome.status).toBe('completed');
        const payload = outcome.resultPayload as any;
        expect(payload.shots).toHaveLength(1);
        expect(payload.shots[0]).toMatchObject({ name: 'hero', position: [0, 40, -100], target: [0, 0, 100], focalMm: 31.5, aspect: 2.39, widthPx: 1920, detailPx: 2 });
        const camera = payload.artifact.data.camera;
        expect(camera.position).toEqual([0, 40, -100]);
        expect(camera.target).toEqual([0, 0, 100]);
        expect(camera.fov).toBeCloseTo(2 * Math.atan(36 / 2.39 / (2 * 31.5)) * 180 / Math.PI, 2);
        expect(camera.lens).toMatchObject({ focalLengthMm: 31.5, sensorWidthMm: 36 });
        expect(camera.keepPoseOnLoad).toBe(true);
        expect(payload.artifact.data.shots).toHaveLength(1);

        const budget = payload.shotDetailBudget;
        expect(budget.inFrame).toBeGreaterThan(0);
        expect(budget.underBudgetShare).toBeGreaterThan(0.5);
        expect(budget.heaviest[0].underBudget).toBeGreaterThan(10000);
        expect(budget.heaviest[0].nearestM).toBeGreaterThan(1900);
        expect(outcome.summaryResult).toContain('Shot detail budget (hero (1920x803))');
        expect(outcome.summaryResult).toContain('min_feature_m');
    }, 180000);

    it('frames the model itself when the script declares no shot', async () => {
        const outcome = await python3DHandlers.execute_3d_python_script({
            script: 'import scratchbox as sb\nscene = sb.geometry.Mesh("Ball")\nscene.merge(sb.create_sphere(radius=1.0, rings=64, sectors=128))\nsb.io.write_glb(OUTPUT_GLB_PATH, scene)',
            description: 'No shot'
        });
        expect(outcome.status).toBe('completed');
        const payload = outcome.resultPayload as any;
        expect(payload.shots).toBeUndefined();
        expect(payload.artifact.data.shots).toBeUndefined();
        expect(payload.artifact.data.camera.keepPoseOnLoad).toBeUndefined();
        expect(payload.artifact.data.camera.fov).toBe(50);
        expect(outcome.summaryResult).not.toContain('Shot detail budget');
    }, 120000);
});

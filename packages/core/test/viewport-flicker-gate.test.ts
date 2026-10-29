/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The flicker gate: the real viewport, with depth of field, lens flare and diffusion on, pans by a fraction of a pixel
 * a frame across detail finer than a pixel (a far grille of thin bars behind a colonnade). Between consecutive frames
 * the whole frame's energy and every 16 x 16 block's energy must stay nearly constant: a pan this slow changes almost
 * nothing, so a step is flicker. Measured with temporal anti-aliasing on (the default) and off, so the gate also shows
 * what the anti-aliasing buys.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { openStagedPage, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { writeFixtureGlb, type FixtureMesh } from './helpers/mesh-glb-fixtures';
import { REPO_ROOT } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'flicker_gate');
type Cam = NonNullable<Scene3DData['camera']>;
type V3 = [number, number, number];
const ROOT = 'scratchbox-cpp-generated-root';

/** Whole-frame and worst-block energy steps between frames, as fractions. */
// set between what the viewport measured with temporal anti-aliasing (on: 0.02 % / 0.04 % / 0.57 % / 0.86 %) and
// without it (off: 0.05 % / 0.18 % / 1.45 % / 1.97 %) on 2026-10-28: a change that brings the flicker back fails
export const FLICKER_LIMITS = { frameMean: 0.0004, frameMax: 0.001, blockMean: 0.01, blockMax: 0.014 };

function grilleGlb(): string {
    const positions: number[] = [], indices: number[] = [];
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
        const quad = (a: number[], b: number[], c: number[], d: number[]) => {
            const base = positions.length / 3;
            positions.push(...a, ...b, ...c, ...d);
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
        quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
        quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
        quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
        quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    };
    // a colonnade in the foreground (blurred by the depth of field) ...
    for (let i = 0; i < 4; i++) {
        box(-4.4, 0, -4 * i - 0.4, -3.6, 5, -4 * i + 0.4);
        box(3.6, 0, -4 * i - 0.4, 4.4, 5, -4 * i + 0.4);
    }
    // ... and, at the plane of focus, a grille of bars thinner than a pixel (mullions on a far facade)
    for (let i = -60; i <= 60; i++) box(i * 0.2 - 0.015, 0, -40.03, i * 0.2 + 0.015, 10, -40);
    for (let j = 0; j <= 40; j++) box(-12, j * 0.25 - 0.015, -40.03, 12, j * 0.25 + 0.015, -40);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-flicker-gate-')), 'grille.glb');
    writeFixtureGlb(file, { positions, indices } as FixtureMesh);
    return fs.readFileSync(file).toString('base64');
}

const EYE: V3 = [0, 3, 6];
const TARGET: V3 = [0, 4, -160];

describe.skipIf(!stagedChrome.ok)('flicker gate in the real viewport (headless Chrome)', () => {
    let page: StagedPage;
    let glb: string;
    const lens = (taa: boolean): Cam['lens'] => ({
        focalLengthMm: 50, sensorWidthMm: 36, sensorHeightMm: 24, apertureFStop: 2, focusDistanceMeters: 46, depthOfField: true,
        flare: { amount: 0.4 }, diffusion: { strength: 0.12 }, temporalAntiAliasing: taa
    });
    const scene = (cam: Cam) => ({
        title: 'Grille',
        renderMode: 'clay',
        cameraMode: 'orbit',
        environment: { skybox: 'studio', lighting: 'studio', ground: false },
        pythonGenerator: { sourceCode: '# flicker gate fixture', glbBase64: glb },
        camera: cam
    });
    const last = () => page.eval<any>('window.sbHarness.lastUpdate()');
    const settle = () => new Promise(r => setTimeout(r, 60));
    const mount = async (data: unknown) => {
        await page.eval(`window.__SB_3D_STACK__ = undefined; window.sbHarness.mount(${JSON.stringify(data)})`);
        for (let i = 0; i < 300; i++) {
            await page.step(2, 16);
            if (await page.eval<boolean>(`!!(window.sbHarness.ready() && window.__SB_3D_STACK__ && window.__SB_3D_STACK__.scene.getObjectByName("${ROOT}"))`)) break;
            await new Promise(r => setTimeout(r, 50));
        }
        await page.step(6, 16);
        await settle();
    };

    /** Pans by `dx` metres a frame and returns the frame-to-frame energy steps (after `warm` frames). */
    const pan = async (taa: boolean, frames = 40, warm = 12, dx = 0.0015) => {
        const base = await last();
        await page.eval(`window.sbHarness.update(${JSON.stringify({ ...base, camera: { position: EYE, target: TARGET, fov: 26.99, lens: lens(taa) } })})`);
        await page.step(4, 16);
        await settle();
        await page.eval(`window.__sbFlicker = { prev: null, frame: [], block: [] }`);
        for (let f = 0; f < frames; f++) {
            const x = f * dx;
            await page.eval(`(() => {
                const s = window.__SB_3D_STACK__;
                s.camera.position.set(${EYE[0] + x}, ${EYE[1]}, ${EYE[2]});
                s.camera.lookAt(${TARGET[0] + x}, ${TARGET[1]}, ${TARGET[2]});
                const t = window.__SB_3D_CAMERA_TARGET__; if (t && t.current) t.current.set(${TARGET[0] + x}, ${TARGET[1]}, ${TARGET[2]});
            })()`);
            // step one frame and read the canvas in the same task (the drawing buffer is still valid)
            await page.eval(`(() => {
                window.__sbStep(1, 16);
                const src = window.__SB_3D_STACK__.renderer.domElement;
                const W = src.width, H = src.height;
                const c = window.__sbFlickerCanvas || (window.__sbFlickerCanvas = document.createElement('canvas'));
                c.width = W; c.height = H;
                const g = c.getContext('2d', { willReadFrequently: true });
                g.drawImage(src, 0, 0, W, H);
                const px = g.getImageData(0, 0, W, H).data;
                const B = 16, bw = Math.ceil(W / B), bh = Math.ceil(H / B);
                const blocks = new Float64Array(bw * bh);
                let sum = 0;
                for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                    const i = (y * W + x) * 4, l = px[i] + px[i + 1] + px[i + 2];
                    sum += l; blocks[Math.floor(x / B) + Math.floor(y / B) * bw] += l;
                }
                const st = window.__sbFlicker;
                if (st.prev && ${f >= warm}) {
                    st.frame.push(Math.abs(sum - st.prev.sum) / st.prev.sum);
                    let worst = 0;
                    for (let k = 0; k < blocks.length; k++) if (st.prev.blocks[k] > B * B * 30) worst = Math.max(worst, Math.abs(blocks[k] - st.prev.blocks[k]) / st.prev.blocks[k]);
                    st.block.push(worst);
                }
                st.prev = { sum, blocks };
            })()`);
        }
        const r = await page.eval<{ frame: number[]; block: number[] }>('({ frame: window.__sbFlicker.frame, block: window.__sbFlicker.block })');
        const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
        const drawn = (await page.eval<{ drawn: string[] }>('window.__SB_3D_OPTICS__.status')).drawn;
        return { drawn, frameMean: mean(r.frame), frameMax: Math.max(...r.frame), blockMean: mean(r.block), blockMax: Math.max(...r.block), samples: r.frame.length };
    };

    beforeAll(async () => {
        glb = grilleGlb();
        page = await openStagedPage({ width: 1100, height: 720, shotDir: SHOTS, manualFrames: true });
        await mount(scene({ position: EYE, target: TARGET, fov: 26.99, lens: lens(true) }));
        // the hardest case for flicker: detail far brighter than white on black (lit windows at night, glints)
        await page.eval(`(() => {
            const s = window.__SB_3D_STACK__;
            const root = s.scene.getObjectByName('${ROOT}');
            root.traverse(o => {
                if (!o.isMesh) return;
                const m = new o.material.constructor();
                if (m.emissive) { m.color.setRGB(0, 0, 0); m.emissive.setRGB(1, 1, 1); m.emissiveIntensity = 6; } else m.color.setRGB(6, 6, 6);
                o.material = m;
            });
            const inRoot = new Set(); root.traverse(o => inRoot.add(o));
            s.scene.traverse(o => { if ((o.isMesh || o.isLine || o.isPoints) && !inRoot.has(o)) o.visible = false; });
            s.scene.background = null;
            s.renderer.setClearColor(0x000000, 1);
        })()`);
    }, 120_000);
    afterAll(async () => { await page?.close(); });

    test('a sub-pixel pan through depth of field, flare and diffusion does not flicker', async () => {
        const off = await pan(false);
        const on = await pan(true);
        await page.screenshot('grille_taa_on');
        console.log('flicker gate', JSON.stringify({ off, on }));
        expect(on.drawn).toEqual(expect.arrayContaining(['temporal-aa', 'depth-of-field', 'lens-flare', 'diffusion']));
        expect(off.drawn).not.toContain('temporal-aa');
        expect(on.samples).toBeGreaterThan(20);
        expect(on.frameMean).toBeLessThan(FLICKER_LIMITS.frameMean);
        expect(on.frameMax).toBeLessThan(FLICKER_LIMITS.frameMax);
        expect(on.blockMean).toBeLessThan(FLICKER_LIMITS.blockMean);
        expect(on.blockMax).toBeLessThan(FLICKER_LIMITS.blockMax);
        // the anti-aliasing must be what holds it steady
        expect(on.blockMean).toBeLessThan(0.6 * off.blockMean);
        expect(page.consoleErrors().filter(e => !/favicon/.test(e))).toEqual([]);
    }, 180_000);
});

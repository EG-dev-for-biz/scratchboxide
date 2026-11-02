/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Auto focus and a tracked focus point in the REAL Scene3DPrimitive in headless Chrome with real WebGL, on a frame
 * clock the test advances (deterministic focus pulls): the panel's focus mode selector writes sb_set_camera_lens; auto
 * focus reads the scene's depth under the AF area and glides to it (85 mm f/1.4, near column -> far column), holds on
 * sky; a picked point follows a moving camera and a moving object, and a lost object holds with a notice; undo, a
 * remount (reload) and the agent's configure_physical_camera keep panel, scene data and viewport in sync; the reticle
 * sits on the AF area / the tracked point and hides with its toggle.
 * Screenshots: test-results/screenshots/camera_focus/ (gitignored).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { openStagedPage, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { writeFixtureGlb, type FixtureMesh } from './helpers/mesh-glb-fixtures';
import { physicalCameraHandlers } from '../src/node/gemini/tools/spatial-tools';
import { REPO_ROOT } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'camera_focus');
type Cam = NonNullable<Scene3DData['camera']>;
type V3 = [number, number, number];
const ROOT = 'scratchbox-cpp-generated-root';

/** Two rows of 12 square columns receding along -Z on a paved floor, one merged mesh (as a generated model). */
function colonnadeGlb(): string {
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
    for (let i = 0; i < 12; i++) {
        const z = -4 * i;
        box(-4.4, 0, z - 0.4, -3.6, 5, z + 0.4);
        box(3.6, 0, z - 0.4, 4.4, 5, z + 0.4);
    }
    box(-4.6, 5, -44.6, -3.4, 5.6, 0.6);
    box(3.4, 5, -44.6, 4.6, 5.6, 0.6);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 24; j++) box(-6 + i * 2 + 0.05, -0.1, -46 + j * 2 + 0.05, -6 + (i + 1) * 2 - 0.05, 0, -46 + (j + 1) * 2 - 0.05);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-camera-focus-')), 'colonnade.glb');
    writeFixtureGlb(file, { positions, indices } as FixtureMesh);
    return fs.readFileSync(file).toString('base64');
}

const EYE: V3 = [0, 2.5, 6];
const NEAR_COLUMN: V3 = [3.6, 2.5, -4];   // inner face of the second right-hand column
const FAR_COLUMN: V3 = [3.6, 2.5, -36];   // inner face of the tenth
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/**
 * A look-at target on the ray from `eye` through `p`, `k` times as far: the centre ray still meets the surface at p
 * first, and the target stands far enough away that the viewport keeps the pose (calculateStandoffCamera re-frames a
 * camera closer to its target than 1.15 scene radii).
 */
const through = (p: V3, eye: V3 = EYE, k = 4): V3 => [eye[0] + (p[0] - eye[0]) * k, eye[1] + (p[1] - eye[1]) * k, eye[2] + (p[2] - eye[2]) * k];

describe.skipIf(!stagedChrome.ok)('auto focus and a tracked focus point in the real viewport (headless Chrome)', () => {
    let page: StagedPage;
    let glb: string;
    const camera = (target: V3, position: V3 = EYE, lens?: Cam['lens']): Cam => ({ position, target, fov: 16.0719, ...(lens ? { lens } : {}) });
    const LENS_85: Cam['lens'] = { focalLengthMm: 85, sensorWidthMm: 36, sensorHeightMm: 24, apertureFStop: 1.4, focusDistanceMeters: 20, depthOfField: true };
    const scene = (cam: Cam) => ({
        title: 'Colonnade',
        renderMode: 'clay',
        cameraMode: 'orbit',
        environment: { skybox: 'studio', lighting: 'studio', ground: false },
        pythonGenerator: { sourceCode: '# colonnade fixture', glbBase64: glb },
        camera: cam
    });
    const last = () => page.eval<any>('window.sbHarness.lastUpdate()');
    const q = (testId: string) => `document.querySelector('[data-testid="${testId}"]')`;
    const settle = () => new Promise(r => setTimeout(r, 120));
    const frames = async (n: number) => { await page.step(n, 16); await settle(); };
    const centre = (testId: string) => page.eval<[number, number]>(`(() => { ${q(testId)}.scrollIntoView({ block: 'nearest' }); const r = ${q(testId)}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const clickTestId = async (testId: string) => { const [x, y] = await centre(testId); await page.click(x, y); await frames(2); };
    const panelOpen = () => page.eval<boolean>(`!!${q('sb-3d-camera-panel')}`);
    const ensureOpen = async () => { if (!(await panelOpen())) await clickTestId('sb-3d-camera-settings'); };
    const focus = () => page.eval<{ mode: string; distanceMeters: number | null; targetMeters: number | null; notice: string | null; worldPoint: V3 | null; reads: number }>('window.__SB_3D_FOCUS__.status');
    const optics = () => page.eval<{ drawn: string[]; focusDistanceMeters: number | null; issues: string[] }>('window.__SB_3D_OPTICS__.status');
    const checked = (mode: string) => page.eval<string>(`${q(`sb-camera-focus-mode-${mode}`)}.getAttribute('aria-checked')`);
    const liveDepth = (p: V3) => page.eval<number>(`(() => { const c = window.__SB_3D_STACK__.camera; c.updateMatrixWorld(); const v = c.position.clone().set(${p.join(',')}); return -v.applyMatrix4(c.matrixWorldInverse).z; })()`);
    const project = (p: V3) => page.eval<[number, number]>(`(() => { const s = window.__SB_3D_STACK__; const v = s.camera.position.clone().set(${p.join(',')}); v.project(s.camera); const r = s.renderer.domElement.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; })()`);
    const reticle = () => page.eval<{ display: string; mode: string | undefined; state: string | undefined; cx: number; cy: number; w: number; canvasH: number }>(`(() => { const el = ${q('sb-3d-focus-reticle')}; const r = el.getBoundingClientRect(); const c = window.__SB_3D_STACK__.renderer.domElement.getBoundingClientRect(); return { display: el.style.display, mode: el.dataset.mode, state: el.dataset.state, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, canvasH: c.height, canvasCx: c.left + c.width / 2, canvasCy: c.top + c.height / 2 }; })()`);
    /** Moves the camera the way the agent's sb_set_camera does: the scene's stored pose, applied by the viewport. */
    const moveCamera = async (target: V3, position: V3 = EYE) => {
        const s = await last();
        await page.eval(`window.sbHarness.update(${JSON.stringify({ ...s, camera: { ...s.camera, position, target } })})`);
        await frames(2);
    };
    const shot = async (name: string) => {
        const file = await page.screenshot(name);
        expect(fs.statSync(file).size).toBeGreaterThan(20_000);
        return file;
    };
    const mount = async (data: unknown) => {
        await page.eval(`window.__SB_3D_STACK__ = undefined; window.sbHarness.mount(${JSON.stringify(data)})`);
        for (let i = 0; i < 300; i++) {
            await page.step(2, 16);
            if (await page.eval<boolean>(`!!(window.sbHarness.ready() && window.__SB_3D_STACK__ && window.__SB_3D_STACK__.scene.getObjectByName("${ROOT}"))`)) break;
            await new Promise(r => setTimeout(r, 50));
        }
        await frames(6);
    };

    beforeAll(async () => {
        glb = colonnadeGlb();
        // drawn at half resolution (550 x 360 device pixels; the layout, clicks and reticle are CSS pixels and unchanged):
        // software WebGL draws the depth-of-field frames several times faster, inside the tests' time on a 2-vCPU runner
        page = await openStagedPage({ width: 1100, height: 720, shotDir: SHOTS, manualFrames: true, deviceScaleFactor: 0.5 });
        await mount(scene(camera(through(NEAR_COLUMN), EYE, LENS_85)));
    }, 120_000);
    afterAll(async () => { await page?.close(); });

    test('auto focus: the selector writes the mode, the AF read finds the centre depth and the focus glides to it (near column, then far column)', async () => {
        expect((await optics()).focusDistanceMeters).toBeCloseTo(20, 6); // manual, as stored
        await ensureOpen();
        expect(await checked('manual')).toBe('true');
        await shot('01_manual_20m_panel');

        await clickTestId('sb-camera-focus-mode-auto');
        let s = await last();
        expect(s.camera.lens).toMatchObject({ focusMode: 'auto', autoFocusAreaFraction: 0.1, focusPullSeconds: 0.3, focusDistanceMeters: 20 });
        expect(s.operatorStack.at(-1).operator).toBe('sb_set_camera_lens');
        expect(await checked('auto')).toBe('true');
        expect(await page.eval<boolean>(`!!${q('sb-camera-af-area')}`)).toBe(true);

        // the glide from 20 m to the near column, frame by frame at 60 fps
        const nearDepth = await liveDepth(NEAR_COLUMN);
        expect(nearDepth).toBeCloseTo(dist(EYE, NEAR_COLUMN), 3);
        const glide: number[] = [];
        for (let i = 0; i < 60; i++) { await page.step(1, 1000 / 60); glide.push((await focus()).distanceMeters!); }
        const target = (await focus()).targetMeters!;
        // the nearest robust depth over the AF area: the column face around the centre, within its half-width
        expect(Math.abs(target - nearDepth)).toBeLessThan(0.5);
        // smooth: monotonic, with intermediate values, about 63 % of the way (in dioptres) after one 0.3 s tau
        glide.forEach((v, i) => { if (i) expect(v).toBeLessThanOrEqual(glide[i - 1] + 1e-9); });
        expect(glide.filter(v => v < 19.9 && v > target + 0.1).length).toBeGreaterThan(20);
        // each frame is one step of the 0.3 s exponential pull in dioptres toward the AF target (frame-rate independent)
        for (let i = 1; i < glide.length; i++) {
            const step = 1 / (1 / glide[i - 1] + (1 / target - 1 / glide[i - 1]) * (1 - Math.exp(-(1 / 60) / 0.3)));
            expect(Math.abs(glide[i] - step) / step).toBeLessThan(2e-3);
        }
        expect(glide[59]).toBeCloseTo(target, 0);
        expect((await optics()).drawn).toContain('depth-of-field');
        await settle();
        expect(await page.eval<string>(`${q('sb-camera-focus-measured')}.innerText`)).toMatch(/^now 1\d\.\d+ m from the camera$/);
        await shot('02_auto_near_column_locked');

        // the reticle marks the AF area: centred, 10 % of the frame height
        let r = await reticle();
        expect(r).toMatchObject({ display: 'block', mode: 'auto', state: 'locked' });
        expect(r.w).toBeCloseTo(0.1 * r.canvasH, 0);
        expect(r.cx).toBeCloseTo((r as any).canvasCx, 0);
        expect(r.cy).toBeCloseTo((r as any).canvasCy, 0);

        // pan to the far column: focus follows smoothly (a frame sequence)
        await moveCamera(through(FAR_COLUMN, EYE, 1.5));
        const farDepth = await liveDepth(FAR_COLUMN);
        const pull: number[] = [];
        for (let i = 0; i < 80; i++) {
            await page.step(1, 1000 / 60);
            pull.push((await focus()).distanceMeters!);
            if (i === 4 || i === 14 || i === 30) await shot(`03_auto_pull_to_far_frame_${String(i).padStart(2, '0')}`);
        }
        const farTarget = (await focus()).targetMeters!;
        expect(Math.abs(farTarget - farDepth)).toBeLessThan(1.5);
        pull.forEach((v, i) => { if (i) expect(v).toBeGreaterThanOrEqual(pull[i - 1] - 1e-9); });
        expect(pull.filter(v => v > target + 1 && v < farTarget - 1).length).toBeGreaterThan(15);
        // converged in dioptres (where a focus ring travels): within 0.002 D of the target after 1.33 s (4.4 tau)
        expect(Math.abs(1 / pull[79] - 1 / farTarget)).toBeLessThan(2e-3);
        await shot('04_auto_far_column_locked');

        // the AF area and pull are continuous: a 0 s pull snaps on the next read
        await ensureOpen();
        const before = (await last()).camera.lens.focusPullSeconds;
        expect(before).toBe(0.3);
        await page.eval(`(() => { const el = ${q('sb-camera-focus-pull')}; el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '0'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await page.key('Enter');
        await frames(1);
        expect((await last()).camera.lens.focusPullSeconds).toBe(0);
        await moveCamera(through(NEAR_COLUMN));
        await frames(8);
        expect(Math.abs((await focus()).distanceMeters! - nearDepth)).toBeLessThan(0.5);

        // sky under the AF area: the last focus is held, and the panel says so
        const held = (await focus()).distanceMeters!;
        await moveCamera([0.5, 60, 5.5]);
        await frames(10);
        expect((await focus()).distanceMeters).toBeCloseTo(held, 6);
        await ensureOpen();
        expect(await page.eval<string>(`${q('sb-camera-focus-notice')}.innerText`)).toMatch(/^auto focus sees no surface under the AF area \(sky or empty\); holding \d+\.\d\d m$/);
        r = await reticle();
        expect(r.state).toBe('held');
        expect(await page.eval<number>(`document.querySelectorAll('[data-testid="sb-3d-viewport-notice"]').length`)).toBe(0); // no banner for the sky
        await shot('05_auto_sky_holds');
        await moveCamera(through(NEAR_COLUMN));
        await frames(8);
    }, 120_000);

    test('track a point: a click locks onto a column surface point; it follows an orbiting camera and a moving object; a lost object holds with a notice', async () => {
        await ensureOpen();
        await clickTestId('sb-camera-focus-mode-track');
        expect(await page.eval<string>(`${q('sb-camera-track-hint')}.innerText`)).toMatch(/Click locks focus onto that surface point/);
        expect((await last()).camera.lens.focusMode).toBe('auto'); // nothing changes until the click
        expect(await checked('track')).toBe('true'); // pending
        expect(await checked('auto')).toBe('false');
        const point: V3 = [3.6, 2.5, -12];
        await moveCamera(through(point, EYE, 2.5));
        const [px, py] = await project([3.6, 2.5, -12]);
        await page.click(px, py);
        await frames(3);
        let s = await last();
        expect(s.camera.lens.focusMode).toBe('track');
        expect(s.camera.lens.focusPoint.objectId).toBe(ROOT);
        s.camera.lens.focusPoint.localPosition.forEach((v: number, i: number) => expect(Math.abs(v - point[i])).toBeLessThan(0.15));
        const picked = s.camera.lens.focusPoint.localPosition as V3;
        await ensureOpen();
        expect(await checked('track')).toBe('true');
        expect(await page.eval<string>(`${q('sb-camera-focus-point')}.innerText`)).toMatch(new RegExp(`on ${ROOT}`));
        expect((await focus()).distanceMeters).toBeCloseTo(await liveDepth(picked), 4);
        await shot('06_track_point_picked');

        // orbit around the colonnade: each frame the focus distance is the picked point's depth
        for (const [i, eye] of ([[-3, 3, 8], [-6, 5, 2], [-2, 8, -4], [0, 4, 12]] as V3[]).entries()) {
            await moveCamera(through(picked, eye, 3), eye);
            await frames(1);
            expect((await focus()).distanceMeters).toBeCloseTo(await liveDepth(picked), 4);
            const [rx, ry] = await project(picked);
            const ret = await reticle();
            expect(ret, JSON.stringify(ret)).toMatchObject({ display: 'block', mode: 'track', state: 'locked' });
            expect(Math.hypot(ret.cx - rx, ret.cy - ry)).toBeLessThan(1.5);
            if (i === 1) await shot('07_track_point_orbit');
        }

        // the object moves (an animation): the point goes with it
        await page.eval(`window.__SB_3D_STACK__.scene.getObjectByName("${ROOT}").position.set(0, 0, -6)`);
        await frames(1);
        const moved: V3 = [picked[0], picked[1], picked[2] - 6];
        expect((await focus()).distanceMeters).toBeCloseTo(await liveDepth(moved), 4);
        expect((await focus()).worldPoint![2]).toBeCloseTo(moved[2], 4);

        // the object disappears: the last distance is held and the panel says why
        const heldAt = (await focus()).distanceMeters!;
        await page.eval(`(() => { const s = window.__SB_3D_STACK__.scene; const r = s.getObjectByName("${ROOT}"); window.__sbDetached = { r, parent: r.parent }; r.parent.remove(r); })()`);
        await frames(2);
        expect((await focus()).distanceMeters).toBeCloseTo(heldAt, 9);
        await ensureOpen();
        expect(await page.eval<string>(`${q('sb-camera-focus-notice')}.innerText`)).toBe(`the tracked point's object '${ROOT}' is not in the viewport; holding the last focus distance ${heldAt.toFixed(2)} m`);
        expect((await optics()).drawn).toContain('depth-of-field');
        expect(await page.eval<string>(`document.querySelector('[data-testid="sb-3d-viewport-notice"][data-kind="focus"]').innerText`)).toMatch(/^Focus held\s+the tracked point's object/);
        await shot('08_track_point_lost_holds');
        await page.eval(`(() => { const d = window.__sbDetached; d.parent.add(d.r); d.r.position.set(0, 0, 0); })()`);
        await frames(2);
        expect((await focus()).notice).toBeNull();
    }, 120_000);

    test('undo / redo of the mode switches, the reticle toggle, and a remount (reload) keeps the mode and the point', async () => {
        await ensureOpen();
        expect(await checked('track')).toBe('true');
        await clickTestId('sb-3d-undo');
        await frames(2);
        expect((await last()).camera.lens.focusMode).toBe('auto');
        expect((await focus()).mode).toBe('auto');
        await clickTestId('sb-3d-redo');
        await frames(2);
        expect((await last()).camera.lens.focusMode).toBe('track');
        expect((await focus()).mode).toBe('track');

        // the reticle hides with its toggle (a per-viewer preference; it is never in the rendered frame)
        await ensureOpen();
        await clickTestId('sb-camera-focus-reticle');
        await frames(1);
        expect((await reticle()).display).toBe('none');
        await ensureOpen();
        await clickTestId('sb-camera-focus-reticle');
        await frames(1);
        expect((await reticle()).display).toBe('block');

        // reload: a fresh mount from the stored scene data
        const stored = await last();
        await mount(stored);
        expect((await focus()).mode).toBe('track');
        expect((await focus()).distanceMeters).toBeCloseTo(await liveDepth(stored.camera.lens.focusPoint.localPosition), 4);
        await ensureOpen();
        expect(await checked('track')).toBe('true');
        await shot('09_reload_keeps_tracked_point');
    }, 120_000);

    test('the agent\'s configure_physical_camera sets auto focus and a tracked point, and the panel follows', async () => {
        const ctx = (data: unknown) => ({ request: { activeArtifact: { id: 's', type: '3d-scene', title: 'Colonnade', version: 3, data } } }) as any;
        let out = await physicalCameraHandlers.configure_physical_camera({ focalLengthMm: 85, apertureFStop: 1.4, focusMode: 'auto', autoFocusAreaFraction: 0.2, focusPullSeconds: 0.5 }, ctx(await last())) as any;
        expect(out.resultPayload.applied).toBe(true);
        await page.eval(`window.sbHarness.update(${JSON.stringify(out.resultPayload.artifact.data)})`);
        await frames(4);
        await ensureOpen();
        expect(await checked('auto')).toBe('true');
        expect(await page.eval<string>(`${q('sb-camera-af-area')}.value`)).toBe('20');
        expect(await page.eval<string>(`${q('sb-camera-focus-pull')}.value`)).toBe('0.5');
        expect((await focus()).mode).toBe('auto');
        const r2 = await reticle();
        expect(r2.w, JSON.stringify(r2)).toBeCloseTo(0.2 * r2.canvasH, 0);
        await shot('10_agent_auto_focus_in_panel');

        // a fixed world point from the agent
        out = await physicalCameraHandlers.configure_physical_camera({ focalLengthMm: 85, apertureFStop: 1.4, focusPoint: { worldPosition: FAR_COLUMN } }, ctx(await last())) as any;
        expect(out.resultPayload.focus.mode).toBe('track');
        await page.eval(`window.sbHarness.update(${JSON.stringify(out.resultPayload.artifact.data)})`);
        await frames(3);
        await ensureOpen();
        expect(await checked('track')).toBe('true');
        expect(await page.eval<string>(`${q('sb-camera-focus-point')}.innerText`)).toMatch(/world point/);
        expect((await focus()).distanceMeters).toBeCloseTo(await liveDepth(FAR_COLUMN), 4);

        // panel -> agent: Manual keeps the distance the viewport was focused at
        await clickTestId('sb-camera-focus-mode-manual');
        const lens = (await last()).camera.lens;
        expect(lens.focusMode).toBe('manual');
        expect(lens.focusPoint).toBeUndefined();
        expect(lens.focusDistanceMeters).toBeCloseTo(await liveDepth(FAR_COLUMN), 1);
        expect(page.consoleErrors().filter(e => !/favicon/.test(e))).toEqual([]);
    }, 120_000);
});

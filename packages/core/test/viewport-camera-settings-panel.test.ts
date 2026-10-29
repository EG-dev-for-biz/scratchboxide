/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport tool strip's camera settings panel in the
 * REAL Scene3DPrimitive in headless Chrome with real WebGL (the staged-build harness; the command builders are covered by
 * camera-settings-commands.test.ts): the camera button opens and
 * closes the panel (mouse, keyboard, Escape, outside press), edits write sb_set_camera / sb_set_camera_lens into the
 * scene data the agent reads, the viewport draws them, undo reverts them, an agent edit shows in the panel, a picked
 * focus lands in the lens, and a saved pose survives a remount (a reload) of a generated model.
 * Screenshots: test-results/screenshots/camera_toolbar/ (gitignored).
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

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'camera_toolbar');
type Cam = NonNullable<Scene3DData['camera']>;

/** A colonnade as one merged mesh (two rows of square columns receding along -Z, and a floor), like a generated model. */
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
    // the floor as a grid of slabs (paving joints)
    for (let i = 0; i < 6; i++) for (let j = 0; j < 24; j++) box(-6 + i * 2 + 0.05, -0.1, -46 + j * 2 + 0.05, -6 + (i + 1) * 2 - 0.05, 0, -46 + (j + 1) * 2 - 0.05);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-camera-panel-')), 'colonnade.glb');
    writeFixtureGlb(file, { positions, indices } as FixtureMesh);
    return fs.readFileSync(file).toString('base64');
}

const STORED_CAMERA: Cam = { position: [0, 3, 10], target: [0, 2.5, -20], fov: 45 };

describe.skipIf(!stagedChrome.ok)('camera settings panel in the real viewport (headless Chrome)', () => {
    let page: StagedPage;
    let glb: string;
    const scene = (camera: Cam = STORED_CAMERA) => ({
        title: 'Colonnade',
        renderMode: 'clay',
        cameraMode: 'orbit',
        environment: { skybox: 'studio', lighting: 'studio', ground: false },
        pythonGenerator: { sourceCode: '# colonnade fixture', glbBase64: glb },
        camera
    });
    const last = () => page.eval<any>('window.sbHarness.lastUpdate()');
    const q = (testId: string) => `document.querySelector('[data-testid="${testId}"]')`;
    const centre = (testId: string) => page.eval<[number, number]>(`(() => { ${q(testId)}.scrollIntoView({ block: 'nearest' }); const r = ${q(testId)}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const clickTestId = async (testId: string) => { const [x, y] = await centre(testId); await page.click(x, y); await settle(); };
    const settle = (ms = 250) => new Promise(r => setTimeout(r, ms));
    const panelOpen = () => page.eval<boolean>(`!!${q('sb-3d-camera-panel')}`);
    const active = () => page.eval<string | null>('document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.getAttribute("aria-label") ?? null');
    const liveCamera = () => page.eval<{ fov: number; position: number[] }>('(() => { const c = window.__SB_3D_STACK__.camera; return { fov: c.fov, position: [c.position.x, c.position.y, c.position.z] }; })()');
    const optics = () => page.eval<{ drawn: string[]; focusDistanceMeters: number | null; issues: string[] }>('window.__SB_3D_OPTICS__.status');
    /** Screen position of a world point through the live camera. */
    const project = (p: [number, number, number]) => page.eval<[number, number]>(`(() => { const s = window.__SB_3D_STACK__; const v = s.camera.position.clone().set(${p.join(',')}); v.project(s.camera); const r = s.renderer.domElement.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; })()`);
    const setField = async (testId: string, value: string) => {
        await page.eval(`(() => { const el = ${q(testId)}; el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '${value}'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await page.key('Enter');
        await settle();
    };
    /** A press on the tool strip (undo, redo) is outside the panel and closes it: open it again. */
    const ensureOpen = async () => { if (!(await panelOpen())) await clickTestId('sb-3d-camera-settings'); };
    const fieldValue = (testId: string) => page.eval<string>(`${q(testId)}.value`);
    const shot = async (name: string) => {
        const file = await page.screenshot(name);
        expect(fs.statSync(file).size).toBeGreaterThan(20_000);
        return file;
    };

    beforeAll(async () => {
        glb = colonnadeGlb();
        page = await openStagedPage({ width: 1100, height: 720, shotDir: SHOTS });
        await page.eval(`window.__SB_3D_STACK__ = undefined; window.sbHarness.mount(${JSON.stringify(scene())})`);
        await page.waitFor('window.sbHarness.ready() && window.__SB_3D_STACK__.scene.getObjectByName("scratchbox-cpp-generated-root")', 30_000, 'the generated model');
        await settle(600);
    }, 120_000);
    afterAll(async () => { await page?.close(); });

    test('the camera button sits under frame/fit in the tool strip and opens / closes the panel (mouse, Escape, outside press, keyboard)', async () => {
        const order = await page.eval<string[]>(`Array.from(document.querySelectorAll('.sb-3d-toolstrip .sb-3d-toolstrip-btn')).slice(0, 5).map(b => b.getAttribute('title') ?? '')`);
        // the camera button sits in the viewing group after frame/fit (the weather button may sit between them)
        const frameAt = order.findIndex(t => /Frame All/.test(t));
        const cameraAt = order.findIndex(t => /^Camera Settings/.test(t));
        expect(frameAt).toBeGreaterThanOrEqual(0);
        expect(cameraAt).toBeGreaterThan(frameAt);
        expect(cameraAt - frameAt).toBeLessThanOrEqual(2);
        await shot('01_toolbar_camera_icon');

        await clickTestId('sb-3d-camera-settings');
        expect(await panelOpen()).toBe(true);
        expect(await page.eval(`${q('sb-3d-camera-settings')}.getAttribute('aria-expanded')`)).toBe('true');
        expect(await active()).toBe('sb-3d-camera-panel');
        await page.key('Escape');
        await settle();
        expect(await panelOpen()).toBe(false);
        expect(await active()).toBe('sb-3d-camera-settings');

        // keyboard: Enter on the focused button opens, Tab walks into the panel, Escape closes and returns focus
        await page.key('Enter');
        await settle();
        expect(await panelOpen()).toBe(true);
        await page.key('Tab');
        expect(await active()).toBe('Close camera settings');
        await page.key('Tab');
        expect(await active()).toMatch(/^sb-camera-focal-\d+$/); // the first focal-length quick pick
        await page.key('Escape');
        await settle();
        expect(await panelOpen()).toBe(false);
        expect(await active()).toBe('sb-3d-camera-settings');

        // a press outside the panel closes it
        await clickTestId('sb-3d-camera-settings');
        expect(await panelOpen()).toBe(true);
        await page.click(1050, 650);
        await settle();
        expect(await panelOpen()).toBe(false);
    });

    test('the panel shows the scene camera, and 24 mm, depth of field at f/1.4 and a picked focus go through the operators into the scene data', async () => {
        await clickTestId('sb-3d-camera-settings');
        expect(await page.eval<string>(`${q('sb-camera-fov')}.innerText`)).toMatch(/^Field of view\s*45° V · 63\.7° H$/);
        expect(await page.eval<string>(`${q('sb-camera-focal')}.placeholder`)).toMatch(/^29 \(from FOV\)/);
        await shot('02_panel_open');

        await clickTestId('sb-camera-focal-24');
        let s = await last();
        expect(s.camera.fov).toBeCloseTo(53.13, 2);
        expect(s.camera.lens).toMatchObject({ focalLengthMm: 24, sensorWidthMm: 36, sensorHeightMm: 24 });
        expect(s.operatorStack.slice(-2).map((o: { operator: string }) => o.operator)).toEqual(['sb_set_camera', 'sb_set_camera_lens']);
        expect((await liveCamera()).fov).toBeCloseTo(53.13, 2);
        expect(await page.eval<string>(`${q('sb-camera-fov')}.innerText`)).toMatch(/53\.1° V · 73\.7° H/);
        expect(await page.eval(`${q('sb-camera-focal-24')}.getAttribute('aria-pressed')`)).toBe('true');

        await clickTestId('sb-camera-dof');
        await clickTestId('sb-camera-fstop-1.4');
        s = await last();
        expect(s.camera.lens).toMatchObject({ depthOfField: true, apertureFStop: 1.4 });
        expect(await page.eval(`${q('sb-camera-dof')}.getAttribute('aria-checked')`)).toBe('true');
        // with no focus set, depth of field still draws: the viewport measures focus (a85dcc4a), so nothing is reported missing
        await settle(400);
        expect(await page.eval<boolean>(`!!${q('sb-camera-dof-missing')}`)).toBe(false);
        expect((await optics()).drawn).toContain('depth-of-field');

        // pick focus: a click focuses at the clicked point (a merged mesh has no single column to name)
        await clickTestId('sb-camera-pick-focus');
        expect(await page.eval(`${q('sb-camera-pick-focus')}.getAttribute('aria-pressed')`)).toBe('true');
        const columnFace: [number, number, number] = [3.6, 2.5, -16];
        const [cx, cy] = await project(columnFace);
        const expectedDepth = await page.eval<number>(`(() => { const c = window.__SB_3D_STACK__.camera; const f = c.getWorldDirection(c.position.clone()); return c.position.clone().set(${columnFace.join(',')}).sub(c.position).dot(f); })()`);
        await page.click(cx, cy);
        await settle(400);
        s = await last();
        expect(s.camera.lens.focusObjectId).toBeUndefined();
        expect(s.camera.lens.focusDistanceMeters).toBeGreaterThan(expectedDepth - 1);
        expect(s.camera.lens.focusDistanceMeters).toBeLessThan(expectedDepth + 1);
        expect(await page.eval(`${q('sb-camera-pick-focus')}.getAttribute('aria-pressed')`)).toBe('false');
        expect(Number(await fieldValue('sb-camera-focus'))).toBeCloseTo(s.camera.lens.focusDistanceMeters, 3);

        // Alt-click focuses on the whole object and follows it
        await clickTestId('sb-camera-pick-focus');
        await page.click(cx, cy, { alt: true });
        await settle(800);
        s = await last();
        expect(s.camera.lens.focusObjectId).toBe('scratchbox-cpp-generated-root');
        expect(s.camera.lens.focusDistanceMeters).toBeUndefined();
        expect(await page.eval<string>(`${q('sb-camera-focus-object')}.innerText`)).toMatch(/scratchbox-cpp-generated-root/);
        const st = await optics();
        expect(st.drawn).toContain('depth-of-field');
        expect(st.focusDistanceMeters).toBeGreaterThan(5);
        await shot('03_24mm_f1.4_focus_object');
    });

    test('barrel distortion from the k1 field is drawn, a folding k1 is refused with nothing changed, and undo reverts the last edit', async () => {
        await setField('sb-camera-k1', '-0.12');
        let s = await last();
        expect(s.camera.lens.distortion).toMatchObject({ k1: -0.12 });
        await settle(400);
        expect((await optics()).drawn).toContain('lens-distortion');
        expect(Number(await page.eval(`${q('sb-camera-k1-slider')}.value`))).toBeCloseTo(-0.12, 6);
        await shot('04_barrel_k1_-0.12');

        const before = JSON.stringify((await last()).camera);
        await setField('sb-camera-k1', '-0.9');
        expect(await page.eval<string>(`${q('sb-camera-error')}.innerText`)).toMatch(/fold back/);
        expect(JSON.stringify((await last()).camera)).toBe(before);
        expect(await fieldValue('sb-camera-k1')).toBe('-0.12');

        // undo (the tool strip's button): the distortion goes, the panel shows it, the viewport stops drawing it
        await clickTestId('sb-3d-undo');
        await settle(400);
        expect(await panelOpen()).toBe(false); // the undo button is outside the panel
        await ensureOpen();
        s = await last();
        expect(s.camera.lens.distortion).toBeUndefined();
        expect(s.camera.lens.focusObjectId).toBe('scratchbox-cpp-generated-root');
        expect(await fieldValue('sb-camera-k1')).toBe('0');
        expect((await optics()).drawn).not.toContain('lens-distortion');
        await shot('05_after_undo');

        await clickTestId('sb-3d-redo');
        expect((await last()).camera.lens.distortion).toMatchObject({ k1: -0.12 });
        await ensureOpen();
        await clickTestId('sb-camera-distortion-reset');
        expect((await last()).camera.lens.distortion).toBeUndefined();
    });

    test('the agent\'s camera tool and the panel stay in sync both ways', async () => {
        // panel -> agent: the tool runs on the scene the panel wrote (what onUpdate hands the canvas store)
        const fromPanel = await last();
        expect(fromPanel.camera.lens).toMatchObject({ focalLengthMm: 24, apertureFStop: 1.4 });
        const out = await physicalCameraHandlers.configure_physical_camera(
            { focalLengthMm: 85, apertureFStop: 2, focusObjectId: 'scratchbox-cpp-generated-root', sensorFormat: 'full_frame_35mm' },
            { request: { activeArtifact: { id: 's', type: '3d-scene', title: 'Colonnade', version: 3, data: fromPanel } } } as any
        ) as any;
        expect(out.resultPayload.applied).toBe(true);
        const agentScene = out.resultPayload.artifact.data;
        // the tool kept what the panel set that it does not own, and the pose the panel stored
        expect(agentScene.camera.position).toEqual(fromPanel.camera.position);

        // agent -> panel: the tool's scene arrives as the data prop
        await page.eval(`window.sbHarness.update(${JSON.stringify(agentScene)})`);
        await settle(500);
        await ensureOpen();
        expect(await page.eval(`${q('sb-camera-focal-85')}.getAttribute('aria-pressed')`)).toBe('true');
        expect(await page.eval(`${q('sb-camera-fstop-2')}.getAttribute('aria-pressed')`)).toBe('true');
        expect(await fieldValue('sb-camera-fstop')).toBe('2');
        expect(await page.eval<string>(`${q('sb-camera-focus-object')}.innerText`)).toMatch(/scratchbox-cpp-generated-root/);
        expect(await page.eval<string>(`${q('sb-camera-fov')}.innerText`)).toMatch(/16\.1° V · 23\.9° H/);
        expect((await liveCamera()).fov).toBeCloseTo(16.07, 1);
        expect(await page.eval<string>(`${q('sb-3d-undo')}.title`)).toMatch(/Agent:/);
        await shot('06_agent_85mm_in_panel');

        // the agent's step is one undo away, and the panel follows it back
        await clickTestId('sb-3d-undo');
        await settle(300);
        await ensureOpen();
        expect(await fieldValue('sb-camera-fstop')).toBe('1.4');
        expect(await page.eval(`${q('sb-camera-focal-24')}.getAttribute('aria-pressed')`)).toBe('true');
    });

    test('the ends of the 8-200 mm range: 8 mm and 200 mm are drawn, the slider is log-scaled, values outside are clamped', async () => {
        await ensureOpen();
        await clickTestId('sb-camera-focal-8');
        await settle(500);
        let cam = (await last()).camera;
        expect(cam.lens.focalLengthMm).toBe(8);
        expect(cam.fov).toBeCloseTo(112.62, 1);
        expect((await liveCamera()).fov).toBeCloseTo(112.62, 1);
        expect(await page.eval<string>(`${q('sb-camera-fov')}.innerText`)).toMatch(/112\.6° V · 132\.1° H/);
        expect(Number(await page.eval(`${q('sb-camera-focal-slider')}.value`))).toBe(0);
        await shot('07_8mm');

        // the slider's far end is 200 mm
        await page.eval(`(() => { const el = ${q('sb-camera-focal-slider')}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '1000'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await settle(500);
        cam = (await last()).camera;
        expect(cam.lens.focalLengthMm).toBe(200);
        expect(cam.fov).toBeCloseTo(6.867, 2);
        expect((await liveCamera()).fov).toBeCloseTo(6.867, 2);
        await shot('08_200mm');

        // typed values outside the range are clamped to it
        await setField('sb-camera-focal', '4');
        cam = (await last()).camera;
        expect(cam.lens.focalLengthMm).toBe(8);
        expect(cam.fov).toBeCloseTo(112.62, 1);
        expect(await fieldValue('sb-camera-focal')).toBe('8');
        await setField('sb-camera-focal', '500');
        cam = (await last()).camera;
        expect(cam.lens.focalLengthMm).toBe(200);
        expect(await fieldValue('sb-camera-focal')).toBe('200');
        // and a value inside it is taken as typed
        await setField('sb-camera-focal', '62.5');
        expect((await last()).camera.lens.focalLengthMm).toBe(62.5);

        await clickTestId('sb-camera-reset-all');
        cam = (await last()).camera;
        expect(cam.lens).toBeUndefined();
        expect(cam.fov).toBe(45);
    });

    test('a saved camera survives a remount (reload) of the generated model instead of being re-framed; an unsaved one is re-framed', async () => {
        // orbit away, save the view
        await page.drag([800, 400], [700, 380]);
        await settle(300);
        const orbited = (await liveCamera()).position;
        expect(await panelOpen()).toBe(false); // the press in the viewport closed it
        await clickTestId('sb-3d-camera-settings');
        await clickTestId('sb-camera-save-view');
        const saved = (await last()).camera;
        expect(saved.keepPoseOnLoad).toBe(true);
        saved.position.forEach((v: number, i: number) => expect(v).toBeCloseTo(orbited[i], 3));

        // reload: a fresh mount from the stored scene data
        await page.eval(`window.__SB_3D_STACK__ = undefined; window.sbHarness.mount(${JSON.stringify({ ...(await last()) })})`);
        await page.waitFor('window.sbHarness.ready() && window.__SB_3D_STACK__.scene.getObjectByName("scratchbox-cpp-generated-root")', 30_000, 'the remounted model');
        await settle(800);
        const reloaded = (await liveCamera()).position;
        reloaded.forEach((v, i) => expect(v).toBeCloseTo(saved.position[i], 2));
        await shot('06_reload_keeps_saved_camera');

        // the same scene without a saved pose or a lens is framed around the model on load, as before
        await page.eval(`window.__SB_3D_STACK__ = undefined; window.sbHarness.mount(${JSON.stringify(scene({ position: [0, 3, 10], target: [0, 2.5, -20], fov: 45 }))})`);
        await page.waitFor('window.sbHarness.ready() && window.__SB_3D_STACK__.scene.getObjectByName("scratchbox-cpp-generated-root")', 30_000, 'the plain model');
        await settle(800);
        const framed = (await liveCamera()).position;
        expect(Math.hypot(framed[0] - 0, framed[1] - 3, framed[2] - 10)).toBeGreaterThan(1);
        expect(page.consoleErrors().filter(e => !/favicon/.test(e))).toEqual([]);
    });
});

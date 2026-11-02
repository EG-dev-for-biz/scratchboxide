/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A clay view of a staged place with an object standing there (the scene build_3d_object_from_reference makes:
 * renderMode 'pbr' over the place's staged layers), in the REAL viewport (headless Chrome, real WebGL, the real
 * Scene3DPrimitive loader and staged-build hook). Asked from chat, staged_location_material_mode (the real tool, run on
 * the mounted scene) turns the object clay as well as the layers, and the saved scene reopens clay (a reload). The
 * overlay's "Show clay" writes the same scene. Screenshots: test-results/screenshots/staged_material_mode/ (gitignored).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { runStagedMaterialModeTool } from '../src/node/gemini/tools/staged-material-mode-tool';
import { composeStagedArtifact } from '../src/node/3d-engine/staged-location/staged-artifact';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, type FixtureLayerId, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { rewriteGlbJson, writeFixtureGlb, type FixtureMesh } from './helpers/mesh-glb-fixtures';
type Vec3 = [number, number, number];
import { REPO_ROOT } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'staged_material_mode');
const STEP = 16;
const HERO = 'hero-chrome-sphere';

/** A UV sphere of radius 2 resting on y = 0, beside the fixture's arch. */
function sphereMesh(seg = 48): FixtureMesh {
    const positions: number[] = [], normals: number[] = [], indices: number[] = [];
    for (let j = 0; j <= seg; j++) {
        const th = (j / seg) * Math.PI;
        for (let i = 0; i <= seg; i++) {
            const ph = (i / seg) * Math.PI * 2;
            const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
            positions.push(2 * n[0] + 12, 2 * n[1] + 2, 2 * n[2] + 6);
            normals.push(...n);
        }
    }
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
        const a = j * (seg + 1) + i, b = a + seg + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
    return { positions, normals, indices };
}

function chromeHeroGlb(): Buffer {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-staged-mode-'));
    const file = writeFixtureGlb(path.join(dir, 'hero.glb'), sphereMesh());
    rewriteGlbJson(file, g => {
        g.materials = [{ name: 'polished chrome', pbrMetallicRoughness: { baseColorFactor: [0.95, 0.95, 0.95, 1], metallicFactor: 1, roughnessFactor: 0.08 } }];
        g.meshes[0].primitives[0].material = 0;
    });
    const out = fs.readFileSync(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
}

/** Each mesh of the object: clay (the clay render mode's swap) and its metalness. */
const HERO_LOOK = `(() => {
    const out = [];
    window.__SB_3D_EXTERNAL_OBJECTS__.get(${JSON.stringify(HERO)})?.traverse(o => { if (o.isMesh) out.push({ clay: !!o.material.userData.sbClay, metalness: o.material.metalness }); });
    return out;
})()`;

describe.skipIf(!stagedChrome.ok)('staged place with an object: clay from chat and from the overlay, kept over a reload (headless Chrome, real viewport)', () => {
    let fixture: StagedFixtureGlbs;
    let page: StagedPage;
    const L = (l: FixtureLayerId) => fixtureLayer(l, fixture.counts, '/models');

    beforeAll(async () => {
        fixture = buildStagedFixture();
        // drawn at half resolution (the checks read the materials, not pixels): a GPU-less runner's software WebGL draws each
        // of the several hundred frames a test steps about 4x faster
        page = await openStagedPage({ manualFrames: true, shotDir: SHOTS, deviceScaleFactor: 0.5 });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
        page.serve(`${HERO}.glb`, chromeHeroGlb());
    }, 180_000);
    afterAll(async () => { await page?.close(); });

    /** The place staged, with the chrome object standing there in its own materials (renderMode 'pbr'). */
    function placeScene(): Record<string, unknown> {
        const data = stagedSceneData(fixtureState([L('l1'), L('l2')], { runState: 'finished' }));
        const hero = { id: HERO, content: { type: '3d-model', durableUri: `/models/${HERO}.glb`, mimeType: 'model/gltf-binary', metadata: { role: 'hero', description: 'chrome sphere' } }, space: { spatial3d: { x: 0, y: 0, z: 0 } } };
        return { ...data, renderMode: 'pbr', objects: [...(data.objects as unknown[]), hero] };
    }
    async function open(data: Record<string, unknown>): Promise<void> {
        await page.eval(`sbHarness.mount(${JSON.stringify(data)})`);
        await page.waitFor('sbHarness.ready()');
        for (const id of [objectIdOf('l1'), objectIdOf('l2'), HERO]) await page.waitFor(`sbHarness.attached(${JSON.stringify(id)})`, 30_000, `${id} attached`);
        for (let i = 0; i < 600 && (await page.eval<{ phase: string } | null>(`sbHarness.layer(${JSON.stringify(objectIdOf('l2'))})`))?.phase !== 'revealed'; i++) await page.step(1, STEP);
        await page.eval(`sbHarness.setCameraView([6, 5, 3], { theta: 0.6, phi: 1.1, distance: 52 })`);
        // past every reveal (the remount replays it), so the frames show the settled look
        await page.step(120, STEP);
    }
    const heroLook = () => page.eval<Array<{ clay: boolean; metalness: number }>>(HERO_LOOK);
    const toggleText = () => page.eval<string>(`sbHarness.text('[data-testid="sb-staged-materials-toggle"]')`);

    test('chat: staged_location_material_mode clay clays the object too, and the saved scene reopens clay', async () => {
        const opened = placeScene();
        await open(opened);
        expect((await heroLook()).every(m => !m.clay && m.metalness === 1), 'the object starts in its chrome').toBe(true);
        await page.screenshot('1_place_pbr');

        // the turn: the tool runs on the open scene; its artifact is what the chat mounts and saves with the session
        const active = { id: 'scene-stg-test', type: '3d-scene', title: 'chrome sphere at a place', version: 5, data: opened as Scene3DData };
        const out = await runStagedMaterialModeTool({ mode: 'clay' }, { request: { activeArtifact: active } } as never);
        const saved = (out.resultPayload.artifact as { data: Scene3DData }).data;
        expect([saved.renderMode, saved.stagedBuild!.materialMode]).toEqual(['clay', 'clay']);
        await page.eval(`sbHarness.update(${JSON.stringify(saved)})`);
        await page.step(4, STEP);
        const clayed = await heroLook();
        expect(clayed.length).toBeGreaterThan(0);
        expect(clayed.every(m => m.clay), 'the object is clay').toBe(true);
        await page.screenshot('2_chat_clay');

        // reload: the saved session's scene, mounted fresh
        await open(JSON.parse(JSON.stringify(saved)));
        expect((await heroLook()).every(m => m.clay), 'still clay after the reload').toBe(true);
        await page.screenshot('3_chat_clay_reloaded');

        // and back to textures from chat: the object shows its chrome again
        const back = await runStagedMaterialModeTool({ mode: 'textured' }, { request: { activeArtifact: { ...active, data: saved } } } as never);
        const textured = (back.resultPayload.artifact as { data: Scene3DData }).data;
        expect([textured.renderMode, textured.stagedBuild!.materialMode]).toEqual(['pbr', 'textured']);
        await page.eval(`sbHarness.update(${JSON.stringify(textured)})`);
        await page.step(4, STEP);
        expect((await heroLook()).every(m => !m.clay && m.metalness === 1)).toBe(true);
        expect(page.consoleErrors().filter(e => !/favicon/.test(e))).toEqual([]);
    }, 180_000);

    test('overlay: "Show clay" writes the same scene (materialMode and renderMode), and it reopens clay', async () => {
        await open(placeScene());
        expect(await toggleText()).toBe('Show clay');
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await page.step(4, STEP);
        const saved = await page.eval<Scene3DData>('sbHarness.lastUpdate()');
        expect([saved.renderMode, saved.stagedBuild?.materialMode]).toEqual(['clay', 'clay']);
        expect((await heroLook()).every(m => m.clay), 'the object is clay').toBe(true);
        await page.screenshot('4_overlay_clay');

        await open(saved as unknown as Record<string, unknown>);
        expect((await heroLook()).every(m => m.clay), 'still clay after the reload').toBe(true);
        await page.screenshot('5_overlay_clay_reloaded');
        expect(page.consoleErrors().filter(e => !/favicon/.test(e))).toEqual([]);
    }, 180_000);

    test('a running build\'s later commit (renderMode clay, no material mode) keeps the choice made on the open scene', async () => {
        const runStart = placeScene();
        (runStart.stagedBuild as Record<string, unknown>).runState = 'running';
        await open(runStart);
        // the server's next commit of the same run: composeStagedArtifact over the scene the run started from, with one
        // more layer (the fixture is at no real place, so the anchor it requires is left out of the mounted scene)
        const nextCommit = (): Record<string, unknown> => {
            const state = fixtureState([L('l1'), L('l2'), L('l3a')]);
            const layerMeta = Object.fromEntries(state.layers.map(l => [l.objectId, { source: 'Google3DTilesClay', resolvedAddress: 'fixture arch' }]));
            const commit = composeStagedArtifact({
                state, layerMeta, camera: { ...(runStart.camera as { position: Vec3; target: Vec3 }), fov: 60 }, geoAnchor: { lat: 0, lng: 0 },
                activeScene: { id: 'scene-stg-test', type: '3d-scene', title: 'chrome sphere at a place', version: 1, data: runStart } as never,
                summary: 'later commit', version: 2
            });
            const { geoAnchor: _anchor, ...data } = commit.data as Record<string, unknown>;
            expect([data.renderMode, (data.stagedBuild as { materialMode?: string }).materialMode]).toEqual(['clay', undefined]);
            return data;
        };
        const commitAndSettle = async (data: Record<string, unknown>) => {
            await page.eval(`sbHarness.update(${JSON.stringify(data)})`);
            await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf('l3a'))})`, 30_000, 'the new layer attached');
            await page.step(120, STEP);
        };

        // clay from the overlay, then textured again from chat (with no textured twins the overlay offers no way back):
        // the object shows its chrome
        const fromChat = async (mode: 'clay' | 'textured', data: Scene3DData): Promise<Scene3DData> => {
            const active = { id: 'scene-stg-test', type: '3d-scene', title: 'chrome sphere at a place', version: 5, data };
            const out = await runStagedMaterialModeTool({ mode }, { request: { activeArtifact: active } } as never);
            const saved = (out.resultPayload.artifact as { data: Scene3DData }).data;
            await page.eval(`sbHarness.update(${JSON.stringify(saved)})`);
            await page.step(4, STEP);
            return saved;
        };
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await page.step(4, STEP);
        const clayed = await page.eval<Scene3DData>('sbHarness.lastUpdate()');
        expect([clayed.renderMode, clayed.stagedBuild?.materialMode]).toEqual(['clay', 'clay']);
        const chosen = await fromChat('textured', clayed);
        expect([chosen.renderMode, chosen.stagedBuild?.materialMode]).toEqual(['pbr', 'textured']);
        expect((await heroLook()).every(m => !m.clay && m.metalness === 1)).toBe(true);

        // the run commits again: the textured choice holds (it was reset to clay before)
        await commitAndSettle(nextCommit());
        const afterCommit = await heroLook();
        expect(afterCommit.length).toBeGreaterThan(0);
        expect(afterCommit.every(m => !m.clay && m.metalness === 1), 'the object keeps its chrome over the commit').toBe(true);
        expect(await toggleText()).toBe('Show clay');
        await page.screenshot('6_textured_kept_over_commit');

        // a clay choice holds over a commit too, and still remembers the object's mode: textured brings the chrome back
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await page.step(4, STEP);
        await commitAndSettle(nextCommit());
        expect((await heroLook()).every(m => m.clay), 'still clay over the commit').toBe(true);
        await page.screenshot('7_clay_kept_over_commit');
        // the scene the overlay saved: clay, remembering the object's mode
        const kept = await page.eval<Scene3DData>('sbHarness.lastUpdate()');
        expect(kept).toMatchObject({ renderMode: 'clay', stagedBuildView: { renderModeBeforeClay: 'pbr' } });
        const back = await fromChat('textured', kept);
        expect([back.renderMode, back.stagedBuild?.materialMode]).toEqual(['pbr', 'textured']);
        expect((await heroLook()).every(m => !m.clay && m.metalness === 1)).toBe(true);
        expect(page.consoleErrors().filter(e => !/favicon/.test(e))).toEqual([]);
    }, 240_000);
});

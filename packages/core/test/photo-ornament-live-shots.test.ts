/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Screenshots of a finished live run in the real viewport (headless Chrome, WebGL; 1500 px wide): the solid-shaded overview and close-ups
 * of the cornice, the frieze, the spandrels and each statue position, with the provenance toggle off and on. It reads the result a live
 * run wrote (LIVE_SHOTS_RESULT: the StagedLocationResult JSON, LIVE_SHOTS_FIT: the fit's structure_fit.json) and the layers it published
 * under <repo>/public/models, and makes no call of any kind. Skipped unless both are given.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { openStagedPage, stagedChrome } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { REPO_ROOT } from './helpers/requirements';
import { readGlbScene } from '../src/node/spatial/StreetViewPoseRegistrar';

const RESULT = process.env.LIVE_SHOTS_RESULT, FIT = process.env.LIVE_SHOTS_FIT, LABEL = process.env.LIVE_SHOTS_LABEL ?? 'run';
const OUT = path.join(REPO_ROOT, 'test-results', 'screenshots', 'photo_live3');
type V3 = [number, number, number];

describe.skipIf(!RESULT || !FIT || !stagedChrome.ok)('a finished live run in the real viewport', () => {
    it('solid-shaded views and close-ups, with and without the provenance toggle', async () => {
        fs.mkdirSync(OUT, { recursive: true });
        const result = JSON.parse(fs.readFileSync(RESULT!, 'utf8'));
        const fit = JSON.parse(fs.readFileSync(FIT!, 'utf8'));
        const state = result.artifact.data.stagedBuild;
        const camera = result.artifact.data.camera;
        // the fitted structure's frame: the footprint centre, and the outward direction of its widest vertical face
        const outer: Array<[number, number]> = fit.footprint.outer;
        const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length, cz = outer.reduce((s, p) => s + p[1], 0) / outer.length;
        const big = fit.surfaces.filter((s: any) => 'plane' in s.chart && Math.abs(s.chart.plane.normal[1]) < 0.1).sort((a: any, b: any) => b.areaM2 - a.areaM2)[0];
        const n = big.chart.plane.normal as V3;
        const azFront = (Math.atan2(n[0], n[2]) * 180) / Math.PI;
        const baseY = fit.ground.baseY;
        const cam = (target: V3, azDeg: number, elevDeg: number, dist: number) => {
            const a = (azDeg * Math.PI) / 180, e = (elevDeg * Math.PI) / 180;
            return { target, view: { theta: a, phi: Math.PI / 2 - e, distance: dist } };
        };
        // the built elements: their boxes (from the detail layer's named nodes) and the model's own words for them, to aim the close-ups
        const detail = state.layers.find((l: any) => l.layer === 'l4' && !l.retired);
        const spec = detail && result.ornament?.specPath ? (() => { const d = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, result.ornament.specPath), 'utf8')); return (d.value?.spec ?? d.spec ?? d.value) as any; })() : undefined;
        const boxes = new Map<string, { min: V3; max: V3 }>();
        if (detail) {
            const file = path.join(REPO_ROOT, 'public', 'models', path.basename(detail.url));
            const buf = fs.readFileSync(file);
            const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
            const names: string[] = json.nodes.filter((nd: any) => nd.mesh !== undefined).map((nd: any) => nd.name);
            readGlbScene(file).forEach((pr, i) => {
                const mn: V3 = [1e9, 1e9, 1e9], mx: V3 = [-1e9, -1e9, -1e9];
                for (let k = 0; k < pr.positions.length; k += 3) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], pr.positions[k + c]); mx[c] = Math.max(mx[c], pr.positions[k + c]); }
                boxes.set(names[i], { min: mn, max: mx });
            });
        }
        const slotAz = (slotId: string): number => {
            const slot = fit.slots.find((x: any) => x.id === slotId);
            const surfId = slot && ('surface' in slot.host ? slot.host.surface.surfaceId : slot.host.edge.surfaceIds[0]);
            const surf = fit.surfaces.find((x: any) => x.id === surfId);
            const nn = surf && 'plane' in surf.chart ? surf.chart.plane.normal : n;
            return (Math.atan2(nn[0], nn[2]) * 180) / Math.PI;
        };
        const shots: Array<{ name: string; c: ReturnType<typeof cam> }> = [
            { name: 'overview_front', c: cam([cx, baseY + 11, cz], azFront + 25, 12, 62) },
            { name: 'overview_back', c: cam([cx, baseY + 11, cz], azFront + 205, 12, 62) }
        ];
        const aimed = (name: string, pattern: RegExp, dist: number, elev: number, nth = 0) => {
            const hits = (spec?.elements ?? []).filter((e: any) => pattern.test(e.label ?? '') && boxes.has(e.id));
            const e = hits[nth];
            if (!e) return;
            const bx = boxes.get(e.id)!;
            const c: V3 = [(bx.min[0] + bx.max[0]) / 2, (bx.min[1] + bx.max[1]) / 2, (bx.min[2] + bx.max[2]) / 2];
            shots.push({ name: `${name}_${e.id.replace('.', '_')}`, c: cam(c, slotAz(e.slotId), elev, dist) });
        };
        aimed('cornice', /cornice/i, 14, 14);
        aimed('cornice', /cornice/i, 14, 14, 2);
        aimed('frieze', /wreath|frieze/i, 9, 16);
        aimed('medallion', /medallion/i, 9, 8);
        aimed('medallion', /medallion/i, 9, 8, 1);
        aimed('spandrel', /trophy|festoon|eagle/i, 11, 8);
        aimed('spandrel', /trophy|festoon|eagle/i, 11, 8, 1);
        aimed('soffit_coffers', /coffer|rosette/i, 10, 5);
        aimed('figure_group', /figure group/i, 12, 8);
        for (const f of (result.figures ?? []) as any[]) {
            const c: V3 = [(f.boundsM.min[0] + f.boundsM.max[0]) / 2, (f.boundsM.min[1] + f.boundsM.max[1]) / 2, (f.boundsM.min[2] + f.boundsM.max[2]) / 2];
            const az = (Math.atan2(c[0] - cx, c[2] - cz) * 180) / Math.PI;
            shots.push({ name: `statue_${f.id}`, c: cam(c, az, 12, 8) });
        }
        const page = await openStagedPage({ manualFrames: true, shotDir: OUT, width: 1500, height: 940 });
        try {
            for (const l of state.layers) {
                const file = path.join(REPO_ROOT, 'public', 'models', path.basename(l.url));
                if (!fs.existsSync(file)) throw new Error(`layer file missing: ${file}`);
                page.serve(path.basename(l.url), fs.readFileSync(file));
            }
            const data = stagedSceneData(state, { camera });
            await page.eval(`sbHarness.mount(${JSON.stringify({ ...data, objects: [] })})`);
            await page.waitFor('sbHarness.ready()');
            await page.step(6, 16);
            const live = state.layers.filter((l: any) => !l.retired);
            await page.eval(`sbHarness.update(${JSON.stringify(data)})`);
            for (const l of live) for (let i = 0; i < 6000; i++) {
                if (await page.eval<boolean>(`sbHarness.attached(${JSON.stringify(l.objectId)})`)) break;
                await page.step(2, 16);
                if (i === 5999) throw new Error(`${l.objectId} never attached`);
            }
            for (const l of live) for (let i = 0; i < 1200; i++) {
                const f = await page.eval<{ phase: string } | null>(`sbHarness.layer(${JSON.stringify(l.objectId)})`);
                if (f && f.phase === 'revealed') break;
                await page.step(1, 16);
            }
            const shoot = async (suffix: string) => {
                for (const s of shots) {
                    const dx = Math.sin(s.c.view.phi) * Math.sin(s.c.view.theta) * s.c.view.distance, dy = Math.cos(s.c.view.phi) * s.c.view.distance, dz = Math.sin(s.c.view.phi) * Math.cos(s.c.view.theta) * s.c.view.distance;
                    await page.eval(`sbHarness.setCameraView(${JSON.stringify(s.c.target)}, ${JSON.stringify({ theta: Math.atan2(dx, dz), phi: Math.acos(dy / Math.hypot(dx, dy, dz)), distance: Math.hypot(dx, dy, dz) })})`);
                    await page.step(8, 16);
                    await page.screenshot(`${LABEL}_${s.name}${suffix}`);
                }
            };
            await shoot('');
            await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
            await page.step(4, 16);
            await shoot('_prov');
            expect(page.consoleErrors().filter(m => !/favicon/i.test(m))).toEqual([]);
        } finally { await page.close(); }
    }, 900_000);
});

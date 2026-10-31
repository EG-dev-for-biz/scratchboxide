/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The free dry run of a photo-match comparison on real builds (the judge-preregister skill's step 2): photo_match_evaluate's
 * own path on the runs and GLBs a preregistration names, with stand-ins only at the billed edges. Discovery lists the real
 * pano positions an earlier build cached (the Street View metadata cache: no fetch), each "photo" is the reference tile
 * rendered from the requested view, registration is the identity, and the judge is blind and scores by pixel difference.
 * It shows every arm renders at every held-out pose, which panos are excluded, the call count and the region masks; it scores
 * nothing that means anything. Skipped unless PHOTO_MATCH_DRYRUN names a JSON file:
 *   { "root": "<the staged workspace root>", "tile": "<the reference tile's textured GLB>", "out": "<a folder for the grids>",
 *     "args": { ...photo_match_evaluate's arguments: arms, views, runs, clay, judgeRegions... } }
 * Run it with credentials unreachable (empty HOME, a cleared environment): it makes no network call and no model call.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import * as jpeg from 'jpeg-js';
import { renderTriangles, type JudgeClient } from '../src/node/3d-engine/staged-location/photo-match-eval';
import { readTileTriangles, decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import type { PanoCandidate } from '../src/node/3d-engine/staged-location/streetview-evidence';
import { buildGroundModel, geodeticToScan, loadScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';
import { createPhotoMatchEvaluateHandler, type PhotoMatchDeps } from '../src/node/gemini/tools/location-evidence/photo-match-evaluate';
import type { ToolContext } from '../src/node/gemini/tools/types';

const CONFIG = process.env.PHOTO_MATCH_DRYRUN;

describe.skipIf(!CONFIG)('photo-match dry run on real builds (PHOTO_MATCH_DRYRUN)', () => {
    it('renders every arm at every held-out pose with stand-ins at the billed edges', async () => {
        const cfg = JSON.parse(fs.readFileSync(CONFIG!, 'utf8')) as { root: string; tile: string; out: string; args: Record<string, unknown> };
        const street = readTileTriangles(fs.readFileSync(cfg.tile));
        const terrain = buildGroundModel(loadScanMesh(cfg.tile.replace(/textured(_[^/]*)?\.glb$/, (_m, tag) => `geometry${tag ?? ''}.glb`)), { cellMeters: 1 });
        const calls = { textured: 0, clay: 0 };
        const judge: JudgeClient & { requested: string; answeredModel: string; skipped: [] } = {
            requested: 'stand-in', answeredModel: 'stand-in', skipped: [],
            async generate(params) {
                const text = params.contents[0].parts.map(p => p.text ?? '').join(' ');
                const clay = /untextured grey clay/.test(text), regions = /- skyline: /.test(text);
                calls[clay ? 'clay' : 'textured']++;
                const [photo, ...renders] = params.contents[0].parts.filter(p => p.inlineData).map(p => decodeImageInMemory(Buffer.from(p.inlineData!.data, 'base64')));
                const entries = renders.map((r, k) => {
                    let d = 0;
                    for (let i = 0; i < r.rgba.length; i += 4) d += Math.abs(r.rgba[i] - photo.rgba[i]) + Math.abs(r.rgba[i + 1] - photo.rgba[i + 1]) + Math.abs(r.rgba[i + 2] - photo.rgba[i + 2]);
                    const s = Math.max(1, Math.min(10, Math.round(10 - d / (r.rgba.length / 4) / 6)));
                    return clay ? { image: k + 1, shape: s, note: '' } : { image: k + 1, shape: s, materials: s, detail: s, errors: s, overall: s, ...(regions ? { ground: s, neighbours: s, skyline: s } : {}), note: '' };
                });
                return { model: 'stand-in', response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ renders: entries }) }] } }] } };
            }
        };
        const listed: PanoCandidate[] = [];
        const deps: PhotoMatchDeps = {
            stagedRoot: () => cfg.root,
            discover: async (origin, centre, cacheDir) => {
                const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, 'streetview', 'metadata.json'), 'utf8')) as Record<string, { status: string; panoId?: string; lat?: number; lng?: number; date?: string; copyright?: string }>;
                for (const v of Object.values(meta)) {
                    if (v.status !== 'OK' || !v.panoId || listed.some(p => p.panoId === v.panoId) || !/Google/.test(v.copyright ?? '')) continue;
                    const q = geodeticToScan(origin, v.lat!, v.lng!);
                    if (Math.hypot(q.x - centre.x, q.z - centre.z) < 200) listed.push({ panoId: v.panoId, lat: v.lat!, lng: v.lng!, ...(v.date ? { date: v.date } : {}), copyright: v.copyright!, x: q.x, z: q.z });
                }
                return listed;
            },
            grounding: () => ({
                retrieveGroundingImage: async (req: { panoId: string; headingDegree: number; pitchDegree: number; fovDegree: number }) => {
                    const p = listed.find(q => q.panoId === req.panoId)!;
                    const gy = terrain.groundAt(p.x, p.z);
                    const cam = castCamera({ eye: [p.x, (Number.isFinite(gy) ? gy : 0) + 2.5, p.z], headingDeg: req.headingDegree, pitchDeg: -req.pitchDegree, fovDeg: req.fovDegree, widthPx: 640, heightPx: 480 });
                    const r = renderTriangles([street], cam, { supersample: 1 });
                    return { image: Buffer.from(jpeg.encode({ data: Buffer.from(r.rgba), width: 640, height: 480 }, 90).data), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree };
                }
            }) as unknown as ReturnType<PhotoMatchDeps['grounding']>,
            register: async images => images.map(im => ({ panoId: im.view.panoId, edgeResidualPx: { prior: 3, edge: 1 }, correction: { dx: 0, dy: 0, dz: 0, dyawDeg: 0, dpitchDeg: 0, drollDeg: 0 }, reason: 'stand-in: identity' })),
            judge: async () => judge
        };
        const out = await createPhotoMatchEvaluateHandler(() => deps)(cfg.args, { request: { prompt: 'dry run' } as never, workspaceRoot: cfg.root } as unknown as ToolContext);
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 1500)).toBe('completed');
        // every arm rendered something at every pose
        for (const v of r.views) for (const f of Object.values(v.renders) as string[]) expect(fs.statSync(f).size).toBeGreaterThan(1000);
        fs.mkdirSync(cfg.out, { recursive: true });
        r.views.forEach((v: any, k: number) => {
            fs.copyFileSync(v.grid, path.join(cfg.out, `grid_view${k}.png`));
            fs.copyFileSync(v.regions.maskGrid, path.join(cfg.out, `masks_view${k}.png`));
        });
        fs.writeFileSync(path.join(cfg.out, 'report.json'), JSON.stringify({ ...r, standInJudgeCalls: calls }, null, 1));
        console.log(`dry run: ${r.views.length} views, ${listed.length} panos listed, ${r.heldOut.usedByBuild} used by the builds and excluded, stand-in judge calls ${JSON.stringify(calls)}; ${r.context}`);
    }, 1_800_000);
});

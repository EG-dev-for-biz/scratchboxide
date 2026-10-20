/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Checks planted trees' crowns against Street View and records a photo-inferred crown correction for their crowns.json.
 *
 *   npx vite-node scripts/tree_crown_photo_check.ts -- --crowns <crowns.json> --trees <trees.glb> --tiles <geometry.glb> \
 *       --ground <devegetated.glb> --out <dir> [--panos 12] [--record 1]
 *
 * 1. Google-captured panoramas around the trees (the metadata endpoint), each aimed (heading every 10°, elevation 10 or 20°,
 *    fov 90, 3:2) where the most crown ellipsoids (sbTree.crown) 7-45 m away fit whole in the frame, plus one view the other way
 *    (the buildings across the street, for the registration); fetched through the Maps Imagery Grounding API.
 * 2. Every view registered against the tile mesh (runPanoRegistrationOffThread: edges, then jointly).
 * 3. For each tree 7-45 m away whose ellipsoid fits the frame and is at least 30 % in front of nearer trees' outlines: a crop
 *    with the trunk's foot marked goes to the vision model (LOW thinking), which returns the crown's box and the trunk point.
 * 4. The readings that pass rejectReading become the correction (tree-crown-photo-check.ts); with --record 1 it is written to
 *    .scratchbox/cache/crown_correction/<sha256 of crowns.json>.json, where the trees stage picks it up.
 *
 * Images are written exactly as the API returned them (out/img); the crops sent to the model go to out/crops.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { createStagedLocationDeps } from '../packages/core/src/node/3d-engine/staged-location/staged-location-tool';
import { discoverPanos, fetchViews, missingCredentials, STREET_VIEW_EYE_HEIGHT_M } from '../packages/core/src/node/3d-engine/staged-location/streetview-evidence';
import { buildGroundModel, loadScanMesh, localStreetHeight } from '../packages/core/src/node/spatial/StreetViewSurveyPlanner';
import { projectToFrame } from '../packages/core/src/node/spatial/StreetViewPoseRegistrar';
import { runPanoRegistrationOffThread } from '../packages/core/src/node/3d-engine/staged-location/pano-registration-run';
import { castCamera } from '../packages/core/src/node/3d-engine/staged-location/survey-casting';
import { VisionModelChain } from '../packages/core/src/node/gemini/vision-model-chain';
import { crownCorrectionPathFor } from '../packages/core/src/node/3d-engine/tile-vegetation-service';
import {
    crownCorrectionFromReadings, distribution, ellipsoidImageBox, ellipsoidImageMask, perTreeReadings, readCrown, rejectReading, type CheckedTree, type CrownPhotoReading
} from '../packages/core/src/node/3d-engine/staged-location/tree-crown-photo-check';

const requireHere = createRequire(__filename);
const jpeg = requireHere('jpeg-js') as { decode(b: Buffer, o: { useTArray: true }): { width: number; height: number; data: Uint8Array }; encode(i: { data: Uint8Array; width: number; height: number }, q: number): { data: Buffer } };

const W_PX = 1920, H_PX = 1280, FOV = 90;
const PROMPT = 'A street-level photo. A magenta cross marks the foot of ONE tree\'s trunk, where it meets the ground (the ground there may be blurred). Find that tree. ' +
    'Return (1) where its trunk meets the ground, as a point, and (2) the bounding box of ITS crown: its own leaves and branches above the trunk, from its lowest leaves or ' +
    'branches to the top of its crown and from side to side. Tell it apart from neighbouring trees as well as you can; leave out other trees, shrubs and hedges beneath it, ' +
    'buildings, poles and lamps. If no tree stands at the cross, say found false. ' +
    'Reply JSON only: {"found": true|false, "trunk_point_2d": [y, x] in 0-1000 of this image, "crown_box_2d": [ymin, xmin, ymax, xmax] in 0-1000 of this image, ' +
    '"separable": "clear"|"partly"|"merged", "top_visible": true|false, "sides_visible": true|false, "occluded_share": 0..1, "notes": "short"}';

function args(): Record<string, string> {
    const a = process.argv.slice(2).filter(x => x !== '--');
    const out: Record<string, string> = {};
    for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1];
    return out;
}

/** The planted trees' crowns (GLB extras sbTree.crown) with their stems and ground from crowns.json. */
function readTrees(treesGlb: string, crownsJson: string): Array<CheckedTree & { heightM: number }> {
    const b = fs.readFileSync(treesGlb);
    const g = JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12)));
    const crowns = new Map<number, any>((JSON.parse(fs.readFileSync(crownsJson, 'utf8')).crowns as any[]).map(c => [c.id, c]));
    const out: Array<CheckedTree & { heightM: number }> = [];
    for (const n of g.nodes ?? []) {
        const t = n.extras?.sbTree;
        const c = t && crowns.get(t.id);
        if (!t?.crown || !c) continue;
        out.push({ id: t.id, crown: { centre: t.crown.centre, radii: t.crown.radii, yawRad: t.crown.yawRad }, stem: c.stem, groundY: c.supportY, heightM: c.apex[1] - c.supportY });
    }
    return out;
}

async function main(): Promise<void> {
    const a = args();
    for (const k of ['crowns', 'trees', 'tiles', 'ground', 'out']) if (!a[k]) throw new Error(`--${k} is required`);
    const root = process.cwd();
    const out = path.resolve(a.out);
    fs.mkdirSync(path.join(out, 'img'), { recursive: true });
    fs.mkdirSync(path.join(out, 'crops'), { recursive: true });
    const trees = readTrees(a.trees, a.crowns);
    const crownsDoc = JSON.parse(fs.readFileSync(a.crowns, 'utf8'));
    const anchor = crownsDoc.frame.anchor;
    const origin = { lat: anchor.lat, lng: anchor.lng, heightMeters: anchor.ellipsoidalHeightM };
    const deps = await createStagedLocationDeps(root);
    const sv = { ...deps.streetView!, refusedPanos: new Map<string, string>() };
    const missing = missingCredentials(sv);
    if (missing) throw new Error(missing);
    if (!deps.vision || !('client' in deps.vision)) throw new Error(`no vision model: ${(deps.vision as { unavailable?: string })?.unavailable ?? 'not configured'}`);

    // 1. panoramas and views
    let cx = 0, cz = 0;
    for (const t of trees) { cx += t.stem[0]; cz += t.stem[1]; }
    cx /= trees.length; cz /= trees.length;
    const found = await discoverPanos(origin, [], sv, undefined, { x: cx, z: cz });
    const scan = loadScanMesh(a.ground);
    const ground = buildGroundModel(scan, { cellMeters: 1 });
    type Plan = { pano: any; eye: [number, number, number]; heading: number; elev: number; score: number };
    const plans: Plan[] = [];
    for (const p of found.panos) {
        const g = localStreetHeight(scan, ground, p.x, p.z);
        const eye: [number, number, number] = [p.x, (g === g ? g : 0) + STREET_VIEW_EYE_HEIGHT_M, p.z];
        let best: Plan | undefined;
        for (let h = 0; h < 360; h += 10) for (const elev of [10, 20]) {
            const cam = castCamera({ eye, headingDeg: h, pitchDeg: elev, fovDeg: FOV, widthPx: W_PX, heightPx: H_PX });
            let score = 0;
            for (const t of trees) {
                const d = Math.hypot(t.stem[0] - eye[0], t.stem[1] - eye[2]);
                if (d < 7 || d > 45) continue;
                const box = ellipsoidImageBox(cam, t.crown);
                if (box && box.x0 >= 20 && box.x1 <= W_PX - 20 && box.y0 >= 10 && box.y1 <= H_PX - 10) score++;
            }
            if (!best || score > best.score) best = { pano: p, eye, heading: h, elev, score };
        }
        if (best && best.score >= 2) plans.push(best);
    }
    plans.sort((x, y) => y.score - x.score);
    const chosen: Plan[] = [];
    const maxPanos = Number(a.panos ?? 12);
    for (const p of plans) {
        if (chosen.length >= maxPanos) break;
        if (!chosen.some(c => Math.hypot(c.eye[0] - p.eye[0], c.eye[2] - p.eye[2]) < 15)) chosen.push(p);
    }
    const views = chosen.flatMap(c => {
        const base = { panoId: c.pano.panoId, date: c.pano.date, copyright: c.pano.copyright, eye: c.eye, facadeHeadingDeg: c.heading, fovDeg: FOV, aspectRatio: 'RATIO_3X2' as const, distanceM: 20, score: c.score };
        return [{ ...base, headingDeg: c.heading, pitchDeg: c.elev }, { ...base, headingDeg: (c.heading + 180) % 360, pitchDeg: 15 }];
    });
    console.log(`${found.panos.length} Google panos; ${chosen.length} chosen; fetching ${views.length} views`);
    const got = await fetchViews(views, sv, undefined, 60_000);
    // 2. registration
    const reg = await runPanoRegistrationOffThread({ images: got.images.map((im, k) => ({ id: `v${k}`, bytes: im.bytes, widthPx: im.widthPx, heightPx: im.heightPx, view: im.view })), meshFiles: [a.tiles], correspondences: [], faces: [] }, { log: m => console.log(`  ${m}`) });
    const shots = got.images.map((im, k) => {
        const v = im.view;
        const corr = reg.registration?.corrections.get(v.panoId);
        const file = path.join(out, 'img', `v${k}_${v.panoId}_${v.headingDeg}.jpg`);
        fs.writeFileSync(file, im.bytes);
        return {
            k, file, panoId: v.panoId, date: v.date, width: im.widthPx, height: im.heightPx, method: reg.registration?.perPano.find(p => p.panoId === v.panoId)?.method ?? 'nominal',
            cam: castCamera({ eye: v.eye, headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg, widthPx: im.widthPx, heightPx: im.heightPx, ...(corr ? { correction: corr } : {}) })
        };
    });

    // 3. the readings
    const chain = new VisionModelChain<string>({ client: deps.vision.client, candidates: deps.vision.candidates });
    type Job = { s: (typeof shots)[number]; t: CheckedTree & { heightM: number } };
    const jobs: Job[] = [];
    for (const s of shots) {
        const near = trees.map(t => ({ t, d: Math.hypot(t.stem[0] - s.cam.eye[0], t.stem[1] - s.cam.eye[2]) })).filter(o => o.d < 60);
        const masks = new Map(near.map(o => [o.t.id, ellipsoidImageMask(s.cam, o.t.crown)]));
        for (const o of near) {
            if (o.d < 7 || o.d > 45) continue;
            const box = ellipsoidImageBox(s.cam, o.t.crown);
            if (!box || box.x0 < 10 || box.x1 > s.width - 10 || box.y0 < 5 || box.y1 > s.height - 5) continue;
            const m = masks.get(o.t.id)!;
            let own = 0, free = 0;
            for (let i = 0; i < m.length; i += 7) if (m[i]) { own++; if (!near.some(q => q.d < o.d - 0.5 && masks.get(q.t.id)![i])) free++; }
            if (own && free / own >= 0.3) jobs.push({ s, t: o.t });
        }
    }
    console.log(`${jobs.length} tree readings to ask`);
    const decoded = new Map<number, ReturnType<typeof jpeg.decode>>();
    const raw: Array<{ view: number; tree: number; answer?: unknown; reading?: CrownPhotoReading | null; rejected?: string; method: string }> = [];
    const accepted: Array<CrownPhotoReading & { view: number; method: string }> = [];
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
        for (let j; (j = next++) < jobs.length;) {
            const { s, t } = jobs[j];
            if (!decoded.has(s.k)) decoded.set(s.k, jpeg.decode(fs.readFileSync(s.file), { useTArray: true }));
            const img = decoded.get(s.k)!;
            const box = ellipsoidImageBox(s.cam, t.crown)!;
            const foot = projectToFrame(s.cam, [t.stem[0], t.groundY, t.stem[1]]);
            if (!foot) continue;
            const w = box.x1 - box.x0, h = box.y1 - box.y0;
            const crop = { x0: Math.max(0, Math.floor(box.x0 - 0.6 * w)), x1: Math.min(s.width, Math.ceil(box.x1 + 0.6 * w)), y0: Math.max(0, Math.floor(box.y0 - 0.6 * h)), y1: Math.min(s.height, Math.ceil(Math.max(box.y1, foot[1]) + 0.3 * h)) };
            const cw = crop.x1 - crop.x0, ch = crop.y1 - crop.y0;
            const data = new Uint8Array(cw * ch * 4);
            for (let y = 0; y < ch; y++) data.set(img.data.subarray(((crop.y0 + y) * img.width + crop.x0) * 4, ((crop.y0 + y) * img.width + crop.x1) * 4), y * cw * 4);
            const fx = foot[0] - crop.x0, fy = foot[1] - crop.y0, R = Math.max(6, Math.round(Math.min(cw, ch) * 0.012));
            for (let k = -3 * R; k <= 3 * R; k++) for (let e = -1; e <= 1; e++) for (const [x, y] of [[fx + k, fy + e], [fx + e, fy + k]]) {
                const X = Math.round(x), Y = Math.round(y);
                if (X >= 0 && Y >= 0 && X < cw && Y < ch) { const i = (Y * cw + X) * 4; data[i] = 255; data[i + 1] = 0; data[i + 2] = 255; }
            }
            const enc = Buffer.from(jpeg.encode({ data, width: cw, height: ch }, 90).data);
            fs.writeFileSync(path.join(out, 'crops', `v${s.k}_t${t.id}.jpg`), enc);
            try {
                const r = await chain.generate({
                    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: enc.toString('base64') } }, { text: PROMPT }] }],
                    config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 2048 }
                }, { stage: 'crown-check', thinkingBudget: 512 });
                const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
                const ans = JSON.parse(text.replace(/^```json|```$/g, ''));
                const bx = Array.isArray(ans.crown_box_2d) && ans.crown_box_2d.length === 4 ? ans.crown_box_2d.map(Number) : undefined;
                const photoBox = bx ? { x0: crop.x0 + bx[1] / 1000 * cw, x1: crop.x0 + bx[3] / 1000 * cw, y0: crop.y0 + bx[0] / 1000 * ch, y1: crop.y0 + bx[2] / 1000 * ch } : undefined;
                const trunk = Array.isArray(ans.trunk_point_2d) ? { x: crop.x0 + ans.trunk_point_2d[1] / 1000 * cw, y: crop.y0 + ans.trunk_point_2d[0] / 1000 * ch } : undefined;
                const reading = photoBox ? readCrown(s.cam, t, photoBox) : null;
                const rejected = rejectReading({ found: !!ans.found && !!photoBox, ...(photoBox ? { box: photoBox } : {}), ...(trunk ? { trunk } : {}), separable: ans.separable, topVisible: ans.top_visible, occludedShare: ans.occluded_share }, { x: foot[0], y: foot[1] }, reading);
                raw.push({ view: s.k, tree: t.id, answer: ans, reading, method: s.method, ...(rejected ? { rejected } : {}) });
                if (!rejected && reading) accepted.push({ ...reading, view: s.k, method: s.method });
            } catch (err) {
                raw.push({ view: s.k, tree: t.id, rejected: `vision call failed: ${(err as Error).message}`, method: s.method });
            }
        }
    }));

    // 4. the correction
    const per = perTreeReadings(accepted);
    const photos = new Map<number, number>();
    for (const r of accepted) photos.set(r.treeId, (photos.get(r.treeId) ?? 0) + 1);
    const heights = new Map(trees.map(t => [t.id, t.heightM]));
    const corr = crownCorrectionFromReadings(per, trees.map(t => t.id), id => heights.get(id) ?? 1, photos, accepted.length);
    corr.crownsSha256 = crypto.createHash('sha256').update(fs.readFileSync(a.crowns)).digest('hex');
    const D = (k: keyof CrownPhotoReading, rs: CrownPhotoReading[]) => distribution(rs.map(r => r[k] as number));
    const keys: Array<keyof CrownPhotoReading> = ['widthRatio', 'heightRatio', 'photoBaseM', 'modelBaseM', 'photoTopM', 'modelTopM', 'photoWidthM', 'modelWidthM', 'distanceM'];
    const summary = {
        views: shots.length, registered: shots.filter(s => s.method !== 'nominal').length, asked: raw.length, accepted: accepted.length, trees: per.length,
        rejected: raw.reduce<Record<string, number>>((m, r) => (r.rejected ? { ...m, [r.rejected]: (m[r.rejected] ?? 0) + 1 } : m), {}),
        perReading: Object.fromEntries(keys.map(k => [k, D(k, accepted)])), perTree: Object.fromEntries(keys.map(k => [k, D(k, per)])),
        topRatio: distribution(accepted.map(r => r.photoTopM / r.modelTopM)), median: corr.median
    };
    fs.writeFileSync(path.join(out, 'readings.json'), JSON.stringify({ shots: shots.map(({ cam, ...s }) => ({ ...s, cam })), raw }, null, 1));
    fs.writeFileSync(path.join(out, 'correction.json'), JSON.stringify(corr, null, 1));
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
    if (a.record === '1') {
        const dest = crownCorrectionPathFor(root, corr.crownsSha256);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, JSON.stringify(corr, null, 1));
        console.log(`recorded ${dest}`);
    }
    console.log(JSON.stringify(summary.median), `${accepted.length} readings of ${per.length} trees accepted of ${raw.length}`);
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

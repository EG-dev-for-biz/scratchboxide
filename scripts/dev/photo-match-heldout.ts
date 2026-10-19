/**
 * Held-out Street View views for the photo-match evaluator (dev tool; scripts/dev/photo-match-eval.ts judges with them).
 *
 * Panos near the structure that no build used (none of the pano ids in the build's staged-replay recordings), one view
 * each aimed at the structure (its centre; the nearest wall with a wider view when the pano stands close), kept when the
 * structure fills enough of the frame and the full tile mesh does not hide most of it. The images come through the grounding
 * API (recorded into their own replay dir, apart from the builds' recordings) and are posed against the full tile mesh by
 * the app's edge registration (registerPanosByEdges); a view is `locked` when its edge residual ended at most 5 px and lower
 * than it started. The photos are written beside the output JSON (dev only; the app itself never writes Street View bytes).
 *
 *   node -r ts-node/register scripts/dev/photo-match-heldout.ts <payload.json> <tilesDir> <rawIsoClay.glb> <buildRecDir> <heldRecDir> <out.json> [maxViews]
 *   payload.json: the staged build's tool result (place, extraction); tilesDir: its tiles stage entry (geometry.glb);
 *   rawIsoClay.glb: tile_refine's isolated raw scan. HELD_MIN_VIS (default 0.3) is the least share of the structure seen.
 */
import * as fs from 'fs';
import * as path from 'path';
const WT = path.join(__dirname, '../..');
const req = (p: string) => require(path.join(WT, p));
const { readGlbScene, sceneToRenderMesh, renderFrameDepth } = req('packages/core/src/node/spatial/StreetViewPoseRegistrar');
const { geodeticToScan, scanToGeodetic } = req('packages/core/src/node/spatial/StreetViewSurveyPlanner');
const { fetchStreetViewPanoMetadata } = req('packages/core/src/node/spatial/StreetViewPanoramaProjectionService');
const { isGoogleCapture, createStreetViewGroundingImageService } = req('packages/core/src/node/spatial/StreetViewGroundingImageService');
const { fetchViews, bearingDeg, headingDir } = req('packages/core/src/node/3d-engine/staged-location/streetview-evidence');
const { registerPanosByEdges, edgeFramesFromImages } = req('packages/core/src/node/3d-engine/staged-location/pano-edge-registration');
const { castCamera } = req('packages/core/src/node/3d-engine/staged-location/survey-casting');
const { GeminiClient } = req('packages/core/src/node/gemini/gemini-client');
const { StagedReplay } = req('scripts/dev/staged-replay');
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const [payloadFile, tilesDir, rawIso, excludeRec, heldRec, outFile, maxC] = process.argv.slice(2);
const maxCandidates = Number(maxC ?? 12);

function usedPanos(dir: string): Set<string> {
    const s = new Set<string>();
    for (const f of fs.readdirSync(path.join(dir, 'grounding'))) if (f.endsWith('.json')) s.add(JSON.parse(fs.readFileSync(path.join(dir, 'grounding', f), 'utf8')).panoId);
    return s;
}

/** Lowest surface of the mesh under (x, z) within 1.5 m (the street), else NaN. */
function groundAt(V: Float32Array, I: Uint32Array, x: number, z: number): number {
    let best = Infinity;
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const minx = Math.min(V[a], V[b], V[c]), maxx = Math.max(V[a], V[b], V[c]), minz = Math.min(V[a + 2], V[b + 2], V[c + 2]), maxz = Math.max(V[a + 2], V[b + 2], V[c + 2]);
        if (x < minx - 1.5 || x > maxx + 1.5 || z < minz - 1.5 || z > maxz + 1.5) continue;
        // barycentric in xz
        const x1 = V[a], z1 = V[a + 2], x2 = V[b], z2 = V[b + 2], x3 = V[c], z3 = V[c + 2];
        const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
        if (Math.abs(d) < 1e-9) continue;
        const l1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / d, l2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / d, l3 = 1 - l1 - l2;
        if (l1 < -0.3 || l2 < -0.3 || l3 < -0.3) continue;
        const y = l1 * V[a + 1] + l2 * V[b + 1] + l3 * V[c + 1];
        best = Math.min(best, y);
    }
    return Number.isFinite(best) ? best : NaN;
}

(async () => {
    let apiKey = process.env.GOOGLE_MAPS_API_KEY;
    try { apiKey ??= JSON.parse(fs.readFileSync(path.join(WT, 'secrets.json'), 'utf8')).GOOGLE_MAPS_API_KEY; } catch { /* the key must then be in the environment */ }
    const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    const origin = { lat: payload.place.lat, lng: payload.place.lng, heightMeters: payload.extraction.originEllipsoidalHeightM };
    const ctxMesh = sceneToRenderMesh(readGlbScene(path.join(tilesDir, 'geometry.glb')));
    const iso = sceneToRenderMesh(readGlbScene(rawIso));
    const IV = iso.vertices as Float32Array;
    let cx = 0, cz = 0, ymin = Infinity, ymax = -Infinity, n = 0;
    for (let i = 0; i < IV.length; i += 3) { cx += IV[i]; cz += IV[i + 2]; ymin = Math.min(ymin, IV[i + 1]); ymax = Math.max(ymax, IV[i + 1]); n++; }
    cx /= n; cz /= n;
    let R = 0;
    for (let i = 0; i < IV.length; i += 3) R = Math.max(R, Math.hypot(IV[i] - cx, IV[i + 2] - cz));
    console.log(`[held] structure centre ${cx.toFixed(1)}, ${cz.toFixed(1)}, radius ${R.toFixed(1)} m, y ${ymin.toFixed(1)}..${ymax.toFixed(1)}`);
    const exclude = usedPanos(excludeRec);
    console.log(`[held] ${exclude.size} panos used by the builds are excluded`);
    // candidate panos: rings around the structure
    const seen = new Map<string, any>();
    const pts: Array<[number, number]> = [];
    for (const r of [R + 6, R + 14, R + 24, R + 38, R + 55, R + 75, R + 100]) for (let a = 0; a < 360; a += 10) { const [dx, dz] = headingDir(a); pts.push([cx + dx * r, cz + dz * r]); }
    for (let k = 0; k < pts.length; k += 8) {
        await Promise.all(pts.slice(k, k + 8).map(async ([x, z]) => {
            const g = scanToGeodetic(origin, x, 0, z);
            try {
                const m = await fetchStreetViewPanoMetadata({ lat: g.lat, lng: g.lng, radiusMeters: 10, apiKey });
                if (!isGoogleCapture(m.copyright) || exclude.has(m.panoId) || seen.has(m.panoId)) return;
                const q = geodeticToScan(origin, m.lat, m.lng);
                seen.set(m.panoId, { panoId: m.panoId, date: m.date, x: q.x, z: q.z });
            } catch { /* no pano here */ }
        }));
    }
    let cands = [...seen.values()].map(p => ({ ...p, d: Math.hypot(p.x - cx, p.z - cz) })).filter(p => p.d > R * 0.5 + 3 && p.d < R + 110);
    // thin to 10 m, then spread over distance and bearing: sort by a coverage greedy
    const kept: Json[] = [];
    cands.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.panoId.localeCompare(b.panoId));
    for (const p of cands) if (!kept.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 10)) kept.push(p);
    cands = kept;
    const V = ctxMesh.vertices as Float32Array, I = ctxMesh.indices as Uint32Array;
    const views: Json[] = [];
    const rej: string[] = [];
    for (const p of cands) {
        let gy = groundAt(V, I, p.x, p.z);
        if (!Number.isFinite(gy)) { if (p.d > R + 60) { rej.push(`${p.panoId.slice(0,6)} no ground`); continue; } gy = ymin; }
        const eye = [p.x, gy + 2.5, p.z];
        // aim: the structure's nearest point when close (the ground floor), else its centre
        let nx = cx, nz = cz, dn = Infinity;
        for (let i = 0; i < IV.length; i += 30) { const dd = Math.hypot(IV[i] - p.x, IV[i + 2] - p.z); if (dd < dn) { dn = dd; nx = IV[i]; nz = IV[i + 2]; } }
        const close = dn < 22;
        const heading = Math.round(bearingDeg(p.x, p.z, close ? nx : cx, close ? nz : cz) * 10) / 10;
        // the structure must be the first surface along the axis: render depth at the image centre
        const fov = close ? 80 : Math.max(50, Math.min(90, 2 * Math.atan((R * 0.9) / Math.max(1, p.d)) * 180 / Math.PI));
        const mid = ymin + 0.4 * (ymax - ymin);
        const pitch = close ? 12 : Math.max(-5, Math.min(30, Math.atan((mid - eye[1]) / p.d) * 180 / Math.PI));
        const cam = castCamera({ panoId: p.panoId, eye, headingDeg: heading, pitchDeg: pitch, fovDeg: fov, widthPx: 160, heightPx: 120 });
        const isoD = renderFrameDepth(iso, cam), ctxD = renderFrameDepth(ctxMesh, cam);
        let seenPx = 0, isoPx = 0;
        for (let i = 0; i < isoD.length; i++) if (isoD[i] < 1e8) { isoPx++; if (ctxD[i] >= isoD[i] - 0.6) seenPx++; }
        const share = isoPx ? seenPx / isoPx : 0;
        if (isoPx < 160 * 120 * 0.06 || share < (Number(process.env.HELD_MIN_VIS ?? 0.3))) { rej.push(`${p.panoId.slice(0,6)} d=${p.d.toFixed(0)} dn=${dn.toFixed(0)} iso=${(isoPx/19200).toFixed(2)} vis=${share.toFixed(2)}`); continue; }
        views.push({ close, panoId: p.panoId, date: p.date, eye, headingDeg: heading, pitchDeg: Math.round(pitch * 10) / 10, fovDeg: Math.round(fov), aspectRatio: 'RATIO_4X3', distanceM: Math.round(p.d * 10) / 10, facadeHeadingDeg: (heading + 180) % 360, score: share, visibleShare: Math.round(share * 100) / 100, screenShare: Math.round((isoPx / (160 * 120)) * 100) / 100 });
    }
    console.log('[held] rejected: ' + rej.join('; '));
    // spread: nearest, farthest, and the rest by bearing diversity
    views.sort((a, b) => a.distanceM - b.distanceM);
    const pick: Json[] = [];
    const take = (v: Json) => { if (v && !pick.includes(v)) pick.push(v); };
    take(views[0]); take(views[views.length - 1]);
    while (pick.length < Math.min(maxCandidates, views.length)) {
        let best: Json, bs = -1;
        for (const v of views) {
            if (pick.includes(v)) continue;
            const s = Math.min(...pick.map(q => Math.min(Math.abs(q.headingDeg - v.headingDeg), 360 - Math.abs(q.headingDeg - v.headingDeg)) + Math.abs(q.distanceM - v.distanceM)));
            if (s > bs) { bs = s; best = v; }
        }
        take(best);
    }
    console.log(`[held] ${cands.length} unused panos, ${views.length} see the structure, fetching ${pick.length}`);
    const replay = new StagedReplay({ dir: heldRec });
    const gem = new GeminiClient();
    const grounding = replay.wrapGrounding(createStreetViewGroundingImageService(gem));
    const got = await fetchViews(pick, { grounding, mapsApiKey: apiKey });
    for (const f of got.failures) console.log(`[held] ${f.view.panoId}: ${f.error}`);
    const frames = edgeFramesFromImages(got.images.map((im: Json) => ({ id: im.id, bytes: im.bytes, widthPx: im.widthPx, heightPx: im.heightPx, view: im.view })));
    const reg = registerPanosByEdges({ frames, mesh: ctxMesh, budgetMs: 600_000, log: () => undefined });
    const out: Json[] = [];
    for (const im of got.images) {
        const o = reg.panos.find((q: Json) => q.panoId === im.view.panoId);
        const before = o?.edgeResidualPx.prior, after = o?.edgeResidualPx.edge;
        const locked = !!o && after !== null && after <= 5 && !(before !== null && after >= before);
        const file = path.join(path.dirname(outFile), `${path.basename(outFile, '.json')}_${im.view.panoId}.jpg`);
        fs.writeFileSync(file, im.bytes);
        out.push({ ...im.view, id: im.id, widthPx: im.widthPx, heightPx: im.heightPx, photo: file, registration: o ? { chosen: o.chosen, reason: o.reason, edgeResidualPx: o.edgeResidualPx, edgeResidualM: o.edgeResidualM, correction: o.edge } : null, locked });
        console.log(`[held] ${im.view.panoId} d=${im.view.distanceM} m h=${im.view.headingDeg} fov=${im.view.fovDeg} ${im.widthPx}x${im.heightPx}: edge residual ${before} -> ${after} px ${locked ? 'LOCKED' : 'not locked'}`);
    }
    fs.writeFileSync(outFile, JSON.stringify({ origin, centre: [cx, cz], radiusM: R, excluded: [...exclude], views: out }, null, 1));
})().then(() => process.exit(0), e => { console.error('[held] FAILED', e); process.exit(1); });

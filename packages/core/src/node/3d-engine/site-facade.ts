/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade of a real building, read for sizing a procedural script's facade (sb.site_tiers applies it).
 *
 *   - Lower floors: the Street View survey's views of the building (runStreetViewSurvey), read once with the facade
 *     parameter prompt. Labelled photo-inferred, and applied only up to the height those photos can see.
 *   - Upper floors (when the building rises above that): the place's 3D tiles rendered from two high cameras square to
 *     its two longest walls, redrawn as photographs by the image model (AI Beautify, with the Street View views as
 *     references), and read with the same prompt. The sharp detail of a redraw is the image model's, so this reading is
 *     labelled generated. It is cross-checked against a reading of the raw tile render: a value the two disagree on by
 *     more than CROSS_CHECK_TOLERANCE is dropped.
 *   - Every reading is checked against the measured massing: storey height in range and dividing the tiers it covers,
 *     bay width fitting the measured walls. A value that fails is dropped with its reason; the script then keeps norms.
 */

import * as fs from 'fs';
import * as path from 'path';
import { IMAGE_MODEL_PRIORITY } from '../../common/media-generation-protocol';
import type { PinholeCamera } from '../../common/spatial/texture-pass-contracts';
import { buildBeautifyPrompt } from '../../browser/generative-canvas/services/location-beautify-service';
import { VisionModelChain } from '../gemini/vision-model-chain';
import { prepareSurveySite, runStreetViewSurvey } from '../gemini/tools/location-evidence/streetview-survey';
import { createStagedLocationDeps } from './staged-location/staged-location-tool';
import { stagedReplyCache, stagedWorkspaceRoot } from './staged-location/stage-cache';
import { readTileTriangles } from './staged-location/tile-texture-transfer';
import { renderTriangles } from './staged-location/photo-match-eval';
import { encodePng } from './staged-location/png-encode';
import { genAiEnhanceClient } from './staged-location/texture-enhance';
import { facadeParametersPrompt, parseFacadeParameters, type BuildingParameters, type ReadingPictureNote } from './staged-location/version-f/facade-parameters';
import type { SiteMassing } from './site-massing';

/** Two readings of the same value further apart than this (relative) do not confirm each other. */
export const CROSS_CHECK_TOLERANCE = 0.3;
const VISION_HEDGE_AFTER_MS = 25_000;

export interface FacadeOpening { widthM: number; heightM: number; sillM: number; recessM: number; archRiseRatio: number }

/** The generator-facing subset of one reading, every value in metres (colours in linear RGB). */
export interface FacadeValues {
    groundStoreyM?: number;
    upperStoreyM?: number;
    bayWidthM?: number;
    edgeMarginM?: number;
    window?: FacadeOpening;
    groundOpening?: FacadeOpening;
    plinth?: { heightM: number; projectionM: number };
    cornice?: { thicknessM: number; projectionM: number };
    parapetM?: number;
    piers?: { widthM: number; projectionM: number };
    wallRgb?: [number, number, number];
    trimRgb?: [number, number, number];
    glassRgb?: [number, number, number];
}

export interface FacadeReading {
    scope: 'lower' | 'upper';
    /** Heights above the street (m) this reading applies to. */
    appliesFromM: number;
    appliesToM: number;
    provenance: 'photo-inferred' | 'generated';
    confidence: number;
    source: string;
    values: FacadeValues;
    /** Values read and then dropped, with the reason (out of range, not dividing the measured tiers, cross-check). */
    rejected: Record<string, string>;
    /** Values the model did not give (parseFacadeParameters' defaults): not used. */
    unread: string[];
    features: string[];
    pictures: string[];
}

export interface SiteFacade { readings: FacadeReading[]; notes: string[]; cached?: boolean }

/** Bump when the reading (pictures, prompt or cross-check) changes, so cached readings are read again. */
export const SITE_FACADE_VERSION = 'site-facade/v1';
const SITE_FACADE_TTL_MS = 7 * 24 * 3600 * 1000;

export function lookAt(eye: [number, number, number], target: [number, number, number], width: number, height: number, hfovDeg: number): PinholeCamera {
    const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const fl = Math.hypot(f[0], f[1], f[2]);
    const fwd: [number, number, number] = [f[0] / fl, f[1] / fl, f[2] / fl];
    const r = [-fwd[2], 0, fwd[0]];
    const rl = Math.hypot(r[0], r[1], r[2]) || 1;
    const right: [number, number, number] = [r[0] / rl, r[1] / rl, r[2] / rl];
    const up: [number, number, number] = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const fx = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
    return { eye, right, up, fwd, fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

function opening(o: BuildingParameters['window']): FacadeOpening {
    return { widthM: o.widthM, heightM: o.heightM, sillM: o.sillM, recessM: o.recessM, archRiseRatio: o.archRiseRatio ?? 0 };
}

/** The generator-facing values of a parsed reading, leaving out what the model did not give. */
function valuesOf(p: BuildingParameters, defaulted: string[]): FacadeValues {
    const unread = (key: string) => defaulted.some(d => d === key || d.startsWith(`${key}.`));
    const v: FacadeValues = {};
    if (!unread('groundStoreyM')) v.groundStoreyM = p.groundStoreyM;
    if (!unread('upperStoreysM') && p.upperStoreysM.length) v.upperStoreyM = p.upperStoreysM[p.upperStoreysM.length - 1];
    if (!unread('bayWidthM')) v.bayWidthM = p.bayWidthM;
    if (!unread('edgeMarginM')) v.edgeMarginM = p.edgeMarginM;
    if (!unread('window')) v.window = opening(p.window);
    if (!unread('groundOpening')) v.groundOpening = opening(p.groundOpening);
    if (!unread('plinth')) v.plinth = { ...p.plinth };
    if (!unread('cornice')) v.cornice = { ...p.cornice };
    if (!unread('parapet')) v.parapetM = p.parapet.heightM;
    if (!unread('piers')) v.piers = { ...p.piers };
    if (!unread('materials')) {
        v.wallRgb = p.materials.wall.linearRgb; v.trimRgb = p.materials.trim.linearRgb; v.glassRgb = p.materials.glazing.linearRgb;
    }
    return v;
}

/** Drops values that do not fit the measured massing; returns the reasons. */
export function checkAgainstMassing(values: FacadeValues, tiers: Array<{ baseM: number; topM: number }>, wallLengthsM: number[]): Record<string, string> {
    const rejected: Record<string, string> = {};
    const s = values.upperStoreyM;
    if (s !== undefined) {
        // A tier under 1.5 storeys is a terrace, parapet or plant level, not whole storeys: it does not vote. Of the other
        // short tiers (tall ones fit any storey height), most must take a whole number of storeys within 15%.
        const votes = tiers.map(t => t.topM - t.baseM).filter(h => h >= 1.5 * s && h < 25).map(h => {
            const n = Math.max(1, Math.round(h / s));
            return { h, n, off: Math.abs(n * s - h) / h };
        });
        const misses = votes.filter(v => v.off > 0.15);
        const why = s < 2.6 || s > 6 ? `${s.toFixed(2)} m is outside a storey's 2.6-6 m`
            : votes.length && misses.length * 2 > votes.length
                ? `${misses.length} of ${votes.length} measured tiers (${misses.map(m => `${m.h.toFixed(1)} m`).join(', ')}) are not a whole number of ${s.toFixed(2)} m storeys within 15%`
                : '';
        if (why) { rejected.upperStoreyM = why; delete values.upperStoreyM; }
    }
    if (values.groundStoreyM !== undefined && (values.groundStoreyM < 2.8 || values.groundStoreyM > 9)) {
        rejected.groundStoreyM = `${values.groundStoreyM.toFixed(2)} m is outside a ground storey's 2.8-9 m`;
        delete values.groundStoreyM;
    }
    const b = values.bayWidthM, longest = Math.max(0, ...wallLengthsM);
    if (b !== undefined && (b < 1.2 || b > 12 || longest / b < 2)) {
        rejected.bayWidthM = `${b.toFixed(2)} m bays ${b < 1.2 || b > 12 ? 'are outside 1.2-12 m' : `give fewer than 2 on the longest measured wall (${longest.toFixed(1)} m)`}`;
        delete values.bayWidthM;
    }
    if (values.window && values.bayWidthM !== undefined && values.window.widthM > values.bayWidthM * 0.95) {
        rejected.window = `a ${values.window.widthM.toFixed(2)} m window does not fit a ${values.bayWidthM.toFixed(2)} m bay`;
        delete values.window;
    }
    return rejected;
}

/** Drops from `generated` the values `raw` reads more than CROSS_CHECK_TOLERANCE differently. */
export function crossCheck(generated: FacadeValues, raw: FacadeValues): Record<string, string> {
    const rejected: Record<string, string> = {};
    const cmp = (key: string, a: number | undefined, b: number | undefined, drop: () => void) => {
        if (a === undefined || b === undefined) return;
        const d = Math.abs(a - b) / Math.max(1e-6, Math.max(a, b));
        if (d > CROSS_CHECK_TOLERANCE) { rejected[key] = `the redraw reads ${a.toFixed(2)} m, the raw tile render ${b.toFixed(2)} m (${Math.round(d * 100)}% apart)`; drop(); }
    };
    cmp('upperStoreyM', generated.upperStoreyM, raw.upperStoreyM, () => { delete generated.upperStoreyM; });
    cmp('bayWidthM', generated.bayWidthM, raw.bayWidthM, () => { delete generated.bayWidthM; });
    cmp('window', generated.window?.widthM, raw.window?.widthM, () => { delete generated.window; });
    cmp('piers', generated.piers?.widthM, raw.piers?.widthM, () => { delete generated.piers; });
    return rejected;
}

/** Reads the facade of the building at (lat, lng) whose massing is `massing`. Throws when nothing can be read. */
export async function readSiteFacade(massing: SiteMassing, opts: { workspaceRoot: string; signal?: AbortSignal; progress?: (m: string) => void }): Promise<SiteFacade> {
    const notes: string[] = [];
    const progress = opts.progress ?? (() => undefined);
    const outDir = path.join(opts.workspaceRoot, 'build', 'site-facade', `${massing.place.lat.toFixed(5)}_${massing.place.lng.toFixed(5)}`);
    fs.mkdirSync(outDir, { recursive: true });
    // the readings as read (before the massing checks, which run every time): a retry does not pay the survey, image and
    // vision calls again
    const cacheFile = path.join(outDir, 'facade.json');
    const tiersOf = (r: FacadeReading) => massing.tiers.filter(t => t.topM > r.appliesFromM && t.baseM < r.appliesToM);
    const finish = (readings: FacadeReading[], extra: string[], cached: boolean): SiteFacade => {
        const walls = (cachedWalls ?? []);
        const checked = readings.map(r => {
            const values = JSON.parse(JSON.stringify(r.values)) as FacadeValues;
            const rejected = { ...r.rejected, ...checkAgainstMassing(values, tiersOf(r), walls) };
            return { ...r, values, rejected };
        });
        return { readings: checked, notes: extra, ...(cached ? { cached } : {}) };
    };
    let cachedWalls: number[] | undefined;
    try {
        const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (c.version === SITE_FACADE_VERSION && Date.now() - c.builtAtMs < SITE_FACADE_TTL_MS && Array.isArray(c.readings) && c.readings.length) {
            cachedWalls = c.wallLengthsM;
            return finish(c.readings, [...(c.notes ?? []), `facade reading reused from ${new Date(c.builtAtMs).toISOString().slice(0, 10)} (cached 7 days)`], true);
        }
    } catch { /* no cache yet */ }
    const deps = await createStagedLocationDeps(stagedWorkspaceRoot(), opts.signal ? { signal: opts.signal } : {});
    if (!deps.vision || !('client' in deps.vision)) throw new Error(`no vision model is configured to read the facade${deps.vision && 'unavailable' in deps.vision ? ` (${deps.vision.unavailable})` : ''}`);
    const vision = deps.vision;
    const chain = new VisionModelChain<string>({ client: vision.client, candidates: vision.candidates, ...(opts.signal ? { signal: opts.signal } : {}), hedgeAfterMs: VISION_HEDGE_AFTER_MS, replyCache: stagedReplyCache(deps.cache) });
    const read = async (pictures: Array<{ bytes: Uint8Array; mimeType: string; note: ReadingPictureNote }>) => {
        const prompt = facadeParametersPrompt(massing.place.resolvedAs, pictures.map(p => p.note));
        const r = await chain.generate({
            contents: [{ role: 'user', parts: [...pictures.map(p => ({ inlineData: { mimeType: p.mimeType, data: Buffer.from(p.bytes).toString('base64') } })), { text: prompt }] }],
            config: { responseMimeType: 'application/json', temperature: 0 }
        }, { stage: 'grammar' });
        const text = r.response.candidates?.[0]?.content?.parts?.map(q => q.text ?? '').join('') ?? '';
        const parsed = parseFacadeParameters(text);
        r.remember();
        return parsed;
    };

    progress('facade: preparing the place (3D tiles extraction, cached for 7 days)');
    const site = await prepareSurveySite({ lat: massing.place.lat, lng: massing.place.lng, query: massing.place.resolvedAs }, deps, { ...(opts.signal ? { signal: opts.signal } : {}), onProgress: progress });
    const outline = site.structure.outline;
    const walls = outline.map((p, i) => {
        const q = outline[(i + 1) % outline.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const mid: [number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        let n: [number, number] = [(q[1] - p[1]) / len, -(q[0] - p[0]) / len];
        // outward: away from the structure's centroid, whatever the outline's winding
        if (n[0] * (mid[0] - site.structure.centroid.x) + n[1] * (mid[1] - site.structure.centroid.z) < 0) n = [-n[0], -n[1]];
        return { mid, len, n };
    }).filter(w => w.len > 1);
    const wallLengths = walls.map(w => w.len);
    const topM = Math.max(...massing.tiers.map(t => t.topM));
    const readings: FacadeReading[] = [];

    // ---- lower floors: the Street View survey
    progress('facade: Street View survey of the building');
    const sv = deps.streetView ?? {};
    let streetTop = 0;
    const references: Array<{ panoId: string; mimeType: 'image/jpeg' | 'image/png'; bytes: Uint8Array }> = [];
    try {
        const survey = await runStreetViewSurvey(site, { maxViews: 4, outDir: path.join(outDir, 'streetview'), workspaceRoot: opts.workspaceRoot, checkTemporary: false },
            { streetView: { ...sv, refusedPanos: sv.refusedPanos ?? new Map<string, string>() }, ...(opts.signal ? { signal: opts.signal } : {}), onProgress: progress });
        const pictures = survey.views.map(v => {
            const camH = v.camera.position.y - site.structure.groundY;
            const d = Math.min(...walls.map(w => Math.hypot(v.camera.position.x - w.mid[0], v.camera.position.z - w.mid[1])));
            const vfov = 2 * Math.atan(Math.tan((v.request.fovDeg * Math.PI) / 360) * v.heightPx / v.widthPx);
            // the highest point a street photo still shows legibly: its frame's top edge, but no steeper than 55 degrees up
            const up = Math.min((v.request.elevationDeg * Math.PI) / 180 + vfov / 2, (55 * Math.PI) / 180);
            streetTop = Math.max(streetTop, camH + d * Math.tan(up));
            const bytes = fs.readFileSync(v.imagePath);
            references.push({ panoId: v.panoId, mimeType: v.mimeType === 'image/png' ? 'image/png' : 'image/jpeg', bytes });
            return { bytes, mimeType: v.mimeType, note: { role: 'street view', caption: `A Google Street View photo of the facade facing compass ${Math.round(v.faceHeadingDeg)} deg, taken about ${d.toFixed(0)} m from it${v.captureMonth ? ` in ${v.captureMonth}` : ''}; it shows the building up to about ${Math.min(topM, camH + d * Math.tan(up)).toFixed(0)} m above the street.` } };
        });
        streetTop = Math.min(streetTop, topM);
        if (pictures.length) {
            const parsed = await read(pictures);
            const values = valuesOf(parsed.params, parsed.defaulted);
            readings.push({
                scope: 'lower', appliesFromM: 0, appliesToM: streetTop, provenance: 'photo-inferred', confidence: Math.min(0.8, parsed.params.confidence),
                source: `Street View survey, ${pictures.length} view${pictures.length === 1 ? '' : 's'} (© Google), read by the vision model`,
                values, rejected: {}, unread: parsed.defaulted, features: parsed.params.features, pictures: survey.views.map(v => v.imagePath)
            });
        } else notes.push('the Street View survey returned no views of the building');
    } catch (err) {
        notes.push(`Street View survey: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- upper floors: beautified renders of the 3D tiles, cross-checked against the raw render
    const upperFrom = Math.max(streetTop, 0);
    if (topM - upperFrom > 10) {
        progress('facade: rendering the upper floors from the 3D tiles');
        const tile = readTileTriangles(fs.readFileSync(site.extraction.texturedGlb));
        const W = 768, H = 1024, hfov = 40;
        const vfov = 2 * Math.atan(Math.tan((hfov * Math.PI) / 360) * H / W);
        const span = topM - upperFrom, midY = site.structure.groundY + upperFrom + span / 2;
        const chosen = [...walls].sort((a, b) => b.len - a.len).filter((w, i, all) => all.findIndex(o => o.n[0] * w.n[0] + o.n[1] * w.n[1] > 0.7) === i).slice(0, 2);
        const rawPics: Array<{ bytes: Uint8Array; mimeType: string; note: ReadingPictureNote }> = [];
        const genPics: typeof rawPics = [];
        const enhance = genAiEnhanceClient(vision.client);
        for (const [k, w] of chosen.entries()) {
            const d = Math.max((span / 2) / Math.tan(vfov / 2), (w.len / 2) / Math.tan((hfov * Math.PI) / 360)) * 1.15;
            const target: [number, number, number] = [w.mid[0], midY, w.mid[1]];
            const cam = lookAt([w.mid[0] + w.n[0] * d, midY, w.mid[1] + w.n[1] * d], target, W, H, hfov);
            const r = renderTriangles([tile], cam, { supersample: 1 });
            const png = encodePng(r.width, r.height, r.rgba, 4);
            fs.writeFileSync(path.join(outDir, `upper_render_${k}.png`), png);
            const heading = ((Math.atan2(w.n[0], -w.n[1]) * 180) / Math.PI + 360) % 360;
            const caption = `the facade facing compass ${heading.toFixed(0)} deg, ${w.len.toFixed(0)} m wide, seen square-on from ${d.toFixed(0)} m away at mid-height, from about ${upperFrom.toFixed(0)} m to ${topM.toFixed(0)} m above the street`;
            rawPics.push({ bytes: png, mimeType: 'image/png', note: { role: 'tile render', caption: `A render of Google's photogrammetric 3D model of ${caption}; the model is blurry at this height.` } });
            progress(`facade: AI Beautify of the upper floors (${k + 1}/${chosen.length})`);
            try {
                const prompt = buildBeautifyPrompt({ locationName: massing.place.resolvedAs, coords: { lat: massing.place.lat, lng: massing.place.lng }, heading, pitch: 0, fovDegrees: hfov, pitchDegrees: 0, cameraHeightMeters: upperFrom + span / 2, aspectRatio: '3:4' });
                const answer = await enhance({ label: `site-facade-upper-${k}`, models: IMAGE_MODEL_PRIORITY, prompt, image: { mimeType: 'image/png', bytes: png, width: W, height: H }, references: references.slice(0, 2), ...(opts.signal ? { signal: opts.signal } : {}) });
                const file = path.join(outDir, `upper_beautified_${k}.${answer.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`);
                fs.writeFileSync(file, answer.bytes);
                genPics.push({ bytes: answer.bytes, mimeType: answer.mimeType, note: { role: 'redrawn render', caption: `An image model's photographic redraw of a 3D-model render of ${caption}; its sharp detail is the image model's, guided by the model's shapes.` } });
            } catch (err) {
                notes.push(`AI Beautify of the upper floors (${k + 1}): ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (genPics.length) {
            const [gen, raw] = await Promise.all([read(genPics), read(rawPics)]);
            const values = valuesOf(gen.params, gen.defaulted);
            const rawValues = valuesOf(raw.params, raw.defaulted);
            const rejected = crossCheck(values, rawValues);
            readings.push({
                scope: 'upper', appliesFromM: upperFrom, appliesToM: topM, provenance: 'generated', confidence: Math.min(0.5, gen.params.confidence),
                source: `AI Beautify redraw of the 3D tiles (${genPics.length} view${genPics.length === 1 ? '' : 's'}), read by the vision model and cross-checked against the raw tile render`,
                values, rejected, unread: gen.defaulted, features: gen.params.features,
                pictures: chosen.map((_, k) => path.join(outDir, `upper_beautified_${k}.png`)).filter(f => fs.existsSync(f))
            });
        } else notes.push('the upper floors could not be redrawn, so they have no reading');
    }
    if (!readings.length) throw new Error(`nothing could be read of the facade: ${notes.join('; ')}`);
    fs.writeFileSync(cacheFile, JSON.stringify({ version: SITE_FACADE_VERSION, builtAtMs: Date.now(), wallLengthsM: wallLengths, readings, notes }));
    cachedWalls = wallLengths;
    return finish(readings, notes, false);
}

/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The photo-read refinement on the REAL Washington Square Arch (cached tile data; the sized isolate and the whole-tile
 * isolate), with the real engines (tile_refine, scan_fit incl. the ornament builder) and the real selection, casting,
 * anchoring and viewport code, and only the network and the billed calls replaced:
 *   - Street View: a Google capture at every queried point (the real streets are not known offline), images are
 *     synthetic decodable JPEGs (bands of stone, sky and shade), never real imagery;
 *   - the vision model: a fake that READS ITS PROMPT (the survey prompt, then the hints and slot tables of the
 *     reading) and answers in the shapes recorded from the real model; it places nothing the prompt does not offer;
 *   - the figure build: a synthetic figure.
 * Every committed state is replayed into the real viewport (headless Chrome, WebGL) and screenshotted to
 * test-results/screenshots/photo_ornament/. No billed call is made.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { runStagedLocation, type StagedExtraction, type StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readGlbScene } from '../src/node/spatial/StreetViewPoseRegistrar';
import { getScanFitService } from '../src/node/3d-engine/scan-fit-service';
import { getTileRefineService } from '../src/node/3d-engine/tile-refine-service';
import { getTileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import type { StageEvent } from '../src/common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import { archRealData, STAGED_RESULTS_DIR } from './helpers/staged-real-data';
import { openStagedPage, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { REPO_ROOT } from './helpers/requirements';
import { bandJpeg, figureGlb, figuresReply, GREY, SKY, STONE } from './helpers/photo-ornament-fixtures';

const WORK = path.join(REPO_ROOT, 'test-results', 'photo-ornament-e2e');
const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'photo_ornament');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(STAGED_RESULTS_DIR, { recursive: true });
const arch = archRealData();

interface Recorded { tMs: number; e: StageEvent; artifact?: CanvasArtifact }
interface Run { events: Recorded[]; result: any; wallMs: number; log: Log }
interface Log { grounding: Array<{ panoId: string; fov: number; pitch: number; heading: number; aspect: string; kind: 'wide' | 'close' }>; vision: Array<{ kind: string; ms: number; images: number; promptChars: number }>; figureBuilds: number; hints: string[]; replies: string[] }

function standInExtract(texturedSrc: string, anchor: { lat: number; lng: number }, wide: boolean): StagedLocationDeps['extract'] {
    return async req => {
        if (wide) req = { ...req, radiusM: 250 };
        if (req.radiusM > 250) throw new Error(`the stand-in extraction covers 250 m, not ${req.radiusM} m`);
        const textured = path.join(req.outDir, 'textured.glb'), geometry = path.join(req.outDir, 'geometry.glb');
        const n = cropLeaves(texturedSrc, textured, req.radiusM);
        const prims = readGlbScene(textured);
        writeStagedGlbFile(geometry, prims.map((p, i) => ({ name: `tile_${i}`, positions: p.positions, indices: p.indices })));
        const ids = Array.from({ length: n }, (_, i) => `leaf-${i}`);
        return {
            texturedGlb: textured, geometryGlb: geometry, downloadOrder: Object.fromEntries(ids.map((id, i) => [id, i])), leafIds: ids, copyrights: ['Google'],
            fetchedAt: '2026-10-15T12:00:00.000Z', radiusM: req.radiusM, coveredRadiusM: req.radiusM, truncated: false, leafTiles: n,
            leafGeometricErrorM: 2.0064, originEllipsoidalHeightM: -23.5, geoAnchor: anchor
        } as StagedExtraction;
    };
}

/** The textured extraction's leaves that touch the circle of `radiusM` around the anchor; photos untouched. */
function cropLeaves(src: string, dest: string, radiusM: number): number {
    const buf = fs.readFileSync(src);
    const jl = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jl));
    const rest = buf.subarray(20 + jl);
    let kept = 0;
    for (const node of json.nodes as any[]) {
        if (node.mesh === undefined) continue;
        const t = node.translation ?? [0, 0, 0];
        const acc = json.accessors[json.meshes[node.mesh].primitives[0].attributes.POSITION];
        const dx = Math.max(acc.min[0] + t[0], Math.min(0, acc.max[0] + t[0])), dz = Math.max(acc.min[2] + t[2], Math.min(0, acc.max[2] + t[2]));
        if (Math.hypot(dx, dz) <= radiusM) kept++;
        else delete node.mesh;
    }
    const text = Buffer.from(JSON.stringify(json));
    const pad = (4 - (text.length % 4)) % 4;
    const jsonChunk = Buffer.concat([text, Buffer.alloc(pad, 0x20)]);
    const head = Buffer.alloc(20);
    head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jsonChunk.length + rest.length, 8);
    head.writeUInt32LE(jsonChunk.length, 12); head.write('JSON', 16);
    fs.writeFileSync(dest, Buffer.concat([head, jsonChunk, rest]));
    return kept;
}

/** A Google capture at every queried point; synthetic decodable images (stone bands under a sky band), never real imagery. */
function fakeStreetView(log: Log): StagedLocationDeps['streetView'] {
    const fetchImpl = (async (url: string) => {
        const [lat, lng] = new URL(url).searchParams.get('location')!.split(',').map(Number);
        const body = { status: 'OK', pano_id: `PANO_${lat.toFixed(5)}_${lng.toFixed(5)}`, location: { lat, lng }, date: '2025-06', copyright: '© Google' };
        return { ok: true, status: 200, statusText: 'OK', json: async () => body } as any;
    }) as typeof fetch;
    const grounding = {
        retrieveGroundingImage: async (req: any) => {
            const portrait = req.aspectRatio === 'RATIO_3X4';
            log.grounding.push({ panoId: req.panoId, fov: req.fovDegree, pitch: req.pitchDegree, heading: req.headingDegree, aspect: req.aspectRatio, kind: req.fovDegree >= 55 ? 'wide' : 'close' });
            const w = portrait ? 240 : 320, h = portrait ? 320 : 240;
            const h8 = crypto.createHash('md5').update(req.panoId).digest()[0];
            const tone: [number, number, number] = [STONE[0] - (h8 % 20), STONE[1] - (h8 % 17), STONE[2] - (h8 % 23)];
            return { image: bandJpeg([SKY, tone, tone, GREY], w, h), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree };
        }
    };
    return { mapsApiKey: 'maps-key', grounding, fetchImpl } as never;
}

const textsOf = (params: any): string => JSON.stringify((params.contents?.[0]?.parts ?? []).filter((p: any) => p.text).map((p: any) => p.text));
const flat = (s: string) => JSON.parse(s).join('\n') as string;

/**
 * A vision stand-in that reads its prompt. The survey: for every image a grid of boxes (it cannot know the fit's slots,
 * which is the point: the SLOTS come from casting). The reading: for every "the survey saw ..." hint line it writes an
 * element in the hinted slot with the hinted count and pitch (a few percent off, like an estimate), citing the polygon
 * of that slot in a close-up that shows it. The figures: a spec per image.
 */
function fakeVision(log: Log): NonNullable<StagedLocationDeps['vision']> {
    const client = {
        models: {
            generateContent: async () => { throw new Error('streaming expected'); },
            generateContentStream: async (params: any) => {
                const t0 = Date.now();
                const text0 = flat(textsOf(params));
                const images = (params.contents[0].parts as any[]).filter(p => p.inlineData).length;
                let reply: unknown;
                let kind = 'other';
                if (/surveying one real structure/.test(text0)) {
                    kind = 'survey';
                    reply = { faces: Array.from({ length: images }, (_, image) => ({
                        image,
                        elements: [
                            { kind: 'repeated course', box: [180, 60, 250, 940], sizeRatio: [0.02, 0.04], repeat: { count: 24, pitchRatio: 0.036, axis: 'h' }, material: 'cut stone, smooth finish', weathering: 'light soiling', confidence: 78 },
                            { kind: 'carved band', box: [280, 80, 360, 920], sizeRatio: [0.06, 0.08], repeat: { count: 7, pitchRatio: 0.12, axis: 'h' }, material: 'carved stone relief', weathering: 'streaked', confidence: 60 },
                            { kind: 'panel', box: [420, 120, 640, 400], sizeRatio: [0.28, 0.22], material: 'carved stone relief', weathering: 'weathered edges', confidence: 55 },
                            { kind: 'panel', box: [420, 600, 640, 880], sizeRatio: [0.28, 0.22], material: 'carved stone relief', weathering: 'weathered edges', confidence: 55 },
                            { kind: 'opening', box: [560, 380, 980, 620], material: 'dressed stone', weathering: 'sooty', confidence: 70 }
                        ],
                        materials: [{ description: 'pale marble ashlar in courses', where: 'the whole face', weathering: 'grey soiling' }]
                    })) };
                } else if (/reading standing figures/.test(text0)) {
                    kind = 'figures';
                    const dims = [...text0.matchAll(/\[(\d+)\] Google Street View crop[^\n]*?\(width ([\d.]+) m, height ([\d.]+) m, depth ([\d.]+) m\)/g)].map(m => ({ i: Number(m[1]), w: Number(m[2]), h: Number(m[3]), d: Number(m[4]) }));
                    reply = { figures: dims.map(x => ({ image: x.i, confidence: 66, spec: { ...(figuresReply([0]) as any).figures[0].spec, boundingMeters: [x.w, x.h, x.d] } })) };
                } else if (/reading architectural ornament/.test(text0)) {
                    kind = 'ornament';
                    const slotLen = new Map<string, number>();
                    const slotSize = new Map<string, [number, number]>();
                    for (const m of text0.matchAll(/^(S\d+): (surface \w+|edge along [\w+]+, ([\d.]+) m), ([\d.]+) × ([\d.]+) m/gm)) { if (m[3]) slotLen.set(m[1], Number(m[3])); slotSize.set(m[1], [Number(m[4]), Number(m[5])]); }
                    const inImages = new Map<string, number>();
                    const polys = new Map<string, number[]>();
                    for (const m of text0.matchAll(/\[(\d+)\] ([^\n]*)/g)) for (const p of m[2].matchAll(/(S\d+) → (\[[\d,]+\])/g)) if (!polys.has(`${m[1]}:${p[1]}`)) polys.set(`${m[1]}:${p[1]}`, JSON.parse(p[2]));
                    // the first image that shows the slot AND has its polygon (the tile orthos have none: the close-ups do)
                    for (const m of text0.matchAll(/^(S\d+):.*in images \[([\d, ]*)\]/gm)) { const idx = m[2].split(',').map(x => x.trim()).filter(Boolean).map(Number).find(i => polys.has(`${i}:${m[1]}`)); if (idx !== undefined) inImages.set(m[1], idx); }
                    const elements: unknown[] = [];
                    log.hints.push(...text0.split('\n').filter(l => /the survey saw/.test(l)));
                    for (const h of text0.matchAll(/^(S\d+): the survey saw "([^"]+)".*?(?:running ([\d.]+)-([\d.]+) m along the edge|([\d.]+) × ([\d.]+) m on the face(?:, inside the slot over u ([\d.-]+)-([\d.-]+) m, v ([\d.-]+)-([\d.-]+) m, with most room at u ([\d.-]+) m, v ([\d.-]+) m \(about ([\d.]+) m clear)?)(?:, (\d+) repeats \((\w)\) about (\d+) mm per cell)?/gm)) {
                        const slot = h[1], img = inImages.get(slot);
                        const poly = img !== undefined ? polys.get(`${img}:${slot}`) : undefined;
                        if (img === undefined || !poly) continue;
                        const ys = poly.filter((_, i) => i % 2 === 0), xs = poly.filter((_, i) => i % 2 === 1);
                        const box = [img, Math.round(Math.min(...ys)), Math.round(Math.min(...xs)), Math.round(Math.max(...ys)), Math.round(Math.max(...xs))];
                        const L = slotLen.get(slot);
                        if (h[3] !== undefined && L && h[14]) {
                            const a = Number(h[3]);
                            // a percent or two off, as an estimate is (inside the 0.31 m the scan allows: it is snapped to the located run)
                            elements.push({ slot, op: { replicate: { seed: { sweep: { t: [0, 8], profile: [0, 0, 220, 0, 220, 140, 0, 140] } }, along: [Math.round((a / L) * 1000), Math.round(Number(h[16]) * 1.015), Number(h[14])] } }, conf: 66, depthBasis: 'shadow in the gaps', ev: [box], label: h[2] });
                        } else if (L && h[3] !== undefined) {
                            elements.push({ slot, op: { sweep: { t: [Math.round((Number(h[3]) / L) * 1000), Math.round((Number(h[4]) / L) * 1000)], profile: [0, 0, 120, 0, 120, 90, 0, 90] } }, conf: 60, depthBasis: 'silhouette', ev: [box], label: h[2] });
                        } else if (h[7] !== undefined) {
                            // placed where the hint says the element stands, inside the slot, in the chart axes the reply uses
                            const cu = Number(h[11]), cv = Number(h[12]);
                            const R = Math.max(40, Math.round(Math.min(400, 800 * Number(h[13]))));
                            elements.push({ slot, op: { revolve: { at: [Math.round(cu * 1000), Math.round(cv * 1000)], axis: 'n', profile: [0, 0, R, 0, R, 90, 0, 120] } }, conf: 58, depthBasis: 'rim highlight', ev: [box], label: h[2] });
                        }
                    }
                    reply = { elements: elements.slice(0, 40), corrections: [], emptySlots: [] };
                    log.replies.push(JSON.stringify(reply).slice(0, 1500));
                } else {
                    throw new Error('the vision stand-in was asked something it does not know');
                }
                log.vision.push({ kind, ms: Date.now() - t0, images, promptChars: text0.length });
                const body = JSON.stringify(reply);
                return (async function* () { yield { candidates: [{ content: { parts: [{ text: body }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001`, usageMetadata: { promptTokenCount: 6000, candidatesTokenCount: 900, thoughtsTokenCount: 80 } } as any; })();
            }
        }
    };
    return { client: client as never, candidates: ['gemini-4-argon'] };
}

function realDeps(root: string, wide: boolean, log: Log): StagedLocationDeps {
    const anchor = { lat: 40.73122, lng: -73.99709 };
    const fit = getScanFitService(root);
    const refine = getTileRefineService(root);
    const veg = getTileVegetationService(root);
    return {
        cache: new StageCache({ workspaceRoot: root }),
        geocode: async () => ({ ...anchor, formattedAddress: 'Washington Square Arch, Washington Square N, New York, NY' }),
        extract: standInExtract(arch.data!.textured, anchor, wide),
        vegetation: { strip: req => veg.strip(req), plant: req => veg.plant(req), canopy: (req: any) => (veg as any).canopy(req) },
        refine: { refine: req => refine.refine(req) },
        scanFit: { fit: req => fit.fit(req), refit: req => fit.refit(req), ornament: req => fit.ornament(req), flatten: req => fit.flatten(req) },
        streetView: fakeStreetView(log),
        vision: fakeVision(log),
        figureBuilder: async spec => { log.figureBuilds++; const [w, h, d] = spec.boundingMeters; return { glb: figureGlb(w, h, d) }; },
        newRunId: () => crypto.randomBytes(4).toString('hex')
    };
}

async function record(request: any, deps: StagedLocationDeps, log: Log): Promise<Run> {
    const events: Recorded[] = [];
    const t0 = Date.now();
    const { result } = await runStagedLocation(request, deps, { emitStage: (e, artifact) => events.push({ tMs: Date.now() - t0, e, artifact }) });
    return { events, result, wallMs: Date.now() - t0, log };
}

function report(label: string, run: Run): string {
    const r = run.result;
    const rows = r.stages.map((s: any) => `${String(s.stage).padEnd(9)} ${String(s.status).padEnd(9)} ${String(s.timings?.ms ?? '-').padStart(7)} ms  ${s.cost ? `${s.cost.images} img ${s.cost.visionCalls} call ${s.cost.seconds}s  ` : ''}${(s.source || s.reason || '').slice(0, 150)}`);
    const wide = run.log.grounding.filter(g => g.kind === 'wide').length, close = run.log.grounding.filter(g => g.kind === 'close').length;
    const text = [
        `[photo-ornament ${label}] wall ${run.wallMs} ms, status ${r.status}; images ${wide} wide + ${close} close-up; vision ${run.log.vision.map(v => v.kind).join(', ')}; figure builds ${run.log.figureBuilds}`,
        ...rows.map((x: string) => '  ' + x),
        `  layers: ${(r.artifact.data.stagedBuild.layers as any[]).filter(l => !l.retired).map(l => `${l.layer}:${l.provenance.label}:${l.counts.triangles}t`).join(', ')}`,
        `  degradations: ${r.degradations.map((d: any) => `${d.stage}/${d.reasonCode}: ${String(d.reason).slice(0, 140)}`).join(' | ') || 'none'}`,
        `  survey: ${r.materialHints ? r.materialHints.faces.map((f: any) => `${Math.round(f.headingDeg)}deg ${f.skipped ? 'skipped' : `${f.elements.length} el ${f.palette?.colours.length ?? 0} col`}`).join('; ') : 'none'}`,
        `  ornament: ${r.ornament ? `${r.ornament.elements} elements; located ${JSON.stringify(r.ornament.surveyLocated)}; anchoring ${r.ornament.anchoring?.length ?? 0}` : 'none'}`,
        `  figures: ${JSON.stringify(r.figures ?? [])}`,
        `  photoCost: ${JSON.stringify(r.photoCost)}`,
        `  hints sent to the reading:\n    ${run.log.hints.join('\n    ') || '(none)'}`,
        `  dropped by the checks: ${JSON.stringify((r.degradations as any[]).filter(d => d.stage === 'vision' || d.stage === 'detail').map(d => `${d.reasonCode}: ${String(d.reason).slice(0, 160)}`))}`
    ].join('\n');
    fs.writeFileSync(path.join(STAGED_RESULTS_DIR, `photo_ornament_${label}.txt`), text);
    fs.writeFileSync(path.join(STAGED_RESULTS_DIR, `photo_ornament_${label}_result.json`), JSON.stringify({ stages: r.stages, degradations: r.degradations, ornament: r.ornament, materialHints: r.materialHints, figures: r.figures, photoCost: r.photoCost, grounding: run.log.grounding, vision: run.log.vision }, null, 1));
    return text;
}

const STEP = 16;
async function advanceTo(page: StagedPage, id: string, p: number): Promise<void> {
    for (let i = 0; i < 1200; i++) {
        const f = await page.eval<{ phase: string; progress: number } | null>(`sbHarness.layer(${JSON.stringify(id)})`);
        if (f && (f.phase === 'revealed' || (f.phase === 'revealing' && f.progress >= p))) return;
        await page.step(1, STEP);
    }
    throw new Error(`${id} never reached ${p}`);
}

/** Replays the committed states in build order into the real viewport, one screenshot per state, then the provenance view. */
async function render(label: string, root: string, run: Run): Promise<string[]> {
    const shots: string[] = [];
    const page = await openStagedPage({ manualFrames: true, shotDir: SHOTS, width: 1280, height: 800 });
    try {
        const served = new Set<string>();
        const serveAll = (state: any) => {
            for (const l of state.layers) {
                const name = path.basename(l.url);
                if (served.has(name)) continue;
                const file = path.join(root, 'public', 'models', name);
                if (!fs.existsSync(file)) throw new Error(`layer file missing: ${file}`);
                page.serve(name, fs.readFileSync(file));
                served.add(name);
            }
        };
        const states = run.events.filter(r => r.artifact && (r.artifact as any).data?.stagedBuild);
        let mounted = false;
        const seen = new Set<string>();
        for (const r of states) {
            const state = (r.artifact as any).data.stagedBuild;
            const camera = (r.artifact as any).data.camera;
            serveAll(state);
            const data = stagedSceneData(state, { camera });
            if (!mounted) {
                await page.eval(`sbHarness.mount(${JSON.stringify({ ...data, objects: [] })})`);
                await page.waitFor('sbHarness.ready()');
                await page.step(6, STEP);
                mounted = true;
            }
            await page.eval(`sbHarness.update(${JSON.stringify(data)})`);
            const fresh = state.layers.filter((l: any) => !l.retired && !seen.has(l.objectId));
            for (const l of fresh) { await page.waitFor(`sbHarness.attached(${JSON.stringify(l.objectId)})`, 60_000); seen.add(l.objectId); }
            for (const l of fresh) await advanceTo(page, l.objectId, 1);
            await page.step(4, STEP);
            const stageNote = fresh.map((l: any) => l.layer).join('+') || 'state';
            const name = `${label}_${String(r.e.seq).padStart(2, '0')}_${r.e.stage}_${r.e.status}_${stageNote}`;
            await page.screenshot(name);
            shots.push(name);
        }
        // close-ups of what the stages added: each figure, and the arch's top where the detail went, in the finished scene (clay), then the same in the provenance view
        const finalState = (run.result.artifact as any).data.stagedBuild;
        const finalCamera = (run.result.artifact as any).data.camera;
        const closeups: Array<{ name: string; camera: { position: [number, number, number]; target: [number, number, number] } }> = [];
        for (const f of (run.result.figures ?? []) as any[]) {
            const c = [(f.boundsM.min[0] + f.boundsM.max[0]) / 2, (f.boundsM.min[1] + f.boundsM.max[1]) / 2, (f.boundsM.min[2] + f.boundsM.max[2]) / 2];
            const d = Math.hypot(c[0], c[2]) || 1;
            closeups.push({ name: `closeup_${f.id}`, camera: { position: [c[0] + (c[0] / d) * 8, c[1] + 2.5, c[2] + (c[2] / d) * 8], target: c as [number, number, number] } });
        }
        const st = (run.result.structure ?? {}) as any;
        closeups.push({ name: 'closeup_top', camera: { position: [14, 30, -22], target: [0, 21, 0] } });
        const shoot = async (suffix: string) => {
            for (const cu of closeups.slice(0, 3)) {
                const dx = cu.camera.position[0] - cu.camera.target[0], dy = cu.camera.position[1] - cu.camera.target[1], dz = cu.camera.position[2] - cu.camera.target[2];
                const dist = Math.hypot(dx, dy, dz);
                await page.eval(`sbHarness.setCameraView(${JSON.stringify(cu.camera.target)}, ${JSON.stringify({ theta: Math.atan2(dx, dz), phi: Math.acos(dy / dist), distance: dist })})`);
                await page.step(8, STEP);
                await page.screenshot(`${label}_${cu.name}${suffix}`);
                shots.push(`${label}_${cu.name}${suffix}`);
            }
        };
        await shoot('');
        void st; void finalCamera;
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(4, STEP);
        await page.screenshot(`${label}_provenance`);
        shots.push(`${label}_provenance`);
        await shoot('_prov');
        const overlay = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-overlay"]')`);
        fs.writeFileSync(path.join(STAGED_RESULTS_DIR, `photo_ornament_${label}_overlay.txt`), overlay);
        const legend = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-legend"]')`);
        fs.writeFileSync(path.join(STAGED_RESULTS_DIR, `photo_ornament_${label}_legend.txt`), legend);
        expect(page.consoleErrors().filter(m => !/favicon/i.test(m))).toEqual([]);
    } finally { await page.close(); }
    return shots;
}

const fresh = (name: string) => { const root = path.join(WORK, name); fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); return root; };
const newLog = (): Log => ({ grounding: [], vision: [], figureBuilds: 0, hints: [], replies: [] });

describe.skipIf(!arch.requirement.ok || !stagedChrome.ok)('photo-read refinement on the real Washington Square Arch (real engines, replayed vision, synthetic Street View)', () => {
    it('the sized isolate: survey, locate, close-ups, reading, anchoring, figures; every state replayed in the real viewport', async () => {
        const root = fresh('sized');
        const log = newLog();
        const run = await record({ query: 'Washington Square Arch', isolate: true, trees: false }, realDeps(root, false, log), log);
        console.log(report('sized', run));
        const shots = await render('sized', root, run);
        console.log(`[photo-ornament sized] screenshots ${shots.join(', ')}`);
        const stage = (id: string) => run.result.stages.find((s: any) => s.stage === id);
        expect(stage('tiles').status).toBe('committed');
        expect(stage('survey')).toBeDefined();
        // whatever the real fit decided, the survey ran beside it and never took long enough to hold the run
        expect(['committed', 'degraded']).toContain(stage('survey').status);
        expect(run.log.grounding.filter(g => g.kind === 'wide').length).toBeLessThanOrEqual(4);
        expect(run.log.grounding.filter(g => g.kind === 'close').length).toBeLessThanOrEqual(8);
        expect(run.log.vision.filter(v => v.kind === 'survey').length).toBe(1);
    }, 1_800_000);

    it('the whole-tile isolate: the fit is accepted, pass 2 runs on the real fitted faces', async () => {
        const root = fresh('wide');
        const log = newLog();
        const run = await record({ query: 'Washington Square Arch', isolate: true, trees: false }, realDeps(root, true, log), log);
        console.log(report('wide', run));
        const shots = await render('wide', root, run);
        console.log(`[photo-ornament wide] screenshots ${shots.join(', ')}`);
        const stage = (id: string) => run.result.stages.find((s: any) => s.stage === id);
        expect(stage('fit').status).toBe('committed');
        expect(stage('survey').cost.visionCalls).toBe(1);
        expect(run.log.vision.filter(v => v.kind === 'survey').length).toBe(1);
        expect(run.log.vision.filter(v => v.kind === 'ornament').length).toBeLessThanOrEqual(2);
        expect(run.log.vision.filter(v => v.kind === 'figures').length).toBeLessThanOrEqual(1);
        for (const l of (run.result.artifact.data.stagedBuild.layers as any[]).filter(x => x.layer === 'l4' || x.layer === 'l4f')) expect(l.counts.triangles).toBeGreaterThan(0);
    }, 1_800_000);
});

afterAll(() => undefined);

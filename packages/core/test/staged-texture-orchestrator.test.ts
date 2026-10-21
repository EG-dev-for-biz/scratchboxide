/**
 * The texture pass as a stage of the staged location build (orchestrator.ts 'textures'): a background stage that
 * starts after the fit commit, never delays the clay layers, publishes each layer's textured twin as a cached variant
 * (StagedLayer.textured), reports the TexturePassRecord in the result and an honest summary with the 'Show real
 * textures' pill, and degrades to clay when it fails. Synthetic world, fake engines, no network, no model calls.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runStagedLocation, type ScanFitDeps, type StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { validateContract, type StageEvent } from '../src/common/spatial/staged-location-contracts';
import { TEXTURE_LADDER_RUNGS } from '../src/common/spatial/texture-pass-contracts';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import { SHOW_CLAY_PILL, SHOW_TEXTURES_PILL } from '../src/node/3d-engine/staged-location/staged-summary';
import { TEXTURE_PASS_VERSION } from '../src/node/3d-engine/staged-location/texture-pass';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/texture-processing';
import { building, fakeNative, readTris, writeTris, type Tri, type WorldSpec } from './helpers/staged-synthetic-world';
import { structureFit } from './helpers/staged-location-fixtures';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { parseGlbNodes } from '../src/node/3d-engine/staged-location/glb-nodes';
import { area, lump, noise, patch } from './helpers/redundant-scan-fixtures';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-staged-tex-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ARCH: WorldSpec = { ground: 40, buildings: [[-13, 13, -6, 5, 22]], trees: [] };

/** Rewrites a fake extraction's triangles as a photo-textured GLB: planar UVs by dominant axis, a striped stone photo. */
function photoTexture(file: string): void {
    const tris: Tri[] = readTris(file);
    const pos = new Float32Array(tris.length * 9), uv = new Float32Array(tris.length * 6);
    tris.forEach((t, k) => {
        pos.set(t, k * 9);
        const e1 = [t[3] - t[0], t[4] - t[1], t[5] - t[2]], e2 = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
        const n = [Math.abs(e1[1] * e2[2] - e1[2] * e2[1]), Math.abs(e1[2] * e2[0] - e1[0] * e2[2]), Math.abs(e1[0] * e2[1] - e1[1] * e2[0])];
        const axis = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2;
        for (let j = 0; j < 3; j++) {
            const p = [t[j * 3], t[j * 3 + 1], t[j * 3 + 2]];
            const [a, b] = axis === 0 ? [p[2], p[1]] : axis === 1 ? [p[0], p[2]] : [p[0], p[1]];
            uv[k * 6 + j * 2] = a / 8; uv[k * 6 + j * 2 + 1] = 1 - b / 8;
        }
    });
    const W = 128, rgba = new Uint8Array(W * W * 4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const course = ((y >> 3) & 1) ? 0 : 6, mortar = (y & 7) === 0 || ((x + course) & 15) === 0;
        const c = mortar ? [120, 112, 100] : [196 + ((x * 7 + y * 3) % 9), 184, 160];
        rgba.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
    }
    const png = encodePng(W, W, Buffer.from(rgba));
    const chunks = [Buffer.from(pos.buffer), Buffer.from(uv.buffer), png];
    const views: any[] = [];
    let off = 0;
    const parts: Buffer[] = [];
    for (const c of chunks) { views.push({ buffer: 0, byteOffset: off, byteLength: c.length }); const pad = (4 - (c.length % 4)) % 4; parts.push(c, Buffer.alloc(pad)); off += c.length + pad; }
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let q = 0; q < 3; q++) { mn[q] = Math.min(mn[q], pos[i + q]); mx[q] = Math.max(mx[q], pos[i + q]); }
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'leaf', mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: mn, max: mx }, { bufferView: 1, componentType: 5126, count: uv.length / 2, type: 'VEC2' }],
        bufferViews: views, buffers: [{ byteLength: off }], images: [{ bufferView: 2, mimeType: 'image/png' }], samplers: [{ wrapS: 10497, wrapT: 10497 }],
        textures: [{ source: 0, sampler: 0 }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }]
    };
    let j = Buffer.from(JSON.stringify(json));
    j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
    const bin = Buffer.concat(parts);
    const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + j.length + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    fs.writeFileSync(file, Buffer.concat([h, jh, j, bh, bin]));
}

/** A scan fitter whose fitted body is the scanned box (so the tile photo lies on it); refit and ornament are not used here. */
function fitter(dir: string, opts: { delayMs?: number; redundantPassThrough?: boolean } = {}): ScanFitDeps {
    fs.mkdirSync(dir, { recursive: true });
    return {
        fit: async () => {
            if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
            const f = structureFit();
            f.outputs.fittedGlb = writeTris(path.join(dir, 'fit_fitted.glb'), building(-13, 13, -6, 5, 22));
            f.outputs.outlinesGlb = writeTris(path.join(dir, 'fit_outlines.glb'), building(-13, 13, -6, 5, 0.1));
            f.outputs.passThroughGlb = undefined;
            f.passThrough.regions = [];
            if (opts.redundantPassThrough) {
                // a noisy scan copy of the north face 5 cm in front of it, a lump 1.3 m proud of it, a fragment past its edge
                const pieces = REDUNDANT_PIECES();
                f.outputs.passThroughGlb = path.join(dir, 'fit_pass.glb');
                writeStagedGlbFile(f.outputs.passThroughGlb, pieces);
                f.passThrough.regions = pieces.map(n => ({ id: n.name, triangles: n.indices!.length / 3, areaM2: area(n), aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], reason: 'not box-like' }));
                f.passThrough.areaM2 = pieces.reduce((a, n) => a + area(n), 0);
            }
            f.outputs.reportJson = path.join(dir, 'fit_structure_fit.json');
            fs.writeFileSync(f.outputs.reportJson, JSON.stringify(f));
            return { value: f, path: f.outputs.reportJson, dir, key: '7c1e04aa'.padEnd(64, '0'), binarySha256: 'b', cached: false, builtAtMs: Date.now(), ms: 30, waitedForEngineMs: 0 } as any;
        },
        refit: async () => { throw new Error('not used'); },
        ornament: async () => { throw new Error('not used'); },
        flatten: async () => { throw new Error('not used'); }
    };
}

/** Pass-through pieces against the fitted north face (z = -6, x -13..13, y 0..22). */
const REDUNDANT_PIECES = () => [
    patch('r0', -10, 10, 2, 18, 0.5, (x, y) => -6.05 + noise(x, y)),
    lump('r1', [0, 8, -7.3], 0.6),
    patch('r2', 14, 16, 4, 6, 0.5, (x, y) => -6.05 + noise(x, y))
];

let counter = 0;
function setup(extra: Partial<StagedLocationDeps> = {}, opts: { photo?: boolean; fitDelayMs?: number; redundantPassThrough?: boolean } = {}) {
    const root = path.join(TMP, `ws${++counter}`);
    fs.mkdirSync(root, { recursive: true });
    const native = fakeNative(path.join(root, 'native'), ARCH, {});
    const extract: StagedLocationDeps['extract'] = async req => {
        const r = await native.deps.extract(req);
        if (opts.photo !== false) photoTexture(r.texturedGlb);
        return r;
    };
    let runs = 0;
    const deps: StagedLocationDeps = {
        cache: new StageCache({ workspaceRoot: root }),
        geocode: async q => ({ lat: 40.73122, lng: -73.99709, formattedAddress: `${q}, New York, NY`, placeId: 'p' }),
        extract, vegetation: native.deps.vegetation, refine: native.deps.refine,
        scanFit: fitter(path.join(root, 'fit'), { delayMs: opts.fitDelayMs, redundantPassThrough: opts.redundantPassThrough }),
        newRunId: () => (0xb1b2c300 + ++runs).toString(16),
        sleep: async () => undefined,
        textures: { maxDensityTexelsPerMeter: 4, maxSide: 512 },
        ...extra
    };
    const events: Array<{ e: StageEvent; artifact?: CanvasArtifact; at: number }> = [];
    const ctx = { emitStage: (e: StageEvent, artifact?: CanvasArtifact) => events.push({ e, artifact, at: Date.now() }) };
    return { root, deps, events, ctx };
}

const seqOf = (events: Array<{ e: StageEvent }>, stage: string, status: string) => events.find(x => x.e.stage === stage && x.e.status === status)?.e.seq ?? -1;

describe('the texture stage of the staged location build', () => {
    it('runs in the background after the fit commit, publishes textured twins as layer variants, and reports honest shares', async () => {
        const s = setup();
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        const tex = result.stages.find(x => x.stage === 'textures')!;
        expect(tex.status).toBe('committed');
        // background: it starts only after the clay layers (remesh, fit) have committed, and they never wait for it
        const fitCommitted = seqOf(s.events, 'fit', 'committed'), remeshCommitted = seqOf(s.events, 'remesh', 'committed');
        const texStarted = seqOf(s.events, 'textures', 'running');
        expect(fitCommitted).toBeGreaterThan(0);
        expect(texStarted).toBeGreaterThan(fitCommitted);
        expect(texStarted).toBeGreaterThan(remeshCommitted);
        // clay is the first result: the artifact that first shows the fitted body has no textured variant and no textured mode
        const firstBody = s.events.find(x => x.artifact && (x.artifact as any).data.stagedBuild.layers.some((l: any) => l.layer === 'l3b'))!;
        expect((firstBody.artifact as any).data.stagedBuild.layers.every((l: any) => !l.textured)).toBe(true);
        expect((firstBody.artifact as any).data.stagedBuild.materialMode ?? 'clay').toBe('clay');
        // the final scene: l2 and l3b carry their textured twins (published GLBs with TEXCOORD_0), clay urls unchanged
        const finalArt = [...s.events].reverse().find(x => x.artifact)!.artifact as any;
        const sb = finalArt.data.stagedBuild;
        expect(validateContract('StagedBuildState', sb)).toEqual([]);
        const textured = sb.layers.filter((l: any) => l.textured);
        // every shown mesh layer (the raw tiles l1 are superseded by the remesh and skipped; the remesh is the ground)
        expect(textured.map((l: any) => l.layer).sort()).toEqual(['l2', 'l3a', 'l3b']);
        for (const l of textured) {
            const file = path.join(s.root, 'public', 'models', path.basename(l.textured.url));
            const g = parseGlbBytes(fs.readFileSync(file));
            expect(g.json.meshes[0].primitives[0].attributes.TEXCOORD_0).toBeDefined();
            expect(l.textured.url).not.toBe(l.url);
            expect(l.textured.rungShares.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1, 3);
            expect(l.textured.provenance.reduce((a: number, p: any) => a + p.coverage, 0)).toBeCloseTo(1, 3);
            // no Street View in this run: the tile photo holds most of each layer
            expect(l.textured.rungShares[2]).toBeGreaterThan(0.5);
            expect(l.textured.rungShares[0] + l.textured.rungShares[1]).toBe(0);
        }
        expect(sb.texturePass).toMatchObject({ status: 'committed', layersDone: 3, layersTotal: 3 });
        // the record in the result, and the summary says the same numbers
        const rec = result.texturePass!;
        expect(rec.passVersion).toBe(TEXTURE_PASS_VERSION);
        expect(rec.layers.map(l => l.layerKey).sort()).toEqual(['l2', 'l3a', 'l3b']);
        expect(rec.degradations.some(d => d.reasonCode === 'no_street_view')).toBe(true);
        expect(rec.degradations.some(d => d.reasonCode === 'enhance_not_run')).toBe(true);
        expect(rec.timingsMs.total).toBeGreaterThan(0);
        // textured by default: the viewport crossfades to the twins on its own, and the pill offers the clay view instead
        expect(result.summary).toContain(SHOW_CLAY_PILL);
        expect(result.summary).not.toContain(SHOW_TEXTURES_PILL);
        expect(result.summary).toMatch(/Real textures are ready for [l0-9a-z, ]+ and [l0-9a-z]+ \(the viewport crossfades from the clay to them on its own\)/);
        const texels = textured.map((l: any) => ({ shares: l.textured.rungShares }));
        const pct = Math.round((sb.texturePass.rungShares[2]) * 1000) / 10;
        expect(result.summary).toContain(`${pct}% ${TEXTURE_LADDER_RUNGS[2]}`);
        expect(texels.length).toBe(3);
        expect(result.summary).toMatch(/generated PBR is not available/);
    });

    it('textures several layers at once, so one layer\'s model wait does not hold back the next', async () => {
        const s = setup();
        await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        const msgs = s.events.filter(x => x.e.stage === 'textures' && x.e.status === 'running').map(x => ({ seq: x.e.seq, m: String((x.e as any).message ?? '') }));
        const started = (layer: string) => msgs.find(x => x.m.startsWith(`${layer}: `))?.seq ?? Infinity;
        const finished = (layer: string) => msgs.find(x => x.m === `${layer} textured`)?.seq ?? -1;
        const layers = ['l2', 'l3a', 'l3b'].filter(l => Number.isFinite(started(l)));
        expect(layers.length, JSON.stringify(msgs.map(x => x.m))).toBe(3);
        // a second layer starts before the first one is finished
        const first = layers.reduce((a, b) => (finished(a) < finished(b) ? a : b));
        expect(layers.filter(l => l !== first).some(l => started(l) < finished(first)), JSON.stringify(msgs.map(x => x.m))).toBe(true);
    });

    it('does not hold back the clay result: the clay stages stream exactly as they do with the pass turned off', async () => {
        const on = setup();
        const off = setup({ textures: { disabled: 'texture pass turned off for the comparison' } });
        await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, on.deps, on.ctx);
        const r = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, off.deps, off.ctx);
        expect(r.result.stages.find(x => x.stage === 'textures')).toMatchObject({ status: 'skipped', reason: 'texture pass turned off for the comparison' });
        // the clay stages' events (everything but the texture stage) are the same sequence, in the same order
        const clay = (ev: typeof on.events) => ev.filter(x => x.e.stage !== 'textures' && x.e.stage !== 'finish').map(x => `${x.e.stage}:${x.e.status}`);
        expect(clay(on.events)).toEqual(clay(off.events));
        // and every clay layer commit precedes the texture stage's first event
        const firstTex = on.events.findIndex(x => x.e.stage === 'textures');
        const lastClayCommit = Math.max(...on.events.map((x, k) => (x.e.stage !== 'textures' && x.e.stage !== 'finish' && x.e.layers?.length ? k : -1)));
        expect(firstTex).toBeGreaterThan(lastClayCommit);
    });

    it('a repeat serves the twins from the cache, with the same urls', async () => {
        const s = setup();
        const first = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        const again = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        const urls = (r: typeof first) => (r.result.artifact as any).data.stagedBuild.layers.filter((l: any) => l.textured).map((l: any) => l.textured.url).sort();
        expect(urls(again)).toEqual(urls(first));
        expect((again.result.artifact as any).data.stagedBuild.layers.filter((l: any) => l.textured).every((l: any) => l.textured.cached)).toBe(true);
    });

    it('without a photo-textured tile and without Street View or a palette the layers stay clay, labelled clay, with the reasons', async () => {
        const s = setup({}, { photo: false });
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        const sb = (result.artifact as any).data.stagedBuild;
        for (const l of sb.layers.filter((x: any) => x.textured)) {
            expect(l.textured.rungShares[5]).toBeCloseTo(1, 3);
            expect(l.textured.provenance.filter((p: any) => p.coverage > 0).map((p: any) => p.source)).toEqual(['clay']);
        }
        const codes = result.texturePass!.degradations.map(d => d.reasonCode);
        expect(codes).toContain('no_tile_photo');
        expect(codes).toContain('no_palette');
        expect(result.texturePass!.degradations.find(d => d.reasonCode === 'no_tile_photo')!.reason).toMatch(/no photo texture/);
    });

    it('a failing texture pass degrades to clay with a degradation record; the clay layers are untouched', async () => {
        const s = setup({ textures: { maxDensityTexelsPerMeter: 4, maxSide: 8 } }); // too small for any atlas
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        const tex = result.stages.find(x => x.stage === 'textures')!;
        expect(tex.status).toBe('degraded');
        const d = result.degradations.find(x => x.stage === 'textures')!;
        expect(d).toMatchObject({ reasonCode: 'texture_pass_failed', fellTo: 'studio grey clay' });
        expect(result.texturePass).toBeUndefined();
        expect(result.summary).not.toContain(SHOW_TEXTURES_PILL);
        expect(result.summary).not.toContain(SHOW_CLAY_PILL);
        const sb = (result.artifact as any).data.stagedBuild;
        expect(sb.layers.some((l: any) => l.layer === 'l3b')).toBe(true);
        expect(sb.layers.every((l: any) => !l.textured)).toBe(true);
    });

    it('a district (no isolated structure) gets the scan\'s own photogrammetric textures as the remesh\'s textured twin', async () => {
        const s = setup();
        const { result } = await runStagedLocation({ query: 'Washington Square', isolate: false, radiusM: 30, trees: false }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        expect(result.stages.find(x => x.stage === 'textures')).toMatchObject({ status: 'committed' });
        const sb = (result.artifact as any).data.stagedBuild;
        const l2 = sb.layers.find((l: any) => l.layer === 'l2');
        expect(l2.textured).toMatchObject({ ladderRung: TEXTURE_LADDER_RUNGS.indexOf('tile photo transfer'), provenance: [{ source: 'tile-extraction', coverage: 1 }] });
        expect(l2.textured.url).toMatch(/_l2_tex_[0-9a-f]{8}\.glb$/);
        expect(sb.texturePass).toMatchObject({ status: 'committed', layersDone: 1, layersTotal: 1 });
        expect(result.summary).toContain(SHOW_CLAY_PILL);
    });
});

describe('pass-through scan redundant with the fitted surface', () => {
    it('is hidden from the drawn, textured and exported pass-through layer, kept viewable as a replaced layer, and recorded', async () => {
        const s = setup({}, { redundantPassThrough: true });
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        const layers = (result.artifact as any).data.stagedBuild.layers as any[];
        const byName = (n: string) => layers.find(l => l.layer === n);
        const l3b = byName('l3b'), l3c = byName('l3c'), l3ch = byName('l3ch');
        const nodesOf = (url: string) => parseGlbNodes(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename(url))));
        const [copy, statue, fragment] = REDUNDANT_PIECES();
        // the copy is in the replaced layer, which the fitted body supersedes; the lump and the fragment are drawn, whole
        expect(l3ch).toBeDefined();
        expect(l3b.supersedes).toContain(l3ch.objectId);
        expect(nodesOf(l3ch.url).map(n => n.name)).toEqual(['r0']);
        expect(nodesOf(l3ch.url)[0].positions.length / 9).toBe(copy.indices!.length / 3);
        const drawn = nodesOf(l3c.url);
        expect(drawn.map(n => n.name)).toEqual(['r1', 'r2']);
        expect(l3c.counts.triangles).toBe((statue.indices!.length + fragment.indices!.length) / 3);
        expect(area(drawn[0])).toBeCloseTo(area(statue), 4);
        expect(area(drawn[1])).toBeCloseTo(area(fragment), 4);
        expect(l3ch.provenance.note).toMatch(/hidden: redundant with the fitted surface/);
        expect(l3c.provenance.note).toMatch(/hidden \(layer l3ch\)/);
        // the textured twin is of the drawn layer only: no twin for the replaced layer, the twin holds the drawn triangles only
        expect(l3ch.textured).toBeUndefined();
        expect(l3c.textured).toBeDefined();
        const twin = nodesOf(l3c.textured.url);
        expect(twin.reduce((n, x) => n + (x.indices ? x.indices.length : x.positions.length / 3) / 3, 0)).toBe(l3c.counts.triangles);
        // the record: the result, one degradation for the hidden region (the region it replaces is no longer "kept as scanned")
        expect(result.structureFit!.passThroughHidden).toMatchObject({ triangles: copy.indices!.length / 3, trianglesSplit: 0, regions: 1, toleranceM: { min: 0.1, max: 0.1 } });
        expect(result.structureFit!.passThroughHidden!.areaM2).toBeCloseTo(area(copy), 1);
        expect(fs.existsSync(result.structureFit!.passThroughHidden!.reportPath)).toBe(true);
        const hid = result.degradations.filter(d => d.reasonCode === 'pass_through_hidden');
        expect(hid.map(d => d.part.objectId)).toEqual([l3ch.objectId]);
        expect(hid[0].reason).toMatch(/^pass-through hidden: redundant with fitted surface, offset 0\.0\d\d m/);
        expect(result.degradations.filter(d => d.reasonCode === 'pass_through').map(d => d.id)).toEqual(['d-fit-pass_through-r1', 'd-fit-pass_through-r2']);
        expect(result.summary).toMatch(/m² of the scan kept as scanned \(1 region\) hidden where a fitted face lies within 0\.10 m behind them/);
    });
});

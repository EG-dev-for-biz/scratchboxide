/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A chunked district shows each building's best version (place-store-best.ts), on synthetic GLBs and a real object
 * store: a building whose new version is worse is shown from its stored one, in the drawn layer and its clay variant,
 * labelled; one whose stored version cannot stand in (other look code, another footprint, a part missing) is shown as
 * built, with why; and SCRATCHBOX_OBJECT_REUSE=0 shows every building as built.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StagedLayer } from '../src/common/spatial/staged-location-contracts';
import { DurableAssetStore } from '../src/node/asset-store/durable-asset-store';
import { SceneObjectStore, type ObjectMeasures } from '../src/node/asset-store/scene-object-store';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { cutLayerByFootprints } from '../src/node/3d-engine/staged-location/district-completeness-audit';
import { kdLookCode, showBestVersions } from '../src/node/3d-engine/staged-location/place-store-best';
import type { LayerObjectManifest } from '../src/node/3d-engine/staged-location/scene-objects';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { box, testGlb } from './helpers/test-glb';

let tmp: string;
const stores: DurableAssetStore[] = [];
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-place-best-test-'))); });
afterEach(() => { for (const s of stores.splice(0)) s.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const FRAME = { lat: 40.750568, lng: -73.993519, ellipsoidalHeightM: -12.3 };
const measures = (holes: number): ObjectMeasures => ({ holes: { value: holes, better: 'lower' } });
const square = (cx: number, half: number) => [[[cx - half, -half], [cx + half, -half], [cx + half, half], [cx - half, half]]] as Array<Array<[number, number]>>;
const footprintsOf = (b1: string, b2: string) => [{ id: b1, loops: square(0, 5) }, { id: b2, loops: square(30, 5) }];
const FOOTPRINTS = footprintsOf('b1', 'b2');
const png = Buffer.from(encodePng(2, 2, new Uint8Array(16).fill(180), 4));
const uvs = (n: number) => Array.from({ length: n * 2 }, () => 0.5);
const textured = (p: ReturnType<typeof box>) => ({ ...p, uvs: uvs(p.positions.length / 3), png });

function setup(opts: { storedLook?: Record<string, string>; storedFootprint?: string; withPart?: boolean; partRuns?: string[]; storedBox?: [number, number, number, number, number, number]; ids?: [string, string] } = {}) {
    const [b1, b2] = opts.ids ?? ['b1', 'b2'];
    const asset = new DurableAssetStore(path.join(tmp, 'home'));
    stores.push(asset);
    const objects = new SceneObjectStore(asset);
    const look = kdLookCode({});
    // an earlier run kept b1: a box 8 m tall, with no holes
    const stored = objects.put({
        kind: 'building', identity: b1, frame: FRAME, inputHash: 'run-a-b1', glb: () => Buffer.from(testGlb([{ prims: [textured(box(...(opts.storedBox ?? [-4, 0, -4, 4, 8, 4])))] }])),
        provenance: { labels: ['remeshed'], confidence: null }, producer: { stage: 'chunks', version: 'test' }, runId: 'run-a',
        inputs: { layer: 'l2', footprintSha256: opts.storedFootprint ?? 'fp-b1', look: opts.storedLook ?? look }, measures: measures(0)
    });
    // a part carries no measures: each run's version of it becomes current, so a later run's may be current now
    if (opts.withPart) for (const [k, run] of (opts.partRuns ?? ['run-b-other']).entries()) objects.put({
        kind: 'building', identity: `${b1}/l3`, frame: FRAME, inputHash: `${run}-b1-l3`, glb: () => Buffer.from(testGlb([{ prims: [textured(box(-4, 8 + k, -4, 4, 9 + k, 4))] }])),
        provenance: { labels: ['remeshed'], confidence: null }, producer: { stage: 'chunks', version: 'test' }, runId: run, inputs: { layer: 'l3' }
    });
    // this run's layer: b1 broken (a shorter box with a face missing) and b2, in the drawn twin and its clay variant
    const modelsDir = path.join(tmp, 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    const nodes = (tex: boolean) => [
        { prims: [tex ? textured(box(-4, 0, -4, 4, 6, 4, ['top'])) : box(-4, 0, -4, 4, 6, 4, ['top'])] },
        { prims: [tex ? textured(box(26, 0, -4, 34, 7, 4)) : box(26, 0, -4, 34, 7, 4)] }
    ];
    fs.writeFileSync(path.join(modelsDir, 'layer_tex.glb'), testGlb(nodes(true)));
    fs.writeFileSync(path.join(modelsDir, 'layer.glb'), testGlb(nodes(false)));
    const all = (n: number) => Array.from({ length: n }, (_, i) => i);
    const manifest: LayerObjectManifest = {
        schema: 'scratchbox.layer-objects/1', sourceFile: path.join(modelsDir, 'layer_tex.glb'), glbSha256: 'x', producer: { stage: 'chunks', layer: 'l2', version: 'test' }, notes: [],
        objects: [
            { kind: 'building', identity: b1, inputHash: 'run-c-b1', inputs: { building: b1, layer: 'l2', footprintSha256: 'fp-b1' }, cuts: [{ node: 0, triangles: all(10) }], provenance: { labels: ['remeshed'], confidence: null }, measures: measures(1) },
            ...(opts.withPart ? [{ kind: 'building', identity: `${b1}/l3`, inputHash: 'run-c-b1-l3', inputs: { building: b1, layer: 'l3' }, cuts: [{ node: 0, triangles: [0] }], provenance: { labels: ['remeshed'], confidence: null } }] : []),
            { kind: 'building', identity: b2, inputHash: 'run-c-b2', inputs: { building: b2, layer: 'l2', footprintSha256: 'fp-b2' }, cuts: [{ node: 1, triangles: all(12) }], provenance: { labels: ['remeshed'], confidence: null }, measures: measures(0) }
        ]
    } as LayerObjectManifest;
    const layer = {
        objectId: 'stg-l2-kd0', stage: 'chunks', layer: 'l2', url: '/models/layer.glb', bytes: 1, counts: { vertices: 0, triangles: 22 }, supersedes: [], revealAfter: [],
        reveal: { durationMs: 1000, stagger: 0, crossfadeFrom: [] }, textured: { url: '/models/layer_tex.glb', bytes: 1 },
        provenance: { label: 'remeshed', measuredGeometry: true, method: 'pipeline K', sources: [] }
    } as unknown as StagedLayer;
    const published: string[] = [];
    const input = {
        runId: 'run-c', frame: FRAME, layers: [layer], manifests: new Map([[layer.objectId, manifest]]), footprints: footprintsOf(b1, b2), store: asset, look, modelsDir,
        outDir: path.join(tmp, 'best'), publish: (file: string, name: string) => { fs.copyFileSync(file, path.join(modelsDir, name)); published.push(name); return { url: `/models/${name}`, bytes: fs.statSync(file).size }; }, env: {}
    };
    return { objects, stored, input, modelsDir, published };
}

/** The triangles of every mesh node, and the nodes carrying a stored version. */
function read(file: string) {
    const glb = parseGlbBytes(fs.readFileSync(file));
    const nodes = glb.json.nodes as Array<{ mesh?: number; extras?: { sb?: { storedVersion?: unknown; provenance?: { label: string; note?: string } } } }>;
    const tris = nodes.filter(n => n.mesh !== undefined).map(n => (glb.json.meshes[n.mesh!].primitives as Array<{ indices: number }>).reduce((a, p) => a + glb.json.accessors[p.indices].count / 3, 0));
    return { glb, tris, stored: nodes.filter(n => n.extras?.sb?.storedVersion) };
}

describe('a district shows each building at its best', () => {
    it.each([['short ids', ['b1', 'b2']], ["Google's vector feature ids, which hold '/'", ['17/38596/49262/f58', '17/38596/49262/f72']]] as Array<[string, [string, string]]>)(
        'shows a worse building from its stored version, in the drawn layer and its clay variant, labelled with the version, run and reason (%s)', (_label, ids) => {
        const { input, modelsDir, published } = setup({ ids });
        const { report, layers } = showBestVersions(input);
        expect(report.errors).toEqual([]);
        expect(report.substituted).toEqual([expect.objectContaining({ id: ids[0], version: 1, runId: 'run-a', layers: ['stg-l2-kd0'] })]);
        expect(report.substituted[0].reason).toContain('holes 0 -> 1 (lower is better)');
        expect(report.keptNew).toEqual([]);
        expect(layers).toHaveLength(1);
        const [{ layer, original, manifest }] = layers;
        expect(layer.objectId).toBe('stg-l2-kd0-best');
        expect(layer.supersedes).toEqual([original.objectId]);
        expect(layer.provenance.note).toContain('1 building shown from an earlier run');
        expect(manifest).toBe(input.manifests.get(original.objectId));
        expect(published).toHaveLength(2);
        // the drawn twin: b2 as built (12 triangles), b1's broken triangles gone, the stored box in their place
        const tex = read(path.join(modelsDir, path.basename(layer.textured!.url)));
        expect(tex.tris.reduce((a, b) => a + b, 0)).toBe(12 + 12);
        expect(tex.stored).toHaveLength(1);
        const sb = tex.stored[0].extras!.sb as { storedVersion: { objectKey: string; version: number; runId: string; reason: string }; provenance: { label: string; method: string; measuredGeometry: boolean } };
        expect(sb.storedVersion).toMatchObject({ version: 1, runId: 'run-a' });
        expect(sb.storedVersion.objectKey.startsWith(`building/${ids[0]}@`)).toBe(true);
        expect(sb.provenance.label).toBe('remeshed · from an earlier run');
        expect(sb.provenance.measuredGeometry).toBe(true);
        expect(sb.provenance.method).toContain(`version 1 of building/${ids[0]}@`);
        // the clay variant: cut by b1's footprint the same way, its stored part drawn in the clay material, no textures
        const clay = read(path.join(modelsDir, path.basename(layer.url)));
        expect(clay.tris.reduce((a, b) => a + b, 0)).toBe(24);
        expect(clay.stored).toHaveLength(1);
        expect(clay.glb.json.images ?? []).toHaveLength(0);
    });

    it('shows a building as built when its stored version was made with other look code, on another footprint, or lacks a part from its run', () => {
        const look = setup({ storedLook: { ...kdLookCode({}), roofShadow: 'roof-shadow/older' } });
        const a = showBestVersions(look.input).report;
        expect(a.substituted).toEqual([]);
        expect(a.keptNew[0].why).toContain('other look code (roofShadow)');
        fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
        stores.splice(0).forEach(s => s.close());
        const moved = setup({ storedFootprint: 'fp-b1-older' });
        expect(showBestVersions(moved.input).report.keptNew[0].why).toContain('its footprint changed since');
        fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
        stores.splice(0).forEach(s => s.close());
        const part = setup({ withPart: true });
        expect(showBestVersions(part.input).report.keptNew[0].why).toContain('its part b1/l3 has no stored version from run run-a');
    });

    it("takes each part as the main part's run stored it, whatever the part's current version", () => {
        const { input, modelsDir } = setup({ withPart: true, partRuns: ['run-a', 'run-b'] });
        const { report, layers } = showBestVersions(input);
        expect(report.keptNew).toEqual([]);
        expect(report.substituted).toEqual([expect.objectContaining({ id: 'b1', runId: 'run-a' })]);
        const tex = read(path.join(modelsDir, path.basename(layers[0].layer.textured!.url)));
        expect(tex.stored.map(n => (n.extras!.sb!.storedVersion as { runId: string; objectKey: string }).runId)).toEqual(['run-a', 'run-a']);
    });

    it('takes the frames as one when the stored box holds the footprint\'s centre, however far past the footprint it stands', () => {
        const wide = setup({ storedBox: [-12, 0, -4, 12, 8, 4] });
        expect(showBestVersions(wide.input).report.substituted.map(x => x.id)).toEqual(['b1']);
        fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
        stores.splice(0).forEach(s => s.close());
        const away = setup({ storedBox: [46, 0, -4, 54, 8, 4] });
        const r = showBestVersions(away.input).report;
        expect(r.substituted).toEqual([]);
        expect(r.keptNew[0].why).toContain("its footprint's centre lies 43.0 m past its stored box (the frames do not match)");
    });

    it('shows every building as built with SCRATCHBOX_OBJECT_REUSE=0, and a geometry switch is not look code', () => {
        const { input } = setup();
        const off = showBestVersions({ ...input, env: { SCRATCHBOX_OBJECT_REUSE: '0' } });
        expect(off.report.skipped).toBe('SCRATCHBOX_OBJECT_REUSE=0: every building is shown as built');
        expect(off.layers).toEqual([]);
        expect(kdLookCode({ SCRATCHBOX_K_INFILL: '0' })).toEqual(kdLookCode({}));
        expect(kdLookCode({ SCRATCHBOX_K_ROOF_SHADOW: '0' })).toMatchObject({ SCRATCHBOX_K_ROOF_SHADOW: '0' });
        expect(kdLookCode({}, { 'twin.roofShadow': false, 'remesh.clip': false })).toEqual({ ...kdLookCode({}), 'steps.twin.roofShadow': 'false' });
    });

    it("cuts a layer's triangles by the footprints, as the audit does", () => {
        const bytes = testGlb([{ prims: [box(-4, 0, -4, 4, 6, 4)] }, { prims: [box(26, 0, -4, 34, 7, 4)] }, { prims: [box(60, 0, -4, 64, 3, 4)] }]);
        const cut = cutLayerByFootprints(bytes, FOOTPRINTS);
        expect([...cut.get('b1')!.entries()].map(([n, t]) => [n, t.size])).toEqual([[0, 12]]);
        expect([...cut.get('b2')!.entries()].map(([n, t]) => [n, t.size])).toEqual([[1, 12]]);
        expect(cut.size).toBe(2);
    });
});

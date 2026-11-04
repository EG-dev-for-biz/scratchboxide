/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A real photo as an object build's reference (photo-reference.ts and the builder's photo helpers), with no model and
 * no segmenter process: the cut-out lays only the object's own pixels on the #808080 backdrop, a part a camera at the
 * photo's viewpoint cannot see is out of view, the spec read's photo fields are taken off the spec and checked, the
 * build is held to the size it was given, and the default cutter hands the vision model's box to the segmenter.
 */

import { describe, expect, it } from 'vitest';
import { CUTOUT_BACKDROP, CUTOUT_MARGIN, cutOutReference, partsOutOfView, partsSeenFrom, segmenterPhotoCutter } from '../src/node/3d-engine/photo-reference';
import {
    SIZE_HINT_TOLERANCE, buildSpecPrompt, describeMaterialProvenance, describeSize, photoSpecJsonSchema, sizeHintProblems, specConventions, stampMaterialProvenance, takePhotoFields
} from '../src/node/3d-engine/reference-object-builder';
import { decodePng } from '../src/node/texture-processing';
import { objectBuildSpecJsonSchema, type ObjectBuildSpec } from '../src/common/spatial/object-build-spec';
import type { TriangleSoup } from '../src/node/3d-engine/part-connectivity';

const W = 200, H = 150;
const GREEN: [number, number, number] = [30, 90, 40];
const YELLOW: [number, number, number] = [230, 200, 40];

/** A photo: sky over pavement, a green box (the object) at x 80..119, y 50..129, a yellow pole in front of it at x 95..99. */
function photo(): { width: number; height: number; rgba: Uint8Array; mask: Uint8Array } {
    const rgba = new Uint8Array(W * H * 4);
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            let c: number[] = y < 75 ? [135, 180, 230] : [110, 110, 105];
            const inBox = x >= 80 && x < 120 && y >= 50 && y < 130;
            const pole = x >= 95 && x < 100;
            if (inBox) c = GREEN;
            if (pole) c = YELLOW;
            if (inBox && !pole) mask[y * W + x] = 1;
            rgba.set([...c, 255], i);
        }
    }
    return { width: W, height: H, rgba, mask };
}

/** An axis-aligned box as a triangle soup. */
function box(min: [number, number, number], max: [number, number, number]): TriangleSoup {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const f = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [3, 2, 6], [3, 6, 7], [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2]];
    return { positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()) } as unknown as TriangleSoup;
}

describe('cutOutReference', () => {
    it('lays only the object\'s pixels on #808080 in a square round it, with the occluder in front left out', () => {
        const p = photo();
        const cut = cutOutReference(p, { mask: p.mask, width: W, height: H });
        const png = decodePng(cut.data);
        // the object is 40 x 80 px: a square of its larger side plus the margin on both sides
        expect(cut.sizePx).toBe(Math.round(80 * (1 + 2 * CUTOUT_MARGIN)));
        expect([png.width, png.height]).toEqual([cut.sizePx, cut.sizePx]);
        expect(cut.bbox).toEqual([80 / W, 50 / H, 120 / W, 130 / H].map(v => +v.toFixed(4)));
        expect(cut.objectPixels).toBe(35 * 80);
        const at = (x: number, y: number) => [...png.rgba.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
        for (const [x, y] of [[0, 0], [png.width - 1, 0], [0, png.height - 1], [png.width - 1, png.height - 1]]) expect(at(x, y)).toEqual([CUTOUT_BACKDROP, CUTOUT_BACKDROP, CUTOUT_BACKDROP]);
        // the object's own colour, exactly (bilinear over the object's own pixels only), left of the pole
        const mid = Math.floor(png.height / 2);
        expect(at(Math.floor(png.width / 2) - 10, mid)).toEqual(GREEN);
        // no pixel of the pole, the sky or the pavement: only the object and the backdrop
        let foreign = 0, green = 0;
        for (let i = 0; i < png.rgba.length; i += 4) {
            const c = [png.rgba[i], png.rgba[i + 1], png.rgba[i + 2]];
            if (c.every((v, k) => v === GREEN[k])) green++;
            else if (!c.every(v => v === CUTOUT_BACKDROP)) foreign++;
        }
        expect(foreign).toBe(0);
        expect(green).toBeGreaterThan(0.25 * png.width * png.height);
    });

    it('fails on an empty mask instead of returning a blank reference', () => {
        const p = photo();
        expect(() => cutOutReference(p, { mask: new Uint8Array(W * H), width: W, height: H })).toThrow(/mask is empty/);
    });

    it('reads a mask of another size than the photo at the nearest pixel', () => {
        const p = photo();
        const half = new Uint8Array((W / 2) * (H / 2));
        for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) half[y * (W / 2) + x] = p.mask[(2 * y) * W + 2 * x];
        const cut = cutOutReference(p, { mask: half, width: W / 2, height: H / 2 });
        expect(cut.bbox[0]).toBeCloseTo(0.4, 2);
        expect(cut.bbox[3]).toBeCloseTo(130 / H, 2);
    });
});

describe('partsSeenFrom / partsOutOfView', () => {
    // a body 0.6 m wide and a plate on its back (-Z), hidden behind it from the front
    const meshes = new Map<string, TriangleSoup>([
        ['body', box([-0.3, 0, -0.3], [0.3, 0.9, 0.3])],
        ['backplate', box([-0.1, 0.35, -0.33], [0.1, 0.55, -0.29])],
        ['lid', box([-0.31, 0.9, -0.31], [0.31, 0.95, 0.31])]
    ]);

    it('a part behind the body is out of view from the front and in view from behind', () => {
        expect(partsOutOfView(meshes, { azimuthDeg: 0, elevationDeg: 10 })).toEqual(['backplate']);
        expect(partsOutOfView(meshes, { azimuthDeg: 180, elevationDeg: 10 })).toEqual([]);
        const seen = partsSeenFrom(meshes, { azimuthDeg: 180, elevationDeg: 10 });
        expect(seen.get('backplate')).toBeGreaterThan(50);
    });

    it('from straight above the wider lid hides the body', () => {
        expect(partsOutOfView(meshes, { azimuthDeg: 0, elevationDeg: 89 })).toContain('body');
        expect(partsOutOfView(meshes, { azimuthDeg: 0, elevationDeg: 89 })).not.toContain('lid');
    });
});

describe('the spec read of a photo build', () => {
    it('takes photoView and unseenPartIds off the reply, wraps the azimuth, and says what is missing', () => {
        const read = { unseen: [] as string[] };
        const missing = takePhotoFields({ subject: 'bin', parts: [] }, read);
        expect(missing.problems).toEqual([expect.stringContaining('photoView is missing')]);
        const bad = takePhotoFields({ photoView: { azimuthDeg: 10, elevationDeg: 120 } }, read);
        expect(bad.problems).toEqual([expect.stringContaining('-89 to 89')]);
        const ok = takePhotoFields({ subject: 'bin', photoView: { azimuthDeg: 200, elevationDeg: 12 }, unseenPartIds: ['back', 'back'] }, read);
        expect(ok.problems).toEqual([]);
        expect(ok.value).toEqual({ subject: 'bin' });
        expect(read).toEqual({ view: { azimuthDeg: -160, elevationDeg: 12 }, unseen: ['back'] });
        // a later patch need not repeat the view
        expect(takePhotoFields({ parts: [] }, read).problems).toEqual([]);
        expect(takePhotoFields({ unseenPartIds: 'back' }, read).problems).toEqual(['unseenPartIds must be a list of part ids']);
    });

    it('asks for the view and the unseen parts in the schema, required on a full read and optional on a patch', () => {
        const full = photoSpecJsonSchema(objectBuildSpecJsonSchema({ materials: true })) as any;
        expect(full.required).toEqual(expect.arrayContaining(['photoView', 'unseenPartIds', 'parts']));
        expect(full.propertyOrdering.slice(-3)).toEqual(['photoView', 'parts', 'unseenPartIds']);
        const patch = photoSpecJsonSchema({ type: 'object', properties: { parts: {} }, required: ['parts'] }, { patch: true }) as any;
        expect(patch.required).toEqual(['parts']);
        expect(Object.keys(patch.properties)).toEqual(['parts', 'photoView', 'unseenPartIds']);
    });

    it('tells the model it reads a cut-out photo, the object\'s own front, and the size it was given', () => {
        const prompt = buildSpecPrompt('a green litter bin', undefined, { materials: true, photo: true, heightMeters: 0.95, sizeSource: 'measured in the scan' });
        expect(prompt).toContain('a real photograph of: a green litter bin, cut out of its surroundings');
        expect(prompt).toContain('say where the camera stood');
        expect(prompt).toContain('the side people face or use');
        expect(prompt).toContain('It is 0.95 m tall, measured in the scan: build it to that height');
        expect(prompt).toContain('photoView:');
        expect(prompt).toContain('ignore cast shadows, highlights, sky reflections');
        // a drawn reference keeps its own wording
        const drawn = specConventions([1, 2, 3], { materials: true });
        expect(drawn).toContain('The user gave its size as about 1 m x 2 m x 3 m');
        expect(drawn).toContain('the side facing the viewer');
        expect(drawn).not.toContain('photoView');
        expect(specConventions(undefined, { photo: true })).toContain('A photo has no scale');
        expect(specConventions(undefined, { photo: true, hints: ['weathered beige concrete trash can', 'section exponent 4'] }))
            .toContain('- Notes from another reading of photos of this object (hints, not measurements; where they disagree with the picture, the picture decides): weathered beige concrete trash can; section exponent 4');
    });
});

describe('size of a photo build', () => {
    it('holds the height within its tolerance and the plan in either order', () => {
        expect(sizeHintProblems([0.6, 0.95 * (1 + SIZE_HINT_TOLERANCE.height * 0.9), 0.6], { heightMeters: 0.95 })).toEqual([]);
        expect(sizeHintProblems([0.6, 0.6, 0.6], { heightMeters: 0.95, source: 'measured in the scan' }))
            .toEqual(['The build is 0.6 m tall but the object is 0.95 m tall (measured in the scan); scale every part so it stands 0.95 m tall.']);
        expect(sizeHintProblems([1.8, 0.9, 0.5], { dimensionsMeters: [0.5, 0.9, 1.8] })).toEqual([]);
        expect(sizeHintProblems([1.0, 0.9, 0.5], { dimensionsMeters: [0.5, 0.9, 1.8] })).toEqual([expect.stringContaining('make its width and depth agree')]);
    });

    it('says where the size came from: the caller\'s hint and source, else the model\'s estimate (generated)', () => {
        expect(describeSize({ heightHintMeters: 0.95, sizeSource: 'measured in the scan (cluster 7)' }, [0.6, 0.95, 0.6], { photo: true }))
            .toEqual({ label: 'as-given', heightMeters: 0.95, note: 'Sized to 0.95 m tall, measured in the scan (cluster 7).', builtMeters: [0.6, 0.95, 0.6] });
        const est = describeSize({}, [0.6, 0.95, 0.6], { photo: true, visionModel: 'gemini-4-argon' });
        expect(est.label).toBe('generated');
        expect(est.note).toBe('A photo has no scale, and no size was given: gemini-4-argon estimated it from what such an object measures (generated).');
        // a caller that measured it labels it so
        expect(describeSize({ dimensionsHintMeters: [0.6, 0.91, 0.6], sizeSource: 'measured in the scan', sizeLabel: 'measured' }, [0.6, 0.91, 0.6], { photo: true }).label).toBe('measured');
    });
});

describe('provenance of a photo build', () => {
    const spec: ObjectBuildSpec = {
        subject: 'bin', observations: [], boundingMeters: [0.6, 0.95, 0.6], expectedBodies: 1,
        parts: [
            { id: 'body', label: 'body', material: { baseColor: [0.02, 0.1, 0.03], roughness: 0.6, metalness: 0, transmission: 0 }, revolve: {} as any },
            { id: 'backplate', label: 'plate', material: { baseColor: [0.5, 0.5, 0.5], roughness: 0.4, metalness: 1, transmission: 0 }, revolve: {} as any }
        ]
    };

    it('labels the materials photo-inferred and the parts the photo does not show generated, in the note and the GLB', () => {
        const prov = describeMaterialProvenance(spec, { clay: false, source: 'photo', visionModel: 'gemini-4-argon', photoSource: 'build/streetview-grounding/x.jpg', generatedParts: ['backplate'] });
        expect(prov.label).toBe('photo-inferred');
        expect(prov.generatedParts).toEqual(['backplate']);
        expect(prov.note).toContain('from a real photograph of the object (build/streetview-grounding/x.jpg)');
        expect(prov.note).toContain('Parts the photo does not show are generated');
        // a minimal GLB with one material per part
        const json = { asset: { version: '2.0' }, meshes: [{ name: 'body', primitives: [{ material: 0 }] }, { name: 'backplate', primitives: [{ material: 1 }] }], materials: [{}, {}] };
        let text = JSON.stringify(json);
        while (text.length % 4) text += ' ';
        const header = Buffer.alloc(20);
        header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + text.length, 8); header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4E4F534A, 16);
        const stamped = stampMaterialProvenance(Buffer.concat([header, Buffer.from(text)]), spec, prov, { sizeProvenance: { label: 'as-given' } });
        const out = JSON.parse(stamped.toString('utf8', 20, 20 + stamped.readUInt32LE(12)));
        expect(out.materials.map((m: any) => m.extras.scratchbox.provenance)).toEqual(['photo-inferred', 'generated']);
        expect(out.asset.extras.scratchbox.materialProvenance).toMatchObject({ label: 'photo-inferred', generatedParts: ['backplate'] });
        expect(out.asset.extras.scratchbox.sizeProvenance).toEqual({ label: 'as-given' });
    });
});

describe('segmenterPhotoCutter', () => {
    it('hands the vision model\'s box and points to the segmenter with the photo\'s own bytes, and reports both', async () => {
        const bytes = Buffer.from('not decoded here');
        const asked: any[] = [];
        const client = {
            models: {
                generateContent: async (params: any) => {
                    asked.push(params);
                    return { candidates: [{ content: { parts: [{ text: '{"found": true, "label": "green litter bin", "box_2d": [200, 400, 800, 600], "positive": [[500, 500]], "negative": [[500, 300]]}' }] } }], modelVersion: params.model } as any;
                }
            }
        };
        const segmented: any[] = [];
        const cutter = segmenterPhotoCutter({ getGenAIClient: async () => client, getModelCandidates: () => ['gemini-4-argon'] }, undefined, {
            segmentBytes: async (input: any) => {
                segmented.push(input);
                return { mask: new Uint8Array([0, 1, 1, 0]), width: 2, height: 2, areaFraction: 0.5, bbox: [0, 0, 1, 1], refinement: 'grabcut', model: 'mediapipe-interactive-segmenter-legacy (magic_touch.tflite)' };
            }
        } as any);
        const mask = await cutter({ data: bytes, mimeType: 'image/jpeg' }, 'the green litter bin');
        expect(asked).toHaveLength(1);
        expect(JSON.stringify(asked[0].contents)).toContain('the green litter bin');
        expect(segmented).toHaveLength(1);
        expect(segmented[0].bytes).toBe(bytes);
        expect(segmented[0].box).toEqual([0.4, 0.2, 0.6, 0.8]);
        expect(segmented[0].positive).toEqual([[0.5, 0.5]]);
        expect(segmented[0].negative).toEqual([[0.3, 0.5]]);
        expect(mask).toMatchObject({ width: 2, height: 2, areaFraction: 0.5, locator: { model: 'gemini-4-argon', label: 'green litter bin' }, segmenter: 'mediapipe-interactive-segmenter-legacy (magic_touch.tflite)' });

        // with the caller's box, nobody is asked to find it: the segmenter cuts from that box
        const fromBox = await cutter({ data: bytes, mimeType: 'image/jpeg' }, 'the green litter bin', undefined, { box: [0.1, 0.2, 0.3, 0.4] });
        expect(asked).toHaveLength(1);
        expect(segmented[1]).toMatchObject({ bytes, box: [0.1, 0.2, 0.3, 0.4] });
        expect(segmented[1].positive).toBeUndefined();
        expect(fromBox.locator).toBeUndefined();
    });
});

/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Which slots are offered to the photo reading: exterior and shown by an image (slot-exposure.ts), on a real arch fit and on stacked boxes. */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { computeSlotOffer, insideSolid, readFittedShells, type FittedShells } from '../src/node/3d-engine/staged-location/slot-exposure';
import { projectSlots } from '../src/node/3d-engine/staged-location/slot-projection';
import { ornamentPromptText } from '../src/node/3d-engine/staged-location/ornament-vision';
import { readGlbScene, sceneToRenderMesh } from '../src/node/spatial/StreetViewPoseRegistrar';
import type { EvidenceImageRef, OrnamentSlot, StructureFit, Vec3 } from '../src/common/spatial/staged-location-contracts';
import { findArchFit } from './helpers/real-arch-data';

const real = findArchFit();

function box(id: string, min: Vec3, max: Vec3) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
    const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
    return { id, positions, indices, min, max };
}
const topSlot = (id: string, y: number, normal: Vec3, x = [0, 2], z = [0, 2]): { slot: OrnamentSlot; surface: any } => ({
    slot: { id, host: { surface: { surfaceId: `s_${id}`, regionUv: [[0, 0], [x[1] - x[0], 0], [x[1] - x[0], z[1] - z[0]], [0, z[1] - z[0]]] } }, sizeM: [x[1] - x[0], z[1] - z[0]], bounds: { maxProudM: 0.3, maxRecessM: 0.1, minFeatureM: 0.1 } },
    surface: { id: `s_${id}`, primitiveId: id, chart: { plane: { origin: [x[0], y, z[0]], u: [1, 0, 0], v: [0, 0, 1], normal, extentUv: [[0, 0], [x[1] - x[0], z[1] - z[0]]] } } }
});
const shown = (slotId: string, visibleFraction: number, index = 0): EvidenceImageRef => ({
    id: `i${index}`, index, kind: 'streetview-grounding', widthPx: 100, heightPx: 100, sha256: '', nativeSampleM: 0.1, slotsShown: [{ slotId, polygon1000: [1, 2, 3, 4], visibleFraction }]
});

describe('slot exposure', () => {
    it('does not offer a slot on a face another primitive covers (stacked boxes sharing a face), and offers the open ones', () => {
        const solid: FittedShells = { shells: [box('lower', [0, 0, 0], [2, 1, 2]), box('upper', [0, 1, 0], [2, 2, 2])] };
        const shared = topSlot('S_shared', 1, [0, 1, 0]);      // top of the lower box = underside of the upper box
        const roof = topSlot('S_roof', 2, [0, 1, 0]);          // top of the upper box: open
        const fit = { slots: [shared.slot, roof.slot], surfaces: [shared.surface, roof.surface], outputs: {} } as unknown as Pick<StructureFit, 'slots' | 'surfaces' | 'outputs'>;
        const ref = shown('S_shared', 0.9);
        ref.slotsShown.push(...shown('S_roof', 0.9).slotsShown);
        const offer = computeSlotOffer(fit, [ref], solid);
        expect(offer.offeredIds.has('S_roof')).toBe(true);
        expect(offer.offeredIds.has('S_shared')).toBe(false);
        expect(offer.hidden).toBe(1);
        expect(offer.entries.find(e => e.slotId === 'S_shared')?.why).toMatch(/hidden or interior/);
        expect(insideSolid(solid, [1, 1.05, 1])).toBe(true);
        expect(insideSolid(solid, [1, 2.5, 1])).toBe(false);
    });

    it('does not offer a slot no image shows, and tells the model which images show an offered one', () => {
        const solid: FittedShells = { shells: [box('S_a', [0, 0, 0], [2, 1, 2]), box('S_b', [3, 0, 0], [4, 1, 2])] };
        const a = topSlot('S_a', 1, [0, 1, 0]), b = topSlot('S_b', 1, [0, 1, 0], [3, 5]);
        const fit = { slots: [a.slot, b.slot], surfaces: [a.surface, b.surface], outputs: {}, sourceLimits: { meshResolvableM: 0.3, photoResolvableM: 0.3 }, primitives: [] } as unknown as StructureFit;
        const ref = shown('S_a', 0.87);
        ref.slotsShown.push(...shown('S_b', 0.05).slotsShown);
        const offer = computeSlotOffer(fit, [ref], solid);
        expect([...offer.offeredIds]).toEqual(['S_a']);
        expect(offer.unseen).toBe(1);
        const { tables } = ornamentPromptText(fit, [ref], [], offer);
        expect(tables).toContain('S_a:');
        expect(tables).not.toContain('S_b:');
        expect(tables).toContain('0 (87% of the slot visible)');
        expect(tables).toContain('Slots offered (1 of 2 fitted');
    });

    it.skipIf(!real)('on the real arch fit: only exterior slots a pano ring shows are offered, the hidden and unseen ones are left out', () => {
        const fit = JSON.parse(fs.readFileSync(real!.fitPath, 'utf8')) as StructureFit;
        fit.outputs.fittedGlb = path.join(real!.dir, 'fitted.glb');
        fit.outputs.passThroughGlb = path.join(real!.dir, 'passthrough.glb');
        expect(readFittedShells(fit)?.shells.length).toBe(fit.primitives.length);
        const occluder = sceneToRenderMesh([...readGlbScene(fit.outputs.fittedGlb), ...readGlbScene(fit.outputs.passThroughGlb!)]);
        const cx = fit.footprint.outer.reduce((s, p) => s + p[0], 0) / fit.footprint.outer.length, cz = fit.footprint.outer.reduce((s, p) => s + p[1], 0) / fit.footprint.outer.length;
        const eyeY = fit.ground.baseY + 2.5;
        const refs: EvidenceImageRef[] = [];
        for (let k = 0; k < 6; k++) {
            const az = (k * 60 * Math.PI) / 180, R = 34;
            const eye: Vec3 = [cx + R * Math.sin(az), eyeY, cz - R * Math.cos(az)];
            const heading = ((Math.atan2(cx - eye[0], -(cz - eye[2])) * 180) / Math.PI + 360) % 360;
            refs.push({ id: `v${k}`, index: k, kind: 'streetview-grounding', widthPx: 1280, heightPx: 960, sha256: '', nativeSampleM: 0.05,
                slotsShown: projectSlots(fit, { eye, headingDeg: heading, pitchDeg: 18, fovDeg: 60, widthPx: 1280, heightPx: 960 }, occluder) });
        }
        const offer = computeSlotOffer(fit, refs);
        const total = fit.slots.length;
        // some slots are offered, some are left out, and every offered one is shown by an image
        expect(offer.offeredIds.size).toBeGreaterThan(5);
        expect(offer.offeredIds.size).toBeLessThan(total);
        expect(offer.hidden + offer.unseen).toBe(total - offer.offeredIds.size);
        expect(offer.unseen).toBeGreaterThan(0);
        for (const e of offer.entries) {
            if (e.offered) {
                expect(e.images.length).toBeGreaterThan(0);
                expect(e.exposedShare ?? 1).toBeGreaterThanOrEqual(0.3);
            } else expect(e.why).toBeTruthy();
        }
        const { tables } = ornamentPromptText(fit, refs, [], offer);
        const lines = tables.split('\n').filter(l => /^S\d+: /.test(l));
        expect(lines.length).toBe(offer.offeredIds.size);
        const dir = path.join(process.cwd(), 'test-results');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'photo_ornament_exposure_real_arch.json'), JSON.stringify({ total, offered: offer.offeredIds.size, hidden: offer.hidden, unseen: offer.unseen, entries: offer.entries }, null, 1));
    });
});

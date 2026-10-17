/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Which fitted slots can carry visible detail at all, before the reading is asked about any.
 *
 * The fit is a stack of closed prisms that share faces. A slot on a face one prism shares with another (or one a neighbour
 * covers) is inside the union of the fitted solid: no photograph shows it and nothing built on it could stand free of the
 * solid. Two tests:
 *   - EXPOSED: samples a hand's breadth off the slot, along its outward direction, must lie outside every fitted
 *     primitive's closed shell (the same union the native builder tests penetration against: each primitive is its own
 *     shell, a point is inside the union when any shell holds it);
 *   - SHOWN: at least one evidence image shows the slot at MIN_SLOT_VISIBLE_FRACTION or more (the projection already
 *     ray-tests the samples against the fitted model and the scan).
 * Only slots passing both are offered to the model, with the images that show them. A slot failing either is not an error:
 * it is just not asked about.
 */

import type { EvidenceImageRef, StructureFit } from '../../../common/spatial/staged-location-contracts';
import { computeSlotCover, type SlotCover } from './slot-cover';
import { insideSolid, readFittedShells, type FittedShells } from './fitted-solid';

export { insideSolid, readFittedShells, type FittedShells, type Shell } from './fitted-solid';

/** A slot is offered when at least this share of its samples lies in open air. */
export const MIN_EXPOSED_SHARE = 0.3;
/** Mirrors ornament-vision's MIN_SLOT_VISIBLE_FRACTION (kept here to avoid a cycle). */
export const MIN_SHOWN_FRACTION = 0.3;

export interface SlotOfferEntry {
    slotId: string;
    /** Share of the slot's open-air samples outside the fitted solid (1: all open; undefined: not judged). */
    exposedShare?: number;
    /** The evidence images that show it: index and visible share (tile orthos show 1: they are renders of the surface itself). */
    images: Array<{ index: number; visibleFraction: number }>;
    offered: boolean;
    /** Where another fitted primitive fills the slot's free space (undefined: none, or not judged). */
    cover?: SlotCover;
    /** Why it is not offered. */
    why?: string;
}

export interface SlotOffer {
    entries: SlotOfferEntry[];
    offeredIds: Set<string>;
    /** The covered parts of every judged slot, for the prompt and the anchoring. */
    covers: Map<string, SlotCover>;
    /** Slots left out, by reason. */
    hidden: number;
    unseen: number;
    /** False when the fitted solid could not be read: nothing was judged exposed or hidden, only the images decided. */
    exposureJudged: boolean;
}

/** `only`: judge just these slots (a focused reading asks about one); `coverCache`: covers already worked out for this fit's solid, filled as they are. */
export function computeSlotOffer(fit: Pick<StructureFit, 'slots' | 'surfaces' | 'outputs'>, evidence: EvidenceImageRef[], solid: FittedShells | undefined = readFittedShells(fit), only?: Set<string>, coverCache?: Map<string, SlotCover | undefined>): SlotOffer {
    const entries: SlotOfferEntry[] = [];
    const covers = new Map<string, SlotCover>();
    let hidden = 0, unseen = 0;
    for (const slot of fit.slots) {
        if (only && !only.has(slot.id)) continue;
        const images = evidence.flatMap(e => {
            const s = e.slotsShown.find(x => x.slotId === slot.id);
            return s && s.visibleFraction >= MIN_SHOWN_FRACTION ? [{ index: e.index, visibleFraction: s.visibleFraction }] : [];
        });
        let exposedShare: number | undefined;
        let cover: SlotCover | undefined;
        if (solid) {
            if (coverCache?.has(slot.id)) cover = coverCache.get(slot.id);
            else { cover = computeSlotCover(slot, fit, solid); coverCache?.set(slot.id, cover); }
            exposedShare = cover ? 1 - cover.share : 0;
            if (cover && cover.share > 0) covers.set(slot.id, cover);
        }
        let why: string | undefined;
        if (exposedShare !== undefined && exposedShare < MIN_EXPOSED_SHARE) { why = `on a hidden or interior face (${Math.round(exposedShare * 100)}% of it open to the air)`; hidden++; }
        else if (!images.length) { why = `no image shows it (${MIN_SHOWN_FRACTION * 100}% visible needed)`; unseen++; }
        entries.push({ slotId: slot.id, ...(exposedShare !== undefined ? { exposedShare: Math.round(exposedShare * 100) / 100 } : {}), images, offered: !why, ...(cover && cover.share > 0 ? { cover } : {}), ...(why ? { why } : {}) });
    }
    return { entries, offeredIds: new Set(entries.filter(e => e.offered).map(e => e.slotId)), covers, hidden, unseen, exposureJudged: !!solid };
}

export function describeOffer(offer: SlotOffer, total: number): string {
    return `${offer.offeredIds.size} of ${total} fitted slots offered to the reading (${offer.hidden} on hidden or interior faces, ${offer.unseen} shown by no image${offer.exposureJudged ? '' : '; the fitted solid could not be read, so only the images decided'})`;
}

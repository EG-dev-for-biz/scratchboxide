/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { Media4DObject } from '../../canvas-types';

/**
 * USD-style variant sets over `Scene3DData.objects[]`.
 *
 * Objects whose `content.metadata.variantSet` share the same (free-form) key are mutually exclusive
 * alternatives of one scene element: exactly one member is shown at a time. The key is an opaque
 * grouping string — nothing branches on its value or on member ids — and members are ordered by the
 * numeric `variantOrder`, labelled by `variantLabel`, and defaulted by `variantDefault: true`.
 */
export interface VariantSet {
    key: string;
    members: Media4DObject[];
}

/** The variant-set key an object belongs to, or undefined for ordinary (always shown) objects. */
export function variantSetKeyOf(obj: Media4DObject | undefined): string | undefined {
    const key = obj?.content?.metadata?.variantSet;
    return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/** Groups objects by variant-set key (string equality only), members sorted by `variantOrder`. */
export function groupVariantSets(objects: Media4DObject[] | undefined): VariantSet[] {
    const byKey = new Map<string, Media4DObject[]>();
    for (const obj of objects || []) {
        const key = variantSetKeyOf(obj);
        if (!key) continue;
        const members = byKey.get(key);
        if (members) members.push(obj);
        else byKey.set(key, [obj]);
    }
    const order = (o: Media4DObject) => {
        const n = Number(o.content?.metadata?.variantOrder);
        return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
    };
    return Array.from(byKey, ([key, members]) => ({
        key,
        // Array.prototype.sort is stable, so unordered members keep their declaration order.
        members: [...members].sort((a, b) => order(a) - order(b))
    }));
}

/**
 * The active member id per set: the viewer's choice when it is still a member, otherwise the member
 * flagged `variantDefault`, otherwise the first member.
 */
export function resolveActiveVariants(sets: VariantSet[], choice: Record<string, string>): Record<string, string> {
    const active: Record<string, string> = {};
    for (const set of sets) {
        const chosen = choice[set.key];
        const member = (chosen && set.members.find(m => m.id === chosen))
            || set.members.find(m => m.content?.metadata?.variantDefault === true)
            || set.members[0];
        if (member) active[set.key] = member.id;
    }
    return active;
}

/** Whether `obj` should be in the live scene given the active variant ids. */
export function isActiveVariant(obj: Media4DObject, activeVariantIds: Record<string, string>): boolean {
    const key = variantSetKeyOf(obj);
    return !key || activeVariantIds[key] === obj.id;
}

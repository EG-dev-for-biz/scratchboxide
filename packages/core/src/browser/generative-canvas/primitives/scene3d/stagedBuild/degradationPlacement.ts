/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Where a degraded part is in the viewport (design §7.4: every degraded part is shaded in the provenance view, and the
 * overlay's list highlights it on request).
 *
 * A DegradationRecord says which part fell to a simpler version of the same real data. The viewport can only shade
 * what is drawn, so each record is placed on the loaded nodes by the most specific thing it and the nodes share, in
 * this order, and the first step that finds a node wins:
 *
 *   1. `degradation-id`  a node that names this record (`extras.sb.ids.degradationId`: NATIVE writes one outline per
 *                        degraded slot);
 *   2. `layer`           the record names a layer (`part.objectId`): every node of it;
 *   3. `ids`             nodes carrying every id the part names (primitive, surface, slot, element, crown);
 *   4. `coarser-ids`     the part names an element, slot or crown that was never drawn (it is the thing that
 *                        degraded), so its nearest drawn parent: the nodes carrying the ids it names beyond the
 *                        element, slot and crown, and no element, slot or crown of their own (the flat fitted face
 *                        the dropped element would have sat on);
 *   5. `stage`           the part names no id at all (a description, a building): the nodes of the record's own stage,
 *                        labelled with the rung the part fell to (`provenanceAfter`);
 *   6. `label`           the record's stage drew nothing (vision, evidence, fit, the tile rungs): every node labelled
 *                        with the rung, inside the named building when the part names one.
 *
 * Steps 5 and 6 look only at layers that are showing: a superseded layer (the raw scan under its remesh) is not where
 * a part that fell to a rung is seen.
 *
 * Steps 1, 3 and 4 are exact parts. Steps 2, 5 and 6 shade whole layers or whole structures, because that is the
 * finest place the data has; the overlay says so. A part that names specific ids no node carries (a tree kept as
 * scanned stays inside the scan, so no node of the trees layer is that tree) is `unplaced`, never spread over a layer:
 * the overlay says there is nothing separate to highlight instead of offering a highlight that shows nothing or shades
 * parts that did not degrade. Nothing here switches on a stage, a label or a description.
 */

import type { DegradationRecord, ProvenanceLabel, StagedLayer, StagedNodeExtras } from '../../../../../common/spatial/staged-location-contracts';

type NodeIds = StagedNodeExtras['sb']['ids'];

/** What placement reads of a node. */
export interface PlacementNode {
    ids: NodeIds;
    provenance: { label: ProvenanceLabel };
}

/** What placement reads of a loaded layer. */
export interface PlacementRoot<N extends PlacementNode = PlacementNode> {
    layer: StagedLayer;
    /** Root extras' buildingId, when the layer is one structure's. */
    buildingId?: string;
    /** The layer is showing now: not superseded by another layer and not retired. */
    showing: boolean;
    nodes: N[];
}

export type PlacementTier = 'degradation-id' | 'layer' | 'ids' | 'coarser-ids' | 'stage' | 'label' | 'unplaced';
/** An exact part, a whole layer or structure (the finest place the data has), or nothing drawn. */
export type PlacementScope = 'part' | 'layer' | 'none';

export interface Placement<N extends PlacementNode = PlacementNode> {
    tier: PlacementTier;
    scope: PlacementScope;
    nodes: N[];
    /** Layers the nodes are in (for the overlay's sentence). */
    layerIds: string[];
}

const SCOPE: Record<PlacementTier, PlacementScope> = {
    'degradation-id': 'part', layer: 'layer', ids: 'part', 'coarser-ids': 'part', stage: 'layer', label: 'layer', unplaced: 'none'
};

/** Id kinds, the finest first: an element sits on a slot, a slot on a surface, a surface on a primitive. */
const FINE: ReadonlyArray<keyof NodeIds> = ['elementId', 'crownId', 'slotId'];
const COARSE: ReadonlyArray<keyof NodeIds> = ['surfaceId', 'primitiveId'];

function named(d: DegradationRecord, kinds: ReadonlyArray<keyof NodeIds>): Array<[keyof NodeIds, string | number]> {
    const p = d.part as unknown as Record<string, string | number | undefined>;
    return kinds.filter(k => p[k] !== undefined).map(k => [k, p[k] as string | number]);
}

function flat<N extends PlacementNode>(roots: PlacementRoot<N>[], pick: (r: PlacementRoot<N>, n: N) => boolean): N[] {
    return roots.flatMap(r => r.nodes.filter(n => pick(r, n)));
}

function place<N extends PlacementNode>(d: DegradationRecord, roots: PlacementRoot<N>[]): { tier: PlacementTier; nodes: N[] } {
    const done = (tier: PlacementTier, nodes: N[]) => ({ tier, nodes });

    const byId = flat(roots, (_r, n) => n.ids.degradationId === d.id);
    if (byId.length > 0) return done('degradation-id', byId);

    if (d.part.objectId !== undefined) {
        const own = roots.filter(r => r.layer.objectId === d.part.objectId);
        return own.length > 0 ? done('layer', own.flatMap(r => r.nodes)) : done('unplaced', []);
    }

    // The part names specific things (an element, a slot, a crown, a surface, a primitive): it is those, drawn or not.
    // Never a whole layer, which would shade parts that did not degrade.
    const all = named(d, [...FINE, ...COARSE]);
    if (all.length > 0) {
        const exact = flat(roots, (_r, n) => all.every(([k, v]) => n.ids[k] === v));
        if (exact.length > 0) return done('ids', exact);
        // The finest thing named was never drawn: its parent is the part that shows it fell.
        const coarse = named(d, COARSE);
        if (coarse.length > 0 && coarse.length < all.length) {
            const parent = flat(roots, (_r, n) => coarse.every(([k, v]) => n.ids[k] === v) && FINE.every(k => n.ids[k] === undefined));
            if (parent.length > 0) return done('coarser-ids', parent);
        }
        return done('unplaced', []);
    }

    // The part names nothing a node carries (a description, or a building): the layers showing the rung it fell to.
    const inBuilding = (r: PlacementRoot<N>) => r.showing && (d.part.buildingId === undefined || r.buildingId === undefined || r.buildingId === d.part.buildingId);
    const fell = (n: N) => n.provenance.label === d.provenanceAfter;
    const own = flat(roots, (r, n) => r.layer.stage === d.stage && inBuilding(r) && fell(n));
    if (own.length > 0) return done('stage', own);
    const anywhere = flat(roots, (r, n) => inBuilding(r) && fell(n));
    if (anywhere.length > 0) return done('label', anywhere);
    return done('unplaced', []);
}

/** The placement of every record on the loaded layers. A record is placed only on nodes that are loaded now. */
export function placeDegradations<N extends PlacementNode>(roots: PlacementRoot<N>[], degradations: readonly DegradationRecord[]): Map<string, Placement<N>> {
    const out = new Map<string, Placement<N>>();
    for (const d of degradations) {
        const { tier, nodes } = place(d, roots);
        const placed = new Set<N>(nodes);
        const layerIds = roots.filter(r => r.nodes.some(n => placed.has(n))).map(r => r.layer.objectId);
        out.set(d.id, { tier, scope: SCOPE[tier], nodes, layerIds });
    }
    return out;
}

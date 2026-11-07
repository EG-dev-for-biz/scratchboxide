/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport's Parts view: a 3D object or building shown as the parts it is made of, the way the Map data view
 * shows a place as its map data. The parts come from what the model itself carries (its nodes' and materials' `sb*`
 * extras: a rebuilt facade, a base skirt, a seal route, a staged part with its provenance, an object build's part, a
 * scan piece cut to the footprint), so a model nobody anticipated still lists by whatever extras it has, and one with
 * none lists its meshes. The setting lives in the scene (Scene3DData.partsView); the drawing in
 * browser/generative-canvas/primitives/scene3d/modelParts.ts.
 */

export interface ModelPartsViewConfig {
    on: boolean;
    /** Part keys switched off (hidden in the viewport). */
    hidden?: string[];
    /** One part key shown alone (the rest hidden), when set. */
    solo?: string;
    /** Every part drawn in its own flat colour over the model, so the parts read apart (default on). */
    tint?: boolean;
}

export const PARTS_VIEW_OPERATOR = 'set_parts_view';
export const PARTS_VIEW_CLEAR_OPERATOR = 'clear_parts_view';

export function partsTintOn(cfg: ModelPartsViewConfig | undefined): boolean {
    return cfg?.tint ?? true;
}

/** Whether a part is drawn under the config: not hidden, and the solo part when one is set. */
export function partShown(cfg: Pick<ModelPartsViewConfig, 'hidden' | 'solo'> | undefined, key: string): boolean {
    if (!cfg) return true;
    if (cfg.solo) return cfg.solo === key;
    return !(cfg.hidden ?? []).includes(key);
}

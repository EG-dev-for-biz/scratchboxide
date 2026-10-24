/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Bridges renderCanonicalViews' RenderedView (camera + PNG) to projectMaskedViewsToUv's PinholeView (camera + mask):
 * segments each self-rendered view for the described surface, the same SegmentImage interface and MASK_YES/MASK_NO
 * convention facade-material-evidence.ts holds real photos to. A segmenter call that finds nothing is a real "not it"
 * (MASK_NO everywhere), not an unread view: it still counts against acceptance if another view disagrees.
 */

import { MASK_NO, FACADE_GLASS_TARGET, type SegmentImage } from '../3d-engine/staged-location/facade-material-evidence';
import { renderCanonicalViews, type CanonicalViewOptions, type RenderedView } from './specular-canonical-views';
import type { PinholeView } from './specular-material-projection';

export interface SelfRenderEvidenceOptions extends CanonicalViewOptions {
    /** The described surface the segmenter looks for (default facade-material-evidence.ts's glass target). */
    target?: string;
    signal?: AbortSignal;
}

/** Segments one already-rendered view for `target`, returning a PinholeView ready for projectMaskedViewsToUv. */
export async function segmentRenderedView(view: RenderedView, target: string, segment: SegmentImage, signal?: AbortSignal): Promise<PinholeView> {
    const { mask } = await segment(view.png, view.width, view.height, target, signal);
    return { ...view, mask: mask ?? new Uint8Array(view.width * view.height).fill(MASK_NO) };
}

/** Self-renders a few canonical views of `glbPath` and segments each for `target` (default the glass target). */
export async function gatherSelfRenderEvidence(glbPath: string, segment: SegmentImage, opts: SelfRenderEvidenceOptions = {}): Promise<PinholeView[]> {
    const target = opts.target ?? FACADE_GLASS_TARGET;
    const views = await renderCanonicalViews(glbPath, opts);
    const out: PinholeView[] = [];
    for (const v of views) out.push(await segmentRenderedView(v, target, segment, opts.signal));
    return out;
}

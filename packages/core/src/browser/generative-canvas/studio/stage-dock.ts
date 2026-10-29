/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The docked frame: a second artifact shown beside the main stage, dragged there from its tab, so two surfaces (a build's
 * node graph and its 3D viewport) are seen at once. The main stage keeps working as before (the chat focus, the canvas
 * maximize and the viewport fit act on the stage as a whole); the dock only takes a share of it.
 */

import type { CanvasArtifact } from '../canvas-types';

export type DockSide = 'left' | 'right' | 'top' | 'bottom';

export interface StageDock {
    artifactId: string;
    side: DockSide;
    /** The docked frame's share of the stage along its side's axis, 0.2-0.8. */
    ratio: number;
}

/** The drag payload a tab carries (its artifact id). */
export const TAB_DRAG_TYPE = 'application/x-scratchbox-artifact-tab';

export const DOCK_RATIO_DEFAULT = 0.45;
export const DOCK_RATIO_MIN = 0.2;
export const DOCK_RATIO_MAX = 0.8;
/** Share of the stage's width (or height, for the top and bottom) near an edge that docks there. */
const EDGE_SHARE = 0.3;

export const clampDockRatio = (r: number) => Math.min(DOCK_RATIO_MAX, Math.max(DOCK_RATIO_MIN, r));

/**
 * Where a tab dropped at (x, y) in the stage's rectangle docks: the nearest edge within its band (left, right, top, bottom),
 * or undefined in the middle (a drop there just opens the tab, as a click does).
 */
export function dockSideAt(x: number, y: number, rect: { left: number; top: number; width: number; height: number }): DockSide | undefined {
    const u = (x - rect.left) / rect.width, v = (y - rect.top) / rect.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return undefined;
    const bands: Array<[DockSide, number]> = [['left', u], ['right', 1 - u], ['top', v], ['bottom', 1 - v]];
    const near = bands.filter(([, d]) => d < EDGE_SHARE).sort((a, b) => a[1] - b[1]);
    return near[0]?.[0];
}

/** Why an artifact cannot be docked beside the main one, or undefined when it can. */
export function dockRefusal(docked: CanvasArtifact | undefined, main: CanvasArtifact | undefined): string | undefined {
    if (!docked) return 'that tab is no longer open';
    if (main && docked.id === main.id) return 'it is already the main view';
    // one 3D viewport at a time: the viewport keeps page-wide state (its fit-to-view event, the active scene element)
    if (docked.type === '3d-scene' && main?.type === '3d-scene') return 'only one 3D viewport can be open at a time';
    return undefined;
}

/**
 * The dock as the stage shows it now: dropped when its artifact is closed or has become the main view (the tab was
 * clicked), so the stage never shows one artifact twice.
 */
export function liveDock(dock: StageDock | undefined, main: CanvasArtifact | undefined, open: CanvasArtifact[]): { dock: StageDock; artifact: CanvasArtifact } | undefined {
    if (!dock) return undefined;
    const artifact = open.find(a => a.id === dock.artifactId);
    if (!artifact || dockRefusal(artifact, main)) return undefined;
    return { dock, artifact };
}

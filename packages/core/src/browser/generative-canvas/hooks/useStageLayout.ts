/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import type { StageLayoutMode } from '../canvas-types';
import type { StageDock } from '../studio/stage-dock';

/**
 * The stage's layout: one artifact or two split side by side, and a second artifact docked beside the main stage,
 * dragged there from its tab (studio/stage-dock.ts). Held by the Studio, not the stage, so a dock outlives the
 * document pane collapsing.
 */
export function useStageLayout() {
    const [stageLayoutMode, setStageLayoutMode] = React.useState<StageLayoutMode>('single');
    const [stageDock, setStageDock] = React.useState<StageDock | undefined>();
    return { stageLayoutMode, setStageLayoutMode, stageDock, setStageDock };
}

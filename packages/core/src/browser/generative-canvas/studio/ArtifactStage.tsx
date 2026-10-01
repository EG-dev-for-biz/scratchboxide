/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { RelatedArtifactsRail } from '../RelatedArtifactsRail';
import { ArtifactStageProps } from './artifact-stage-props';
import { CanvasCardBody } from './CanvasCardBody';
import { CanvasCardHeader } from './CanvasCardHeader';

export type { ArtifactStageProps } from './artifact-stage-props';

/** Right-hand artifact stage: the glass canvas card with header, related-artifacts rail and primitive body. */
export const ArtifactStage: React.FC<ArtifactStageProps> = props => {
    const { documentPaneState, relatedArtifacts, handleSelectRelatedArtifact, handleOpenRelatedInBento } = props;
    return (
    <div className="sb-canvas-split-right-pane sb-document-split-right-pane" style={{
        flex: 1,
        width: documentPaneState === 'expanded' ? '100%' : undefined,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        boxSizing: 'border-box',
        background: 'transparent',
        minWidth: 0,
    }}>
        {/* ChatGPT-style document/canvas workspace frame / card wrapper */}
        <div className="sb-chatgpt-document-card sb-glass-card" style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            margin: documentPaneState === 'expanded' ? '12px' : '10px 14px 12px 6px',
            borderRadius: '16px',
            overflow: 'hidden',
            position: 'relative',
            minHeight: 0
        }}>
        <CanvasCardHeader {...props} />

        <CanvasCardBody {...props} />
    </div>
</div>
    );
};

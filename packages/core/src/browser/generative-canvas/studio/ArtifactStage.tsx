/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
        width: documentPaneState === 'expanded' ? '100%' : '55%',
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
            margin: '16px',
            borderRadius: '16px',
            overflow: 'hidden',
            position: 'relative',
            minHeight: 0
        }}>
        <CanvasCardHeader {...props} />

        <RelatedArtifactsRail
            items={relatedArtifacts}
            onSelect={handleSelectRelatedArtifact}
            onOpenBento={handleOpenRelatedInBento}
        />

        <CanvasCardBody {...props} />
    </div>
</div>
    );
};

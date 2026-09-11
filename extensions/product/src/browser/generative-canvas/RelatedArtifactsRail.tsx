/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { RelatedArtifact } from '../../common/project-artifact-graph-protocol';
import { getPrimitiveSvgIcon } from './canvas-icons';
import { PrimitiveType } from './canvas-types';

export interface RelatedArtifactsRailProps {
    items: RelatedArtifact[];
    onSelect: (artifactId: string) => void;
    onOpenBento: (artifactId: string) => void;
}

export const RelatedArtifactsRail: React.FC<RelatedArtifactsRailProps> = ({ items, onSelect, onOpenBento }) => {
    if (items.length === 0) {
        return <React.Fragment />;
    }
    return (
        <div
            className="sb-related-artifacts-rail"
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderBottom: '1px solid var(--theia-border, rgba(255,255,255,.08))',
                background: 'var(--theia-sideBar-background, #141416)',
                overflowX: 'auto',
                flexShrink: 0
            }}
        >
            <span style={{ fontSize: 10, opacity: 0.65, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Related
            </span>
            {items.map(item => (
                <button
                    key={item.edge.id}
                    type="button"
                    className="sb-btn sb-btn-secondary sb-btn-xs"
                    onClick={() => onSelect(item.artifact.id)}
                    onDoubleClick={() => onOpenBento(item.artifact.id)}
                    title={`${item.direction === 'incoming' ? 'Backlink' : 'Related'} via ${item.edge.type}. Double-click for bento view.`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
                >
                    {getPrimitiveSvgIcon(item.artifact.kind as PrimitiveType, 11)}
                    <span>{item.artifact.title}</span>
                    <span style={{ opacity: 0.55 }}>· {item.edge.type}</span>
                </button>
            ))}
        </div>
    );
};

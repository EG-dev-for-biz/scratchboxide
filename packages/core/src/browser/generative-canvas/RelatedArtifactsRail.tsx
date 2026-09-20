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
    activeArtifactTitle?: string;
}

export const RelatedArtifactsRail: React.FC<RelatedArtifactsRailProps> = ({ items, onSelect, onOpenBento, activeArtifactTitle }) => {
    if (items.length === 0) {
        return <React.Fragment />;
    }
    const seen = new Set<string>();
    const uniqueItems = items.filter(item => {
        if (seen.has(item.artifact.id)) return false;
        seen.add(item.artifact.id);
        return true;
    });

    const getDisplayTitle = (title: string): string => {
        if (activeArtifactTitle && title.toLowerCase().startsWith(activeArtifactTitle.toLowerCase())) {
            const suffix = title.slice(activeArtifactTitle.length).replace(/^[\s\-_:·]+/, '');
            if (suffix.length > 2) return suffix;
        }
        return title;
    };

    return (
        <div
            className="sb-related-artifacts-rail"
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                borderBottom: '1px solid var(--sb-ui-card-border, rgba(255, 255, 255, 0.08))',
                background: 'var(--sb-surface-card, rgba(255, 255, 255, 0.03))',
                color: 'var(--sb-text-secondary, #94a3b8)',
                overflowX: 'auto',
                flexShrink: 0
            }}
        >
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--sb-text-tertiary, #94a3b8)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Related
            </span>
            {uniqueItems.map(item => {
                const displayTitle = getDisplayTitle(item.artifact.title);
                return (
                    <button
                        key={item.edge.id}
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs"
                        onClick={() => onSelect(item.artifact.id)}
                        onDoubleClick={() => onOpenBento(item.artifact.id)}
                        title={`${item.artifact.title} (${item.direction === 'incoming' ? 'Backlink' : 'Related'} via ${item.edge.type}). Double-click for bento view.`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
                    >
                        {getPrimitiveSvgIcon(item.artifact.kind as PrimitiveType, 11)}
                        <span style={{ maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle}</span>
                        <span style={{ opacity: 0.55 }}>· {item.edge.type}</span>
                    </button>
                );
            })}
        </div>
    );
};

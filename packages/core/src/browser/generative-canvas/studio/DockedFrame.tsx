/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { renderArtifactSurface } from '../BentoStageLayout';
import { CanvasArtifact, PrimitiveType, Scene3DData } from '../canvas-types';
import { CanvasErrorBoundary } from '../CanvasErrorBoundary';
import { Scene3DPrimitive } from '../primitives/Scene3DPrimitive';
import { morphArtifact } from '../primitive-transformer-engine';
import { clampDockRatio, DockSide, TAB_DRAG_TYPE } from './stage-dock';

export interface DockedFrameProps {
    artifact: CanvasArtifact;
    getArtifactIcon: (type: PrimitiveType | string) => string;
    workspacePath?: string;
    onUpdateArtifact: (artifact: CanvasArtifact) => void;
    onMorphArtifact: (artifact: CanvasArtifact) => void;
    onPromptAction: (promptText: string) => void;
    onOpenInBrowser: (url: string, title?: string) => void;
    /** Make it the main view (the main one takes its place in the dock). */
    onSwap: () => void;
    onUndock: () => void;
}

/** The docked artifact's own surface, with a header to swap it into the main view or undock it. */
export const DockedFrame: React.FC<DockedFrameProps> = ({ artifact, getArtifactIcon, workspacePath, onUpdateArtifact, onMorphArtifact, onPromptAction, onOpenInBrowser, onSwap, onUndock }) => (
    <div className="sb-docked-frame" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1, background: 'var(--sb-editor-background, #18181b)' }}>
        <div
            className="sb-docked-frame-header"
            draggable
            onDragStart={e => { e.dataTransfer.setData(TAB_DRAG_TYPE, artifact.id); e.dataTransfer.effectAllowed = 'move'; }}
            title="Drag to another edge to move the docked frame"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 12, borderBottom: '1px solid var(--sb-border, rgba(255,255,255,0.08))', color: 'var(--sb-foreground, #ddd)', cursor: 'grab', flex: '0 0 auto' }}
        >
            <span aria-hidden>{getArtifactIcon(artifact.type)}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.title}</span>
            <button type="button" className="sb-btn" title="Make this the main view" onClick={onSwap} style={{ fontSize: 11, padding: '2px 6px' }}>⇄ Swap</button>
            <button type="button" className="sb-btn" title="Undock (close this frame; the tab stays open)" aria-label="Undock" onClick={onUndock} style={{ fontSize: 11, padding: '2px 6px' }}>✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', overflow: artifact.type === '3d-scene' ? 'hidden' : 'auto' }}>
            <CanvasErrorBoundary fallbackTitle={`Docked: ${artifact.title}`}>
                {artifact.type === '3d-scene' ? (
                    <Scene3DPrimitive
                        key={`docked-${artifact.id}`}
                        activeArtifact={artifact}
                        data={{ ...((artifact.data as Scene3DData) || {}), title: (artifact.data as Scene3DData)?.title || artifact.title }}
                        onUpdate={updatedData => onUpdateArtifact({ ...artifact, data: updatedData })}
                        onPromptAction={onPromptAction}
                        onMorphArtifact={(a, targetType) => onMorphArtifact(morphArtifact(a, targetType as PrimitiveType))}
                    />
                ) : renderArtifactSurface(artifact, { onUpdateArtifact, onPromptAction, onOpenInBrowser, workspacePath })}
            </CanvasErrorBoundary>
        </div>
    </div>
);

/** The bar between the main stage and the docked frame: dragging it sets the dock's share; a double-click resets it. */
export const DockSplitter: React.FC<{ side: DockSide; containerRef: React.RefObject<HTMLDivElement | null>; onRatio: (ratio: number) => void; onReset: () => void }> = ({ side, containerRef, onRatio, onReset }) => {
    const vertical = side === 'left' || side === 'right';
    const onMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        const move = (ev: MouseEvent) => {
            const r = containerRef.current?.getBoundingClientRect();
            if (!r) return;
            const share = side === 'left' ? (ev.clientX - r.left) / r.width : side === 'right' ? (r.right - ev.clientX) / r.width : side === 'top' ? (ev.clientY - r.top) / r.height : (r.bottom - ev.clientY) / r.height;
            onRatio(clampDockRatio(share));
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; };
        document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    };
    return (
        <div
            className="sb-dock-splitter"
            role="separator"
            aria-orientation={vertical ? 'vertical' : 'horizontal'}
            title="Drag to resize; double-click to reset"
            onMouseDown={onMouseDown}
            onDoubleClick={onReset}
            style={{ flex: '0 0 5px', cursor: vertical ? 'col-resize' : 'row-resize', background: 'var(--sb-border, rgba(255,255,255,0.08))' }}
        />
    );
};

/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import {
    CanvasArtifact,
    KanbanBoardData,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    NodeGraphData,
    InteractiveBrowserData,
    PrimitiveType,
    StageLayoutMode
} from './canvas-types';
import { LiveCodeSandboxPrimitive } from './primitives/LiveCodeSandboxPrimitive';
import { MarkdownDocumentPrimitive } from './primitives/MarkdownDocumentPrimitive';
import { KanbanBoardPrimitive } from './primitives/KanbanBoardPrimitive';
import { NodeGraphPrimitive } from './primitives/NodeGraphPrimitive';
import { InteractiveBrowserPrimitive } from './primitives/InteractiveBrowserPrimitive';
import {
    IconMaximize,
    IconSparkles,
    IconSplit,
    getPrimitiveSvgIcon
} from './canvas-icons';

export interface BentoStageLayoutProps {
    layoutMode: StageLayoutMode;
    onLayoutModeChange?: (mode: StageLayoutMode) => void;
    artifacts: CanvasArtifact[];
    activeArtifactId?: string;
    onSelectArtifact?: (id: string) => void;
    onUpdateArtifact?: (artifact: CanvasArtifact) => void;
    onMorphArtifact?: (artifact: CanvasArtifact, targetType: PrimitiveType) => void;
    onPromptAction?: (promptText: string) => void;
    onOpenInBrowser?: (url: string, title?: string) => void;
    workspacePath?: string;
}

export const BentoStageLayout: React.FC<BentoStageLayoutProps> = ({
    layoutMode = 'single',
    onLayoutModeChange,
    artifacts = [],
    activeArtifactId,
    onSelectArtifact,
    onUpdateArtifact,
    onMorphArtifact,
    onPromptAction,
    onOpenInBrowser,
    workspacePath
}) => {
    const [focusedPaneIndex, setFocusedPaneIndex] = React.useState<number>(0);
    const [paneArtifactIds, setPaneArtifactIds] = React.useState<string[]>(() => {
        const ids: string[] = [];
        if (activeArtifactId) {
            ids.push(activeArtifactId);
        }
        for (const art of artifacts) {
            if (!ids.includes(art.id)) {
                ids.push(art.id);
            }
            if (ids.length >= 4) break;
        }
        return ids;
    });

    React.useEffect(() => {
        if (activeArtifactId && !paneArtifactIds.includes(activeArtifactId)) {
            setPaneArtifactIds(prev => [activeArtifactId, ...prev.slice(0, 3)]);
        }
    }, [activeArtifactId]);

    const getArtifactForPane = (index: number): CanvasArtifact | undefined => {
        const targetId = paneArtifactIds[index];
        if (targetId) {
            const found = artifacts.find(a => a.id === targetId);
            if (found) return found;
        }
        return artifacts[index] || artifacts[0];
    };

    const handleAssignPaneArtifact = (paneIndex: number, newArtifactId: string) => {
        setPaneArtifactIds(prev => {
            const next = [...prev];
            next[paneIndex] = newArtifactId;
            return next;
        });
        if (onSelectArtifact) {
            onSelectArtifact(newArtifactId);
        }
    };

    const renderPrimitiveContent = (artifact?: CanvasArtifact) => {
        if (!artifact) {
            return (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: 'var(--theia-descriptionForeground, #888)',
                    padding: '24px',
                    textAlign: 'center'
                }}>
                    <div style={{ opacity: 0.4, marginBottom: 12 }}>
                        <IconSparkles size={32} />
                    </div>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>No surface active in this pane</p>
                    <p style={{ margin: '4px 0 0', fontSize: 11, opacity: 0.7 }}>Select an artifact from the header above</p>
                </div>
            );
        }

        switch (artifact.type) {
            case 'live-code-sandbox':
                return (
                    <LiveCodeSandboxPrimitive
                        data={artifact.data as LiveCodeSandboxData}
                        onUpdate={updatedData => onUpdateArtifact?.({ ...artifact, data: updatedData })}
                        onPromptAction={onPromptAction}
                        hideTopbar={true}
                    />
                );
            case 'markdown-document':
                return (
                    <MarkdownDocumentPrimitive
                        data={artifact.data as MarkdownDocumentData}
                        onUpdate={(updatedData: MarkdownDocumentData) => onUpdateArtifact?.({ ...artifact, data: updatedData })}
                        onPromptAction={onPromptAction}
                        onOpenInBrowser={onOpenInBrowser}
                        workspacePath={workspacePath}
                    />
                );
            case 'kanban-board':
                return (
                    <KanbanBoardPrimitive
                        data={artifact.data as KanbanBoardData}
                        onUpdate={updatedData => onUpdateArtifact?.({ ...artifact, data: updatedData })}
                    />
                );
            case 'interactive-browser':
            case 'browser':
                return (
                    <InteractiveBrowserPrimitive
                        data={artifact.data as InteractiveBrowserData}
                        onUpdate={updatedData => onUpdateArtifact?.({ ...artifact, data: updatedData })}
                        onPromptAction={onPromptAction}
                    />
                );
            case 'node-graph':
                return (
                    <NodeGraphPrimitive
                        data={artifact.data as NodeGraphData}
                        onUpdate={updatedData => onUpdateArtifact?.({ ...artifact, data: updatedData })}
                        workspacePath={workspacePath}
                    />
                );
            default:
                return (
                    <div style={{ padding: 24, color: 'var(--theia-foreground, #ccc)' }}>
                        <h3>{artifact.title}</h3>
                        <p>{artifact.summary}</p>
                    </div>
                );
        }
    };

    const renderPane = (paneIndex: number, style?: React.CSSProperties) => {
        const artifact = getArtifactForPane(paneIndex);
        const isFocused = focusedPaneIndex === paneIndex;

        return (
            <div
                key={`bento-pane-${paneIndex}`}
                onClick={() => setFocusedPaneIndex(paneIndex)}
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    position: 'relative',
                    overflow: 'hidden',
                    backgroundColor: 'var(--theia-editor-background, #18181b)',
                    border: isFocused
                        ? '1px solid rgba(59, 130, 246, 0.6)'
                        : '1px solid var(--theia-border, rgba(255, 255, 255, 0.08))',
                    borderRadius: 8,
                    boxShadow: isFocused ? '0 0 0 1px rgba(59, 130, 246, 0.3)' : 'none',
                    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                    minWidth: 0,
                    minHeight: 0,
                    ...style
                }}
            >
                {/* Pane Header */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 12px',
                    height: 36,
                    backgroundColor: 'var(--theia-tab-inactiveBackground, #1e1e24)',
                    borderBottom: '1px solid var(--theia-border, rgba(255, 255, 255, 0.06))',
                    fontSize: 12,
                    userSelect: 'none'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                        {artifact && getPrimitiveSvgIcon(artifact.type)}
                        <select
                            value={artifact?.id || ''}
                            onChange={e => handleAssignPaneArtifact(paneIndex, e.target.value)}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--theia-foreground, #e4e4e7)',
                                fontSize: 12,
                                fontWeight: 500,
                                outline: 'none',
                                cursor: 'pointer',
                                maxWidth: 180,
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden'
                            }}
                        >
                            {artifacts.map(a => (
                                <option key={a.id} value={a.id} style={{ background: '#1e1e24', color: '#fff' }}>
                                    {a.title} ({a.type})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {artifact && (
                            <span style={{
                                fontSize: 10,
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                                padding: '2px 6px',
                                borderRadius: 4,
                                backgroundColor: 'rgba(255, 255, 255, 0.06)',
                                color: 'var(--theia-descriptionForeground, #a1a1aa)'
                            }}>
                                {artifact.type.replace('-', ' ')}
                            </span>
                        )}

                        {onLayoutModeChange && layoutMode !== 'single' && (
                            <button
                                type="button"
                                className="sb-icon-button"
                                title="Maximize this pane"
                                onClick={e => {
                                    e.stopPropagation();
                                    if (artifact) onSelectArtifact?.(artifact.id);
                                    onLayoutModeChange('single');
                                }}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'var(--theia-descriptionForeground, #a1a1aa)',
                                    cursor: 'pointer',
                                    padding: '2px 4px',
                                    borderRadius: 4
                                }}
                            >
                                <IconMaximize size={13} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Pane Content */}
                <div style={{ flex: 1, position: 'relative', overflow: 'auto' }}>
                    {renderPrimitiveContent(artifact)}
                </div>
            </div>
        );
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
            {/* Top Layout Mode Switcher Bar */}
            {onLayoutModeChange && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 12px',
                    height: 32,
                    backgroundColor: 'var(--sb-surface-elevated, #ffffff)',
                    borderBottom: '1px solid var(--sb-surface-border, rgba(0, 0, 0, 0.07))',
                    color: 'var(--sb-text-secondary, #475569)',
                    fontSize: 11
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--sb-text-secondary, #64748b)' }}>
                        <IconSplit size={13} />
                        <span style={{ fontWeight: 500 }}>Multi-Surface Stage:</span>
                    </div>

                    <div className="sb-segmented-control sb-segmented-control-xs" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {(['single', 'dual-split-horizontal', 'dual-split-vertical', 'tri-pane-bento', 'quad-grid'] as StageLayoutMode[]).map(mode => (
                            <button
                                type="button"
                                key={mode}
                                className={`sb-segment-btn ${layoutMode === mode ? 'sb-segment-active' : ''}`}
                                onClick={() => onLayoutModeChange(mode)}
                                style={{
                                    padding: '3px 9px',
                                    fontSize: 11,
                                    fontWeight: layoutMode === mode ? 600 : 400,
                                    borderRadius: 6,
                                    border: layoutMode === mode
                                        ? '1px solid rgba(59, 130, 246, 0.4)'
                                        : '1px solid transparent',
                                    backgroundColor: layoutMode === mode
                                        ? 'rgba(59, 130, 246, 0.15)'
                                        : 'transparent',
                                    color: layoutMode === mode
                                        ? '#60a5fa'
                                        : 'var(--theia-descriptionForeground, #a1a1aa)',
                                    cursor: 'pointer',
                                    transition: 'all 0.12s ease'
                                }}
                            >
                                {mode === 'single' && 'Single'}
                                {mode === 'dual-split-horizontal' && 'Dual Horizontal'}
                                {mode === 'dual-split-vertical' && 'Dual Vertical'}
                                {mode === 'tri-pane-bento' && 'Tri-Pane Bento'}
                                {mode === 'quad-grid' && 'Quad Grid'}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Layout Stage Panes */}
            <div style={{ flex: 1, padding: 8, overflow: 'hidden' }}>
                {layoutMode === 'single' && (
                    <div style={{ width: '100%', height: '100%' }}>
                        {renderPane(0, { width: '100%', height: '100%' })}
                    </div>
                )}

                {layoutMode === 'dual-split-horizontal' && (
                    <div style={{ display: 'flex', gap: 8, width: '100%', height: '100%' }}>
                        {renderPane(0, { flex: 1, height: '100%' })}
                        {renderPane(1, { flex: 1, height: '100%' })}
                    </div>
                )}

                {layoutMode === 'dual-split-vertical' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', height: '100%' }}>
                        {renderPane(0, { width: '100%', flex: 1 })}
                        {renderPane(1, { width: '100%', flex: 1 })}
                    </div>
                )}

                {layoutMode === 'tri-pane-bento' && (
                    <div style={{ display: 'flex', gap: 8, width: '100%', height: '100%' }}>
                        {/* Left Hero Pane (60%) */}
                        {renderPane(0, { flex: 3, height: '100%' })}
                        {/* Right Stacked Panes (40%) */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 2, height: '100%' }}>
                            {renderPane(1, { width: '100%', flex: 1 })}
                            {renderPane(2, { width: '100%', flex: 1 })}
                        </div>
                    </div>
                )}

                {layoutMode === 'quad-grid' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 8, width: '100%', height: '100%' }}>
                        {renderPane(0, { width: '100%', height: '100%' })}
                        {renderPane(1, { width: '100%', height: '100%' })}
                        {renderPane(2, { width: '100%', height: '100%' })}
                        {renderPane(3, { width: '100%', height: '100%' })}
                    </div>
                )}
            </div>
        </div>
    );
};

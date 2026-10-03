/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import {
    IconCode,
    IconEdit,
    IconPlus,
    IconSparkles,
    IconSplit,
    IconMoreVertical,
    IconExpandCorners,
    IconSidebarToggle,
    IconMinimize,
    IconCheck,
    IconDocument,
    IconFolder
} from '../canvas-icons';
import { ArtifactStageProps } from './artifact-stage-props';

/** Artifact tab strip on the left of the canvas card header (Studio / VS Code style). */
export const CanvasTabsBar: React.FC<ArtifactStageProps> = props => {
    const { activeArtifact, layoutMode, docReadOnly, canvasArtifactTabs, getArtifactIcon, getCanvasHeaderLabel, handleSelectArtifactTab, handleCloseArtifactTab, handleCreateNewSandboxTab } = props;
    const activeTabRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (activeTabRef.current) {
            activeTabRef.current.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
        }
    }, [activeArtifact?.id]);

    return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%', overflow: 'hidden', flex: 1, minWidth: 0 }}>
        {canvasArtifactTabs.length === 0 && (
            <span className="sb-doc-card-title-tag" style={{ fontSize: '12px', fontWeight: 600, padding: '0 12px' }}>{getCanvasHeaderLabel()}</span>
        )}
        {/* Studio Editor Tabs */}
        <div 
            className="sb-canvas-tabs-container" 
            style={{ display: 'flex', alignItems: 'center', height: '100%', flex: '1 1 auto', overflowX: 'auto', scrollbarWidth: 'none' }}
            onWheel={(e) => {
                if (e.deltaY !== 0) {
                    e.currentTarget.scrollLeft += e.deltaY;
                }
            }}
        >
            {canvasArtifactTabs.map(art => {
                const isActive = activeArtifact?.id === art.id;
                return (
                    <div
                        key={art.id}
                        ref={isActive ? activeTabRef : undefined}
                        className={`sb-canvas-tab ${isActive ? 'active' : ''}`}
                        onClick={() => handleSelectArtifactTab(art)}
                        title={`${art.title || art.type} (${art.type})`}
                    >
                        <span className="sb-canvas-tab-icon">{getArtifactIcon(art.type)}</span>
                        <span className="sb-canvas-tab-title">
                            {art.title || art.type}
                        </span>
                        {canvasArtifactTabs.length > 1 && (
                            <button
                                type="button"
                                className="sb-canvas-tab-close"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleCloseArtifactTab(e, art.id);
                                }}
                                title="Close tab"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                );
            })}

            {/* New Tab Button (+) */}
            <button
                type="button"
                className="sb-canvas-new-tab-btn"
                onClick={handleCreateNewSandboxTab}
                title="New Live Sandbox / Artifact Tab (+)"
            >
                <IconPlus size={12} strokeWidth={2} />
            </button>
        </div>

        {layoutMode === 'document' && docReadOnly && <span className="sb-doc-readonly-tag" style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', flexShrink: 0, margin: '0 8px' }}>READ-ONLY</span>}
    </div>
    );
};

/** Version pager, layout/mode switches and export actions on the right of the canvas card header. */
export const CanvasHeaderControls: React.FC<ArtifactStageProps> = props => {
    const {
        activeArtifact,
        activeWorkspace,
        layoutMode,
        documentPaneState,
        setDocumentPaneState,
        docReadOnly,
        setDocReadOnly,
        activeSandboxData,
        syncSandboxSaveToMarkdown,
        getCanvasReopenTabTitle,
        handleSetSandboxViewMode,
        triggerMarkdownExport,
        triggerGoogleDriveSave,
        showToast,
        handleCreateNewSandboxTab,
        currentArtifactVersionsList,
        currentArtifactVersionIndex,
        isCurrentArtifactLatestVersion,
        handleRollbackArtifactToVersion,
        handleSelectVersion
    } = props;

    // Scratchbox Studio overflow menu state & click-outside dismissal
    const [isOverflowOpen, setIsOverflowOpen] = React.useState<boolean>(false);
    const overflowMenuRef = React.useRef<HTMLDivElement>(null);

    // Canvas version history dropdown
    const [isCanvasVersionMenuOpen, setIsCanvasVersionMenuOpen] = React.useState<boolean>(false);
    const canvasVersionMenuRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (!isOverflowOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
                setIsOverflowOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOverflowOpen]);

    React.useEffect(() => {
        if (!isCanvasVersionMenuOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (canvasVersionMenuRef.current && !canvasVersionMenuRef.current.contains(e.target as Node)) {
                setIsCanvasVersionMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isCanvasVersionMenuOpen]);

    const totalVersions = Math.max(currentArtifactVersionsList.length, activeArtifact?.version || 1);
    const displayVersion = Math.min(activeArtifact?.version || (currentArtifactVersionIndex + 1), totalVersions);

    const handleDoneCommit = async () => {
        setIsOverflowOpen(false);
        if (layoutMode === 'document') {
            const nextReadOnly = !docReadOnly;
            setDocReadOnly(nextReadOnly);
            if (nextReadOnly && activeArtifact) {
                try {
                    const rootParam = activeWorkspace?.path ? `?root=${encodeURIComponent(activeWorkspace.path)}` : '';
                    await fetch(`/workspace/sync-artifact${rootParam}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            workspaceRoot: activeWorkspace?.path,
                            artifact: activeArtifact
                        })
                    });
                } catch {
                    // ignore offline
                }
                showToast(`${getCanvasReopenTabTitle()} saved and committed.`, 'check');
            }
        } else {
            if (activeArtifact && activeSandboxData && syncSandboxSaveToMarkdown) {
                syncSandboxSaveToMarkdown(activeSandboxData);
            }
            if (activeArtifact) {
                try {
                    const rootParam = activeWorkspace?.path ? `?root=${encodeURIComponent(activeWorkspace.path)}` : '';
                    await fetch(`/workspace/sync-artifact${rootParam}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            workspaceRoot: activeWorkspace?.path,
                            artifact: activeArtifact
                        })
                    });
                } catch {
                    // ignore offline
                }
            }
            showToast(`${getCanvasReopenTabTitle()} saved and committed.`, 'check');
        }
    };

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            {/* Version History Dropdown if multiple snapshots exist */}
            {activeArtifact && currentArtifactVersionsList.length > 1 && (
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '4px' }} ref={canvasVersionMenuRef}>
                    <button
                        type="button"
                        className="sb-btn sb-btn-xs"
                        onClick={() => setIsCanvasVersionMenuOpen(!isCanvasVersionMenuOpen)}
                        title="Version History — Click to view snapshots"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '3px 8px',
                            borderRadius: '5px',
                            fontSize: '11px',
                            fontWeight: 600,
                            background: isCurrentArtifactLatestVersion ? 'rgba(255, 255, 255, 0.05)' : 'rgba(245, 158, 11, 0.15)',
                            color: isCurrentArtifactLatestVersion ? 'var(--sb-text-secondary)' : '#f59e0b',
                            border: isCurrentArtifactLatestVersion ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid rgba(245, 158, 11, 0.4)'
                        }}
                    >
                        <span>v{displayVersion} of {totalVersions}</span>
                        {!isCurrentArtifactLatestVersion && <span style={{ fontSize: '9px', opacity: 0.8 }}>(Historical)</span>}
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="6 9 12 15 18 9" />
                        </svg>
                    </button>

                    {!isCurrentArtifactLatestVersion && (
                        <button
                            type="button"
                            className="sb-btn sb-btn-xs sb-canvas-restore-btn animate-fadeIn"
                            onClick={() => handleRollbackArtifactToVersion(activeArtifact)}
                            title={`Restore v${activeArtifact.version || currentArtifactVersionIndex + 1} as new head version`}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '3px',
                                padding: '3px 8px',
                                borderRadius: '5px',
                                fontSize: '11px',
                                fontWeight: 600,
                                background: '#f59e0b',
                                color: '#000000',
                                border: 'none',
                                cursor: 'pointer'
                            }}
                        >
                            Restore
                        </button>
                    )}

                    {isCanvasVersionMenuOpen && (
                        <div
                            className="sb-canvas-version-history-popover animate-scaleIn"
                            style={{
                                position: 'absolute',
                                top: '100%',
                                right: 0,
                                marginTop: '6px',
                                width: '280px',
                                background: 'var(--sb-surface-elevated, #18181b)',
                                border: '1px solid var(--sb-surface-border, rgba(255, 255, 255, 0.12))',
                                borderRadius: '10px',
                                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
                                zIndex: 100,
                                padding: '6px',
                                backdropFilter: 'blur(20px)'
                            }}
                        >
                            <div style={{ padding: '6px 8px 4px 8px', fontSize: '10px', fontWeight: 700, color: 'var(--sb-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                Version History ({currentArtifactVersionsList.length} Snapshots)
                            </div>
                            <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                                {currentArtifactVersionsList.map((verSnapshot, vIdx) => {
                                    const isSelected = (verSnapshot.version || 1) === (activeArtifact.version || 1);
                                    const isLatestVer = vIdx === currentArtifactVersionsList.length - 1;
                                    return (
                                        <div
                                            key={`${verSnapshot.id}-ver-${verSnapshot.version || vIdx}`}
                                            className={`sb-ver-menu-item ${isSelected ? 'sb-ver-item-selected' : ''}`}
                                            onClick={() => {
                                                handleSelectVersion(verSnapshot);
                                                setIsCanvasVersionMenuOpen(false);
                                            }}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                padding: '8px 10px',
                                                borderRadius: '6px',
                                                cursor: 'pointer',
                                                marginBottom: '2px',
                                                background: isSelected ? 'var(--sb-system-blue-subtle, rgba(37, 99, 235, 0.15))' : 'transparent',
                                                border: isSelected ? '1px solid var(--sb-system-blue, #2563eb)' : '1px solid transparent',
                                                transition: 'background 0.15s ease'
                                            }}
                                        >
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                    <span style={{
                                                        fontSize: '10px',
                                                        fontWeight: 700,
                                                        padding: '1px 5px',
                                                        borderRadius: '4px',
                                                        background: isLatestVer ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                                                        color: isLatestVer ? '#10b981' : 'var(--sb-text-secondary)'
                                                    }}>
                                                        v{verSnapshot.version || vIdx + 1} {isLatestVer ? '• Latest' : ''}
                                                    </span>
                                                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--sb-text-label)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                        {verSnapshot.title || `Snapshot v${verSnapshot.version || vIdx + 1}`}
                                                    </span>
                                                </div>
                                                {verSnapshot.summary && (
                                                    <span style={{ fontSize: '10px', color: 'var(--sb-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                        {verSnapshot.summary}
                                                    </span>
                                                )}
                                            </div>
                                            {isSelected && (
                                                <span style={{ color: '#2563eb', fontWeight: 700, fontSize: '12px', marginLeft: '6px' }}>✓</span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Minimalist Segmented View Mode Pill: Code | Split | Preview (only on Live Code Sandbox) */}
            {activeArtifact?.type === 'live-code-sandbox' && (
                <div
                    className="sb-segmented-control sb-segmented-control-xs"
                    title="Live Sandbox View Mode"
                    style={{ marginRight: '4px' }}
                >
                    <button
                        type="button"
                        className={`sb-segment-btn ${(activeSandboxData?.viewMode || 'preview') === 'code' ? 'sb-segment-active' : ''}`}
                        onClick={() => handleSetSandboxViewMode('code')}
                        title="Code Editor"
                    >
                        <IconCode size={11} strokeWidth={2} />
                        <span>Code</span>
                    </button>
                    <button
                        type="button"
                        className={`sb-segment-btn ${(activeSandboxData?.viewMode || 'preview') === 'split' ? 'sb-segment-active' : ''}`}
                        onClick={() => handleSetSandboxViewMode('split')}
                        title="Split Editor & Live Preview"
                    >
                        <IconSplit size={11} strokeWidth={2} />
                        <span>Split</span>
                    </button>
                    <button
                        type="button"
                        className={`sb-segment-btn ${(activeSandboxData?.viewMode || 'preview') === 'preview' ? 'sb-segment-active' : ''}`}
                        onClick={() => handleSetSandboxViewMode('preview')}
                        title="Live Interactive Preview"
                    >
                        <IconSparkles size={11} strokeWidth={2} />
                        <span>Preview</span>
                    </button>
                </div>
            )}

            {/* Split / Maximize Controls */}
            <button
                type="button"
                className={`sb-canvas-icon-btn ${documentPaneState === 'split' ? 'active' : ''}`}
                onClick={() => {
                    if (documentPaneState === 'split') {
                        setDocumentPaneState('collapsed');
                    } else {
                        setDocumentPaneState('split');
                    }
                }}
                title={documentPaneState === 'split' ? "Focus Chat" : "Split View"}
            >
                <IconSidebarToggle size={14} strokeWidth={1.8} />
            </button>

            <button
                type="button"
                className={`sb-canvas-icon-btn ${documentPaneState === 'expanded' ? 'active' : ''}`}
                onClick={() => {
                    if (documentPaneState === 'expanded') {
                        setDocumentPaneState('split');
                    } else {
                        setDocumentPaneState('expanded');
                    }
                }}
                title={documentPaneState === 'expanded' ? "Restore Window" : "Maximize Canvas"}
            >
                {documentPaneState === 'expanded' ? (
                    <IconMinimize size={14} strokeWidth={1.8} />
                ) : (
                    <IconExpandCorners size={14} strokeWidth={1.8} />
                )}
            </button>

            {(layoutMode === '3d' || activeArtifact?.type === '3d-scene') && (
                <button
                    type="button"
                    className="sb-canvas-icon-btn"
                    onClick={() => {
                        window.dispatchEvent(new CustomEvent('sb-3d-fit-to-view'));
                    }}
                    title="Fit Viewport to Scene Geometry (F)"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                    </svg>
                </button>
            )}

            {/* More Actions Overflow Dropdown (⋮) */}
            <div style={{ position: 'relative' }} ref={overflowMenuRef}>
                <button
                    type="button"
                    className={`sb-canvas-icon-btn ${isOverflowOpen ? 'active' : ''}`}
                    onClick={() => setIsOverflowOpen(!isOverflowOpen)}
                    title="More Actions"
                >
                    <IconMoreVertical size={14} strokeWidth={1.8} />
                </button>

                {isOverflowOpen && (
                    <div className="sb-canvas-menu">
                        {/* Done & Commit */}
                        <button
                            type="button"
                            className="sb-canvas-menu-item"
                            onClick={handleDoneCommit}
                        >
                            <span style={{ color: '#10b981', display: 'inline-flex' }}><IconCheck size={13} strokeWidth={2} /></span>
                            <span>{layoutMode === 'document' ? (docReadOnly ? 'Switch to Edit' : 'Done Editing') : 'Done & Commit'}</span>
                        </button>

                        <div className="sb-canvas-menu-divider" />

                        {/* Export 3D Scene (.glb) */}
                        {(layoutMode === '3d' || activeArtifact?.type === '3d-scene') && (
                            <>
                                <button
                                    type="button"
                                    className="sb-canvas-menu-item"
                                    onClick={() => {
                                        setIsOverflowOpen(false);
                                        window.dispatchEvent(new CustomEvent('sb-3d-fit-to-view'));
                                    }}
                                >
                                    <span style={{ fontSize: '13px' }}>🎯</span>
                                    <span>Fit to View (F)</span>
                                </button>
                                <button
                                    type="button"
                                    className="sb-canvas-menu-item"
                                    onClick={() => {
                                        setIsOverflowOpen(false);
                                        window.dispatchEvent(new CustomEvent('sb-export-glb'));
                                    }}
                                >
                                    <span style={{ fontSize: '13px' }}>📦</span>
                                    <span>Export 3D Scene (.glb)</span>
                                </button>
                            </>
                        )}

                        {/* Download Markdown */}
                        <button
                            type="button"
                            className="sb-canvas-menu-item"
                            onClick={() => {
                                setIsOverflowOpen(false);
                                triggerMarkdownExport();
                            }}
                        >
                            <IconDocument size={13} strokeWidth={1.8} />
                            <span>Download Markdown (.md)</span>
                        </button>

                        {/* Save to Drive */}
                        <button
                            type="button"
                            className="sb-canvas-menu-item"
                            onClick={() => {
                                setIsOverflowOpen(false);
                                triggerGoogleDriveSave();
                            }}
                        >
                            <IconFolder size={13} strokeWidth={1.8} />
                            <span>Save to Google Drive</span>
                        </button>

                        <div className="sb-canvas-menu-divider" />

                        {/* New Sandbox Tab */}
                        <button
                            type="button"
                            className="sb-canvas-menu-item"
                            onClick={() => {
                                setIsOverflowOpen(false);
                                handleCreateNewSandboxTab();
                            }}
                        >
                            <IconPlus size={13} strokeWidth={1.8} />
                            <span>New Sandbox Tab</span>
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

/** Header row of the canvas card. */
export const CanvasCardHeader: React.FC<ArtifactStageProps> = props => (
    <div className="sb-document-card-header" style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '35px',
        padding: '0 8px 0 0',
        background: '#141416',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        borderTopLeftRadius: 'inherit',
        borderTopRightRadius: 'inherit',
        overflow: 'hidden',
        userSelect: 'none',
        boxSizing: 'border-box'
    }}>
        <CanvasTabsBar {...props} />
        <CanvasHeaderControls {...props} />
    </div>
);

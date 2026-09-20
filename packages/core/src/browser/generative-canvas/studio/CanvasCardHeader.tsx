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

/** Artifact tab strip, title and version-history dropdown on the left of the canvas card header. */
export const CanvasTabsBar: React.FC<ArtifactStageProps> = props => {
    const { activeArtifact, layoutMode, docReadOnly, canvasArtifactTabs, currentArtifactVersionsList, currentArtifactVersionIndex, isCurrentArtifactLatestVersion, getArtifactIcon, getCanvasHeaderLabel, handleSelectArtifactTab, handleCloseArtifactTab, handleCreateNewSandboxTab, handlePrevArtifactVersion, handleNextArtifactVersion, handleRollbackArtifactToVersion, handleSelectVersion } = props;
    // Canvas version history dropdown (open state + outside-click dismissal)
    const [isCanvasVersionMenuOpen, setIsCanvasVersionMenuOpen] = React.useState<boolean>(false);
    const canvasVersionMenuRef = React.useRef<HTMLDivElement>(null);
    const activeTabRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (activeTabRef.current) {
            activeTabRef.current.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
        }
    }, [activeArtifact?.id]);

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

    return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden', flex: 1, minWidth: 0, marginRight: '12px' }}>
        {canvasArtifactTabs.length === 0 && (
            <span className="sb-doc-card-title-tag" style={{ fontSize: '12px', fontWeight: 600 }}>{getCanvasHeaderLabel()}</span>
        )}
        {/* Scratchbox Studio Minimalist Artifact Tab Strip */}
        <div 
            className="sb-canvas-tabs-container" 
            style={{ maxWidth: 'calc(100% - 150px)', flex: '0 1 auto' }}
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

            {/* Scratchbox New Tab Button (+) */}
            <button
                type="button"
                className="sb-canvas-icon-btn"
                onClick={handleCreateNewSandboxTab}
                style={{ width: '26px', height: '26px', borderRadius: '6px' }}
                title="New Live Sandbox / Artifact Tab (+)"
            >
                <IconPlus size={13} strokeWidth={2} />
            </button>
        </div>

        {layoutMode === 'document' && docReadOnly && <span className="sb-doc-readonly-tag" style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', flexShrink: 0 }}>READ-ONLY</span>}

        {/* Canvas Version History Dropdown & Rollback Button */}
        {activeArtifact && currentArtifactVersionsList.length > 0 && (
            <div className="sb-canvas-header-version-ctrls" ref={canvasVersionMenuRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '6px' }}>
                {currentArtifactVersionsList.length > 1 && (
                    <div className="sb-canvas-ver-stepper-group" style={{ display: 'flex', alignItems: 'center', gap: '2px', background: 'var(--sb-surface-card)', border: '1px solid var(--sb-surface-border)', borderRadius: '6px', padding: '2px 4px' }}>
                        <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-icon-xs sb-canvas-ver-step-btn"
                            onClick={handlePrevArtifactVersion}
                            disabled={currentArtifactVersionIndex <= 0}
                            title="Previous version snapshot"
                            style={{ padding: '2px 4px', fontSize: '10px', opacity: currentArtifactVersionIndex <= 0 ? 0.3 : 1 }}
                        >
                            ◀
                        </button>
                        <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-icon-xs sb-canvas-ver-step-btn"
                            onClick={handleNextArtifactVersion}
                            disabled={currentArtifactVersionIndex >= currentArtifactVersionsList.length - 1}
                            title="Next version snapshot"
                            style={{ padding: '2px 4px', fontSize: '10px', opacity: currentArtifactVersionIndex >= currentArtifactVersionsList.length - 1 ? 0.3 : 1 }}
                        >
                            ▶
                        </button>
                    </div>
                )}

                <button
                    type="button"
                    className={`sb-btn sb-btn-xs sb-canvas-version-dropdown-btn ${isCanvasVersionMenuOpen ? 'sb-btn-active' : 'sb-btn-secondary'}`}
                    onClick={() => setIsCanvasVersionMenuOpen(!isCanvasVersionMenuOpen)}
                    title="Version History — Click to view snapshots"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '4px 8px',
                        borderRadius: '6px',
                        fontSize: '11px',
                        fontWeight: 600,
                        background: isCurrentArtifactLatestVersion ? 'var(--sb-surface-card)' : 'rgba(245, 158, 11, 0.15)',
                        color: isCurrentArtifactLatestVersion ? 'var(--sb-text-secondary)' : '#f59e0b',
                        border: isCurrentArtifactLatestVersion ? '1px solid var(--sb-surface-border)' : '1px solid rgba(245, 158, 11, 0.4)'
                    }}
                >
                    <span>{totalVersions > 1 ? `v${displayVersion} of ${totalVersions}` : `v${displayVersion}`}</span>
                    {!isCurrentArtifactLatestVersion && <span style={{ fontSize: '9px', opacity: 0.8 }}>(Historical)</span>}
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
                            gap: '4px',
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontSize: '11px',
                            fontWeight: 600,
                            background: '#f59e0b',
                            color: '#000000',
                            border: 'none',
                            cursor: 'pointer'
                        }}
                    >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="1 4 1 10 7 10" />
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                        </svg>
                        <span>Restore v{activeArtifact.version || currentArtifactVersionIndex + 1}</span>
                    </button>
                )}

                {isCanvasVersionMenuOpen && (
                    <div
                        className="sb-canvas-version-history-popover animate-scaleIn"
                        style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
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
        handleCreateNewSandboxTab
    } = props;

    // Scratchbox Studio overflow menu state & click-outside dismissal
    const [isOverflowOpen, setIsOverflowOpen] = React.useState<boolean>(false);
    const overflowMenuRef = React.useRef<HTMLDivElement>(null);

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
            {/* Minimalist Segmented View Mode Pill: Code | Split | Preview */}
            {(layoutMode === 'code' || activeArtifact?.type === 'live-code-sandbox') && (
                <div
                    className="sb-segmented-control sb-segmented-control-xs"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        background: 'rgba(0, 0, 0, 0.35)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '7px',
                        padding: '2px',
                        gap: '2px',
                        marginRight: '4px'
                    }}
                    title="Live Sandbox View Mode"
                >
                    <button
                        type="button"
                        className={`sb-btn sb-btn-xs ${(activeSandboxData?.viewMode || 'preview') === 'code' ? 'sb-btn-primary' : 'sb-btn-ghost'}`}
                        onClick={() => handleSetSandboxViewMode('code')}
                        style={{
                            padding: '3px 8px',
                            fontSize: '11px',
                            fontWeight: 600,
                            borderRadius: '5px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}
                        title="Code Editor"
                    >
                        <IconCode size={11} strokeWidth={2} />
                        <span>Code</span>
                    </button>
                    <button
                        type="button"
                        className={`sb-btn sb-btn-xs ${(activeSandboxData?.viewMode || 'preview') === 'split' ? 'sb-btn-primary' : 'sb-btn-ghost'}`}
                        onClick={() => handleSetSandboxViewMode('split')}
                        style={{
                            padding: '3px 8px',
                            fontSize: '11px',
                            fontWeight: 600,
                            borderRadius: '5px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}
                        title="Split Editor & Live Preview"
                    >
                        <IconSplit size={11} strokeWidth={2} />
                        <span>Split</span>
                    </button>
                    <button
                        type="button"
                        className={`sb-btn sb-btn-xs ${(activeSandboxData?.viewMode || 'preview') === 'preview' ? 'sb-btn-primary' : 'sb-btn-ghost'}`}
                        onClick={() => handleSetSandboxViewMode('preview')}
                        style={{
                            padding: '3px 8px',
                            fontSize: '11px',
                            fontWeight: 600,
                            borderRadius: '5px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}
                        title="Live Interactive Preview"
                    >
                        <IconSparkles size={11} strokeWidth={2} />
                        <span>Preview</span>
                    </button>
                </div>
            )}

            {/* Scratchbox Studio Minimalist Controls Group */}
            {/* 1. Toggle Split / Side-by-side View ([|]) */}
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

            {/* 2. Toggle Maximize / Fullscreen ([ ]) */}
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

            {/* 3. More Actions Overflow Dropdown (⋮) */}
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
            padding: '12px 20px',
            userSelect: 'none'
        }}>
        <CanvasTabsBar {...props} />

        <CanvasHeaderControls {...props} />
    </div>
);

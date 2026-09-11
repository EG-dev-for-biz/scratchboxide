/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { IconCode, IconEdit, IconPlus, IconSparkles, IconSplit } from '../canvas-icons';
import { ArtifactStageProps } from './artifact-stage-props';

/** Artifact tab strip, title and version-history dropdown on the left of the canvas card header. */
export const CanvasTabsBar: React.FC<ArtifactStageProps> = props => {
    const { activeArtifact, layoutMode, docReadOnly, canvasArtifactTabs, currentArtifactVersionsList, currentArtifactVersionIndex, isCurrentArtifactLatestVersion, getArtifactIcon, getCanvasHeaderLabel, handleSelectArtifactTab, handleCloseArtifactTab, handleCreateNewSandboxTab, handlePrevArtifactVersion, handleNextArtifactVersion, handleRollbackArtifactToVersion, handleSelectVersion } = props;
    // Canvas version history dropdown (open state + outside-click dismissal)
    const [isCanvasVersionMenuOpen, setIsCanvasVersionMenuOpen] = React.useState<boolean>(false);
    const canvasVersionMenuRef = React.useRef<HTMLDivElement>(null);
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

    return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden', flex: 1, minWidth: 0, marginRight: '12px' }}>
        {canvasArtifactTabs.length === 0 && (
            <span className="sb-doc-card-title-tag" style={{ fontSize: '12px', fontWeight: 600 }}>{getCanvasHeaderLabel()}</span>
        )}
        {/* Persistent Artifact Tab Strip */}
        <div className="sb-canvas-tabs-bar" style={{ display: 'flex', alignItems: 'center', gap: '4px', overflowX: 'auto', maxWidth: '460px', scrollbarWidth: 'none', flexShrink: 0 }}>
            {canvasArtifactTabs.map(art => {
                const isActive = activeArtifact?.id === art.id;
                return (
                    <div
                        key={art.id}
                        className={`sb-canvas-tab-pill ${isActive ? 'sb-canvas-tab-active' : ''}`}
                        onClick={() => handleSelectArtifactTab(art)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '3px 8px',
                            borderRadius: '6px',
                            fontSize: '11px',
                            fontWeight: isActive ? 600 : 500,
                            cursor: 'pointer',
                            background: isActive ? 'var(--sb-system-blue-subtle, rgba(37, 99, 235, 0.22))' : 'rgba(255, 255, 255, 0.05)',
                            border: isActive ? '1px solid var(--sb-system-blue, #2563eb)' : '1px solid rgba(255, 255, 255, 0.08)',
                            color: isActive ? '#ffffff' : 'var(--sb-text-secondary, #94a3b8)',
                            transition: 'all 0.15s ease',
                            whiteSpace: 'nowrap',
                            flexShrink: 0
                        }}
                        title={`${art.title || art.type} (${art.type})`}
                    >
                        <span style={{ fontSize: '11px' }}>{getArtifactIcon(art.type)}</span>
                        <span style={{ maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {art.title || art.type}
                        </span>
                        {canvasArtifactTabs.length > 1 && (
                            <button
                                type="button"
                                className="sb-canvas-tab-close"
                                onClick={(e) => handleCloseArtifactTab(e, art.id)}
                                title="Close tab"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                );
            })}

            {/* New Preview Sandbox Button */}
            <button
                type="button"
                className="sb-btn sb-btn-ghost sb-btn-xs"
                onClick={handleCreateNewSandboxTab}
                style={{
                    padding: '3px 8px',
                    borderRadius: '6px',
                    fontSize: '11px',
                    fontWeight: 500,
                    color: 'var(--sb-text-secondary, #94a3b8)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    border: '1px dashed rgba(255, 255, 255, 0.15)',
                    flexShrink: 0
                }}
                title="Open new live preview sandbox"
            >
                <IconPlus size={11} strokeWidth={2} />
                <span>Preview</span>
            </button>
        </div>

        {layoutMode === 'document' && docReadOnly && <span className="sb-doc-readonly-tag" style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', flexShrink: 0 }}>READ-ONLY</span>}

        {/* Canvas Version History Dropdown & Rollback Button */}
        {activeArtifact && currentArtifactVersionsList.length > 0 && (
            <div className="sb-canvas-header-version-ctrls" ref={canvasVersionMenuRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '6px' }}>
                {currentArtifactVersionsList.length > 1 && (
                    <div className="sb-canvas-ver-stepper-group" style={{ display: 'flex', alignItems: 'center', gap: '2px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '6px', padding: '2px 4px' }}>
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
                        background: isCurrentArtifactLatestVersion ? 'rgba(255, 255, 255, 0.06)' : 'rgba(245, 158, 11, 0.15)',
                        color: isCurrentArtifactLatestVersion ? 'var(--sb-text-secondary)' : '#f59e0b',
                        border: isCurrentArtifactLatestVersion ? '1px solid var(--sb-surface-border)' : '1px solid rgba(245, 158, 11, 0.4)'
                    }}
                >
                    <span>v{activeArtifact.version || currentArtifactVersionIndex + 1} of {currentArtifactVersionsList.length}</span>
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
    const { activeArtifact, layoutMode, documentPaneState, setDocumentPaneState, docReadOnly, setDocReadOnly, activeSandboxData, getCanvasReopenTabTitle, handleSetSandboxViewMode, triggerMarkdownExport, triggerGoogleDriveSave, showToast } = props;
    return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        {/* Mode Switcher: Code | Split | Preview */}
        {(layoutMode === 'code' || activeArtifact?.type === 'live-code-sandbox') && (
            <div
                className="sb-segmented-control sb-segmented-control-xs"
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: '8px',
                    padding: '2px',
                    gap: '2px',
                    marginRight: '4px'
                }}
                title="Live Code Sandbox View Mode"
            >
                <button
                    type="button"
                    className={`sb-btn sb-btn-xs ${(activeSandboxData?.viewMode || 'preview') === 'code' ? 'sb-btn-primary' : 'sb-btn-ghost'}`}
                    onClick={() => handleSetSandboxViewMode('code')}
                    style={{
                        padding: '3px 8px',
                        fontSize: '11px',
                        fontWeight: 600,
                        borderRadius: '6px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px'
                    }}
                    title="Code Editor View"
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
                        borderRadius: '6px',
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
                        borderRadius: '6px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px'
                    }}
                    title="Full Live Interactive Preview"
                >
                    <IconSparkles size={11} strokeWidth={2} />
                    <span>Preview</span>
                </button>
            </div>
        )}

        {layoutMode === 'document' ? (
            /* Edit toggle button */
            <button
                className={`sb-btn sb-btn-xs sb-doc-edit-mode-toggle ${docReadOnly ? 'sb-btn-secondary' : 'sb-btn-primary'}`}
                type="button"
                onClick={() => setDocReadOnly(prev => !prev)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '4px 10px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: 500,
                    transition: 'all 0.15s ease'
                }}
                title={docReadOnly ? "Switch to Edit Mode" : "Switch to Read-Only Mode"}
            >
                <IconEdit size={12} strokeWidth={1.8} />
                <span>{docReadOnly ? 'Edit' : 'Done'}</span>
            </button>
        ) : (
            /* Done button for non-document canvas modes */
            <button
                className="sb-btn sb-btn-primary sb-btn-xs sb-canvas-done-btn"
                type="button"
                onClick={() => {
                    showToast(`${getCanvasReopenTabTitle()} saved and up to date.`);
                }}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '4px 10px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: 500,
                    background: 'var(--sb-system-blue, #2563eb)',
                    color: '#ffffff'
                }}
                title="Done editing canvas"
            >
                <IconSparkles size={12} strokeWidth={1.8} />
                <span>Done</span>
            </button>
        )}

        {/* Download button */}
        <button
            className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-export-btn"
            type="button"
            onClick={triggerMarkdownExport}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '4px 10px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 500
            }}
            title={layoutMode === 'document' ? "Export Markdown (.md)" : "Export Artifact (.md)"}
        >
            <span>Download .md</span>
        </button>

        {/* Save to Drive button */}
        <button
            className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-export-btn"
            type="button"
            onClick={triggerGoogleDriveSave}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '4px 10px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 500
            }}
            title="Save to Google Drive"
        >
            <span>Save Drive</span>
        </button>

        {/* Minimize/Collapse/Expand Buttons */}
        {documentPaneState === 'split' ? (
            <>
                <button
                    className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-collapse-btn"
                    type="button"
                    onClick={() => setDocumentPaneState('collapsed')}
                    style={{ padding: '4px 8px', borderRadius: '6px' }}
                    title="Collapse canvas (View Chat)"
                >
                    <span>Collapse</span>
                </button>
                <button
                    className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-expand-btn"
                    type="button"
                    onClick={() => setDocumentPaneState('expanded')}
                    style={{ padding: '4px 8px', borderRadius: '6px' }}
                    title="Expand canvas (Full Workspace)"
                >
                    <span>Expand</span>
                </button>
            </>
        ) : (
            <button
                className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-split-view-btn"
                type="button"
                onClick={() => setDocumentPaneState('split')}
                style={{ padding: '4px 8px', borderRadius: '6px' }}
                title="Reset to Split View"
            >
                <span>Split View</span>
            </button>
        )}
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

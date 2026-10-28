/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact, LiveCodeSandboxData, PrimitiveType, StageLayoutMode, StudioLayoutMode } from '../canvas-types';
import { ProjectItem } from '../ProjectsModal';
import { ProjectArtifactController } from '../project-artifact-controller';
import { StageDock } from './stage-dock';

/** Everything the right-hand artifact stage (header, tabs, version controls and primitive surfaces) needs from the Studio. */
export interface ArtifactStageProps {
    activeArtifact: CanvasArtifact | undefined;
    setActiveArtifact: (updater: CanvasArtifact | undefined | ((prev: CanvasArtifact | undefined) => CanvasArtifact | undefined)) => void;
    artifactHistory: CanvasArtifact[];
    setArtifactHistory: (updater: CanvasArtifact[] | ((prev: CanvasArtifact[]) => CanvasArtifact[])) => void;
    activeWorkspace: ProjectItem;
    layoutMode: StudioLayoutMode;
    stageLayoutMode: StageLayoutMode;
    setStageLayoutMode: React.Dispatch<React.SetStateAction<StageLayoutMode>>;
    /** A second artifact docked beside the main stage (dragged there from its tab). */
    stageDock: StageDock | undefined;
    setStageDock: React.Dispatch<React.SetStateAction<StageDock | undefined>>;
    documentPaneState: 'split' | 'collapsed' | 'expanded';
    setDocumentPaneState: React.Dispatch<React.SetStateAction<'split' | 'collapsed' | 'expanded'>>;
    docReadOnly: boolean;
    setDocReadOnly: React.Dispatch<React.SetStateAction<boolean>>;
    isGenerating: boolean;
    activeStreamingSectionId: string | undefined;
    activeSandboxData: LiveCodeSandboxData | null;
    canvasArtifactTabs: CanvasArtifact[];
    relatedArtifacts: ReturnType<ProjectArtifactController['related']>;
    currentArtifactVersionsList: CanvasArtifact[];
    currentArtifactVersionIndex: number;
    isCurrentArtifactLatestVersion: boolean;
    getArtifactIcon: (type: PrimitiveType | string) => string;
    getCanvasHeaderLabel: () => string;
    getCanvasReopenTabTitle: () => string;
    handleSelectArtifactTab: (art: CanvasArtifact) => void;
    handleCloseArtifactTab: (e: React.MouseEvent, artId: string) => void;
    handleCreateNewSandboxTab: () => void;
    handlePrevArtifactVersion: () => void;
    handleNextArtifactVersion: () => void;
    handleRollbackArtifactToVersion: (targetVersion: CanvasArtifact) => void;
    handleSelectVersion: (targetVersion: CanvasArtifact) => void;
    handleSelectRelatedArtifact: (artifactId: string) => void;
    handleOpenRelatedInBento: (artifactId: string) => void;
    handleSetSandboxViewMode: (mode: 'code' | 'split' | 'preview') => void;
    handleUpdateArtifact: (updatedArtifact: CanvasArtifact, opts?: { keepStage?: boolean }) => void;
    handleMorphArtifact: (morphedArtifact: CanvasArtifact) => void;
    handleOpenInAppBrowser: (targetUrl: string, targetTitle?: string) => void;
    handleSurfaceAiPrompt: (promptText: string) => void;
    handleSendMessage: (textToSend?: string, targetPrimitiveType?: PrimitiveType) => Promise<void>;
    syncSandboxSaveToMarkdown: (sandboxData: LiveCodeSandboxData) => void;
    triggerMarkdownExport: () => void;
    triggerGoogleDriveSave: () => Promise<void>;
    showToast: (text: string, icon?: string) => void;
}

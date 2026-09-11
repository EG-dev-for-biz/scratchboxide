/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact, LiveCodeSandboxData, PrimitiveType, StageLayoutMode, StudioLayoutMode } from '../canvas-types';
import { ProjectItem } from '../ProjectsModal';
import { ProjectArtifactController } from '../project-artifact-controller';

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
    handleUpdateArtifact: (updatedArtifact: CanvasArtifact) => void;
    handleMorphArtifact: (morphedArtifact: CanvasArtifact) => void;
    handleOpenInAppBrowser: (targetUrl: string, targetTitle?: string) => void;
    handleSurfaceAiPrompt: (promptText: string) => void;
    handleSendMessage: (textToSend?: string, targetPrimitiveType?: PrimitiveType) => Promise<void>;
    syncSandboxSaveToMarkdown: (sandboxData: LiveCodeSandboxData) => void;
    triggerMarkdownExport: () => void;
    triggerGoogleDriveSave: () => Promise<void>;
    showToast: (text: string, icon?: string) => void;
}

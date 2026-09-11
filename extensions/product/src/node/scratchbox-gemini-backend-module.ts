/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { GeminiService } from './gemini-service';
import { GeminiEndpoint } from './gemini-endpoint';
import { WorkspaceConfigService } from './workspace-config-service';
import { WorkspaceEndpoint } from './workspace-endpoint';
import { WorkspaceFileWatcherService } from './workspace-file-watcher-service';
import { ProjectContextGraphService } from './project-context-graph-service';
import { BrowserProxyService } from './browser-proxy-service';
import { BrowserProxyEndpoint } from './browser-proxy-endpoint';
import { UserMemoriesService } from './user-memories-service';
import { ProjectArtifactStore } from './project-artifact-store';
import { GoogleMediaCredentialsService } from './google-media-credentials-service';
import { GoogleMediaGenerationService } from './google-media-generation-service';
import { MediaAssetStore } from './media-asset-store';
import { MediaGenerationJobService } from './media-generation-job-service';
import { CodebasePatternEngine } from './codebase-pattern-engine';
import { LspDiagnosticFeedbackService } from './lsp-diagnostic-feedback-service';
import { ConversationDiffMemoryService } from './conversation-diff-memory-service';
import { VisualVerificationService } from './visual-verification-service';
import { UnifiedProjectCoordinatorService } from './unified-project-coordinator-service';

// Deep-Write & Intelligent Planning Services
import { DeepWriteService } from './deep-write/deep-write-service';
import { GoalAnalyzer } from './deep-write/goal-analyzer';
import { MultiPlatformScaffolder } from './deep-write/multi-platform-scaffolder';
import { DynamicDagPlanner } from './deep-write/dynamic-dag-planner';
import { DeepWriteExecutionBridge } from './deep-write/deep-write-execution-bridge';
import { CodebaseLensSyncService } from './deep-write/codebase-lens-sync-service';
import { PrimitiveSynthesizer } from './deep-write/primitive-synthesizer';
import { UserLearningService } from './deep-write/user-learning-service';

export default new ContainerModule(bind => {
    bind(DeepWriteService).toSelf().inSingletonScope();
    bind(GoalAnalyzer).toSelf().inSingletonScope();
    bind(MultiPlatformScaffolder).toSelf().inSingletonScope();
    bind(DynamicDagPlanner).toSelf().inSingletonScope();
    bind(DeepWriteExecutionBridge).toSelf().inSingletonScope();
    bind(CodebaseLensSyncService).toSelf().inSingletonScope();
    bind(PrimitiveSynthesizer).toSelf().inSingletonScope();
    bind(UserLearningService).toSelf().inSingletonScope();

    bind(CodebasePatternEngine).toSelf().inSingletonScope();
    bind(LspDiagnosticFeedbackService).toSelf().inSingletonScope();
    bind(ConversationDiffMemoryService).toSelf().inSingletonScope();
    bind(VisualVerificationService).toSelf().inSingletonScope();
    bind(UnifiedProjectCoordinatorService).toSelf().inSingletonScope();

    bind(GeminiService).toSelf().inSingletonScope();
    bind(GeminiEndpoint).toSelf().inSingletonScope();
    bind(WorkspaceConfigService).toSelf().inSingletonScope();
    bind(WorkspaceEndpoint).toSelf().inSingletonScope();
    bind(WorkspaceFileWatcherService).toSelf().inSingletonScope();
    bind(ProjectContextGraphService).toSelf().inSingletonScope();
    bind(BrowserProxyService).toSelf().inSingletonScope();
    bind(BrowserProxyEndpoint).toSelf().inSingletonScope();
    bind(UserMemoriesService).toSelf().inSingletonScope();
    bind(ProjectArtifactStore).toSelf().inSingletonScope();
    bind(GoogleMediaCredentialsService).toSelf().inSingletonScope();
    bind(MediaAssetStore).toSelf().inSingletonScope();
    bind(GoogleMediaGenerationService).toSelf().inSingletonScope();
    bind(MediaGenerationJobService).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(GeminiEndpoint);
    bind(BackendApplicationContribution).toService(WorkspaceEndpoint);
    bind(BackendApplicationContribution).toService(BrowserProxyEndpoint);
});

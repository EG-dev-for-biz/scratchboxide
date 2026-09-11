/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// AI Intelligence & Gemini Service
export { GeminiService } from '../../../extensions/product/src/node/gemini-service';

// Project Artifact & Config Persistence
export { ProjectArtifactStore } from '../../../extensions/product/src/node/project-artifact-store';
export { WorkspaceConfigService } from '../../../extensions/product/src/node/workspace-config-service';
export { WorkspaceFileWatcherService } from '../../../extensions/product/src/node/workspace-file-watcher-service';
export { ProjectContextGraphService } from '../../../extensions/product/src/node/project-context-graph-service';

// User Memories & Browser Proxy Services
export { UserMemoriesService } from '../../../extensions/product/src/node/user-memories-service';
export { BrowserProxyService } from '../../../extensions/product/src/node/browser-proxy-service';

// Media Generation Services
export { MediaAssetStore } from '../../../extensions/product/src/node/media-asset-store';
export { GoogleMediaGenerationService } from '../../../extensions/product/src/node/google-media-generation-service';
export { MediaGenerationJobService } from '../../../extensions/product/src/node/media-generation-job-service';
export { GoogleMediaCredentialsService } from '../../../extensions/product/src/node/google-media-credentials-service';

// Autonomous DeepWrite Services
export { DeepWriteService } from '../../../extensions/product/src/node/deep-write/deep-write-service';
export { GoalAnalyzer } from '../../../extensions/product/src/node/deep-write/goal-analyzer';
export { MultiPlatformScaffolder } from '../../../extensions/product/src/node/deep-write/multi-platform-scaffolder';
export { DynamicDagPlanner } from '../../../extensions/product/src/node/deep-write/dynamic-dag-planner';
export { DeepWriteExecutionBridge } from '../../../extensions/product/src/node/deep-write/deep-write-execution-bridge';
export { CodebaseLensSyncService } from '../../../extensions/product/src/node/deep-write/codebase-lens-sync-service';
export { PrimitiveSynthesizer } from '../../../extensions/product/src/node/deep-write/primitive-synthesizer';
export { UserLearningService } from '../../../extensions/product/src/node/deep-write/user-learning-service';

// Autonomous Agent, Sandbox & Subagent Services
export { LongRunningAgentService } from '../../../extensions/product/src/node/long-running-agent-service';
export { SubagentPoolService } from '../../../extensions/product/src/node/subagent-pool-service';
export { ContainerSandboxService } from '../../../extensions/product/src/node/container-sandbox-service';
export { LspDiagnosticFeedbackService } from '../../../extensions/product/src/node/lsp-diagnostic-feedback-service';
export { CodebasePatternEngine } from '../../../extensions/product/src/node/codebase-pattern-engine';
export { AgentContextCompactor } from '../../../extensions/product/src/node/agent-context-compactor';
export { ConversationDiffMemoryService } from '../../../extensions/product/src/node/conversation-diff-memory-service';


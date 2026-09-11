/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// AI Intelligence & Gemini Service
export { GeminiService } from './node/gemini-service';

// Project Artifact & Config Persistence
export { ProjectArtifactStore } from './node/project-artifact-store';
export { WorkspaceConfigService } from './node/workspace-config-service';
export { WorkspaceFileWatcherService } from './node/workspace-file-watcher-service';
export { ProjectContextGraphService } from './node/project-context-graph-service';

// User Memories & Browser Proxy Services
export { UserMemoriesService } from './node/user-memories-service';
export { BrowserProxyService } from './node/browser-proxy-service';

// Media Generation Services
export { MediaAssetStore } from './node/media-asset-store';
export { GoogleMediaGenerationService } from './node/google-media-generation-service';
export { MediaGenerationJobService } from './node/media-generation-job-service';
export { GoogleMediaCredentialsService } from './node/google-media-credentials-service';

// Autonomous DeepWrite Services
export { DeepWriteService } from './node/deep-write/deep-write-service';
export { GoalAnalyzer } from './node/deep-write/goal-analyzer';
export { MultiPlatformScaffolder } from './node/deep-write/multi-platform-scaffolder';
export { DynamicDagPlanner } from './node/deep-write/dynamic-dag-planner';
export { DeepWriteExecutionBridge } from './node/deep-write/deep-write-execution-bridge';
export { CodebaseLensSyncService } from './node/deep-write/codebase-lens-sync-service';
export { PrimitiveSynthesizer } from './node/deep-write/primitive-synthesizer';
export { UserLearningService } from './node/deep-write/user-learning-service';

// Autonomous Agent, Sandbox & Subagent Services
export { LongRunningAgentService } from './node/long-running-agent-service';
export { SubagentPoolService } from './node/subagent-pool-service';
export { ContainerSandboxService } from './node/container-sandbox-service';
export { LspDiagnosticFeedbackService } from './node/lsp-diagnostic-feedback-service';
export { CodebasePatternEngine } from './node/codebase-pattern-engine';
export { AgentContextCompactor } from './node/agent-context-compactor';
export { ConversationDiffMemoryService } from './node/conversation-diff-memory-service';


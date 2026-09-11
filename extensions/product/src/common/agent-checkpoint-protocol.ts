/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { CanvasArtifact } from '../browser/generative-canvas/canvas-types';

export interface ExecutionBudget {
    maxIterations: number;
    maxDurationMs: number;
    maxTokenCount?: number;
    usedIterations: number;
    usedDurationMs: number;
    usedTokenCount?: number;
}

export interface AgentMilestone {
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    acceptanceCriteria: string;
    summaryResult?: string;
    filesTargeted?: string[];
}

export interface AgentStepRecord {
    stepNumber: number;
    description: string;
    status: 'success' | 'failure' | 'running';
    timestamp: number;
    actionType: string;
    filesModified: string[];
    logs?: string;
    errorOutput?: string;
}

export interface AgentCheckpoint {
    checkpointId: string;
    timestamp: number;
    description: string;
    workspaceDiff?: string; // Git diff or snapshot state
    fileSnapshots: Record<string, string>; // path -> content for key files
    serializedState: string; // JSON-string of current state variables
}

export interface AgentSessionState {
    sessionId: string;
    goal: string;
    status: 'initializing' | 'running' | 'paused' | 'completed' | 'failed';
    milestones: AgentMilestone[];
    currentMilestoneIndex: number;
    history: AgentStepRecord[];
    budget: ExecutionBudget;
    checkpoints: AgentCheckpoint[];
    lastCheckpointId?: string;
    artifacts?: CanvasArtifact[];
}

export type AgentStreamEventType =
    | 'agent_init'
    | 'step_start'
    | 'step_complete'
    | 'step_failed'
    | 'milestone_complete'
    | 'checkpoint_saved'
    | 'guardrail_gate'
    | 'budget_exhausted'
    | 'agent_done'
    | 'agent_error'
    | 'agent_thought';

export interface AgentStreamEvent {
    type: AgentStreamEventType;
    sessionId: string;
    timestamp: number;
    message: string;
    data?: any;
}

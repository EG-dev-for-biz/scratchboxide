/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import type { CanvasArtifact, ChatSession, Scene3DData } from '../canvas-types';
import { applySceneProposal, dropProposal, markProposalDecided, revertSceneProposal } from '../services/scene-proposals';
import type { SceneProposal } from '../services/scene-proposals';

type Setter<T> = (value: T | ((prev: T) => T)) => void;

export interface SceneProposalReview {
    /** The agent edit on the scene on stage waiting for a decision, if any. */
    proposal: SceneProposal | undefined;
    /** A held edit is applied onto the live scene (the user's own edits since the request stand) as a new version; an applied one is kept. */
    accept: () => void;
    /** What the edit already put on the scene is taken back (where the user has not changed it since); then it is dropped. */
    reject: () => void;
}

/** Accept / Reject for the agent edit held on the open scene (services/scene-proposals.ts). */
export function useSceneProposalReview(args: {
    activeArtifact: CanvasArtifact | undefined;
    activeSession: ChatSession | undefined;
    currentSessionId: string | undefined;
    setSessions: Setter<ChatSession[]>;
    /** The studio's artifact update: stage, history, version, session and the scene's file on disk. */
    updateArtifact: (artifact: CanvasArtifact) => void;
}): SceneProposalReview {
    const { activeArtifact, activeSession, currentSessionId, setSessions, updateArtifact } = args;
    const proposal = activeArtifact?.type === '3d-scene'
        ? activeSession?.sceneProposals?.find(p => p.artifactId === activeArtifact.id)
        : undefined;

    const drop = React.useCallback((artifactId: string) => {
        if (proposal) markProposalDecided(proposal.id);
        if (!currentSessionId) return;
        setSessions(prev => prev.map(s => (s.id !== currentSessionId ? s : { ...s, sceneProposals: dropProposal(s.sceneProposals, artifactId) })));
    }, [proposal, currentSessionId, setSessions]);

    const accept = React.useCallback(() => {
        if (!proposal || !activeArtifact || activeArtifact.id !== proposal.artifactId) return;
        if (proposal.status === 'pending') {
            const { data, applied } = applySceneProposal(activeArtifact.data as Scene3DData, proposal);
            if (applied.length) updateArtifact({ ...activeArtifact, data, version: (activeArtifact.version ?? 1) + 1 });
        }
        drop(proposal.artifactId);
    }, [proposal, activeArtifact, updateArtifact, drop]);

    const reject = React.useCallback(() => {
        if (!proposal) return;
        if (activeArtifact?.id === proposal.artifactId && proposal.applied?.length) {
            const { data, applied } = revertSceneProposal(activeArtifact.data as Scene3DData, proposal);
            if (applied.length) updateArtifact({ ...activeArtifact, data, version: (activeArtifact.version ?? 1) + 1 });
        }
        drop(proposal.artifactId);
    }, [proposal, activeArtifact, updateArtifact, drop]);

    return { proposal, accept, reject };
}

/**
 * useWorkspaceGraphCoordinator
 *
 * Owns the project artifact graph controller, the codebase lens controller and the
 * unified project coordinator for the active workspace, plus the effects that keep
 * them in sync with the workspace, the active artifact and on-disk file changes.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { CanvasArtifact, ChatSession, getActiveUserName } from '../canvas-types';
import {
    CodebaseLensController,
    CodebaseLensRegistry,
    MarkdownDocumentLens,
    LiveCodeSandboxLens,
    KanbanTaskLens,
    NodeGraphWorkflowLens
} from '../lenses';
import { ProjectArtifactController } from '../project-artifact-controller';
import { DEFAULT_RECENT_PROJECTS, ProjectItem } from '../ProjectsModal';
import { UnifiedProjectCoordinator } from '../unified-project-coordinator';
import { WorkspaceConfigClient } from '../workspace-config-client';

export interface WorkspaceGraphCoordinatorInput {
    activeWorkspace: ProjectItem;
    sessions: ChatSession[];
    activeArtifact: CanvasArtifact | undefined;
}

export interface WorkspaceGraphCoordinator {
    graphControllerRef: React.MutableRefObject<ProjectArtifactController>;
    lensControllerRef: React.MutableRefObject<CodebaseLensController>;
    unifiedCoordinatorRef: React.MutableRefObject<UnifiedProjectCoordinator>;
    /** Bumped whenever the graph mutates so memoized selectors re-run. */
    graphEpoch: number;
    setGraphEpoch: React.Dispatch<React.SetStateAction<number>>;
}

export function useWorkspaceGraphCoordinator({
    activeWorkspace,
    sessions,
    activeArtifact
}: WorkspaceGraphCoordinatorInput): WorkspaceGraphCoordinator {
    const graphControllerRef = React.useRef<ProjectArtifactController>(new ProjectArtifactController(
        DEFAULT_RECENT_PROJECTS[0].id,
        { id: 'active-user', displayName: getActiveUserName(), kind: 'user' }
    ));
    const [graphEpoch, setGraphEpoch] = React.useState(0);

    const lensControllerRef = React.useRef<CodebaseLensController>((() => {
        const reg = new CodebaseLensRegistry();
        reg.register(new MarkdownDocumentLens());
        reg.register(new LiveCodeSandboxLens());
        reg.register(new KanbanTaskLens());
        reg.register(new NodeGraphWorkflowLens());
        return new CodebaseLensController(reg);
    })());

    const unifiedCoordinatorRef = React.useRef<UnifiedProjectCoordinator>(new UnifiedProjectCoordinator({
        projectId: DEFAULT_RECENT_PROJECTS[0].id,
        workspaceRoot: DEFAULT_RECENT_PROJECTS[0].path || `/workspace/${DEFAULT_RECENT_PROJECTS[0].id}`,
        projectController: graphControllerRef.current,
        lensController: lensControllerRef.current
    }));

    React.useEffect(() => {
        const unsubscribe = WorkspaceConfigClient.getInstance().subscribeToFileChanges(
            (event) => {
                if (!event?.path) return;
                const controller = lensControllerRef.current;
                const binding = controller.getBindingByPath(event.path);
                if (binding && activeArtifact && binding.artifactId === activeArtifact.id) {
                    // Fetch updated file from workspace if changed externally
                    console.log(`[CodebaseLens] Reacting to file change for ${event.path}`);
                }
                if (unifiedCoordinatorRef.current) {
                    unifiedCoordinatorRef.current.mutateFromDisk(event.path, (event as any).content || '');
                }
            },
            activeWorkspace.path
        );
        return () => {
            unsubscribe();
        };
    }, [activeWorkspace.path, activeArtifact?.id]);

    // Latest sessions/activeArtifact are read through refs: the controller must only be
    // re-created when the workspace changes, not on every chat update.
    const sessionsRef = React.useRef(sessions);
    sessionsRef.current = sessions;
    const activeArtifactRef = React.useRef(activeArtifact);
    activeArtifactRef.current = activeArtifact;

    React.useEffect(() => {
        let cancelled = false;
        const controller = new ProjectArtifactController(
            activeWorkspace.id,
            { id: 'active-user', displayName: getActiveUserName(), kind: 'user' }
        );
        graphControllerRef.current = controller;
        const coordinator = new UnifiedProjectCoordinator({
            projectId: activeWorkspace.id,
            workspaceRoot: activeWorkspace.path,
            projectController: controller,
            lensController: lensControllerRef.current
        });
        unifiedCoordinatorRef.current = coordinator;

        const projectSessions = sessionsRef.current.filter(session => !session.workspaceId || session.workspaceId === activeWorkspace.id);
        controller.initialize(projectSessions, activeWorkspace.path).then(() => {
            if (cancelled) return;
            const currentArtifact = activeArtifactRef.current;
            if (currentArtifact) {
                controller.registerArtifact(currentArtifact, `studio-initialize-${currentArtifact.id}`);
                coordinator.mutateFromLens(currentArtifact.type, currentArtifact.id, currentArtifact.data);
            }
            setGraphEpoch(epoch => epoch + 1);
        }).catch(error => console.warn('Failed to initialize project artifact graph', error));
        return () => {
            cancelled = true;
        };
    }, [activeWorkspace.id, activeWorkspace.path]);

    React.useEffect(() => {
        if (!activeArtifact || graphControllerRef.current.projectId !== activeWorkspace.id) {
            return;
        }
        graphControllerRef.current.registerArtifact(
            activeArtifact,
            `studio-sync-${activeArtifact.id}-${activeArtifact.version}`
        );
        if (unifiedCoordinatorRef.current) {
            unifiedCoordinatorRef.current.mutateFromLens(
                activeArtifact.type,
                activeArtifact.id,
                activeArtifact.data
            );
        }
        setGraphEpoch(epoch => epoch + 1);
    }, [activeArtifact, activeWorkspace.id]);

    return { graphControllerRef, lensControllerRef, unifiedCoordinatorRef, graphEpoch, setGraphEpoch };
}

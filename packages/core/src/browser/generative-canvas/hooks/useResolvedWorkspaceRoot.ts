/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { ProjectItem } from '../ProjectsModal';
import { WorkspaceConfigClient } from '../workspace-config-client';

/** Placeholder the workspace-config client falls back to when the backend is unreachable. */
const UNRESOLVED_ROOT = '/workspace';

/**
 * Workspaces shipped with an empty `path` are resolved at runtime from the backend
 * (`GET /workspace/config` reports the server's working directory) instead of relying on
 * a hardcoded developer path.
 */
export function useResolvedWorkspaceRoot(
    activeWorkspace: ProjectItem,
    setActiveWorkspace: React.Dispatch<React.SetStateAction<ProjectItem>>,
    setWorkspaces: React.Dispatch<React.SetStateAction<ProjectItem[]>>
): void {
    const workspaceId = activeWorkspace.id;
    const hasPath = Boolean(activeWorkspace.path);

    React.useEffect(() => {
        if (hasPath) {
            return;
        }
        let cancelled = false;
        WorkspaceConfigClient.getInstance().fetchWorkspaceConfig().then(cfg => {
            if (cancelled) {
                return;
            }
            const resolvedRoot = cfg?.workspaceRoot;
            if (!resolvedRoot || resolvedRoot === UNRESOLVED_ROOT) {
                return;
            }
            const withPath = (project: ProjectItem): ProjectItem =>
                project.id === workspaceId && !project.path ? { ...project, path: resolvedRoot } : project;
            setActiveWorkspace(withPath);
            setWorkspaces(prev => prev.map(withPath));
        }).catch(error => console.warn('[useResolvedWorkspaceRoot] Failed to resolve workspace root', error));
        return () => {
            cancelled = true;
        };
    }, [workspaceId, hasPath, setActiveWorkspace, setWorkspaces]);
}

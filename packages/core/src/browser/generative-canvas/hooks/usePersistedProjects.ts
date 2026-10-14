/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import type { ProjectItem } from '../ProjectsModal';
import { WorkspaceConfigClient } from '../workspace-config-client';

/**
 * Keeps a recent-project list in ~/.scratchbox-ide/projects.json: saved projects are added on load,
 * and every change is written back. Entries without a resolved path are never saved.
 */
export function usePersistedProjects(projects: ProjectItem[], setProjects: React.Dispatch<React.SetStateAction<ProjectItem[]>>): void {
    const loaded = React.useRef(false);

    React.useEffect(() => {
        let cancelled = false;
        WorkspaceConfigClient.getInstance().fetchProjects<ProjectItem>().then(saved => {
            if (cancelled) return;
            loaded.current = true;
            if (saved.length === 0) return;
            setProjects(prev => {
                const known = new Set(prev.map(p => p.id));
                const knownPaths = new Set(prev.map(p => p.path).filter(Boolean));
                return [...prev, ...saved.filter(p => !known.has(p.id) && !knownPaths.has(p.path)).map(p => ({ ...p, isActive: false }))];
            });
        });
        return () => { cancelled = true; };
    }, []);

    React.useEffect(() => {
        if (!loaded.current) return;
        const timer = setTimeout(() => {
            void WorkspaceConfigClient.getInstance().saveProjects(projects.filter(p => p.path));
        }, 500);
        return () => clearTimeout(timer);
    }, [projects]);
}

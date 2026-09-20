/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { ProjectItem } from '../ProjectsModal';

export interface UseComposerGitEnvOptions {
    activeWorkspace: ProjectItem;
    showToast: (text: string, icon?: string) => void;
}

export interface UseComposerGitEnvReturn {
    currentBranch: string;
    setCurrentBranch: React.Dispatch<React.SetStateAction<string>>;
    gitBranches: string[];
    setGitBranches: React.Dispatch<React.SetStateAction<string[]>>;
    showGitBranchMenu: boolean;
    setShowGitBranchMenu: React.Dispatch<React.SetStateAction<boolean>>;
    executionEnvironment: string;
    setExecutionEnvironment: React.Dispatch<React.SetStateAction<string>>;
    showEnvironmentMenu: boolean;
    setShowEnvironmentMenu: React.Dispatch<React.SetStateAction<boolean>>;
    handleCheckoutBranch: (branch: string) => Promise<void>;
}

export function useComposerGitEnv({
    activeWorkspace,
    showToast
}: UseComposerGitEnvOptions): UseComposerGitEnvReturn {
    const [currentBranch, setCurrentBranch] = React.useState<string>('main');
    const [gitBranches, setGitBranches] = React.useState<string[]>(['main']);
    const [showGitBranchMenu, setShowGitBranchMenu] = React.useState<boolean>(false);
    const [executionEnvironment, setExecutionEnvironment] = React.useState<string>('This Mac');
    const [showEnvironmentMenu, setShowEnvironmentMenu] = React.useState<boolean>(false);

    // Fetch git branches when active workspace changes
    React.useEffect(() => {
        let isMounted = true;
        const fetchBranches = async () => {
            try {
                const rootParam = activeWorkspace.path ? `?root=${encodeURIComponent(activeWorkspace.path)}` : '';
                const res = await fetch(`/git/branches${rootParam}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.success && isMounted) {
                        if (data.current) setCurrentBranch(data.current);
                        if (Array.isArray(data.branches) && data.branches.length > 0) {
                            setGitBranches(data.branches);
                        }
                    }
                }
            } catch {
                // Ignore network error; fallback to default
            }
        };
        fetchBranches();
        return () => {
            isMounted = false;
        };
    }, [activeWorkspace.path, activeWorkspace.id]);

    const handleCheckoutBranch = React.useCallback(async (branch: string) => {
        try {
            const rootParam = activeWorkspace.path ? `?root=${encodeURIComponent(activeWorkspace.path)}` : '';
            const res = await fetch(`/git/checkout${rootParam}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ branch })
            });
            if (res.ok) {
                setCurrentBranch(branch);
                showToast(`Switched to branch "${branch}"`, 'git');
            } else {
                const err = await res.json();
                showToast(`Checkout failed: ${err.error || 'Unknown error'}`);
            }
        } catch {
            setCurrentBranch(branch);
            showToast(`Switched to branch "${branch}" (offline)`, 'git');
        }
        setShowGitBranchMenu(false);
    }, [activeWorkspace.path, showToast]);

    return {
        currentBranch,
        setCurrentBranch,
        gitBranches,
        setGitBranches,
        showGitBranchMenu,
        setShowGitBranchMenu,
        executionEnvironment,
        setExecutionEnvironment,
        showEnvironmentMenu,
        setShowEnvironmentMenu,
        handleCheckoutBranch
    };
}

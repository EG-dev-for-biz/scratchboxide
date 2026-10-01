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

export interface UseComposerGitEnvOptions {
    activeWorkspace: ProjectItem;
    showToast: (text: string, icon?: string) => void;
}

export interface GitStatusFile {
    path: string;
    status: string;
}

export interface GitStatusSummary {
    branch: string;
    clean: boolean;
    staged: GitStatusFile[];
    unstaged: GitStatusFile[];
    untracked: string[];
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
    gitStatus: GitStatusSummary | null;
    isGitLoading: boolean;
    fetchGitStatus: () => Promise<GitStatusSummary | null>;
    fetchGitDiff: (file?: string, cached?: boolean) => Promise<string>;
    handleStageFile: (file?: string) => Promise<boolean>;
    handleUnstageFile: (file?: string) => Promise<boolean>;
    handleCommit: (message: string) => Promise<boolean>;
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

    const [gitStatus, setGitStatus] = React.useState<GitStatusSummary | null>(null);
    const [isGitLoading, setIsGitLoading] = React.useState<boolean>(false);

    const fetchGitStatus = React.useCallback(async (): Promise<GitStatusSummary | null> => {
        setIsGitLoading(true);
        try {
            const rootParam = activeWorkspace.path ? `?root=${encodeURIComponent(activeWorkspace.path)}` : '';
            const res = await fetch(`/git/status${rootParam}`);
            if (res.ok) {
                const data = await res.json();
                if (data.success) {
                    const summary: GitStatusSummary = {
                        branch: data.branch || 'main',
                        clean: !!data.clean,
                        staged: Array.isArray(data.staged) ? data.staged : [],
                        unstaged: Array.isArray(data.unstaged) ? data.unstaged : [],
                        untracked: Array.isArray(data.untracked) ? data.untracked : []
                    };
                    setGitStatus(summary);
                    if (data.branch) setCurrentBranch(data.branch);
                    return summary;
                }
            }
            return null;
        } catch {
            return null;
        } finally {
            setIsGitLoading(false);
        }
    }, [activeWorkspace.path]);

    const fetchGitDiff = React.useCallback(async (file?: string, cached?: boolean): Promise<string> => {
        try {
            const params = new URLSearchParams();
            if (activeWorkspace.path) params.append('root', activeWorkspace.path);
            if (file) params.append('file', file);
            if (cached) params.append('cached', 'true');
            const res = await fetch(`/git/diff?${params.toString()}`);
            if (res.ok) {
                const data = await res.json();
                return data.rawDiff || '';
            }
            return '';
        } catch {
            return '';
        }
    }, [activeWorkspace.path]);

    const handleStageFile = React.useCallback(async (file?: string): Promise<boolean> => {
        try {
            const rootParam = activeWorkspace.path ? `?root=${encodeURIComponent(activeWorkspace.path)}` : '';
            const res = await fetch(`/git/stage${rootParam}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceRoot: activeWorkspace.path, file })
            });
            if (res.ok) {
                showToast(file ? `Staged ${file}` : 'Staged all changes', 'git');
                await fetchGitStatus();
                return true;
            } else {
                const err = await res.json();
                showToast(`Staging failed: ${err.error || 'Unknown error'}`);
                return false;
            }
        } catch {
            showToast('Staging failed (network error)');
            return false;
        }
    }, [activeWorkspace.path, showToast, fetchGitStatus]);

    const handleUnstageFile = React.useCallback(async (file?: string): Promise<boolean> => {
        try {
            const rootParam = activeWorkspace.path ? `?root=${encodeURIComponent(activeWorkspace.path)}` : '';
            const res = await fetch(`/git/unstage${rootParam}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceRoot: activeWorkspace.path, file })
            });
            if (res.ok) {
                showToast(file ? `Unstaged ${file}` : 'Unstaged all changes', 'git');
                await fetchGitStatus();
                return true;
            } else {
                const err = await res.json();
                showToast(`Unstaging failed: ${err.error || 'Unknown error'}`);
                return false;
            }
        } catch {
            showToast('Unstaging failed (network error)');
            return false;
        }
    }, [activeWorkspace.path, showToast, fetchGitStatus]);

    const handleCommit = React.useCallback(async (message: string): Promise<boolean> => {
        if (!message || !message.trim()) {
            showToast('Commit message cannot be empty');
            return false;
        }
        try {
            const rootParam = activeWorkspace.path ? `?root=${encodeURIComponent(activeWorkspace.path)}` : '';
            const res = await fetch(`/git/commit${rootParam}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceRoot: activeWorkspace.path, message: message.trim() })
            });
            if (res.ok) {
                const data = await res.json();
                const hashShort = data.commitHash ? ` (${data.commitHash.slice(0, 7)})` : '';
                showToast(`Committed${hashShort}: ${message.trim().split('\n')[0]}`, 'git');
                await fetchGitStatus();
                return true;
            } else {
                const err = await res.json();
                showToast(`Commit failed: ${err.error || 'Unknown error'}`);
                return false;
            }
        } catch {
            showToast('Commit failed (network error)');
            return false;
        }
    }, [activeWorkspace.path, showToast, fetchGitStatus]);

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
        handleCheckoutBranch,
        gitStatus,
        isGitLoading,
        fetchGitStatus,
        fetchGitDiff,
        handleStageFile,
        handleUnstageFile,
        handleCommit
    };
}

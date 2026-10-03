/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { GitStatusSummary, GitStatusFile } from './hooks/useComposerGitEnv';
import {
    IconClose,
    IconDiff,
    IconGitFork,
    IconRefresh,
    IconCheck,
    IconFileCode
} from './canvas-icons';

export interface GitReviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    workspacePath: string;
    currentBranch: string;
    gitStatus: GitStatusSummary | null;
    isGitLoading: boolean;
    fetchGitStatus: () => Promise<GitStatusSummary | null>;
    fetchGitDiff: (file?: string, cached?: boolean) => Promise<string>;
    handleStageFile: (file?: string) => Promise<boolean>;
    handleUnstageFile: (file?: string) => Promise<boolean>;
    handleCommit: (message: string) => Promise<boolean>;
}

export const GitReviewModal: React.FC<GitReviewModalProps> = ({
    isOpen,
    onClose,
    workspacePath,
    currentBranch,
    gitStatus,
    isGitLoading,
    fetchGitStatus,
    fetchGitDiff,
    handleStageFile,
    handleUnstageFile,
    handleCommit
}) => {
    const [selectedFile, setSelectedFile] = React.useState<{ path: string; staged: boolean } | null>(null);
    const [diffContent, setDiffContent] = React.useState<string>('');
    const [isLoadingDiff, setIsLoadingDiff] = React.useState<boolean>(false);
    const [commitMessage, setCommitMessage] = React.useState<string>('');
    const [isCommitting, setIsCommitting] = React.useState<boolean>(false);

    // Initial load when modal opens
    React.useEffect(() => {
        if (isOpen) {
            fetchGitStatus();
        }
    }, [isOpen, fetchGitStatus]);

    // Handle Escape key
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Load diff when selected file changes
    React.useEffect(() => {
        if (!isOpen) return;
        let isMounted = true;
        const loadDiff = async () => {
            setIsLoadingDiff(true);
            try {
                const diff = await fetchGitDiff(selectedFile?.path, selectedFile?.staged);
                if (isMounted) {
                    setDiffContent(diff);
                }
            } finally {
                if (isMounted) {
                    setIsLoadingDiff(false);
                }
            }
        };
        loadDiff();
        return () => {
            isMounted = false;
        };
    }, [isOpen, selectedFile, fetchGitDiff]);

    // Auto-select first changed file if nothing is selected
    React.useEffect(() => {
        if (!isOpen || selectedFile || !gitStatus) return;
        if (gitStatus.staged.length > 0) {
            setSelectedFile({ path: gitStatus.staged[0].path, staged: true });
        } else if (gitStatus.unstaged.length > 0) {
            setSelectedFile({ path: gitStatus.unstaged[0].path, staged: false });
        } else if (gitStatus.untracked.length > 0) {
            setSelectedFile({ path: gitStatus.untracked[0], staged: false });
        }
    }, [isOpen, selectedFile, gitStatus]);

    if (!isOpen) return null;

    const stagedCount = gitStatus?.staged.length || 0;
    const unstagedCount = (gitStatus?.unstaged.length || 0) + (gitStatus?.untracked.length || 0);

    const onCommitSubmit = async () => {
        if (!commitMessage.trim() || isCommitting || stagedCount === 0) return;
        setIsCommitting(true);
        try {
            const success = await handleCommit(commitMessage);
            if (success) {
                setCommitMessage('');
                setSelectedFile(null);
                setDiffContent('');
            }
        } finally {
            setIsCommitting(false);
        }
    };

    const handleKeyDownCommit = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onCommitSubmit();
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
            <div className="relative flex flex-col w-full max-w-5xl h-[85vh] max-h-[820px] bg-zinc-950/95 border border-zinc-800/90 rounded-2xl shadow-2xl overflow-hidden font-sans">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/40">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <IconDiff size={18} strokeWidth={2} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h2 className="text-base font-semibold text-zinc-100">Git Review & Staging</h2>
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-800/80 text-zinc-300 border border-zinc-700/60">
                                    <IconGitFork size={11} strokeWidth={2} />
                                    {currentBranch}
                                </span>
                            </div>
                            <p className="text-xs text-zinc-400 mt-0.5 truncate max-w-md">
                                {workspacePath || 'Current Workspace'}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => fetchGitStatus()}
                            disabled={isGitLoading}
                            title="Refresh Git Status"
                            className="sb-btn sb-icon-button p-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors disabled:opacity-50"
                        >
                            <IconRefresh size={16} className={isGitLoading ? 'animate-spin text-emerald-400' : ''} />
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            title="Close (Esc)"
                            className="sb-btn sb-icon-button p-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
                        >
                            <IconClose size={16} />
                        </button>
                    </div>
                </div>

                {/* Main Content Area */}
                <div className="flex flex-1 min-h-0 overflow-hidden">
                    {/* Left Panel: File Lists & Commit Box */}
                    <div className="w-80 flex flex-col border-r border-zinc-800/80 bg-zinc-950/60">
                        <div className="flex-1 overflow-y-auto p-3 space-y-4">
                            {/* Staged Section */}
                            <div>
                                <div className="flex items-center justify-between px-2 pb-1.5 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                                    <div className="flex items-center gap-1.5">
                                        <span>Staged</span>
                                        <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-emerald-500/20 text-emerald-400 font-bold">
                                            {stagedCount}
                                        </span>
                                    </div>
                                    {stagedCount > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => handleUnstageFile()}
                                            className="sb-btn sb-btn-inline text-[11px] text-zinc-400 hover:text-amber-400 lowercase hover:underline"
                                        >
                                            Unstage all
                                        </button>
                                    )}
                                </div>

                                {stagedCount === 0 ? (
                                    <div className="px-2 py-3 text-xs text-zinc-500 italic">
                                        No changes staged for commit.
                                    </div>
                                ) : (
                                    <div className="space-y-0.5">
                                        {gitStatus?.staged.map((f: GitStatusFile) => {
                                            const isSelected = selectedFile?.path === f.path && selectedFile.staged;
                                            return (
                                                <div
                                                    key={`staged-${f.path}`}
                                                    onClick={() => setSelectedFile({ path: f.path, staged: true })}
                                                    className={`group flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition-colors ${
                                                        isSelected
                                                            ? 'bg-emerald-500/15 text-emerald-300 font-medium'
                                                            : 'text-zinc-300 hover:bg-zinc-800/50'
                                                    }`}
                                                >
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <IconFileCode size={13} className="shrink-0 text-zinc-400" />
                                                        <span className="truncate">{f.path}</span>
                                                    </div>
                                                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                                                        <span className="text-[10px] font-mono font-bold text-emerald-400 uppercase">
                                                            {f.status || 'M'}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleUnstageFile(f.path);
                                                            }}
                                                            title="Unstage this file"
                                                            className="sb-btn sb-btn-inline opacity-0 group-hover:opacity-100 px-1 py-0.5 rounded text-[10px] bg-zinc-800 hover:bg-amber-500/20 text-zinc-300 hover:text-amber-300 transition-opacity"
                                                        >
                                                            -
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* Unstaged & Untracked Section */}
                            <div>
                                <div className="flex items-center justify-between px-2 pb-1.5 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                                    <div className="flex items-center gap-1.5">
                                        <span>Changes</span>
                                        <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-zinc-800 text-zinc-300 font-bold">
                                            {unstagedCount}
                                        </span>
                                    </div>
                                    {unstagedCount > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => handleStageFile()}
                                            className="sb-btn sb-btn-inline text-[11px] text-zinc-400 hover:text-emerald-400 lowercase hover:underline"
                                        >
                                            Stage all
                                        </button>
                                    )}
                                </div>

                                {unstagedCount === 0 ? (
                                    <div className="px-2 py-3 text-xs text-zinc-500 italic">
                                        Working tree is clean.
                                    </div>
                                ) : (
                                    <div className="space-y-0.5">
                                        {gitStatus?.unstaged.map((f: GitStatusFile) => {
                                            const isSelected = selectedFile?.path === f.path && !selectedFile.staged;
                                            return (
                                                <div
                                                    key={`unstaged-${f.path}`}
                                                    onClick={() => setSelectedFile({ path: f.path, staged: false })}
                                                    className={`group flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition-colors ${
                                                        isSelected
                                                            ? 'bg-zinc-800/90 text-zinc-100 font-medium'
                                                            : 'text-zinc-300 hover:bg-zinc-800/40'
                                                    }`}
                                                >
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <IconFileCode size={13} className="shrink-0 text-zinc-400" />
                                                        <span className="truncate">{f.path}</span>
                                                    </div>
                                                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                                                        <span className="text-[10px] font-mono font-bold text-amber-400 uppercase">
                                                            {f.status || 'M'}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleStageFile(f.path);
                                                            }}
                                                            title="Stage this file"
                                                            className="sb-btn sb-btn-inline opacity-0 group-hover:opacity-100 px-1 py-0.5 rounded text-[10px] bg-zinc-800 hover:bg-emerald-500/20 text-zinc-300 hover:text-emerald-300 transition-opacity"
                                                        >
                                                            +
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        {gitStatus?.untracked.map((path: string) => {
                                            const isSelected = selectedFile?.path === path && !selectedFile.staged;
                                            return (
                                                <div
                                                    key={`untracked-${path}`}
                                                    onClick={() => setSelectedFile({ path, staged: false })}
                                                    className={`group flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition-colors ${
                                                        isSelected
                                                            ? 'bg-zinc-800/90 text-zinc-100 font-medium'
                                                            : 'text-zinc-400 hover:bg-zinc-800/40'
                                                    }`}
                                                >
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <IconFileCode size={13} className="shrink-0 text-zinc-500" />
                                                        <span className="truncate">{path}</span>
                                                    </div>
                                                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                                                        <span className="text-[10px] font-mono font-bold text-emerald-400">
                                                            U
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleStageFile(path);
                                                            }}
                                                            title="Stage untracked file"
                                                            className="sb-btn sb-btn-inline opacity-0 group-hover:opacity-100 px-1 py-0.5 rounded text-[10px] bg-zinc-800 hover:bg-emerald-500/20 text-zinc-300 hover:text-emerald-300 transition-opacity"
                                                        >
                                                            +
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Commit Box */}
                        <div className="p-3 border-t border-zinc-800/80 bg-zinc-900/30">
                            <textarea
                                value={commitMessage}
                                onChange={(e) => setCommitMessage(e.target.value)}
                                onKeyDown={handleKeyDownCommit}
                                placeholder="Commit message (Cmd+Enter to commit)..."
                                rows={3}
                                className="w-full px-3 py-2 text-xs bg-zinc-900 border border-zinc-700/80 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/80 resize-none transition-colors"
                            />
                            <div className="flex items-center justify-between mt-2">
                                <span className="text-[11px] text-zinc-500">
                                    {stagedCount} file{stagedCount === 1 ? '' : 's'} staged
                                </span>
                                <button
                                    type="button"
                                    onClick={onCommitSubmit}
                                    disabled={!commitMessage.trim() || isCommitting || stagedCount === 0}
                                    className="sb-btn sb-btn-primary px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm inline-flex items-center gap-1.5"
                                >
                                    {isCommitting ? (
                                        <IconRefresh size={12} className="animate-spin" />
                                    ) : (
                                        <IconCheck size={12} strokeWidth={2.5} />
                                    )}
                                    Commit
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Right Panel: Diff Viewer */}
                    <div className="flex-1 flex flex-col bg-zinc-950 overflow-hidden">
                        {selectedFile ? (
                            <>
                                {/* Diff Header */}
                                <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800/80 bg-zinc-900/20 text-xs">
                                    <div className="flex items-center gap-2">
                                        <span className="font-mono text-zinc-200 font-semibold">{selectedFile.path}</span>
                                        <span
                                            className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                                                selectedFile.staged
                                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                                    : 'bg-zinc-800 text-zinc-300 border border-zinc-700/60'
                                            }`}
                                        >
                                            {selectedFile.staged ? 'Staged Diff' : 'Working Tree Diff'}
                                        </span>
                                    </div>
                                    <div>
                                        {selectedFile.staged ? (
                                            <button
                                                type="button"
                                                onClick={() => handleUnstageFile(selectedFile.path)}
                                                className="sb-btn sb-btn-secondary px-2.5 py-1 rounded text-xs bg-zinc-800 hover:bg-amber-500/20 text-zinc-200 hover:text-amber-300 border border-zinc-700/60 transition-colors"
                                            >
                                                Unstage File
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => handleStageFile(selectedFile.path)}
                                                className="sb-btn sb-btn-primary px-2.5 py-1 rounded text-xs bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-200 border border-emerald-500/40 transition-colors"
                                            >
                                                Stage File
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* Diff Body */}
                                <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
                                    {isLoadingDiff ? (
                                        <div className="flex items-center justify-center h-full text-zinc-500 gap-2">
                                            <IconRefresh size={14} className="animate-spin text-emerald-400" />
                                            <span>Loading diff...</span>
                                        </div>
                                    ) : !diffContent.trim() ? (
                                        <div className="flex items-center justify-center h-full text-zinc-500 italic">
                                            No changes in this file or file is untracked/binary.
                                        </div>
                                    ) : (
                                        <div className="space-y-0.5 select-text">
                                            {diffContent.split('\n').map((line, idx) => {
                                                let lineStyle = 'text-zinc-400';
                                                let bgStyle = 'hover:bg-zinc-900/40';

                                                if (line.startsWith('+') && !line.startsWith('+++')) {
                                                    lineStyle = 'text-emerald-300';
                                                    bgStyle = 'bg-emerald-950/30 hover:bg-emerald-950/50';
                                                } else if (line.startsWith('-') && !line.startsWith('---')) {
                                                    lineStyle = 'text-rose-400';
                                                    bgStyle = 'bg-rose-950/30 hover:bg-rose-950/50';
                                                } else if (line.startsWith('@@')) {
                                                    lineStyle = 'text-cyan-400 font-semibold';
                                                    bgStyle = 'bg-cyan-950/20 my-1 py-0.5';
                                                } else if (line.startsWith('diff --git') || line.startsWith('index ')) {
                                                    lineStyle = 'text-zinc-500 font-bold';
                                                }

                                                return (
                                                    <div
                                                        key={`diff-line-${idx}`}
                                                        className={`flex px-2 py-0.5 rounded ${bgStyle} ${lineStyle}`}
                                                    >
                                                        <span className="w-10 shrink-0 text-zinc-600 select-none text-right pr-3 font-mono text-[11px]">
                                                            {idx + 1}
                                                        </span>
                                                        <span className="whitespace-pre font-mono break-all">{line}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-zinc-500 p-8 text-center">
                                <IconDiff size={40} className="text-zinc-700 mb-3" />
                                <p className="text-sm font-medium text-zinc-400">Select a file on the left to review changes</p>
                                <p className="text-xs text-zinc-600 mt-1 max-w-sm">
                                    Stage changes individually or all at once, review unified diffs, and commit your work directly.
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

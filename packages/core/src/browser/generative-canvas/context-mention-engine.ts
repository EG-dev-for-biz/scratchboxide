/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type {
    ContextMentionCategory,
    ContextMentionItem,
    McpServerItem,
    ParsedContextMentions
} from './canvas-types';

export type {
    ContextMentionCategory,
    ContextMentionItem,
    McpServerItem,
    ParsedContextMentions
};

export const CONTEXT_MENTION_TAGS: ContextMentionCategory[] = [
    'file',
    'files',
    'folder',
    'git',
    'terminal',
    'web',
    'docs',
    'mcp',
    'skill'
];

export const CONTEXT_MENTION_METADATA: Record<
    ContextMentionCategory,
    { label: string; icon: string; description: string; placeholder: string }
> = {
    file: {
        label: 'File (@file)',
        icon: '📄',
        description: 'Reference a workspace file (.tsx, .ts, .json, .css)',
        placeholder: 'Search files...'
    },
    files: {
        label: 'Files (@files)',
        icon: '📁',
        description: 'Reference multiple workspace files',
        placeholder: 'Search files...'
    },
    folder: {
        label: 'Folder (@folder)',
        icon: '📂',
        description: 'Reference an entire directory tree',
        placeholder: 'Search directories...'
    },
    git: {
        label: 'Git Status (@git)',
        icon: '🌿',
        description: 'Reference current branch, diffs, or staged commits',
        placeholder: 'Branch, commit, diff...'
    },
    terminal: {
        label: 'Terminal (@terminal)',
        icon: '⚡',
        description: 'Reference active terminal logs, exit codes, and output',
        placeholder: 'Search terminal history...'
    },
    web: {
        label: 'Live Web (@web)',
        icon: '🌐',
        description: 'Query live web sources & verified citations',
        placeholder: 'Web search topic...'
    },
    docs: {
        label: 'Documentation (@docs)',
        icon: '📚',
        description: 'Search Apple HIG, Gemini API & developer documentation',
        placeholder: 'Search documentation...'
    },
    mcp: {
        label: 'MCP Tool (@mcp)',
        icon: '🔌',
        description: 'Attach Model Context Protocol live tool bridge',
        placeholder: 'Search MCP servers...'
    },
    skill: {
        label: 'Skill (/skill)',
        icon: '✨',
        description: 'Attach domain intelligence capability',
        placeholder: 'Search skills...'
    }
};

export interface TriggerMatch {
    type: 'context' | 'skill';
    triggerIndex: number;
    query: string;
    prefix: string;
    suffix: string;
}

/**
 * Finds active trigger (@ or /) in text around the cursor position, supporting multi-word queries.
 */
export function findTriggerMatch(text: string, cursorPosition?: number): TriggerMatch | undefined {
    if (!text || typeof text !== 'string') return undefined;

    const pos = typeof cursorPosition === 'number' ? Math.max(0, Math.min(cursorPosition, text.length)) : text.length;
    const textBefore = text.slice(0, pos);

    // Look backward from cursor to find the last @ or / trigger
    let triggerIndex = -1;
    let triggerChar: '@' | '/' | undefined = undefined;

    for (let i = pos - 1; i >= 0; i--) {
        const char = textBefore[i];
        if (char === '@' || char === '/') {
            if (i === 0 || /\s/.test(textBefore[i - 1])) {
                triggerIndex = i;
                triggerChar = char as '@' | '/';
                break;
            }
        }
    }

    if (triggerIndex === -1 || !triggerChar) {
        return undefined;
    }

    const prefix = text.slice(0, triggerIndex);
    const remainderAfterTrigger = text.slice(triggerIndex + 1);

    let queryLength = pos - (triggerIndex + 1);
    const afterCursor = text.slice(pos);
    const wordContinuation = afterCursor.match(/^[a-zA-Z0-9_\-\./:]*/);
    if (wordContinuation && wordContinuation[0]) {
        queryLength += wordContinuation[0].length;
    }

    const query = remainderAfterTrigger.slice(0, queryLength);
    const suffix = remainderAfterTrigger.slice(queryLength);

    return {
        type: triggerChar === '@' ? 'context' : 'skill',
        triggerIndex,
        query,
        prefix,
        suffix
    };
}

/**
 * Inserts a mention token preserving text before and after the trigger.
 */
export function insertMentionToken(
    originalText: string,
    triggerIndex: number,
    queryLength: number,
    replacementToken: string
): { newText: string; newCursorPosition: number } {
    const prefix = originalText.slice(0, triggerIndex);
    const suffix = originalText.slice(triggerIndex + queryLength);
    const newText = prefix + replacementToken + suffix;
    const newCursorPosition = (prefix + replacementToken).length;
    return {
        newText,
        newCursorPosition
    };
}

/**
 * Cycles keyboard navigation selected index with wrap-around support.
 */
export function cycleSelectedIndex(
    currentIndex: number,
    totalItems: number,
    direction: 'up' | 'down'
): number {
    if (totalItems <= 0) return 0;
    if (direction === 'down') {
        return (currentIndex + 1) % totalItems;
    } else {
        return (currentIndex - 1 + totalItems) % totalItems;
    }
}

/**
 * Parses all `@tag` or `@tag:query` mentions from a user prompt.
 */
export function parseContextMentions(prompt: string): ParsedContextMentions {
    if (!prompt || typeof prompt !== 'string') {
        return { cleanPrompt: '', mentions: [] };
    }

    const mentions: ParsedContextMentions['mentions'] = [];
    const mentionRegex = /@([a-zA-Z0-9_\-]+)(?::([^\s]+))?/g;

    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(prompt)) !== null) {
        const rawTag = match[1].toLowerCase();
        const query = match[2] || undefined;

        let resolvedType: ContextMentionCategory | undefined = undefined;

        if (CONTEXT_MENTION_TAGS.includes(rawTag as ContextMentionCategory)) {
            resolvedType = rawTag as ContextMentionCategory;
        } else if (rawTag === 'code' || rawTag === 'src') {
            resolvedType = 'file';
        } else if (rawTag === 'dir' || rawTag === 'directory') {
            resolvedType = 'folder';
        } else if (rawTag === 'diff' || rawTag === 'branch') {
            resolvedType = 'git';
        } else if (rawTag === 'term' || rawTag === 'console' || rawTag === 'cli') {
            resolvedType = 'terminal';
        } else if (rawTag === 'search' || rawTag === 'internet') {
            resolvedType = 'web';
        } else if (rawTag === 'doc' || rawTag === 'reference') {
            resolvedType = 'docs';
        } else {
            // Check if matches known MCP server prefix
            resolvedType = 'mcp';
        }

        mentions.push({
            tag: match[0],
            query,
            type: resolvedType
        });
    }

    // Generate a clean prompt string with mention tags normalized
    const cleanPrompt = prompt.replace(mentionRegex, '').replace(/\s{2,}/g, ' ').trim();

    return {
        cleanPrompt: cleanPrompt || prompt,
        mentions
    };
}

/**
 * Real-time search query resolution across workspace files, git status, terminal logs, and MCP tools.
 */
export function resolveContextMentionQuery(
    type: ContextMentionCategory,
    query: string = '',
    workspaceFiles: string[] = [],
    gitStatus?: { branch?: string; modified?: string[]; staged?: string[]; untracked?: string[] },
    mcpServers: McpServerItem[] = []
): ContextMentionItem[] {
    const q = (query || '').toLowerCase().trim();
    const results: ContextMentionItem[] = [];

    switch (type) {
        case 'file':
        case 'files': {
            const filtered = workspaceFiles.filter(f => !q || f.toLowerCase().includes(q));
            for (const file of filtered.slice(0, 15)) {
                const fileName = file.split('/').pop() || file;
                const dir = file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : 'root';
                results.push({
                    id: `ctx-file-${file.replace(/[^a-zA-Z0-9]/g, '-')}`,
                    type: 'file',
                    name: fileName,
                    path: file,
                    description: `Workspace file in ${dir}`,
                    detail: file,
                    icon: getFileExtensionIcon(fileName)
                });
            }
            break;
        }

        case 'folder': {
            const folders = new Set<string>();
            workspaceFiles.forEach(f => {
                const parts = f.split('/');
                if (parts.length > 1) {
                    folders.add(parts.slice(0, -1).join('/'));
                    folders.add(parts[0]);
                }
            });
            const folderList = Array.from(folders).filter(f => !q || f.toLowerCase().includes(q));
            for (const folder of folderList.slice(0, 10)) {
                results.push({
                    id: `ctx-folder-${folder.replace(/[^a-zA-Z0-9]/g, '-')}`,
                    type: 'folder',
                    name: `${folder}/`,
                    path: folder,
                    description: 'Workspace Directory',
                    detail: folder,
                    icon: '📂'
                });
            }
            break;
        }

        case 'git': {
            const branch = gitStatus?.branch || 'main';
            if (!q || 'branch'.includes(q) || branch.toLowerCase().includes(q)) {
                results.push({
                    id: 'ctx-git-branch',
                    type: 'git',
                    name: `git: ${branch}`,
                    description: 'Active Git working branch',
                    detail: `Branch: ${branch}`,
                    icon: '🌿',
                    payload: { branch }
                });
            }

            if (gitStatus?.modified && gitStatus.modified.length > 0) {
                const modMatches = gitStatus.modified.filter(m => !q || m.toLowerCase().includes(q));
                if (modMatches.length > 0) {
                    results.push({
                        id: 'ctx-git-modified',
                        type: 'git',
                        name: `git: ${modMatches.length} modified files`,
                        description: modMatches.slice(0, 3).join(', '),
                        detail: modMatches.join('\n'),
                        icon: '📝',
                        payload: { modified: modMatches }
                    });
                }
            }

            if (gitStatus?.staged && gitStatus.staged.length > 0) {
                const stagedMatches = gitStatus.staged.filter(s => !q || s.toLowerCase().includes(q));
                if (stagedMatches.length > 0) {
                    results.push({
                        id: 'ctx-git-staged',
                        type: 'git',
                        name: `git: ${stagedMatches.length} staged files`,
                        description: stagedMatches.slice(0, 3).join(', '),
                        detail: stagedMatches.join('\n'),
                        icon: '📦',
                        payload: { staged: stagedMatches }
                    });
                }
            }

            if (gitStatus?.untracked && gitStatus.untracked.length > 0) {
                const untrackedMatches = gitStatus.untracked.filter(u => !q || u.toLowerCase().includes(q));
                if (untrackedMatches.length > 0) {
                    results.push({
                        id: 'ctx-git-untracked',
                        type: 'git',
                        name: `git: ${untrackedMatches.length} untracked files`,
                        description: untrackedMatches.slice(0, 3).join(', '),
                        detail: untrackedMatches.join('\n'),
                        icon: '❓',
                        payload: { untracked: untrackedMatches }
                    });
                }
            }
            break;
        }

        case 'terminal': {
            results.push(
                {
                    id: 'ctx-terminal-last-output',
                    type: 'terminal',
                    name: 'Last Command Output',
                    description: 'Inject stdout/stderr from most recent terminal run',
                    icon: '⚡'
                },
                {
                    id: 'ctx-terminal-errors',
                    type: 'terminal',
                    name: 'Active Terminal Errors & Stack Traces',
                    description: 'Inject compiler errors and failure diagnostics',
                    icon: '🚨'
                },
                {
                    id: 'ctx-terminal-env',
                    type: 'terminal',
                    name: 'Terminal Environment & Working Directory',
                    description: 'Current working directory, node version, git branch',
                    icon: '🖥️'
                }
            );
            break;
        }

        case 'web': {
            results.push(
                {
                    id: 'ctx-web-live-search',
                    type: 'web',
                    name: q ? `Live Web Search: "${q}"` : 'Live Web Knowledge Query',
                    description: 'Queries live web sources and returns verified citations',
                    detail: q || 'Enter search query',
                    icon: '🌐'
                },
                {
                    id: 'ctx-web-news',
                    type: 'web',
                    name: 'Latest Tech & Release Updates',
                    description: 'Fetches current news and developer release updates',
                    icon: '📰'
                }
            );
            break;
        }

        case 'docs': {
            const docsTopics = [
                { name: 'Apple HIG Design System', desc: 'Liquid Glass, 8-pt grid, SF Pro typography', icon: '🍎' },
                { name: 'Gemini 3.7 Flash & 2.5 API', desc: 'Hybrid reasoning, multimodal context, function calling', icon: '✨' },
                { name: 'Model Context Protocol (MCP) Spec', desc: 'JSON-RPC 2.0 tool endpoints, SSE & STDIO transports', icon: '🔌' },
                { name: 'React 19 & Tailwind CSS v4', desc: 'Action hooks, server components, utility tokens', icon: '⚛️' }
            ];

            for (const doc of docsTopics) {
                if (!q || doc.name.toLowerCase().includes(q) || doc.desc.toLowerCase().includes(q)) {
                    results.push({
                        id: `ctx-doc-${doc.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
                        type: 'docs',
                        name: doc.name,
                        description: doc.desc,
                        icon: doc.icon
                    });
                }
            }
            break;
        }

        case 'mcp': {
            const matches = mcpServers.filter(
                s => !q || s.name.toLowerCase().includes(q) || s.tagline.toLowerCase().includes(q)
            );
            for (const srv of matches) {
                results.push({
                    id: `ctx-mcp-${srv.id}`,
                    type: 'mcp',
                    name: srv.name,
                    description: srv.tagline,
                    detail: `${srv.toolsCount} tools • ${srv.status}`,
                    icon: '🔌',
                    payload: srv
                });
            }
            break;
        }

        default:
            break;
    }

    return results;
}

function getFileExtensionIcon(fileName: string): string {
    if (fileName.endsWith('.tsx') || fileName.endsWith('.jsx')) return '⚛️';
    if (fileName.endsWith('.ts') || fileName.endsWith('.js')) return '📜';
    if (fileName.endsWith('.json')) return '📋';
    if (fileName.endsWith('.css') || fileName.endsWith('.scss')) return '🎨';
    if (fileName.endsWith('.md')) return '📝';
    if (fileName.endsWith('.py')) return '🐍';
    if (fileName.endsWith('.sh') || fileName.endsWith('.bash')) return '⚡';
    return '📄';
}

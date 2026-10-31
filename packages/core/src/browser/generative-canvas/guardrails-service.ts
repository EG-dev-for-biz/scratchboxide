/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    AccentColor,
    CanvasArtifact,
    KanbanBoardData,
    KanbanCard,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    McpExecutionState,
    PrimitiveType,
    StudioLayoutMode
} from './canvas-types';
import { canShowLayoutMode } from '../../common/product-scope';

export type CliCommandGuardrailLevel = 'safe_read' | 'prompt_confirm' | 'blocked_danger';

export interface CliCommandAnalysis {
    command: string;
    level: CliCommandGuardrailLevel;
    requiresConfirmation: boolean;
    isBlocked: boolean;
    description: string;
    dangerWarning?: string;
}

export interface CliExecutionState {
    id: string;
    command: string;
    guardrailLevel: CliCommandGuardrailLevel;
    confirmedByUser: boolean;
    status: 'pending_approval' | 'running' | 'completed' | 'failed';
    timestamp: string;
    description: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
    humanFriendlyCard?: McpExecutionState['humanFriendlyOutput'];
}

// Patterns of dangerous, irreversible commands that must be blocked
const BLOCKED_PATTERNS: RegExp[] = [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|\*|~\/?)/i,
    /\brm\s+-rf\s+(\/|\*)/i,
    /\b(chmod|chown)\s+(-R\s+)?777\s+\//i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+push\s+.*(--force|-f)\b/i,
    /\bdd\s+if=.*of=\/dev\//i,
    /\bmkfs(\.[a-z0-9]+)?\s+\/dev\//i,
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // Fork bomb
    />\s*\/dev\/(sda|hda|nvme|disk)/i
];

// Patterns of safe, read-only inspection commands
const SAFE_READ_PATTERNS: RegExp[] = [
    /^git\s+(status|log|diff|show|branch|tag|remote|rev-parse|describe)\b/i,
    /^(ls|dir|pwd|whoami|date|uptime)\b/i,
    /^(cat|head|tail|grep|rg|find|wc|file|which|where)\b/i,
    /^(node|npm|yarn|pnpm|bun|deno|python|python3|pip|cargo|rustc|go|docker)\s+(--version|-v|--help|-h|version)\b/i,
    /^(npm|yarn|pnpm)\s+(list|ls|why|outdated|audit)\b/i,
    /^echo\s+[^\>\|]*$/i
];

/**
 * Classifies a CLI command according to Scratchbox safety guardrails.
 */
export function classifyCliCommand(command: string): CliCommandAnalysis {
    const trimmed = command.trim();

    // Check for blocked dangerous commands
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {
                command: trimmed,
                level: 'blocked_danger',
                requiresConfirmation: false,
                isBlocked: true,
                description: 'Blocked dangerous command execution',
                dangerWarning: 'This command contains destructive flags that could irreversibly destroy data or system state.'
            };
        }
    }

    // Check for safe read-only commands
    for (const pattern of SAFE_READ_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {
                command: trimmed,
                level: 'safe_read',
                requiresConfirmation: false,
                isBlocked: false,
                description: `Inspect system state: ${trimmed}`
            };
        }
    }

    // Default to prompt_confirm for mutating commands (install, write, commit, create, delete, execute)
    let summary = `Execute command: ${trimmed}`;
    if (trimmed.startsWith('git commit')) {
        summary = 'Commit working tree changes to git repository';
    } else if (trimmed.startsWith('npm install') || trimmed.startsWith('yarn add') || trimmed.startsWith('pnpm add')) {
        summary = 'Install new project dependencies';
    } else if (trimmed.startsWith('mkdir') || trimmed.startsWith('touch')) {
        summary = 'Create files or directories in workspace';
    } else if (trimmed.startsWith('git checkout -b') || trimmed.startsWith('git switch -c')) {
        summary = 'Create and switch to new git branch';
    }

    return {
        command: trimmed,
        level: 'prompt_confirm',
        requiresConfirmation: true,
        isBlocked: false,
        description: summary
    };
}

/**
 * Evaluates whether a CLI execution state can proceed.
 */
export function evaluateCliGuardrail(state: CliExecutionState): { canExecute: boolean; reason?: string } {
    if (state.guardrailLevel === 'blocked_danger') {
        return { canExecute: false, reason: 'Command is blocked by safety guardrails' };
    }
    if (state.guardrailLevel === 'safe_read') {
        return { canExecute: true };
    }
    if (state.guardrailLevel === 'prompt_confirm') {
        if (state.confirmedByUser) {
            return { canExecute: true };
        }
        return { canExecute: false, reason: 'Awaiting user approval badge' };
    }
    return { canExecute: false, reason: 'Unknown guardrail level' };
}

/**
 * Synthesizes raw JSON or object payloads into human-friendly interactive card views.
 */
export function synthesizeHumanFriendlyCard(
    title: string,
    payload: any
): NonNullable<McpExecutionState['humanFriendlyOutput']> {
    if (!payload || typeof payload !== 'object') {
        return {
            cardType: 'json',
            title,
            note: String(payload)
        };
    }

    // If payload is an array of objects -> render as interactive table
    if (Array.isArray(payload)) {
        if (payload.length > 0 && typeof payload[0] === 'object' && payload[0] !== null) {
            const headers = Object.keys(payload[0]);
            const rows = payload.map(item =>
                headers.map(h => {
                    const val = item[h];
                    if (val === null || val === undefined) return '-';
                    if (typeof val === 'object') return JSON.stringify(val);
                    return String(val);
                })
            );
            return {
                cardType: 'table',
                title,
                headers,
                rows,
                note: `${payload.length} items retrieved`
            };
        }
        return {
            cardType: 'badge-list',
            title,
            items: payload.map(item => ({
                label: String(item),
                value: '✓',
                color: 'blue' as AccentColor
            }))
        };
    }

    // If payload is an object with numeric or currency-like metrics -> render as metric card
    const entries = Object.entries(payload);
    const items: Array<{ label: string; value: string; color?: AccentColor }> = [];
    const colors: AccentColor[] = ['indigo', 'emerald', 'blue', 'purple', 'cyan', 'amber', 'rose'];

    let colorIdx = 0;
    for (const [k, v] of entries) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            const formattedLabel = k
                .replace(/_/g, ' ')
                .replace(/([A-Z])/g, ' $1')
                .replace(/^./, str => str.toUpperCase())
                .trim();

            items.push({
                label: formattedLabel,
                value: String(v),
                color: colors[colorIdx % colors.length]
            });
            colorIdx++;
        }
    }

    if (items.length > 0) {
        return {
            cardType: 'metric',
            title,
            items,
            note: 'Live telemetry synchronized'
        };
    }

    return {
        cardType: 'json',
        title,
        note: JSON.stringify(payload, null, 2)
    };
}

/**
 * Resolves the primary surface mode for a given primitive type.
 */
export function resolveModeForArtifact(type: PrimitiveType | string): StudioLayoutMode {
    switch (type) {
        case 'live-code-sandbox':
        case 'code-sandbox':
        case 'sandbox':
            return 'code';
        case 'interactive-browser':
        case 'browser':
            return 'browser';
        case 'node-graph':
        case 'flow-graph':
            return 'automation';
        case '3d-scene':
        case 'scene-3d':
        case '3d':
            return '3d';
        case 'video-timeline':
        case 'video':
        case 'timeline':
        case 'nle':
            return 'video';
        case 'metric-dashboard':
        case 'mind-map':
        case 'skills-hub':
        case 'mcp-hub':
            return 'code';
        case 'markdown-document':
        case 'rendered-document':
        case 'checklist':
        case 'interactive-form':
            return 'document';
        case 'kanban-board':
        case 'kanban':
            return 'kanban';
        default:
            return 'code';
    }
}

/**
 * Sanitizes layout mode to ensure only valid non-legacy modes are used.
 */
export function sanitizeLayoutMode(mode?: string, artifact?: CanvasArtifact): StudioLayoutMode {
    let resolved: StudioLayoutMode = 'chat';
    if (mode === 'chat' || mode === 'code' || mode === 'canvas' || mode === 'document' || mode === 'kanban' || mode === 'automation' || mode === '3d' || mode === 'browser' || mode === 'video') {
        resolved = mode === 'canvas' ? 'code' : (mode as StudioLayoutMode);
    } else if (artifact) {
        resolved = resolveModeForArtifact(artifact.type);
    }
    // A mode the 3D/VFX build does not offer (common/product-scope.ts) restores as chat; the saved canvas is kept.
    return canShowLayoutMode(resolved) ? resolved : 'chat';
}

/**
 * Computes difference metadata between two artifact versions.
 */
export function computeArtifactDiff(v1: CanvasArtifact, v2: CanvasArtifact): {
    hasChanges: boolean;
    addedCount: number;
    modifiedCount: number;
    unchangedCount: number;
    details?: any;
} {
    if (v1.type !== v2.type) {
        return {
            hasChanges: true,
            addedCount: 1,
            modifiedCount: 0,
            unchangedCount: 0
        };
    }

    if (v1.type === 'markdown-document') {
        const doc1 = v1.data as MarkdownDocumentData;
        const doc2 = v2.data as MarkdownDocumentData;

        const sec1Map = new Map((doc1.sections || []).map(s => [s.id, s]));
        let addedCount = 0;
        let modifiedCount = 0;
        let unchangedCount = 0;

        for (const s2 of doc2.sections || []) {
            const s1 = sec1Map.get(s2.id);
            if (!s1) {
                addedCount++;
            } else if (JSON.stringify(s1) !== JSON.stringify(s2)) {
                modifiedCount++;
            } else {
                unchangedCount++;
            }
        }

        const hasChanges = addedCount > 0 || modifiedCount > 0 || (doc1.sections?.length !== doc2.sections?.length);
        return {
            hasChanges,
            addedCount,
            modifiedCount,
            unchangedCount
        };
    }

    if (v1.type === 'live-code-sandbox') {
        const sb1 = v1.data as LiveCodeSandboxData;
        const sb2 = v2.data as LiveCodeSandboxData;
        const file1Map = new Map((sb1.files || []).map(f => [f.id || f.name, f]));
        let addedCount = 0;
        let modifiedCount = 0;
        let unchangedCount = 0;

        for (const f2 of sb2.files || []) {
            const f1 = file1Map.get(f2.id || f2.name);
            if (!f1) {
                addedCount++;
            } else if (f1.content !== f2.content || f1.language !== f2.language) {
                modifiedCount++;
            } else {
                unchangedCount++;
            }
        }
        const hasChanges = addedCount > 0 || modifiedCount > 0 || ((sb1.files || []).length !== (sb2.files || []).length);
        return {
            hasChanges,
            addedCount,
            modifiedCount,
            unchangedCount
        };
    }

    const hasChanges = JSON.stringify(v1.data) !== JSON.stringify(v2.data);
    return {
        hasChanges,
        addedCount: hasChanges ? 1 : 0,
        modifiedCount: 0,
        unchangedCount: hasChanges ? 0 : 1
    };
}

/**
 * Moves a Kanban card to a target column preserving order and metadata.
 */
export function transitionKanbanCard(
    board: KanbanBoardData,
    cardId: string,
    targetColId: string
): KanbanBoardData {
    let cardToMove: KanbanCard | undefined;

    // Remove card from its existing column
    const nextColumns = board.columns.map(col => {
        const found = col.cards.find(c => c.id === cardId);
        if (found) {
            cardToMove = found;
            return {
                ...col,
                cards: col.cards.filter(c => c.id !== cardId)
            };
        }
        return col;
    });

    if (!cardToMove) {
        return board;
    }

    // Add card to target column
    const finalColumns = nextColumns.map(col => {
        if (col.id === targetColId) {
            return {
                ...col,
                cards: [...col.cards, cardToMove!]
            };
        }
        return col;
    });

    return {
        ...board,
        columns: finalColumns
    };
}

/**
 * Calculates overall progress percentage and card counts for a Kanban board.
 */
export function calculateKanbanProgress(board: KanbanBoardData): {
    totalCards: number;
    doneCards: number;
    inProgressCards: number;
    backlogCards: number;
    percentage: number;
} {
    let totalCards = 0;
    let doneCards = 0;
    let inProgressCards = 0;
    let backlogCards = 0;

    for (const col of board.columns) {
        const count = col.cards.length;
        totalCards += count;

        const lowerTitle = col.title.toLowerCase();
        if (lowerTitle.includes('done') || lowerTitle.includes('complete') || lowerTitle.includes('released')) {
            doneCards += count;
        } else if (lowerTitle.includes('progress') || lowerTitle.includes('doing') || lowerTitle.includes('review')) {
            inProgressCards += count;
        } else {
            backlogCards += count;
        }
    }

    const percentage = totalCards > 0 ? Math.round((doneCards / totalCards) * 100) : 0;

    return {
        totalCards,
        doneCards,
        inProgressCards,
        backlogCards,
        percentage
    };
}

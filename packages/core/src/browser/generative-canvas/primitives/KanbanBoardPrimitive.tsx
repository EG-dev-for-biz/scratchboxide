/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import {
    CanvasArtifact,
    KanbanBoardData,
    KanbanCard,
    KanbanColumn,
    LiveCodeSandboxData,
    PrimitiveType,
    AccentColor,
    getActiveUserName
} from '../canvas-types';
import { morphKanbanCardToSandbox } from '../primitive-transformer-engine';
import { IconDocument } from '../canvas-icons';
import { ViewAsMenu } from './shared/ViewAsMenu';

export interface KanbanBoardPrimitiveProps {
    data: KanbanBoardData;
    /** The full artifact wrapping `data`, when one exists — needed for the "View As" whole-board morph. */
    activeArtifact?: CanvasArtifact;
    onUpdate?: (updatedData: KanbanBoardData) => void;
    onMorphCardToSandbox?: (sandboxData: LiveCodeSandboxData) => void;
    /** Per-card "1-click morph this card" (e.g. Code & Test) — builds its own artifact, takes just that artifact. */
    onMorphArtifact?: (artifact: CanvasArtifact) => void;
    /** "View As" — morphs the WHOLE board artifact into a different primitive type. Distinct from `onMorphArtifact` above. */
    onMorphWholeBoard?: (artifact: CanvasArtifact, targetType: PrimitiveType) => void;
    onPromptAction?: (promptText: string) => void;
    /** True while the AI agent is generating a reply — used to sequence Run Task / Run Phase execution. */
    isAgentGenerating?: boolean;
}

const ACCENT_CYCLE: AccentColor[] = ['blue', 'indigo', 'purple', 'emerald', 'amber', 'rose', 'cyan'];

export const KanbanBoardPrimitive: React.FC<KanbanBoardPrimitiveProps> = ({
    data,
    activeArtifact,
    onUpdate,
    onMorphCardToSandbox,
    onMorphArtifact,
    onMorphWholeBoard,
    onPromptAction,
    isAgentGenerating
}) => {
    const sanitizeBoard = (raw: KanbanBoardData): KanbanBoardData => {
        const rawCols = raw?.columns || (raw as any)?.kanbanColumns || [];
        return {
            title: raw?.title || (raw as any)?.boardTitle || 'Product Kanban Board',
            subtitle: raw?.subtitle || (raw as any)?.boardSubtitle,
            columns: (Array.isArray(rawCols) ? rawCols : []).map((col, idx) => ({
                id: col.id || `col-${idx}`,
                title: col.title || 'Column',
                color: col.color || 'blue',
                cards: Array.isArray(col.cards) ? col.cards : (Array.isArray((col as any).tasks) ? (col as any).tasks : [])
            })),
            drafts: Array.isArray(raw?.drafts) ? raw.drafts : []
        };
    };

    const [board, setBoard] = React.useState<KanbanBoardData>(() => sanitizeBoard(data));
    const [addingCardColId, setAddingCardColId] = React.useState<string | undefined>(undefined);
    const [newCardTitle, setNewCardTitle] = React.useState<string>('');
    const [isAddingColumn, setIsAddingColumn] = React.useState<boolean>(false);
    const [newColumnTitle, setNewColumnTitle] = React.useState<string>('');
    const [dragOverColId, setDragOverColId] = React.useState<string | undefined>(undefined);
    const [draggingCardInfo, setDraggingCardInfo] = React.useState<{ cardId: string; sourceColId: string } | undefined>(undefined);

    const [expandedDraftId, setExpandedDraftId] = React.useState<string | undefined>(undefined);
    const [promotingDraftId, setPromotingDraftId] = React.useState<string | undefined>(undefined);
    const [newDraftPrompt, setNewDraftPrompt] = React.useState<string>('');

    // Replit-style task runner state
    const [runningCardId, setRunningCardId] = React.useState<string | undefined>(undefined);
    // Queue of { cardId, colId } waiting to run after the current card finishes
    const runQueueRef = React.useRef<Array<{ cardId: string; colId: string }>>([]);
    const boardRef = React.useRef<KanbanBoardData>(board);
    boardRef.current = board;

    // When agent finishes generating, advance the completed card and start the next queued task
    const prevGenerating = React.useRef<boolean | undefined>(undefined);
    React.useEffect(() => {
        const wasGenerating = prevGenerating.current;
        prevGenerating.current = isAgentGenerating;
        if (wasGenerating === true && isAgentGenerating === false && runningCardId) {
            // Move completed card one column to the right
            const currentBoard = boardRef.current;
            const cols = currentBoard.columns || [];
            const fromColIdx = cols.findIndex(col => col.cards.some(c => c.id === runningCardId));
            if (fromColIdx !== -1 && fromColIdx < cols.length - 1) {
                const fromCol = cols[fromColIdx];
                const card = fromCol.cards.find(c => c.id === runningCardId);
                if (card) {
                    const newCols = cols.map((col, idx) => {
                        if (idx === fromColIdx) return { ...col, cards: col.cards.filter(c => c.id !== runningCardId) };
                        if (idx === fromColIdx + 1) return { ...col, cards: [...col.cards, card] };
                        return col;
                    });
                    const newBoard: KanbanBoardData = { ...currentBoard, columns: newCols };
                    setBoard(newBoard);
                    onUpdate?.(newBoard);
                }
            }
            setRunningCardId(undefined);
            // Fire next item in queue
            const next = runQueueRef.current.shift();
            if (next) {
                const nextBoard = boardRef.current;
                const nextCols = nextBoard.columns || [];
                const nextCol = nextCols.find(c => c.id === next.colId);
                const nextCard = nextCol?.cards.find(c => c.id === next.cardId);
                if (nextCard && onPromptAction) {
                    setRunningCardId(next.cardId);
                    onPromptAction(buildRunPrompt(nextCard));
                }
            }
        }
    }, [isAgentGenerating, runningCardId]);

    const buildRunPrompt = (card: KanbanCard): string => {
        const steps = card.planSteps?.length ? `\n\nPlan steps:\n${card.planSteps.map(s => `- ${s}`).join('\n')}` : '';
        const desc = card.description ? `\n\n${card.description}` : '';
        return `Implement this task: **${card.title}**${desc}${steps}\n\nWork through it step by step, write any code needed, and show the result.`;
    };

    const handleRunCard = (card: KanbanCard) => {
        if (!onPromptAction || isAgentGenerating || runningCardId) return;
        setRunningCardId(card.id);
        onPromptAction(buildRunPrompt(card));
    };

    const handleRunPhase = (colId: string) => {
        if (!onPromptAction) return;
        const cols = boardRef.current.columns || [];
        const col = cols.find(c => c.id === colId);
        if (!col || col.cards.length === 0) return;
        const cards = [...col.cards];
        // First card runs immediately; the rest are queued
        const [first, ...rest] = cards;
        runQueueRef.current = rest.map(c => ({ cardId: c.id, colId }));
        if (!isAgentGenerating && !runningCardId) {
            setRunningCardId(first.id);
            onPromptAction(buildRunPrompt(first));
        } else {
            // Agent is busy — queue everything including first
            runQueueRef.current = cards.map(c => ({ cardId: c.id, colId }));
        }
    };

    const handlePromoteDraft = (cardId: string) => {
        const drafts = board.drafts || [];
        const draftToPromote = drafts.find(c => c.id === cardId);
        if (!draftToPromote) return;

        setPromotingDraftId(cardId);

        setTimeout(() => {
            const cols = board.columns || [];
            if (cols.length === 0) {
                setPromotingDraftId(undefined);
                return;
            }

            const newDrafts = drafts.filter(c => c.id !== cardId);
            const firstCol = cols[0];
            const updatedFirstCol = {
                ...firstCol,
                cards: [...(firstCol.cards || []), draftToPromote]
            };
            const newColumns = cols.map((col, idx) => idx === 0 ? updatedFirstCol : col);

            const newBoard: KanbanBoardData = {
                ...board,
                columns: newColumns,
                drafts: newDrafts
            };

            setBoard(newBoard);
            setPromotingDraftId(undefined);

            if (onUpdate) {
                onUpdate(newBoard);
            }
            if (onPromptAction) {
                onPromptAction(`Promoted AI suggested task "${draftToPromote.title}" to ${firstCol.title}.`);
            }
        }, 400);
    };

    const handleGenerateDraft = (promptText: string) => {
        const text = promptText.trim();
        if (!text) return;

        const lowerText = text.toLowerCase();
        let tag = 'Task';
        let tagColor: AccentColor = 'blue';
        let priority: 'low' | 'medium' | 'high' | 'urgent' = 'medium';
        let planSteps: string[] = [];
        let description = '';

        if (lowerText.includes('payment') || lowerText.includes('stripe') || lowerText.includes('checkout') || lowerText.includes('billing')) {
            tag = 'Payments';
            tagColor = 'indigo';
            priority = 'high';
            planSteps = [
                'Initialize Stripe SDK with secure secret keys',
                'Create custom endpoint /api/stripe/checkout-session',
                'Construct webhook signature verifier and test webhooks locally',
                'Verify successful MRR updates in database cohort logs'
            ];
            description = 'Integrate Stripe billing checkout and webhook sync workflows';
        } else if (lowerText.includes('dark') || lowerText.includes('ui') || lowerText.includes('ux') || lowerText.includes('color') || lowerText.includes('toggle') || lowerText.includes('style') || lowerText.includes('design')) {
            tag = 'UI/UX';
            tagColor = 'purple';
            priority = 'medium';
            planSteps = [
                'Map out semantic design tokens for light/dark modes',
                'Implement responsive theme toggle context provider',
                'Apply smooth transition effects and audit WCAG AA contrast ratios',
                'Take desktop and mobile viewport screenshots to verify layout alignment'
            ];
            description = 'Enhance interface style themes with accessibility checks';
        } else if (lowerText.includes('database') || lowerText.includes('db') || lowerText.includes('postgres') || lowerText.includes('firestore') || lowerText.includes('query')) {
            tag = 'Database';
            tagColor = 'emerald';
            priority = 'high';
            planSteps = [
                'Create normalized DB schema migration for location variables',
                'Write optimized query indexes for sub-millisecond retrieval',
                'Mock test database pipelines under maximum simulated payload',
                'Verify schema layout matches design specifications'
            ];
            description = 'Optimize database schema structures and indexes';
        } else {
            tag = 'Engineering';
            tagColor = 'blue';
            priority = 'medium';
            planSteps = [
                'Deconstruct user query into actionable engineering specs',
                'Author unit and integration tests with robust assertions',
                'Implement core logic strictly satisfying written tests',
                'Verify compilation and green test suite runs locally'
            ];
            description = `Implement requirements for: ${text}`;
        }

        const newCard: KanbanCard = {
            id: `draft-${Date.now()}`,
            title: text,
            description,
            tag,
            tagColor,
            priority,
            planSteps,
            promptProvenance: promptText,
            totalSubtasks: planSteps.length,
            completedSubtasks: 0
        };

        const newDrafts = [...(board.drafts || []), newCard];
        const newBoard: KanbanBoardData = {
            ...board,
            drafts: newDrafts
        };

        setBoard(newBoard);
        setNewDraftPrompt('');

        if (onUpdate) {
            onUpdate(newBoard);
        }
        if (onPromptAction) {
            onPromptAction(`Generated new suggestion draft: "${newCard.title}".`);
        }
    };

    const handleDeleteDraft = (cardId: string) => {
        const drafts = board.drafts || [];
        const newDrafts = drafts.filter(c => c.id !== cardId);
        const newBoard = { ...board, drafts: newDrafts };
        setBoard(newBoard);
        if (onUpdate) {
            onUpdate(newBoard);
        }
    };

    React.useEffect(() => {
        setBoard(sanitizeBoard(data));
    }, [data]);

    const handleMoveCard = (cardId: string, fromColId: string, direction: 'left' | 'right') => {
        const cols = board.columns || [];
        const fromColIdx = cols.findIndex(c => c.id === fromColId);
        if (fromColIdx === -1) { return; }

        const targetColIdx = direction === 'left' ? fromColIdx - 1 : fromColIdx + 1;
        if (targetColIdx < 0 || targetColIdx >= cols.length) { return; }

        const fromCol = cols[fromColIdx];
        const card = fromCol.cards?.find(c => c.id === cardId);
        if (!card) { return; }

        const newColumns = cols.map((col, idx) => {
            const currentCards = col.cards || [];
            if (idx === fromColIdx) {
                return { ...col, cards: currentCards.filter(c => c.id !== cardId) };
            }
            if (idx === targetColIdx) {
                return { ...col, cards: [...currentCards, card] };
            }
            return col;
        });

        const newBoard: KanbanBoardData = { ...board, columns: newColumns };
        setBoard(newBoard);
        if (onUpdate) {
            onUpdate(newBoard);
        }
    };

    const handleDropCard = (targetColId: string) => {
        if (!draggingCardInfo) return;
        const { cardId, sourceColId } = draggingCardInfo;
        setDraggingCardInfo(undefined);
        setDragOverColId(undefined);

        if (sourceColId === targetColId) return;

        const cols = board.columns || [];
        const sourceCol = cols.find(c => c.id === sourceColId);
        const card = sourceCol?.cards?.find(c => c.id === cardId);
        if (!card) return;

        const newColumns = cols.map(col => {
            const currentCards = col.cards || [];
            if (col.id === sourceColId) {
                return { ...col, cards: currentCards.filter(c => c.id !== cardId) };
            }
            if (col.id === targetColId) {
                return { ...col, cards: [...currentCards, card] };
            }
            return col;
        });

        const newBoard: KanbanBoardData = { ...board, columns: newColumns };
        setBoard(newBoard);
        if (onUpdate) {
            onUpdate(newBoard);
        }
    };

    const handleDeleteCard = (cardId: string, colId: string) => {
        const cols = board.columns || [];
        const newColumns = cols.map(col => {
            const currentCards = col.cards || [];
            if (col.id === colId) {
                return { ...col, cards: currentCards.filter(c => c.id !== cardId) };
            }
            return col;
        });
        const newBoard = { ...board, columns: newColumns };
        setBoard(newBoard);
        if (onUpdate) {
            onUpdate(newBoard);
        }
    };

    const handleAddCardSubmit = (colId: string) => {
        if (!newCardTitle.trim()) { return; }
        const newCard: KanbanCard = {
            id: `card-${Date.now()}`,
            title: newCardTitle.trim(),
            priority: 'medium',
            tag: 'Task',
            tagColor: 'blue'
        };

        const cols = board.columns || [];
        const newColumns = cols.map(col => {
            const currentCards = col.cards || [];
            if (col.id === colId) {
                return { ...col, cards: [...currentCards, newCard] };
            }
            return col;
        });

        const newBoard = { ...board, columns: newColumns };
        setBoard(newBoard);
        setNewCardTitle('');
        setAddingCardColId(undefined);
        if (onUpdate) {
            onUpdate(newBoard);
        }
    };

    const handleAddColumnSubmit = () => {
        if (!newColumnTitle.trim()) return;
        const nextColor = ACCENT_CYCLE[(board.columns?.length || 0) % ACCENT_CYCLE.length];
        const newCol: KanbanColumn = {
            id: `col-${Date.now()}`,
            title: newColumnTitle.trim(),
            color: nextColor,
            cards: []
        };
        const newBoard: KanbanBoardData = {
            ...board,
            columns: [...(board.columns || []), newCol]
        };
        setBoard(newBoard);
        setNewColumnTitle('');
        setIsAddingColumn(false);
        if (onUpdate) {
            onUpdate(newBoard);
        }
    };

    const getPriorityBadgeClass = (priority?: string) => {
        switch (priority) {
            case 'urgent':
                return 'sb-priority-urgent';
            case 'high':
                return 'sb-priority-high';
            case 'medium':
                return 'sb-priority-medium';
            default:
                return 'sb-priority-low';
        }
    };

    const handleAddNewTask = () => {
        const cols = board.columns || [];
        if (cols.length === 0) return;
        const taskNum = (cols[0].cards?.length || 0) + 1;
        const newCard: KanbanCard = {
            id: `card-task-${Date.now()}`,
            title: `Milestone Deliverable ${taskNum}`,
            description: 'Define requirements, implement verified solution, and certify acceptance criteria',
            tag: 'Sprint',
            tagColor: 'blue',
            priority: 'high',
            assignee: getActiveUserName(),
            completedSubtasks: 0,
            totalSubtasks: 2,
            planSteps: [
                'Review technical requirements and input schemas',
                'Implement core logic with automated verification tests'
            ]
        };
        const newCols = cols.map((col, idx) => idx === 0 ? { ...col, cards: [newCard, ...(col.cards || [])] } : col);
        const newBoard: KanbanBoardData = { ...board, columns: newCols };
        setBoard(newBoard);
        if (onUpdate) onUpdate(newBoard);
        if (onPromptAction) onPromptAction('Added new milestone deliverable to Backlog.');
    };

    const handleAddQaColumn = () => {
        const cols = board.columns || [];
        const newCol: KanbanColumn = {
            id: `col-qa-${Date.now()}`,
            title: 'QA & Review',
            color: 'amber',
            cards: [
                {
                    id: `card-qa-${Date.now()}`,
                    title: 'Multi-Device Responsive Verification',
                    description: 'Verify Mobile 375px and Tablet 768px viewports',
                    tag: 'QA',
                    tagColor: 'amber',
                    priority: 'high',
                    completedSubtasks: 3,
                    totalSubtasks: 3
                }
            ]
        };
        const insertIdx = Math.max(0, cols.length - 1);
        const newCols = [...cols];
        newCols.splice(insertIdx, 0, newCol);
        const newBoard: KanbanBoardData = { ...board, columns: newCols };
        setBoard(newBoard);
        if (onUpdate) onUpdate(newBoard);
        if (onPromptAction) onPromptAction('Added QA & Review stage column.');
    };

    const handlePrioritizeCoreTasks = () => {
        const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
        const newCols = (board.columns || []).map(col => {
            const sortedCards = [...(col.cards || [])].sort((a, b) => {
                const pA = priorityOrder[a.priority || 'low'] ?? 4;
                const pB = priorityOrder[b.priority || 'low'] ?? 4;
                return pA - pB;
            });
            return { ...col, cards: sortedCards };
        });
        const newBoard: KanbanBoardData = { ...board, columns: newCols };
        setBoard(newBoard);
        if (onUpdate) onUpdate(newBoard);
        if (onPromptAction) onPromptAction('Prioritized urgent and high-priority tasks.');
    };

    const totalCardsCount = (board.columns || []).reduce((acc, col) => acc + (col.cards?.length || 0), 0);
    const lastColCardsCount = board.columns && board.columns.length > 0 ? (board.columns[board.columns.length - 1]?.cards?.length || 0) : 0;
    const progressPercent = totalCardsCount > 0 ? Math.round((lastColCardsCount / totalCardsCount) * 100) : 0;

    const handleExportMarkdown = () => {
        let md = `# ${board.title}\n`;
        if (board.subtitle) md += `_${board.subtitle}_\n\n`;
        md += `> Sprint Progress: ${progressPercent}%\n\n`;

        (board.columns || []).forEach(col => {
            md += `## ${col.title} (${(col.cards || []).length})\n\n`;
            if (!col.cards || col.cards.length === 0) {
                md += `_No tasks in this column._\n\n`;
                return;
            }
            col.cards.forEach((card, idx) => {
                const priorityTag = card.priority ? ` [${card.priority.toUpperCase()}]` : '';
                const tagStr = card.tag ? ` #${card.tag}` : '';
                md += `### ${idx + 1}. ${card.title}${priorityTag}${tagStr}\n`;
                if (card.description) {
                    md += `${card.description}\n`;
                }
                if (card.planSteps && card.planSteps.length > 0) {
                    md += `\n**Plan Steps:**\n`;
                    card.planSteps.forEach(step => {
                        md += `- [ ] ${step}\n`;
                    });
                }
                md += `\n`;
            });
        });

        if (board.drafts && board.drafts.length > 0) {
            md += `## Suggestions / Backlog (${board.drafts.length})\n\n`;
            board.drafts.forEach(draft => {
                md += `- [ ] **${draft.title}**${draft.description ? `: ${draft.description}` : ''}\n`;
            });
            md += `\n`;
        }

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `${board.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="sb-primitive-kanban">
            {/* Top Kanban Action Bar & Progress Metric */}
            <div className="sb-kanban-top-actions">
                <div className="sb-kanban-top-action-group">
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs sb-kanban-action-chip"
                        onClick={handleAddNewTask}
                        title="Add new milestone deliverable"
                    >
                        <span>+ Add Milestone Task</span>
                    </button>
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs sb-kanban-action-chip"
                        onClick={handleAddQaColumn}
                        title="Add QA Review column"
                    >
                        <span>+ Add QA Review Column</span>
                    </button>
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs sb-kanban-action-chip"
                        onClick={handlePrioritizeCoreTasks}
                        title="Sort tasks by priority"
                    >
                        <span>⚡ Prioritize Core Tasks</span>
                    </button>
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs sb-kanban-action-chip"
                        onClick={handleExportMarkdown}
                        title="Export Kanban board as Markdown (.md)"
                    >
                        <IconDocument size={12} />
                        <span>Export Markdown</span>
                    </button>
                    {onMorphWholeBoard && activeArtifact && (
                        <ViewAsMenu
                            currentType="kanban-board"
                            onSelect={targetType => onMorphWholeBoard(activeArtifact, targetType)}
                            triggerClassName="sb-btn sb-btn-secondary sb-btn-xs sb-kanban-action-chip"
                        />
                    )}
                </div>

                <div className="sb-kanban-progress-wrapper">
                    <span className="sb-kanban-progress-label">Sprint Progress:</span>
                    <div className="sb-kanban-progress-track">
                        <div className="sb-kanban-progress-bar" style={{ width: `${progressPercent}%` }} />
                    </div>
                    <span className="sb-kanban-progress-percent">{progressPercent}%</span>
                </div>
            </div>

            <div className="sb-kanban-columns">
                {/* Replit-style Drafts/Suggestions Column */}
                <div className="sb-kanban-column sb-kanban-column-drafts">
                    <div className="sb-kanban-col-header">
                        <div className="sb-kanban-col-title-group">
                            <span className="sb-kanban-col-dot sb-col-dot-drafts" />
                            <h4 className="sb-kanban-col-title sb-col-title-drafts">Suggestions</h4>
                        </div>
                        <span className="sb-kanban-col-count sb-col-count-drafts">
                            {(board.drafts || []).length}
                        </span>
                    </div>

                    <div className="sb-kanban-cards-list">
                        {(board.drafts || []).length === 0 ? (
                            <div className="sb-kanban-draft-empty-box">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="sb-kanban-draft-empty-icon">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 21l3.71-3.71h2.29h2.29H21V3H3v12.904h6.813z" />
                                </svg>
                                <span>No drafts yet. Ask the AI in the main chat bar below to plan new tasks!</span>
                            </div>
                        ) : (
                            (board.drafts || []).map(card => {
                                const isExpanded = expandedDraftId === card.id;
                                const isPromoting = promotingDraftId === card.id;
                                return (
                                    <div
                                        key={card.id}
                                        className={`sb-kanban-card sb-kanban-card-draft ${isPromoting ? 'sb-card-promoting-spring' : ''}`}
                                    >
                                        <div className="sb-kanban-card-top">
                                            {card.tag && (
                                                <span className={`sb-card-tag sb-tag-${card.tagColor || 'indigo'}`}>
                                                    {card.tag}
                                                </span>
                                            )}
                                            {card.priority && (
                                                <span className={`sb-card-priority ${getPriorityBadgeClass(card.priority)}`}>
                                                    {card.priority}
                                                </span>
                                            )}
                                            <button
                                                className="sb-card-delete-btn"
                                                title="Dismiss suggestion"
                                                onClick={() => handleDeleteDraft(card.id)}
                                            >
                                                ×
                                            </button>
                                        </div>

                                        <h5 className="sb-kanban-card-title">{card.title}</h5>
                                        {card.description && (
                                            <p className="sb-kanban-card-desc">{card.description}</p>
                                        )}

                                        {/* Plan steps section */}
                                        {isExpanded && card.planSteps && card.planSteps.length > 0 && (
                                            <div className="sb-kanban-draft-plan">
                                                <div className="sb-kanban-draft-plan-heading">
                                                    Suggested Plan
                                                </div>
                                                <ul className="sb-kanban-draft-plan-list">
                                                    {card.planSteps.map((step, sIdx) => (
                                                        <li key={sIdx} className="sb-kanban-draft-plan-item">
                                                            <span className="sb-kanban-draft-plan-bullet">•</span>
                                                            <span>{step}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                                {card.promptProvenance && (
                                                    <div className="sb-kanban-draft-origin">
                                                        Origin: "{card.promptProvenance}"
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Suggestion actions */}
                                        <div className="sb-kanban-card-actions sb-kanban-draft-actions">
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-primary sb-btn-xs sb-kanban-draft-promote-btn"
                                                onClick={() => handlePromoteDraft(card.id)}
                                            >
                                                Start / Apply
                                            </button>
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-secondary sb-btn-xs sb-kanban-draft-plan-toggle-btn"
                                                onClick={() => setExpandedDraftId(isExpanded ? undefined : card.id)}
                                            >
                                                {isExpanded ? 'Hide Plan' : 'View Plan'}
                                            </button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>

                    {/* Bottom Mini Info Label */}
                    <div className="sb-kanban-drafts-input-container">
                        <div className="sb-kanban-drafts-hint-wrap">
                            <span className="sb-kanban-drafts-hint-text">
                                ✨ Generate task suggestions directly by asking the AI in the main chat bar below.
                            </span>
                        </div>
                    </div>
                </div>

                {board.columns.map((column: KanbanColumn, colIndex: number) => {
                    const isFirstCol = colIndex === 0;
                    const isLastCol = colIndex === board.columns.length - 1;
                    const accentColor: AccentColor = column.color || 'blue';
                    const isTargetCol = dragOverColId === column.id;

                    return (
                        <div
                            key={column.id}
                            className={`sb-kanban-column sb-col-accent-${accentColor} ${isTargetCol ? 'sb-col-drag-over' : ''}`}
                            onDragOver={(e) => {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = 'move';
                                if (dragOverColId !== column.id) setDragOverColId(column.id);
                            }}
                            onDragLeave={() => {
                                if (dragOverColId === column.id) setDragOverColId(undefined);
                            }}
                            onDrop={(e) => {
                                e.preventDefault();
                                handleDropCard(column.id);
                            }}
                        >
                            <div className="sb-kanban-col-header">
                                <div className="sb-kanban-col-title-group">
                                    <span className="sb-kanban-col-dot" />
                                    <h4 className="sb-kanban-col-title">{column.title}</h4>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    {onPromptAction && column.cards.length > 0 && (
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-primary sb-btn-xs"
                                            style={{ fontSize: '10px', padding: '2px 6px', opacity: (isAgentGenerating || runningCardId) ? 0.5 : 1 }}
                                            title={`Run all ${column.cards.length} task${column.cards.length !== 1 ? 's' : ''} in this phase sequentially`}
                                            onClick={() => handleRunPhase(column.id)}
                                            disabled={!!(isAgentGenerating || runningCardId)}
                                        >
                                            ▶ Run Phase
                                        </button>
                                    )}
                                    <span className="sb-kanban-col-count">{column.cards.length}</span>
                                </div>
                            </div>

                            <div className="sb-kanban-cards-list">
                                {column.cards.map(card => (
                                    <div
                                        key={card.id}
                                        className={`sb-kanban-card${runningCardId === card.id ? ' sb-card-promoting-spring' : ''}`}
                                        style={runningCardId === card.id ? { outline: '2px solid var(--sb-accent-blue, #3b82f6)', outlineOffset: '2px' } : undefined}
                                        draggable={true}
                                        onDragStart={(e) => {
                                            e.dataTransfer.setData('text/plain', JSON.stringify({ cardId: card.id, sourceColId: column.id }));
                                            setDraggingCardInfo({ cardId: card.id, sourceColId: column.id });
                                        }}
                                        onDragEnd={() => {
                                            setDraggingCardInfo(undefined);
                                            setDragOverColId(undefined);
                                        }}
                                    >
                                        <div className="sb-kanban-card-top">
                                            {card.tag && (
                                                <span className={`sb-card-tag sb-tag-${card.tagColor || 'blue'}`}>
                                                    {card.tag}
                                                </span>
                                            )}
                                            {card.priority && (
                                                <span className={`sb-card-priority ${getPriorityBadgeClass(card.priority)}`}>
                                                    {card.priority}
                                                </span>
                                            )}
                                            {runningCardId === card.id && (
                                                <span style={{ fontSize: '10px', color: 'var(--sb-accent-blue, #3b82f6)', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                    <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor', animation: 'pulse 1.2s ease-in-out infinite' }} />
                                                    Running…
                                                </span>
                                            )}
                                            <button
                                                className="sb-card-delete-btn"
                                                title="Delete card"
                                                onClick={() => handleDeleteCard(card.id, column.id)}
                                            >
                                                ×
                                            </button>
                                        </div>

                                        <h5 className="sb-kanban-card-title">{card.title}</h5>
                                        {card.description && (
                                            <p className="sb-kanban-card-desc">{card.description}</p>
                                        )}

                                        <div className="sb-kanban-card-meta">
                                            {card.assignee && (
                                                <div className="sb-card-assignee" title={card.assignee}>
                                                    <span className="sb-avatar-initials">
                                                        {card.assignee.substring(0, 2).toUpperCase()}
                                                    </span>
                                                    <span className="sb-assignee-name">{card.assignee}</span>
                                                </div>
                                            )}
                                            {card.dueDate && (
                                                <span className="sb-card-due-date">
                                                    {card.dueDate}
                                                </span>
                                            )}
                                            {card.totalSubtasks !== undefined && card.totalSubtasks > 0 && (
                                                <div className="sb-card-subtasks-pill" title={`${card.completedSubtasks || 0} of ${card.totalSubtasks} subtasks completed`}>
                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                        <polyline points="20 6 9 17 4 12" />
                                                    </svg>
                                                    <span>{card.completedSubtasks || 0}/{card.totalSubtasks}</span>
                                                </div>
                                            )}
                                        </div>

                                        {/* Card movement & Morph controls */}
                                        <div className="sb-kanban-card-actions">
                                            {onPromptAction && (
                                                <button
                                                    type="button"
                                                    className="sb-btn sb-btn-primary sb-btn-xs"
                                                    style={{ opacity: (isAgentGenerating || runningCardId) && runningCardId !== card.id ? 0.45 : 1 }}
                                                    title="Run this task — sends it to the AI agent and advances the card when done"
                                                    disabled={!!(isAgentGenerating && runningCardId !== card.id) || (!!runningCardId && runningCardId !== card.id)}
                                                    onClick={() => handleRunCard(card)}
                                                >
                                                    {runningCardId === card.id ? '⏳ Running…' : '▶ Run Task'}
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-secondary sb-btn-xs sb-card-morph-btn"
                                                title="1-Click: Morph Card into Live Code Sandbox with Unit Tests"
                                                onClick={() => {
                                                    const sandboxData = morphKanbanCardToSandbox(card, board.title);
                                                    onMorphCardToSandbox?.(sandboxData);
                                                    onMorphArtifact?.({
                                                        id: `art-sandbox-${Date.now()}`,
                                                        title: sandboxData.title,
                                                        summary: sandboxData.subtitle || 'Morphed Sandbox Code',
                                                        type: 'live-code-sandbox',
                                                        data: sandboxData,
                                                        createdAt: new Date().toLocaleTimeString(),
                                                        version: 1
                                                    });
                                                    onPromptAction?.(`Morphed card "${card.title}" into Live Code Sandbox with tests.`);
                                                }}
                                            >
                                                <span>⚡ Code & Test</span>
                                            </button>

                                            <div className="sb-card-move-group">
                                                <button
                                                    className="sb-move-btn"
                                                    disabled={isFirstCol}
                                                    title="Move left"
                                                    onClick={() => handleMoveCard(card.id, column.id, 'left')}
                                                >
                                                    ←
                                                </button>
                                                <button
                                                    className="sb-move-btn"
                                                    disabled={isLastCol}
                                                    title="Move right"
                                                    onClick={() => handleMoveCard(card.id, column.id, 'right')}
                                                >
                                                    →
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}

                                {/* Add Card Quick Interface */}
                                {addingCardColId === column.id ? (
                                    <div className="sb-kanban-add-form">
                                        <input
                                            type="text"
                                            className="sb-input sb-input-sm"
                                            placeholder="Card title..."
                                            value={newCardTitle}
                                            autoFocus
                                            onChange={e => setNewCardTitle(e.target.value)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') { handleAddCardSubmit(column.id); }
                                                if (e.key === 'Escape') {
                                                    setAddingCardColId(undefined);
                                                    setNewCardTitle('');
                                                }
                                            }}
                                        />
                                        <div className="sb-add-form-actions">
                                            <button
                                                className="sb-btn sb-btn-primary sb-btn-xs"
                                                onClick={() => handleAddCardSubmit(column.id)}
                                            >
                                                Add
                                            </button>
                                            <button
                                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                                onClick={() => {
                                                    setAddingCardColId(undefined);
                                                    setNewCardTitle('');
                                                }}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <button
                                        className="sb-kanban-add-card-btn"
                                        onClick={() => {
                                            setAddingCardColId(column.id);
                                            setNewCardTitle('');
                                        }}
                                    >
                                        + Add Task
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}

                {/* Add Column Section */}
                <div className="sb-kanban-add-col-container">
                    {isAddingColumn ? (
                        <div className="sb-kanban-add-col-form">
                            <input
                                type="text"
                                className="sb-input sb-input-sm"
                                placeholder="Column title..."
                                value={newColumnTitle}
                                autoFocus
                                onChange={e => setNewColumnTitle(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') handleAddColumnSubmit();
                                    if (e.key === 'Escape') {
                                        setIsAddingColumn(false);
                                        setNewColumnTitle('');
                                    }
                                }}
                            />
                            <div className="sb-kanban-add-col-form-actions">
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-primary sb-btn-xs"
                                    onClick={handleAddColumnSubmit}
                                >
                                    Add Column
                                </button>
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-xs"
                                    onClick={() => {
                                        setIsAddingColumn(false);
                                        setNewColumnTitle('');
                                    }}
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-kanban-add-col-btn"
                            onClick={() => setIsAddingColumn(true)}
                        >
                            <span>+ Add Column</span>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    CodebaseLens,
    LensContext,
    LensProjectionResult,
    LensUnprojectionResult,
    computeMultiFileHash
} from '../../../common/codebase-lens-protocol';
import {
    AccentColor,
    KanbanBoardData,
    KanbanCard,
    KanbanColumn,
    PrimitiveType
} from '../canvas-types';
import { slugify } from '../services/text-utils';

export class KanbanTaskLens implements CodebaseLens<KanbanBoardData> {
    readonly primitiveType: PrimitiveType = 'kanban-board';

    canHandle(filePathOrFiles: string | Record<string, string>): boolean {
        if (typeof filePathOrFiles === 'string') {
            const lower = filePathOrFiles.toLowerCase();
            return (
                lower.includes('roadmap') ||
                lower.includes('task') ||
                lower.includes('kanban') ||
                lower.includes('todo') ||
                lower.endsWith('.kanban-board.json')
            );
        }
        return Object.keys(filePathOrFiles).some(p => this.canHandle(p));
    }

    project(
        sourceContent: Record<string, string> | string,
        context?: LensContext
    ): LensProjectionResult<KanbanBoardData> {
        const rawText = typeof sourceContent === 'string'
            ? sourceContent
            : Object.values(sourceContent)[0] || '';

        // If it's a JSON file
        if (rawText.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(rawText) as KanbanBoardData;
                return {
                    data: parsed,
                    contentHash: computeMultiFileHash(rawText)
                };
            } catch (e) {
                // Fallback to text parsing
            }
        }

        const lines = rawText.split('\n');
        let title = 'Project Task Board';
        let subtitle: string | undefined;

        const columns: KanbanColumn[] = [];
        let currentColumn: KanbanColumn | undefined;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed) continue;

            // # Document Title
            if (trimmed.startsWith('# ') && title === 'Project Task Board') {
                title = trimmed.slice(2).trim();
                if (lines[i + 1] && !lines[i + 1].trim().startsWith('#')) {
                    subtitle = lines[i + 1].trim();
                    i++;
                }
                continue;
            }

            // ## Column Heading (## To Do, ## In Progress, ## Done)
            const columnMatch = trimmed.match(/^##\s+(.+)$/);
            if (columnMatch) {
                const colTitle = columnMatch[1].trim();
                const colId = slugify(colTitle);
                let color: AccentColor = 'blue';
                const lower = colTitle.toLowerCase();
                if (lower.includes('progress') || lower.includes('doing') || lower.includes('active')) {
                    color = 'amber';
                } else if (lower.includes('done') || lower.includes('complete') || lower.includes('finished')) {
                    color = 'emerald';
                } else if (lower.includes('backlog') || lower.includes('review')) {
                    color = 'indigo';
                }

                currentColumn = {
                    id: colId,
                    title: colTitle,
                    color,
                    cards: []
                };
                columns.push(currentColumn);
                continue;
            }

            // - [ ] or - [x] Checkbox Card
            const cardMatch = trimmed.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
            if (cardMatch) {
                if (!currentColumn) {
                    currentColumn = {
                        id: 'to-do',
                        title: 'To Do',
                        color: 'blue',
                        cards: []
                    };
                    columns.push(currentColumn);
                }

                const isChecked = cardMatch[1].toLowerCase() === 'x';
                let rawTaskText = cardMatch[2].trim();

                // Extract custom id if present: <!-- id:card-101 -->
                let cardId = '';
                const idCommentMatch = rawTaskText.match(/<!--\s*id:([a-zA-Z0-9_-]+)\s*-->/);
                if (idCommentMatch) {
                    cardId = idCommentMatch[1];
                    rawTaskText = rawTaskText.replace(idCommentMatch[0], '').trim();
                }

                // Extract priority tag: [urgent], [high], [medium], [low]
                let priority: 'low' | 'medium' | 'high' | 'urgent' = isChecked ? 'low' : 'medium';
                const priorityMatch = rawTaskText.match(/^\[(urgent|high|medium|low)\]\s*(.+)$/i);
                if (priorityMatch) {
                    priority = priorityMatch[1].toLowerCase() as any;
                    rawTaskText = priorityMatch[2].trim();
                }

                if (!cardId) {
                    cardId = slugify(rawTaskText).slice(0, 32);
                }

                const card: KanbanCard = {
                    id: cardId,
                    title: rawTaskText,
                    priority,
                    completedSubtasks: isChecked ? 1 : 0,
                    totalSubtasks: 1
                };

                currentColumn.cards.push(card);
            }
        }

        // Fallback default columns if none detected
        if (columns.length === 0) {
            columns.push(
                { id: 'to-do', title: 'To Do', color: 'blue', cards: [] },
                { id: 'in-progress', title: 'In Progress', color: 'amber', cards: [] },
                { id: 'done', title: 'Done', color: 'emerald', cards: [] }
            );
        }

        const data: KanbanBoardData = {
            title,
            subtitle,
            columns
        };

        return {
            data,
            contentHash: computeMultiFileHash(rawText)
        };
    }

    unproject(
        primitiveData: KanbanBoardData,
        currentDiskContent: Record<string, string> | string,
        context?: LensContext
    ): LensUnprojectionResult {
        const primaryFileName = typeof currentDiskContent === 'object' && Object.keys(currentDiskContent).length > 0
            ? Object.keys(currentDiskContent)[0]
            : 'ROADMAP.md';

        const lines: string[] = [];

        // Title & Subtitle
        if (primitiveData.title) {
            lines.push(`# ${primitiveData.title}`);
        }
        if (primitiveData.subtitle) {
            lines.push(primitiveData.subtitle);
            lines.push('');
        }

        // Columns
        for (const col of primitiveData.columns || []) {
            lines.push(`## ${col.title}`);
            const isDoneCol = col.id.toLowerCase().includes('done') || col.title.toLowerCase().includes('done');

            for (const card of col.cards || []) {
                const isChecked = isDoneCol || (card.completedSubtasks && card.completedSubtasks === card.totalSubtasks);
                const checkMark = isChecked ? 'x' : ' ';
                const priorityTag = card.priority ? `[${card.priority}] ` : '';
                const idAnnotation = card.id ? ` <!-- id:${card.id} -->` : '';

                lines.push(`- [${checkMark}] ${priorityTag}${card.title}${idAnnotation}`);
            }
            lines.push('');
        }

        const generatedText = lines.join('\n').trim() + '\n';
        const files: Record<string, string> = {
            [primaryFileName]: generatedText
        };

        return {
            files,
            contentHash: computeMultiFileHash(files),
            modifiedFilePaths: [primaryFileName],
            changeSummary: `Unprojected ${primitiveData.columns?.length || 0} Kanban columns into ${primaryFileName}`
        };
    }
}

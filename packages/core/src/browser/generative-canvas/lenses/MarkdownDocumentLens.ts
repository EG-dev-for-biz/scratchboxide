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
    MarkdownDocumentData,
    MarkdownSection,
    PrimitiveType
} from '../canvas-types';

export class MarkdownDocumentLens implements CodebaseLens<MarkdownDocumentData> {
    readonly primitiveType: PrimitiveType = 'markdown-document';

    canHandle(filePathOrFiles: string | Record<string, string>): boolean {
        if (typeof filePathOrFiles === 'string') {
            const lower = filePathOrFiles.toLowerCase();
            return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdown');
        }
        return Object.keys(filePathOrFiles).some(path => this.canHandle(path));
    }

    project(
        sourceContent: Record<string, string> | string,
        context?: LensContext
    ): LensProjectionResult<MarkdownDocumentData> {
        const rawText = typeof sourceContent === 'string'
            ? sourceContent
            : Object.values(sourceContent)[0] || '';

        const lines = rawText.split('\n');
        let title = 'Document Specification';
        let subtitle: string | undefined;
        const sections: MarkdownSection[] = [];

        let lineIdx = 0;

        // Parse Frontmatter if present
        if (lines[0]?.trim() === '---') {
            lineIdx = 1;
            while (lineIdx < lines.length && lines[lineIdx].trim() !== '---') {
                const fLine = lines[lineIdx];
                const match = fLine.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
                if (match) {
                    const key = match[1].toLowerCase();
                    const val = match[2].trim().replace(/^['"]|['"]$/g, '');
                    if (key === 'title') title = val;
                    if (key === 'subtitle' || key === 'description') subtitle = val;
                }
                lineIdx++;
            }
            if (lineIdx < lines.length && lines[lineIdx].trim() === '---') {
                lineIdx++;
            }
        }

        while (lineIdx < lines.length) {
            const line = lines[lineIdx];
            const trimmed = line.trim();

            if (!trimmed) {
                lineIdx++;
                continue;
            }

            // 1. Title / Headings (#, ##, ###)
            const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (headingMatch) {
                const level = headingMatch[1].length as 1 | 2 | 3;
                const headingText = headingMatch[2].trim();

                if (level === 1 && (!title || title === 'Document Specification')) {
                    title = headingText;
                    // Check next line for potential subtitle
                    if (lineIdx + 1 < lines.length && !lines[lineIdx + 1].trim().startsWith('#') && !lines[lineIdx + 1].trim().startsWith('>')) {
                        const candidateSub = lines[lineIdx + 1].trim();
                        if (candidateSub && !candidateSub.startsWith('|') && !candidateSub.startsWith('-')) {
                            subtitle = candidateSub;
                            lineIdx++;
                        }
                    }
                } else {
                    sections.push({
                        id: `sec-heading-${sections.length + 1}`,
                        type: 'heading',
                        level: level <= 3 ? level : 3,
                        content: headingText
                    });
                }
                lineIdx++;
                continue;
            }

            // 2. GitHub-style Callouts (> [!NOTE], > [!WARNING], > [!TIP], > [!INFO])
            const calloutHeaderMatch = trimmed.match(/^>\s*\[!(NOTE|TIP|WARNING|INFO|CAUTION|IMPORTANT)\]\s*(.*)$/i);
            if (calloutHeaderMatch) {
                const rawType = calloutHeaderMatch[1].toLowerCase();
                let calloutType: 'info' | 'tip' | 'warning' | 'success' = 'info';
                if (rawType === 'warning' || rawType === 'caution') calloutType = 'warning';
                else if (rawType === 'tip' || rawType === 'important') calloutType = 'tip';

                const calloutLines: string[] = [];
                if (calloutHeaderMatch[2].trim()) {
                    calloutLines.push(calloutHeaderMatch[2].trim());
                }

                lineIdx++;
                while (lineIdx < lines.length && lines[lineIdx].trim().startsWith('>')) {
                    calloutLines.push(lines[lineIdx].replace(/^>\s?/, ''));
                    lineIdx++;
                }

                sections.push({
                    id: `sec-callout-${sections.length + 1}`,
                    type: 'callout',
                    calloutType,
                    calloutTitle: calloutHeaderMatch[1].toUpperCase(),
                    content: calloutLines.join('\n')
                });
                continue;
            }

            // 3. Tables (| A | B |)
            if (trimmed.startsWith('|') && trimmed.endsWith('|') && lines[lineIdx + 1]?.trim().startsWith('|') && lines[lineIdx + 1]?.includes('---')) {
                const headers = trimmed
                    .slice(1, -1)
                    .split('|')
                    .map(h => h.trim());
                lineIdx += 2; // Skip header and divider

                const rows: string[][] = [];
                while (lineIdx < lines.length && lines[lineIdx].trim().startsWith('|') && lines[lineIdx].trim().endsWith('|')) {
                    const rowCells = lines[lineIdx]
                        .trim()
                        .slice(1, -1)
                        .split('|')
                        .map(c => c.trim());
                    rows.push(rowCells);
                    lineIdx++;
                }

                sections.push({
                    id: `sec-table-${sections.length + 1}`,
                    type: 'table',
                    tableHeaders: headers,
                    tableRows: rows
                });
                continue;
            }

            // 4. Checklist / Task List (- [ ] or - [x])
            if (/^[-*]\s*\[([ xX])\]\s*(.+)$/.test(trimmed)) {
                const checklistItems: { id: string; text: string; done: boolean }[] = [];
                while (lineIdx < lines.length) {
                    const chkLine = lines[lineIdx].trim();
                    const chkMatch = chkLine.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
                    if (chkMatch) {
                        checklistItems.push({
                            id: `chk-${checklistItems.length + 1}`,
                            done: chkMatch[1].toLowerCase() === 'x',
                            text: chkMatch[2].trim()
                        });
                        lineIdx++;
                    } else if (!chkLine) {
                        lineIdx++;
                    } else {
                        break;
                    }
                }

                sections.push({
                    id: `sec-checklist-${sections.length + 1}`,
                    type: 'checklist',
                    checklistItems
                });
                continue;
            }

            // 5. Code Block (```lang)
            if (trimmed.startsWith('```')) {
                const lang = trimmed.slice(3).trim();
                const codeLines: string[] = [];
                lineIdx++;
                while (lineIdx < lines.length && !lines[lineIdx].trim().startsWith('```')) {
                    codeLines.push(lines[lineIdx]);
                    lineIdx++;
                }
                if (lineIdx < lines.length && lines[lineIdx].trim().startsWith('```')) {
                    lineIdx++;
                }

                sections.push({
                    id: `sec-code-${sections.length + 1}`,
                    type: 'code',
                    codeLanguage: lang,
                    content: codeLines.join('\n')
                });
                continue;
            }

            // 6. Generic Paragraph
            const paragraphLines: string[] = [line];
            lineIdx++;
            while (lineIdx < lines.length) {
                const nextLine = lines[lineIdx];
                const nextTrim = nextLine.trim();
                if (!nextTrim || nextTrim.startsWith('#') || nextTrim.startsWith('>') || nextTrim.startsWith('|') || nextTrim.startsWith('```') || /^[-*]\s*\[([ xX])\]/.test(nextTrim)) {
                    break;
                }
                paragraphLines.push(nextLine);
                lineIdx++;
            }

            sections.push({
                id: `sec-para-${sections.length + 1}`,
                type: 'paragraph',
                content: paragraphLines.join('\n')
            });
        }

        const data: MarkdownDocumentData = {
            title,
            subtitle,
            sections
        };

        return {
            data,
            contentHash: computeMultiFileHash(rawText)
        };
    }

    unproject(
        primitiveData: MarkdownDocumentData,
        currentDiskContent: Record<string, string> | string,
        context?: LensContext
    ): LensUnprojectionResult {
        const lines: string[] = [];

        // 1. Header & Subtitle
        if (primitiveData.title) {
            lines.push(`# ${primitiveData.title}`);
        }
        if (primitiveData.subtitle) {
            lines.push(primitiveData.subtitle);
            lines.push('');
        }

        // 2. Sections
        for (const section of primitiveData.sections || []) {
            switch (section.type) {
                case 'heading': {
                    const lvl = section.level || 2;
                    lines.push(`${'#'.repeat(lvl)} ${section.content || ''}`);
                    lines.push('');
                    break;
                }
                case 'callout': {
                    const tag = (section.calloutTitle || section.calloutType || 'NOTE').toUpperCase();
                    lines.push(`> [!${tag}]`);
                    const cLines = (section.content || '').split('\n');
                    for (const cl of cLines) {
                        lines.push(`> ${cl}`);
                    }
                    lines.push('');
                    break;
                }
                case 'table': {
                    if (section.tableHeaders && section.tableHeaders.length > 0) {
                        lines.push(`| ${section.tableHeaders.join(' | ')} |`);
                        lines.push(`| ${section.tableHeaders.map(() => '---').join(' | ')} |`);
                        for (const row of section.tableRows || []) {
                            lines.push(`| ${row.join(' | ')} |`);
                        }
                        lines.push('');
                    }
                    break;
                }
                case 'checklist': {
                    for (const item of section.checklistItems || []) {
                        lines.push(`- [${item.done ? 'x' : ' '}] ${item.text}`);
                    }
                    lines.push('');
                    break;
                }
                case 'code': {
                    lines.push(`\`\`\`${section.codeLanguage || ''}`);
                    lines.push(section.content || '');
                    lines.push('```');
                    lines.push('');
                    break;
                }
                default: {
                    if (section.content) {
                        lines.push(section.content);
                        lines.push('');
                    }
                    break;
                }
            }
        }

        const generatedMarkdown = lines.join('\n').trim() + '\n';
        const primaryFileName = typeof currentDiskContent === 'object' && Object.keys(currentDiskContent).length > 0
            ? Object.keys(currentDiskContent)[0]
            : 'document.md';

        const files: Record<string, string> = {
            [primaryFileName]: generatedMarkdown
        };

        return {
            files,
            contentHash: computeMultiFileHash(files),
            modifiedFilePaths: [primaryFileName],
            changeSummary: `Unprojected ${primitiveData.sections?.length || 0} sections into ${primaryFileName}`
        };
    }
}

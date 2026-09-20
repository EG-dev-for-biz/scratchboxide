/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export interface ExtractedWikilink {
    target: string;
    alias?: string;
    anchor?: string;
    displayText: string;
    raw: string;
}

export interface MarkdownAstChunk {
    id: string;
    headingLevel: number;
    headingTitle: string;
    breadcrumb: string;
    headingHierarchy: string[];
    content: string;
    chunkType: 'heading' | 'prose' | 'table' | 'code' | 'callout' | 'checklist';
    wikilinks: ExtractedWikilink[];
    blockId?: string;
    frontmatter?: Record<string, any>;
}

export type MarkdownParseResult = MarkdownAstChunk[] & {
    frontmatter: Record<string, any>;
    title: string;
    chunks: MarkdownAstChunk[];
    allWikilinks: string[];
};

export interface AstChunkOptions {
    targetChunkChars?: number;
    minChunkTokens?: number;
    maxChunkTokens?: number;
    includeBreadcrumbsInContent?: boolean;
}

/**
 * Extracts YAML frontmatter key-value pairs from markdown header block.
 */
export function extractYamlFrontmatter(markdown: string): {
    frontmatter: Record<string, any>;
    body: string;
    content: string;
} {
    const trimmed = markdown.trimStart();
    if (!trimmed.startsWith('---')) {
        return { frontmatter: {}, body: markdown, content: markdown };
    }

    const endIdx = trimmed.indexOf('\n---', 3);
    if (endIdx === -1) {
        return { frontmatter: {}, body: markdown, content: markdown };
    }

    const yamlBlock = trimmed.slice(3, endIdx).trim();
    const body = trimmed.slice(endIdx + 4).trimStart();
    const frontmatter: Record<string, any> = {};

    const lines = yamlBlock.split('\n');
    let currentKey = '';
    let currentObj: Record<string, any> | null = null;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        // Check for list item with dash: e.g. "  - name: ..." or "  - item"
        if (/^\s*-\s+/.test(rawLine)) {
            const listContent = line.replace(/^-\s+/, '').trim();
            if (currentKey && Array.isArray(frontmatter[currentKey])) {
                const colonIdx = listContent.indexOf(':');
                if (colonIdx !== -1) {
                    const subKey = listContent.slice(0, colonIdx).trim();
                    const subVal = parseScalarYaml(listContent.slice(colonIdx + 1).trim());
                    currentObj = { [subKey]: subVal };
                    frontmatter[currentKey].push(currentObj);
                } else {
                    currentObj = null;
                    frontmatter[currentKey].push(parseScalarYaml(listContent));
                }
            }
            continue;
        }

        // Check for continuation of current list item object: e.g. "    description: ..."
        if (currentObj && /^\s{2,}/.test(rawLine) && line.includes(':')) {
            const colonIdx = line.indexOf(':');
            const subKey = line.slice(0, colonIdx).trim();
            const subVal = parseScalarYaml(line.slice(colonIdx + 1).trim());
            currentObj[subKey] = subVal;
            continue;
        }

        // Regular top-level key: value
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const key = line.slice(0, colonIdx).trim();
        const rawVal = line.slice(colonIdx + 1).trim();

        currentKey = key;
        currentObj = null;

        if (rawVal === '') {
            frontmatter[key] = [];
        } else {
            frontmatter[key] = parseScalarYaml(rawVal);
        }
    }

    return { frontmatter, body, content: body };
}

function parseScalarYaml(val: string): any {
    if (val.startsWith('[') && val.endsWith(']')) {
        return val
            .slice(1, -1)
            .split(',')
            .map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
    } else if (val === 'true') {
        return true;
    } else if (val === 'false') {
        return false;
    } else if (!isNaN(Number(val)) && val !== '') {
        return Number(val);
    } else {
        return val.replace(/^['"]|['"]$/g, '');
    }
}

/**
 * Extracts all knowledge wikilinks [[Target]] or [[Target|Alias]] or [[Target#Anchor]] from text.
 */
export function extractWikilinks(text: string): ExtractedWikilink[] {
    const wikilinks: ExtractedWikilink[] = [];
    const regex = /\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
        const raw = match[0];
        const target = (match[1] || '').trim();
        const anchor = match[2] ? match[2].trim() : undefined;
        const alias = match[3] ? match[3].trim() : undefined;
        const displayText = alias || (target && anchor ? `${target} > ${anchor}` : target || anchor || '');

        wikilinks.push({
            target,
            alias,
            anchor,
            displayText,
            raw
        });
    }

    return wikilinks;
}

/**
 * AST-aware chunking for Markdown documents.
 * Preserves heading hierarchies (breadcrumbs), YAML frontmatter, atomic tables, code fences, and wikilinks.
 */
export function chunkMarkdownByAst(markdown: string, options: AstChunkOptions = {}): MarkdownParseResult {
    const { targetChunkChars = 800, includeBreadcrumbsInContent = false } = options;
    const { frontmatter, body } = extractYamlFrontmatter(markdown);

    const docTitle = String(
        frontmatter.title ||
        frontmatter.name ||
        extractFirstHeading(body) ||
        'Untitled Document'
    );

    const lines = body.split('\n');
    const chunks: MarkdownAstChunk[] = [];
    const allWikilinksSet = new Set<string>();

    // Heading hierarchy tracker: 0-indexed levels: index 0 = H1, index 1 = H2, index 2 = H3 ...
    const headingStack: string[] = [];

    let currentSectionType: 'heading' | 'prose' | 'table' | 'code' | 'callout' | 'checklist' = 'prose';
    let currentBuffer: string[] = [];
    let currentBlockId: string | undefined;

    const flushBuffer = () => {
        if (currentBuffer.length === 0) return;
        const rawContent = currentBuffer.join('\n').trim();
        if (!rawContent) {
            currentBuffer = [];
            return;
        }

        // Check for block id at the end (e.g. ^ref-42)
        const blockMatch = rawContent.match(/\^([a-zA-Z0-9_-]+)$/);
        const blockId = blockMatch ? blockMatch[1] : currentBlockId;
        const cleanedContent = blockMatch ? rawContent.replace(/\s*\^[a-zA-Z0-9_-]+$/, '') : rawContent;

        const activeHierarchy = headingStack.filter(Boolean);
        const breadcrumb = activeHierarchy.length > 0
            ? activeHierarchy.join(' > ')
            : docTitle;

        const wikilinks = extractWikilinks(cleanedContent);
        wikilinks.forEach(w => {
            if (w.target) allWikilinksSet.add(w.target);
        });

        const finalContent = includeBreadcrumbsInContent && breadcrumb
            ? `[Context: ${breadcrumb}]\n\n${cleanedContent}`
            : cleanedContent;

        const headingHierarchy = activeHierarchy.length > 0 ? [...activeHierarchy] : [docTitle];

        chunks.push({
            id: `chunk-${chunks.length + 1}`,
            headingLevel: Math.max(1, activeHierarchy.length),
            headingTitle: activeHierarchy[activeHierarchy.length - 1] || docTitle,
            breadcrumb,
            headingHierarchy,
            content: finalContent,
            chunkType: currentSectionType,
            wikilinks,
            blockId,
            frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined
        });

        currentBuffer = [];
        currentBlockId = undefined;
    };

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        // 1. Heading (#, ##, ###)
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            flushBuffer();
            const level = headingMatch[1].length; // 1 for H1, 2 for H2, etc.
            const headingText = headingMatch[2].replace(/\s*\^[a-zA-Z0-9_-]+$/, '').trim();

            // Adjust heading stack depth (level 1 corresponds to index 0)
            while (headingStack.length >= level) {
                headingStack.pop();
            }
            while (headingStack.length < level - 1) {
                headingStack.push('');
            }
            headingStack.push(headingText);

            currentSectionType = 'heading';
            currentBuffer = [line];
            flushBuffer();
            currentSectionType = 'prose';
            i++;
            continue;
        }

        // 2. Fenced Code Block (``` ... ```)
        if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
            flushBuffer();
            currentSectionType = 'code';
            const fence = line.trim().slice(0, 3);
            currentBuffer.push(line);
            i++;

            while (i < lines.length) {
                currentBuffer.push(lines[i]);
                if (lines[i].trim().startsWith(fence)) {
                    i++;
                    break;
                }
                i++;
            }
            flushBuffer();
            currentSectionType = 'prose';
            continue;
        }

        // 3. Markdown Table (| col1 | col2 |)
        if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
            if (currentSectionType !== 'table') {
                flushBuffer();
                currentSectionType = 'table';
            }
            currentBuffer.push(line);
            i++;
            continue;
        } else if (currentSectionType === 'table') {
            flushBuffer();
            currentSectionType = 'prose';
        }

        // 4. Markdown Callout (> [!callout])
        if (line.trim().startsWith('> [!')) {
            flushBuffer();
            currentSectionType = 'callout';
            currentBuffer.push(line);
            i++;

            while (i < lines.length && (lines[i].trim().startsWith('>') || lines[i].trim() === '')) {
                currentBuffer.push(lines[i]);
                i++;
            }
            flushBuffer();
            currentSectionType = 'prose';
            continue;
        }

        // 5. Checklist items (- [ ] / - [x])
        if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
            if (currentSectionType !== 'checklist') {
                flushBuffer();
                currentSectionType = 'checklist';
            }
            currentBuffer.push(line);
            i++;
            continue;
        } else if (currentSectionType === 'checklist' && line.trim().length > 0 && !/^\s*[-*+]\s+/.test(line)) {
            flushBuffer();
            currentSectionType = 'prose';
        }

        // 6. Paragraph lines / empty line splitting
        if (line.trim() === '') {
            if (currentBuffer.join('\n').length >= targetChunkChars) {
                flushBuffer();
            } else if (currentBuffer.length > 0) {
                currentBuffer.push('');
            }
        } else {
            currentBuffer.push(line);
        }

        i++;
    }

    flushBuffer();

    const parseResult = Object.assign([...chunks], {
        frontmatter,
        title: docTitle,
        chunks,
        allWikilinks: Array.from(allWikilinksSet)
    });

    return parseResult as MarkdownParseResult;
}

function extractFirstHeading(text: string): string | null {
    const match = text.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
}
